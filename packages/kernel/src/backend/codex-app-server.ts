import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type BackendCapabilities,
  type ProviderEntry,
  type ProviderNativeQuota,
  type RunEvent,
  type SessionRef,
} from "@kiln/protocol";
import type { ProviderHealthTracker } from "./provider-health.js";
import {
  StdioRpcProcess,
  TurnEventQueue,
  buildAgentCliEnv,
  extractRetryAfterSec,
  isRateLimitMessage,
  probeCliBinary,
  resolveCliBinary,
  type ProbeCliBinaryOptions,
  type SpawnProcessFn,
} from "./stdio-rpc.js";
import {
  assertRoleAgentEligible,
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
  type SessionProbeResult,
} from "./types.js";
import {
  DEFAULT_PROVIDER_USAGE_RULES,
  createContextWindowEvent,
  createProviderUsageNormalizerState,
  normalizeProviderTurnUsage,
  resolveProviderUsageRule,
  type ProviderUsageNormalizerState,
  type RawProviderUsage,
} from "./usage-normalizer.js";

const DEFAULT_CANCEL_TIMEOUT_MS = 3_000;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

export const CODEX_APP_SERVER_CAPABILITIES: BackendCapabilities = {
  interactiveChat: true,
  approvals: true,
  mcpInjection: true,
  usageCacheBreakdown: true,
  interrupt: true,
  imageInput: true,
  cacheWriteTelemetry: false,
  contextWindowTelemetry: true,
  nativeQuotaWindow: true,
  readOnlySandbox: true,
  warmSessionReuse: true,
};

const CODEX_MODES: readonly BackendModeDescriptor[] = [
  { id: "workspace-write", label: "Workspace Write" },
  { id: "read-only", label: "Read Only" },
];

const GRANULAR_APPROVAL_POLICY = {
  granular: {
    mcp_elicitations: true,
    rules: false,
    sandbox_approval: false,
    request_permissions: false,
    skill_approval: false,
  },
} as const;

export interface CodexAppServerBackendOptions {
  provider: ProviderEntry;
  kilnHome?: string;
  sourceCodexHome?: string;
  healthTracker?: ProviderHealthTracker;
  cancelTimeoutMs?: number;
  rpcTimeoutMs?: number;
  spawnFn?: SpawnProcessFn;
  probeOptions?: ProbeCliBinaryOptions;
}

const CODEX_SHARED_FILES = [
  "auth.json",
  "config.toml",
  "instructions.md",
  "AGENTS.md",
  "hooks.json",
] as const;

const CODEX_SHARED_DIRS = ["skills", "agents", "rules", "plugins", "vendor_imports"] as const;

/**
 * Resolves Kiln's isolated `CODEX_HOME` directory under `<kilnHome>/agent-homes/codex`
 * so Kiln background runs never pollute the user's personal `~/.codex` session list.
 */
export function resolveIsolatedCodexHome(kilnHome: string): string {
  return path.join(path.resolve(kilnHome), "agent-homes", "codex");
}

function isPathWithinDir(candidatePath: string, parentDir: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedParent = path.resolve(parentDir);
  if (resolvedCandidate === resolvedParent) {
    return true;
  }
  const prefix = resolvedParent.endsWith(path.sep) ? resolvedParent : resolvedParent + path.sep;
  return resolvedCandidate.startsWith(prefix);
}

function removeStaleMirrorSymlink(dstPath: string, targetDir: string, sourceDir: string): void {
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(dstPath);
  } catch {
    return;
  }
  if (!lst.isSymbolicLink()) {
    return;
  }
  try {
    const rawLink = fs.readlinkSync(dstPath);
    const resolvedLink = path.resolve(targetDir, rawLink);
    if (isPathWithinDir(resolvedLink, sourceDir)) {
      fs.rmSync(dstPath, { force: true });
    }
  } catch {
    fs.rmSync(dstPath, { force: true });
  }
}

/**
 * Prepares an isolated `CODEX_HOME` under `<kilnHome>/agent-homes/codex` by mirroring
 * shared auth/config/extensions from `sourceCodexHome` (defaulting to `$CODEX_HOME` or `~/.codex`)
 * while excluding all conversation history, session indexes, and SQLite state files.
 */
export function prepareIsolatedCodexHome(
  kilnHome: string,
  options?: {
    sourceCodexHome?: string;
    platform?: NodeJS.Platform;
  },
): string {
  const platform = options?.platform ?? process.platform;
  const targetDir = resolveIsolatedCodexHome(kilnHome);
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  if (platform !== "win32") {
    try {
      fs.chmodSync(targetDir, 0o700);
    } catch {
      // Ignore chmod failure on unsupported filesystems.
    }
  }

  const explicitSource = options?.sourceCodexHome?.trim();
  const envSource = process.env.CODEX_HOME?.trim();
  const rawSource =
    explicitSource && explicitSource.length > 0
      ? explicitSource
      : envSource && envSource.length > 0 && path.resolve(envSource) !== targetDir
        ? envSource
        : path.join(os.homedir(), ".codex");
  const sourceDir = path.resolve(rawSource);

  if (sourceDir === targetDir || !fs.existsSync(sourceDir)) {
    return targetDir;
  }

  for (const name of CODEX_SHARED_FILES) {
    const srcPath = path.join(sourceDir, name);
    const dstPath = path.join(targetDir, name);
    let srcStat: fs.Stats | null = null;
    try {
      const st = fs.statSync(srcPath);
      if (st.isFile()) {
        srcStat = st;
      }
    } catch {
      srcStat = null;
    }

    if (!srcStat) {
      removeStaleMirrorSymlink(dstPath, targetDir, sourceDir);
      continue;
    }

    let dstLstat: fs.Stats | null = null;
    try {
      dstLstat = fs.lstatSync(dstPath);
    } catch {
      dstLstat = null;
    }

    if (dstLstat) {
      if (dstLstat.isSymbolicLink()) {
        try {
          const resolvedLink = path.resolve(targetDir, fs.readlinkSync(dstPath));
          if (resolvedLink === srcPath) {
            continue;
          }
          if (isPathWithinDir(resolvedLink, sourceDir)) {
            fs.rmSync(dstPath, { force: true });
          } else {
            continue;
          }
        } catch {
          fs.rmSync(dstPath, { force: true });
        }
      } else if (dstLstat.isFile()) {
        if (name === "auth.json" && dstLstat.mtimeMs >= srcStat.mtimeMs) {
          // Preserve fresher OAuth tokens refreshed by Codex inside the isolated home.
          continue;
        }
        if (dstLstat.mtimeMs >= srcStat.mtimeMs) {
          continue;
        }
      } else {
        continue;
      }
    }

    try {
      fs.symlinkSync(srcPath, dstPath, "file");
    } catch {
      try {
        fs.copyFileSync(srcPath, dstPath);
        if (platform !== "win32" && name === "auth.json") {
          try {
            fs.chmodSync(dstPath, 0o600);
          } catch {
            // Ignore chmod failure.
          }
        }
      } catch {
        // Non-fatal mirror failure; Codex can still boot with defaults.
      }
    }
  }

  for (const dirName of CODEX_SHARED_DIRS) {
    const srcPath = path.join(sourceDir, dirName);
    const dstPath = path.join(targetDir, dirName);
    let srcIsDir = false;
    try {
      srcIsDir = fs.statSync(srcPath).isDirectory();
    } catch {
      srcIsDir = false;
    }

    if (!srcIsDir) {
      removeStaleMirrorSymlink(dstPath, targetDir, sourceDir);
      continue;
    }

    let dstLstat: fs.Stats | null = null;
    try {
      dstLstat = fs.lstatSync(dstPath);
    } catch {
      dstLstat = null;
    }

    if (dstLstat) {
      if (dstLstat.isSymbolicLink()) {
        try {
          const resolvedLink = path.resolve(targetDir, fs.readlinkSync(dstPath));
          if (resolvedLink === srcPath) {
            continue;
          }
          if (isPathWithinDir(resolvedLink, sourceDir)) {
            fs.rmSync(dstPath, { force: true });
          } else {
            continue;
          }
        } catch {
          fs.rmSync(dstPath, { force: true });
        }
      } else {
        continue;
      }
    }

    try {
      fs.symlinkSync(srcPath, dstPath, platform === "win32" ? "junction" : "dir");
    } catch {
      // Ignore unsupported directory symlink permissions gracefully.
    }
  }

  return targetDir;
}

interface PendingCodexApproval {
  id: string;
  sessionId: string;
  rpcId: string | number;
  kind: "elicitation" | "approval";
  proc: StdioRpcProcess;
  queue: TurnEventQueue;
}

interface CodexTurnState {
  turnId: string;
  providerTurnId: string | null;
  queue: TurnEventQueue;
  latestTotalUsage: RawProviderUsage | null;
  cancelling: boolean;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  seenItemIds: Set<string>;
}

interface CodexSessionState {
  sessionId: string;
  sessionRef: SessionRef;
  proc: StdioRpcProcess;
  runSpec: BackendRunSpec;
  isReadOnly: boolean;
  threadId: string;
  mountedMcpNames: Set<string>;
  usageState: ProviderUsageNormalizerState;
  status: "running" | "idle" | "closed";
  turnSeq: number;
  currentTurn: CodexTurnState | null;
}

function buildProcessEnv(
  providerEnv?: Record<string, string>,
  runEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  return buildAgentCliEnv(providerEnv, runEnv);
}

function normalizeCodexRateLimit(raw: unknown): ProviderNativeQuota | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as {
    rateLimits?: {
      limitId?: unknown;
      planType?: unknown;
      primary?: {
        usedPercent?: unknown;
        windowDurationMins?: unknown;
        resetsAt?: unknown;
      } | null;
    } | null;
  };
  const primary = obj.rateLimits?.primary;
  if (
    !primary ||
    typeof primary.usedPercent !== "number" ||
    !Number.isFinite(primary.usedPercent)
  ) {
    return null;
  }

  let resetsAtIso: string | null = null;
  if (typeof primary.resetsAt === "number" && Number.isFinite(primary.resetsAt)) {
    const ms = primary.resetsAt > 1e12 ? primary.resetsAt : primary.resetsAt * 1000;
    resetsAtIso = new Date(ms).toISOString();
  } else if (typeof primary.resetsAt === "string" && primary.resetsAt.trim().length > 0) {
    resetsAtIso = primary.resetsAt.trim();
  }

  return {
    source: typeof obj.rateLimits?.limitId === "string" ? obj.rateLimits.limitId : "codex",
    used_percent: Math.min(100, Math.max(0, primary.usedPercent)),
    window_duration_mins:
      typeof primary.windowDurationMins === "number" && primary.windowDurationMins > 0
        ? Math.trunc(primary.windowDurationMins)
        : null,
    resets_at: resetsAtIso,
    plan_type:
      typeof obj.rateLimits?.planType === "string" && obj.rateLimits.planType.length > 0
        ? obj.rateLimits.planType
        : null,
  };
}

function mapCodexModelList(rawData: unknown): BackendModelDescriptor[] {
  const obj = rawData as { data?: unknown } | null;
  const list = Array.isArray(obj?.data) ? obj.data : Array.isArray(rawData) ? rawData : [];
  const models: BackendModelDescriptor[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id =
      typeof rec.id === "string" && rec.id.trim().length > 0
        ? rec.id.trim()
        : typeof rec.model === "string" && rec.model.trim().length > 0
          ? rec.model.trim()
          : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const label =
      typeof rec.displayName === "string" && rec.displayName.trim().length > 0
        ? rec.displayName.trim()
        : typeof rec.name === "string" && rec.name.trim().length > 0
          ? rec.name.trim()
          : id;

    const rawEfforts = Array.isArray(rec.supportedReasoningEfforts)
      ? rec.supportedReasoningEfforts
      : [];
    const thinkingOptions: BackendModelDescriptor["thinkingOptions"] = [];
    for (const eff of rawEfforts) {
      const val =
        typeof eff === "string"
          ? eff
          : eff && typeof eff === "object"
            ? ((eff as { reasoningEffort?: unknown; id?: unknown }).reasoningEffort ??
              (eff as { id?: unknown }).id)
            : null;
      if (
        typeof val === "string" &&
        ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(val)
      ) {
        const typed = val as BackendModelDescriptor["thinkingOptions"][number];
        if (!thinkingOptions.includes(typed)) {
          thinkingOptions.push(typed);
        }
      }
    }

    const defaultEffort =
      typeof rec.defaultReasoningEffort === "string" &&
      thinkingOptions.includes(
        rec.defaultReasoningEffort as BackendModelDescriptor["thinkingOptions"][number],
      )
        ? (rec.defaultReasoningEffort as BackendModelDescriptor["thinkingOptions"][number])
        : undefined;

    models.push({
      id,
      label,
      thinkingOptions,
      ...(defaultEffort !== undefined ? { defaultThinkingOptionId: defaultEffort } : {}),
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
    out.push({
      id,
      label: id,
      thinkingOptions: [],
    });
  }
  return out;
}

/**
 * Direct `codex app-server` JSONL adapter grounded on P1 probe findings.
 */
export class CodexAppServerBackend implements ProviderTelemetryBackend {
  readonly backendId: string;

  private readonly provider: ProviderEntry;
  private readonly kilnHome: string | undefined;
  private readonly sourceCodexHome: string | undefined;
  private readonly healthTracker: ProviderHealthTracker | undefined;
  private readonly cancelTimeoutMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly spawnFn: SpawnProcessFn | undefined;
  private readonly probeOptions: ProbeCliBinaryOptions | undefined;

  private readonly sessions = new Map<string, CodexSessionState>();
  private readonly approvalHandlers = new Set<ApprovalHandler>();
  private readonly pendingApprovals = new Map<string, PendingCodexApproval>();
  private cachedModels: BackendModelDescriptor[] | null = null;
  private disposed = false;

  constructor(options: CodexAppServerBackendOptions) {
    this.provider = options.provider;
    this.backendId = options.provider.id;
    this.kilnHome = options.kilnHome;
    this.sourceCodexHome = options.sourceCodexHome;
    this.healthTracker = options.healthTracker;
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.spawnFn = options.spawnFn;
    this.probeOptions = options.probeOptions;
  }

  private resolveCodexProcessEnv(runEnv?: Record<string, string>): {
    env: NodeJS.ProcessEnv;
    codexHome: string | undefined;
  } {
    const explicitCodexHome =
      runEnv?.CODEX_HOME?.trim() || this.provider.env?.CODEX_HOME?.trim() || undefined;
    if (explicitCodexHome) {
      return {
        env: buildProcessEnv(this.provider.env, runEnv),
        codexHome: explicitCodexHome,
      };
    }
    if (this.kilnHome) {
      const isolatedCodexHome = prepareIsolatedCodexHome(
        this.kilnHome,
        this.sourceCodexHome !== undefined ? { sourceCodexHome: this.sourceCodexHome } : {},
      );
      return {
        env: buildProcessEnv(this.provider.env, {
          ...(runEnv ?? {}),
          CODEX_HOME: isolatedCodexHome,
        }),
        codexHome: isolatedCodexHome,
      };
    }
    return {
      env: buildProcessEnv(this.provider.env, runEnv),
      codexHome: undefined,
    };
  }

  private getCommandAndArgs(): { command: string; args: string[] } {
    const command = this.provider.command?.trim() || "codex";
    const args = this.provider.args.length > 0 ? [...this.provider.args] : ["app-server"];
    return { command, args };
  }

  async probeProvider(): Promise<ProviderProbeSnapshot> {
    this.assertNotDisposed();
    const { command, args } = this.getCommandAndArgs();
    const { env } = this.resolveCodexProcessEnv();
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
        capabilities: { ...CODEX_APP_SERVER_CAPABILITIES },
      };
    }

    const proc = new StdioRpcProcess({
      command: binaryProbe.resolvedPath,
      args,
      cwd: process.cwd(),
      env,
      ...(this.spawnFn ? { spawnFn: this.spawnFn } : {}),
    });

    try {
      await proc.request(
        "initialize",
        {
          clientInfo: { name: "kiln", title: "Kiln", version: "0.0.8" },
          capabilities: { experimentalApi: true },
        },
        { includeJsonRpcField: false, timeoutMs: 8_000 },
      );
      proc.send({ method: "initialized" });

      const modelListRes = await proc.request(
        "model/list",
        { limit: 100 },
        { includeJsonRpcField: false, timeoutMs: 8_000 },
      );
      const discovered = mapCodexModelList(modelListRes);
      this.cachedModels = mergeCustomModels(discovered, this.provider.custom_models);

      let nativeQuota: ProviderNativeQuota | null = null;
      try {
        const rateRes = await proc.request("account/rateLimits/read", null, {
          includeJsonRpcField: false,
          timeoutMs: 5_000,
        });
        nativeQuota = normalizeCodexRateLimit(rateRes);
        this.healthTracker?.setNativeQuota(this.provider.id, nativeQuota);
      } catch {
        // Non-fatal if account rateLimits endpoint is unavailable.
      }

      this.healthTracker?.setAvailability(this.provider.id, {
        available: true,
        version: binaryProbe.version,
      });

      return {
        available: true,
        version: binaryProbe.version,
        modelsCount: this.cachedModels.length,
        capabilities: { ...CODEX_APP_SERVER_CAPABILITIES },
        nativeQuota,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const authRequired = /auth|login|unauthorized|api[_ -]?key|token/i.test(msg);
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
        capabilities: { ...CODEX_APP_SERVER_CAPABILITIES },
      };
    } finally {
      await proc.close();
    }
  }

  async readNativeQuota(): Promise<ProviderNativeQuota | null> {
    const snap = await this.probeProvider();
    return snap.nativeQuota ?? null;
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
        capabilities: { ...CODEX_APP_SERVER_CAPABILITIES },
        modes: CODEX_MODES.map((m) => ({ ...m })),
        defaultModeId: "workspace-write",
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
    return { ...CODEX_APP_SERVER_CAPABILITIES };
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

    if (pending.kind === "elicitation") {
      pending.proc.respond(
        pending.rpcId,
        { action: allow ? "accept" : "decline" },
        { includeJsonRpcField: false },
      );
    } else {
      pending.proc.respond(
        pending.rpcId,
        { decision: allow ? "accept" : "decline" },
        { includeJsonRpcField: false },
      );
    }
  }

  async start(runSpec: BackendRunSpec): Promise<SessionRef> {
    this.assertNotDisposed();
    assertRoleAgentEligible(runSpec.role, this.provider.id, CODEX_APP_SERVER_CAPABILITIES);

    const isReadOnly = isReadOnlyRole(runSpec.role) || runSpec.readOnly === true;
    const selectedModeId = isReadOnly
      ? "read-only"
      : (selectSafeModeId(this.provider.id, CODEX_MODES, {
          allowFullAccessFallback: runSpec.allowFullAccessFallback,
        }) ?? "workspace-write");

    const { command, args } = this.getCommandAndArgs();
    const { env, codexHome } = this.resolveCodexProcessEnv(runSpec.env);
    const resolvedCmd = resolveCliBinary(command, { env, ...(this.probeOptions ?? {}) }) ?? command;

    const sessionId = `codex-${randomUUID()}`;
    const sessionRef: SessionRef = {
      backendId: this.backendId,
      sessionId,
      meta: {
        agent: this.provider.id,
        modeId: selectedModeId,
        ...(codexHome ? { codexHome } : {}),
      },
    };

    const mountedMcpNames = new Set<string>();
    const mcpServersConfig: Record<
      string,
      { command: string; args: string[]; env?: Record<string, string> }
    > = {};
    for (const mcp of runSpec.mcpServers ?? []) {
      mountedMcpNames.add(mcp.name);
      mcpServersConfig[mcp.name] = {
        command: mcp.command,
        args: [...(mcp.args ?? [])],
        ...(mcp.env ? { env: { ...mcp.env } } : {}),
      };
    }

    let session!: CodexSessionState;
    const proc = new StdioRpcProcess({
      command: resolvedCmd,
      args,
      cwd: runSpec.cwd,
      env,
      ...(this.spawnFn ? { spawnFn: this.spawnFn } : {}),
      onMessage: (msg) => {
        if (session) {
          this.handleWireMessage(session, msg);
        }
      },
      onExit: (info) => {
        if (!session) return;
        this.clearPendingApprovalsForSession(session.sessionId);
        session.status = "closed";
        const turn = session.currentTurn;
        if (turn && !turn.queue.isFinished()) {
          if (turn.cancelTimer) {
            clearTimeout(turn.cancelTimer);
            turn.cancelTimer = null;
          }
          if (turn.cancelling) {
            turn.queue.emitExit("cancelled", "Cancelled");
          } else {
            const detail =
              info.error?.message ??
              `Codex app-server exited unexpectedly (code=${info.code ?? "null"}, signal=${info.signal ?? "null"})`;
            turn.queue.emitExit("failed", detail);
          }
        }
      },
    });

    session = {
      sessionId,
      sessionRef,
      proc,
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
      threadId: "",
      mountedMcpNames,
      usageState: createProviderUsageNormalizerState(),
      status: "running",
      turnSeq: 0,
      currentTurn: null,
    };
    this.sessions.set(sessionId, session);

    try {
      await proc.request(
        "initialize",
        {
          clientInfo: { name: "kiln", title: "Kiln", version: "0.0.8" },
          capabilities: { experimentalApi: true },
        },
        { includeJsonRpcField: false, timeoutMs: this.rpcTimeoutMs },
      );
      proc.send({ method: "initialized" });

      const threadRes = (await proc.request(
        "thread/start",
        {
          cwd: runSpec.cwd,
          model: runSpec.model,
          approvalPolicy: GRANULAR_APPROVAL_POLICY,
          sandbox: isReadOnly ? "read-only" : "workspace-write",
          ephemeral: false,
          ...(Object.keys(mcpServersConfig).length > 0
            ? { config: { mcp_servers: mcpServersConfig } }
            : {}),
        },
        { includeJsonRpcField: false, timeoutMs: this.rpcTimeoutMs },
      )) as { thread?: { id?: string; path?: string | null } };

      const threadId = threadRes?.thread?.id?.trim();
      const threadPath =
        typeof threadRes?.thread?.path === "string" && threadRes.thread.path.trim().length > 0
          ? threadRes.thread.path.trim()
          : undefined;
      if (!threadId) {
        throw new Error("Codex app-server thread/start did not return thread.id");
      }
      session.threadId = threadId;
      sessionRef.meta = {
        ...sessionRef.meta,
        providerSessionId: threadId,
        ...(threadPath ? { providerSessionPath: threadPath } : {}),
      };

      const initialPrompt = runSpec.systemPrompt
        ? `${runSpec.systemPrompt.trim()}\n\n${runSpec.prompt}`
        : runSpec.prompt;
      const turn = this.beginTurn(session);
      turn.queue.push({
        kind: "session_bound",
        at: new Date().toISOString(),
        providerSessionId: threadId,
        ...(threadPath ? { providerSessionPath: threadPath } : {}),
      });

      const startTurnRes = (await proc.request(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: initialPrompt }],
          ...(runSpec.reasoningEffort ? { effort: runSpec.reasoningEffort } : {}),
          approvalPolicy: GRANULAR_APPROVAL_POLICY,
          sandboxPolicy: isReadOnly
            ? { type: "readOnly", networkAccess: false }
            : {
                type: "workspaceWrite",
                writableRoots: runSpec.allowedWriteRoots?.length
                  ? runSpec.allowedWriteRoots
                  : [runSpec.cwd],
                networkAccess: false,
              },
        },
        { includeJsonRpcField: false, timeoutMs: this.rpcTimeoutMs },
      )) as { turn?: { id?: string } };
      if (typeof startTurnRes?.turn?.id === "string" && startTurnRes.turn.id.trim().length > 0) {
        turn.providerTurnId = startTurnRes.turn.id.trim();
      }
    } catch (err) {
      this.sessions.delete(sessionId);
      this.clearPendingApprovalsForSession(sessionId);
      await proc.close();
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
    if (session.status === "closed" || !session.proc.isAlive) {
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
    try {
      const startTurnRes = (await session.proc.request(
        "turn/start",
        {
          threadId: session.threadId,
          input: [{ type: "text", text: message }],
          ...(session.runSpec.reasoningEffort ? { effort: session.runSpec.reasoningEffort } : {}),
          approvalPolicy: GRANULAR_APPROVAL_POLICY,
          sandboxPolicy: session.isReadOnly
            ? { type: "readOnly", networkAccess: false }
            : {
                type: "workspaceWrite",
                writableRoots: session.runSpec.allowedWriteRoots?.length
                  ? session.runSpec.allowedWriteRoots
                  : [session.runSpec.cwd],
                networkAccess: false,
              },
        },
        { includeJsonRpcField: false, timeoutMs: this.rpcTimeoutMs },
      )) as { turn?: { id?: string } };
      if (typeof startTurnRes?.turn?.id === "string" && startTurnRes.turn.id.trim().length > 0) {
        turn.providerTurnId = startTurnRes.turn.id.trim();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.finishTurnFailed(session, turn, msg);
      throw err;
    }
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
    this.clearPendingApprovalsForSession(session.sessionId);

    if (session.proc.isAlive && session.threadId && turn.providerTurnId) {
      void session.proc
        .request(
          "turn/interrupt",
          { threadId: session.threadId, turnId: turn.providerTurnId },
          { includeJsonRpcField: false, timeoutMs: this.cancelTimeoutMs },
        )
        .catch(() => {});
    }

    const fallback = new Promise<void>((resolve) => {
      turn.cancelTimer = setTimeout(() => {
        turn.cancelTimer = null;
        if (!turn.queue.isFinished()) {
          void session.proc.close().finally(() => {
            if (!turn.queue.isFinished()) {
              turn.queue.emitExit("cancelled", "Cancelled (interrupt timeout)");
            }
            session.status = "closed";
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
        ? (session.currentTurn.providerTurnId ?? session.currentTurn.turnId)
        : null;
    return {
      alive: session.status !== "closed" && session.proc.isAlive,
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
    this.pendingApprovals.clear();
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
        await session.proc.close();
      }),
    );
  }

  private beginTurn(session: CodexSessionState): CodexTurnState {
    session.turnSeq += 1;
    session.status = "running";
    const turn: CodexTurnState = {
      turnId: `${session.sessionId}-turn-${session.turnSeq}`,
      providerTurnId: null,
      queue: new TurnEventQueue(),
      latestTotalUsage: null,
      cancelling: false,
      cancelTimer: null,
      seenItemIds: new Set<string>(),
    };
    session.currentTurn = turn;
    return turn;
  }

  private handleWireMessage(session: CodexSessionState, msg: Record<string, unknown>): void {
    const method = typeof msg.method === "string" ? msg.method : null;
    if (!method) {
      return;
    }

    // Inbound server request requiring an RPC response
    if (typeof msg.id === "string" || typeof msg.id === "number") {
      this.handleServerRequest(session, msg.id, method, msg.params);
      return;
    }

    const turn = session.currentTurn;
    if (!turn || turn.queue.isFinished()) {
      return;
    }

    const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<
      string,
      unknown
    >;
    const at = new Date().toISOString();

    switch (method) {
      case "turn/started": {
        const t = params.turn as { id?: unknown } | undefined;
        if (typeof t?.id === "string" && t.id.trim().length > 0) {
          turn.providerTurnId = t.id.trim();
        }
        break;
      }
      case "item/agentMessage/delta": {
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (delta.length > 0) {
          turn.queue.push({ kind: "message", at, text: delta, delta: true });
        }
        break;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const delta = typeof params.delta === "string" ? params.delta : "";
        turn.queue.push(
          delta.length > 0
            ? { kind: "thinking", at, chars: delta.length }
            : { kind: "thinking", at },
        );
        break;
      }
      case "item/started":
      case "item/completed": {
        this.handleItemEvent(turn, method, params.item, at);
        break;
      }
      case "thread/tokenUsage/updated": {
        const tokenUsage = (
          params.tokenUsage && typeof params.tokenUsage === "object" ? params.tokenUsage : params
        ) as Record<string, unknown>;
        const total = tokenUsage.total as Record<string, unknown> | undefined;
        if (total && typeof total === "object") {
          turn.latestTotalUsage = {
            inputTokens: typeof total.inputTokens === "number" ? total.inputTokens : undefined,
            cachedReadTokens:
              typeof total.cachedInputTokens === "number" ? total.cachedInputTokens : undefined,
            cacheWriteTokens:
              typeof total.cacheWriteInputTokens === "number"
                ? total.cacheWriteInputTokens
                : undefined,
            outputTokens: typeof total.outputTokens === "number" ? total.outputTokens : undefined,
            reasoningTokens:
              typeof total.reasoningOutputTokens === "number"
                ? total.reasoningOutputTokens
                : undefined,
          };
        }

        const last = tokenUsage.last as { totalTokens?: unknown } | undefined;
        const ctxWindow = tokenUsage.modelContextWindow;
        if (
          typeof last?.totalTokens === "number" &&
          typeof ctxWindow === "number" &&
          ctxWindow > 0
        ) {
          turn.queue.push(createContextWindowEvent(last.totalTokens, ctxWindow, at));
        }
        break;
      }
      case "turn/completed": {
        if (turn.cancelTimer) {
          clearTimeout(turn.cancelTimer);
          turn.cancelTimer = null;
        }
        const turnPayload = params.turn as
          | {
              id?: unknown;
              status?: unknown;
              error?: { message?: unknown } | null;
            }
          | undefined;
        const statusStr =
          typeof turnPayload?.status === "string" ? turnPayload.status : "completed";
        const providerTurnId =
          typeof turnPayload?.id === "string" ? turnPayload.id : turn.providerTurnId;

        if (turn.latestTotalUsage) {
          const rule = resolveProviderUsageRule(
            this.provider.id,
            this.provider.usage_rule ?? DEFAULT_PROVIDER_USAGE_RULES.codex,
          );
          const normalized = normalizeProviderTurnUsage({
            provider: this.provider.id,
            model: session.runSpec.model,
            agentId: this.provider.id,
            raw: turn.latestTotalUsage,
            rule,
            state: session.usageState,
            candidateTurnIds: [providerTurnId, turn.turnId],
          });
          turn.latestTotalUsage = null;
          if (normalized) {
            turn.queue.push({ kind: "usage", at, ...normalized });
          }
        }

        if (statusStr === "interrupted" || turn.cancelling) {
          session.status = "idle";
          turn.queue.emitExit("cancelled", "Turn interrupted");
          break;
        }

        if (statusStr === "failed") {
          const errDetail =
            typeof turnPayload?.error?.message === "string"
              ? turnPayload.error.message
              : JSON.stringify(turnPayload?.error ?? "Turn failed");
          this.finishTurnFailed(session, turn, errDetail);
          break;
        }

        session.status = "idle";
        turn.queue.emitExit("completed");
        break;
      }
      default:
        break;
    }
  }

  private handleItemEvent(
    turn: CodexTurnState,
    method: string,
    rawItem: unknown,
    at: string,
  ): void {
    if (!rawItem || typeof rawItem !== "object") {
      return;
    }
    const item = rawItem as Record<string, unknown>;
    const itemType = typeof item.type === "string" ? item.type : "";
    const itemId = typeof item.id === "string" ? item.id : null;

    if (itemType === "reasoning") {
      if (method === "item/started") {
        turn.queue.push({ kind: "thinking", at });
      }
      return;
    }

    if (itemType === "mcpToolCall") {
      if (method === "item/started" || (itemId && !turn.seenItemIds.has(itemId))) {
        if (itemId) turn.seenItemIds.add(itemId);
        const tool = typeof item.tool === "string" ? item.tool : "mcp_tool";
        const server = typeof item.server === "string" ? item.server : undefined;
        turn.queue.push({
          kind: "tool",
          at,
          name: server ? `${server}.${tool}` : tool,
        });
      }
      return;
    }

    if (itemType === "commandExecution") {
      if (method === "item/started" || (itemId && !turn.seenItemIds.has(itemId))) {
        if (itemId) turn.seenItemIds.add(itemId);
        const cmd = typeof item.command === "string" ? item.command : undefined;
        turn.queue.push({
          kind: "tool",
          at,
          name: "commandExecution",
          ...(cmd ? { target: cmd } : {}),
        });
      }
      return;
    }

    if (itemType === "fileChange" && method === "item/completed") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      for (const ch of changes) {
        if (ch && typeof ch === "object" && typeof (ch as { path?: unknown }).path === "string") {
          turn.queue.push({ kind: "file_write", at, path: (ch as { path: string }).path });
        }
      }
      if (changes.length === 0 && typeof item.path === "string" && item.path.length > 0) {
        turn.queue.push({ kind: "file_write", at, path: item.path });
      }
    }
  }

  private handleServerRequest(
    session: CodexSessionState,
    rpcId: string | number,
    method: string,
    rawParams: unknown,
  ): void {
    const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as Record<
      string,
      unknown
    >;
    const turn = session.currentTurn;
    const at = new Date().toISOString();

    if (method === "mcpServer/elicitation/request") {
      const serverName = typeof params.serverName === "string" ? params.serverName.trim() : "";
      if (serverName && session.mountedMcpNames.has(serverName)) {
        session.proc.respond(rpcId, { action: "accept" }, { includeJsonRpcField: false });
        return;
      }

      if (session.isReadOnly || this.approvalHandlers.size === 0) {
        session.proc.respond(rpcId, { action: "decline" }, { includeJsonRpcField: false });
        return;
      }

      const approvalId = `codex-appr-${randomUUID()}`;
      if (turn) {
        turn.queue.push({
          kind: "approval",
          at,
          id: approvalId,
          action: "mcp_elicitation",
          detail: serverName || JSON.stringify(params),
        });
        this.pendingApprovals.set(approvalId, {
          id: approvalId,
          sessionId: session.sessionId,
          rpcId,
          kind: "elicitation",
          proc: session.proc,
          queue: turn.queue,
        });
        this.dispatchApprovalEvent({
          id: approvalId,
          sessionRef: session.sessionRef,
          action: "mcp_elicitation",
          detail: serverName || JSON.stringify(params),
          at,
        });
      } else {
        session.proc.respond(rpcId, { action: "decline" }, { includeJsonRpcField: false });
      }
      return;
    }

    // All non-MCP approval requests (command execution, file changes, permissions, etc.)
    const action =
      method === "item/commandExecution/requestApproval"
        ? "command_execution"
        : method === "item/fileChange/requestApproval"
          ? "file_write"
          : method;
    const detail =
      typeof params.command === "string"
        ? params.command
        : typeof params.reason === "string"
          ? params.reason
          : JSON.stringify(params);

    const approvalId = `codex-appr-${randomUUID()}`;
    if (turn) {
      turn.queue.push({
        kind: "approval",
        at,
        id: approvalId,
        action,
        detail,
      });
    }

    if (session.isReadOnly || this.approvalHandlers.size === 0 || !turn) {
      session.proc.respond(rpcId, { decision: "decline" }, { includeJsonRpcField: false });
      return;
    }

    this.pendingApprovals.set(approvalId, {
      id: approvalId,
      sessionId: session.sessionId,
      rpcId,
      kind: "approval",
      proc: session.proc,
      queue: turn.queue,
    });
    this.dispatchApprovalEvent({
      id: approvalId,
      sessionRef: session.sessionRef,
      action,
      detail,
      at,
    });
  }

  private dispatchApprovalEvent(req: ApprovalRequestEvent): void {
    for (const handler of this.approvalHandlers) {
      void Promise.resolve(handler(req)).catch(() => {});
    }
  }

  private finishTurnFailed(session: CodexSessionState, turn: CodexTurnState, detail: string): void {
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
    session.status = "idle";
    turn.queue.emitExit("failed", detail);
  }

  private clearPendingApprovalsForSession(sessionId: string): void {
    for (const [id, item] of this.pendingApprovals) {
      if (item.sessionId === sessionId) {
        this.pendingApprovals.delete(id);
      }
    }
  }

  private requireSession(sessionRef: SessionRef): CodexSessionState {
    if (sessionRef.backendId !== this.backendId) {
      throw new Error(
        `Session backendId mismatch: expected "${this.backendId}", got "${sessionRef.backendId}"`,
      );
    }
    const session = this.sessions.get(sessionRef.sessionId);
    if (!session) {
      throw new Error(`Unknown Codex session "${sessionRef.sessionId}"`);
    }
    return session;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error(`CodexAppServerBackend "${this.backendId}" has been disposed`);
    }
  }
}
