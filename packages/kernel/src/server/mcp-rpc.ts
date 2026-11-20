import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import {
  DraftCardSchema,
  McpToolNameSchema,
  PendingDecisionSchema,
  RECEIPT_KINDS,
  RoleForbiddenErrorSchema,
  RunMetaSchema,
  TaskCardSchema,
  WbAskDecisionInputSchema,
  WbGetContextInputSchema,
  WbListTasksInputSchema,
  WbPlanInputSchema,
  WbProposeLedgerInputSchema,
  WbReadLedgerInputSchema,
  WbSubmitReceiptInputSchema,
  isRoleAllowedForTool,
  parseAndValidateReceipt,
  type McpToolName,
  type ReceiptKind,
  type RunMeta,
  type RunTokenClaims,
  type SpaceConfig,
  type TaskCard,
} from "@kiln/protocol";
import {
  InvalidStateTransitionError,
  TaskStateMachine,
  canTransition,
} from "../state/index.js";
import {
  KilnStore,
  assertSafeSegment,
  deriveTaskStatus,
  ensureDir,
  readYamlOptional,
} from "../store/index.js";
import type { CaffeinateController } from "./caffeinate.js";
import { ServerHttpError, mapDomainError } from "./errors.js";
import {
  appendLedgerProposal,
  countRunningLeafTasks,
  PendingDecisionStore,
  readOptionalText,
  readTaskCardOptional,
  resolveCardLimits,
} from "./pending-decisions.js";
import type { SseHub } from "./sse.js";
import { RunTokenAuthError, verifyRunToken } from "./token.js";

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

function isReceiptKind(role: string): role is ReceiptKind {
  return (RECEIPT_KINDS as readonly string[]).includes(role);
}

export interface McpRpcServerOptions {
  store: KilnStore;
  stateMachine: TaskStateMachine;
  sseHub: SseHub;
  pendingDecisions: PendingDecisionStore;
  caffeinate: CaffeinateController;
  tokenSecret: string | Buffer;
  socketPath?: string;
  maxBodyBytes?: number;
  onTaskQueued?: (taskId: string) => void;
  onContractUpdated?: (taskId: string) => void;
  onDecisionRequested?: (taskId: string) => void;
}

export interface McpRpcHttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string | undefined>;
  rawBody?: string;
}

export interface McpRpcHttpResponse {
  status: number;
  body: unknown;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readRawBody(req: IncomingMessage, maxBodyBytes: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const fail = (err: Error): void => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      totalBytes += buf.length;
      if (totalBytes > maxBodyBytes) {
        fail(
          new ServerHttpError(413, {
            error: "payload_too_large",
            message: `Request body exceeds ${maxBodyBytes} bytes`,
          }),
        );
        req.destroy();
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (err) => {
      fail(err);
    });
  });
}

function parseRawJsonBody(rawText: string | undefined, maxBodyBytes: number): unknown {
  const text = (rawText ?? "").trim();
  if (Buffer.byteLength(rawText ?? "", "utf8") > maxBodyBytes) {
    throw new ServerHttpError(413, {
      error: "payload_too_large",
      message: `Request body exceeds ${maxBodyBytes} bytes`,
    });
  }
  if (text.length === 0) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ServerHttpError(400, {
      error: "invalid_json",
      message: "Request body must be valid JSON",
    });
  }
}

async function probeUnixSocketActive(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const client = net.createConnection(socketPath);
    let settled = false;

    const finish = (active: boolean): void => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(active);
    };

    client.once("connect", () => finish(true));
    client.once("error", () => finish(false));
  });
}

async function prepareUnixSocketPath(socketPath: string): Promise<void> {
  ensureDir(path.dirname(socketPath));

  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  if (stat === null) {
    return;
  }

  if (!stat.isSocket()) {
    throw new Error(`Refusing to overwrite non-socket path at "${socketPath}"`);
  }

  const active = await probeUnixSocketActive(socketPath);
  if (active) {
    throw new Error(`Another kilnd instance is already listening at "${socketPath}"`);
  }

  fs.unlinkSync(socketPath);
}

function findRunByRunId(
  store: KilnStore,
  taskId: string,
  runId: string,
): { runDirName: string; runMeta: RunMeta } | null {
  const runsDir = store.paths.runsDir(taskId);
  if (!fs.existsSync(runsDir)) {
    return null;
  }

  const entries = fs.readdirSync(runsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const runDirName = assertSafeSegment(entry.name, "runDirName");
    const runMeta = readYamlOptional(store.paths.runYaml(taskId, runDirName), RunMetaSchema);
    if (runMeta && runMeta.run_id === runId) {
      return { runDirName, runMeta };
    }
  }
  return null;
}

/**
 * Local Unix Domain Socket RPC server (`~/.kiln/run/kilnd.sock`, mode `0600`)
 * authenticating `KILN_RUN_TOKEN` and enforcing the 7-tool `kiln-mcp` role allowlist.
 */
export class McpRpcServer {
  readonly socketPath: string;
  private readonly store: KilnStore;
  private readonly stateMachine: TaskStateMachine;
  private readonly sseHub: SseHub;
  private readonly pendingDecisions: PendingDecisionStore;
  private readonly caffeinate: CaffeinateController;
  private readonly tokenSecret: string | Buffer;
  private readonly maxBodyBytes: number;
  private readonly onTaskQueued: ((taskId: string) => void) | undefined;
  private readonly onContractUpdated: ((taskId: string) => void) | undefined;
  private readonly onDecisionRequested: ((taskId: string) => void) | undefined;

  private server: http.Server | null = null;
  private listening = false;

  constructor(options: McpRpcServerOptions) {
    this.store = options.store;
    this.stateMachine = options.stateMachine;
    this.sseHub = options.sseHub;
    this.pendingDecisions = options.pendingDecisions;
    this.caffeinate = options.caffeinate;
    this.tokenSecret = options.tokenSecret;
    this.socketPath = options.socketPath ?? options.store.paths.kilndSock;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.onTaskQueued = options.onTaskQueued;
    this.onContractUpdated = options.onContractUpdated;
    this.onDecisionRequested = options.onDecisionRequested;
  }

  async start(): Promise<string> {
    if (this.server && this.listening) {
      return this.socketPath;
    }

    await prepareUnixSocketPath(this.socketPath);

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        try {
          fs.chmodSync(this.socketPath, 0o600);
          this.listening = true;
          resolve();
        } catch (err) {
          reject(err);
        }
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.socketPath);
    });

    this.server = server;
    return this.socketPath;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    const wasListening = this.listening;
    this.listening = false;

    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }

    if (wasListening) {
      fs.rmSync(this.socketPath, { force: true });
    }
  }

  private authenticateHeaders(
    headers: Record<string, string | undefined> | undefined,
  ): RunTokenClaims {
    const rawAuth = headers?.authorization ?? headers?.Authorization;
    if (typeof rawAuth !== "string") {
      throw new ServerHttpError(401, {
        error: "unauthorized",
        message: "Missing Authorization header",
      });
    }
    const match = /^Bearer\s+(\S+)$/i.exec(rawAuth.trim());
    if (!match || !match[1]) {
      throw new ServerHttpError(401, {
        error: "unauthorized",
        message: "Malformed Authorization Bearer token",
      });
    }

    try {
      return verifyRunToken(match[1], this.tokenSecret);
    } catch (err) {
      if (err instanceof RunTokenAuthError) {
        throw new ServerHttpError(401, {
          error: "unauthorized",
          reason: err.reason,
          message: err.message,
        });
      }
      throw err;
    }
  }

  /**
   * Dispatches an MCP RPC HTTP request directly against `McpRpcServer` auth,
   * 7-tool whitelist, and role allowlist rules (shared by live Unix socket and in-process tests).
   */
  async dispatchHttpRequest(input: McpRpcHttpRequest): Promise<McpRpcHttpResponse> {
    try {
      const url = new URL(input.url, "http://kilnd.local");
      const routeMatch = /^\/rpc\/mcp\/([^/]+)$/.exec(url.pathname);
      if (input.method.toUpperCase() !== "POST" || !routeMatch || !routeMatch[1]) {
        return { status: 404, body: { error: "not_found", message: "Route not found" } };
      }

      let toolSegment: string;
      try {
        toolSegment = decodeURIComponent(routeMatch[1]);
      } catch {
        return {
          status: 400,
          body: { error: "invalid_tool", message: "Malformed tool path encoding" },
        };
      }

      const claims = this.authenticateHeaders(input.headers);

      const parsedTool = McpToolNameSchema.safeParse(toolSegment);
      if (!parsedTool.success) {
        return {
          status: 404,
          body: {
            error: "unknown_tool",
            tool: toolSegment,
            message: `Unknown MCP tool "${toolSegment}"`,
          },
        };
      }
      const tool = parsedTool.data;

      if (!isRoleAllowedForTool(claims.role, tool)) {
        const forbidden = RoleForbiddenErrorSchema.parse({
          code: "role_forbidden",
          role: claims.role,
          tool,
          message: `Role "${claims.role}" is not allowed to invoke "${tool}"`,
        });
        return { status: 403, body: forbidden };
      }

      const rawBody = parseRawJsonBody(input.rawBody, this.maxBodyBytes);
      const result = this.dispatchTool(tool, rawBody, claims);
      return { status: 200, body: result };
    } catch (err) {
      const mapped = mapDomainError(err);
      return { status: mapped.statusCode, body: mapped.payload };
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const rawBody = await readRawBody(req, this.maxBodyBytes);
      const response = await this.dispatchHttpRequest({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: {
          authorization:
            typeof req.headers.authorization === "string"
              ? req.headers.authorization
              : undefined,
        },
        rawBody,
      });
      sendJson(res, response.status, response.body);
    } catch (err) {
      if (res.writableEnded) {
        return;
      }
      const mapped = mapDomainError(err);
      sendJson(res, mapped.statusCode, mapped.payload);
    }
  }

  private dispatchTool(
    tool: McpToolName,
    rawBody: unknown,
    claims: RunTokenClaims,
  ): Record<string, unknown> {
    switch (tool) {
      case "wb_get_context":
        return this.handleGetContext(rawBody, claims);
      case "wb_list_tasks":
        return this.handleListTasks(rawBody);
      case "wb_read_ledger":
        return this.handleReadLedger(rawBody);
      case "wb_plan":
        return this.handlePlan(rawBody, claims);
      case "wb_ask_decision":
        return this.handleAskDecision(rawBody, claims);
      case "wb_submit_receipt":
        return this.handleSubmitReceipt(rawBody, claims);
      case "wb_propose_ledger":
        return this.handleProposeLedger(rawBody, claims);
    }
  }

  private requireCard(taskId: string): TaskCard {
    const safeTaskId = assertSafeSegment(taskId, "taskId");
    const card = readTaskCardOptional(this.store, safeTaskId);
    if (!card) {
      throw new ServerHttpError(404, {
        error: "task_not_found",
        taskId: safeTaskId,
        message: `Task "${safeTaskId}" does not exist`,
      });
    }
    return card;
  }

  private handleGetContext(
    rawBody: unknown,
    claims: RunTokenClaims,
  ): Record<string, unknown> {
    WbGetContextInputSchema.parse(rawBody);
    const card = this.requireCard(claims.taskId);
    const brief = readOptionalText(this.store.paths.briefMd(claims.taskId)) ?? "";
    const stateEvents = this.store.readStateEvents(claims.taskId);
    const derived = deriveTaskStatus(card, stateEvents);
    const taskIndex = this.store.getTaskIndex(claims.taskId);
    const spaceConfig = this.store.readSpace(card.space);
    const matchedRun = findRunByRunId(this.store, claims.taskId, claims.runId);
    const activeLease = this.store.getStageLease(claims.taskId);
    const pendingDecision = this.pendingDecisions.get(claims.taskId);

    return {
      ok: true,
      taskId: claims.taskId,
      runId: claims.runId,
      role: claims.role,
      tokenContractVersion: claims.contractVersion,
      contract_version: card.contract_version,
      card,
      brief,
      state: {
        ...derived,
        effectivePriority: taskIndex?.effective_priority ?? derived.priority,
      },
      space: spaceConfig,
      run: matchedRun ? { dirName: matchedRun.runDirName, ...matchedRun.runMeta } : null,
      activeLease,
      pendingDecision,
    };
  }

  private handleListTasks(rawBody: unknown): Record<string, unknown> {
    const input = WbListTasksInputSchema.parse(rawBody);
    if (input.space !== undefined) {
      assertSafeSegment(input.space, "space");
    }

    const tasks = this.store.listTasks({
      ...(input.space !== undefined ? { space: input.space } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    });

    const spaces: Record<string, SpaceConfig> = {};
    const spaceIds = new Set<string>(tasks.map((t) => t.space));
    if (input.space !== undefined) {
      spaceIds.add(input.space);
    }

    for (const spaceId of spaceIds) {
      const cfg = this.store.readSpace(spaceId);
      if (cfg) {
        spaces[spaceId] = cfg;
      }
    }

    const spaceConfig = input.space !== undefined ? (spaces[input.space] ?? null) : null;
    return {
      ok: true,
      tasks,
      spaceConfig,
      spaces,
    };
  }

  private handleReadLedger(rawBody: unknown): Record<string, unknown> {
    const input = WbReadLedgerInputSchema.parse(rawBody);
    assertSafeSegment(input.space, "space");
    const ledger = this.store.readLedger(input.space);
    return {
      ok: true,
      space: input.space,
      exists: ledger !== null,
      ledger: ledger ?? {
        schema_version: 1,
        space: input.space,
        entries: [],
      },
    };
  }

  private handlePlan(rawBody: unknown, claims: RunTokenClaims): Record<string, unknown> {
    const input = WbPlanInputSchema.parse(rawBody);
    const now = new Date().toISOString();

    switch (input.mode) {
      case "upsert_draft": {
        assertSafeSegment(input.draft_id, "draft_id");
        if (input.space !== undefined) {
          assertSafeSegment(input.space, "space");
        }
        const existing = this.store.readDraft(input.draft_id);
        const draft = DraftCardSchema.parse({
          schema_version: 1,
          id: input.draft_id,
          title: input.title ?? existing?.title ?? "",
          space: input.space ?? existing?.space ?? "local",
          priority: input.priority ?? existing?.priority ?? "P2",
          track: input.track ?? existing?.track ?? "L2",
          workspace_mode: input.workspace_mode ?? existing?.workspace_mode ?? "git_worktree",
          depends_on: input.depends_on ?? existing?.depends_on ?? [],
          contract: {
            ...(existing?.contract ?? {}),
            ...(input.contract ?? {}),
          },
          session_ref: existing?.session_ref ?? null,
          created_at: existing?.created_at ?? now,
          updated_at: now,
        });
        this.store.writeDraft(draft);
        return { ok: true, mode: "upsert_draft", draft };
      }

      case "commit_card": {
        assertSafeSegment(input.space, "space");
        if (input.draft_id !== undefined) {
          assertSafeSegment(input.draft_id, "draft_id");
        }
        if (input.workspace_mode === "external_only") {
          throw new ServerHttpError(400, {
            error: "unsupported_workspace_mode",
            message: 'Unsupported workspace_mode: "external_only" is Post-MVP',
          });
        }

        const taskId = `t-${randomUUID().slice(0, 8)}`;
        const card = TaskCardSchema.parse({
          schema_version: 1,
          id: taskId,
          title: input.title,
          space: input.space,
          priority: input.priority,
          track: input.track,
          workspace_mode: input.workspace_mode,
          parent: input.parent,
          depends_on: input.depends_on,
          contract_version: 1,
          contract: input.contract,
          limits: resolveCardLimits(this.store, input.limits),
          created_at: now,
          updated_at: now,
        });

        const created = this.stateMachine.createTask(card, input.brief_markdown);
        if (created.state.status === "waiting") {
          const dec = this.pendingDecisions.ensureUpstreamCancelledDecision(created.card.id);
          if (dec) {
            this.sseHub.publish({
              type: "decision.requested",
              taskId: created.card.id,
              priority: created.card.priority,
              question: dec.question,
            });
          }
        }
        this.sseHub.publish({
          type: "task.updated",
          taskId: created.card.id,
          patch: {
            status: created.state.status,
            priority: created.card.priority,
            effectivePriority: created.effectivePriority,
            contractVersion: created.card.contract_version,
          },
        });
        if (created.state.status === "queued") {
          this.onTaskQueued?.(created.card.id);
        }

        return {
          ok: true,
          mode: "commit_card",
          card: created.card,
          state: {
            ...created.state,
            effectivePriority: created.effectivePriority,
          },
        };
      }

      case "update_contract": {
        assertSafeSegment(input.task_id, "task_id");
        if (
          (claims.role === "triage" || claims.role === "resolver") &&
          input.task_id !== claims.taskId
        ) {
          throw new ServerHttpError(403, {
            error: "task_scope_forbidden",
            message: `Role "${claims.role}" bound to task "${claims.taskId}" cannot update contract of "${input.task_id}"`,
          });
        }

        const card = this.requireCard(input.task_id);
        const previousStatus = deriveTaskStatus(
          card,
          this.store.readStateEvents(input.task_id),
        ).status;
        if (
          input.contract.accept_cmd !== undefined &&
          input.contract.accept_cmd !== card.contract.accept_cmd &&
          (input.contract.accept_files_hash === undefined ||
            input.contract.accept_files_hash === card.contract.accept_files_hash)
        ) {
          throw new ServerHttpError(400, {
            error: "accept_files_hash_required",
            message: `Updating accept_cmd for task "${input.task_id}" requires a new accept_files_hash`,
          });
        }

        const updated = this.stateMachine.updateContract({
          taskId: input.task_id,
          contractPatch: input.contract,
          affectedStages: input.affected_stages,
          ...(input.contract.accept_files_hash !== undefined
            ? { acceptFilesHash: input.contract.accept_files_hash }
            : {}),
          now,
        });

        if (updated.state.status === "waiting") {
          const rebound = this.pendingDecisions.rebindContractVersion(
            input.task_id,
            updated.newVersion,
          );
          if (previousStatus !== "waiting" && rebound) {
            this.sseHub.publish({
              type: "decision.requested",
              taskId: input.task_id,
              priority:
                this.store.getTaskIndex(input.task_id)?.priority ?? updated.state.priority,
              question: rebound.question,
            });
          }
        }

        this.caffeinate.syncRunningCount(countRunningLeafTasks(this.store));
        this.sseHub.publish({
          type: "task.updated",
          taskId: input.task_id,
          patch: {
            status: updated.state.status,
            ...(updated.state.stage !== null ? { stage: updated.state.stage } : {}),
            contractVersion: updated.newVersion,
          },
        });
        this.onContractUpdated?.(input.task_id);

        return {
          ok: true,
          mode: "update_contract",
          taskId: input.task_id,
          status: updated.state.status,
          stage: updated.state.stage,
          contractVersion: updated.newVersion,
          archivedReceipts: updated.archivedReceipts,
          rationale: input.rationale,
        };
      }
    }
  }

  private handleAskDecision(
    rawBody: unknown,
    claims: RunTokenClaims,
  ): Record<string, unknown> {
    const input = WbAskDecisionInputSchema.parse(rawBody);
    const card = this.requireCard(claims.taskId);

    if (card.contract_version !== claims.contractVersion) {
      throw new ServerHttpError(409, {
        error: "contract_version_mismatch",
        expectedContractVersion: card.contract_version,
        tokenContractVersion: claims.contractVersion,
        message: `Run token contractVersion (${claims.contractVersion}) does not match current card contract_version (${card.contract_version})`,
      });
    }

    const matchedRun = findRunByRunId(this.store, claims.taskId, claims.runId);
    if (!matchedRun) {
      throw new ServerHttpError(409, {
        error: "run_not_dispatched",
        taskId: claims.taskId,
        runId: claims.runId,
        message: `Run "${claims.runId}" has not been dispatched for task "${claims.taskId}"`,
      });
    }
    if (matchedRun.runMeta.contract_version !== claims.contractVersion) {
      throw new ServerHttpError(409, {
        error: "contract_version_mismatch",
        expectedContractVersion: matchedRun.runMeta.contract_version,
        tokenContractVersion: claims.contractVersion,
        message: `Run "${claims.runId}" contract_version (${matchedRun.runMeta.contract_version}) does not match token (${claims.contractVersion})`,
      });
    }
    if (matchedRun.runMeta.role !== claims.role) {
      throw new ServerHttpError(409, {
        error: "role_mismatch",
        expectedRole: matchedRun.runMeta.role,
        tokenRole: claims.role,
        message: `Run "${claims.runId}" belongs to role "${matchedRun.runMeta.role}", not "${claims.role}"`,
      });
    }

    const lease = this.store.getStageLease(claims.taskId);
    if (lease === null) {
      throw new ServerHttpError(409, {
        error: "no_active_lease",
        taskId: claims.taskId,
        runId: claims.runId,
        message: `Task "${claims.taskId}" has no active stage lease for run "${claims.runId}"`,
      });
    }
    if (lease.state !== "active") {
      throw new ServerHttpError(409, {
        error: "lease_not_active",
        leaseState: lease.state,
        activeRunId: lease.run_id,
        message: `Stage lease for task "${claims.taskId}" (run "${lease.run_id}") is in state "${lease.state}", not "active"`,
      });
    }
    if (lease.run_id !== claims.runId) {
      throw new ServerHttpError(409, {
        error: "lease_mismatch",
        activeRunId: lease.run_id,
        message: `Active stage lease belongs to run "${lease.run_id}", not "${claims.runId}"`,
      });
    }
    if (lease.contract_version !== claims.contractVersion) {
      throw new ServerHttpError(409, {
        error: "contract_version_mismatch",
        expectedContractVersion: lease.contract_version,
        tokenContractVersion: claims.contractVersion,
        message: `Active stage lease contract_version (${lease.contract_version}) mismatches token (${claims.contractVersion})`,
      });
    }

    const derived = deriveTaskStatus(card, this.store.readStateEvents(claims.taskId));
    if (derived.status !== "running" || derived.activeRunId !== claims.runId) {
      throw new ServerHttpError(409, {
        error: "task_not_running_for_run",
        status: derived.status,
        activeRunId: derived.activeRunId,
        message: `Task "${claims.taskId}" is in status "${derived.status}" (active run "${derived.activeRunId ?? "none"}"), not running under "${claims.runId}"`,
      });
    }

    if (!canTransition(derived.status, "waiting")) {
      throw new InvalidStateTransitionError(derived.status, "waiting");
    }

    const now = new Date().toISOString();
    const decision = PendingDecisionSchema.parse({
      id: `dec-${randomUUID().slice(0, 8)}`,
      task_id: claims.taskId,
      run_id: claims.runId,
      contract_version: claims.contractVersion,
      reason: input.reason,
      category: input.category,
      question: input.question,
      options: input.options,
      created_at: now,
    });

    this.pendingDecisions.set(decision);
    let nextState;
    try {
      nextState = this.stateMachine.requestDecision(claims.taskId, decision, now);
    } catch (err) {
      this.pendingDecisions.remove(claims.taskId);
      throw err;
    }

    this.caffeinate.syncRunningCount(countRunningLeafTasks(this.store));
    this.sseHub.publish({
      type: "decision.requested",
      taskId: claims.taskId,
      priority: nextState.priority,
      question: decision.question,
    });
    this.sseHub.publish({
      type: "task.updated",
      taskId: claims.taskId,
      patch: {
        status: nextState.status,
        ...(nextState.stage !== null ? { stage: nextState.stage } : {}),
        contractVersion: nextState.contractVersion,
      },
    });
    this.onDecisionRequested?.(claims.taskId);

    return {
      ok: true,
      decision,
      state: nextState,
    };
  }

  private handleSubmitReceipt(
    rawBody: unknown,
    claims: RunTokenClaims,
  ): Record<string, unknown> {
    const input = WbSubmitReceiptInputSchema.parse(rawBody);
    this.requireCard(claims.taskId);

    const matchedRun = findRunByRunId(this.store, claims.taskId, claims.runId);
    if (!matchedRun) {
      throw new ServerHttpError(404, {
        error: "run_not_found",
        taskId: claims.taskId,
        runId: claims.runId,
        message: `No RUN.yaml found for task "${claims.taskId}" and run "${claims.runId}"`,
      });
    }

    if (!isReceiptKind(claims.role)) {
      throw new ServerHttpError(400, {
        error: "invalid_receipt",
        role: claims.role,
        errors: [`Role "${claims.role}" is not a valid receipt role`],
        message: `Invalid receipt role "${claims.role}"`,
      });
    }

    // Validate schema, required sections, and token identity BEFORE consuming the active lease
    // so an agent can fix formatting errors and resubmit within the same turn.
    const validation = parseAndValidateReceipt(claims.role, input.markdown);
    const errors: string[] = validation.ok ? [] : [...validation.errors];
    if (validation.ok) {
      if (validation.frontmatter.run_id !== claims.runId) {
        errors.push(
          `frontmatter.run_id "${validation.frontmatter.run_id}" does not match run token runId "${claims.runId}"`,
        );
      }
      if (validation.frontmatter.contract_version !== claims.contractVersion) {
        errors.push(
          `frontmatter.contract_version (${validation.frontmatter.contract_version}) does not match run token contractVersion (${claims.contractVersion})`,
        );
      }
    }

    if (errors.length > 0) {
      throw new ServerHttpError(400, {
        error: "invalid_receipt",
        role: claims.role,
        errors,
        message: `Invalid ${claims.role} receipt: ${errors.join("; ")}`,
      });
    }

    const submitResult = this.store.submitReceipt({
      taskId: claims.taskId,
      runId: claims.runId,
      contractVersion: claims.contractVersion,
      runDirName: matchedRun.runDirName,
      markdown: input.markdown,
    });

    if (submitResult.accepted) {
      return {
        ok: true,
        accepted: true,
        runDirName: matchedRun.runDirName,
        receiptPath: submitResult.receiptPath,
      };
    }

    return {
      ok: true,
      accepted: false,
      runDirName: matchedRun.runDirName,
      reason: submitResult.reason,
      archivedPath: submitResult.archivedPath,
    };
  }

  private handleProposeLedger(
    rawBody: unknown,
    claims: RunTokenClaims,
  ): Record<string, unknown> {
    const input = WbProposeLedgerInputSchema.parse(rawBody);
    assertSafeSegment(input.space, "space");
    this.requireCard(claims.taskId);

    const proposal = appendLedgerProposal(this.store, {
      schema_version: 1,
      id: `lprop-${randomUUID().slice(0, 8)}`,
      task_id: claims.taskId,
      run_id: claims.runId,
      role: claims.role,
      space: input.space,
      rule: input.rule,
      rationale: input.rationale,
      status: "pending_confirmation",
      proposed_at: new Date().toISOString(),
    });

    return {
      ok: true,
      status: "proposed",
      proposalId: proposal.id,
      taskId: claims.taskId,
      space: input.space,
      rule: input.rule,
      rationale: input.rationale,
    };
  }
}
