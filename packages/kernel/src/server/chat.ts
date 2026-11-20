import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  DraftCardSchema,
  SessionRefSchema,
  type DraftCard,
  type PendingDecision,
  type ReasoningEffort,
  type RoleId,
  type RunEvent,
  type SessionRef,
  type SpaceConfig,
  type TaskCard,
} from "@kiln/protocol";
import {
  assertRoleAgentEligible,
  type BackendAgentDescriptor,
  type BackendModelDescriptor,
  type BackendRegistry,
  type BackendRunSpec,
  type ExecutionBackend,
  type McpStdioMountSpec,
} from "../backend/index.js";
import {
  appendNdjsonLine,
  assertSafeSegment,
  ensureDir,
  KilnStore,
  readNdjsonValidated,
  writeFileAtomic,
} from "../store/index.js";
import { ServerHttpError } from "./errors.js";
import { PendingDecisionStore, readOptionalText } from "./pending-decisions.js";

const DEFAULT_BACKEND_QUERY_TIMEOUT_MS = 1_500;

export const ChatMessageRecordSchema = z.object({
  id: z.string().min(1).optional(),
  role: z.enum(["user", "assistant", "system", "tool"]).optional(),
  who: z.enum(["me", "agent", "tool"]).optional(),
  name: z.string().optional(),
  text: z.string(),
  at: z.string().min(1).optional(),
  toolName: z.string().optional(),
});
export type ChatMessageRecord = z.infer<typeof ChatMessageRecordSchema>;

const ResolverSessionFileSchema = z.object({
  schema_version: z.literal(1),
  task_id: z.string().min(1),
  session_ref: SessionRefSchema,
  updated_at: z.string().min(1),
});

export interface AgentSnapshotEntry {
  id: string;
  label: string;
  backendId: string;
  capabilities: BackendAgentDescriptor["capabilities"];
  modes: BackendAgentDescriptor["modes"];
  defaultModeId: string | null;
  models: BackendModelDescriptor[];
}

export interface BackendConnectionSnapshot {
  backendId: string;
  id: string;
  connected: boolean;
  status: "connected" | "disconnected";
  detail: string;
}

export interface NormalizedProviderUsageEntry {
  agent: string;
  label: string;
  usedRatio?: number;
  usedPercent?: number;
  resetAt?: string;
  note?: string;
}

export interface BackendsSnapshot {
  agents: AgentSnapshotEntry[];
  backends: BackendConnectionSnapshot[];
  providerUsage: NormalizedProviderUsageEntry[];
}

interface MaybeProviderUsageWindow {
  providerId?: unknown;
  agent?: unknown;
  displayName?: unknown;
  shortLabel?: unknown;
  label?: unknown;
  usedPct?: unknown;
  usedPercent?: unknown;
  usedRatio?: unknown;
  remainingPct?: unknown;
  resetsAt?: unknown;
  resetAt?: unknown;
  planLabel?: unknown;
}

interface MaybeProviderUsageBackend extends ExecutionBackend {
  listProviderUsage?: () => Promise<unknown[]>;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (timeoutMs <= 0) {
    return await promise;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (typeof timer === "object" && timer !== null && "unref" in timer) {
          (timer as { unref?: () => void }).unref?.();
        }
      }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

function normalizeProviderUsageWindows(
  rawWindows: readonly unknown[],
): NormalizedProviderUsageEntry[] {
  const entries: NormalizedProviderUsageEntry[] = [];
  const seenAgents = new Set<string>();

  for (const raw of rawWindows) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const w = raw as MaybeProviderUsageWindow;
    const agentId =
      typeof w.agent === "string" && w.agent.trim().length > 0
        ? w.agent.trim()
        : typeof w.providerId === "string" && w.providerId.trim().length > 0
          ? w.providerId.trim()
          : null;
    if (!agentId || seenAgents.has(agentId)) {
      continue;
    }

    let usedRatio: number | undefined;
    let usedPercent: number | undefined;

    if (typeof w.usedRatio === "number" && Number.isFinite(w.usedRatio)) {
      usedRatio = Math.max(0, Math.min(1, w.usedRatio));
      usedPercent = Math.round(usedRatio * 100);
    } else if (typeof w.usedPct === "number" && Number.isFinite(w.usedPct)) {
      usedPercent = Math.max(0, Math.min(100, w.usedPct));
      usedRatio = usedPercent / 100;
    } else if (typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent)) {
      usedPercent = Math.max(0, Math.min(100, w.usedPercent));
      usedRatio = usedPercent / 100;
    } else if (typeof w.remainingPct === "number" && Number.isFinite(w.remainingPct)) {
      usedPercent = Math.max(0, Math.min(100, 100 - w.remainingPct));
      usedRatio = usedPercent / 100;
    }

    if (usedRatio === undefined) {
      continue;
    }

    const label =
      typeof w.shortLabel === "string" && w.shortLabel.trim().length > 0
        ? w.shortLabel.trim()
        : typeof w.label === "string" && w.label.trim().length > 0
          ? w.label.trim()
          : "订阅窗口";
    const resetAt =
      typeof w.resetsAt === "string" && w.resetsAt.trim().length > 0
        ? w.resetsAt.trim()
        : typeof w.resetAt === "string" && w.resetAt.trim().length > 0
          ? w.resetAt.trim()
          : undefined;
    const note =
      typeof w.planLabel === "string" && w.planLabel.trim().length > 0
        ? w.planLabel.trim()
        : undefined;

    seenAgents.add(agentId);
    entries.push({
      agent: agentId,
      label,
      usedRatio,
      usedPercent,
      ...(resetAt !== undefined ? { resetAt } : {}),
      ...(note !== undefined ? { note } : {}),
    });
  }

  return entries;
}

/**
 * Queries all registered backends with timeout isolation so an offline or slow backend
 * daemon never breaks `/api/agents` or `/api/bootstrap`.
 */
export async function snapshotBackends(
  registry: BackendRegistry | undefined,
  options: { timeoutMs?: number } = {},
): Promise<BackendsSnapshot> {
  if (!registry) {
    return { agents: [], backends: [], providerUsage: [] };
  }

  const backendsList = registry.list();
  if (backendsList.length === 0) {
    return { agents: [], backends: [], providerUsage: [] };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_BACKEND_QUERY_TIMEOUT_MS;
  const agents: AgentSnapshotEntry[] = [];
  const backends: BackendConnectionSnapshot[] = [];
  const providerUsage: NormalizedProviderUsageEntry[] = [];

  await Promise.all(
    backendsList.map(async (backend) => {
      try {
        const listedAgents = await withTimeout(
          backend.listAgents(),
          timeoutMs,
          `listAgents(${backend.backendId})`,
        );

        const modelsByAgent = await Promise.all(
          listedAgents.map(async (agentDesc) => {
            try {
              return await withTimeout(
                backend.listModels(agentDesc.id),
                timeoutMs,
                `listModels(${backend.backendId}:${agentDesc.id})`,
              );
            } catch {
              return [] as BackendModelDescriptor[];
            }
          }),
        );

        for (let i = 0; i < listedAgents.length; i++) {
          const agentDesc = listedAgents[i]!;
          agents.push({
            id: agentDesc.id,
            label: agentDesc.label,
            backendId: backend.backendId,
            capabilities: { ...agentDesc.capabilities },
            modes: agentDesc.modes.map((m) => ({ ...m })),
            defaultModeId: agentDesc.defaultModeId ?? null,
            models: modelsByAgent[i] ?? [],
          });
        }

        backends.push({
          backendId: backend.backendId,
          id: backend.backendId,
          connected: true,
          status: "connected",
          detail: `${listedAgents.length} agent(s) available`,
        });

        const maybeUsageBackend = backend as MaybeProviderUsageBackend;
        if (typeof maybeUsageBackend.listProviderUsage === "function") {
          try {
            const windows = await withTimeout(
              maybeUsageBackend.listProviderUsage(),
              timeoutMs,
              `listProviderUsage(${backend.backendId})`,
            );
            if (Array.isArray(windows)) {
              providerUsage.push(...normalizeProviderUsageWindows(windows));
            }
          } catch {
            // M0 V9 fallback: degrade gracefully when subscription quota windows cannot be fetched.
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        backends.push({
          backendId: backend.backendId,
          id: backend.backendId,
          connected: false,
          status: "disconnected",
          detail: msg,
        });
      }
    }),
  );

  return { agents, backends, providerUsage };
}

export interface McpCommandSpec {
  command: string;
  args: string[];
}

/**
 * Resolves the `kiln-mcp` stdio command specification used when mounting MCP tools onto agent sessions.
 */
export function resolveMcpServerCommand(override?: McpCommandSpec): McpCommandSpec {
  if (override) {
    return { command: override.command, args: [...override.args] };
  }

  let current = import.meta.dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(current, "packages", "mcp", "dist", "bin.js");
    if (fs.existsSync(candidate)) {
      return { command: process.execPath, args: [candidate] };
    }
    const siblingCandidate = path.join(current, "mcp", "dist", "bin.js");
    if (fs.existsSync(siblingCandidate)) {
      return { command: process.execPath, args: [siblingCandidate] };
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return { command: "kiln-mcp", args: [] };
}

export interface ChatResponderInput {
  role: "intake" | "resolver";
  targetId: string;
  message: string;
  history: readonly ChatMessageRecord[];
  draft?: DraftCard;
  card?: TaskCard;
  pendingDecision?: PendingDecision | null;
  token: string;
}

export interface ChatResponderOutput {
  replyText: string;
  toolMessages?: ChatMessageRecord[];
}

export type ChatResponder = (
  input: ChatResponderInput,
) => Promise<ChatResponderOutput> | ChatResponderOutput;

export interface KilnChatEngineOptions {
  store: KilnStore;
  backendRegistry: BackendRegistry;
  pendingDecisions: PendingDecisionStore;
  socketPath: string;
  issueRunToken: (input: {
    taskId: string;
    runId: string;
    role: RoleId;
    contractVersion: number;
    ttlSeconds?: number;
  }) => string;
  mcpServerCommand?: McpCommandSpec;
  chatResponder?: ChatResponder;
}

interface ResolvedInteractiveExecutor {
  backend: ExecutionBackend;
  agent: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  allowFullAccessFallback: boolean;
}

/**
 * Interactive chat engine backing `intake` (draft planning) and `resolver` (pending decision
 * discussion & contract refinement), enforcing `interactiveChat && mcpInjection` capabilities
 * and persisting conversation logs atomically to disk.
 */
export class KilnChatEngine {
  private readonly store: KilnStore;
  private readonly backendRegistry: BackendRegistry;
  private readonly pendingDecisions: PendingDecisionStore;
  private readonly socketPath: string;
  private readonly issueRunToken: KilnChatEngineOptions["issueRunToken"];
  private readonly mcpServerCommand: McpCommandSpec;
  private readonly chatResponder: ChatResponder | undefined;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: KilnChatEngineOptions) {
    this.store = options.store;
    this.backendRegistry = options.backendRegistry;
    this.pendingDecisions = options.pendingDecisions;
    this.socketPath = options.socketPath;
    this.issueRunToken = options.issueRunToken;
    this.mcpServerCommand = resolveMcpServerCommand(options.mcpServerCommand);
    this.chatResponder = options.chatResponder;
  }

  draftChatPath(draftId: string): string {
    const safeDraftId = assertSafeSegment(draftId, "draftId");
    return path.join(this.store.paths.draftsDir, `${safeDraftId}-chat.ndjson`);
  }

  taskChatPath(taskId: string): string {
    const safeTaskId = assertSafeSegment(taskId, "taskId");
    return path.join(this.store.paths.taskDir(safeTaskId), "resolver_chat.ndjson");
  }

  private resolverSessionPath(taskId: string): string {
    const safeTaskId = assertSafeSegment(taskId, "taskId");
    return path.join(this.store.paths.taskDir(safeTaskId), "resolver_session.json");
  }

  getDraftChatMessages(draftId: string): ChatMessageRecord[] {
    return readNdjsonValidated(this.draftChatPath(draftId), ChatMessageRecordSchema);
  }

  getTaskChatMessages(taskId: string): ChatMessageRecord[] {
    return readNdjsonValidated(this.taskChatPath(taskId), ChatMessageRecordSchema);
  }

  private async runSerialized<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(lockKey) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tracked = next.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(lockKey, tracked);
    try {
      return await next;
    } finally {
      if (this.locks.get(lockKey) === tracked) {
        this.locks.delete(lockKey);
      }
    }
  }

  private async resolveInteractiveExecutor(
    role: "intake" | "resolver",
  ): Promise<ResolvedInteractiveExecutor | null> {
    const rolesConfig = this.store.readConfig("roles");
    const assignment = rolesConfig?.roles[role];

    if (assignment) {
      let targetBackend: ExecutionBackend | null = null;
      if (assignment.backend_id) {
        if (this.backendRegistry.has(assignment.backend_id)) {
          targetBackend = this.backendRegistry.get(assignment.backend_id);
        }
      } else {
        for (const candidate of this.backendRegistry.list()) {
          try {
            const listed = await candidate.listAgents();
            if (listed.some((a) => a.id === assignment.agent)) {
              targetBackend = candidate;
              break;
            }
          } catch {
            // Try remaining registered backends
          }
        }
      }

      if (!targetBackend) {
        if (this.chatResponder) {
          return null;
        }
        throw new ServerHttpError(409, {
          error: "backend_unavailable",
          role,
          agent: assignment.agent,
          message: `No connected ExecutionBackend exposes agent "${assignment.agent}" for role "${role}"`,
        });
      }

      const caps = await targetBackend.capabilities(assignment.agent);
      assertRoleAgentEligible(role, assignment.agent, caps);

      return {
        backend: targetBackend,
        agent: assignment.agent,
        model: assignment.model,
        ...(assignment.reasoning_effort !== undefined
          ? { reasoningEffort: assignment.reasoning_effort }
          : {}),
        allowFullAccessFallback: assignment.allow_full_access_fallback ?? false,
      };
    }

    // No explicit role configured: auto-select first eligible interactiveChat + mcpInjection agent.
    let firstIneligible: { agent: string; caps: BackendAgentDescriptor["capabilities"] } | null =
      null;
    for (const backend of this.backendRegistry.list()) {
      try {
        const listed = await backend.listAgents();
        for (const agentDesc of listed) {
          if (agentDesc.capabilities.interactiveChat && agentDesc.capabilities.mcpInjection) {
            const models = await backend.listModels(agentDesc.id).catch(() => []);
            const model = models[0]?.id ?? "default";
            return {
              backend,
              agent: agentDesc.id,
              model,
              allowFullAccessFallback: false,
            };
          }
          if (!firstIneligible) {
            firstIneligible = { agent: agentDesc.id, caps: agentDesc.capabilities };
          }
        }
      } catch {
        // Ignore offline backend while scanning fallback candidates
      }
    }

    if (this.chatResponder) {
      return null;
    }

    if (firstIneligible) {
      assertRoleAgentEligible(role, firstIneligible.agent, firstIneligible.caps);
    }

    throw new ServerHttpError(409, {
      error: "backend_unavailable",
      role,
      message: `No interactive ExecutionBackend available for role "${role}"`,
    });
  }

  private buildMcpMount(token: string): McpStdioMountSpec {
    return {
      name: "kiln",
      command: this.mcpServerCommand.command,
      args: [...this.mcpServerCommand.args],
      env: {
        KILN_RUN_TOKEN: token,
        KILN_SOCK_PATH: this.socketPath,
        KILN_HOME: this.store.paths.home,
      },
    };
  }

  private async canReuseSession(
    sessionRef: SessionRef | null | undefined,
  ): Promise<{ backend: ExecutionBackend; sessionRef: SessionRef } | null> {
    if (!sessionRef || !this.backendRegistry.has(sessionRef.backendId)) {
      return null;
    }
    const backend = this.backendRegistry.get(sessionRef.backendId);
    try {
      const probe = await backend.probe(sessionRef);
      if (probe.alive && probe.status !== "closed") {
        return { backend, sessionRef };
      }
    } catch {
      return null;
    }
    return null;
  }

  private async consumeTurnEvents(
    backend: ExecutionBackend,
    sessionRef: SessionRef,
    roleName: "intake" | "resolver",
  ): Promise<{ replyText: string; toolMessages: ChatMessageRecord[] }> {
    const fullMessages: string[] = [];
    const deltaChunks: string[] = [];
    const toolMessages: ChatMessageRecord[] = [];
    let exitEvent: Extract<RunEvent, { kind: "exit" }> | null = null;

    for await (const ev of backend.events(sessionRef)) {
      if (ev.kind === "message") {
        if (ev.delta) {
          deltaChunks.push(ev.text);
        } else if (ev.text.trim().length > 0) {
          fullMessages.push(ev.text);
        }
      } else if (ev.kind === "tool") {
        toolMessages.push({
          id: `msg-${randomUUID().slice(0, 8)}`,
          role: "tool",
          who: "tool",
          name: roleName,
          toolName: ev.name,
          text: ev.target ? `${ev.name} · ${ev.target}` : ev.name,
          at: ev.at,
        });
      } else if (ev.kind === "exit") {
        exitEvent = ev;
      }
    }

    if (exitEvent?.reason === "failed") {
      throw new ServerHttpError(409, {
        error: "chat_turn_failed",
        message: exitEvent.detail ?? `${roleName} chat session exited with failure`,
      });
    }

    const replyText =
      fullMessages.length > 0
        ? fullMessages.join("\n").trim()
        : deltaChunks.join("").trim();

    return {
      replyText: replyText || "已处理当前对话回合。",
      toolMessages,
    };
  }

  private resolveIntakeWorkspace(
    draft: DraftCard,
    safeDraftId: string,
  ): { cwd: string; spaceConfig: SpaceConfig | null; isProjectRepo: boolean } {
    const spaceConfig = this.store.readSpace(draft.space);
    if (
      draft.space !== "local" &&
      spaceConfig?.repo_path &&
      fs.existsSync(spaceConfig.repo_path) &&
      fs.statSync(spaceConfig.repo_path).isDirectory()
    ) {
      return { cwd: spaceConfig.repo_path, spaceConfig, isProjectRepo: true };
    }
    const draftDir = this.store.paths.draftDir(safeDraftId);
    ensureDir(draftDir);
    return { cwd: draftDir, spaceConfig, isProjectRepo: false };
  }

  private formatPriorChatSummary(history: readonly ChatMessageRecord[]): string {
    const dialogue = history.filter(
      (m) => m.who === "me" || m.who === "agent" || m.role === "user" || m.role === "assistant",
    );
    if (dialogue.length === 0) {
      return "";
    }
    const recent = dialogue.slice(-12).map((m) => {
      const speaker = m.who === "me" || m.role === "user" ? "用户" : "intake";
      const trimmed = m.text.trim();
      const text = trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
      return `- [${speaker}]: ${text}`;
    });
    return `切换空间/工作目录前的前序对话摘要：\n${recent.join("\n")}`;
  }

  private buildIntakeSystemPrompt(params: {
    draft: DraftCard;
    spaceConfig: SpaceConfig | null;
    allSpaces: readonly SpaceConfig[];
    cwd: string;
    isProjectRepo: boolean;
    priorHistory: readonly ChatMessageRecord[];
  }): string {
    const { draft, spaceConfig, allSpaces, cwd, isProjectRepo, priorHistory } = params;
    const tasks = this.store.listTasks().slice(0, 20);
    const ledger = this.store.readLedger(draft.space);
    const taskLines =
      tasks.length > 0
        ? tasks.map((t) => `- ${t.id} [${t.status}/${t.priority}] ${t.title}`).join("\n")
        : "(暂无在途任务)";
    const ledgerLines =
      ledger && ledger.entries.length > 0
        ? ledger.entries.map((e) => `- ${e.rule}`).join("\n")
        : "(暂无空间账本约束)";

    const projectSpaces = allSpaces.filter((s) => s.id !== "local" && Boolean(s.repo_path));
    const registeredSpacesText =
      projectSpaces.length > 0
        ? projectSpaces
            .map(
              (s) =>
                `- ${s.id} (${s.name}): repo_path=${s.repo_path}, branch=${s.default_branch}${
                  s.default_accept_cmd ? `, accept=${s.default_accept_cmd}` : ""
                }`,
            )
            .join("\n")
        : "(暂无已登记 Git 项目空间)";

    const modeSummary = isProjectRepo
      ? [
          `当前任务模式：项目任务（git_worktree）`,
          `当前项目空间 "${spaceConfig?.name ?? draft.space}" (${draft.space})：repo_path=${cwd}, default_branch=${spaceConfig?.default_branch ?? "main"}${
            spaceConfig?.default_accept_cmd
              ? `, default_accept_cmd=${spaceConfig.default_accept_cmd}`
              : ""
          }`,
          `**只读探索约束**：你当前位于项目仓库目录 (${cwd})，可只读检索代码、目录结构与测试脚本以确定准确的可改范围 (scope) 与验收命令 (accept_cmd)；**严禁直接修改项目源码文件或执行 git 写入命令**，只允许通过 wb_plan(mode: "upsert_draft") 更新草稿。`,
        ].join("\n")
      : [
          `当前任务模式：本机 / 临时任务（非 Git 项目空间，cwd=${cwd}）`,
          `可用 workspace_mode 仅限 scratch_dir（独立临时沙盒）或 host_scoped（本机白名单文件两阶段暂存，严禁在立项阶段直接改动宿主机文件）。`,
        ].join("\n");

    const draftSummary = [
      `当前草稿字段摘要：`,
      `- title: ${draft.title || "(未填)"}`,
      `- space: ${draft.space}`,
      `- priority: ${draft.priority}`,
      `- track: ${draft.track}`,
      `- workspace_mode: ${draft.workspace_mode}`,
      `- end: ${draft.contract.end ?? "(未填)"}`,
      `- accept_cmd: ${draft.contract.accept_cmd ?? "(未填)"}`,
      `- scope: ${draft.contract.scope?.join(", ") || "(未填)"}`,
      `- depends_on: ${draft.depends_on.join(", ") || "无"}`,
    ].join("\n");

    const priorSummary = this.formatPriorChatSummary(priorHistory);

    return [
      `你是 Kiln 的 intake 立项对话角色。当前草稿 ID: ${draft.id}，空间: ${draft.space}，cwd: ${cwd}。`,
      modeSummary,
      `你拥有 kiln-mcp 工具权限（wb_list_tasks, wb_read_ledger, wb_plan），请协助用户梳理目标、验收标准、可改范围、依赖前置并调用 wb_plan(mode: "upsert_draft") 更新草稿。`,
      `已登记项目空间列表：\n${registeredSpacesText}`,
      draftSummary,
      `当前在途任务：\n${taskLines}`,
      `空间 ${draft.space} 长期决策账本：\n${ledgerLines}`,
      priorSummary,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private buildResolverSystemPrompt(
    card: TaskCard,
    pendingDecision: PendingDecision | null,
  ): string {
    const brief = readOptionalText(this.store.paths.briefMd(card.id)) ?? "";
    const decisions = readOptionalText(this.store.paths.decisionsMd(card.id)) ?? "";
    const decisionSection = pendingDecision
      ? `当前待决 (${pendingDecision.id}): ${pendingDecision.question}\n选项:\n${pendingDecision.options
          .map((o) => `- ${o.id} (${o.action}): ${o.label}`)
          .join("\n")}`
      : "(当前无激活的待决项)";

    return [
      `你是 Kiln 的 resolver 讨论角色，负责协助用户讨论任务 "${card.id}"（${card.title}，契约 v${card.contract_version}）。`,
      `可使用 wb_get_context / wb_list_tasks / wb_read_ledger / wb_plan(mode: "update_contract")。`,
      `当前契约：\n- goal: ${card.contract.goal}\n- end: ${card.contract.end}\n- accept_cmd: ${card.contract.accept_cmd}\n- scope: ${card.contract.scope.join(", ")}`,
      decisionSection,
      brief ? `立项 BRIEF:\n${brief}` : "",
      decisions ? `历史 decisions:\n${decisions}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async sendDraftChat(
    draftId: string,
    message: string,
  ): Promise<{ messages: ChatMessageRecord[]; reply: ChatMessageRecord; draft: DraftCard }> {
    const safeDraftId = assertSafeSegment(draftId, "draftId");
    const trimmed = message.trim();
    if (trimmed.length === 0) {
      throw new ServerHttpError(400, {
        error: "invalid_message",
        message: "Chat message cannot be empty",
      });
    }

    return await this.runSerialized(`draft:${safeDraftId}`, async () => {
      const draft = this.store.readDraft(safeDraftId);
      if (!draft) {
        throw new ServerHttpError(404, {
          error: "draft_not_found",
          draftId: safeDraftId,
          message: `Draft "${safeDraftId}" does not exist`,
        });
      }

      const executor = await this.resolveInteractiveExecutor("intake");
      const historyBefore = this.getDraftChatMessages(safeDraftId);
      const chatFile = this.draftChatPath(safeDraftId);
      const userNow = new Date().toISOString();
      const userRecord: ChatMessageRecord = {
        id: `msg-${randomUUID().slice(0, 8)}`,
        role: "user",
        who: "me",
        text: trimmed,
        at: userNow,
      };
      appendNdjsonLine(chatFile, userRecord);

      const runId = `chat-intake-${randomUUID().slice(0, 8)}`;
      const token = this.issueRunToken({
        taskId: safeDraftId,
        runId,
        role: "intake",
        contractVersion: 1,
        ttlSeconds: 86_400,
      });

      let replyText: string;
      let toolMessages: ChatMessageRecord[] = [];

      if (executor === null && this.chatResponder) {
        const res = await this.chatResponder({
          role: "intake",
          targetId: safeDraftId,
          message: trimmed,
          history: historyBefore,
          draft,
          token,
        });
        replyText = res.replyText;
        toolMessages = res.toolMessages ?? [];
      } else {
        if (!executor) {
          throw new ServerHttpError(409, {
            error: "backend_unavailable",
            role: "intake",
            message: "No ExecutionBackend available for intake chat",
          });
        }

        const resolvedWorkspace = this.resolveIntakeWorkspace(draft, safeDraftId);
        const reusable = await this.canReuseSession(draft.session_ref);
        let activeBackend = executor.backend;
        let sessionRef: SessionRef;
        const reusableMeta = reusable?.sessionRef.meta;

        if (
          reusable &&
          reusable.backend.backendId === executor.backend.backendId &&
          reusableMeta?.kiln_chat_agent === executor.agent &&
          reusableMeta?.kiln_chat_model === executor.model &&
          reusableMeta?.kiln_chat_space === draft.space &&
          reusableMeta?.kiln_chat_cwd === resolvedWorkspace.cwd
        ) {
          sessionRef = reusable.sessionRef;
          await activeBackend.send(sessionRef, trimmed);
        } else {
          const allSpaces = this.store.listSpaces();
          const spec: BackendRunSpec = {
            runId,
            taskId: safeDraftId,
            role: "intake",
            agent: executor.agent,
            model: executor.model,
            ...(executor.reasoningEffort !== undefined
              ? { reasoningEffort: executor.reasoningEffort }
              : {}),
            cwd: resolvedWorkspace.cwd,
            prompt: trimmed,
            systemPrompt: this.buildIntakeSystemPrompt({
              draft,
              spaceConfig: resolvedWorkspace.spaceConfig,
              allSpaces,
              cwd: resolvedWorkspace.cwd,
              isProjectRepo: resolvedWorkspace.isProjectRepo,
              priorHistory: historyBefore,
            }),
            freshContext: false,
            allowFullAccessFallback: executor.allowFullAccessFallback,
            mcpServers: [this.buildMcpMount(token)],
          };
          sessionRef = await activeBackend.start(spec);
          const taggedSessionRef: SessionRef = {
            ...sessionRef,
            meta: {
              ...sessionRef.meta,
              kiln_chat_agent: executor.agent,
              kiln_chat_model: executor.model,
              kiln_chat_space: draft.space,
              kiln_chat_cwd: resolvedWorkspace.cwd,
            },
          };
          const updatedDraft = DraftCardSchema.parse({
            ...draft,
            session_ref: taggedSessionRef,
            updated_at: new Date().toISOString(),
          });
          this.store.writeDraft(updatedDraft);
        }

        const consumed = await this.consumeTurnEvents(activeBackend, sessionRef, "intake");
        replyText = consumed.replyText;
        toolMessages = consumed.toolMessages;
      }

      for (const toolMsg of toolMessages) {
        appendNdjsonLine(chatFile, toolMsg);
      }
      const replyRecord: ChatMessageRecord = {
        id: `msg-${randomUUID().slice(0, 8)}`,
        role: "assistant",
        who: "agent",
        name: "intake",
        text: replyText,
        at: new Date().toISOString(),
      };
      appendNdjsonLine(chatFile, replyRecord);

      const latestDraft = this.store.readDraft(safeDraftId) ?? draft;
      return {
        messages: this.getDraftChatMessages(safeDraftId),
        reply: replyRecord,
        draft: latestDraft,
      };
    });
  }

  async sendTaskChat(
    taskId: string,
    message: string,
  ): Promise<{
    messages: ChatMessageRecord[];
    reply: ChatMessageRecord;
    pendingDecision: PendingDecision | null;
    card: TaskCard;
  }> {
    const safeTaskId = assertSafeSegment(taskId, "taskId");
    const trimmed = message.trim();
    if (trimmed.length === 0) {
      throw new ServerHttpError(400, {
        error: "invalid_message",
        message: "Chat message cannot be empty",
      });
    }

    return await this.runSerialized(`task:${safeTaskId}`, async () => {
      let card: TaskCard;
      try {
        card = this.store.readTaskCard(safeTaskId);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ServerHttpError(404, {
            error: "task_not_found",
            taskId: safeTaskId,
            message: `Task "${safeTaskId}" does not exist`,
          });
        }
        throw err;
      }

      const executor = await this.resolveInteractiveExecutor("resolver");
      const historyBefore = this.getTaskChatMessages(safeTaskId);
      const chatFile = this.taskChatPath(safeTaskId);
      const pendingDecision = this.pendingDecisions.get(safeTaskId);

      const userRecord: ChatMessageRecord = {
        id: `msg-${randomUUID().slice(0, 8)}`,
        role: "user",
        who: "me",
        text: trimmed,
        at: new Date().toISOString(),
      };
      appendNdjsonLine(chatFile, userRecord);

      const runId = `chat-resolver-${randomUUID().slice(0, 8)}`;
      const token = this.issueRunToken({
        taskId: safeTaskId,
        runId,
        role: "resolver",
        contractVersion: card.contract_version,
        ttlSeconds: 86_400,
      });

      let replyText: string;
      let toolMessages: ChatMessageRecord[] = [];

      if (executor === null && this.chatResponder) {
        const res = await this.chatResponder({
          role: "resolver",
          targetId: safeTaskId,
          message: trimmed,
          history: historyBefore,
          card,
          pendingDecision,
          token,
        });
        replyText = res.replyText;
        toolMessages = res.toolMessages ?? [];
      } else {
        if (!executor) {
          throw new ServerHttpError(409, {
            error: "backend_unavailable",
            role: "resolver",
            message: "No ExecutionBackend available for resolver chat",
          });
        }

        let existingSessionRef: SessionRef | null = null;
        const sessionFile = this.resolverSessionPath(safeTaskId);
        const rawSession = readOptionalText(sessionFile);
        if (rawSession !== null) {
          try {
            existingSessionRef = ResolverSessionFileSchema.parse(
              JSON.parse(rawSession) as unknown,
            ).session_ref;
          } catch {
            existingSessionRef = null;
          }
        }

        const reusable = await this.canReuseSession(existingSessionRef);
        let sessionRef: SessionRef;
        const reusableMeta = reusable?.sessionRef.meta;

        if (
          reusable &&
          reusable.backend.backendId === executor.backend.backendId &&
          reusableMeta?.kiln_chat_agent === executor.agent &&
          reusableMeta?.kiln_chat_model === executor.model
        ) {
          sessionRef = reusable.sessionRef;
          await executor.backend.send(sessionRef, trimmed);
        } else {
          const spec: BackendRunSpec = {
            runId,
            taskId: safeTaskId,
            role: "resolver",
            agent: executor.agent,
            model: executor.model,
            ...(executor.reasoningEffort !== undefined
              ? { reasoningEffort: executor.reasoningEffort }
              : {}),
            cwd: this.store.paths.taskDir(safeTaskId),
            prompt: trimmed,
            systemPrompt: this.buildResolverSystemPrompt(card, pendingDecision),
            freshContext: false,
            allowFullAccessFallback: executor.allowFullAccessFallback,
            mcpServers: [this.buildMcpMount(token)],
          };
          sessionRef = await executor.backend.start(spec);
          const taggedSessionRef: SessionRef = {
            ...sessionRef,
            meta: {
              ...sessionRef.meta,
              kiln_chat_agent: executor.agent,
              kiln_chat_model: executor.model,
            },
          };
          writeFileAtomic(
            sessionFile,
            `${JSON.stringify(
              ResolverSessionFileSchema.parse({
                schema_version: 1,
                task_id: safeTaskId,
                session_ref: taggedSessionRef,
                updated_at: new Date().toISOString(),
              }),
              null,
              2,
            )}\n`,
          );
        }

        const consumed = await this.consumeTurnEvents(executor.backend, sessionRef, "resolver");
        replyText = consumed.replyText;
        toolMessages = consumed.toolMessages;
      }

      for (const toolMsg of toolMessages) {
        appendNdjsonLine(chatFile, toolMsg);
      }
      const replyRecord: ChatMessageRecord = {
        id: `msg-${randomUUID().slice(0, 8)}`,
        role: "assistant",
        who: "agent",
        name: "resolver",
        text: replyText,
        at: new Date().toISOString(),
      };
      appendNdjsonLine(chatFile, replyRecord);

      return {
        messages: this.getTaskChatMessages(safeTaskId),
        reply: replyRecord,
        pendingDecision: this.pendingDecisions.get(safeTaskId),
        card: this.store.readTaskCard(safeTaskId),
      };
    });
  }
}
