import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  client as createAcpClient,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ClientConnection,
  type ClientContext,
  type ContentBlock,
  type NewSessionResponse,
  type PermissionOption,
  type PromptResponse,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type SessionNotification,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import {
  MAX_ATTACHMENT_BYTES,
  type BackendCapabilities,
  type ProviderEntry,
  type RunEvent,
  type SessionRef,
} from "@kiln/protocol";
import { terminateProcessTree } from "../../gate/command-runner.js";
import type { ProviderHealthTracker } from "../provider-health.js";
import {
  TurnEventQueue,
  buildAgentCliEnv,
  extractRetryAfterSec,
  isRateLimitMessage,
  probeCliBinary,
  resolveCliBinary,
  type ProbeCliBinaryOptions,
  type SpawnProcessFn,
} from "../stdio-rpc.js";
import {
  assertRoleAgentEligible,
  isFullAccessMode,
  isReadOnlyRole,
  selectSafeModeId,
  type ApprovalHandler,
  type ApprovalRequestEvent,
  type BackendAgentDescriptor,
  type BackendModeDescriptor,
  type BackendModelDescriptor,
  type BackendRunSpec,
  type ProviderProbeSnapshot,
  type ProviderTelemetryBackend,
  type RunAttachmentInput,
  type SessionProbeResult,
} from "../types.js";
import {
  createContextWindowEvent,
  createProviderUsageNormalizerState,
  normalizeProviderTurnUsage,
  resolveProviderUsageRule,
  type ProviderUsageNormalizerState,
} from "../usage-normalizer.js";

const DEFAULT_CANCEL_TIMEOUT_MS = 3_000;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

export const BASE_ACP_CAPABILITIES: BackendCapabilities = {
  interactiveChat: true,
  approvals: true,
  mcpInjection: true,
  usageCacheBreakdown: true,
  interrupt: true,
  imageInput: false,
  cacheWriteTelemetry: true,
  contextWindowTelemetry: true,
  nativeQuotaWindow: false,
  readOnlySandbox: false,
  warmSessionReuse: true,
};

export interface AcpBackendOptions {
  provider: ProviderEntry;
  healthTracker?: ProviderHealthTracker;
  cancelTimeoutMs?: number;
  rpcTimeoutMs?: number;
  spawnFn?: SpawnProcessFn;
  probeOptions?: ProbeCliBinaryOptions;
}

interface PendingAcpApproval {
  id: string;
  sessionId: string;
  options: PermissionOption[];
  resolve: (outcome: RequestPermissionOutcome) => void;
}

interface AcpTurnState {
  turnId: string;
  queue: TurnEventQueue;
  cancelling: boolean;
  cancelTimer: ReturnType<typeof setTimeout> | null;
}

interface AcpSessionState {
  sessionId: string;
  providerSessionId: string;
  sessionRef: SessionRef;
  child: ChildProcess;
  connection: ClientConnection;
  agentCtx: ClientContext;
  runSpec: BackendRunSpec;
  isReadOnly: boolean;
  canonicalCwd: string;
  canonicalAllowedWriteRoots: string[];
  usageState: ProviderUsageNormalizerState;
  status: "running" | "idle" | "closed";
  exited: boolean;
  turnSeq: number;
  currentTurn: AcpTurnState | null;
}

interface ExtendedNewSessionResponse extends NewSessionResponse {
  models?: {
    currentModelId?: string | null;
    availableModels?: Array<{
      modelId?: string;
      id?: string;
      name?: string;
      label?: string;
      description?: string;
    }>;
  } | null;
}

interface ExtendedPromptResponse extends PromptResponse {
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    thoughtTokens?: number;
    totalTokens?: number;
  } | null;
}

function buildProcessEnv(
  providerEnv?: Record<string, string>,
  runEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  return buildAgentCliEnv(providerEnv, runEnv);
}

function getDefaultAcpArgs(providerId: string): string[] {
  switch (providerId) {
    case "agy":
      return ["acp", "--stdio", "--disable-telemetry"];
    case "gemini":
      return ["--experimental-acp"];
    default:
      return ["acp"];
  }
}

const MUTATING_KIND_SET = new Set(["write", "edit", "delete", "move", "execute"]);
const MUTATING_KEYWORD_RE =
  /(?:^|[^a-z0-9])(write|edit|create|delete|remove|unlink|patch|move|rename|mkdir|bash|zsh|sh|shell|exec|command|terminal)(?:$|[^a-z0-9])/i;

function splitCamelCase(input: string): string {
  return input.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

function isWriteOrExecuteToolCall(toolCall: ToolCallUpdate | undefined): boolean {
  if (!toolCall) {
    return true;
  }
  const rawKind = typeof toolCall.kind === "string" ? toolCall.kind.trim() : "";
  const kind = rawKind.toLowerCase();
  // Fail closed when `kind` is absent or stripped by @agentclientprotocol/sdk's `defaultOnError`
  // on non-standard values (e.g. "write_file" / "run_shell").
  if (!kind || MUTATING_KIND_SET.has(kind)) {
    return true;
  }
  const title = String(toolCall.title ?? "");
  const name = String(toolCall.name ?? "");
  const rawInput = toolCall.rawInput !== undefined ? JSON.stringify(toolCall.rawInput) : "";
  return MUTATING_KEYWORD_RE.test(splitCamelCase(`${rawKind} ${title} ${name} ${rawInput}`));
}

function extractCandidateWritePaths(toolCall: ToolCallUpdate | undefined): string[] {
  const candidates: string[] = [];
  if (!toolCall) {
    return candidates;
  }
  for (const loc of toolCall.locations ?? []) {
    if (typeof loc?.path === "string" && loc.path.trim().length > 0) {
      candidates.push(loc.path.trim());
    }
  }
  if (toolCall.rawInput && typeof toolCall.rawInput === "object") {
    const raw = toolCall.rawInput as Record<string, unknown>;
    for (const key of ["path", "filePath", "file_path", "target", "file", "destination", "dest"]) {
      const val = raw[key];
      if (typeof val === "string" && val.trim().length > 0) {
        candidates.push(val.trim());
      }
    }
  }
  return candidates;
}

function resolveCanonicalCandidatePath(resolved: string): string {
  try {
    return fs.realpathSync(resolved);
  } catch {
    // Target or intermediate subdirectories might not exist yet; walk ancestors until an existing one is found.
    const missingSegments: string[] = [];
    let probe = resolved;
    while (true) {
      const parent = path.dirname(probe);
      if (parent === probe) {
        return resolved;
      }
      missingSegments.push(path.basename(probe));
      probe = parent;
      try {
        const canonicalAncestor = fs.realpathSync(probe);
        return path.join(canonicalAncestor, ...missingSegments.reverse());
      } catch {
        // Keep walking upward until an existing ancestor directory is found.
      }
    }
  }
}

function isPathInsideRoots(
  candidatePath: string,
  cwd: string,
  allowedRoots: readonly string[],
): boolean {
  const resolved = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(cwd, candidatePath);

  const canonicalTarget = resolveCanonicalCandidatePath(resolved);

  return allowedRoots.some((root) => {
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    return canonicalTarget === root || canonicalTarget.startsWith(prefix);
  });
}

function pickAllowOption(options: readonly PermissionOption[]): RequestPermissionOutcome {
  const hit =
    options.find((o) => o.kind === "allow_once") ??
    options.find((o) => String(o.kind).startsWith("allow")) ??
    options[0];
  return hit ? { outcome: "selected", optionId: hit.optionId } : { outcome: "cancelled" };
}

function pickRejectOption(options: readonly PermissionOption[]): RequestPermissionOutcome {
  const hit =
    options.find((o) => o.kind === "reject_once") ??
    options.find((o) => String(o.kind).startsWith("reject")) ??
    options.find((o) => /reject|deny|cancel/i.test(`${o.optionId} ${o.name}`));
  return hit ? { outcome: "selected", optionId: hit.optionId } : { outcome: "cancelled" };
}

function toBackendModes(res: ExtendedNewSessionResponse): BackendModeDescriptor[] {
  const rawModes = res.modes?.availableModes ?? [];
  return rawModes.map((m) => {
    const desc: BackendModeDescriptor = {
      id: m.id,
      label: m.name || m.id,
      ...(m.description ? { description: m.description } : {}),
    };
    if (isFullAccessMode(desc)) {
      desc.isFullAccess = true;
    }
    return desc;
  });
}

function toBackendModels(res: ExtendedNewSessionResponse): BackendModelDescriptor[] {
  const rawModels = res.models?.availableModels ?? [];
  const models: BackendModelDescriptor[] = [];
  const seen = new Set<string>();
  for (const m of rawModels) {
    const id = (m.modelId ?? m.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: (m.name ?? m.label ?? id).trim() || id,
      ...(m.description ? { description: m.description } : {}),
      thinkingOptions: [],
    });
  }
  return models;
}

function mergeCustomModels(
  discovered: readonly BackendModelDescriptor[],
  customModels: readonly string[],
): BackendModelDescriptor[] {
  const out = discovered.map((m) => ({
    ...m,
    thinkingOptions: [...m.thinkingOptions],
  }));
  const seen = new Set(out.map((m) => m.id));
  for (const raw of customModels) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: id, thinkingOptions: [] });
  }
  return out;
}

function isReadableInsideCwd(rawPath: string, canonicalCwd: string): string | null {
  if (!rawPath || rawPath.includes("\0")) {
    return null;
  }
  const resolved = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(canonicalCwd, rawPath);
  try {
    const realTarget = fs.realpathSync(resolved);
    const prefix = canonicalCwd.endsWith(path.sep) ? canonicalCwd : `${canonicalCwd}${path.sep}`;
    if (realTarget === canonicalCwd || realTarget.startsWith(prefix)) {
      return realTarget;
    }
    return null;
  } catch {
    return null;
  }
}

function sliceLineRange(content: string, line?: number | null, limit?: number | null): string {
  if (!line && !limit) {
    return content;
  }
  const lines = content.split("\n");
  const startIdx = Math.max(0, (line ?? 1) - 1);
  const endIdx = limit && limit > 0 ? startIdx + limit : lines.length;
  return lines.slice(startIdx, endIdx).join("\n");
}

/**
 * Standard ACP JSON-RPC 2.0 adapter backed by `@agentclientprotocol/sdk`,
 * enforcing P3 security findings (read-only permission blocking, cwd-confined
 * `fs/read_text_file`, `usage_update` context decoupling, and `FullAccessOnlyProviderError`).
 */
export class AcpBackend implements ProviderTelemetryBackend {
  readonly backendId: string;

  private readonly provider: ProviderEntry;
  private readonly healthTracker: ProviderHealthTracker | undefined;
  private readonly cancelTimeoutMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly spawnFn: SpawnProcessFn | undefined;
  private readonly probeOptions: ProbeCliBinaryOptions | undefined;

  private readonly sessions = new Map<string, AcpSessionState>();
  private readonly approvalHandlers = new Set<ApprovalHandler>();
  private readonly pendingApprovals = new Map<string, PendingAcpApproval>();

  private cachedCapabilities: BackendCapabilities = { ...BASE_ACP_CAPABILITIES };
  private cachedModes: BackendModeDescriptor[] | null = null;
  private cachedDefaultModeId: string | null = null;
  private cachedModels: BackendModelDescriptor[] | null = null;
  private disposed = false;

  constructor(options: AcpBackendOptions) {
    this.provider = options.provider;
    this.backendId = options.provider.id;
    this.healthTracker = options.healthTracker;
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.spawnFn = options.spawnFn;
    this.probeOptions = options.probeOptions;
  }

  private getCommandAndArgs(): { command: string; args: string[] } {
    const command = this.provider.command?.trim() || this.provider.id;
    const args =
      this.provider.args.length > 0 ? [...this.provider.args] : getDefaultAcpArgs(this.provider.id);
    return { command, args };
  }

  private spawnAcpChild(
    command: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): ChildProcess {
    const spawnImpl = this.spawnFn ?? spawn;
    const child = spawnImpl(command, [...args], {
      cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Prevent unhandled EPIPE error events if the child terminates mid-write.
    child.stdin?.on("error", () => {});
    return child;
  }

  private async closeChild(child: ChildProcess, connection?: ClientConnection): Promise<void> {
    try {
      connection?.close();
    } catch {
      // Ignore connection close errors during teardown.
    }
    try {
      child.stdin?.end();
    } catch {
      // Ignore stdin close errors.
    }
    await terminateProcessTree(child.pid).catch(() => false);
  }

  private connectSdkClient(
    child: ChildProcess,
    handlers?: {
      onUpdate?: (params: SessionNotification) => void;
      onPermission?: (
        params: RequestPermissionRequest,
      ) => Promise<{ outcome: RequestPermissionOutcome }>;
      onReadTextFile?: (params: {
        path: string;
        line?: number | null;
        limit?: number | null;
      }) => Promise<{ content: string }>;
    },
  ): { connection: ClientConnection; agentCtx: ClientContext } {
    if (!child.stdin || !child.stdout) {
      throw new Error(`ACP child process "${this.provider.id}" missing stdio pipes`);
    }

    const webWritable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const webReadable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(webWritable, webReadable);

    const app = createAcpClient()
      .onNotification("session/update", async (ctx) => {
        handlers?.onUpdate?.(ctx.params);
      })
      .onRequest("session/request_permission", async (ctx) => {
        if (handlers?.onPermission) {
          return await handlers.onPermission(ctx.params);
        }
        return { outcome: { outcome: "cancelled" as const } };
      })
      .onRequest("fs/read_text_file", async (ctx) => {
        if (handlers?.onReadTextFile) {
          return await handlers.onReadTextFile(ctx.params);
        }
        throw RequestError.methodNotFound("fs/read_text_file");
      });

    const connection = app.connect(stream);
    return {
      connection,
      agentCtx: connection.agent,
    };
  }

  private requestOpts(timeoutMs: number) {
    return timeoutMs > 0
      ? {
          cancellationSignal: AbortSignal.timeout(timeoutMs),
          stopWaitingOnCancel: true,
        }
      : undefined;
  }

  async probeProvider(): Promise<ProviderProbeSnapshot> {
    this.assertNotDisposed();
    const { command, args } = this.getCommandAndArgs();
    const env = buildProcessEnv(this.provider.env);
    const binaryProbe = await probeCliBinary(command, {
      env,
      ...(this.probeOptions ?? {}),
    });

    if (!binaryProbe.available || !binaryProbe.resolvedPath) {
      this.healthTracker?.setAvailability(this.provider.id, {
        available: false,
        version: null,
        detail: binaryProbe.detail ?? `Command "${command}" not found`,
      });
      return {
        available: false,
        version: null,
        detail: binaryProbe.detail ?? `Command "${command}" not found`,
        capabilities: { ...this.cachedCapabilities },
      };
    }

    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "kiln-acp-probe-"));
    let child: ChildProcess | null = null;
    let connection: ClientConnection | undefined;
    let rejectSpawnErr: ((err: Error) => void) | null = null;
    const spawnErrPromise = new Promise<never>((_resolve, reject) => {
      rejectSpawnErr = reject;
    });
    spawnErrPromise.catch(() => {});

    try {
      child = this.spawnAcpChild(binaryProbe.resolvedPath, args, tmpCwd, env);
      child.once("error", (err) => {
        rejectSpawnErr?.(err instanceof Error ? err : new Error(String(err)));
      });
      child.once("exit", (code, signal) => {
        rejectSpawnErr?.(
          new Error(
            `ACP probe process exited before handshake (code=${code ?? "null"}, signal=${signal ?? "null"})`,
          ),
        );
      });
      const connected = this.connectSdkClient(child);
      connection = connected.connection;

      const initRes = await Promise.race([
        connected.agentCtx.request(
          "initialize",
          {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: true, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "kiln", version: "0.0.6" },
          },
          this.requestOpts(8_000),
        ),
        spawnErrPromise,
      ]);

      const imageCap = Boolean(initRes.agentCapabilities?.promptCapabilities?.image);
      this.cachedCapabilities = {
        ...BASE_ACP_CAPABILITIES,
        imageInput: imageCap,
      };

      const sessionRes = (await Promise.race([
        connected.agentCtx.request(
          "session/new",
          {
            cwd: tmpCwd,
            mcpServers: [],
          },
          this.requestOpts(8_000),
        ),
        spawnErrPromise,
      ])) as ExtendedNewSessionResponse;

      this.cachedModes = toBackendModes(sessionRes);
      this.cachedDefaultModeId = sessionRes.modes?.currentModeId ?? null;
      this.cachedModels = mergeCustomModels(
        toBackendModels(sessionRes),
        this.provider.custom_models,
      );

      this.healthTracker?.setAvailability(this.provider.id, {
        available: true,
        version: binaryProbe.version ?? initRes.agentInfo?.version ?? null,
      });

      return {
        available: true,
        version: binaryProbe.version ?? initRes.agentInfo?.version ?? null,
        modelsCount: this.cachedModels.length,
        capabilities: { ...this.cachedCapabilities },
        nativeQuota: null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const authRequired = /auth|login|unauthorized|api[_ -]?key|credential/i.test(msg);
      this.healthTracker?.setAvailability(this.provider.id, {
        available: false,
        authRequired,
        version: binaryProbe.version,
        detail: msg,
      });
      return {
        available: false,
        authRequired,
        version: binaryProbe.version,
        detail: msg,
        capabilities: { ...this.cachedCapabilities },
      };
    } finally {
      if (child) {
        await this.closeChild(child, connection);
      }
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  }

  async refreshProviders(): Promise<void> {
    await this.probeProvider();
  }

  async listAgents(): Promise<BackendAgentDescriptor[]> {
    this.assertNotDisposed();
    if (this.cachedModels === null) {
      const { command } = this.getCommandAndArgs();
      const env = buildProcessEnv(this.provider.env);
      const resolved = resolveCliBinary(command, {
        env,
        ...(this.probeOptions ?? {}),
      });
      if (!resolved) {
        this.healthTracker?.setAvailability(this.provider.id, {
          available: false,
          detail: `Command "${command}" not found`,
        });
        return [];
      }
      const probe = await this.probeProvider();
      if (!probe.available) {
        return [];
      }
    }

    return [
      {
        id: this.provider.id,
        label: this.provider.label,
        capabilities: { ...this.cachedCapabilities },
        modes: (this.cachedModes ?? []).map((m) => ({ ...m })),
        defaultModeId: this.cachedDefaultModeId,
      },
    ];
  }

  async listModels(_agent: string): Promise<BackendModelDescriptor[]> {
    this.assertNotDisposed();
    if (this.cachedModels === null) {
      const { command } = this.getCommandAndArgs();
      const env = buildProcessEnv(this.provider.env);
      if (resolveCliBinary(command, { env, ...(this.probeOptions ?? {}) })) {
        await this.probeProvider().catch(() => undefined);
      }
    }
    return mergeCustomModels(this.cachedModels ?? [], this.provider.custom_models);
  }

  async capabilities(_agent: string): Promise<BackendCapabilities> {
    this.assertNotDisposed();
    return { ...this.cachedCapabilities };
  }

  onApproval(handler: ApprovalHandler): () => void {
    this.approvalHandlers.add(handler);
    return () => {
      this.approvalHandlers.delete(handler);
    };
  }

  async answer(approvalId: string, allow: boolean, _message?: string): Promise<void> {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      throw new Error(`Unknown or already resolved approval "${approvalId}"`);
    }
    this.pendingApprovals.delete(approvalId);
    pending.resolve(allow ? pickAllowOption(pending.options) : pickRejectOption(pending.options));
  }

  async start(runSpec: BackendRunSpec): Promise<SessionRef> {
    this.assertNotDisposed();
    assertRoleAgentEligible(runSpec.role, this.provider.id, this.cachedCapabilities);

    const { command, args } = this.getCommandAndArgs();
    const env = buildProcessEnv(this.provider.env, runSpec.env);
    const resolvedCmd = resolveCliBinary(command, { env, ...(this.probeOptions ?? {}) }) ?? command;
    const isReadOnly = isReadOnlyRole(runSpec.role) || runSpec.readOnly === true;

    let canonicalCwd = path.resolve(runSpec.cwd);
    try {
      canonicalCwd = fs.realpathSync(canonicalCwd);
    } catch {
      // Fallback to resolved path if cwd does not exist in unit mock cases.
    }
    const canonicalAllowedWriteRoots = (runSpec.allowedWriteRoots ?? [canonicalCwd]).map((root) => {
      try {
        return fs.realpathSync(root);
      } catch {
        return path.resolve(root);
      }
    });

    const sessionId = `acp-${randomUUID()}`;
    const sessionRef: SessionRef = {
      backendId: this.backendId,
      sessionId,
      meta: {
        agent: this.provider.id,
      },
    };

    const child = this.spawnAcpChild(resolvedCmd, args, runSpec.cwd, env);
    let session!: AcpSessionState;

    const { connection, agentCtx } = this.connectSdkClient(child, {
      onUpdate: (notification) => {
        if (session) {
          this.handleSessionNotification(session, notification);
        }
      },
      onPermission: async (params) => {
        if (!session) {
          return { outcome: pickRejectOption(params.options ?? []) };
        }
        return await this.handlePermissionRequest(session, params);
      },
      onReadTextFile: async (params) => {
        const realPath = isReadableInsideCwd(params.path, canonicalCwd);
        if (!realPath) {
          throw RequestError.invalidParams(
            { path: params.path },
            `Refused fs/read_text_file outside workspace cwd: ${params.path}`,
          );
        }
        const raw = fs.readFileSync(realPath, "utf8");
        return { content: sliceLineRange(raw, params.line, params.limit) };
      },
    });

    session = {
      sessionId,
      providerSessionId: "",
      sessionRef,
      child,
      connection,
      agentCtx,
      runSpec: {
        ...runSpec,
        mcpServers: runSpec.mcpServers?.map((m) => ({
          ...m,
          args: m.args ? [...m.args] : undefined,
          env: m.env ? { ...m.env } : undefined,
        })),
        env: runSpec.env ? { ...runSpec.env } : undefined,
      },
      isReadOnly,
      canonicalCwd,
      canonicalAllowedWriteRoots,
      usageState: createProviderUsageNormalizerState(),
      status: "running",
      exited: false,
      turnSeq: 0,
      currentTurn: null,
    };
    this.sessions.set(sessionId, session);

    child.once("error", (err) => {
      this.handleProcessClosed(session, err.message);
    });
    child.once("close", (code, signal) => {
      const detail = `ACP agent exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      this.handleProcessClosed(session, detail);
    });

    try {
      const initRes = await agentCtx.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "kiln", version: "0.0.6" },
        },
        this.requestOpts(this.rpcTimeoutMs),
      );

      this.cachedCapabilities = {
        ...BASE_ACP_CAPABILITIES,
        imageInput: Boolean(initRes.agentCapabilities?.promptCapabilities?.image),
      };

      const mcpServers = (runSpec.mcpServers ?? []).map((spec) => ({
        name: spec.name,
        command: spec.command,
        args: [...(spec.args ?? [])],
        env: Object.entries(spec.env ?? {}).map(([name, value]) => ({ name, value })),
      }));

      const newSessionRes = (await agentCtx.request(
        "session/new",
        {
          cwd: runSpec.cwd,
          mcpServers,
        },
        this.requestOpts(this.rpcTimeoutMs),
      )) as ExtendedNewSessionResponse;

      const providerSessionId = newSessionRes.sessionId?.trim();
      if (!providerSessionId) {
        throw new Error(`ACP agent "${this.provider.id}" session/new returned empty sessionId`);
      }

      const modeDescs = toBackendModes(newSessionRes);
      this.cachedModes = modeDescs;
      this.cachedDefaultModeId = newSessionRes.modes?.currentModeId ?? null;
      this.cachedModels = mergeCustomModels(
        toBackendModels(newSessionRes),
        this.provider.custom_models,
      );

      let chosenModeId: string | undefined;
      if (isReadOnly) {
        const planMode = modeDescs.find((m) => m.id === "plan");
        if (planMode) {
          chosenModeId = planMode.id;
        } else {
          chosenModeId = selectSafeModeId(this.provider.id, modeDescs, {
            allowFullAccessFallback: runSpec.allowFullAccessFallback,
          });
        }
      } else {
        chosenModeId = selectSafeModeId(this.provider.id, modeDescs, {
          allowFullAccessFallback: runSpec.allowFullAccessFallback,
        });
      }

      if (chosenModeId && chosenModeId !== newSessionRes.modes?.currentModeId) {
        await agentCtx.request(
          "session/set_mode",
          { sessionId: providerSessionId, modeId: chosenModeId },
          this.requestOpts(this.rpcTimeoutMs),
        );
      }

      const currentModelId = newSessionRes.models?.currentModelId ?? null;
      if (runSpec.model && runSpec.model !== currentModelId) {
        await agentCtx
          .request<unknown, { sessionId: string; modelId: string }>(
            "session/set_model",
            { sessionId: providerSessionId, modelId: runSpec.model },
            this.requestOpts(this.rpcTimeoutMs),
          )
          .catch(() => {});
      }

      session.providerSessionId = providerSessionId;
      sessionRef.meta = {
        ...sessionRef.meta,
        providerSessionId,
        ...(chosenModeId ? { modeId: chosenModeId } : {}),
      };

      const initialPrompt = runSpec.systemPrompt
        ? `${runSpec.systemPrompt.trim()}\n\n${runSpec.prompt}`
        : runSpec.prompt;
      const turn = this.beginTurn(session);
      turn.queue.push({
        kind: "session_bound",
        at: new Date().toISOString(),
        providerSessionId,
      });

      this.dispatchPromptTurn(session, turn, initialPrompt, runSpec.attachments);
    } catch (err) {
      this.sessions.delete(sessionId);
      this.clearPendingApprovalsForSession(sessionId);
      await this.closeChild(child, connection);
      throw err;
    }

    return {
      backendId: sessionRef.backendId,
      sessionId: sessionRef.sessionId,
      meta: sessionRef.meta ? { ...sessionRef.meta } : undefined,
    };
  }

  async send(sessionRef: SessionRef, message: string): Promise<void> {
    this.assertNotDisposed();
    const session = this.requireSession(sessionRef);
    if (session.status === "closed" || session.exited) {
      throw new Error(`Session "${sessionRef.sessionId}" is closed`);
    }
    if (
      session.status === "running" &&
      session.currentTurn &&
      !session.currentTurn.queue.isFinished()
    ) {
      throw new Error(
        `Session "${sessionRef.sessionId}" already has an active turn "${session.currentTurn.turnId}"`,
      );
    }

    const turn = this.beginTurn(session);
    this.dispatchPromptTurn(session, turn, message);
  }

  events(sessionRef: SessionRef): AsyncIterable<RunEvent> {
    const session = this.requireSession(sessionRef);
    const turn = session.currentTurn;
    if (!turn) {
      return (async function* () {})();
    }
    return turn.queue.iterate();
  }

  async cancel(sessionRef: SessionRef): Promise<void> {
    const session = this.requireSession(sessionRef);
    const turn = session.currentTurn;
    if (!turn || turn.queue.isFinished()) {
      if (session.status === "running") {
        session.status = "idle";
      }
      return;
    }

    turn.cancelling = true;
    this.clearPendingApprovalsForSession(session.sessionId, true);

    if (!session.exited && session.providerSessionId) {
      void session.agentCtx
        .notify("session/cancel", { sessionId: session.providerSessionId })
        .catch(() => {});
    }

    const fallback = new Promise<void>((resolve) => {
      turn.cancelTimer = setTimeout(() => {
        turn.cancelTimer = null;
        if (!turn.queue.isFinished()) {
          void this.closeChild(session.child, session.connection).finally(() => {
            if (!turn.queue.isFinished()) {
              turn.queue.emitExit("cancelled", "Cancelled (ACP cancel timeout)");
            }
            session.status = "closed";
            session.exited = true;
            resolve();
          });
        } else {
          resolve();
        }
      }, this.cancelTimeoutMs);
      turn.cancelTimer.unref?.();
    });

    await Promise.race([turn.queue.waitForFinish(), fallback]);
    if (turn.cancelTimer) {
      clearTimeout(turn.cancelTimer);
      turn.cancelTimer = null;
    }
  }

  async probe(sessionRef: SessionRef): Promise<SessionProbeResult> {
    const session = this.requireSession(sessionRef);
    const activeTurnId =
      session.currentTurn && !session.currentTurn.queue.isFinished()
        ? session.currentTurn.turnId
        : null;
    return {
      alive: session.status !== "closed" && !session.exited,
      status: session.status,
      activeTurnId,
    };
  }

  async liveViewUrl(_sessionRef: SessionRef): Promise<string | null> {
    return null;
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const allSessions = Array.from(this.sessions.values());
    this.sessions.clear();
    this.clearAllPendingApprovals();
    this.approvalHandlers.clear();

    await Promise.allSettled(
      allSessions.map(async (session) => {
        const turn = session.currentTurn;
        if (turn?.cancelTimer) {
          clearTimeout(turn.cancelTimer);
          turn.cancelTimer = null;
        }
        if (turn && !turn.queue.isFinished()) {
          turn.cancelling = true;
          turn.queue.emitExit("cancelled", "Backend disposed");
        }
        session.status = "closed";
        session.exited = true;
        await this.closeChild(session.child, session.connection);
      }),
    );
  }

  private beginTurn(session: AcpSessionState): AcpTurnState {
    session.turnSeq += 1;
    session.status = "running";
    const turn: AcpTurnState = {
      turnId: `${session.sessionId}-turn-${session.turnSeq}`,
      queue: new TurnEventQueue(),
      cancelling: false,
      cancelTimer: null,
    };
    session.currentTurn = turn;
    return turn;
  }

  private buildPromptBlocks(
    promptText: string,
    attachments?: readonly RunAttachmentInput[],
  ): ContentBlock[] {
    const blocks: ContentBlock[] = [{ type: "text", text: promptText }];
    if (!attachments || attachments.length === 0 || !this.cachedCapabilities.imageInput) {
      return blocks;
    }

    for (const att of attachments) {
      try {
        const st = fs.statSync(att.path);
        if (!st.isFile() || st.size <= 0 || st.size > MAX_ATTACHMENT_BYTES) {
          continue;
        }
        const data = fs.readFileSync(att.path).toString("base64");
        blocks.push({
          type: "image",
          mimeType: att.mimeType,
          data,
        });
      } catch {
        // Ignore unreadable attachment files so text execution still proceeds.
      }
    }
    return blocks;
  }

  private dispatchPromptTurn(
    session: AcpSessionState,
    turn: AcpTurnState,
    promptText: string,
    attachments?: readonly RunAttachmentInput[],
  ): void {
    const prompt = this.buildPromptBlocks(promptText, attachments);
    void session.agentCtx
      .request("session/prompt", {
        sessionId: session.providerSessionId,
        prompt,
      })
      .then((res) => {
        if (turn.queue.isFinished()) {
          return;
        }
        if (turn.cancelTimer) {
          clearTimeout(turn.cancelTimer);
          turn.cancelTimer = null;
        }
        const ext = res as ExtendedPromptResponse;
        const at = new Date().toISOString();

        if (ext.usage) {
          const rule = resolveProviderUsageRule(this.provider.id, this.provider.usage_rule);
          const normalized = normalizeProviderTurnUsage({
            provider: this.provider.id,
            model: session.runSpec.model,
            agentId: this.provider.id,
            raw: {
              inputTokens: ext.usage.inputTokens,
              cachedReadTokens: ext.usage.cachedReadTokens,
              cacheWriteTokens: ext.usage.cachedWriteTokens,
              outputTokens: ext.usage.outputTokens,
              reasoningTokens: ext.usage.thoughtTokens,
            },
            rule,
            state: session.usageState,
            candidateTurnIds: [turn.turnId],
          });
          if (normalized) {
            turn.queue.push({ kind: "usage", at, ...normalized });
          }
        }

        if (ext.stopReason === "cancelled" || turn.cancelling) {
          session.status = "idle";
          turn.queue.emitExit("cancelled", "Turn cancelled");
          return;
        }

        session.status = "idle";
        turn.queue.emitExit("completed");
      })
      .catch((err) => {
        if (turn.queue.isFinished()) {
          return;
        }
        if (turn.cancelTimer) {
          clearTimeout(turn.cancelTimer);
          turn.cancelTimer = null;
        }
        if (turn.cancelling) {
          session.status = session.exited ? "closed" : "idle";
          turn.queue.emitExit("cancelled", "Turn cancelled");
          return;
        }
        const detail = err instanceof Error ? err.message : String(err);
        const at = new Date().toISOString();
        if (isRateLimitMessage(detail)) {
          const retryAfterSec = extractRetryAfterSec(detail);
          const until = this.healthTracker?.recordRateLimit(this.provider.id, {
            ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
            detail,
          });
          turn.queue.push({
            kind: "rate_limited",
            at,
            provider: this.provider.id,
            ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
            ...(until !== undefined ? { until } : {}),
            detail,
          });
        }
        session.status = session.exited ? "closed" : "idle";
        turn.queue.emitExit("failed", detail);
      });
  }

  private handleSessionNotification(
    session: AcpSessionState,
    notification: SessionNotification,
  ): void {
    const turn = session.currentTurn;
    if (!turn || turn.queue.isFinished()) {
      return;
    }

    const update = notification.update as unknown as Record<string, unknown> | undefined;
    if (!update) {
      return;
    }
    const kind = String(update.sessionUpdate ?? "");
    const at = new Date().toISOString();

    switch (kind) {
      case "agent_message_chunk": {
        const content = update.content as { type?: unknown; text?: unknown } | undefined;
        if (
          content?.type === "text" &&
          typeof content.text === "string" &&
          content.text.length > 0
        ) {
          turn.queue.push({ kind: "message", at, text: content.text, delta: true });
        }
        break;
      }
      case "agent_thought_chunk": {
        const content = update.content as { type?: unknown; text?: unknown } | undefined;
        const chars = typeof content?.text === "string" ? content.text.length : 0;
        turn.queue.push(chars > 0 ? { kind: "thinking", at, chars } : { kind: "thinking", at });
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const title = typeof update.title === "string" ? update.title : undefined;
        const name = typeof update.name === "string" ? update.name : (title ?? "tool");
        const locations = Array.isArray(update.locations) ? update.locations : [];
        const firstPath =
          locations[0] && typeof (locations[0] as { path?: unknown }).path === "string"
            ? (locations[0] as { path: string }).path
            : undefined;
        if (kind === "tool_call") {
          turn.queue.push({
            kind: "tool",
            at,
            name,
            ...(firstPath ? { target: firstPath } : {}),
          });
        }
        const toolKind = typeof update.kind === "string" ? update.kind.toLowerCase() : "";
        const status = typeof update.status === "string" ? update.status.toLowerCase() : "";
        if ((toolKind === "edit" || toolKind === "write") && status === "completed" && firstPath) {
          turn.queue.push({ kind: "file_write", at, path: firstPath });
        }
        break;
      }
      case "usage_update": {
        // P3 invariant: live usage_update ONLY emits context_window occupancy, NEVER usage_turns billing.
        const used = typeof update.used === "number" ? update.used : undefined;
        const size = typeof update.size === "number" ? update.size : undefined;
        if (used !== undefined && size !== undefined && size > 0) {
          turn.queue.push(createContextWindowEvent(used, size, at));
        }
        break;
      }
      default:
        break;
    }
  }

  private async handlePermissionRequest(
    session: AcpSessionState,
    params: RequestPermissionRequest,
  ): Promise<{ outcome: RequestPermissionOutcome }> {
    const turn = session.currentTurn;
    const options = params.options ?? [];
    const at = new Date().toISOString();
    const isMutating = isWriteOrExecuteToolCall(params.toolCall);
    const candidatePaths = extractCandidateWritePaths(params.toolCall);

    const outOfRoot =
      isMutating &&
      candidatePaths.some(
        (p) => !isPathInsideRoots(p, session.canonicalCwd, session.canonicalAllowedWriteRoots),
      );

    const approvalId = `acp-appr-${randomUUID()}`;
    const rawKind =
      typeof params.toolCall?.kind === "string" ? params.toolCall.kind.toLowerCase() : "";
    const action = outOfRoot
      ? "outside_scope"
      : isMutating
        ? MUTATING_KIND_SET.has(rawKind)
          ? rawKind
          : "file_write"
        : rawKind || "read";
    const detail =
      candidatePaths[0] ??
      params.toolCall?.title ??
      params.toolCall?.name ??
      JSON.stringify(params.toolCall ?? {});

    if (turn && !turn.queue.isFinished()) {
      turn.queue.push({
        kind: "approval",
        at,
        id: approvalId,
        action,
        detail,
      });
    }

    // P3 guardrail: read-only roles NEVER approve mutating/execute actions.
    if (session.isReadOnly && isMutating) {
      return { outcome: pickRejectOption(options) };
    }
    if (outOfRoot && this.approvalHandlers.size === 0) {
      return { outcome: pickRejectOption(options) };
    }

    if (this.approvalHandlers.size === 0) {
      return { outcome: isMutating ? pickRejectOption(options) : pickAllowOption(options) };
    }

    const reqEvent: ApprovalRequestEvent = {
      id: approvalId,
      sessionRef: session.sessionRef,
      action,
      detail,
      at,
    };

    const outcome = await new Promise<RequestPermissionOutcome>((resolve) => {
      this.pendingApprovals.set(approvalId, {
        id: approvalId,
        sessionId: session.sessionId,
        options,
        resolve,
      });
      for (const handler of this.approvalHandlers) {
        void Promise.resolve(handler(reqEvent)).catch(() => {});
      }
    });

    return { outcome };
  }

  private handleProcessClosed(session: AcpSessionState, detail: string): void {
    if (session.exited) {
      return;
    }
    session.exited = true;
    session.status = "closed";
    this.clearPendingApprovalsForSession(session.sessionId, true);
    const turn = session.currentTurn;
    if (turn && !turn.queue.isFinished()) {
      if (turn.cancelTimer) {
        clearTimeout(turn.cancelTimer);
        turn.cancelTimer = null;
      }
      if (turn.cancelling) {
        turn.queue.emitExit("cancelled", "Cancelled");
      } else {
        turn.queue.emitExit("failed", detail);
      }
    }
  }

  private clearPendingApprovalsForSession(sessionId: string, rejectWaiters = false): void {
    for (const [id, pending] of this.pendingApprovals) {
      if (pending.sessionId === sessionId) {
        this.pendingApprovals.delete(id);
        if (rejectWaiters) {
          pending.resolve({ outcome: "cancelled" });
        }
      }
    }
  }

  private clearAllPendingApprovals(): void {
    for (const [id, pending] of this.pendingApprovals) {
      this.pendingApprovals.delete(id);
      pending.resolve({ outcome: "cancelled" });
    }
  }

  private requireSession(sessionRef: SessionRef): AcpSessionState {
    if (sessionRef.backendId !== this.backendId) {
      throw new Error(
        `Session backendId mismatch: expected "${this.backendId}", got "${sessionRef.backendId}"`,
      );
    }
    const session = this.sessions.get(sessionRef.sessionId);
    if (!session) {
      throw new Error(`Unknown ACP session "${sessionRef.sessionId}"`);
    }
    return session;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error(`AcpBackend "${this.backendId}" has been disposed`);
    }
  }
}
