import {
  type BackendCapabilities,
  type RoleId,
  type RunEvent,
  RunEventSchema,
  RunUsageSchema,
  type SessionRef,
} from "@kiln/protocol";
import {
  type ApprovalHandler,
  type ApprovalRequestEvent,
  assertRoleAgentEligible,
  type BackendAgentDescriptor,
  type BackendModelDescriptor,
  type BackendRunSpec,
  type ExecutionBackend,
  selectSafeModeId,
  type SessionProbeResult,
} from "./types.js";

export type FakeScriptStep =
  | { kind: "thinking"; delayMs?: number }
  | { kind: "message"; text: string; delta?: boolean; delayMs?: number }
  | { kind: "tool"; name: string; target?: string; delayMs?: number }
  | { kind: "file_write"; path: string; delayMs?: number }
  | {
      kind: "approval";
      action: string;
      detail: string;
      onDenyExitReason?: "failed" | "cancelled";
      onDenyDetail?: string;
    }
  | {
      kind: "usage";
      turnId?: string;
      inputTokens: number;
      cachedInputTokens?: number;
      outputTokens: number;
      delayMs?: number;
    }
  | { kind: "wait_for_cancel" }
  | { kind: "exit"; reason: "completed" | "cancelled" | "failed"; detail?: string };

export type FakeTurnScript = readonly FakeScriptStep[];

export interface FakeTurnMatchContext {
  runSpec: BackendRunSpec;
  sessionRef: SessionRef;
  turnNumber: number;
  message: string;
}

export interface FakeScriptMatcher {
  taskId?: string;
  runId?: string;
  role?: RoleId;
  agent?: string;
  model?: string;
  turnNumber?: number;
  message?: string | RegExp;
}

export type FakeTurnMatcher =
  | FakeScriptMatcher
  | ((ctx: FakeTurnMatchContext) => boolean);

export interface FakeBackendOptions {
  backendId?: string;
  agents?: BackendAgentDescriptor[];
  models?: Record<string, BackendModelDescriptor[]>;
  defaultTurnScript?: FakeTurnScript;
  turnScripts?: FakeTurnScript[];
  liveViewBaseUrl?: string | null;
}

interface QueuedScriptEntry {
  script: FakeTurnScript;
  matcher?: FakeTurnMatcher;
}

interface PendingApproval {
  id: string;
  sessionId: string;
  turnId: string;
  resolve: (decision: { allow: boolean; message?: string }) => void;
}

interface TurnState {
  turnId: string;
  turnNumber: number;
  events: RunEvent[];
  finished: boolean;
  waiters: Set<() => void>;
  abortController: AbortController;
  completionPromise: Promise<void>;
}

interface SessionState {
  sessionRef: SessionRef;
  runSpec: BackendRunSpec;
  selectedModeId: string | undefined;
  status: "running" | "idle" | "closed";
  activeTurnId: string | null;
  turnSeq: number;
  currentTurn: TurnState | null;
}

const DEFAULT_AGENTS: readonly BackendAgentDescriptor[] = [
  {
    id: "codex",
    label: "Codex",
    capabilities: {
      interactiveChat: true,
      approvals: true,
      mcpInjection: true,
      usageCacheBreakdown: true,
      interrupt: true,
    },
    modes: [
      { id: "auto", label: "Default Permissions" },
      { id: "auto-review", label: "Auto-review" },
      { id: "full-access", label: "Full Access", isFullAccess: true },
    ],
    defaultModeId: "auto-review",
  },
  {
    id: "pi",
    label: "Pi",
    capabilities: {
      interactiveChat: true,
      approvals: false,
      mcpInjection: false,
      usageCacheBreakdown: true,
      interrupt: true,
    },
    modes: [],
    defaultModeId: null,
  },
  {
    id: "antigravity-full-only",
    label: "Antigravity (full-access only)",
    capabilities: {
      interactiveChat: true,
      approvals: false,
      mcpInjection: true,
      usageCacheBreakdown: false,
      interrupt: true,
    },
    modes: [{ id: "full-access", label: "Full access", isFullAccess: true }],
    defaultModeId: "full-access",
  },
];

const DEFAULT_MODELS: Record<string, readonly BackendModelDescriptor[]> = {
  codex: [
    {
      id: "gpt-6-luna",
      label: "GPT-6 Luna",
      thinkingOptions: ["low", "medium", "high", "xhigh", "max"],
      defaultThinkingOptionId: "high",
    },
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      thinkingOptions: ["low", "medium", "high", "xhigh"],
      defaultThinkingOptionId: "high",
    },
  ],
  pi: [
    {
      id: "magpie/group/fast",
      label: "Magpie Fast",
      thinkingOptions: ["low"],
      defaultThinkingOptionId: "low",
    },
    {
      id: "magpie/group/work",
      label: "Magpie Work",
      thinkingOptions: ["low", "medium", "high"],
      defaultThinkingOptionId: "high",
    },
  ],
  "antigravity-full-only": [
    {
      id: "gemini-3-pro",
      label: "Gemini 3 Pro",
      thinkingOptions: ["low", "medium", "high"],
      defaultThinkingOptionId: "medium",
    },
  ],
};

const DEFAULT_TURN_SCRIPT: FakeTurnScript = [
  { kind: "thinking" },
  { kind: "message", text: "Completed deterministic turn.", delta: false },
  { kind: "usage", inputTokens: 120, cachedInputTokens: 20, outputTokens: 30 },
  { kind: "exit", reason: "completed" },
];

function cloneAgent(agent: BackendAgentDescriptor): BackendAgentDescriptor {
  return {
    ...agent,
    capabilities: { ...agent.capabilities },
    modes: agent.modes.map((mode) => ({ ...mode })),
  };
}

function cloneModel(model: BackendModelDescriptor): BackendModelDescriptor {
  return {
    ...model,
    thinkingOptions: [...model.thinkingOptions],
  };
}

function cloneRunSpec(spec: BackendRunSpec): BackendRunSpec {
  return {
    ...spec,
    mcpServers: spec.mcpServers?.map((server) => ({
      ...server,
      args: server.args ? [...server.args] : undefined,
      env: server.env ? { ...server.env } : undefined,
    })),
    env: spec.env ? { ...spec.env } : undefined,
  };
}

function cloneSessionRef(ref: SessionRef): SessionRef {
  return {
    backendId: ref.backendId,
    sessionId: ref.sessionId,
    ...(ref.meta ? { meta: { ...ref.meta } } : {}),
  };
}

function matchesScript(matcher: FakeTurnMatcher, ctx: FakeTurnMatchContext): boolean {
  if (typeof matcher === "function") {
    return matcher(ctx);
  }
  if (matcher.taskId !== undefined && matcher.taskId !== ctx.runSpec.taskId) {
    return false;
  }
  if (matcher.runId !== undefined && matcher.runId !== ctx.runSpec.runId) {
    return false;
  }
  if (matcher.role !== undefined && matcher.role !== ctx.runSpec.role) {
    return false;
  }
  if (matcher.agent !== undefined && matcher.agent !== ctx.runSpec.agent) {
    return false;
  }
  if (matcher.model !== undefined && matcher.model !== ctx.runSpec.model) {
    return false;
  }
  if (matcher.turnNumber !== undefined && matcher.turnNumber !== ctx.turnNumber) {
    return false;
  }
  if (matcher.message !== undefined) {
    if (typeof matcher.message === "string") {
      if (matcher.message !== ctx.message) {
        return false;
      }
    } else if (!matcher.message.test(ctx.message)) {
      return false;
    }
  }
  return true;
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Deterministic script-driven ExecutionBackend for zero-token unit, concurrency, and contract testing.
 */
export class FakeBackend implements ExecutionBackend {
  readonly backendId: string;

  private readonly agents = new Map<string, BackendAgentDescriptor>();
  private readonly models = new Map<string, BackendModelDescriptor[]>();
  private readonly defaultTurnScript: FakeTurnScript;
  private readonly scriptQueue: QueuedScriptEntry[] = [];
  private readonly liveViewBaseUrl: string | null;

  private readonly sessions = new Map<string, SessionState>();
  private readonly approvalHandlers = new Set<ApprovalHandler>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly recordedSpecs: BackendRunSpec[] = [];

  private sessionSeq = 0;
  private approvalSeq = 0;
  private disposed = false;

  constructor(options?: FakeBackendOptions) {
    this.backendId = options?.backendId ?? "fake";
    this.liveViewBaseUrl = options?.liveViewBaseUrl ?? null;
    this.defaultTurnScript = options?.defaultTurnScript ?? DEFAULT_TURN_SCRIPT;

    const agentList = options?.agents ?? DEFAULT_AGENTS;
    for (const agent of agentList) {
      this.agents.set(agent.id, cloneAgent(agent));
      const configuredModels = options?.models?.[agent.id] ?? DEFAULT_MODELS[agent.id] ?? [];
      this.models.set(agent.id, configuredModels.map(cloneModel));
    }

    if (options?.turnScripts) {
      for (const script of options.turnScripts) {
        this.scriptQueue.push({ script: [...script] });
      }
    }
  }

  enqueueScript(script: FakeTurnScript, matcher?: FakeTurnMatcher): void {
    this.scriptQueue.push({
      script: [...script],
      ...(matcher !== undefined ? { matcher } : {}),
    });
  }

  getRecordedSpecs(): readonly BackendRunSpec[] {
    return this.recordedSpecs.map(cloneRunSpec);
  }

  getSelectedModeId(sessionRef: SessionRef): string | undefined {
    const session = this.requireSession(sessionRef);
    return session.selectedModeId;
  }

  async listAgents(): Promise<BackendAgentDescriptor[]> {
    return Array.from(this.agents.values(), cloneAgent);
  }

  async listModels(agent: string): Promise<BackendModelDescriptor[]> {
    this.requireAgent(agent);
    return (this.models.get(agent) ?? []).map(cloneModel);
  }

  async capabilities(agent: string): Promise<BackendCapabilities> {
    return { ...this.requireAgent(agent).capabilities };
  }

  async start(runSpec: BackendRunSpec): Promise<SessionRef> {
    this.assertNotDisposed();
    const agentDesc = this.requireAgent(runSpec.agent);
    assertRoleAgentEligible(runSpec.role, runSpec.agent, agentDesc.capabilities);
    const selectedModeId = selectSafeModeId(runSpec.agent, agentDesc.modes, {
      allowFullAccessFallback: runSpec.allowFullAccessFallback,
    });

    const specCopy = cloneRunSpec(runSpec);
    this.recordedSpecs.push(specCopy);

    const sessionId = `${this.backendId}-session-${++this.sessionSeq}`;
    const meta: Record<string, string> = {
      agent: runSpec.agent,
      ...(selectedModeId !== undefined ? { modeId: selectedModeId } : {}),
    };

    const sessionRef: SessionRef = {
      backendId: this.backendId,
      sessionId,
      meta,
    };

    const session: SessionState = {
      sessionRef,
      runSpec: specCopy,
      selectedModeId,
      status: "running",
      activeTurnId: null,
      turnSeq: 0,
      currentTurn: null,
    };
    this.sessions.set(sessionId, session);

    this.launchTurn(session, runSpec.prompt);
    return cloneSessionRef(sessionRef);
  }

  async send(sessionRef: SessionRef, message: string): Promise<void> {
    this.assertNotDisposed();
    const session = this.requireSession(sessionRef);
    if (session.status === "closed") {
      throw new Error(`Session "${session.sessionRef.sessionId}" is closed`);
    }
    if (session.status === "running" && session.currentTurn && !session.currentTurn.finished) {
      throw new Error(
        `Session "${session.sessionRef.sessionId}" already has an active turn "${session.activeTurnId}"`,
      );
    }

    this.launchTurn(session, message);
  }

  async *events(sessionRef: SessionRef): AsyncIterable<RunEvent> {
    const session = this.requireSession(sessionRef);
    const turn = session.currentTurn;
    if (!turn) {
      return;
    }

    let index = 0;
    while (true) {
      while (index < turn.events.length) {
        const event = turn.events[index]!;
        index += 1;
        yield event;
        if (event.kind === "exit") {
          return;
        }
      }
      if (turn.finished) {
        return;
      }
      let wakeWaiter: (() => void) | undefined;
      try {
        await new Promise<void>((resolve) => {
          wakeWaiter = resolve;
          turn.waiters.add(resolve);
        });
      } finally {
        if (wakeWaiter) {
          turn.waiters.delete(wakeWaiter);
        }
      }
    }
  }

  onApproval(handler: ApprovalHandler): () => void {
    this.approvalHandlers.add(handler);
    return () => {
      this.approvalHandlers.delete(handler);
    };
  }

  async answer(approvalId: string, allow: boolean, message?: string): Promise<void> {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      throw new Error(`Unknown or already resolved approval "${approvalId}"`);
    }
    this.pendingApprovals.delete(approvalId);
    pending.resolve({ allow, ...(message !== undefined ? { message } : {}) });
  }

  async cancel(sessionRef: SessionRef): Promise<void> {
    const session = this.requireSession(sessionRef);
    const turn = session.currentTurn;
    if (!turn || turn.finished) {
      if (session.status === "running") {
        session.status = "idle";
        session.activeTurnId = null;
      }
      return;
    }

    this.clearTurnPendingApprovals(turn.turnId);
    turn.abortController.abort();
    this.emitExit(session, turn, {
      kind: "exit",
      at: new Date().toISOString(),
      reason: "cancelled",
    });
    await turn.completionPromise;
  }

  async probe(sessionRef: SessionRef): Promise<SessionProbeResult> {
    const session = this.requireSession(sessionRef);
    return {
      alive: session.status !== "closed",
      status: session.status,
      activeTurnId: session.activeTurnId,
    };
  }

  async liveViewUrl(sessionRef: SessionRef): Promise<string | null> {
    const session = this.requireSession(sessionRef);
    if (!this.liveViewBaseUrl) {
      return null;
    }
    return `${this.liveViewBaseUrl.replace(/\/$/, "")}/${session.sessionRef.sessionId}`;
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    const completions: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      const turn = session.currentTurn;
      if (turn && !turn.finished) {
        this.clearTurnPendingApprovals(turn.turnId);
        turn.abortController.abort();
        this.emitExit(session, turn, {
          kind: "exit",
          at: new Date().toISOString(),
          reason: "cancelled",
          detail: "Backend disposed",
        });
        completions.push(turn.completionPromise);
      }
      session.status = "closed";
      session.activeTurnId = null;
    }

    this.pendingApprovals.clear();
    this.approvalHandlers.clear();
    await Promise.allSettled(completions);
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error(`FakeBackend "${this.backendId}" has been disposed`);
    }
  }

  private requireAgent(agentId: string): BackendAgentDescriptor {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent "${agentId}" for backend "${this.backendId}"`);
    }
    return agent;
  }

  private requireSession(sessionRef: SessionRef): SessionState {
    if (sessionRef.backendId !== this.backendId) {
      throw new Error(
        `Session backendId mismatch: expected "${this.backendId}", got "${sessionRef.backendId}"`,
      );
    }
    const session = this.sessions.get(sessionRef.sessionId);
    if (!session) {
      throw new Error(
        `Unknown session "${sessionRef.sessionId}" for backend "${this.backendId}"`,
      );
    }
    return session;
  }

  private takeScriptForTurn(ctx: FakeTurnMatchContext): FakeTurnScript {
    const matchedIdx = this.scriptQueue.findIndex(
      (entry) => entry.matcher !== undefined && matchesScript(entry.matcher, ctx),
    );
    if (matchedIdx !== -1) {
      const [entry] = this.scriptQueue.splice(matchedIdx, 1);
      return entry!.script;
    }

    const fifoIdx = this.scriptQueue.findIndex((entry) => entry.matcher === undefined);
    if (fifoIdx !== -1) {
      const [entry] = this.scriptQueue.splice(fifoIdx, 1);
      return entry!.script;
    }

    return this.defaultTurnScript;
  }

  private launchTurn(session: SessionState, message: string): void {
    const turnNumber = ++session.turnSeq;
    const turnId = `${session.sessionRef.sessionId}-turn-${turnNumber}`;
    const script = this.takeScriptForTurn({
      runSpec: session.runSpec,
      sessionRef: session.sessionRef,
      turnNumber,
      message,
    });

    const abortController = new AbortController();
    let resolveCompletion!: () => void;
    const completionPromise = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    const turn: TurnState = {
      turnId,
      turnNumber,
      events: [],
      finished: false,
      waiters: new Set(),
      abortController,
      completionPromise,
    };

    session.currentTurn = turn;
    session.status = "running";
    session.activeTurnId = turnId;

    void this.executeTurn(session, turn, script, resolveCompletion);
  }

  private async executeTurn(
    session: SessionState,
    turn: TurnState,
    script: FakeTurnScript,
    resolveCompletion: () => void,
  ): Promise<void> {
    try {
      // Yield one microtask so callers can immediately attach events()/probe() after start()/send().
      await Promise.resolve();
      if (turn.abortController.signal.aborted || turn.finished) {
        return;
      }

      for (const step of script) {
        if (turn.abortController.signal.aborted || turn.finished) {
          return;
        }

        if ("delayMs" in step && step.delayMs !== undefined && step.delayMs > 0) {
          await sleepAbortable(step.delayMs, turn.abortController.signal);
          if (turn.abortController.signal.aborted || turn.finished) {
            return;
          }
        }

        switch (step.kind) {
          case "thinking": {
            this.pushEvent(turn, { kind: "thinking", at: new Date().toISOString() });
            break;
          }
          case "message": {
            this.pushEvent(turn, {
              kind: "message",
              at: new Date().toISOString(),
              text: step.text,
              ...(step.delta !== undefined ? { delta: step.delta } : {}),
            });
            break;
          }
          case "tool": {
            this.pushEvent(turn, {
              kind: "tool",
              at: new Date().toISOString(),
              name: step.name,
              ...(step.target !== undefined ? { target: step.target } : {}),
            });
            break;
          }
          case "file_write": {
            this.pushEvent(turn, {
              kind: "file_write",
              at: new Date().toISOString(),
              path: step.path,
            });
            break;
          }
          case "usage": {
            const parsedUsage = RunUsageSchema.parse({
              turnId: step.turnId ?? turn.turnId,
              agent: session.runSpec.agent,
              model: session.runSpec.model,
              inputTokens: step.inputTokens,
              cachedInputTokens: step.cachedInputTokens ?? 0,
              outputTokens: step.outputTokens,
            });
            this.pushEvent(turn, {
              kind: "usage",
              at: new Date().toISOString(),
              ...parsedUsage,
            });
            break;
          }
          case "approval": {
            const decision = await this.runApprovalStep(session, turn, step);
            if (!decision) {
              return;
            }
            if (!decision.allow && step.onDenyExitReason !== undefined) {
              this.emitExit(session, turn, {
                kind: "exit",
                at: new Date().toISOString(),
                reason: step.onDenyExitReason,
                detail:
                  step.onDenyDetail ??
                  decision.message ??
                  `Approval denied for ${step.action}`,
              });
              return;
            }
            break;
          }
          case "wait_for_cancel": {
            await waitForAbort(turn.abortController.signal);
            return;
          }
          case "exit": {
            this.emitExit(session, turn, {
              kind: "exit",
              at: new Date().toISOString(),
              reason: step.reason,
              ...(step.detail !== undefined ? { detail: step.detail } : {}),
            });
            return;
          }
        }
      }

      if (!turn.finished && !turn.abortController.signal.aborted) {
        this.emitExit(session, turn, {
          kind: "exit",
          at: new Date().toISOString(),
          reason: "completed",
        });
      }
    } catch (err) {
      if (!turn.finished) {
        this.emitExit(session, turn, {
          kind: "exit",
          at: new Date().toISOString(),
          reason: "failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this.clearTurnPendingApprovals(turn.turnId);
      resolveCompletion();
    }
  }

  private async runApprovalStep(
    session: SessionState,
    turn: TurnState,
    step: Extract<FakeScriptStep, { kind: "approval" }>,
  ): Promise<{ allow: boolean; message?: string } | null> {
    const approvalId = `apr-${++this.approvalSeq}`;
    const at = new Date().toISOString();

    let resolved = false;
    let resolveDecision!: (decision: { allow: boolean; message?: string } | null) => void;
    const decisionPromise = new Promise<{ allow: boolean; message?: string } | null>(
      (resolve) => {
        resolveDecision = resolve;
      },
    );

    const finishWith = (value: { allow: boolean; message?: string } | null): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      turn.abortController.signal.removeEventListener("abort", onAbort);
      resolveDecision(value);
    };

    const onAbort = (): void => {
      this.pendingApprovals.delete(approvalId);
      finishWith(null);
    };

    this.pendingApprovals.set(approvalId, {
      id: approvalId,
      sessionId: session.sessionRef.sessionId,
      turnId: turn.turnId,
      resolve: (decision) => finishWith(decision),
    });
    turn.abortController.signal.addEventListener("abort", onAbort, { once: true });

    this.pushEvent(turn, {
      kind: "approval",
      at,
      id: approvalId,
      action: step.action,
      detail: step.detail,
    });

    const requestEvent: ApprovalRequestEvent = {
      id: approvalId,
      sessionRef: cloneSessionRef(session.sessionRef),
      action: step.action,
      detail: step.detail,
      at,
    };

    for (const handler of [...this.approvalHandlers]) {
      try {
        const result = handler(requestEvent);
        if (result && typeof (result as Promise<void>).then === "function") {
          void (result as Promise<void>).catch((err) => {
            this.pendingApprovals.delete(approvalId);
            if (!turn.finished) {
              this.emitExit(session, turn, {
                kind: "exit",
                at: new Date().toISOString(),
                reason: "failed",
                detail: err instanceof Error ? err.message : String(err),
              });
            }
            finishWith(null);
          });
        }
      } catch (err) {
        this.pendingApprovals.delete(approvalId);
        finishWith(null);
        throw err;
      }
    }

    return decisionPromise;
  }

  private clearTurnPendingApprovals(turnId: string): void {
    for (const [id, pending] of this.pendingApprovals.entries()) {
      if (pending.turnId === turnId) {
        this.pendingApprovals.delete(id);
      }
    }
  }

  private pushEvent(turn: TurnState, rawEvent: RunEvent): void {
    if (turn.finished) {
      return;
    }
    const event = RunEventSchema.parse(rawEvent);
    turn.events.push(event);
    if (event.kind === "exit") {
      turn.finished = true;
    }
    for (const wake of turn.waiters) {
      wake();
    }
    turn.waiters.clear();
  }

  private emitExit(
    session: SessionState,
    turn: TurnState,
    exitEvent: Extract<RunEvent, { kind: "exit" }>,
  ): void {
    if (turn.finished) {
      return;
    }
    // Clear running state before waking consumers waiting on exit.
    if (session.status !== "closed") {
      session.status = "idle";
    }
    session.activeTurnId = null;
    this.pushEvent(turn, exitEvent);
  }
}
