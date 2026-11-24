import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  DeliverConfigSchema,
  DraftCardSchema,
  PrioritySchema,
  SessionRefSchema,
  StageIdSchema,
  WorkflowBlueprintSchema,
  buildCustomWorkflow,
  buildWorkflowPreset,
  extractWorkflowToggles,
  type ChatCommandItem,
  type ChatCommandsResponse,
  type DraftCard,
  type PendingDecision,
  type ReasoningEffort,
  type RoleId,
  type RunEvent,
  type SessionRef,
  type SpaceConfig,
  type TaskCard,
  type WorkflowBlueprint,
} from "@kiln/protocol";
import {
  ProviderHealthTracker,
  assertRoleAgentEligible,
  isFullAccessMode,
  type BackendAgentDescriptor,
  type BackendModelDescriptor,
  type BackendRegistry,
  type BackendRunSpec,
  type ExecutionBackend,
  type McpStdioMountSpec,
  type RunAttachmentInput,
} from "../backend/index.js";
import { RoleNotConfiguredError, resolveRosterStageAssignment } from "../scheduler/index.js";
import type { TaskStateMachine } from "../state/index.js";
import {
  appendNdjsonLine,
  assertSafeSegment,
  deriveTaskStatus,
  ensureDir,
  KilnStore,
  readNdjsonValidated,
  writeFileAtomic,
} from "../store/index.js";
import { resolveRunAttachmentInputs } from "./attachments.js";
import { selectActiveLedgerEntriesForHandoff } from "./improvements.js";
import type { CaffeinateController } from "./caffeinate.js";
import { ServerHttpError } from "./errors.js";
import { discoverMcpServers, discoverSkills } from "./extensions.js";
import {
  countRunningLeafTasks,
  PendingDecisionStore,
  readOptionalText,
} from "./pending-decisions.js";
import type { SseHub } from "./sse.js";

const DEFAULT_BACKEND_QUERY_TIMEOUT_MS = 5_000;
const DEFAULT_BACKEND_REFRESH_TIMEOUT_MS = 15_000;

const LAST_BACKEND_AGENTS_CACHE = new WeakMap<
  ExecutionBackend,
  { agents: AgentSnapshotEntry[]; updatedAt: number }
>();

const optionalTrimmedString = z.preprocess((val) => {
  if (val === undefined || val === null) return undefined;
  if (typeof val === "string") {
    const trimmed = val.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return val;
}, z.string().min(1).optional());

const optionalStringList = z.preprocess(
  (val) => {
    if (val === undefined || val === null) return undefined;
    if (typeof val === "string") {
      return val
        .split(/\r?\n/)
        .map((line) =>
          line
            .trim()
            .replace(/^[-*•]\s+/, "")
            .trim(),
        )
        .filter((line) => line.length > 0);
    }
    if (Array.isArray(val)) {
      return val
        .map((item) => (typeof item === "string" ? item.trim() : item))
        .filter((item) => typeof item !== "string" || item.length > 0);
    }
    return val;
  },
  z.array(z.string().min(1)).optional(),
);

const NonMcpDraftPatchSchema = z.object({
  title: optionalTrimmedString,
  priority: PrioritySchema.optional(),
  track: z.enum(["L1", "L2"]).optional(),
  workspace_mode: z.enum(["git_worktree", "host_scoped", "scratch_dir"]).optional(),
  workflow_preset: z.enum(["quick", "host_op", "standard_dev", "full_delivery"]).optional(),
  workflow: WorkflowBlueprintSchema.optional(),
  pm_rationale: optionalTrimmedString,
  depends_on: optionalStringList,
  open_questions: optionalStringList,
  brief_markdown: z.string().optional(),
  contract: z
    .object({
      goal: optionalTrimmedString,
      end: optionalTrimmedString,
      accept_cmd: optionalTrimmedString,
      scope: optionalStringList,
      non_goals: optionalStringList,
      deliver: DeliverConfigSchema.optional(),
    })
    .optional(),
});

const NonMcpContractPatchSchema = z.object({
  contract: z
    .object({
      goal: optionalTrimmedString,
      end: optionalTrimmedString,
      accept_cmd: optionalTrimmedString,
      accept_files_hash: optionalTrimmedString,
      scope: optionalStringList,
    })
    .optional(),
  affected_stages: z.array(StageIdSchema).min(1),
  rationale: z.string().min(1),
});

function extractLabeledJsonPatchBlock(
  rawText: string,
  label: string,
): { displayText: string; rawJson: string | null } {
  const anchoredPattern = new RegExp(
    "(^|\\r?\\n)[ \\t]*```" +
      label +
      "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*```[ \\t]*(?=\\r?\\n|$)",
    "gi",
  );
  const anchoredMatches = Array.from(rawText.matchAll(anchoredPattern));
  if (anchoredMatches.length > 0) {
    const rawJson = (anchoredMatches[anchoredMatches.length - 1]?.[2] ?? "").trim();
    const displayText = rawText
      .replace(anchoredPattern, "$1")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { displayText, rawJson };
  }

  const fallbackPattern = new RegExp("```" + label + "[ \\t]*\\r?\\n?([\\s\\S]*?)```", "gi");
  const fallbackMatches = Array.from(rawText.matchAll(fallbackPattern));
  if (fallbackMatches.length === 0) {
    return { displayText: rawText, rawJson: null };
  }
  const rawJson = (fallbackMatches[fallbackMatches.length - 1]?.[1] ?? "").trim();
  const displayText = rawText
    .replace(fallbackPattern, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { displayText, rawJson };
}

const KILN_BUILTIN_CHAT_COMMANDS: Readonly<Record<"intake" | "resolver", ChatCommandItem[]>> = {
  intake: [
    {
      name: "brief",
      description: "生成或更新右侧《产品方案 (BRIEF.md)》并同步立项契约",
      argumentHint: "[补充说明]",
      kind: "command",
      source: "kiln",
      action: "generate_brief",
    },
    {
      name: "fill",
      description: "让立项助手自动补全剩余缺失的立项字段",
      argumentHint: "[补充要求]",
      kind: "command",
      source: "kiln",
      action: "fill_draft",
    },
    {
      name: "split",
      description: "评估需求体量并建议垂直 MVP 切片拆分方案",
      argumentHint: "[拆分偏好]",
      kind: "command",
      source: "kiln",
      action: "split_slices",
    },
    {
      name: "new",
      description: "清空当前立项对话并开始新草稿（本地操作，不消耗 Token）",
      argumentHint: "",
      kind: "command",
      source: "kiln",
      action: "new_draft",
    },
  ],
  resolver: [
    {
      name: "summary",
      description: "梳理当前待决分歧、备选方案利弊与推荐决策",
      argumentHint: "",
      kind: "command",
      source: "kiln",
    },
    {
      name: "contract",
      description: "基于当前讨论生成需要修订的契约字段方案",
      argumentHint: "[修订说明]",
      kind: "command",
      source: "kiln",
    },
  ],
};

export function getBuiltinChatCommands(role: "intake" | "resolver"): ChatCommandItem[] {
  return KILN_BUILTIN_CHAT_COMMANDS[role].map((cmd) => ({ ...cmd }));
}

const PURE_CONTROL_SLASH_PATTERN = /^\/(?:compact|clear|autocompact|reset)(?:\s|$)/i;

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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
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
  options: { timeoutMs?: number; refresh?: boolean } = {},
): Promise<BackendsSnapshot> {
  if (!registry) {
    return { agents: [], backends: [], providerUsage: [] };
  }

  const backendsList = registry.list();
  if (backendsList.length === 0) {
    return { agents: [], backends: [], providerUsage: [] };
  }

  const baseTimeoutMs = options.timeoutMs ?? DEFAULT_BACKEND_QUERY_TIMEOUT_MS;
  const refresh = options.refresh === true;
  const effectiveTimeoutMs = refresh
    ? Math.max(baseTimeoutMs, DEFAULT_BACKEND_REFRESH_TIMEOUT_MS)
    : baseTimeoutMs;
  const agents: AgentSnapshotEntry[] = [];
  const backends: BackendConnectionSnapshot[] = [];
  const providerUsage: NormalizedProviderUsageEntry[] = [];

  await Promise.all(
    backendsList.map(async (backend) => {
      const prevCached = LAST_BACKEND_AGENTS_CACHE.get(backend);
      const prevModelsByAgent = new Map(
        prevCached?.agents.map((entry) => [entry.id, entry.models]) ?? [],
      );

      try {
        if (refresh && typeof backend.refreshProviders === "function") {
          await withTimeout(
            backend.refreshProviders(),
            effectiveTimeoutMs,
            `refreshProviders(${backend.backendId})`,
          );
        }

        const listedAgents = await withTimeout(
          backend.listAgents(),
          effectiveTimeoutMs,
          `listAgents(${backend.backendId})`,
        );

        const modelsByAgent = await Promise.all(
          listedAgents.map(async (agentDesc) => {
            try {
              return await withTimeout(
                backend.listModels(agentDesc.id),
                effectiveTimeoutMs,
                `listModels(${backend.backendId}:${agentDesc.id})`,
              );
            } catch {
              const prevModels = prevModelsByAgent.get(agentDesc.id);
              if (!refresh && prevModels && prevModels.length > 0) {
                return prevModels.map((m) => ({
                  ...m,
                  thinkingOptions: [...m.thinkingOptions],
                }));
              }
              return [] as BackendModelDescriptor[];
            }
          }),
        );

        const backendAgents: AgentSnapshotEntry[] = [];
        for (let i = 0; i < listedAgents.length; i++) {
          const agentDesc = listedAgents[i]!;
          backendAgents.push({
            id: agentDesc.id,
            label: agentDesc.label,
            backendId: backend.backendId,
            capabilities: { ...agentDesc.capabilities },
            modes: agentDesc.modes.map((m) => ({ ...m })),
            defaultModeId: agentDesc.defaultModeId ?? null,
            models: modelsByAgent[i] ?? [],
          });
        }

        LAST_BACKEND_AGENTS_CACHE.set(backend, {
          agents: backendAgents,
          updatedAt: Date.now(),
        });
        agents.push(...backendAgents);

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
              effectiveTimeoutMs,
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
        if (!refresh && prevCached) {
          agents.push(...prevCached.agents);
          backends.push({
            backendId: backend.backendId,
            id: backend.backendId,
            connected: true,
            status: "connected",
            detail: `${prevCached.agents.length} agent(s) (cached; refresh delayed: ${msg})`,
          });
          return;
        }
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
  env?: Record<string, string>;
}

export interface CompiledBinaryDetectInput {
  isBun?: boolean;
  argv1?: string;
  moduleUrl?: string;
  bunMain?: string;
}

function isBunVirtualFsPath(value: string): boolean {
  return (
    value.includes("/$bunfs/") || value.includes("\\$bunfs\\") || /[\\/]~BUN[\\/]/i.test(value)
  );
}

/**
 * Detects whether the current process is executing from a standalone single-file
 * Bun-compiled binary (`bun build --compile`). Returns `false` in Node.js and in
 * uncompiled `bun run` dev sessions.
 */
export function isCompiledKilnBinary(input?: CompiledBinaryDetectInput): boolean {
  const bunRuntime = (globalThis as { Bun?: { main?: unknown } }).Bun;
  const isBun = input?.isBun ?? typeof bunRuntime !== "undefined";
  if (!isBun) {
    return false;
  }

  const argv1 = input?.argv1 ?? process.argv[1] ?? "";
  if (isBunVirtualFsPath(argv1)) {
    return true;
  }

  const moduleUrl = input?.moduleUrl ?? import.meta.url;
  if (isBunVirtualFsPath(moduleUrl)) {
    return true;
  }

  const bunMain = input?.bunMain ?? (typeof bunRuntime?.main === "string" ? bunRuntime.main : "");
  if (isBunVirtualFsPath(bunMain)) {
    return true;
  }

  return false;
}

/**
 * Resolves the `kiln-mcp` stdio command specification used when mounting MCP tools onto agent sessions.
 * In standalone compiled binaries, invokes `[process.execPath, "__mcp"]` in-process via the hidden CLI entrypoint.
 */
export function resolveMcpServerCommand(
  override?: McpCommandSpec,
  options?: {
    compiledBinary?: boolean;
    execPath?: string;
    electronRuntime?: boolean;
    searchStartDir?: string;
  },
): McpCommandSpec {
  if (override) {
    return {
      command: override.command,
      args: [...override.args],
      ...(override.env ? { env: { ...override.env } } : {}),
    };
  }

  const electronRuntime =
    options?.electronRuntime ?? Boolean((process.versions as { electron?: string }).electron);
  const attachElectronEnv = (spec: McpCommandSpec): McpCommandSpec =>
    electronRuntime
      ? {
          ...spec,
          env: {
            ...spec.env,
            ELECTRON_RUN_AS_NODE: "1",
          },
        }
      : spec;
  const execPath = options?.execPath ?? process.execPath;

  const compiled = options?.compiledBinary ?? isCompiledKilnBinary();
  if (compiled) {
    return {
      command: execPath,
      args: ["__mcp"],
    };
  }

  let current = options?.searchStartDir ?? import.meta.dirname;
  for (let i = 0; i < 6; i++) {
    const flatElectronMcp = path.join(current, "kiln-mcp.mjs");
    if (fs.existsSync(flatElectronMcp)) {
      return attachElectronEnv({ command: execPath, args: [flatElectronMcp] });
    }
    const candidate = path.join(current, "packages", "mcp", "dist", "bin.js");
    if (fs.existsSync(candidate)) {
      return attachElectronEnv({ command: execPath, args: [candidate] });
    }
    const siblingCandidate = path.join(current, "mcp", "dist", "bin.js");
    if (fs.existsSync(siblingCandidate)) {
      return attachElectronEnv({ command: execPath, args: [siblingCandidate] });
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
  stateMachine?: TaskStateMachine;
  providerHealth?: ProviderHealthTracker;
  sseHub?: SseHub;
  caffeinate?: CaffeinateController;
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
  onContractUpdated?: (taskId: string) => void;
  extensionsHomeDir?: string;
}

interface ResolvedInteractiveExecutor {
  backend: ExecutionBackend;
  agent: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  allowFullAccessFallback: boolean;
  mcpEnabled: boolean;
}

/**
 * Interactive chat engine backing `intake` (draft planning) and `resolver` (pending decision
 * discussion & contract refinement), enforcing `interactiveChat` and routing non-MCP agents
 * through structured patch blocks while persisting conversation logs atomically to disk.
 */
export class KilnChatEngine {
  private readonly store: KilnStore;
  private readonly backendRegistry: BackendRegistry;
  private readonly pendingDecisions: PendingDecisionStore;
  private readonly stateMachine: TaskStateMachine | undefined;
  private readonly providerHealth: ProviderHealthTracker | undefined;
  private readonly sseHub: SseHub | undefined;
  private readonly caffeinate: CaffeinateController | undefined;
  private readonly socketPath: string;
  private readonly issueRunToken: KilnChatEngineOptions["issueRunToken"];
  private readonly mcpServerCommand: McpCommandSpec;
  private readonly chatResponder: ChatResponder | undefined;
  private readonly onContractUpdated: ((taskId: string) => void) | undefined;
  private readonly extensionsHomeDir: string | undefined;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: KilnChatEngineOptions) {
    this.store = options.store;
    this.backendRegistry = options.backendRegistry;
    this.pendingDecisions = options.pendingDecisions;
    this.stateMachine = options.stateMachine;
    this.providerHealth = options.providerHealth;
    this.sseHub = options.sseHub;
    this.caffeinate = options.caffeinate;
    this.socketPath = options.socketPath;
    this.issueRunToken = options.issueRunToken;
    this.mcpServerCommand = resolveMcpServerCommand(options.mcpServerCommand);
    this.chatResponder = options.chatResponder;
    this.onContractUpdated = options.onContractUpdated;
    this.extensionsHomeDir = options.extensionsHomeDir;
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

  private expandKilnBuiltinSlashPrompt(role: "intake" | "resolver", trimmed: string): string {
    if (!trimmed.startsWith("/")) {
      return trimmed;
    }
    const match = /^\/([a-zA-Z0-9_:-]+)(?:\s+([\s\S]+))?$/.exec(trimmed);
    if (!match) {
      return trimmed;
    }
    const name = match[1]!.toLowerCase();
    const args = (match[2] ?? "").trim();
    const extra = args ? `\n用户补充要求：${args}` : "";

    if (role === "intake") {
      if (name === "brief") {
        return `请基于当前对话与仓库只读事实，立即生成或更新完整的《产品方案 (BRIEF.md)》并同步补全右侧立项契约字段。${extra}`;
      }
      if (name === "fill") {
        return `请检查并自动推导补全当前立项单中缺失的标题、交付终点、验收命令、可改范围及前置依赖等字段。${extra}`;
      }
      if (name === "split") {
        return `请评估当前需求的复杂度与工作量，并给出建议的垂直 MVP 切片拆分方案（每片可独立交付与验收），说明推荐先落哪一片。${extra}`;
      }
    } else {
      if (name === "summary") {
        return `请梳理当前待决问题的核心分歧、各备选方案的利弊与改动代价，并给出你的推荐决策。${extra}`;
      }
      if (name === "contract") {
        return `请根据我们目前的讨论，整理并提出需要修订的任务契约字段（goal、end、accept_cmd、scope）方案供我拍板。${extra}`;
      }
    }
    return trimmed;
  }

  private buildMentionContextNote(trimmed: string): string | null {
    const blocks: string[] = [];

    const taskIds = new Set<string>();
    for (const m of trimmed.matchAll(/@task:([a-zA-Z0-9_-]+)/g)) {
      if (m[1]) taskIds.add(m[1]);
      if (taskIds.size >= 4) break;
    }
    for (const rawId of taskIds) {
      try {
        const safeId = assertSafeSegment(rawId, "taskId");
        const card = this.store.readTaskCard(safeId);
        const derived = deriveTaskStatus(card, this.store.readStateEvents(safeId));
        blocks.push(
          `- 任务 ${card.id} [${derived.status}/${derived.priority}] 《${card.title}》：goal=${card.contract.goal} | end=${card.contract.end} | scope=${card.contract.scope.join(", ")}`,
        );
      } catch {
        // Ignore non-existent or unsafe task references
      }
    }

    const ledgerSpaces = new Set<string>();
    for (const m of trimmed.matchAll(/@ledger:([a-zA-Z0-9_-]+)/g)) {
      if (m[1]) ledgerSpaces.add(m[1]);
      if (ledgerSpaces.size >= 4) break;
    }
    for (const rawSpace of ledgerSpaces) {
      try {
        const safeSpace = assertSafeSegment(rawSpace, "space");
        const ledger = this.store.readLedger(safeSpace);
        if (ledger && ledger.entries.length > 0) {
          const rules = ledger.entries
            .slice(0, 8)
            .map((e) => e.rule)
            .join("；");
          blocks.push(`- 空间 ${safeSpace} 决策账本（${ledger.entries.length} 条）：${rules}`);
        }
      } catch {
        // Ignore invalid ledger space references
      }
    }

    const mcpNames = new Set<string>();
    for (const m of trimmed.matchAll(/@mcp:([a-zA-Z0-9._:-]+)/g)) {
      if (m[1]) mcpNames.add(m[1]);
      if (mcpNames.size >= 4) break;
    }
    for (const mcpName of mcpNames) {
      blocks.push(
        `- 指定外部 MCP 服务 ${mcpName}：请优先通过已配置的 MCP 服务 "${mcpName}" 获取所需上下文或执行只读查询（若当前会话未挂载该 MCP，请明确说明）。`,
      );
    }

    if (blocks.length === 0) {
      return null;
    }
    return `[用户引用上下文:\n${blocks.join("\n")}\n]`;
  }

  private buildSkillDirectiveNote(params: {
    role: "intake" | "resolver";
    trimmed: string;
    projectDir: string | null;
    agent: string | null;
  }): string | null {
    if (!params.trimmed.startsWith("/")) {
      return null;
    }
    const match = /^\/([a-zA-Z0-9_:-]+)(?:\s|$)/.exec(params.trimmed);
    const cmdName = match?.[1]?.trim();
    if (!cmdName) {
      return null;
    }
    const cmdLower = cmdName.toLowerCase();
    if (KILN_BUILTIN_CHAT_COMMANDS[params.role].some((c) => c.name.toLowerCase() === cmdLower)) {
      return null;
    }
    const skills = discoverSkills({
      projectDir: params.projectDir,
      kilnHome: this.store.paths.home,
      agent: params.agent,
      ...(this.extensionsHomeDir !== undefined ? { homeDir: this.extensionsHomeDir } : {}),
    });
    const matched = skills.find((s) => s.name.toLowerCase() === cmdLower);
    if (!matched) {
      return null;
    }
    return `[调用技能 ${matched.name}：请先只读读取技能说明文件 ${matched.skillMdPath} 并严格按其流程与约束执行。]`;
  }

  private composePromptForAgent(effectiveMessage: string, contextLines: readonly string[]): string {
    const filtered = contextLines.filter((line) => line.trim().length > 0);
    if (effectiveMessage.startsWith("/")) {
      if (PURE_CONTROL_SLASH_PATTERN.test(effectiveMessage) || filtered.length === 0) {
        return effectiveMessage;
      }
      // Keep skill invocation at index 0 while attaching skill/mention guidance cleanly after.
      return `${effectiveMessage}\n\n${filtered.join("\n")}`;
    }
    if (filtered.length === 0) {
      return effectiveMessage;
    }
    return `${filtered.join("\n")}\n\n${effectiveMessage}`;
  }

  async listChatCommands(params: {
    role: "intake" | "resolver";
    draftId?: string;
    spaceId?: string;
    taskId?: string;
  }): Promise<ChatCommandsResponse> {
    const builtins = getBuiltinChatCommands(params.role);
    const builtinNames = new Set(builtins.map((c) => c.name.toLowerCase()));

    const rolesConfig = this.store.readConfig("roles");
    const configured = rolesConfig?.roles[params.role];

    let executor: ResolvedInteractiveExecutor | null = null;
    try {
      executor = await this.resolveInteractiveExecutor(params.role);
    } catch {
      executor = null;
    }
    const agent = executor?.agent ?? configured?.agent ?? null;
    const model = executor?.model ?? configured?.model ?? null;

    let projectDir: string | null = null;
    if (params.draftId) {
      try {
        const safeDraftId = assertSafeSegment(params.draftId, "draftId");
        const draft = this.store.readDraft(safeDraftId);
        if (draft && draft.space !== "local") {
          const spaceCfg = this.store.readSpace(draft.space);
          if (spaceCfg?.repo_path && fs.existsSync(spaceCfg.repo_path)) {
            projectDir = spaceCfg.repo_path;
          }
        }
      } catch {
        // Fallback to taskId/spaceId
      }
    } else if (params.taskId) {
      try {
        const safeTaskId = assertSafeSegment(params.taskId, "taskId");
        const card = this.store.readTaskCard(safeTaskId);
        if (card.space !== "local") {
          const spaceCfg = this.store.readSpace(card.space);
          if (spaceCfg?.repo_path && fs.existsSync(spaceCfg.repo_path)) {
            projectDir = spaceCfg.repo_path;
          }
        }
      } catch {
        // Fallback
      }
    } else if (params.spaceId && params.spaceId !== "local") {
      try {
        const safeSpace = assertSafeSegment(params.spaceId, "space");
        const spaceCfg = this.store.readSpace(safeSpace);
        if (spaceCfg?.repo_path && fs.existsSync(spaceCfg.repo_path)) {
          projectDir = spaceCfg.repo_path;
        }
      } catch {
        // Fallback
      }
    }

    const discoveryOpts = {
      projectDir,
      kilnHome: this.store.paths.home,
      agent,
      ...(this.extensionsHomeDir !== undefined ? { homeDir: this.extensionsHomeDir } : {}),
    };
    const skills = discoverSkills(discoveryOpts);
    const skillItems: ChatCommandItem[] = [];
    for (const skill of skills) {
      if (builtinNames.has(skill.name.toLowerCase())) {
        continue;
      }
      skillItems.push({
        name: skill.name,
        description: skill.description,
        argumentHint: "",
        kind: "skill",
        source: "skill",
        scope: skill.scope,
      });
    }
    const mcpServers = discoverMcpServers(discoveryOpts);

    return {
      ok: true,
      role: params.role,
      agent,
      model,
      commands: [...builtins, ...skillItems],
      mcpServers,
    };
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

  private async findBackendForAgent(
    agent: string,
    backendId?: string,
  ): Promise<ExecutionBackend | null> {
    if (backendId) {
      return this.backendRegistry.has(backendId) ? this.backendRegistry.get(backendId) : null;
    }
    for (const candidate of this.backendRegistry.list()) {
      try {
        const listed = await candidate.listAgents();
        if (listed.some((a) => a.id === agent)) {
          return candidate;
        }
      } catch {
        // Try remaining registered backends
      }
    }
    return null;
  }

  private async resolveInteractiveExecutor(
    role: "intake" | "resolver",
  ): Promise<ResolvedInteractiveExecutor | null> {
    const rosterConfig = this.store.readEffectiveRosterConfig();
    let rosterAssignment: ReturnType<typeof resolveRosterStageAssignment> = null;
    try {
      rosterAssignment = resolveRosterStageAssignment(
        rosterConfig,
        role === "intake" ? "intake" : "advise",
        role,
        {
          isCoolingDown: (key) => this.providerHealth?.isInCooldown(key.agent) ?? false,
        },
      );
    } catch (err) {
      if (!(err instanceof RoleNotConfiguredError)) {
        throw err;
      }
    }

    if (rosterAssignment) {
      const targetBackend = await this.findBackendForAgent(
        rosterAssignment.agent,
        rosterAssignment.backendId,
      );
      if (targetBackend) {
        const caps = await targetBackend.capabilities(rosterAssignment.agent);
        assertRoleAgentEligible(role, rosterAssignment.agent, caps);
        return {
          backend: targetBackend,
          agent: rosterAssignment.agent,
          model: rosterAssignment.model,
          ...(rosterAssignment.reasoningEffort !== undefined
            ? { reasoningEffort: rosterAssignment.reasoningEffort }
            : {}),
          allowFullAccessFallback: rosterAssignment.allowFullAccessFallback,
          mcpEnabled: caps.mcpInjection,
        };
      }
      if (this.chatResponder) {
        return null;
      }
      throw new ServerHttpError(409, {
        error: "backend_unavailable",
        role,
        agent: rosterAssignment.agent,
        message: `No connected ExecutionBackend exposes agent "${rosterAssignment.agent}" for role "${role}"`,
      });
    }

    const rolesConfig = this.store.readConfig("roles");
    const assignment = rolesConfig?.roles[role];

    if (assignment) {
      const targetBackend = await this.findBackendForAgent(assignment.agent, assignment.backend_id);

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
        mcpEnabled: caps.mcpInjection,
      };
    }

    // No explicit role configured: prefer non-full-access interactive+MCP agents,
    // then non-full-access interactive agents without MCP (never auto-select full-access-only).
    let nonMcpFallback: ResolvedInteractiveExecutor | null = null;
    let firstIneligible: { agent: string; caps: BackendAgentDescriptor["capabilities"] } | null =
      null;
    for (const backend of this.backendRegistry.list()) {
      try {
        const listed = await backend.listAgents();
        for (const agentDesc of listed) {
          const fullAccessOnly =
            agentDesc.modes.length > 0 && agentDesc.modes.every((mode) => isFullAccessMode(mode));
          if (agentDesc.capabilities.interactiveChat && !fullAccessOnly) {
            const models = await backend.listModels(agentDesc.id).catch(() => []);
            const model = models[0]?.id ?? "default";
            const candidate: ResolvedInteractiveExecutor = {
              backend,
              agent: agentDesc.id,
              model,
              allowFullAccessFallback: false,
              mcpEnabled: agentDesc.capabilities.mcpInjection,
            };
            if (agentDesc.capabilities.mcpInjection) {
              return candidate;
            }
            if (!nonMcpFallback) {
              nonMcpFallback = candidate;
            }
            continue;
          }
          if (!agentDesc.capabilities.interactiveChat && !firstIneligible) {
            firstIneligible = { agent: agentDesc.id, caps: agentDesc.capabilities };
          }
        }
      } catch {
        // Ignore offline backend while scanning fallback candidates
      }
    }

    if (nonMcpFallback) {
      return nonMcpFallback;
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
        ...(this.mcpServerCommand.env ?? {}),
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
    onProgress?: (ev: RunEvent) => void,
  ): Promise<{ replyText: string; toolMessages: ChatMessageRecord[] }> {
    const fullMessages: string[] = [];
    const deltaChunks: string[] = [];
    const toolMessages: ChatMessageRecord[] = [];
    let exitEvent: Extract<RunEvent, { kind: "exit" }> | null = null;

    for await (const ev of backend.events(sessionRef)) {
      if (ev.kind === "thinking") {
        onProgress?.(ev);
      } else if (ev.kind === "message") {
        if (ev.delta) {
          deltaChunks.push(ev.text);
        } else if (ev.text.trim().length > 0) {
          fullMessages.push(ev.text);
        }
      } else if (ev.kind === "tool") {
        onProgress?.(ev);
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
      fullMessages.length > 0 ? fullMessages.join("\n").trim() : deltaChunks.join("").trim();

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

  private formatDraftSnapshotLine(draft: DraftCard): string {
    const brief = this.store.readDraftBrief(draft.id);
    const hasBrief = brief !== null && brief.trim().length > 0;
    const openCount = draft.open_questions?.length ?? 0;
    return `[当前右侧草稿最新字段: title=${draft.title || "(未填)"}, space=${draft.space}, priority=${draft.priority}, track=${draft.track}, workspace_mode=${draft.workspace_mode}, end=${draft.contract.end ?? "(未填)"}, accept_cmd=${draft.contract.accept_cmd ?? "(未填)"}, scope=${draft.contract.scope?.join(", ") || "(未填)"}, depends_on=${draft.depends_on.join(", ") || "无"}, brief=${hasBrief ? "已生成" : "未生成"}, open_questions=${openCount}项${
      openCount > 0 ? ` (${draft.open_questions!.join(" | ")})` : ""
    }]`;
  }

  private applyNonMcpDraftPatch(params: {
    safeDraftId: string;
    fallbackDraft: DraftCard;
    rawJson: string;
  }): { applied: boolean; updatedFields: string[]; errorDetail?: string } {
    try {
      const parsedJson = JSON.parse(params.rawJson) as unknown;
      const patch = NonMcpDraftPatchSchema.parse(parsedJson);
      const latest = this.store.readDraft(params.safeDraftId) ?? params.fallbackDraft;
      const updatedFields: string[] = [];

      let nextWorkspaceMode = latest.workspace_mode;
      if (latest.space === "local") {
        if (patch.workspace_mode === "scratch_dir" || patch.workspace_mode === "host_scoped") {
          nextWorkspaceMode = patch.workspace_mode;
          updatedFields.push("workspace_mode");
        } else if (patch.workflow_preset === "host_op" && nextWorkspaceMode !== "host_scoped") {
          nextWorkspaceMode = "host_scoped";
          updatedFields.push("workspace_mode");
        } else if (nextWorkspaceMode === "git_worktree") {
          nextWorkspaceMode = "scratch_dir";
        }
      } else {
        nextWorkspaceMode = "git_worktree";
      }

      const nextContract = { ...latest.contract };
      if (patch.contract) {
        if (patch.contract.goal !== undefined) {
          nextContract.goal = patch.contract.goal;
          updatedFields.push("contract.goal");
        }
        if (patch.contract.end !== undefined) {
          nextContract.end = patch.contract.end;
          updatedFields.push("contract.end");
        }
        if (patch.contract.accept_cmd !== undefined) {
          nextContract.accept_cmd = patch.contract.accept_cmd;
          updatedFields.push("contract.accept_cmd");
        }
        if (patch.contract.scope !== undefined) {
          nextContract.scope = patch.contract.scope;
          updatedFields.push("contract.scope");
        }
        if (patch.contract.non_goals !== undefined) {
          nextContract.non_goals = patch.contract.non_goals;
          updatedFields.push("contract.non_goals");
        }
        if (patch.contract.deliver !== undefined) {
          nextContract.deliver = patch.contract.deliver;
          updatedFields.push("contract.deliver");
        }
      }

      let nextWorkflow: WorkflowBlueprint | undefined = latest.workflow;
      if (patch.workflow !== undefined) {
        nextWorkflow = patch.workflow;
        updatedFields.push("workflow");
      } else if (patch.workflow_preset !== undefined) {
        nextWorkflow = buildWorkflowPreset(patch.workflow_preset, {
          hasDeliverCmd: nextContract.deliver?.mode === "run_cmd",
        });
        updatedFields.push("workflow");
      }

      const hasDeliverCmd = nextContract.deliver?.mode === "run_cmd";
      if (nextWorkflow !== undefined) {
        const toggles = extractWorkflowToggles(nextWorkflow);
        if (nextWorkspaceMode === "host_scoped" && !toggles.hostTwoPhase) {
          nextWorkflow = buildCustomWorkflow({
            ...toggles,
            preset: nextWorkflow.preset === "custom" ? "custom" : "host_op",
            hostTwoPhase: true,
            deliverApproval: true,
            hasDeliverCmd,
          });
          if (!updatedFields.includes("workflow")) updatedFields.push("workflow");
        } else if (nextWorkspaceMode !== "host_scoped" && toggles.hostTwoPhase) {
          nextWorkflow = buildCustomWorkflow({
            ...toggles,
            preset: nextWorkflow.preset === "host_op" ? "standard_dev" : nextWorkflow.preset,
            hostTwoPhase: false,
            hasDeliverCmd,
          });
          if (!updatedFields.includes("workflow")) updatedFields.push("workflow");
        }
      }
      if (patch.pm_rationale !== undefined && nextWorkflow !== undefined) {
        nextWorkflow = {
          ...nextWorkflow,
          pm_rationale: patch.pm_rationale,
        };
        if (!updatedFields.includes("workflow")) updatedFields.push("workflow");
      }

      let nextTrack = patch.track ?? latest.track;
      if (
        patch.track === undefined &&
        (patch.workflow_preset !== undefined || nextWorkflow !== undefined)
      ) {
        const effectivePreset = nextWorkflow?.preset ?? patch.workflow_preset;
        nextTrack =
          effectivePreset === "quick" || effectivePreset === "host_op"
            ? "L1"
            : nextWorkflow
              ? extractWorkflowToggles(nextWorkflow).includeReview
                ? "L2"
                : "L1"
              : nextTrack;
      }

      if (patch.title !== undefined) updatedFields.push("title");
      if (patch.priority !== undefined) updatedFields.push("priority");
      if (patch.track !== undefined || nextTrack !== latest.track) updatedFields.push("track");
      if (patch.depends_on !== undefined) updatedFields.push("depends_on");
      if (patch.open_questions !== undefined) updatedFields.push("open_questions");

      const nextOpenQuestions =
        patch.open_questions !== undefined ? patch.open_questions : latest.open_questions;

      const merged = DraftCardSchema.parse({
        ...latest,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        track: nextTrack,
        workspace_mode: nextWorkspaceMode,
        ...(nextWorkflow !== undefined ? { workflow: nextWorkflow } : {}),
        ...(patch.depends_on !== undefined ? { depends_on: patch.depends_on } : {}),
        ...(nextOpenQuestions !== undefined ? { open_questions: nextOpenQuestions } : {}),
        contract: nextContract,
        updated_at: new Date().toISOString(),
      });
      this.store.writeDraft(merged);

      if (patch.brief_markdown !== undefined) {
        this.store.writeDraftBrief(params.safeDraftId, patch.brief_markdown);
        updatedFields.push("brief_markdown");
      }

      this.sseHub?.publish({
        type: "intake.progress",
        draftId: params.safeDraftId,
        kind: "draft_updated",
        toolName: "draft_patch",
        text:
          patch.brief_markdown !== undefined && patch.brief_markdown.trim().length > 0
            ? "已同步《产品方案》与立项草稿"
            : "已更新立项草稿字段",
        at: new Date().toISOString(),
      });
      return { applied: true, updatedFields };
    } catch (err) {
      return {
        applied: false,
        updatedFields: [],
        errorDetail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private applyNonMcpContractPatch(params: { safeTaskId: string; rawJson: string }): {
    applied: boolean;
    message: string;
  } {
    if (!this.stateMachine) {
      return {
        applied: false,
        message: "contract_patch · 当前服务器未挂载状态机，已跳过契约自动更新",
      };
    }

    try {
      const parsedJson = JSON.parse(params.rawJson) as unknown;
      const patch = NonMcpContractPatchSchema.parse(parsedJson);
      if (!patch.contract || Object.keys(patch.contract).length === 0) {
        return {
          applied: false,
          message: "contract_patch · 补丁未包含任何契约字段改动，已跳过",
        };
      }

      const card = this.store.readTaskCard(params.safeTaskId);
      const previousStatus = deriveTaskStatus(
        card,
        this.store.readStateEvents(params.safeTaskId),
      ).status;
      if (previousStatus === "done" || previousStatus === "cancelled") {
        return {
          applied: false,
          message: `contract_patch · 任务已处于终态（${previousStatus}），已跳过契约修改`,
        };
      }

      if (
        patch.contract.accept_cmd !== undefined &&
        patch.contract.accept_cmd !== card.contract.accept_cmd &&
        (patch.contract.accept_files_hash === undefined ||
          patch.contract.accept_files_hash === card.contract.accept_files_hash)
      ) {
        return {
          applied: false,
          message:
            "contract_patch · 修改 accept_cmd 需同步提供新的 accept_files_hash，已跳过自动修改",
        };
      }

      const updated = this.stateMachine.updateContract({
        taskId: params.safeTaskId,
        contractPatch: patch.contract,
        affectedStages: patch.affected_stages,
        ...(patch.contract.accept_files_hash !== undefined
          ? { acceptFilesHash: patch.contract.accept_files_hash }
          : {}),
        now: new Date().toISOString(),
      });

      if (updated.state.status === "waiting") {
        const rebound = this.pendingDecisions.rebindContractVersion(
          params.safeTaskId,
          updated.newVersion,
        );
        if (previousStatus !== "waiting" && rebound) {
          this.sseHub?.publish({
            type: "decision.requested",
            taskId: params.safeTaskId,
            priority:
              this.store.getTaskIndex(params.safeTaskId)?.priority ?? updated.state.priority,
            question: rebound.question,
          });
        }
      }

      this.caffeinate?.syncRunningCount(countRunningLeafTasks(this.store));
      this.sseHub?.publish({
        type: "task.updated",
        taskId: params.safeTaskId,
        patch: {
          status: updated.state.status,
          ...(updated.state.stage !== null ? { stage: updated.state.stage } : {}),
          contractVersion: updated.newVersion,
        },
      });
      this.onContractUpdated?.(params.safeTaskId);

      return {
        applied: true,
        message: `contract_patch · 契约已升至 v${updated.newVersion}（${patch.rationale}）`,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        applied: false,
        message: `contract_patch · 契约补丁校验未通过（${detail}），请核对或直接使用右侧选项拍板`,
      };
    }
  }

  private buildIntakeSystemPrompt(params: {
    draft: DraftCard;
    spaceConfig: SpaceConfig | null;
    allSpaces: readonly SpaceConfig[];
    cwd: string;
    isProjectRepo: boolean;
    priorHistory: readonly ChatMessageRecord[];
    mcpEnabled: boolean;
  }): string {
    const { draft, spaceConfig, allSpaces, cwd, isProjectRepo, priorHistory, mcpEnabled } = params;
    const tasks = this.store.listTasks().slice(0, 20);
    const ledger = this.store.readLedger(draft.space);
    const activeLedger =
      ledger && ledger.entries.length > 0
        ? selectActiveLedgerEntriesForHandoff(ledger.entries)
        : [];
    const taskLines =
      tasks.length > 0
        ? tasks.map((t) => `- ${t.id} [${t.status}/${t.priority}] ${t.title}`).join("\n")
        : "(暂无在途任务)";
    const ledgerLines =
      activeLedger.length > 0
        ? activeLedger.map((e) => `- ${e.rule}`).join("\n")
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
          `**只读探索约束**：你当前位于项目仓库目录 (${cwd})，可只读检索代码、目录结构与测试脚本以确定准确的可改范围 (scope) 与验收命令 (accept_cmd)；**严禁直接修改项目源码文件或执行 git 写入命令**${
            mcpEnabled
              ? `，只允许通过 wb_plan(mode: "upsert_draft") 更新草稿`
              : `，只允许通过回复末尾 \`\`\`kiln-draft-patch\`\`\` JSON 块回填草稿`
          }。`,
        ].join("\n")
      : [
          `当前任务模式：本机 / 临时任务（非 Git 项目空间，cwd=${cwd}）`,
          `可用 workspace_mode 仅限 scratch_dir（独立临时沙盒）或 host_scoped（本机白名单文件两阶段暂存，严禁在立项阶段直接改动宿主机文件）。`,
          `严禁将当前立项临时目录（${cwd} 或任何 ~/.kiln/drafts/ 路径）写入 contract.end、accept_cmd 或 scope：立项提交后草稿目录会被自动删除。scratch_dir 模式请使用相对工作区路径，host_scoped 模式请使用用户明确指定的宿主机持久化路径。`,
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
      `- open_questions: ${
        draft.open_questions && draft.open_questions.length > 0
          ? draft.open_questions.join(" | ")
          : "无"
      }`,
    ].join("\n");

    const currentBrief = this.store.readDraftBrief(draft.id);
    const currentBriefSection =
      currentBrief && currentBrief.trim().length > 0
        ? `当前已记录的《产品方案 (BRIEF.md)》：\n${currentBrief.trim()}`
        : "(尚未生成《产品方案 (BRIEF.md)》，请在本轮完成后输出并同步)";

    const draftResearch = this.store.readDraftResearch(draft.id);
    const draftResearchSection =
      draftResearch && draftResearch.trim().length > 0
        ? [
            `## 前置侦察简报 (RESEARCH.md · 由用户配置的 researcher 生成)`,
            `以下为立项前只读扫描产出的项目环境与代码地图，请先基于此简报与用户确认方案与验收边界；仅对存疑细节做定点核查，避免重复全仓扫盘：`,
            draftResearch.trim(),
          ].join("\n")
        : "";

    const pmWorkflowProtocol = [
      `你的职责是 Kiln 的产品经理与技术立项架构师（intake）：将用户的原始想法打磨为清晰、无歧义、可执行的产品设计方案（BRIEF.md）与工程契约，并将确认后的方案无损传递给下游执行角色。`,
      `核心工作方法（四步协议 + D25/D26 规则）：`,
      `1. **三档自适应对话节奏（D26）**：明确小活 0–1 轮直接推导并补齐完整字段供一语发车；有边界盲区 1–2 轮给出带「推荐」与代价的结构化分叉选项；模糊或较大需求围绕《产品方案 (BRIEF.md)》收敛；需求过大时主动拆出 2–12 张带 \`depends_on_temp_ids\` 依赖关系的垂直切片（可调用 \`wb_plan(mode: "commit_split_cards")\`）。`,
      `2. **先查侦察简报、账本与常备阵容（D25）**：若上方已提供前置侦察简报（RESEARCH.md）则优先直接采用；否则在项目仓库只读核查关键源码、脚本与空间账本（ledger）。结合下方「当前待命 Agent 阵容池」的角色定位、档位（tier）、特性（traits）、权限（perm）与冷却状态，只点将本任务真正需要的角色（设计了不必全上，在 \`workflow.steps[].roster_role\` 与 \`rationale\` 及 \`workflow.pm_rationale\` 说明排兵理由；严禁将 \`read_only\` 角色点将到 \`implement\`）。`,
      `3. **清晰目标与明确不做什么（non_goals）**：只聚焦产品目标、规则、外部行为与范围边界，显式锁定 \`contract.non_goals\`；若存在关键分歧在 \`open_questions\` 维护待决事项（确认后置空 []）。`,
      `4. **L1 / L2 自适应探索深度**：`,
      draft.track === "L1"
        ? `- 当前为 **L1 快车道**：保持 1–2 轮高效收敛，避免过度访谈；生成精简 4 段设计稿（目标与改动、边界约束、方案要点、验收命令）并尽快补齐全部契约字段。`
        : `- 当前为 **L2 标准交付**：确保业务规则、多状态流转、异常边界与人工兜底全部梳理清晰，直至 open_questions 清零；BRIEF.md 固定采用 5 段结构：\n  ## 1. 目标与用户场景\n  ## 2. 已确认规则与关键流程 / 边界\n  ## 3. 选定落地方案与关键取舍\n  ## 4. 范围边界（做什么 / 明确不做什么）\n  ## 5. 可观察验收场景`,
      `自动补全与安全边界：用户已在前端通过 Tab 选定了项目空间、优先级或轨道；请主动替用户推导并回填 title、end、accept_cmd、scope、non_goals、depends_on、open_questions 与 brief_markdown，严禁私自调用 commit_card 直接建卡（必须由用户点击「开始推进」确认）。`,
      `5. **可组合流程蓝图预设**：按任务复杂度优先选用 4 套配方之一：\`quick\`（快速通道：实施→验真→交付，适合简单脚本/小改）、\`host_op\`（本机两阶段操作：实施暂存 dry-run→staged_only 门禁→单一交付审批后由内核原子落盘+执行+终审）、\`standard_dev\`（标准开发：实施⇄审查循环→交付，默认项目开发）、\`full_delivery\`（完整交付：顾问出方案 PLAN.md→实施⇄审查→独立验收→交付审批）。跨模块深挖可前置加入 \`research\` 节点（\`research -> plan\`），由 \`researcher\` 先补齐深层代码地图后再交 \`architect\` 设计 \`PLAN.md\`。若为 \`host_op\` 涉及本机实际执行命令，应把待执行命令放入 \`contract.deliver: { mode: "run_cmd", cmd: "..." }\`、把最终校验命令放入 \`contract.accept_cmd\`，Phase 1 只生成暂存脚本与校验报告，切勿让正式宿主验收命令在审批落盘前执行。`,
    ].join("\n");

    const rosterConfig = this.store.readEffectiveRosterConfig();
    const enabledRosterEntries = Object.entries(rosterConfig.roster).filter(
      ([, entry]) => entry.enabled,
    );
    const rosterLines =
      enabledRosterEntries.length > 0
        ? enabledRosterEntries
            .map(([id, entry]) => {
              const primaryLabel = entry.primary
                ? `${entry.primary.provider}/${entry.primary.model}`
                : entry.mode === "kernel"
                  ? "kernel(0-token)"
                  : entry.mode === "on_conflict"
                    ? "unset(on_conflict)"
                    : "unset";
              const tierLabel = entry.tier_hint ? `tier=${entry.tier_hint} | ` : "";
              const escLabel = entry.escalation_target
                ? `escalate->${entry.escalation_target} | `
                : "";
              const cooling =
                entry.primary && this.providerHealth?.isInCooldown(entry.primary.provider)
                  ? " [冷却中]"
                  : "";
              return `- ${id} (${entry.name}) | stage=${entry.stage} | perm=${entry.perm} | ${tierLabel}${escLabel}primary=${primaryLabel}${cooling} | traits=${entry.traits}`;
            })
            .join("\n")
        : "(当前暂无已启用 Agent 阵容，将按默认流程推进)";

    const attachmentsSection =
      draft.attachments && draft.attachments.length > 0
        ? `当前草稿附件截图 (${draft.attachments.length})：\n${draft.attachments
            .map(
              (a) =>
                `- ${a.filename} (${a.mime_type}, ${a.size_bytes} bytes, rel_path=${a.rel_path})`,
            )
            .join("\n")}`
        : "";

    const priorSummary = this.formatPriorChatSummary(priorHistory);
    const spaceChecklistSection =
      spaceConfig?.intake_checklist && spaceConfig.intake_checklist.length > 0
        ? [
            `## 本项目立项核对清单（历史复盘沉淀，提交契约前请主动与用户核对）`,
            ...spaceConfig.intake_checklist.map((item, idx) => `${idx + 1}. ${item}`),
          ].join("\n")
        : "";
    const defaultPresetHint = spaceConfig?.default_workflow_preset
      ? `\n- 当前空间推荐默认蓝图（历史调优沉淀）：\`${spaceConfig.default_workflow_preset}\``
      : "";
    const protocolInstruction = mcpEnabled
      ? `你拥有 kiln-mcp 工具权限（wb_list_tasks, wb_read_ledger, wb_plan），请每轮及时调用 wb_plan(mode: "upsert_draft") 将已确定的 title、workflow（含 steps[].roster_role / rationale / pm_rationale）、contract（goal/end/accept_cmd/scope/non_goals/deliver）、depends_on、open_questions 与完整 brief_markdown 同步写入草稿与 BRIEF.md；拆多卡时可调用 wb_plan(mode: "commit_split_cards")。`
      : [
          `当前对话运行在无 MCP 模式：已将项目空间、在途任务、长期账本、待命阵容池、当前方案与草稿字段注入上下文，无需调用 kiln-mcp 工具。`,
          `如本次对话确认或变更了任何立项字段或产品方案，请在正常回复末尾附一个 \`\`\`kiln-draft-patch\\n{...}\\n\`\`\` JSON 代码块（可选字段：title (string)、priority ("P0"|"P1"|"P2"|"P3")、track ("L1"|"L2")、workflow_preset ("quick"|"host_op"|"standard_dev"|"full_delivery")、workflow (对象)、pm_rationale (string)、workspace_mode ("git_worktree"|"host_scoped"|"scratch_dir")、depends_on (string[])、open_questions (string[])、brief_markdown (string，完整 Markdown 设计方案)、contract: { goal (string), end (string), accept_cmd (string), scope (string[]), non_goals?: string[], deliver?: { mode: "merge_main"|"open_pr"|"manual" } | { mode: "run_cmd", cmd: string } }；严禁更改 space 或直接建卡）。系统会自动剥离该代码块并同步到右侧「产品方案」与立项单。`,
        ].join("\n");

    return [
      `你是 Kiln 的 intake 立项对话角色。当前草稿 ID: ${draft.id}，空间: ${draft.space}，cwd: ${cwd}。`,
      pmWorkflowProtocol,
      modeSummary,
      protocolInstruction,
      `当前待命 Agent 阵容池（enabled=true，严禁点将禁用角色或将 read_only 角色点将至 implement）：\n${rosterLines}`,
      `已登记项目空间列表：\n${registeredSpacesText}`,
      draftSummary,
      draftResearchSection,
      attachmentsSection,
      currentBriefSection,
      `当前在途任务：\n${taskLines}${defaultPresetHint}`,
      spaceChecklistSection,
      `空间 ${draft.space} 长期决策账本：\n${ledgerLines}`,
      priorSummary,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private buildResolverSystemPrompt(
    card: TaskCard,
    pendingDecision: PendingDecision | null,
    mcpEnabled: boolean,
  ): string {
    const brief = readOptionalText(this.store.paths.briefMd(card.id)) ?? "";
    const decisions = readOptionalText(this.store.paths.decisionsMd(card.id)) ?? "";
    const ledger = this.store.readLedger(card.space);
    const activeLedger =
      ledger && ledger.entries.length > 0
        ? selectActiveLedgerEntriesForHandoff(ledger.entries)
        : [];
    const ledgerLines =
      activeLedger.length > 0 ? activeLedger.map((e) => `- ${e.rule}`).join("\n") : "";
    const decisionSection = pendingDecision
      ? `当前待决 (${pendingDecision.id}): ${pendingDecision.question}\n选项:\n${pendingDecision.options
          .map((o) => `- ${o.id} (${o.action}): ${o.label}`)
          .join("\n")}`
      : "(当前无激活的待决项)";
    const protocolSection = mcpEnabled
      ? `可使用 wb_get_context / wb_list_tasks / wb_read_ledger / wb_plan(mode: "update_contract")。`
      : [
          `当前对话运行在无 MCP 模式，请仅做只读分析与方案讨论，严禁直接修改文件。`,
          `仅当用户明确要求修改当前任务契约（goal、end、scope 或 accept_cmd）时，在回复末尾附一个 \`\`\`kiln-contract-patch\\n{...}\\n\`\`\` JSON 代码块（含 affected_stages 阶段数组、rationale 修改原因与 contract 变更字段；若改 accept_cmd 须同步提供新 accept_files_hash）。`,
        ].join("\n");

    return [
      `你是 Kiln 的 resolver 讨论角色，负责协助用户讨论任务 "${card.id}"（${card.title}，契约 v${card.contract_version}）。`,
      protocolSection,
      `当前契约：\n- goal: ${card.contract.goal}\n- end: ${card.contract.end}\n- accept_cmd: ${card.contract.accept_cmd}\n- scope: ${card.contract.scope.join(", ")}`,
      decisionSection,
      ledgerLines ? `空间 ${card.space} 长期决策账本：\n${ledgerLines}` : "",
      brief ? `立项 BRIEF:\n${brief}` : "",
      decisions ? `历史 decisions:\n${decisions}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private async executeDraftRecon(
    safeDraftId: string,
    hint: string,
    options?: { force?: boolean; timeoutMs?: number },
  ): Promise<{ ran: boolean; researchMarkdown: string | null; skippedReason?: string }> {
    const draft = this.store.readDraft(safeDraftId);
    if (!draft) {
      throw new ServerHttpError(404, {
        error: "draft_not_found",
        draftId: safeDraftId,
        message: `Draft "${safeDraftId}" does not exist`,
      });
    }

    const existing = this.store.readDraftResearch(safeDraftId);
    if (!options?.force && existing && existing.trim().length > 0) {
      return { ran: false, researchMarkdown: existing, skippedReason: "already_exists" };
    }

    const workspace = this.resolveIntakeWorkspace(draft, safeDraftId);
    if (!workspace.isProjectRepo && !options?.force) {
      return { ran: false, researchMarkdown: null, skippedReason: "not_project_repo" };
    }

    const rosterConfig = this.store.readEffectiveRosterConfig();
    if (!options?.force && rosterConfig.pm_orchestration?.intake_auto_recon === false) {
      return { ran: false, researchMarkdown: null, skippedReason: "disabled_by_policy" };
    }

    const researcher = rosterConfig.roster.researcher;
    if (!researcher || !researcher.enabled || researcher.mode !== "agent" || !researcher.primary) {
      return { ran: false, researchMarkdown: null, skippedReason: "researcher_not_enabled" };
    }

    const candidates = [researcher.primary, ...researcher.fallbacks];
    const pickedBinding =
      candidates.find((b) => !(this.providerHealth?.isInCooldown(b.provider) ?? false)) ??
      candidates[0];
    if (!pickedBinding) {
      return { ran: false, researchMarkdown: null, skippedReason: "no_model_binding" };
    }

    const backend = await this.findBackendForAgent(
      pickedBinding.provider,
      pickedBinding.backend_id,
    );
    if (!backend) {
      return { ran: false, researchMarkdown: null, skippedReason: "backend_unavailable" };
    }

    const runId = `recon-${safeDraftId}-${randomUUID().slice(0, 6)}`;
    const reconPrompt = [
      `你是 Kiln 立项前置只读侦察员 (researcher · 严格只读)。`,
      `当前目标工作区: ${workspace.cwd}（空间 ${draft.space}）`,
      `用户需求线索: ${hint.trim() || "(请扫描项目核心目录结构、技术栈与可用测试脚本)"}`,
      ``,
      `请快速只读检索该工作区，严禁修改任何文件，也不要直接拍板产品或架构设计；只汇报客观事实，严格输出以下 4 个 Markdown 二级标题章节（精炼高密度，给下游 PM 与架构师直接建立项目地图）：`,
      `## 项目环境与运行基线`,
      `## 相关文件与精确符号`,
      `## 现有调用链与约束`,
      `## 可用验收命令与风险点`,
    ].join("\n");

    const timeoutMs = options?.timeoutMs ?? 50_000;
    let sessionRef: SessionRef | null = null;
    try {
      sessionRef = await backend.start({
        runId,
        taskId: safeDraftId,
        role: "advisor",
        agent: pickedBinding.provider,
        model: pickedBinding.model,
        ...(pickedBinding.effort !== undefined ? { reasoningEffort: pickedBinding.effort } : {}),
        cwd: workspace.cwd,
        prompt: reconPrompt,
        freshContext: true,
        readOnly: true,
        allowFullAccessFallback: researcher.allow_full_access_fallback ?? false,
      });

      let timer: ReturnType<typeof setTimeout> | null = null;
      const result = await Promise.race([
        this.consumeTurnEvents(backend, sessionRef, "intake"),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("draft recon timeout")), timeoutMs);
          if (typeof timer === "object" && timer !== null && "unref" in timer) {
            (timer as { unref?: () => void }).unref?.();
          }
        }),
      ]).finally(() => {
        if (timer !== null) {
          clearTimeout(timer);
        }
      });

      const researchText = result.replyText.trim();
      if (researchText.length === 0) {
        return { ran: false, researchMarkdown: null, skippedReason: "empty_output" };
      }
      this.store.writeDraftResearch(safeDraftId, researchText);
      return { ran: true, researchMarkdown: researchText };
    } catch (err) {
      if (sessionRef) {
        await backend.cancel(sessionRef).catch(() => {});
      }
      return {
        ran: false,
        researchMarkdown: existing ?? null,
        skippedReason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async runDraftRecon(
    draftId: string,
    hint = "",
    options?: { force?: boolean; timeoutMs?: number },
  ): Promise<{ ran: boolean; researchMarkdown: string | null; skippedReason?: string }> {
    const safeDraftId = assertSafeSegment(draftId, "draftId");
    return await this.runSerialized(`draft:${safeDraftId}`, async () => {
      return await this.executeDraftRecon(safeDraftId, hint, options);
    });
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

      const effectiveMessage = this.expandKilnBuiltinSlashPrompt("intake", trimmed);
      const draftSpaceCfg = draft.space !== "local" ? this.store.readSpace(draft.space) : null;
      const draftProjectDir =
        draftSpaceCfg?.repo_path && fs.existsSync(draftSpaceCfg.repo_path)
          ? draftSpaceCfg.repo_path
          : null;
      const skillNote = this.buildSkillDirectiveNote({
        role: "intake",
        trimmed,
        projectDir: draftProjectDir,
        agent: executor?.agent ?? null,
      });
      const mentionNote = this.buildMentionContextNote(trimmed);
      const turnContextNotes = [skillNote, mentionNote].filter(
        (line): line is string => line !== null,
      );

      if (executor === null && this.chatResponder) {
        const promptForResponder = this.composePromptForAgent(effectiveMessage, turnContextNotes);
        const res = await this.chatResponder({
          role: "intake",
          targetId: safeDraftId,
          message: promptForResponder,
          history: historyBefore,
          draft,
          token,
        });
        appendNdjsonLine(chatFile, userRecord);
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
        const attachmentsSig = (draft.attachments ?? [])
          .map((a) => `${a.id}:${a.sha256}`)
          .sort()
          .join(",");
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
          reusableMeta?.kiln_chat_cwd === resolvedWorkspace.cwd &&
          (reusableMeta?.kiln_chat_attachments_sig ?? "") === attachmentsSig
        ) {
          sessionRef = reusable.sessionRef;
          const contextLines: string[] = [];
          if (!executor.mcpEnabled) {
            contextLines.push(this.formatDraftSnapshotLine(draft));
          }
          contextLines.push(...turnContextNotes);
          const promptForAgent = this.composePromptForAgent(effectiveMessage, contextLines);
          await activeBackend.send(sessionRef, promptForAgent);
        } else {
          if (resolvedWorkspace.isProjectRepo && !this.store.readDraftResearch(safeDraftId)) {
            await this.executeDraftRecon(safeDraftId, trimmed);
          }
          const allSpaces = this.store.listSpaces();
          const firstTurnPrompt = this.composePromptForAgent(effectiveMessage, turnContextNotes);
          const draftAttachments: RunAttachmentInput[] = resolveRunAttachmentInputs(this.store, {
            kind: "draft",
            draftId: safeDraftId,
          });
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
            prompt: firstTurnPrompt,
            systemPrompt: this.buildIntakeSystemPrompt({
              draft,
              spaceConfig: resolvedWorkspace.spaceConfig,
              allSpaces,
              cwd: resolvedWorkspace.cwd,
              isProjectRepo: resolvedWorkspace.isProjectRepo,
              priorHistory: historyBefore,
              mcpEnabled: executor.mcpEnabled,
            }),
            freshContext: false,
            allowFullAccessFallback: executor.allowFullAccessFallback,
            ...(executor.mcpEnabled ? { mcpServers: [this.buildMcpMount(token)] } : {}),
            ...(draftAttachments.length > 0 ? { attachments: draftAttachments } : {}),
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
              kiln_chat_attachments_sig: attachmentsSig,
            },
          };
          const updatedDraft = DraftCardSchema.parse({
            ...draft,
            intake_open: true,
            session_ref: taggedSessionRef,
            updated_at: new Date().toISOString(),
          });
          this.store.writeDraft(updatedDraft);
        }

        appendNdjsonLine(chatFile, userRecord);
        let lastProgressKind: "thinking" | "tool" | null = null;
        const consumed = await this.consumeTurnEvents(activeBackend, sessionRef, "intake", (ev) => {
          if (!this.sseHub) return;
          if (ev.kind === "thinking") {
            if (lastProgressKind === "thinking") return;
            lastProgressKind = "thinking";
            this.sseHub.publish({
              type: "intake.progress",
              draftId: safeDraftId,
              kind: "thinking",
              text: resolvedWorkspace.isProjectRepo
                ? "正在分析项目结构与方案可行性…"
                : "正在梳理需求并整理方案…",
              at: ev.at,
            });
          } else if (ev.kind === "tool") {
            lastProgressKind = "tool";
            this.sseHub.publish({
              type: "intake.progress",
              draftId: safeDraftId,
              kind: "tool",
              toolName: ev.name,
              text: ev.target ? `正在读取/调用 ${ev.name} · ${ev.target}` : `正在调用 ${ev.name}`,
              at: ev.at,
            });
          }
        });
        replyText = consumed.replyText;
        toolMessages = consumed.toolMessages;

        if (!executor.mcpEnabled) {
          const extracted = extractLabeledJsonPatchBlock(replyText, "kiln-draft-patch");
          replyText = extracted.displayText;
          if (extracted.rawJson !== null) {
            const patchRes = this.applyNonMcpDraftPatch({
              safeDraftId,
              fallbackDraft: this.store.readDraft(safeDraftId) ?? draft,
              rawJson: extracted.rawJson,
            });
            const detailSuffix = patchRes.errorDetail
              ? `（${patchRes.errorDetail.replace(/\s+/g, " ").trim().slice(0, 160)}）`
              : "";
            toolMessages.push({
              id: `msg-${randomUUID().slice(0, 8)}`,
              role: "tool",
              who: "tool",
              name: "intake",
              toolName: "draft_patch",
              text: patchRes.applied
                ? patchRes.updatedFields.length > 0
                  ? `draft_patch · 已更新草稿字段：${patchRes.updatedFields.join(", ")}`
                  : "draft_patch · 已同步立项单草稿"
                : `draft_patch · 自动回填格式校验失败${detailSuffix}，请直接在右侧核对填写`,
              at: new Date().toISOString(),
            });
            if (!replyText) {
              replyText = patchRes.applied
                ? "已更新右侧立项单草稿。"
                : "已回复（自动回填格式未识别，请直接在右侧核对立项字段）。";
            }
          }
        }
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

      const latestBeforeReturn = this.store.readDraft(safeDraftId) ?? draft;
      const latestDraft =
        latestBeforeReturn.intake_open === true
          ? latestBeforeReturn
          : DraftCardSchema.parse({
              ...latestBeforeReturn,
              intake_open: true,
              updated_at: new Date().toISOString(),
            });
      if (latestBeforeReturn.intake_open !== true) {
        this.store.writeDraft(latestDraft);
      }
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

      const effectiveMessage = this.expandKilnBuiltinSlashPrompt("resolver", trimmed);
      const cardSpaceCfg = card.space !== "local" ? this.store.readSpace(card.space) : null;
      const cardProjectDir =
        cardSpaceCfg?.repo_path && fs.existsSync(cardSpaceCfg.repo_path)
          ? cardSpaceCfg.repo_path
          : null;
      const skillNote = this.buildSkillDirectiveNote({
        role: "resolver",
        trimmed,
        projectDir: cardProjectDir,
        agent: executor?.agent ?? null,
      });
      const mentionNote = this.buildMentionContextNote(trimmed);
      const turnContextNotes = [skillNote, mentionNote].filter(
        (line): line is string => line !== null,
      );

      if (executor === null && this.chatResponder) {
        const promptForResponder = this.composePromptForAgent(effectiveMessage, turnContextNotes);
        const res = await this.chatResponder({
          role: "resolver",
          targetId: safeTaskId,
          message: promptForResponder,
          history: historyBefore,
          card,
          pendingDecision,
          token,
        });
        appendNdjsonLine(chatFile, userRecord);
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
          const contextLines: string[] = [];
          if (!executor.mcpEnabled) {
            contextLines.push(
              `[当前任务契约 v${card.contract_version}: goal=${card.contract.goal}, end=${card.contract.end}, accept_cmd=${card.contract.accept_cmd}, scope=${card.contract.scope.join(", ")}]`,
            );
          }
          contextLines.push(...turnContextNotes);
          const promptForAgent = this.composePromptForAgent(effectiveMessage, contextLines);
          await executor.backend.send(sessionRef, promptForAgent);
        } else {
          const firstTurnPrompt = this.composePromptForAgent(effectiveMessage, turnContextNotes);
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
            prompt: firstTurnPrompt,
            systemPrompt: this.buildResolverSystemPrompt(
              card,
              pendingDecision,
              executor.mcpEnabled,
            ),
            freshContext: false,
            allowFullAccessFallback: executor.allowFullAccessFallback,
            ...(executor.mcpEnabled ? { mcpServers: [this.buildMcpMount(token)] } : {}),
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

        appendNdjsonLine(chatFile, userRecord);
        const consumed = await this.consumeTurnEvents(executor.backend, sessionRef, "resolver");
        replyText = consumed.replyText;
        toolMessages = consumed.toolMessages;

        if (!executor.mcpEnabled) {
          const extracted = extractLabeledJsonPatchBlock(replyText, "kiln-contract-patch");
          replyText = extracted.displayText;
          if (extracted.rawJson !== null) {
            const patchRes = this.applyNonMcpContractPatch({
              safeTaskId,
              rawJson: extracted.rawJson,
            });
            toolMessages.push({
              id: `msg-${randomUUID().slice(0, 8)}`,
              role: "tool",
              who: "tool",
              name: "resolver",
              toolName: "contract_patch",
              text: patchRes.message,
              at: new Date().toISOString(),
            });
            if (!replyText) {
              replyText = patchRes.applied
                ? "已按讨论更新当前任务契约。"
                : "已记录讨论回复（契约未自动变更，请核对后在右侧拍板）。";
            }
          }
        }
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
