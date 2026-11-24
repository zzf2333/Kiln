import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  type BackendModeDescriptor,
  type BackendModelDescriptor,
  type BackendRunSpec,
  type ProviderProbeSnapshot,
  type ProviderTelemetryBackend,
  type SessionProbeResult,
} from "./types.js";
import {
  DEFAULT_PROVIDER_USAGE_RULES,
  createProviderUsageNormalizerState,
  normalizeProviderTurnUsage,
  resolveProviderUsageRule,
  type ProviderUsageNormalizerState,
} from "./usage-normalizer.js";

const DEFAULT_CANCEL_TIMEOUT_MS = 3_000;

export const CLAUDE_DIRECT_CAPABILITIES: BackendCapabilities = {
  interactiveChat: true,
  approvals: false,
  mcpInjection: true,
  usageCacheBreakdown: true,
  interrupt: true,
  imageInput: true,
  cacheWriteTelemetry: true,
  contextWindowTelemetry: false,
  nativeQuotaWindow: false,
  readOnlySandbox: true,
  warmSessionReuse: true,
};

const CLAUDE_MODES: readonly BackendModeDescriptor[] = [
  { id: "plan", label: "Plan (read-only)" },
  { id: "acceptEdits", label: "Accept edits" },
];

const DEFAULT_CLAUDE_MODELS: readonly BackendModelDescriptor[] = [
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    thinkingOptions: ["low", "medium", "high"],
  },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", thinkingOptions: ["low", "medium", "high"] },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", thinkingOptions: ["low", "medium", "high"] },
];

export interface ClaudeDirectBackendOptions {
  provider: ProviderEntry;
  healthTracker?: ProviderHealthTracker;
  cancelTimeoutMs?: number;
  spawnFn?: SpawnProcessFn;
  probeOptions?: ProbeCliBinaryOptions;
}

interface ClaudeTurnState {
  turnId: string;
  queue: TurnEventQueue;
  cancelling: boolean;
  cancelTimer: ReturnType<typeof setTimeout> | null;
}

interface ClaudeSessionState {
  sessionId: string;
  providerSessionId: string | null;
  sessionRef: SessionRef;
  proc: StdioRpcProcess;
  runSpec: BackendRunSpec;
  isReadOnly: boolean;
  resolvedCommand: string;
  mcpConfigPath: string | null;
  usageState: ProviderUsageNormalizerState;
  status: "running" | "idle" | "closed";
  turnSeq: number;
  currentTurn: ClaudeTurnState | null;
}

function buildProcessEnv(
  providerEnv?: Record<string, string>,
  runEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  return buildAgentCliEnv(providerEnv, runEnv);
}

function mergeCustomModels(
  base: readonly BackendModelDescriptor[],
  customModels: readonly string[],
): BackendModelDescriptor[] {
  const out = base.map((m) => ({ ...m, thinkingOptions: [...m.thinkingOptions] }));
  const seen = new Set(out.map((m) => m.id));
  for (const raw of customModels) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: id, thinkingOptions: [] });
  }
  return out;
}

function stripConflictingClaudeFlags(baseArgs: readonly string[]): string[] {
  const cleaned: string[] = [];
  const skipWithVal = new Set(["--permission-mode", "--model", "--mcp-config", "--resume"]);
  for (let i = 0; i < baseArgs.length; i++) {
    const arg = baseArgs[i]!;
    if (skipWithVal.has(arg)) {
      i += 1;
      continue;
    }
    cleaned.push(arg);
  }
  if (!cleaned.includes("-p") && !cleaned.includes("--print")) {
    cleaned.push("-p");
  }
  if (!cleaned.includes("--output-format")) {
    cleaned.push("--output-format", "stream-json");
  }
  if (!cleaned.includes("--input-format")) {
    cleaned.push("--input-format", "stream-json");
  }
  if (!cleaned.includes("--verbose")) {
    cleaned.push("--verbose");
  }
  return cleaned;
}

/**
 * Fallback direct `claude -p --output-format stream-json --input-format stream-json` adapter
 * when `claude-agent-acp` is not installed (P4 contract).
 */
export class ClaudeDirectBackend implements ProviderTelemetryBackend {
  readonly backendId: string;

  private readonly provider: ProviderEntry;
  private readonly healthTracker: ProviderHealthTracker | undefined;
  private readonly cancelTimeoutMs: number;
  private readonly spawnFn: SpawnProcessFn | undefined;
  private readonly probeOptions: ProbeCliBinaryOptions | undefined;

  private readonly sessions = new Map<string, ClaudeSessionState>();
  private disposed = false;

  constructor(options: ClaudeDirectBackendOptions) {
    this.provider = options.provider;
    this.backendId = options.provider.id;
    this.healthTracker = options.healthTracker;
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
    this.spawnFn = options.spawnFn;
    this.probeOptions = options.probeOptions;
  }

  private getBaseCommand(): string {
    return this.provider.command?.trim() || "claude";
  }

  async probeProvider(): Promise<ProviderProbeSnapshot> {
    this.assertNotDisposed();
    const command = this.getBaseCommand();
    const env = buildProcessEnv(this.provider.env);
    const probe = await probeCliBinary(command, {
      env,
      ...(this.probeOptions ?? {}),
    });

    if (!probe.available || !probe.resolvedPath) {
      this.healthTracker?.setAvailability(this.provider.id, {
        available: false,
        version: null,
        detail: probe.detail ?? `Command "${command}" not found`,
      });
      return {
        available: false,
        version: null,
        detail: probe.detail ?? `Command "${command}" not found`,
        capabilities: { ...CLAUDE_DIRECT_CAPABILITIES },
      };
    }

    this.healthTracker?.setAvailability(this.provider.id, {
      available: true,
      version: probe.version,
    });
    const models = mergeCustomModels(DEFAULT_CLAUDE_MODELS, this.provider.custom_models);
    return {
      available: true,
      version: probe.version,
      modelsCount: models.length,
      capabilities: { ...CLAUDE_DIRECT_CAPABILITIES },
      nativeQuota: null,
    };
  }

  async refreshProviders(): Promise<void> {
    await this.probeProvider();
  }

  async listAgents(): Promise<BackendAgentDescriptor[]> {
    this.assertNotDisposed();
    const probe = await this.probeProvider();
    if (!probe.available) {
      return [];
    }
    return [
      {
        id: this.provider.id,
        label: this.provider.label,
        capabilities: { ...CLAUDE_DIRECT_CAPABILITIES },
        modes: CLAUDE_MODES.map((m) => ({ ...m })),
        defaultModeId: "acceptEdits",
      },
    ];
  }

  async listModels(_agent: string): Promise<BackendModelDescriptor[]> {
    this.assertNotDisposed();
    return mergeCustomModels(DEFAULT_CLAUDE_MODELS, this.provider.custom_models);
  }

  async capabilities(_agent: string): Promise<BackendCapabilities> {
    this.assertNotDisposed();
    return { ...CLAUDE_DIRECT_CAPABILITIES };
  }

  onApproval(_handler: ApprovalHandler): () => void {
    return () => {};
  }

  async answer(approvalId: string): Promise<void> {
    throw new Error(`ClaudeDirectBackend does not support interactive approvals (${approvalId})`);
  }

  private writeTempMcpConfig(runSpec: BackendRunSpec): string | null {
    if (!runSpec.mcpServers || runSpec.mcpServers.length === 0) {
      return null;
    }
    const mcpServers: Record<
      string,
      { command: string; args: string[]; env?: Record<string, string> }
    > = {};
    for (const s of runSpec.mcpServers) {
      mcpServers[s.name] = {
        command: s.command,
        args: [...(s.args ?? [])],
        ...(s.env ? { env: { ...s.env } } : {}),
      };
    }
    const filePath = path.join(os.tmpdir(), `kiln-claude-mcp-${randomUUID()}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
    return filePath;
  }

  private removeTempMcpConfig(filePath: string | null): void {
    if (!filePath) return;
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }

  private buildArgs(
    runSpec: BackendRunSpec,
    isReadOnly: boolean,
    mcpConfigPath: string | null,
    resumeSessionId: string | null,
  ): string[] {
    const args = stripConflictingClaudeFlags(this.provider.args);
    args.push("--model", runSpec.model);
    args.push("--permission-mode", isReadOnly ? "plan" : "acceptEdits");
    if (mcpConfigPath) {
      args.push("--mcp-config", mcpConfigPath);
    }
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }
    return args;
  }

  private spawnClaudeProcess(
    session: ClaudeSessionState,
    resolvedCommand: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): StdioRpcProcess {
    return new StdioRpcProcess({
      command: resolvedCommand,
      args,
      cwd: session.runSpec.cwd,
      env,
      ...(this.spawnFn ? { spawnFn: this.spawnFn } : {}),
      onMessage: (msg) => {
        this.handleStreamMessage(session, msg);
      },
      onExit: (info) => {
        const turn = session.currentTurn;
        if (turn && !turn.queue.isFinished()) {
          if (turn.cancelTimer) {
            clearTimeout(turn.cancelTimer);
            turn.cancelTimer = null;
          }
          if (turn.cancelling) {
            session.status = "closed";
            this.removeTempMcpConfig(session.mcpConfigPath);
            session.mcpConfigPath = null;
            turn.queue.emitExit("cancelled", "Cancelled");
          } else {
            const detail =
              info.error?.message ??
              `Claude CLI exited before emitting result (code=${info.code ?? "null"}, signal=${info.signal ?? "null"})`;
            session.status = "closed";
            this.removeTempMcpConfig(session.mcpConfigPath);
            session.mcpConfigPath = null;
            turn.queue.emitExit("failed", detail);
          }
        }
      },
    });
  }

  async start(runSpec: BackendRunSpec): Promise<SessionRef> {
    this.assertNotDisposed();
    assertRoleAgentEligible(runSpec.role, this.provider.id, CLAUDE_DIRECT_CAPABILITIES);

    const isReadOnly = isReadOnlyRole(runSpec.role) || runSpec.readOnly === true;
    const command = this.getBaseCommand();
    const env = buildProcessEnv(this.provider.env, runSpec.env);
    const resolvedCommand =
      resolveCliBinary(command, { env, ...(this.probeOptions ?? {}) }) ?? command;

    const mcpConfigPath = this.writeTempMcpConfig(runSpec);
    const sessionId = `claude-${randomUUID()}`;
    const sessionRef: SessionRef = {
      backendId: this.backendId,
      sessionId,
      meta: {
        agent: this.provider.id,
        modeId: isReadOnly ? "plan" : "acceptEdits",
      },
    };

    const session: ClaudeSessionState = {
      sessionId,
      providerSessionId: null,
      sessionRef,
      proc: null as unknown as StdioRpcProcess,
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
      resolvedCommand,
      mcpConfigPath,
      usageState: createProviderUsageNormalizerState(),
      status: "running",
      turnSeq: 0,
      currentTurn: null,
    };

    try {
      const args = this.buildArgs(runSpec, isReadOnly, mcpConfigPath, null);
      session.proc = this.spawnClaudeProcess(session, resolvedCommand, args, env);
      this.sessions.set(sessionId, session);

      const turn = this.beginTurn(session);
      const initialPrompt = runSpec.systemPrompt
        ? `${runSpec.systemPrompt.trim()}\n\n${runSpec.prompt}`
        : runSpec.prompt;
      session.proc.send({
        type: "user",
        message: { role: "user", content: initialPrompt },
      });
      void turn;
    } catch (err) {
      this.sessions.delete(sessionId);
      this.removeTempMcpConfig(mcpConfigPath);
      await session.proc?.close?.().catch(() => {});
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
    if (session.status === "closed") {
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
      if (!session.proc.isAlive) {
        const env = buildProcessEnv(this.provider.env, session.runSpec.env);
        if (!session.mcpConfigPath && session.runSpec.mcpServers?.length) {
          session.mcpConfigPath = this.writeTempMcpConfig(session.runSpec);
        }
        const args = this.buildArgs(
          session.runSpec,
          session.isReadOnly,
          session.mcpConfigPath,
          session.providerSessionId,
        );
        session.proc = this.spawnClaudeProcess(session, session.resolvedCommand, args, env);
      }

      session.proc.send({
        type: "user",
        message: { role: "user", content: message },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      session.status = "idle";
      turn.queue.emitExit("failed", detail);
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
    await session.proc.close(this.cancelTimeoutMs);
    this.removeTempMcpConfig(session.mcpConfigPath);
    session.mcpConfigPath = null;
    if (!turn.queue.isFinished()) {
      turn.queue.emitExit("cancelled", "Cancelled");
    }
    session.status = "closed";
  }

  async probe(sessionRef: SessionRef): Promise<SessionProbeResult> {
    const session = this.requireSession(sessionRef);
    const activeTurnId =
      session.currentTurn && !session.currentTurn.queue.isFinished()
        ? session.currentTurn.turnId
        : null;
    return {
      alive: session.status !== "closed",
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
        this.removeTempMcpConfig(session.mcpConfigPath);
        session.mcpConfigPath = null;
        await session.proc.close();
      }),
    );
  }

  private beginTurn(session: ClaudeSessionState): ClaudeTurnState {
    session.turnSeq += 1;
    session.status = "running";
    const turn: ClaudeTurnState = {
      turnId: `${session.sessionId}-turn-${session.turnSeq}`,
      queue: new TurnEventQueue(),
      cancelling: false,
      cancelTimer: null,
    };
    session.currentTurn = turn;
    return turn;
  }

  private handleStreamMessage(session: ClaudeSessionState, msg: Record<string, unknown>): void {
    const turn = session.currentTurn;
    if (!turn || turn.queue.isFinished()) {
      return;
    }

    const type = typeof msg.type === "string" ? msg.type : "";
    const at = new Date().toISOString();

    if (type === "system") {
      const sid = typeof msg.session_id === "string" ? msg.session_id.trim() : "";
      if (sid && sid !== session.providerSessionId) {
        session.providerSessionId = sid;
        session.sessionRef.meta = {
          ...(session.sessionRef.meta ?? {}),
          providerSessionId: sid,
        };
        turn.queue.push({
          kind: "session_bound",
          at,
          providerSessionId: sid,
        });
      }
      return;
    }

    if (type === "assistant") {
      const message = msg.message as { content?: unknown } | undefined;
      const blocks = Array.isArray(message?.content) ? message.content : [];
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
          turn.queue.push({ kind: "message", at, text: b.text, delta: true });
        } else if (b.type === "thinking") {
          turn.queue.push({ kind: "thinking", at });
        } else if (b.type === "tool_use") {
          const name = typeof b.name === "string" ? b.name : "tool";
          const input = (b.input && typeof b.input === "object" ? b.input : {}) as Record<
            string,
            unknown
          >;
          const target =
            typeof input.file_path === "string"
              ? input.file_path
              : typeof input.path === "string"
                ? input.path
                : typeof input.command === "string"
                  ? input.command
                  : undefined;
          turn.queue.push({
            kind: "tool",
            at,
            name,
            ...(target ? { target } : {}),
          });
          if (/^(Write|Edit|MultiEdit)$/i.test(name) && target) {
            turn.queue.push({ kind: "file_write", at, path: target });
          }
        }
      }
      return;
    }

    if (type === "result") {
      const sid = typeof msg.session_id === "string" ? msg.session_id.trim() : "";
      if (sid && sid !== session.providerSessionId) {
        session.providerSessionId = sid;
        session.sessionRef.meta = {
          ...(session.sessionRef.meta ?? {}),
          providerSessionId: sid,
        };
        turn.queue.push({
          kind: "session_bound",
          at,
          providerSessionId: sid,
        });
      }

      const usage = msg.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage === "object") {
        const providerCost =
          typeof msg.total_cost_usd === "number" &&
          Number.isFinite(msg.total_cost_usd) &&
          msg.total_cost_usd >= 0
            ? msg.total_cost_usd
            : undefined;
        const rule = resolveProviderUsageRule(
          this.provider.id,
          this.provider.usage_rule ?? DEFAULT_PROVIDER_USAGE_RULES.claude,
        );
        const normalized = normalizeProviderTurnUsage({
          provider: this.provider.id,
          model: session.runSpec.model,
          agentId: this.provider.id,
          raw: {
            inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
            cachedReadTokens:
              typeof usage.cache_read_input_tokens === "number"
                ? usage.cache_read_input_tokens
                : undefined,
            cacheWriteTokens:
              typeof usage.cache_creation_input_tokens === "number"
                ? usage.cache_creation_input_tokens
                : undefined,
            outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
            ...(providerCost !== undefined
              ? { providerCostUsd: providerCost, costSource: "provider_reported" as const }
              : {}),
          },
          rule,
          state: session.usageState,
          candidateTurnIds: [turn.turnId],
        });
        if (normalized) {
          turn.queue.push({ kind: "usage", at, ...normalized });
        }
      }

      if (turn.cancelling) {
        session.status = "idle";
        turn.queue.emitExit("cancelled", "Cancelled");
        return;
      }

      const isError = msg.is_error === true || msg.subtype === "error_during_execution";
      if (isError) {
        const errDetail =
          typeof msg.result === "string" && msg.result.trim().length > 0
            ? msg.result.trim()
            : Array.isArray(msg.errors) && msg.errors.length > 0
              ? String(msg.errors[0])
              : "Claude turn failed";
        if (isRateLimitMessage(errDetail)) {
          const retryAfterSec = extractRetryAfterSec(errDetail);
          const until = this.healthTracker?.recordRateLimit(this.provider.id, {
            ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
            detail: errDetail,
          });
          turn.queue.push({
            kind: "rate_limited",
            at,
            provider: this.provider.id,
            ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
            ...(until !== undefined ? { until } : {}),
            detail: errDetail,
          });
        }
        session.status = "idle";
        turn.queue.emitExit("failed", errDetail);
        return;
      }

      session.status = "idle";
      turn.queue.emitExit("completed");
    }
  }

  private requireSession(sessionRef: SessionRef): ClaudeSessionState {
    if (sessionRef.backendId !== this.backendId) {
      throw new Error(
        `Session backendId mismatch: expected "${this.backendId}", got "${sessionRef.backendId}"`,
      );
    }
    const session = this.sessions.get(sessionRef.sessionId);
    if (!session) {
      throw new Error(`Unknown Claude session "${sessionRef.sessionId}"`);
    }
    return session;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error(`ClaudeDirectBackend "${this.backendId}" has been disposed`);
    }
  }
}
