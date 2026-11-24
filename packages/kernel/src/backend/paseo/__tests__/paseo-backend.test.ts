import { calculateTurnCostUsd, type RunEvent } from "@kiln/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  type ApprovalRequestEvent,
  type BackendRunSpec,
  FullAccessOnlyProviderError,
} from "../../types.js";
import { verifyBackendContract } from "../../__tests__/contract.suite.js";
import * as publicPaseoExports from "../index.js";
import { PaseoBackend } from "../index.js";
import { createPaseoBackendForTest } from "../paseo-backend.js";
import { createSessionUsageState, normalizeTurnUsage } from "../usage-normalizer.js";
import type {
  PaseoAgentSnapshot,
  PaseoAgentUsage,
  PaseoConnectionState,
  PaseoCreateAgentOptions,
  PaseoDaemonEvent,
  PaseoDaemonLike,
  PaseoObservationHandle,
  PaseoPermissionRequest,
  PaseoPermissionResponse,
  PaseoProviderSnapshotEntry,
  PaseoProviderUsageResponse,
  PaseoServerInfo,
  PaseoTimelineMessage,
  PaseoTimelineSubscription,
} from "../types.js";

const DEFAULT_MOCK_PROVIDERS: PaseoProviderSnapshotEntry[] = [
  {
    provider: "codex",
    status: "ready",
    enabled: true,
    label: "Codex",
    defaultModeId: "auto-review",
    modes: [
      { id: "auto", label: "Default Permissions" },
      { id: "auto-review", label: "Auto-review" },
      { id: "full-access", label: "Full Access" },
    ],
    models: [
      {
        provider: "codex",
        id: "gpt-6-luna",
        label: "GPT-6 Luna",
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
          { id: "xhigh", label: "XHigh" },
          { id: "max", label: "Max" },
          { id: "invalid-tier", label: "Bogus Tier" },
        ],
        defaultThinkingOptionId: "high",
      },
      {
        provider: "codex",
        id: "gpt-hidden",
        label: "Hidden Model",
        isSelectable: false,
      },
    ],
  },
  {
    provider: "pi",
    status: "ready",
    enabled: true,
    label: "Pi",
    defaultModeId: null,
    modes: [],
    models: [
      {
        provider: "pi",
        id: "magpie/group/fast",
        label: "Magpie Fast",
        thinkingOptions: [{ id: "low", label: "Low" }],
        defaultThinkingOptionId: "low",
      },
    ],
  },
  {
    provider: "antigravity",
    status: "ready",
    enabled: true,
    label: "Antigravity",
    defaultModeId: "full-access",
    modes: [{ id: "full-access", label: "Full access" }],
    models: [
      {
        provider: "antigravity",
        id: "gemini-3-pro",
        label: "Gemini 3 Pro",
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
        defaultThinkingOptionId: "medium",
      },
    ],
  },
  {
    provider: "claude",
    status: "unavailable",
    enabled: false,
    label: "Claude",
    modes: [],
    models: [],
  },
];

interface MockAgentRuntime {
  snapshot: PaseoAgentSnapshot;
  turnCount: number;
  lastPrompt: string | null;
}

type TurnBehavior = (ctx: {
  agentId: string;
  turnNumber: number;
  message: string;
  runtime: MockAgentRuntime;
  daemon: MockPaseoDaemon;
}) => Promise<void> | void;

class MockPaseoDaemon implements PaseoDaemonLike {
  isConnected = false;
  connectCalls = 0;
  closeCalls = 0;
  callOrder: string[] = [];

  serverInfo: PaseoServerInfo | null;
  providers: PaseoProviderSnapshotEntry[];
  providerUsageResponse: PaseoProviderUsageResponse = {
    requestId: "usage-req-1",
    fetchedAt: "2026-11-19T12:00:00.000Z",
    providers: [],
  };

  createdOptions: PaseoCreateAgentOptions[] = [];
  sentMessages: Array<{ agentId: string; text: string }> = [];
  cancelledAgents: string[] = [];
  deletedAgents: string[] = [];
  observeEventsCalls: string[][] = [];
  observeAgentsCalls: Array<{ includeBackground?: boolean } | undefined> = [];
  releasedObservations: string[] = [];
  permissionResponses: Array<{
    agentId: string;
    requestId: string;
    response: PaseoPermissionResponse;
  }> = [];

  cancelError: Error | null = null;
  deleteErrors = new Set<string>();
  readyDelayMs = 0;
  emitCancelOnCancelAgent = true;
  refreshSnapshotCalls = 0;
  onRefreshSnapshot?: () => void;
  createPersistenceHook?: (
    options: PaseoCreateAgentOptions,
    agentId: string,
  ) => PaseoAgentSnapshot["persistence"];

  private agentSeq = 0;
  private readonly agents = new Map<string, MockAgentRuntime>();
  private readonly daemonListeners = new Set<(event: PaseoDaemonEvent) => void>();
  private readonly eventObservers = new Set<(event: PaseoDaemonEvent) => void>();
  private readonly connectionListeners = new Set<(state: PaseoConnectionState) => void>();
  private readonly timelineListeners = new Map<string, Set<(msg: PaseoTimelineMessage) => void>>();
  private readonly pendingPermWaiters = new Map<
    string,
    (response: PaseoPermissionResponse) => void
  >();
  private readonly turnBehaviorQueue: TurnBehavior[] = [];
  private defaultBehavior: TurnBehavior = ({ agentId, turnNumber, daemon }) => {
    const at = new Date().toISOString();
    daemon.emitTimeline(agentId, {
      type: "agent_stream",
      payload: {
        agentId,
        timestamp: at,
        event: {
          type: "turn_started",
          provider: "codex",
          turnId: `${agentId}-paseo-t${turnNumber}`,
        },
      },
    });
    daemon.emitTimeline(agentId, {
      type: "agent_stream",
      payload: {
        agentId,
        timestamp: at,
        event: {
          type: "timeline",
          provider: "codex",
          turnId: `${agentId}-paseo-t${turnNumber}`,
          item: { type: "reasoning", text: "Thinking..." },
        },
      },
    });
    daemon.emitTimeline(agentId, {
      type: "agent_stream",
      payload: {
        agentId,
        timestamp: at,
        event: {
          type: "timeline",
          provider: "codex",
          turnId: `${agentId}-paseo-t${turnNumber}`,
          item: { type: "assistant_message", text: `Reply ${turnNumber}` },
        },
      },
    });
    daemon.emitTimeline(agentId, {
      type: "agent_stream",
      payload: {
        agentId,
        timestamp: at,
        event: {
          type: "turn_completed",
          provider: "codex",
          turnId: `${agentId}-paseo-t${turnNumber}`,
          usage: { inputTokens: 120, cachedInputTokens: 20, outputTokens: 30 },
        },
      },
    });
  };

  constructor(options?: {
    serverInfo?: PaseoServerInfo | null;
    providers?: PaseoProviderSnapshotEntry[];
  }) {
    this.serverInfo =
      options?.serverInfo !== undefined
        ? options.serverInfo
        : {
            serverId: "srv_local_test",
            features: {
              backgroundWorkspaces: true,
              providerUsageList: true,
            },
          };
    this.providers = options?.providers ?? structuredClone(DEFAULT_MOCK_PROVIDERS);
  }

  enqueueTurnBehavior(behavior: TurnBehavior): void {
    this.turnBehaviorQueue.push(behavior);
  }

  setDefaultBehavior(behavior: TurnBehavior): void {
    this.defaultBehavior = behavior;
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.isConnected = true;
    this.callOrder.push("connect");
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.isConnected = false;
    this.callOrder.push("close");
  }

  getLastServerInfoMessage(): PaseoServerInfo | null {
    return this.serverInfo;
  }

  async getProvidersSnapshot(): Promise<{
    requestId: string;
    entries: PaseoProviderSnapshotEntry[];
  }> {
    return {
      requestId: "snap-mock-1",
      entries: structuredClone(this.providers),
    };
  }

  async refreshProvidersSnapshot(options?: {
    cwd?: string;
    requestId?: string;
  }): Promise<{ requestId: string }> {
    this.refreshSnapshotCalls += 1;
    this.callOrder.push("refreshProvidersSnapshot");
    this.onRefreshSnapshot?.();
    return { requestId: options?.requestId ?? `refresh-${this.refreshSnapshotCalls}` };
  }

  async createAgent(options: PaseoCreateAgentOptions): Promise<PaseoAgentSnapshot> {
    this.callOrder.push("createAgent");
    this.createdOptions.push(structuredClone(options));

    const id = `agent-${++this.agentSeq}`;
    const provider = options.config.provider;
    const isPi = provider === "pi";
    const snapshot: PaseoAgentSnapshot = {
      id,
      provider,
      model: options.config.model ?? null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: isPi,
        supportsMcpServers: !isPi,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      availableModes: [],
      currentModeId: options.config.modeId ?? null,
      pendingPermissions: [],
      ...(this.createPersistenceHook
        ? { persistence: this.createPersistenceHook(options, id) }
        : {}),
    };
    this.agents.set(id, { snapshot, turnCount: 0, lastPrompt: null });
    return structuredClone(snapshot);
  }

  async fetchAgent(options: {
    agentId: string;
  }): Promise<{ agent: PaseoAgentSnapshot; project: unknown } | null> {
    const runtime = this.agents.get(options.agentId);
    if (!runtime) {
      return null;
    }
    return { agent: structuredClone(runtime.snapshot), project: null };
  }

  async deleteAgent(agentId: string): Promise<void> {
    this.deletedAgents.push(agentId);
    if (this.deleteErrors.has(agentId)) {
      throw new Error(`Failed to delete ${agentId}`);
    }
    this.agents.delete(agentId);
  }

  async sendAgentMessage(agentId: string, text: string): Promise<{ deliveryStatus?: "queued" }> {
    this.callOrder.push(`sendAgentMessage:${agentId}`);
    this.sentMessages.push({ agentId, text });
    const runtime = this.agents.get(agentId);
    if (!runtime) {
      throw new Error(`Unknown agent ${agentId}`);
    }
    runtime.turnCount += 1;
    runtime.lastPrompt = text;
    runtime.snapshot.status = "running";

    const behavior = this.turnBehaviorQueue.shift() ?? this.defaultBehavior;
    const turnNumber = runtime.turnCount;

    queueMicrotask(() => {
      void behavior({
        agentId,
        turnNumber,
        message: text,
        runtime,
        daemon: this,
      });
    });

    return {};
  }

  async cancelAgent(agentId: string): Promise<void> {
    this.cancelledAgents.push(agentId);
    if (this.cancelError) {
      throw this.cancelError;
    }
    const runtime = this.agents.get(agentId);
    if (runtime) {
      runtime.snapshot.status = "idle";
    }
    if (this.emitCancelOnCancelAgent) {
      this.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: new Date().toISOString(),
          event: {
            type: "turn_canceled",
            provider: runtime?.snapshot.provider ?? "codex",
            reason: "interrupted",
          },
        },
      });
    }
  }

  async respondToPermission(
    agentId: string,
    requestId: string,
    response: PaseoPermissionResponse,
  ): Promise<void> {
    this.permissionResponses.push({ agentId, requestId, response });
    const waiter = this.pendingPermWaiters.get(requestId);
    if (waiter) {
      this.pendingPermWaiters.delete(requestId);
      waiter(response);
    }
  }

  subscribe(handler: (event: PaseoDaemonEvent) => void): () => void {
    this.daemonListeners.add(handler);
    return () => {
      this.daemonListeners.delete(handler);
    };
  }

  subscribeAgentTimeline(
    agentId: string,
    handler: (message: PaseoTimelineMessage) => void,
  ): PaseoTimelineSubscription {
    this.callOrder.push(`subscribeAgentTimeline:${agentId}`);
    let set = this.timelineListeners.get(agentId);
    if (!set) {
      set = new Set();
      this.timelineListeners.set(agentId, set);
    }
    set.add(handler);

    const ready = (
      this.readyDelayMs > 0
        ? new Promise<void>((resolve) => setTimeout(resolve, this.readyDelayMs))
        : Promise.resolve()
    ).then(() => {
      this.callOrder.push(`timelineReady:${agentId}`);
    });

    const release = async (): Promise<void> => {
      this.timelineListeners.get(agentId)?.delete(handler);
    };

    return Object.assign(
      () => {
        this.timelineListeners.get(agentId)?.delete(handler);
      },
      { ready, subscriptionId: `sub-${agentId}`, release },
    );
  }

  subscribeConnectionStatus(listener: (state: PaseoConnectionState) => void): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  ensureConnected(): void {
    this.isConnected = true;
  }

  observeEvents(
    events: Array<
      "agent_permission_request" | "agent_permission_resolved" | "providers_snapshot_update"
    >,
  ): PaseoObservationHandle & {
    subscriptionId: string | null;
    subscribe: (observer: {
      snapshot?: (snap: unknown) => void;
      update?: (msg: PaseoDaemonEvent) => void;
    }) => () => void;
  } {
    this.observeEventsCalls.push([...events]);
    const localListeners = new Set<(msg: PaseoDaemonEvent) => void>();
    return {
      ready: Promise.resolve({ requestId: "obs-events-1", subscribed: true }),
      subscriptionId: "sub-events-1",
      subscribe: (observer) => {
        const cb = (msg: PaseoDaemonEvent) => {
          observer?.update?.(msg);
        };
        localListeners.add(cb);
        this.eventObservers.add(cb);
        return () => {
          localListeners.delete(cb);
          this.eventObservers.delete(cb);
        };
      },
      release: async () => {
        for (const cb of localListeners) {
          this.eventObservers.delete(cb);
        }
        localListeners.clear();
        this.releasedObservations.push("events");
      },
    };
  }

  observeAgents(options?: { includeBackground?: boolean }): PaseoObservationHandle & {
    subscriptionId: string | null;
    subscribe: () => () => void;
  } {
    this.observeAgentsCalls.push(options ? { ...options } : undefined);
    return {
      ready: Promise.resolve({ agents: [] }),
      subscriptionId: "sub-agents-1",
      subscribe: () => () => {},
      release: async () => {
        this.releasedObservations.push("agents");
      },
    };
  }

  async listProviderUsage(): Promise<PaseoProviderUsageResponse> {
    return structuredClone(this.providerUsageResponse);
  }

  emitTimeline(agentId: string, msg: PaseoTimelineMessage): void {
    const listeners = this.timelineListeners.get(agentId);
    if (!listeners) {
      return;
    }
    for (const listener of Array.from(listeners)) {
      listener(msg);
    }
  }

  emitDaemonEvent(event: PaseoDaemonEvent): void {
    for (const listener of Array.from(this.daemonListeners)) {
      listener(event);
    }
    for (const observer of Array.from(this.eventObservers)) {
      observer(event);
    }
  }

  emitConnectionState(state: PaseoConnectionState): void {
    for (const listener of Array.from(this.connectionListeners)) {
      listener(state);
    }
  }

  setAgentLastUsage(agentId: string, lastUsage: PaseoAgentUsage): void {
    const runtime = this.agents.get(agentId);
    if (runtime) {
      runtime.snapshot.lastUsage = { ...lastUsage };
    }
  }

  setAgentSnapshot(agentId: string, patch: Partial<PaseoAgentSnapshot>): void {
    const runtime = this.agents.get(agentId);
    if (runtime) {
      Object.assign(runtime.snapshot, patch);
    }
  }

  waitForPermissionResponse(requestId: string): Promise<PaseoPermissionResponse> {
    return new Promise((resolve) => {
      this.pendingPermWaiters.set(requestId, resolve);
    });
  }
}

function makeRunSpec(overrides: Partial<BackendRunSpec> = {}): BackendRunSpec {
  return {
    runId: "run-201",
    taskId: "t-201",
    role: "worker",
    agent: "codex",
    model: "gpt-6-luna",
    cwd: "/tmp/kiln-paseo-test",
    prompt: "Implement feature",
    freshContext: true,
    ...overrides,
  };
}

async function collectAll(iter: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of iter) {
    out.push(event);
  }
  return out;
}

verifyBackendContract("PaseoBackend", () => {
  const daemon = new MockPaseoDaemon();
  const backend = createPaseoBackendForTest({ daemonClient: daemon });

  return {
    backend,
    createStreamingRun() {
      daemon.enqueueTurnBehavior(({ agentId, daemon: d }) => {
        const at = new Date().toISOString();
        d.emitTimeline(agentId, {
          type: "agent_stream",
          payload: {
            agentId,
            timestamp: at,
            event: { type: "turn_started", provider: "codex", turnId: "codex-t-stream" },
          },
        });
        d.emitTimeline(agentId, {
          type: "agent_stream",
          payload: {
            agentId,
            timestamp: at,
            event: {
              type: "timeline",
              provider: "codex",
              item: { type: "reasoning", text: "Analyzing" },
            },
          },
        });
        d.emitTimeline(agentId, {
          type: "agent_stream",
          payload: {
            agentId,
            timestamp: at,
            event: {
              type: "timeline",
              provider: "codex",
              item: { type: "assistant_message", text: "Hello " },
            },
          },
        });
        d.emitTimeline(agentId, {
          type: "agent_stream",
          payload: {
            agentId,
            timestamp: at,
            event: {
              type: "timeline",
              provider: "codex",
              item: { type: "assistant_message", text: "Kiln" },
            },
          },
        });
        d.emitTimeline(agentId, {
          type: "agent_stream",
          payload: {
            agentId,
            timestamp: at,
            event: {
              type: "timeline",
              provider: "codex",
              item: {
                type: "tool_call",
                callId: "call-read-1",
                name: "read_file",
                status: "completed",
                error: null,
                detail: { type: "read", filePath: "README.md" },
              },
            },
          },
        });
        d.emitTimeline(agentId, {
          type: "agent_stream",
          payload: {
            agentId,
            timestamp: at,
            event: {
              type: "turn_completed",
              provider: "codex",
              turnId: "codex-t-stream",
              usage: { inputTokens: 150, cachedInputTokens: 50, outputTokens: 25 },
            },
          },
        });
      });
      return makeRunSpec({ runId: "run-paseo-stream" });
    },
    createCancellableRun() {
      daemon.enqueueTurnBehavior(({ agentId, daemon: d }) => {
        const at = new Date().toISOString();
        d.emitTimeline(agentId, {
          type: "agent_stream",
          payload: {
            agentId,
            timestamp: at,
            event: {
              type: "timeline",
              provider: "codex",
              item: { type: "assistant_message", text: "Streaming before cancel..." },
            },
          },
        });
      });
      return makeRunSpec({ runId: "run-paseo-cancel" });
    },
    createApprovalRun(branch) {
      daemon.enqueueTurnBehavior(async ({ agentId, daemon: d }) => {
        const requestId = `perm-${branch}-1`;
        const req: PaseoPermissionRequest = {
          id: requestId,
          provider: "codex",
          name: "write_file",
          kind: "tool",
          detail: { type: "write", filePath: "/etc/hosts" },
        };
        const decisionPromise = d.waitForPermissionResponse(requestId);
        d.emitTimeline(agentId, {
          type: "agent_stream",
          payload: {
            agentId,
            timestamp: new Date().toISOString(),
            event: {
              type: "permission_requested",
              provider: "codex",
              request: req,
            },
          },
        });

        const decision = await decisionPromise;
        const at = new Date().toISOString();
        if (decision.behavior === "deny") {
          d.emitTimeline(agentId, {
            type: "agent_stream",
            payload: {
              agentId,
              timestamp: at,
              event: {
                type: "turn_failed",
                provider: "codex",
                error: decision.message ?? "Permission denied",
              },
            },
          });
          return;
        }

        d.emitTimeline(agentId, {
          type: "agent_stream",
          payload: {
            agentId,
            timestamp: at,
            event: {
              type: "timeline",
              provider: "codex",
              item: {
                type: "tool_call",
                callId: `call-write-${branch}`,
                name: "write_file",
                status: "completed",
                error: null,
                detail: { type: "write", filePath: "/tmp/kiln-paseo-test/out.ts" },
              },
            },
          },
        });
        d.emitTimeline(agentId, {
          type: "agent_stream",
          payload: {
            agentId,
            timestamp: at,
            event: {
              type: "turn_completed",
              provider: "codex",
              turnId: `codex-approval-${branch}`,
              usage: { inputTokens: 200, cachedInputTokens: 100, outputTokens: 40 },
            },
          },
        });
      });

      return makeRunSpec({
        runId: `run-paseo-approval-${branch}`,
        allowFullAccessFallback: false,
      });
    },
    createMultiTurnRun() {
      daemon.enqueueTurnBehavior(({ agentId, daemon: d }) => {
        const at = new Date().toISOString();
        d.emitTimeline(agentId, {
          type: "agent_stream",
          payload: {
            agentId,
            timestamp: at,
            event: {
              type: "timeline",
              provider: "codex",
              item: { type: "assistant_message", text: "Turn 1 answer" },
            },
          },
        });
        d.emitTimeline(agentId, {
          type: "agent_stream",
          payload: {
            agentId,
            timestamp: at,
            event: {
              type: "turn_completed",
              provider: "codex",
              turnId: "turn-codex-1",
              usage: { inputTokens: 300, cachedInputTokens: 100, outputTokens: 50 },
            },
          },
        });
      });
      daemon.enqueueTurnBehavior(({ agentId, daemon: d }) => {
        const at = new Date().toISOString();
        d.emitTimeline(agentId, {
          type: "agent_stream",
          payload: {
            agentId,
            timestamp: at,
            event: {
              type: "timeline",
              provider: "codex",
              item: { type: "assistant_message", text: "Turn 2 answer" },
            },
          },
        });
        d.emitTimeline(agentId, {
          type: "agent_stream",
          payload: {
            agentId,
            timestamp: at,
            event: {
              type: "turn_completed",
              provider: "codex",
              turnId: "turn-codex-2",
              usage: { inputTokens: 420, cachedInputTokens: 300, outputTokens: 60 },
            },
          },
        });
      });

      return {
        runSpec: makeRunSpec({ runId: "run-paseo-multiturn", role: "intake" }),
        followUpMessage: "Please refine scope",
      };
    },
  };
});

describe("PaseoBackend constructor & single-connection construction", () => {
  it("constructs with real @getpaseo/client DaemonClient lazily without opening network or background timers", async () => {
    const backend = new PaseoBackend({
      url: "ws://127.0.0.1:65534/ws",
      reconnect: { enabled: false },
    });

    expect(backend.backendId).toBe("paseo");
    expect(await backend.liveViewUrl({ backendId: "paseo", sessionId: "agent-1" })).toBeNull();
    await backend.dispose();
    await backend.dispose();
  });

  it("reuses a single injected DaemonClient across all operations without duplicate connections", async () => {
    const daemon = new MockPaseoDaemon();
    const backend = createPaseoBackendForTest({ daemonClient: daemon });

    await backend.listAgents();
    await backend.listModels("codex");
    await backend.capabilities("pi");
    const ref = await backend.start(makeRunSpec());
    await collectAll(backend.events(ref));

    expect(daemon.connectCalls).toBe(1);
    await backend.dispose();
    expect(daemon.closeCalls).toBe(1);
  });

  it("wires real createPaseoApi(daemonClient) when observeEvents is provided on the client", async () => {
    const daemon = new MockPaseoDaemon();
    const observeCalls: unknown[] = [];
    const clientWithObserve = Object.assign(daemon, {
      ensureConnected: () => {
        daemon.isConnected = true;
      },
      observeEvents: (events: unknown) => {
        observeCalls.push(events);
        return {
          ready: Promise.resolve({ requestId: "obs-1", subscribed: true }),
          subscriptionId: "sub-obs-1",
          subscribe: () => () => {},
          release: async () => {},
        };
      },
      getProvidersSnapshot: async () => ({
        requestId: "snap-1",
        cwd: "/tmp",
        entries: structuredClone(daemon.providers),
      }),
    });

    const backend = createPaseoBackendForTest({ daemonClient: clientWithObserve });
    const agents = await backend.listAgents();
    expect(agents.map((a) => a.id)).toEqual(["codex", "pi", "antigravity"]);
    expect(observeCalls).toEqual([
      ["agent_permission_request", "agent_permission_resolved", "providers_snapshot_update"],
      ["providers_snapshot_update"],
    ]);

    daemon.providerUsageResponse = {
      requestId: "usage-obs-1",
      fetchedAt: "2026-11-19T12:00:00.000Z",
      providers: [
        {
          providerId: "codex",
          displayName: "Codex",
          status: "available",
          planLabel: "Pro",
          windows: [{ id: "weekly", label: "Weekly", usedPct: 10, remainingPct: 90 }],
        },
      ],
    };
    const windows = await backend.listProviderUsage();
    expect(windows).toHaveLength(1);
    expect(windows[0]?.windowId).toBe("weekly");

    await backend.dispose();
  });
});

describe("PaseoBackend V1: provider discovery, models, capabilities & mode selection", () => {
  it("lists enabled ready agents, filters thinkingOptions via ReasoningEffortSchema, and marks full-access modes", async () => {
    const daemon = new MockPaseoDaemon();
    const backend = createPaseoBackendForTest({ daemonClient: daemon });

    const agents = await backend.listAgents();
    expect(agents.map((a) => a.id)).toEqual(["codex", "pi", "antigravity"]);

    const codex = agents.find((a) => a.id === "codex")!;
    expect(codex.capabilities).toEqual({
      interactiveChat: true,
      approvals: false,
      mcpInjection: true,
      usageCacheBreakdown: true,
      interrupt: true,
    });
    expect(codex.modes.map((m) => ({ id: m.id, isFullAccess: Boolean(m.isFullAccess) }))).toEqual([
      { id: "auto", isFullAccess: false },
      { id: "auto-review", isFullAccess: false },
      { id: "full-access", isFullAccess: true },
    ]);

    const pi = agents.find((a) => a.id === "pi")!;
    expect(pi.capabilities).toEqual({
      interactiveChat: true,
      approvals: false,
      mcpInjection: false,
      usageCacheBreakdown: true,
      interrupt: true,
    });
    expect(pi.modes).toEqual([]);

    const codexModels = await backend.listModels("codex");
    expect(codexModels).toEqual([
      {
        id: "gpt-6-luna",
        label: "GPT-6 Luna",
        thinkingOptions: ["low", "medium", "high", "xhigh", "max"],
        defaultThinkingOptionId: "high",
      },
    ]);

    await expect(backend.listModels("unknown-provider")).rejects.toThrow(/Unknown agent/);
    await backend.dispose();
  });

  it("selects 'auto' for Codex, omits modeId completely for Pi, and blocks full-access-only Antigravity unless fallback allowed", async () => {
    const daemon = new MockPaseoDaemon();
    const backend = createPaseoBackendForTest({ daemonClient: daemon });

    // Codex picks "auto" (never "full-access")
    const codexRef = await backend.start(makeRunSpec({ agent: "codex", reasoningEffort: "low" }));
    expect(codexRef.meta?.modeId).toBe("auto");
    expect(daemon.createdOptions[0]?.config.modeId).toBe("auto");
    expect(daemon.createdOptions[0]?.config.thinkingOptionId).toBe("low");
    await collectAll(backend.events(codexRef));

    // Pi omits modeId strictly (never passes "default")
    const piRef = await backend.start(
      makeRunSpec({ agent: "pi", model: "magpie/group/fast", role: "worker" }),
    );
    expect(piRef.meta?.modeId).toBeUndefined();
    expect("modeId" in (piRef.meta ?? {})).toBe(false);
    expect("modeId" in daemon.createdOptions[1]!.config).toBe(false);
    await collectAll(backend.events(piRef));

    // Antigravity throws FullAccessOnlyProviderError unless allowFullAccessFallback is true
    await expect(
      backend.start(
        makeRunSpec({
          agent: "antigravity",
          model: "gemini-3-pro",
          role: "worker",
        }),
      ),
    ).rejects.toBeInstanceOf(FullAccessOnlyProviderError);

    const agyRef = await backend.start(
      makeRunSpec({
        agent: "antigravity",
        model: "gemini-3-pro",
        role: "worker",
        allowFullAccessFallback: true,
      }),
    );
    expect(agyRef.meta?.modeId).toBe("full-access");
    expect(daemon.createdOptions[2]?.config.modeId).toBe("full-access");
    await collectAll(backend.events(agyRef));

    await backend.dispose();
  });
});

describe("PaseoBackend V2: conservative approvals=false & deduplicated dual-source permission routing", () => {
  it("reports approvals=false while deduplicating permission_requested and agent_permission_request by request.id", async () => {
    const daemon = new MockPaseoDaemon();
    const backend = createPaseoBackendForTest({ daemonClient: daemon });

    expect((await backend.capabilities("codex")).approvals).toBe(false);
    expect((await backend.capabilities("pi")).approvals).toBe(false);

    const seenApprovals: ApprovalRequestEvent[] = [];
    const unsubscribe = backend.onApproval(async (req) => {
      seenApprovals.push(req);
      await backend.answer(req.id, false, "Not permitted");
    });

    daemon.enqueueTurnBehavior(async ({ agentId, daemon: d }) => {
      const req: PaseoPermissionRequest = {
        id: "perm-dup-1",
        provider: "codex",
        name: "shell",
        kind: "tool",
        detail: { type: "shell", command: "rm -rf /tmp/x" },
      };
      const wait = d.waitForPermissionResponse("perm-dup-1");
      // Emit via BOTH daemon subscribe and timeline stream with identical request.id
      d.emitDaemonEvent({
        type: "agent_permission_request",
        agentId,
        request: req,
      });
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: new Date().toISOString(),
          event: { type: "permission_requested", provider: "codex", request: req },
        },
      });
      await wait;
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: new Date().toISOString(),
          event: {
            type: "turn_completed",
            provider: "codex",
            turnId: "t-perm-dup",
            usage: { inputTokens: 80, cachedInputTokens: 10, outputTokens: 15 },
          },
        },
      });
    });

    const ref = await backend.start(makeRunSpec());
    const events = await collectAll(backend.events(ref));
    unsubscribe();

    expect(seenApprovals).toHaveLength(1);
    expect(seenApprovals[0]?.action).toBe("shell");
    expect(seenApprovals[0]?.detail).toBe("rm -rf /tmp/x");
    expect(events.filter((e) => e.kind === "approval")).toHaveLength(1);
    expect(daemon.permissionResponses).toEqual([
      {
        agentId: ref.sessionId,
        requestId: "perm-dup-1",
        response: { behavior: "deny", message: "Not permitted" },
      },
    ]);

    // Answering unknown or already-resolved ID rejects
    await expect(backend.answer("perm-dup-1", true)).rejects.toThrow(/Unknown or already resolved/);
    await expect(backend.answer("perm-missing", false)).rejects.toThrow(
      /Unknown or already resolved/,
    );

    await backend.dispose();
  });
});

describe("PaseoBackend V3: MCP injection, strict toolPolicy & Pi capability guard", () => {
  it("mounts strict stdio mcpServers + role-scoped preapproved toolPolicy for Codex without initialPrompt", async () => {
    const daemon = new MockPaseoDaemon();
    const backend = createPaseoBackendForTest({ daemonClient: daemon });

    const ref = await backend.start(
      makeRunSpec({
        agent: "codex",
        role: "worker",
        systemPrompt: "Follow contract strictly",
        env: { KILN_RUN_TOKEN: "tok-secret" },
        mcpServers: [
          {
            name: "kiln",
            command: "node",
            args: ["/opt/kiln/mcp.js"],
            env: { KILN_SOCK: "/tmp/kiln.sock" },
          },
        ],
      }),
    );
    await collectAll(backend.events(ref));

    const createOpt = daemon.createdOptions[0]!;
    expect("initialPrompt" in createOpt).toBe(false);
    expect(createOpt.background).toBe(true);
    expect(createOpt.env).toEqual({ KILN_RUN_TOKEN: "tok-secret" });
    expect(createOpt.config.systemPrompt).toBe("Follow contract strictly");
    expect(createOpt.config.mcpServers).toEqual({
      kiln: {
        type: "stdio",
        command: "node",
        args: ["/opt/kiln/mcp.js"],
        env: { KILN_SOCK: "/tmp/kiln.sock" },
      },
    });
    expect(createOpt.config.toolPolicy).toEqual({
      preapproved: [
        { kind: "mcp", server: "kiln", tool: "wb_get_context" },
        { kind: "mcp", server: "kiln", tool: "wb_read_ledger" },
        { kind: "mcp", server: "kiln", tool: "wb_ask_decision" },
        { kind: "mcp", server: "kiln", tool: "wb_submit_receipt" },
        { kind: "mcp", server: "kiln", tool: "wb_propose_ledger" },
      ],
    });

    await backend.dispose();
  });

  it("omits background when host lacks backgroundWorkspaces, allows Pi on intake/resolver without mcpServers/toolPolicy, and enforces Antigravity full-access opt-in", async () => {
    const daemon = new MockPaseoDaemon({
      serverInfo: { serverId: "srv_old", features: { backgroundWorkspaces: false } },
    });
    const backend = createPaseoBackendForTest({ daemonClient: daemon });

    const piIntakeRef = await backend.start(
      makeRunSpec({
        agent: "pi",
        model: "magpie/group/fast",
        role: "intake",
        mcpServers: [{ name: "kiln", command: "node", args: ["mcp.js"] }],
      }),
    );
    await collectAll(backend.events(piIntakeRef));

    const piResolverRef = await backend.start(
      makeRunSpec({
        agent: "pi",
        model: "magpie/group/fast",
        role: "resolver",
        mcpServers: [{ name: "kiln", command: "node", args: ["mcp.js"] }],
      }),
    );
    await collectAll(backend.events(piResolverRef));

    const ref = await backend.start(
      makeRunSpec({
        agent: "pi",
        model: "magpie/group/fast",
        role: "worker",
        mcpServers: [{ name: "kiln", command: "node", args: ["mcp.js"] }],
      }),
    );
    await collectAll(backend.events(ref));

    for (const createOpt of daemon.createdOptions.slice(0, 3)) {
      expect("background" in createOpt).toBe(false);
      expect("mcpServers" in createOpt.config).toBe(false);
      expect("toolPolicy" in createOpt.config).toBe(false);
    }

    // Antigravity on intake still requires allowFullAccessFallback, and also omits MCP when enabled
    await expect(
      backend.start(
        makeRunSpec({
          agent: "antigravity",
          model: "gemini-3-pro",
          role: "intake",
          allowFullAccessFallback: false,
        }),
      ),
    ).rejects.toBeInstanceOf(FullAccessOnlyProviderError);

    const agyIntakeRef = await backend.start(
      makeRunSpec({
        agent: "antigravity",
        model: "gemini-3-pro",
        role: "intake",
        allowFullAccessFallback: true,
        mcpServers: [{ name: "kiln", command: "node", args: ["mcp.js"] }],
      }),
    );
    await collectAll(backend.events(agyIntakeRef));
    const agyOpt = daemon.createdOptions[3]!;
    expect(agyOpt.config.modeId).toBe("full-access");
    expect("mcpServers" in agyOpt.config).toBe(false);
    expect("toolPolicy" in agyOpt.config).toBe(false);

    // Intake role receives intake-allowed MCP tools (excluding worker receipt/decision tools)
    const intakeRef = await backend.start(
      makeRunSpec({
        agent: "codex",
        role: "intake",
        mcpServers: [{ name: "kiln", command: "node", args: ["mcp.js"] }],
      }),
    );
    await collectAll(backend.events(intakeRef));
    expect(daemon.createdOptions[4]?.config.toolPolicy).toEqual({
      preapproved: [
        { kind: "mcp", server: "kiln", tool: "wb_get_context" },
        { kind: "mcp", server: "kiln", tool: "wb_list_tasks" },
        { kind: "mcp", server: "kiln", tool: "wb_read_ledger" },
        { kind: "mcp", server: "kiln", tool: "wb_plan" },
        { kind: "mcp", server: "kiln", tool: "wb_propose_ledger" },
      ],
    });

    await backend.dispose();
  });

  it("cleans up created agent and timeline subscription if start() fails during sendAgentMessage", async () => {
    const daemon = new MockPaseoDaemon();
    daemon.sendAgentMessage = async () => {
      throw new Error("send rejected");
    };
    const backend = createPaseoBackendForTest({ daemonClient: daemon });

    await expect(backend.start(makeRunSpec())).rejects.toThrow("send rejected");
    expect(daemon.deletedAgents).toHaveLength(1);
    await backend.dispose();
  });
});

describe("PaseoBackend V4 & V5 & V6: timeline subscription ordering, tool deduplication, cancellation, cleanup & deep links", () => {
  it("awaits sub.ready before sendAgentMessage, deduplicates tool_call by callId, and replays finished turn events", async () => {
    const daemon = new MockPaseoDaemon();
    daemon.readyDelayMs = 15;
    const backend = createPaseoBackendForTest({ daemonClient: daemon });

    daemon.enqueueTurnBehavior(({ agentId, daemon: d }) => {
      const at = new Date().toISOString();
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: at,
          event: {
            type: "timeline",
            provider: "codex",
            item: {
              type: "tool_call",
              callId: "c-write-1",
              name: "write_file",
              status: "running",
              error: null,
              detail: { type: "write", filePath: "src/app.ts" },
            },
          },
        },
      });
      // Duplicate emission for c-write-1 transition to completed
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: at,
          event: {
            type: "timeline",
            provider: "codex",
            item: {
              type: "tool_call",
              callId: "c-write-1",
              name: "write_file",
              status: "completed",
              error: null,
              detail: { type: "write", filePath: "src/app.ts" },
            },
          },
        },
      });
      // Failed edit should map to tool (not file_write)
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: at,
          event: {
            type: "timeline",
            provider: "codex",
            item: {
              type: "tool_call",
              callId: "c-edit-fail",
              name: "edit_file",
              status: "failed",
              error: "conflict",
              detail: { type: "edit", filePath: "src/bad.ts" },
            },
          },
        },
      });
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: at,
          event: {
            type: "turn_completed",
            provider: "codex",
            turnId: "t-order-1",
            usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 },
          },
        },
      });
    });

    const ref = await backend.start(makeRunSpec());
    expect(daemon.callOrder).toEqual([
      "connect",
      "createAgent",
      `subscribeAgentTimeline:${ref.sessionId}`,
      `timelineReady:${ref.sessionId}`,
      `sendAgentMessage:${ref.sessionId}`,
    ]);

    const [eventsA, eventsB] = await Promise.all([
      collectAll(backend.events(ref)),
      collectAll(backend.events(ref)),
    ]);
    expect(eventsA).toEqual(eventsB);
    expect(eventsA.map((e) => e.kind)).toEqual(["file_write", "tool", "usage", "exit"]);
    expect(eventsA[0]).toMatchObject({ kind: "file_write", path: "src/app.ts" });
    expect(eventsA[1]).toMatchObject({ kind: "tool", name: "edit_file", target: "src/bad.ts" });

    // Late replay after completion must not hang
    const replay = await collectAll(backend.events(ref));
    expect(replay).toEqual(eventsA);

    await backend.dispose();
  });

  it("handles agent.timeline.error, fatal disconnects, stopFallback, idempotent cancel, and tolerant dispose cleanup", async () => {
    const daemon = new MockPaseoDaemon();
    const stopFallback = vi.fn(async (agentId: string) => {
      daemon.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: new Date().toISOString(),
          event: { type: "turn_canceled", provider: "codex", reason: "cli stop" },
        },
      });
    });
    const backend = createPaseoBackendForTest({
      daemonClient: daemon,
      stopFallback,
      cancelTimeoutMs: 100,
    });

    // 1. Timeline error emits single failed exit
    daemon.enqueueTurnBehavior(({ agentId, daemon: d }) => {
      d.emitTimeline(agentId, {
        type: "agent.timeline.error",
        payload: { agentId, error: "subscription dropped" },
      });
    });
    const errRef = await backend.start(makeRunSpec({ runId: "r-tl-err" }));
    const errEvents = await collectAll(backend.events(errRef));
    expect(errEvents).toHaveLength(1);
    expect(errEvents[0]).toMatchObject({
      kind: "exit",
      reason: "failed",
      detail: "subscription dropped",
    });

    // 2. cancelAgent failure invokes stopFallback & second cancel is idempotent
    daemon.cancelError = new Error("RPC cancel failed");
    daemon.enqueueTurnBehavior(() => {});
    const cancelRef = await backend.start(makeRunSpec({ runId: "r-cancel-fb" }));
    // Active turn guard for send()
    await expect(backend.send(cancelRef, "concurrent")).rejects.toThrow(/active turn/i);

    const streamPromise = collectAll(backend.events(cancelRef));
    await backend.cancel(cancelRef);
    await backend.cancel(cancelRef);
    const cancelEvents = await streamPromise;
    expect(stopFallback).toHaveBeenCalledWith(cancelRef.sessionId);
    expect(cancelEvents).toHaveLength(1);
    expect(cancelEvents[0]).toMatchObject({
      kind: "exit",
      reason: "cancelled",
      detail: "cli stop",
    });

    // 3. Fatal disconnect terminates active turn cleanly
    daemon.cancelError = null;
    daemon.enqueueTurnBehavior(() => {});
    const dcRef = await backend.start(makeRunSpec({ runId: "r-disconnect" }));
    const dcEventsPromise = collectAll(backend.events(dcRef));
    daemon.emitConnectionState({ status: "disconnected", reason: "Socket closed" });
    const dcEvents = await dcEventsPromise;
    expect(dcEvents).toHaveLength(1);
    expect(dcEvents[0]).toMatchObject({
      kind: "exit",
      reason: "failed",
      detail: "Socket closed",
    });

    // 4. V6 liveViewUrl construction
    expect(await backend.liveViewUrl(dcRef)).toBe(
      `paseo://h/srv_local_test/agent/${encodeURIComponent(dcRef.sessionId)}`,
    );
    daemon.serverInfo = { serverId: "   " };
    expect(await backend.liveViewUrl(dcRef)).toBeNull();

    // 5. Cancel timeout fallback when cancelAgent resolves without emitting turn_canceled
    daemon.emitCancelOnCancelAgent = false;
    daemon.enqueueTurnBehavior(() => {});
    const timeoutCancelRef = await backend.start(makeRunSpec({ runId: "r-cancel-timeout" }));
    const timeoutStream = collectAll(backend.events(timeoutCancelRef));
    await backend.cancel(timeoutCancelRef);
    const timeoutEvents = await timeoutStream;
    expect(timeoutEvents).toHaveLength(1);
    expect(timeoutEvents[0]).toMatchObject({ kind: "exit", reason: "cancelled" });

    // 6. Dispose tolerantly deletes all agents even if one throws
    daemon.deleteErrors.add(errRef.sessionId);
    await backend.dispose();
    expect(daemon.deletedAgents).toEqual(
      expect.arrayContaining([
        errRef.sessionId,
        cancelRef.sessionId,
        dcRef.sessionId,
        timeoutCancelRef.sessionId,
      ]),
    );
    expect(daemon.closeCalls).toBe(1);
    await expect(backend.send(cancelRef, "after dispose")).rejects.toThrow(/disposed/i);
  });
});

describe("PaseoBackend V9: Pi M0 probe usage replay, turnId deduplication & provider usage windows", () => {
  it("replays exact M0 Pi cumulative uncached lastUsage across two turns with zero negative cost", async () => {
    const daemon = new MockPaseoDaemon();
    const backend = createPaseoBackendForTest({ daemonClient: daemon });

    // Turn 1 from M0 RESULTS.md: turn_completed.usage=undefined, lastUsage={ in: 12365, cached: 104704, out: 482 }
    daemon.enqueueTurnBehavior(({ agentId, daemon: d }) => {
      d.setAgentLastUsage(agentId, {
        inputTokens: 12365,
        cachedInputTokens: 104704,
        outputTokens: 482,
        totalCostUsd: 0.003933224,
      });
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: "2026-11-19T12:00:01.000Z",
          event: {
            type: "timeline",
            provider: "pi",
            item: { type: "assistant_message", text: "NO_MCP" },
          },
        },
      });
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: "2026-11-19T12:00:02.000Z",
          event: {
            type: "turn_completed",
            provider: "pi",
            // Intentionally send explicit usage: null (exact Paseo 0.16.2 Pi payload) & omit turnId
            usage: null,
          },
        },
      });
    });

    // Turn 2 from M0 RESULTS.md: lastUsage={ in: 12581, cached: 128640, out: 484 }
    daemon.enqueueTurnBehavior(({ agentId, daemon: d }) => {
      d.setAgentLastUsage(agentId, {
        inputTokens: 12581,
        cachedInputTokens: 128640,
        outputTokens: 484,
        totalCostUsd: 0.00435192,
      });
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: "2026-11-19T12:00:03.000Z",
          event: {
            type: "timeline",
            provider: "pi",
            item: { type: "assistant_message", text: "OK" },
          },
        },
      });
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: "2026-11-19T12:00:04.000Z",
          event: {
            type: "turn_completed",
            provider: "pi",
          },
        },
      });
    });

    const ref = await backend.start(
      makeRunSpec({
        agent: "pi",
        model: "magpie/group/fast",
        role: "worker",
      }),
    );

    const turn1Events = await collectAll(backend.events(ref));
    expect(turn1Events.map((e) => e.kind)).toEqual(["message", "usage", "exit"]);
    const turn1Usage = turn1Events[1] as Extract<RunEvent, { kind: "usage" }>;
    expect(turn1Usage.inputTokens).toBe(117069);
    expect(turn1Usage.cachedInputTokens).toBe(104704);
    expect(turn1Usage.outputTokens).toBe(482);

    await backend.send(ref, "Reply with only the word OK.");
    const turn2Events = await collectAll(backend.events(ref));
    expect(turn2Events.map((e) => e.kind)).toEqual(["message", "usage", "exit"]);
    const turn2Usage = turn2Events[1] as Extract<RunEvent, { kind: "usage" }>;
    expect(turn2Usage.inputTokens).toBe(24152);
    expect(turn2Usage.cachedInputTokens).toBe(23936);
    expect(turn2Usage.outputTokens).toBe(2);
    expect(turn2Usage.turnId).not.toBe(turn1Usage.turnId);

    const pricing = { in: 1.25, cached: 0.125, out: 10.0 };
    const cost1 = calculateTurnCostUsd(turn1Usage, pricing);
    const cost2 = calculateTurnCostUsd(turn2Usage, pricing);
    expect(cost1).toBeGreaterThan(0);
    expect(cost2).toBeGreaterThan(0);
    // Uncached deltas: 12365 and 216
    expect(cost1).toBeCloseTo((12365 * 1.25 + 104704 * 0.125 + 482 * 10) / 1e6, 10);
    expect(cost2).toBeCloseTo((216 * 1.25 + 23936 * 0.125 + 2 * 10) / 1e6, 10);

    await backend.dispose();
  });

  it("deduplicates repeated turnIds and normalizes direct uncached-only usage defensively", () => {
    const state = createSessionUsageState();
    const u1 = normalizeTurnUsage({
      provider: "codex",
      model: "gpt-6-luna",
      agentId: "agent-99",
      rawUsage: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 10 },
      source: "turn_completed",
      state,
      candidateTurnIds: ["dup-turn"],
    });
    const u2 = normalizeTurnUsage({
      provider: "custom-provider",
      model: "custom-model",
      agentId: "agent-99",
      // cachedInputTokens > inputTokens triggers defensive normalization
      rawUsage: { inputTokens: 50, cachedInputTokens: 200, outputTokens: 5 },
      source: "turn_completed",
      state,
      candidateTurnIds: ["dup-turn"],
    });

    expect(u1?.turnId).toBe("dup-turn");
    expect(u2?.turnId).toBe("agent-99-turn-1");
    expect(u2?.inputTokens).toBe(250);
    expect(u2?.cachedInputTokens).toBe(200);
    expect(
      calculateTurnCostUsd(u2!, { in: 1.25, cached: 0.125, out: 10.0 }),
    ).toBeGreaterThanOrEqual(0);
  });

  it("reads compact quota windows via listProviderUsage() when feature is enabled and returns [] otherwise", async () => {
    const daemon = new MockPaseoDaemon();
    daemon.providerUsageResponse = {
      requestId: "u-1",
      fetchedAt: "2026-11-19T12:00:00.000Z",
      providers: [
        {
          providerId: "codex",
          displayName: "Codex",
          status: "available",
          planLabel: "Plus",
          windows: [
            {
              id: "weekly",
              label: "Weekly Limit",
              shortLabel: "7d",
              usedPct: 42,
              remainingPct: 58,
              resetsAt: "2026-11-26T00:00:00.000Z",
              tone: "ok",
            },
          ],
        },
        {
          providerId: "pi",
          displayName: "Pi",
          status: "unavailable",
          planLabel: null,
          windows: [],
        },
      ],
    };

    const backend = createPaseoBackendForTest({ daemonClient: daemon });
    const windows = await backend.listProviderUsage();
    expect(windows).toEqual([
      {
        providerId: "codex",
        displayName: "Codex",
        status: "available",
        planLabel: "Plus",
        windowId: "weekly",
        label: "Weekly Limit",
        shortLabel: "7d",
        usedPct: 42,
        remainingPct: 58,
        resetsAt: "2026-11-26T00:00:00.000Z",
        tone: "ok",
      },
    ]);

    daemon.serverInfo = {
      serverId: "srv_legacy",
      features: { providerUsageList: false },
    };
    expect(await backend.listProviderUsage()).toEqual([]);

    await backend.dispose();
  });
});

describe("PaseoBackend Round 1 review fixes: isolation, observations, reconnect recovery & tool_call states", () => {
  it("keeps the public paseo barrel clean without leaking test/wire helpers", () => {
    expect(Object.keys(publicPaseoExports)).toEqual(["PaseoBackend"]);
  });

  it("registers observeEvents and observeAgents on connect and releases both on dispose", async () => {
    const daemonWithBg = new MockPaseoDaemon({
      serverInfo: { serverId: "srv_bg", features: { backgroundWorkspaces: true } },
    });
    const bgBackend = createPaseoBackendForTest({ daemonClient: daemonWithBg });
    await bgBackend.connect();

    expect(daemonWithBg.observeEventsCalls).toEqual([
      ["agent_permission_request", "agent_permission_resolved", "providers_snapshot_update"],
    ]);
    expect(daemonWithBg.observeAgentsCalls).toEqual([{ includeBackground: true }]);

    await bgBackend.dispose();
    expect(daemonWithBg.releasedObservations).toEqual(["events", "agents"]);

    const daemonNoBg = new MockPaseoDaemon({
      serverInfo: { serverId: "srv_no_bg", features: { backgroundWorkspaces: false } },
    });
    const noBgBackend = createPaseoBackendForTest({ daemonClient: daemonNoBg });
    await noBgBackend.listAgents();
    expect(daemonNoBg.observeAgentsCalls).toEqual([undefined]);
    await noBgBackend.dispose();
    expect(daemonNoBg.releasedObservations).toEqual(["events", "events", "agents"]);
  });

  it("applies disconnectGraceMs to reconnectable disconnects and reconciles if connection returns", async () => {
    const failDaemon = new MockPaseoDaemon();
    const failBackend = createPaseoBackendForTest({
      daemonClient: failDaemon,
      disconnectGraceMs: 35,
    });
    failDaemon.enqueueTurnBehavior(() => {
      // Simulate daemon disappearing before emitting turn_completed.
    });
    const failRef = await failBackend.start(makeRunSpec({ runId: "r-disc-fail" }));
    failDaemon.emitConnectionState({
      status: "disconnected",
      reason: "ws closed unexpectedly",
      nextRetryAt: new Date(Date.now() + 5_000).toISOString(),
    });
    const failedEvents = await collectAll(failBackend.events(failRef));
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({
      kind: "exit",
      reason: "failed",
      detail: "ws closed unexpectedly",
    });
    await failBackend.dispose();

    const recoverDaemon = new MockPaseoDaemon();
    const recoverBackend = createPaseoBackendForTest({
      daemonClient: recoverDaemon,
      disconnectGraceMs: 500,
    });
    recoverDaemon.enqueueTurnBehavior(() => {
      // Turn will complete on host while disconnected.
    });
    const recoverRef = await recoverBackend.start(makeRunSpec({ runId: "r-disc-rec" }));
    recoverDaemon.emitConnectionState({
      status: "disconnected",
      reason: "transient drop",
      nextRetryAt: new Date(Date.now() + 5_000).toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    recoverDaemon.setAgentSnapshot(recoverRef.sessionId, {
      status: "idle",
      activeTurn: null,
      lastUsage: { inputTokens: 60, cachedInputTokens: 10, outputTokens: 15 },
    });
    recoverDaemon.emitConnectionState({ status: "connected" });

    const recoveredEvents = await collectAll(recoverBackend.events(recoverRef));
    expect(recoveredEvents.map((e) => e.kind)).toEqual(["usage", "exit"]);
    expect(recoveredEvents[0]).toMatchObject({
      kind: "usage",
      inputTokens: 60,
      cachedInputTokens: 10,
      outputTokens: 15,
    });
    expect(recoveredEvents[1]).toMatchObject({ kind: "exit", reason: "completed" });
    await recoverBackend.dispose();
  });

  it("reconciles missed turn results on agent.timeline.subscription_restored and replacement", async () => {
    const daemon = new MockPaseoDaemon();
    const backend = createPaseoBackendForTest({ daemonClient: daemon });

    daemon.enqueueTurnBehavior(({ agentId, daemon: d }) => {
      d.setAgentSnapshot(agentId, {
        status: "idle",
        activeTurn: null,
        lastUsage: { inputTokens: 90, cachedInputTokens: 20, outputTokens: 12 },
      });
      d.emitTimeline(agentId, {
        type: "agent.timeline.subscription_restored",
        payload: { agentId, subscriptionId: "sub-restored" },
      });
    });

    const restoredRef = await backend.start(makeRunSpec({ runId: "r-tl-restored" }));
    const restoredEvents = await collectAll(backend.events(restoredRef));
    expect(restoredEvents.map((e) => e.kind)).toEqual(["usage", "exit"]);
    expect(restoredEvents[1]).toMatchObject({ kind: "exit", reason: "completed" });

    daemon.enqueueTurnBehavior(({ agentId, daemon: d }) => {
      d.setAgentSnapshot(agentId, {
        status: "error",
        lastError: "worker crashed across epoch replacement",
      });
      d.emitTimeline(agentId, {
        type: "agent.timeline.replacement",
        payload: { agentId, epoch: "epoch-2" },
      });
    });

    const replacedRef = await backend.start(makeRunSpec({ runId: "r-tl-replaced" }));
    const replacedEvents = await collectAll(backend.events(replacedRef));
    expect(replacedEvents).toHaveLength(1);
    expect(replacedEvents[0]).toMatchObject({
      kind: "exit",
      reason: "failed",
      detail: "worker crashed across epoch replacement",
    });

    await backend.dispose();
  });

  it("defers write/edit tool_call mapping until terminal status so failed/canceled do not emit file_write", async () => {
    const daemon = new MockPaseoDaemon();
    const backend = createPaseoBackendForTest({ daemonClient: daemon });

    daemon.enqueueTurnBehavior(({ agentId, daemon: d }) => {
      const at = new Date().toISOString();
      // Transition 1: write starts running then fails -> must emit tool, never file_write
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: at,
          event: {
            type: "timeline",
            provider: "codex",
            item: {
              type: "tool_call",
              callId: "c-write-fail",
              name: "write_file",
              status: "running",
              error: null,
              detail: { type: "write", filePath: "src/denied.ts" },
            },
          },
        },
      });
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: at,
          event: {
            type: "timeline",
            provider: "codex",
            item: {
              type: "tool_call",
              callId: "c-write-fail",
              name: "write_file",
              status: "failed",
              error: "permission denied",
              detail: { type: "write", filePath: "src/denied.ts" },
            },
          },
        },
      });
      // Transition 2: edit starts running then is canceled -> must emit tool, never file_write
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: at,
          event: {
            type: "timeline",
            provider: "codex",
            item: {
              type: "tool_call",
              callId: "c-edit-cancel",
              name: "edit_file",
              status: "running",
              error: null,
              detail: { type: "edit", filePath: "src/aborted.ts" },
            },
          },
        },
      });
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: at,
          event: {
            type: "timeline",
            provider: "codex",
            item: {
              type: "tool_call",
              callId: "c-edit-cancel",
              name: "edit_file",
              status: "canceled",
              error: null,
              detail: { type: "edit", filePath: "src/aborted.ts" },
            },
          },
        },
      });
      // Transition 3: write starts running then completes -> must emit single file_write
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: at,
          event: {
            type: "timeline",
            provider: "codex",
            item: {
              type: "tool_call",
              callId: "c-write-ok",
              name: "write_file",
              status: "running",
              error: null,
              detail: { type: "write", filePath: "src/ok.ts" },
            },
          },
        },
      });
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: at,
          event: {
            type: "timeline",
            provider: "codex",
            item: {
              type: "tool_call",
              callId: "c-write-ok",
              name: "write_file",
              status: "completed",
              error: null,
              detail: { type: "write", filePath: "src/ok.ts" },
            },
          },
        },
      });
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: at,
          event: {
            type: "turn_completed",
            provider: "codex",
            turnId: "t-tools",
            usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
          },
        },
      });
    });

    const ref = await backend.start(makeRunSpec({ runId: "r-tool-states" }));
    const events = await collectAll(backend.events(ref));
    expect(events.map((e) => e.kind)).toEqual(["tool", "tool", "file_write", "usage", "exit"]);
    expect(events[0]).toMatchObject({
      kind: "tool",
      name: "write_file",
      target: "src/denied.ts",
    });
    expect(events[1]).toMatchObject({
      kind: "tool",
      name: "edit_file",
      target: "src/aborted.ts",
    });
    expect(events[2]).toMatchObject({ kind: "file_write", path: "src/ok.ts" });

    await backend.dispose();
  });

  it("normalizes case/whitespace-varied runSpec.agent to entry.provider for createAgent and Pi usage delta", async () => {
    const daemon = new MockPaseoDaemon();
    const backend = createPaseoBackendForTest({ daemonClient: daemon });

    daemon.enqueueTurnBehavior(({ agentId, daemon: d }) => {
      d.setAgentLastUsage(agentId, {
        inputTokens: 1000,
        cachedInputTokens: 400,
        outputTokens: 50,
      });
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: new Date().toISOString(),
          event: { type: "turn_completed", provider: "pi", usage: null },
        },
      });
    });

    daemon.enqueueTurnBehavior(({ agentId, daemon: d }) => {
      d.setAgentLastUsage(agentId, {
        inputTokens: 1300,
        cachedInputTokens: 600,
        outputTokens: 70,
      });
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: new Date().toISOString(),
          event: { type: "turn_completed", provider: "pi", usage: null },
        },
      });
    });

    const ref = await backend.start(
      makeRunSpec({
        agent: "  PI  ",
        model: "magpie/group/fast",
        role: "worker",
      }),
    );

    expect(daemon.createdOptions[0]?.config.provider).toBe("pi");
    expect(ref.meta?.agent).toBe("pi");
    // Uncached Pi normalization: inputTotal = 1000 + 400 = 1400, cached = 400, output = 50
    const t1 = await collectAll(backend.events(ref));
    expect(t1[0]).toMatchObject({
      kind: "usage",
      inputTokens: 1400,
      cachedInputTokens: 400,
      outputTokens: 50,
    });

    await backend.send(ref, "turn 2");
    // Turn 2 delta: (1300 - 1000) + (600 - 400) = 500 input, 200 cached, 20 output
    const t2 = await collectAll(backend.events(ref));
    expect(t2[0]).toMatchObject({
      kind: "usage",
      inputTokens: 500,
      cachedInputTokens: 200,
      outputTokens: 20,
    });

    await backend.dispose();
  });

  it("never caches or admits status='loading' snapshots that would bypass mode/full-access guards or empty listModels", async () => {
    const loadingProviders: PaseoProviderSnapshotEntry[] = [
      { provider: "codex", status: "loading", enabled: true, modes: [], models: [] },
      { provider: "antigravity", status: "loading", enabled: true, modes: [], models: [] },
    ];

    // A. Fallback snapshot client still returning loading entries excludes them completely
    const legacyDaemon = new MockPaseoDaemon({ providers: loadingProviders });
    const legacyClient: PaseoDaemonLike = {
      connect: () => legacyDaemon.connect(),
      close: () => legacyDaemon.close(),
      getLastServerInfoMessage: () => legacyDaemon.getLastServerInfoMessage(),
      getProvidersSnapshot: () => legacyDaemon.getProvidersSnapshot(),
      createAgent: (opts) => legacyDaemon.createAgent(opts),
      fetchAgent: (opts) => legacyDaemon.fetchAgent(opts),
      deleteAgent: (id) => legacyDaemon.deleteAgent(id),
      sendAgentMessage: (id, text) => legacyDaemon.sendAgentMessage(id, text),
      cancelAgent: (id) => legacyDaemon.cancelAgent(id),
      respondToPermission: (id, reqId, res) => legacyDaemon.respondToPermission(id, reqId, res),
      subscribe: (h) => legacyDaemon.subscribe(h),
      subscribeAgentTimeline: (id, h) => legacyDaemon.subscribeAgentTimeline(id, h),
    };
    const legacyBackend = createPaseoBackendForTest({ daemonClient: legacyClient });
    expect(await legacyBackend.listAgents()).toEqual([]);
    await expect(
      legacyBackend.start(makeRunSpec({ agent: "antigravity", model: "gemini-3-pro" })),
    ).rejects.toThrow(/Unknown agent/);
    await legacyBackend.dispose();

    // B. Real observeEvents flow: loading update pushed before waitForReady must wait for ready snapshot
    const daemon = new MockPaseoDaemon({ providers: loadingProviders });
    const backend = createPaseoBackendForTest({ daemonClient: daemon });

    await backend.connect();
    daemon.emitDaemonEvent({
      type: "providers_snapshot_update",
      payload: { entries: structuredClone(loadingProviders) },
    });

    const readyTimer = setTimeout(() => {
      daemon.providers = structuredClone(DEFAULT_MOCK_PROVIDERS);
      daemon.emitDaemonEvent({
        type: "providers_snapshot_update",
        payload: { entries: structuredClone(DEFAULT_MOCK_PROVIDERS) },
      });
    }, 15);

    try {
      const models = await backend.listModels("codex");
      expect(models.map((m) => m.id)).toEqual(["gpt-6-luna"]);
    } finally {
      clearTimeout(readyTimer);
    }

    // C. Subsequent loading refresh MUST NOT overwrite cached ready entries with empty modes
    daemon.emitDaemonEvent({
      type: "providers_snapshot_update",
      payload: { entries: structuredClone(loadingProviders) },
    });
    await expect(
      backend.start(makeRunSpec({ agent: "antigravity", model: "gemini-3-pro" })),
    ).rejects.toBeInstanceOf(FullAccessOnlyProviderError);

    const codexRef = await backend.start(makeRunSpec({ agent: "codex" }));
    expect(codexRef.meta?.modeId).toBe("auto");
    await collectAll(backend.events(codexRef));

    await backend.dispose();
  });

  it("preserves turn across reconnectable disconnect during Pi fetchAgent and reconciles on reconnect", async () => {
    const daemon = new MockPaseoDaemon();
    const backend = createPaseoBackendForTest({
      daemonClient: daemon,
      disconnectGraceMs: 500,
    });

    let failFetchOnce = true;
    const origFetchAgent = daemon.fetchAgent.bind(daemon);
    daemon.fetchAgent = async (opts) => {
      if (failFetchOnce) {
        failFetchOnce = false;
        daemon.emitConnectionState({
          status: "disconnected",
          reason: "socket dropped during fetchAgent",
          nextRetryAt: new Date(Date.now() + 5_000).toISOString(),
        });
        throw new Error("Connection lost");
      }
      return origFetchAgent(opts);
    };

    daemon.enqueueTurnBehavior(({ agentId, daemon: d }) => {
      d.setAgentLastUsage(agentId, {
        inputTokens: 1000,
        cachedInputTokens: 200,
        outputTokens: 40,
      });
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: new Date().toISOString(),
          event: { type: "turn_completed", provider: "pi", usage: null },
        },
      });
    });

    const ref = await backend.start(
      makeRunSpec({ agent: "pi", model: "magpie/group/fast", role: "worker" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    daemon.setAgentSnapshot(ref.sessionId, { status: "idle", activeTurn: null });
    daemon.emitConnectionState({ status: "connected" });

    const events = await collectAll(backend.events(ref));
    expect(events.map((e) => e.kind)).toEqual(["usage", "exit"]);
    expect(events[0]).toMatchObject({
      kind: "usage",
      inputTokens: 1200,
      cachedInputTokens: 200,
      outputTokens: 40,
    });
    expect(events[1]).toMatchObject({ kind: "exit", reason: "completed" });
    await backend.dispose();
  });

  it("ignores idle reconciliation before sendAgentMessage has dispatched the turn", async () => {
    const daemon = new MockPaseoDaemon();
    const backend = createPaseoBackendForTest({ daemonClient: daemon });

    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });

    const origSend = daemon.sendAgentMessage.bind(daemon);
    daemon.sendAgentMessage = async (agentId, text) => {
      // Simulate stale idle snapshot + subscription_restored arriving while prompt dispatch is in flight
      daemon.setAgentSnapshot(agentId, {
        status: "idle",
        activeTurn: null,
        lastUsage: { inputTokens: 999, cachedInputTokens: 0, outputTokens: 99 },
      });
      daemon.emitTimeline(agentId, {
        type: "agent.timeline.subscription_restored",
        payload: { agentId, subscriptionId: "sub-early" },
      });
      await sendGate;
      return origSend(agentId, text);
    };

    daemon.enqueueTurnBehavior(({ agentId, daemon: d }) => {
      d.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: new Date().toISOString(),
          event: {
            type: "turn_completed",
            provider: "codex",
            turnId: "real-turn-after-dispatch",
            usage: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 3 },
          },
        },
      });
    });

    const startPromise = backend.start(makeRunSpec({ runId: "r-predispatch" }));
    await new Promise((resolve) => setTimeout(resolve, 15));
    releaseSend();
    const ref = await startPromise;

    const events = await collectAll(backend.events(ref));
    expect(events.map((e) => e.kind)).toEqual(["usage", "exit"]);
    expect(events[0]).toMatchObject({
      kind: "usage",
      turnId: "real-turn-after-dispatch",
      inputTokens: 12,
      cachedInputTokens: 2,
      outputTokens: 3,
    });
    await backend.dispose();
  });

  it("refreshProviders() triggers daemon refreshProvidersSnapshot and updates cached models", async () => {
    const daemon = new MockPaseoDaemon();
    const backend = createPaseoBackendForTest({ daemonClient: daemon });

    expect((await backend.listModels("pi")).map((m) => m.id)).toEqual(["magpie/group/fast"]);

    daemon.onRefreshSnapshot = () => {
      const piEntry = daemon.providers.find((p) => p.provider === "pi")!;
      piEntry.models = [
        ...(piEntry.models ?? []),
        {
          provider: "pi",
          id: "magpie/group/strong",
          label: "Magpie Strong",
          thinkingOptions: [{ id: "high", label: "High" }],
          defaultThinkingOptionId: "high",
        },
      ];
    };

    await backend.refreshProviders();
    expect(daemon.refreshSnapshotCalls).toBe(1);
    expect((await backend.listModels("pi")).map((m) => m.id)).toEqual([
      "magpie/group/fast",
      "magpie/group/strong",
    ]);

    await backend.dispose();
  });

  it("captures providerSessionId and providerSessionPath from createAgent, thread_started, agent_update, and fetchAgent fallback without duplicate session_bound events", async () => {
    const daemon = new MockPaseoDaemon();
    const backend = createPaseoBackendForTest({ daemonClient: daemon });

    // Source 1: createAgent snapshot persistence (+ duplicate agent_update must stay idempotent)
    daemon.createPersistenceHook = () => ({
      provider: "pi",
      sessionId: "pi-internal-01",
      nativeHandle: "pi-native-01",
      metadata: {
        sessionFile: "/tmp/kiln-pi/pi-native-01.jsonl",
      },
    });
    daemon.enqueueTurnBehavior(async ({ agentId, turnNumber, runtime }) => {
      daemon.emitDaemonEvent({
        type: "agent_update",
        agentId,
        payload: {
          kind: "upsert",
          agent: {
            ...runtime.snapshot,
            persistence: {
              provider: "pi",
              sessionId: "pi-internal-01",
              nativeHandle: "pi-native-01",
              metadata: { sessionFile: "/tmp/kiln-pi/pi-native-01.jsonl" },
            },
          },
        },
      });
      daemon.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: "2026-11-22T09:00:02.000Z",
          event: {
            type: "turn_completed",
            provider: "pi",
            turnId: `pi-t${turnNumber}`,
            usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
          },
        },
      });
    });

    const piRef = await backend.start(makeRunSpec({ agent: "pi", model: "magpie/group/fast" }));
    expect(piRef.meta?.providerSessionId).toBe("pi-native-01");
    expect(piRef.meta?.providerSessionPath).toBe("/tmp/kiln-pi/pi-native-01.jsonl");
    const piEvents = await collectAll(backend.events(piRef));
    expect(piEvents.filter((e) => e.kind === "session_bound")).toEqual([
      expect.objectContaining({
        kind: "session_bound",
        providerSessionId: "pi-native-01",
        providerSessionPath: "/tmp/kiln-pi/pi-native-01.jsonl",
      }),
    ]);

    // Source 2: stream thread_started event
    daemon.createPersistenceHook = undefined;
    daemon.enqueueTurnBehavior(async ({ agentId, turnNumber }) => {
      daemon.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: "2026-11-22T09:01:00.000Z",
          event: {
            type: "thread_started",
            provider: "codex",
            sessionId: "codex-thread-abc123",
          },
        },
      });
      daemon.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: "2026-11-22T09:01:02.000Z",
          event: {
            type: "turn_completed",
            provider: "codex",
            turnId: `codex-t${turnNumber}`,
            usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
          },
        },
      });
    });
    const threadRef = await backend.start(makeRunSpec({ agent: "codex" }));
    const threadEvents = await collectAll(backend.events(threadRef));
    expect(threadEvents.find((e) => e.kind === "session_bound")).toMatchObject({
      kind: "session_bound",
      providerSessionId: "codex-thread-abc123",
    });

    // Source 3: agent_update upsert
    daemon.enqueueTurnBehavior(async ({ agentId, turnNumber, runtime }) => {
      daemon.emitDaemonEvent({
        type: "agent_update",
        agentId,
        payload: {
          kind: "upsert",
          agent: {
            ...runtime.snapshot,
            persistence: {
              provider: "codex",
              sessionId: "codex-upsert-raw",
              nativeHandle: "codex-upsert-77",
            },
          },
        },
      });
      daemon.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: "2026-11-22T09:02:02.000Z",
          event: {
            type: "turn_completed",
            provider: "codex",
            turnId: `codex-u${turnNumber}`,
            usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
          },
        },
      });
    });
    const upsertRef = await backend.start(makeRunSpec({ agent: "codex" }));
    const upsertEvents = await collectAll(backend.events(upsertRef));
    expect(upsertEvents.find((e) => e.kind === "session_bound")).toMatchObject({
      kind: "session_bound",
      providerSessionId: "codex-upsert-77",
    });

    // Source 4: completeTurnFromFetchedAgent fallback on turn_completed without usage
    daemon.enqueueTurnBehavior(async ({ agentId, turnNumber }) => {
      daemon.setAgentSnapshot(agentId, {
        persistence: {
          provider: "pi",
          sessionId: "pi-fetch-9",
          metadata: { sessionPath: "/tmp/kiln-pi/fetch-9.jsonl" },
        },
      });
      daemon.setAgentLastUsage(agentId, {
        inputTokens: 15,
        cachedInputTokens: 3,
        outputTokens: 5,
      });
      daemon.emitTimeline(agentId, {
        type: "agent_stream",
        payload: {
          agentId,
          timestamp: "2026-11-22T09:03:02.000Z",
          event: {
            type: "turn_completed",
            provider: "pi",
            turnId: `pi-fetch-${turnNumber}`,
          },
        },
      });
    });
    const fetchRef = await backend.start(makeRunSpec({ agent: "pi", model: "magpie/group/fast" }));
    const fetchEvents = await collectAll(backend.events(fetchRef));
    expect(fetchEvents.map((e) => e.kind)).toEqual(["session_bound", "usage", "exit"]);
    expect(fetchEvents[0]).toMatchObject({
      kind: "session_bound",
      providerSessionId: "pi-fetch-9",
      providerSessionPath: "/tmp/kiln-pi/fetch-9.jsonl",
    });

    await backend.dispose();
  });
});
