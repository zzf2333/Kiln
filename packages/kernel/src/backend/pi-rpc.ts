import { randomUUID } from "node:crypto";
import {
  type BackendCapabilities,
  type ProviderEntry,
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
  type ApprovalHandler,
  type BackendAgentDescriptor,
  type BackendModelDescriptor,
  type BackendRunSpec,
  type ProviderProbeSnapshot,
  type ProviderTelemetryBackend,
  type SessionProbeResult,
} from "./types.js";
import {
  DEFAULT_PROVIDER_USAGE_RULES,
  accumulateMessageUsage,
  createContextWindowEvent,
  createProviderUsageNormalizerState,
  flushAccumulatedTurnUsage,
  normalizeProviderTurnUsage,
  resolveProviderUsageRule,
  type ProviderUsageNormalizerState,
} from "./usage-normalizer.js";

const DEFAULT_CANCEL_TIMEOUT_MS = 3_000;
const DEFAULT_RPC_TIMEOUT_MS = 15_000;

export const PI_RPC_CAPABILITIES: BackendCapabilities = {
  interactiveChat: true,
  approvals: false,
  mcpInjection: false,
  usageCacheBreakdown: true,
  interrupt: true,
  imageInput: true,
  cacheWriteTelemetry: true,
  contextWindowTelemetry: true,
  nativeQuotaWindow: false,
  readOnlySandbox: true,
  warmSessionReuse: true,
};

export interface PiRpcBackendOptions {
  provider: ProviderEntry;
  healthTracker?: ProviderHealthTracker;
  cancelTimeoutMs?: number;
  rpcTimeoutMs?: number;
  spawnFn?: SpawnProcessFn;
  probeOptions?: ProbeCliBinaryOptions;
}

interface PiTurnState {
  turnId: string;
  queue: TurnEventQueue;
  cancelling: boolean;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  lastErrorMessage: string | null;
  sawAssistantUsage: boolean;
}

interface PiSessionState {
  sessionId: string;
  sessionRef: SessionRef;
  proc: StdioRpcProcess;
  runSpec: BackendRunSpec;
  isReadOnly: boolean;
  usageState: ProviderUsageNormalizerState;
  status: "running" | "idle" | "closed";
  turnSeq: number;
  currentTurn: PiTurnState | null;
}

interface PiDiscoveredModel {
  fullId: string;
  provider?: string;
  modelId: string;
  descriptor: BackendModelDescriptor;
}

function buildProcessEnv(
  providerEnv?: Record<string, string>,
  runEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  return buildAgentCliEnv(providerEnv, runEnv);
}

function parsePiAvailableModels(raw: unknown): PiDiscoveredModel[] {
  const obj = raw as { models?: unknown; data?: { models?: unknown } } | null;
  const rawList = Array.isArray(obj?.models)
    ? obj.models
    : Array.isArray(obj?.data?.models)
      ? obj.data.models
      : [];

  const results: PiDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const rawId = typeof rec.id === "string" ? rec.id.trim() : "";
    const provider = typeof rec.provider === "string" ? rec.provider.trim() : "";
    if (!rawId) continue;

    const fullId = provider && !rawId.includes("/") ? `${provider}/${rawId}` : rawId;
    if (seen.has(fullId)) continue;
    seen.add(fullId);

    const reasoning = rec.reasoning === true;
    const thinkingOptions: BackendModelDescriptor["thinkingOptions"] = reasoning
      ? ["low", "medium", "high"]
      : [];

    results.push({
      fullId,
      ...(provider ? { provider } : {}),
      modelId: rawId,
      descriptor: {
        id: fullId,
        label: typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : fullId,
        thinkingOptions,
      },
    });
  }
  return results;
}

function mergePiModels(
  discovered: readonly PiDiscoveredModel[],
  customModels: readonly string[],
): BackendModelDescriptor[] {
  const out = discovered.map((d) => ({
    ...d.descriptor,
    thinkingOptions: [...d.descriptor.thinkingOptions],
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

function extractPiRawUsage(rawUsage: unknown) {
  if (!rawUsage || typeof rawUsage !== "object") {
    return null;
  }
  const u = rawUsage as Record<string, unknown>;
  const costObj = u.cost as { total?: unknown } | undefined;
  const providerCost =
    typeof costObj?.total === "number" && Number.isFinite(costObj.total) && costObj.total >= 0
      ? costObj.total
      : undefined;

  return {
    inputTokens: typeof u.input === "number" ? u.input : undefined,
    cachedReadTokens: typeof u.cacheRead === "number" ? u.cacheRead : undefined,
    cacheWriteTokens: typeof u.cacheWrite === "number" ? u.cacheWrite : undefined,
    outputTokens: typeof u.output === "number" ? u.output : undefined,
    reasoningTokens: typeof u.reasoning === "number" ? u.reasoning : undefined,
    ...(providerCost !== undefined
      ? { providerCostUsd: providerCost, costSource: "provider_reported" as const }
      : {}),
  };
}

function stripConflictingPiFlags(baseArgs: readonly string[]): string[] {
  const cleaned: string[] = [];
  const skipWithVal = new Set(["--provider", "--model", "--thinking", "--tools"]);
  for (let i = 0; i < baseArgs.length; i++) {
    const arg = baseArgs[i]!;
    if (skipWithVal.has(arg)) {
      i += 1;
      continue;
    }
    if (arg === "--no-mcp") {
      continue;
    }
    cleaned.push(arg);
  }
  if (!cleaned.includes("--mode")) {
    cleaned.unshift("--mode", "rpc");
  }
  return cleaned;
}

/**
 * Direct `pi --mode rpc` JSONL adapter grounded on P2 probe findings.
 */
export class PiRpcBackend implements ProviderTelemetryBackend {
  readonly backendId: string;

  private readonly provider: ProviderEntry;
  private readonly healthTracker: ProviderHealthTracker | undefined;
  private readonly cancelTimeoutMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly spawnFn: SpawnProcessFn | undefined;
  private readonly probeOptions: ProbeCliBinaryOptions | undefined;

  private readonly sessions = new Map<string, PiSessionState>();
  private discoveredModels: PiDiscoveredModel[] | null = null;
  private disposed = false;

  constructor(options: PiRpcBackendOptions) {
    this.provider = options.provider;
    this.backendId = options.provider.id;
    this.healthTracker = options.healthTracker;
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.spawnFn = options.spawnFn;
    this.probeOptions = options.probeOptions;
  }

  private getBaseCommand(): string {
    return this.provider.command?.trim() || "pi";
  }

  async probeProvider(): Promise<ProviderProbeSnapshot> {
    this.assertNotDisposed();
    const command = this.getBaseCommand();
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
        capabilities: { ...PI_RPC_CAPABILITIES },
      };
    }

    const baseArgs = stripConflictingPiFlags(
      this.provider.args.length > 0 ? this.provider.args : ["--mode", "rpc"],
    );
    const probeArgs = baseArgs.includes("--no-session") ? baseArgs : [...baseArgs, "--no-session"];

    const proc = new StdioRpcProcess({
      command: binaryProbe.resolvedPath,
      args: probeArgs,
      cwd: process.cwd(),
      env,
      ...(this.spawnFn ? { spawnFn: this.spawnFn } : {}),
    });

    try {
      const modelsRes = await proc.request({ type: "get_available_models" }, undefined, {
        id: "probe-models",
        timeoutMs: 8_000,
      });
      this.discoveredModels = parsePiAvailableModels(modelsRes);
      const merged = mergePiModels(this.discoveredModels, this.provider.custom_models);

      this.healthTracker?.setAvailability(this.provider.id, {
        available: true,
        version: binaryProbe.version,
      });

      return {
        available: true,
        version: binaryProbe.version,
        modelsCount: merged.length,
        capabilities: { ...PI_RPC_CAPABILITIES },
        nativeQuota: null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.healthTracker?.setAvailability(this.provider.id, {
        available: false,
        version: binaryProbe.version,
        detail: msg,
      });
      return {
        available: false,
        version: binaryProbe.version,
        detail: msg,
        capabilities: { ...PI_RPC_CAPABILITIES },
      };
    } finally {
      await proc.close();
    }
  }

  async refreshProviders(): Promise<void> {
    await this.probeProvider();
  }

  async listAgents(): Promise<BackendAgentDescriptor[]> {
    this.assertNotDisposed();
    if (this.discoveredModels === null) {
      const command = this.getBaseCommand();
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
        capabilities: { ...PI_RPC_CAPABILITIES },
        modes: [],
        defaultModeId: null,
      },
    ];
  }

  async listModels(_agent: string): Promise<BackendModelDescriptor[]> {
    this.assertNotDisposed();
    if (this.discoveredModels === null) {
      const command = this.getBaseCommand();
      const env = buildProcessEnv(this.provider.env);
      if (resolveCliBinary(command, { env, ...(this.probeOptions ?? {}) })) {
        await this.probeProvider().catch(() => undefined);
      }
    }
    return mergePiModels(this.discoveredModels ?? [], this.provider.custom_models);
  }

  async capabilities(_agent: string): Promise<BackendCapabilities> {
    this.assertNotDisposed();
    return { ...PI_RPC_CAPABILITIES };
  }

  onApproval(_handler: ApprovalHandler): () => void {
    return () => {};
  }

  async answer(approvalId: string): Promise<void> {
    throw new Error(`PiRpcBackend does not support interactive approvals (${approvalId})`);
  }

  private buildSessionArgs(runSpec: BackendRunSpec, isReadOnly: boolean): string[] {
    const args = stripConflictingPiFlags(
      this.provider.args.length > 0 ? this.provider.args : ["--mode", "rpc"],
    );

    const matched = this.discoveredModels?.find(
      (m) => m.fullId === runSpec.model || m.modelId === runSpec.model,
    );
    if (matched?.provider) {
      args.push("--provider", matched.provider, "--model", matched.modelId);
    } else if (runSpec.model.includes("/")) {
      const slash = runSpec.model.indexOf("/");
      const prov = runSpec.model.slice(0, slash).trim();
      const mod = runSpec.model.slice(slash + 1).trim();
      if (prov && mod) {
        args.push("--provider", prov, "--model", mod);
      } else {
        args.push("--model", runSpec.model);
      }
    } else {
      args.push("--model", runSpec.model);
    }

    if (runSpec.reasoningEffort) {
      args.push("--thinking", runSpec.reasoningEffort);
    }

    if (isReadOnly) {
      args.push("--tools", "read,grep,find,ls", "--no-mcp");
    }

    return args;
  }

  async start(runSpec: BackendRunSpec): Promise<SessionRef> {
    this.assertNotDisposed();
    assertRoleAgentEligible(runSpec.role, this.provider.id, PI_RPC_CAPABILITIES);

    const isReadOnly = isReadOnlyRole(runSpec.role) || runSpec.readOnly === true;
    const command = this.getBaseCommand();
    const env = buildProcessEnv(this.provider.env, runSpec.env);
    const resolvedCmd = resolveCliBinary(command, { env, ...(this.probeOptions ?? {}) }) ?? command;
    const args = this.buildSessionArgs(runSpec, isReadOnly);

    const sessionId = `pi-${randomUUID()}`;
    const sessionRef: SessionRef = {
      backendId: this.backendId,
      sessionId,
      meta: {
        agent: this.provider.id,
      },
    };

    let session!: PiSessionState;
    const proc = new StdioRpcProcess({
      command: resolvedCmd,
      args,
      cwd: runSpec.cwd,
      env,
      ...(this.spawnFn ? { spawnFn: this.spawnFn } : {}),
      onMessage: (msg) => {
        if (session) {
          this.handleWireEvent(session, msg);
        }
      },
      onExit: (info) => {
        if (!session) return;
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
              turn.lastErrorMessage ??
              info.error?.message ??
              `Pi RPC exited unexpectedly (code=${info.code ?? "null"}, signal=${info.signal ?? "null"})`;
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
        env: runSpec.env ? { ...runSpec.env } : undefined,
      },
      isReadOnly,
      usageState: createProviderUsageNormalizerState(),
      status: "running",
      turnSeq: 0,
      currentTurn: null,
    };
    this.sessions.set(sessionId, session);

    try {
      const stateRes = (await proc.request({ type: "get_state" }, undefined, {
        id: `${sessionId}-state`,
        timeoutMs: this.rpcTimeoutMs,
      })) as { sessionId?: string; sessionFile?: string } | null;

      const providerSessionId = stateRes?.sessionId?.trim() || undefined;
      const providerSessionPath = stateRes?.sessionFile?.trim() || undefined;
      if (providerSessionId || providerSessionPath) {
        sessionRef.meta = {
          ...sessionRef.meta,
          ...(providerSessionId ? { providerSessionId } : {}),
          ...(providerSessionPath ? { providerSessionPath } : {}),
        };
      }

      const turn = this.beginTurn(session);
      if (providerSessionId || providerSessionPath) {
        turn.queue.push({
          kind: "session_bound",
          at: new Date().toISOString(),
          providerSessionId: providerSessionId ?? providerSessionPath!,
          ...(providerSessionPath ? { providerSessionPath } : {}),
        });
      }

      const initialPrompt = runSpec.systemPrompt
        ? `${runSpec.systemPrompt.trim()}\n\n${runSpec.prompt}`
        : runSpec.prompt;
      await proc.request({ type: "prompt", message: initialPrompt }, undefined, {
        id: `${sessionId}-prompt-1`,
        timeoutMs: this.rpcTimeoutMs,
      });
    } catch (err) {
      this.sessions.delete(sessionId);
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
      await session.proc.request({ type: "prompt", message }, undefined, {
        id: `${turn.turnId}-prompt`,
        timeoutMs: this.rpcTimeoutMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.finishTurnWithFailure(session, turn, msg);
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
    if (session.proc.isAlive) {
      void session.proc
        .request({ type: "abort" }, undefined, {
          id: `${turn.turnId}-abort`,
          timeoutMs: this.cancelTimeoutMs,
        })
        .catch(() => {});
    }

    const fallback = new Promise<void>((resolve) => {
      turn.cancelTimer = setTimeout(() => {
        turn.cancelTimer = null;
        if (!turn.queue.isFinished()) {
          void session.proc.close().finally(() => {
            if (!turn.queue.isFinished()) {
              turn.queue.emitExit("cancelled", "Cancelled (abort timeout)");
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
        ? session.currentTurn.turnId
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

  private beginTurn(session: PiSessionState): PiTurnState {
    session.turnSeq += 1;
    session.status = "running";
    const turn: PiTurnState = {
      turnId: `${session.sessionId}-turn-${session.turnSeq}`,
      queue: new TurnEventQueue(),
      cancelling: false,
      cancelTimer: null,
      lastErrorMessage: null,
      sawAssistantUsage: false,
    };
    session.currentTurn = turn;
    return turn;
  }

  private handleWireEvent(session: PiSessionState, msg: Record<string, unknown>): void {
    const turn = session.currentTurn;
    if (!turn || turn.queue.isFinished()) {
      return;
    }

    const type = typeof msg.type === "string" ? msg.type : "";
    const at = new Date().toISOString();

    switch (type) {
      case "message_update": {
        const inner = msg.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
        if (
          inner?.type === "text_delta" &&
          typeof inner.delta === "string" &&
          inner.delta.length > 0
        ) {
          turn.queue.push({ kind: "message", at, text: inner.delta, delta: true });
        } else if (inner?.type === "thinking_delta" || inner?.type === "thinking_start") {
          turn.queue.push({ kind: "thinking", at });
        }
        break;
      }
      case "tool_execution_start": {
        const toolName = typeof msg.toolName === "string" ? msg.toolName : "tool";
        const args = (msg.args && typeof msg.args === "object" ? msg.args : {}) as Record<
          string,
          unknown
        >;
        const target =
          typeof args.path === "string"
            ? args.path
            : typeof args.file_path === "string"
              ? args.file_path
              : typeof args.command === "string"
                ? args.command
                : undefined;
        turn.queue.push({
          kind: "tool",
          at,
          name: toolName,
          ...(target ? { target } : {}),
        });
        if (/write|edit/i.test(toolName) && typeof target === "string" && target.length > 0) {
          turn.queue.push({ kind: "file_write", at, path: target });
        }
        break;
      }
      case "message_end": {
        const message = msg.message as Record<string, unknown> | undefined;
        if (message?.role !== "assistant") {
          break;
        }
        if (message.stopReason === "error") {
          turn.lastErrorMessage =
            typeof message.errorMessage === "string" && message.errorMessage.trim()
              ? message.errorMessage.trim()
              : "Pi assistant turn failed";
        }
        const extracted = extractPiRawUsage(message.usage);
        if (extracted) {
          turn.sawAssistantUsage = true;
          accumulateMessageUsage(session.usageState, extracted);
        }
        break;
      }
      case "agent_end": {
        void this.finalizePiTurn(session, turn, msg);
        break;
      }
      default:
        break;
    }
  }

  private async finalizePiTurn(
    session: PiSessionState,
    turn: PiTurnState,
    agentEndMsg: Record<string, unknown>,
  ): Promise<void> {
    if (turn.queue.isFinished()) {
      return;
    }
    if (turn.cancelTimer) {
      clearTimeout(turn.cancelTimer);
      turn.cancelTimer = null;
    }
    const at = new Date().toISOString();

    // Fallback: if message_end was skipped by a custom stream, extract from agent_end.messages
    if (!turn.sawAssistantUsage && Array.isArray(agentEndMsg.messages)) {
      for (const m of agentEndMsg.messages) {
        if (!m || typeof m !== "object") continue;
        const msgObj = m as Record<string, unknown>;
        if (msgObj.role !== "assistant") continue;
        if (msgObj.stopReason === "error" && !turn.lastErrorMessage) {
          turn.lastErrorMessage =
            typeof msgObj.errorMessage === "string" && msgObj.errorMessage.trim()
              ? msgObj.errorMessage.trim()
              : "Pi assistant turn failed";
        }
        const raw = extractPiRawUsage(msgObj.usage);
        if (raw) {
          accumulateMessageUsage(session.usageState, raw);
        }
      }
    }

    if (!turn.cancelling && session.proc.isAlive) {
      try {
        const stats = (await session.proc.request({ type: "get_session_stats" }, undefined, {
          id: `${turn.turnId}-stats`,
          timeoutMs: 2_000,
        })) as {
          contextUsage?: { tokens?: unknown; contextWindow?: unknown } | null;
        } | null;
        const cu = stats?.contextUsage;
        if (
          cu &&
          typeof cu.tokens === "number" &&
          Number.isFinite(cu.tokens) &&
          typeof cu.contextWindow === "number" &&
          cu.contextWindow > 0
        ) {
          turn.queue.push(createContextWindowEvent(cu.tokens, cu.contextWindow, at));
        }
      } catch {
        // Best-effort live context window telemetry; never fail the turn.
      }
    }

    const rule = resolveProviderUsageRule(
      this.provider.id,
      this.provider.usage_rule ?? DEFAULT_PROVIDER_USAGE_RULES.pi,
    );
    const flushed = flushAccumulatedTurnUsage(session.usageState, {
      provider: this.provider.id,
      model: session.runSpec.model,
      agentId: this.provider.id,
      rule,
      candidateTurnIds: [turn.turnId],
    });
    if (flushed) {
      turn.queue.push({ kind: "usage", at, ...flushed });
    } else if (agentEndMsg.usage && typeof agentEndMsg.usage === "object") {
      const raw = extractPiRawUsage(agentEndMsg.usage);
      const fallbackUsage = normalizeProviderTurnUsage({
        provider: this.provider.id,
        model: session.runSpec.model,
        agentId: this.provider.id,
        raw,
        rule,
        state: session.usageState,
        candidateTurnIds: [turn.turnId],
      });
      if (fallbackUsage) {
        turn.queue.push({ kind: "usage", at, ...fallbackUsage });
      }
    }

    if (turn.cancelling) {
      session.status = "idle";
      turn.queue.emitExit("cancelled", "Aborted");
      return;
    }

    if (turn.lastErrorMessage) {
      this.finishTurnWithFailure(session, turn, turn.lastErrorMessage);
      return;
    }

    session.status = "idle";
    turn.queue.emitExit("completed");
  }

  private finishTurnWithFailure(session: PiSessionState, turn: PiTurnState, detail: string): void {
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

  private requireSession(sessionRef: SessionRef): PiSessionState {
    if (sessionRef.backendId !== this.backendId) {
      throw new Error(
        `Session backendId mismatch: expected "${this.backendId}", got "${sessionRef.backendId}"`,
      );
    }
    const session = this.sessions.get(sessionRef.sessionId);
    if (!session) {
      throw new Error(`Unknown Pi session "${sessionRef.sessionId}"`);
    }
    return session;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error(`PiRpcBackend "${this.backendId}" has been disposed`);
    }
  }
}
