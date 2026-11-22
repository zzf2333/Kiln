import { randomUUID } from "node:crypto";
import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  type BackendCapabilities,
  isRoleAllowedForTool,
  MCP_TOOL_NAMES,
  type ReasoningEffort,
  ReasoningEffortSchema,
  type RoleId,
  type RunEvent,
  RunEventSchema,
  type SessionRef,
} from "@kiln/protocol";
import {
  type ApprovalHandler,
  type ApprovalRequestEvent,
  assertRoleAgentEligible,
  type BackendAgentDescriptor,
  type BackendModeDescriptor,
  type BackendModelDescriptor,
  type BackendRunSpec,
  type ExecutionBackend,
  FullAccessOnlyProviderError,
  isFullAccessMode,
  selectSafeModeId,
  type SessionProbeResult,
} from "../types.js";
import type {
  PaseoAgentCapabilityFlags,
  PaseoAgentModel,
  PaseoAgentSnapshot,
  PaseoAgentStreamEvent,
  PaseoApiLike,
  PaseoBackendInternalOptions,
  PaseoBackendPublicOptions,
  PaseoConnectionState,
  PaseoCreateAgentOptions,
  PaseoDaemonEvent,
  PaseoDaemonLike,
  PaseoMcpStdioServerConfig,
  PaseoObservationHandle,
  PaseoPermissionRequest,
  PaseoPermissionResponse,
  PaseoProviderSnapshotEntry,
  PaseoProviderUsageWindow,
  PaseoTimelineMessage,
  PaseoTimelineSubscription,
  PaseoToolCallDetail,
} from "./types.js";
import {
  createSessionUsageState,
  hasAnyTokenCounter,
  normalizeTurnUsage,
  type SessionUsageState,
} from "./usage-normalizer.js";

// Compile-time proof that real @getpaseo/client types satisfy our narrow structural interfaces.
type _AssertDaemonAssignable = DaemonClient extends PaseoDaemonLike ? true : never;
type _AssertApiAssignable = PaseoApi extends PaseoApiLike ? true : never;
const _assertDaemonAssignable: _AssertDaemonAssignable = true;
const _assertApiAssignable: _AssertApiAssignable = true;
void _assertDaemonAssignable;
void _assertApiAssignable;

const DEFAULT_PASEO_URL = "ws://127.0.0.1:6767/ws";
const DEFAULT_CANCEL_TIMEOUT_MS = 3_000;
const DEFAULT_DISCONNECT_GRACE_MS = 15_000;
const DEFAULT_PROVIDER_READY_TIMEOUT_MS = 30_000;

const INTERNAL_OVERRIDES = new WeakMap<
  PaseoBackendPublicOptions,
  Pick<PaseoBackendInternalOptions, "daemonClient" | "api">
>();

const PROVIDER_FALLBACK_CAPABILITIES: Readonly<Record<string, BackendCapabilities>> = {
  codex: {
    interactiveChat: true,
    approvals: false,
    mcpInjection: true,
    usageCacheBreakdown: true,
    interrupt: true,
  },
  claude: {
    interactiveChat: true,
    approvals: false,
    mcpInjection: true,
    usageCacheBreakdown: true,
    interrupt: true,
  },
  opencode: {
    interactiveChat: true,
    approvals: false,
    mcpInjection: true,
    usageCacheBreakdown: true,
    interrupt: true,
  },
  pi: {
    interactiveChat: true,
    approvals: false,
    mcpInjection: false,
    usageCacheBreakdown: true,
    interrupt: true,
  },
  antigravity: {
    interactiveChat: true,
    approvals: false,
    mcpInjection: false,
    usageCacheBreakdown: false,
    interrupt: true,
  },
};

const UNKNOWN_PROVIDER_CAPABILITIES: BackendCapabilities = {
  interactiveChat: true,
  approvals: false,
  mcpInjection: false,
  usageCacheBreakdown: false,
  interrupt: true,
};

interface TurnState {
  turnId: string;
  turnNumber: number;
  providerTurnId: string | null;
  events: RunEvent[];
  finished: boolean;
  completing: boolean;
  reconciling: boolean;
  dispatched: boolean;
  waiters: Set<() => void>;
  seenToolCallIds: Set<string>;
  completionPromise: Promise<void>;
  resolveCompletion: () => void;
  cancelPromise: Promise<void> | null;
}

interface SessionState {
  agentId: string;
  canonicalProvider: string;
  sessionRef: SessionRef;
  runSpec: BackendRunSpec;
  status: "running" | "idle" | "closed";
  activeTurnId: string | null;
  turnSeq: number;
  currentTurn: TurnState | null;
  timelineSub: PaseoTimelineSubscription | null;
  usageState: SessionUsageState;
}

interface PendingApproval {
  id: string;
  agentId: string;
  sessionId: string;
}

function cloneSessionRef(ref: SessionRef): SessionRef {
  return {
    backendId: ref.backendId,
    sessionId: ref.sessionId,
    ...(ref.meta ? { meta: { ...ref.meta } } : {}),
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

function toBackendModeDescriptor(mode: {
  id: string;
  label: string;
  description?: string;
}): BackendModeDescriptor {
  const desc: BackendModeDescriptor = {
    id: mode.id,
    label: mode.label,
    ...(mode.description !== undefined ? { description: mode.description } : {}),
  };
  if (isFullAccessMode(desc)) {
    desc.isFullAccess = true;
  }
  return desc;
}

function toBackendModelDescriptor(model: PaseoAgentModel): BackendModelDescriptor {
  const thinkingOptions: ReasoningEffort[] = [];
  for (const option of model.thinkingOptions ?? []) {
    const parsed = ReasoningEffortSchema.safeParse(option.id);
    if (parsed.success && !thinkingOptions.includes(parsed.data)) {
      thinkingOptions.push(parsed.data);
    }
  }

  const parsedDefault =
    model.defaultThinkingOptionId !== undefined
      ? ReasoningEffortSchema.safeParse(model.defaultThinkingOptionId)
      : null;

  return {
    id: model.id,
    label: model.label,
    ...(model.description !== undefined ? { description: model.description } : {}),
    thinkingOptions,
    ...(parsedDefault?.success ? { defaultThinkingOptionId: parsedDefault.data } : {}),
  };
}

function extractToolTarget(detail: PaseoToolCallDetail): string | undefined {
  let raw: string | undefined;
  switch (detail.type) {
    case "shell":
      raw = detail.command;
      break;
    case "read":
    case "edit":
    case "write":
      raw = detail.filePath;
      break;
    case "search":
      raw = detail.query;
      break;
    case "fetch":
      raw = detail.url;
      break;
    case "worktree_setup":
      raw = detail.worktreePath;
      break;
    case "plain_text":
      raw = detail.label ?? detail.text;
      break;
    default:
      raw = undefined;
  }
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function formatPermissionDetail(request: PaseoPermissionRequest): string {
  const detail = request.detail;
  if (detail) {
    const target = extractToolTarget(detail);
    if (target !== undefined) {
      return target;
    }
  }
  if (request.description && request.description.length > 0) {
    return request.description;
  }
  if (request.title && request.title.length > 0) {
    return request.title;
  }
  if (detail) {
    return JSON.stringify(detail);
  }
  if (request.input) {
    return JSON.stringify(request.input);
  }
  return request.kind;
}

function hasObserveEvents(client: PaseoDaemonLike): boolean {
  return typeof (client as Partial<DaemonClient>).observeEvents === "function";
}

function createPaseoApiAdapter(
  daemonClient: PaseoDaemonLike,
  explicitApi?: PaseoApiLike,
): PaseoApiLike {
  if (explicitApi) {
    return explicitApi;
  }
  if (hasObserveEvents(daemonClient)) {
    return createPaseoApi(daemonClient as unknown as DaemonClient);
  }
  return {
    providers: {
      waitForReady: (options) =>
        daemonClient.getProvidersSnapshot(
          options?.cwd !== undefined ? { cwd: options.cwd } : undefined,
        ),
      ...(daemonClient.refreshProvidersSnapshot
        ? {
            refresh: (options) => daemonClient.refreshProvidersSnapshot!(options),
          }
        : {}),
      listUsage: (options) => {
        if (!daemonClient.listProviderUsage) {
          return Promise.reject(new Error("Provider usage listing is not supported"));
        }
        return daemonClient.listProviderUsage(options);
      },
    },
  };
}

export function createPaseoBackendForTest(options: PaseoBackendInternalOptions): PaseoBackend {
  const { daemonClient, api, ...publicOptions } = options;
  const passThrough: PaseoBackendPublicOptions = { ...publicOptions };
  if (daemonClient !== undefined || api !== undefined) {
    INTERNAL_OVERRIDES.set(passThrough, { daemonClient, api });
  }
  return new PaseoBackend(passThrough);
}

/**
 * ExecutionBackend adapter for Paseo 0.16.2 (`@getpaseo/client`).
 * Reuses a single DaemonClient/WebSocket connection across provider discovery,
 * session execution, timeline streaming, approvals, interruption, and usage collection.
 */
export class PaseoBackend implements ExecutionBackend {
  readonly backendId: string;

  private readonly daemonClient: PaseoDaemonLike;
  private readonly api: PaseoApiLike;
  private readonly stopFallback?: (agentId: string) => Promise<void>;
  private readonly cancelTimeoutMs: number;
  private readonly disconnectGraceMs: number;
  private readonly providerReadyTimeoutMs: number;
  private readonly preapprovedToolsByRole?: Partial<Record<RoleId, readonly string[]>>;

  private readonly providerCache = new Map<string, PaseoProviderSnapshotEntry>();
  private readonly agentCapabilitiesCache = new Map<string, PaseoAgentCapabilityFlags>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly approvalHandlers = new Set<ApprovalHandler>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly seenPermissionIds = new Set<string>();

  private daemonUnsubscribe: (() => void) | null = null;
  private connectionUnsubscribe: (() => void) | null = null;
  private eventsObservation: PaseoObservationHandle | null = null;
  private agentsObservation: PaseoObservationHandle | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectableDisconnect = false;
  private connectPromise: Promise<void> | null = null;
  private connectedOnce = false;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(options?: PaseoBackendPublicOptions) {
    const internal = options ? INTERNAL_OVERRIDES.get(options) : undefined;
    if (options && internal) {
      INTERNAL_OVERRIDES.delete(options);
    }

    this.backendId = options?.backendId ?? "paseo";
    this.stopFallback = options?.stopFallback;
    this.cancelTimeoutMs = options?.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
    this.disconnectGraceMs = Math.max(0, options?.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS);
    this.providerReadyTimeoutMs =
      options?.providerReadyTimeoutMs ?? DEFAULT_PROVIDER_READY_TIMEOUT_MS;
    this.preapprovedToolsByRole = options?.preapprovedToolsByRole;

    if (internal?.daemonClient) {
      this.daemonClient = internal.daemonClient;
    } else {
      const url = options?.url ?? process.env.PASEO_URL ?? DEFAULT_PASEO_URL;
      const clientId = options?.clientId ?? `kiln-paseo-${randomUUID()}`;
      this.daemonClient = new DaemonClient({
        url,
        clientId,
        clientType: "cli",
        ...(options?.password !== undefined ? { password: options.password } : {}),
        ...(options?.authHeader !== undefined ? { authHeader: options.authHeader } : {}),
        ...(options?.connectTimeoutMs !== undefined
          ? { connectTimeoutMs: options.connectTimeoutMs }
          : {}),
        ...(options?.reconnect !== undefined ? { reconnect: options.reconnect } : {}),
      });
    }

    this.api = createPaseoApiAdapter(this.daemonClient, internal?.api);

    this.daemonUnsubscribe = this.daemonClient.subscribe((event) => {
      this.handleDaemonEvent(event);
    });
    if (this.daemonClient.subscribeConnectionStatus) {
      this.connectionUnsubscribe = this.daemonClient.subscribeConnectionStatus((state) => {
        this.handleConnectionState(state);
      });
    }
  }

  /**
   * Explicitly establishes the single underlying Paseo daemon connection.
   */
  async connect(): Promise<void> {
    await this.ensureConnected();
  }

  async listAgents(): Promise<BackendAgentDescriptor[]> {
    this.assertNotDisposed();
    await this.ensureConnected();
    const snapshot = await this.api.providers.waitForReady({
      timeoutMs: this.providerReadyTimeoutMs,
    });
    this.updateProviderCache(snapshot.entries);

    const agents: BackendAgentDescriptor[] = [];
    for (const entry of snapshot.entries) {
      if (!this.isEntrySelectable(entry)) {
        continue;
      }
      agents.push({
        id: entry.provider,
        label: entry.label ?? entry.provider,
        capabilities: this.resolveCapabilities(entry.provider),
        modes: (entry.modes ?? []).map(toBackendModeDescriptor),
        ...(entry.defaultModeId !== undefined ? { defaultModeId: entry.defaultModeId } : {}),
      });
    }
    return agents;
  }

  async refreshProviders(): Promise<void> {
    this.assertNotDisposed();
    await this.ensureConnected();
    if (this.api.providers.refresh) {
      await this.api.providers.refresh();
    }
    const snapshot = await this.api.providers.waitForReady({
      timeoutMs: this.providerReadyTimeoutMs,
    });
    this.updateProviderCache(snapshot.entries);
  }

  async listModels(agent: string): Promise<BackendModelDescriptor[]> {
    this.assertNotDisposed();
    const entry = await this.requireProviderEntry(agent);
    return (entry.models ?? [])
      .filter((model) => model.isSelectable !== false)
      .map(toBackendModelDescriptor);
  }

  async capabilities(agent: string): Promise<BackendCapabilities> {
    this.assertNotDisposed();
    await this.requireProviderEntry(agent);
    return this.resolveCapabilities(agent);
  }

  async start(runSpec: BackendRunSpec): Promise<SessionRef> {
    this.assertNotDisposed();
    await this.ensureConnected();

    const entry = await this.requireProviderEntry(runSpec.agent);
    const canonicalProvider = entry.provider;
    const caps = this.resolveCapabilities(canonicalProvider);
    assertRoleAgentEligible(runSpec.role, canonicalProvider, caps);

    const modes = (entry.modes ?? []).map(toBackendModeDescriptor);
    const selectedModeId = selectSafeModeId(canonicalProvider, modes, {
      allowFullAccessFallback: runSpec.allowFullAccessFallback,
    });

    const mcpConfig = this.buildMcpConfig(runSpec, caps);
    const serverFeatures = this.daemonClient.getLastServerInfoMessage()?.features;
    const createOptions: PaseoCreateAgentOptions = {
      config: {
        provider: canonicalProvider,
        model: runSpec.model,
        cwd: runSpec.cwd,
        ...(selectedModeId !== undefined ? { modeId: selectedModeId } : {}),
        ...(runSpec.reasoningEffort !== undefined
          ? { thinkingOptionId: runSpec.reasoningEffort }
          : {}),
        ...(runSpec.systemPrompt !== undefined ? { systemPrompt: runSpec.systemPrompt } : {}),
        ...mcpConfig,
      },
      ...(runSpec.env !== undefined ? { env: { ...runSpec.env } } : {}),
      ...(serverFeatures?.backgroundWorkspaces === true ? { background: true } : {}),
    };

    const agentSnapshot = await this.daemonClient.createAgent(createOptions);
    if (this.disposed) {
      await this.daemonClient.deleteAgent(agentSnapshot.id).catch(() => {});
      throw new Error(`PaseoBackend "${this.backendId}" has been disposed`);
    }
    if (agentSnapshot.capabilities) {
      this.agentCapabilitiesCache.set(
        this.normalizeProviderKey(canonicalProvider),
        agentSnapshot.capabilities,
      );
    }

    const meta: Record<string, string> = {
      agent: canonicalProvider,
      ...(selectedModeId !== undefined ? { modeId: selectedModeId } : {}),
    };

    const sessionRef: SessionRef = {
      backendId: this.backendId,
      sessionId: agentSnapshot.id,
      meta,
    };

    const session: SessionState = {
      agentId: agentSnapshot.id,
      canonicalProvider,
      sessionRef,
      runSpec: cloneRunSpec(runSpec),
      status: "running",
      activeTurnId: null,
      turnSeq: 0,
      currentTurn: null,
      timelineSub: null,
      usageState: createSessionUsageState(),
    };
    const turn = this.beginTurn(session);
    this.sessions.set(agentSnapshot.id, session);

    try {
      const sub = this.daemonClient.subscribeAgentTimeline(agentSnapshot.id, (message) => {
        this.handleTimelineMessage(session, message);
      });
      session.timelineSub = sub;
      await sub.ready;
      this.assertNotDisposed();
      await this.daemonClient.sendAgentMessage(agentSnapshot.id, runSpec.prompt);
      turn.dispatched = true;
    } catch (error) {
      this.sessions.delete(agentSnapshot.id);
      this.releaseTimelineSub(session);
      await this.daemonClient.deleteAgent(agentSnapshot.id).catch(() => {});
      if (!turn.finished) {
        this.emitExit(session, turn, {
          kind: "exit",
          at: new Date().toISOString(),
          reason: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }

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

    await this.ensureConnected();
    await this.ensureTimelineSubscription(session);

    const turn = this.beginTurn(session);
    try {
      await this.daemonClient.sendAgentMessage(session.agentId, message);
      turn.dispatched = true;
    } catch (error) {
      if (!turn.finished) {
        this.emitExit(session, turn, {
          kind: "exit",
          at: new Date().toISOString(),
          reason: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
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

    const response: PaseoPermissionResponse = allow
      ? { behavior: "allow" }
      : { behavior: "deny", ...(message !== undefined ? { message } : {}) };
    await this.daemonClient.respondToPermission(pending.agentId, approvalId, response);
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

    if (turn.cancelPromise) {
      return turn.cancelPromise;
    }

    turn.cancelPromise = this.performCancel(session, turn);
    return turn.cancelPromise;
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
    if (sessionRef.backendId !== this.backendId) {
      throw new Error(
        `Session backendId mismatch: expected "${this.backendId}", got "${sessionRef.backendId}"`,
      );
    }
    const serverId = this.daemonClient.getLastServerInfoMessage()?.serverId?.trim();
    const sessionId = sessionRef.sessionId.trim();
    if (!serverId || !sessionId) {
      return null;
    }
    return `paseo://h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(sessionId)}`;
  }

  /**
   * Lists provider subscription quota windows when supported by the connected Paseo host.
   */
  async listProviderUsage(): Promise<PaseoProviderUsageWindow[]> {
    this.assertNotDisposed();
    await this.ensureConnected();

    const serverInfo = this.daemonClient.getLastServerInfoMessage();
    if (serverInfo?.features?.providerUsageList !== true) {
      return [];
    }

    const result = await this.api.providers.listUsage();
    const windows: PaseoProviderUsageWindow[] = [];
    for (const provider of result.providers) {
      if (provider.status !== "available") {
        continue;
      }
      for (const window of provider.windows) {
        windows.push({
          providerId: provider.providerId,
          displayName: provider.displayName,
          status: provider.status,
          planLabel: provider.planLabel ?? null,
          windowId: window.id,
          label: window.label,
          ...(window.shortLabel !== undefined ? { shortLabel: window.shortLabel } : {}),
          usedPct: window.usedPct ?? null,
          remainingPct: window.remainingPct ?? null,
          resetsAt: window.resetsAt ?? null,
          ...(window.tone !== undefined ? { tone: window.tone } : {}),
        });
      }
    }
    return windows;
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }

    this.disposed = true;
    this.disposePromise = this.performDispose();
    return this.disposePromise;
  }

  private async performDispose(): Promise<void> {
    this.reconnectableDisconnect = false;
    this.clearDisconnectTimer();
    this.daemonUnsubscribe?.();
    this.daemonUnsubscribe = null;
    this.connectionUnsubscribe?.();
    this.connectionUnsubscribe = null;

    const eventsObs = this.eventsObservation;
    const agentsObs = this.agentsObservation;
    this.eventsObservation = null;
    this.agentsObservation = null;

    const sessionList = Array.from(this.sessions.values());
    for (const session of sessionList) {
      const turn = session.currentTurn;
      if (turn && !turn.finished) {
        this.emitExit(session, turn, {
          kind: "exit",
          at: new Date().toISOString(),
          reason: "cancelled",
          detail: "Backend disposed",
        });
      }
      session.status = "closed";
      session.activeTurnId = null;
      this.releaseTimelineSub(session);
    }

    this.pendingApprovals.clear();
    this.approvalHandlers.clear();

    await Promise.allSettled([
      eventsObs?.release(),
      agentsObs?.release(),
      ...sessionList.map(async (session) => {
        await this.daemonClient.deleteAgent(session.agentId).catch(() => {});
      }),
    ]);

    await this.api.dispose?.().catch(() => {});
    await this.daemonClient.close();
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error(`PaseoBackend "${this.backendId}" has been disposed`);
    }
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer !== null) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  private ensureDaemonObservations(): void {
    if (this.disposed) {
      return;
    }
    if (!this.eventsObservation && this.daemonClient.observeEvents) {
      try {
        const sub = this.daemonClient.observeEvents([
          "agent_permission_request",
          "agent_permission_resolved",
          "providers_snapshot_update",
        ]);
        this.eventsObservation = sub;
        void sub.ready.catch(() => {});
      } catch {
        // Ignore unsupported event subscription setup on legacy daemons.
      }
    }
    if (!this.agentsObservation && this.daemonClient.observeAgents) {
      try {
        const includeBackground =
          this.daemonClient.getLastServerInfoMessage()?.features?.backgroundWorkspaces === true;
        const sub = this.daemonClient.observeAgents(
          includeBackground ? { includeBackground: true } : undefined,
        );
        this.agentsObservation = sub;
        void sub.ready.catch(() => {});
      } catch {
        // Ignore unsupported agent observation setup on legacy daemons.
      }
    }
  }

  private async ensureConnected(): Promise<void> {
    this.assertNotDisposed();
    if (this.daemonClient.isConnected === true) {
      this.connectedOnce = true;
      this.ensureDaemonObservations();
      return;
    }
    if (this.connectedOnce && this.daemonClient.isConnected === undefined) {
      this.ensureDaemonObservations();
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = (async () => {
      await this.daemonClient.connect();
      this.connectedOnce = true;
      this.ensureDaemonObservations();
    })().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private normalizeProviderKey(provider: string): string {
    return provider.trim().toLowerCase();
  }

  private isEntrySelectable(entry: PaseoProviderSnapshotEntry): boolean {
    return entry.enabled !== false && entry.status === "ready";
  }

  private updateProviderCache(entries: readonly PaseoProviderSnapshotEntry[]): void {
    for (const entry of entries) {
      if (entry.status === "loading") {
        continue;
      }
      this.providerCache.set(this.normalizeProviderKey(entry.provider), entry);
    }
  }

  private async requireProviderEntry(agent: string): Promise<PaseoProviderSnapshotEntry> {
    const key = this.normalizeProviderKey(agent);
    let entry = this.providerCache.get(key);
    if (!entry || entry.status === "loading") {
      await this.ensureConnected();
      const snapshot = await this.api.providers.waitForReady({
        timeoutMs: this.providerReadyTimeoutMs,
      });
      this.updateProviderCache(snapshot.entries);
      entry =
        this.providerCache.get(key) ??
        snapshot.entries.find((candidate) => this.normalizeProviderKey(candidate.provider) === key);
    }

    if (!entry || !this.isEntrySelectable(entry)) {
      throw new Error(`Unknown agent "${agent}" for backend "${this.backendId}"`);
    }
    return entry;
  }

  private resolveCapabilities(agent: string): BackendCapabilities {
    const key = this.normalizeProviderKey(agent);
    const base = PROVIDER_FALLBACK_CAPABILITIES[key] ?? UNKNOWN_PROVIDER_CAPABILITIES;
    const cached = this.agentCapabilitiesCache.get(key);

    return {
      interactiveChat: base.interactiveChat,
      // Conservative V2 invariant: Paseo permission prompts are not guaranteed across providers.
      approvals: false,
      mcpInjection: cached ? cached.supportsMcpServers : base.mcpInjection,
      usageCacheBreakdown: base.usageCacheBreakdown,
      interrupt: base.interrupt,
    };
  }

  private buildMcpConfig(
    runSpec: BackendRunSpec,
    caps: BackendCapabilities,
  ):
    | {
        mcpServers: Record<string, PaseoMcpStdioServerConfig>;
        toolPolicy?: { preapproved: Array<{ kind: "mcp"; server: string; tool: string }> };
      }
    | Record<string, never> {
    if (!caps.mcpInjection || !runSpec.mcpServers || runSpec.mcpServers.length === 0) {
      return {};
    }

    const mcpServers: Record<string, PaseoMcpStdioServerConfig> = {};
    const preapproved: Array<{ kind: "mcp"; server: string; tool: string }> = [];

    const allowedTools =
      this.preapprovedToolsByRole?.[runSpec.role] ??
      MCP_TOOL_NAMES.filter((tool) => isRoleAllowedForTool(runSpec.role, tool));

    for (const server of runSpec.mcpServers) {
      mcpServers[server.name] = {
        type: "stdio",
        command: server.command,
        ...(server.args !== undefined ? { args: [...server.args] } : {}),
        ...(server.env !== undefined ? { env: { ...server.env } } : {}),
      };
      for (const tool of allowedTools) {
        preapproved.push({
          kind: "mcp",
          server: server.name,
          tool,
        });
      }
    }

    return {
      mcpServers,
      ...(preapproved.length > 0 ? { toolPolicy: { preapproved } } : {}),
    };
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

  private beginTurn(session: SessionState): TurnState {
    const turnNumber = ++session.turnSeq;
    const turnId = `${session.sessionRef.sessionId}-turn-${turnNumber}`;

    let resolveCompletion!: () => void;
    const completionPromise = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    const turn: TurnState = {
      turnId,
      turnNumber,
      providerTurnId: null,
      events: [],
      finished: false,
      completing: false,
      reconciling: false,
      dispatched: false,
      waiters: new Set(),
      seenToolCallIds: new Set(),
      completionPromise,
      resolveCompletion,
      cancelPromise: null,
    };

    session.currentTurn = turn;
    session.status = "running";
    session.activeTurnId = turnId;
    return turn;
  }

  private async ensureTimelineSubscription(session: SessionState): Promise<void> {
    if (session.timelineSub) {
      await session.timelineSub.ready;
      return;
    }
    const sub = this.daemonClient.subscribeAgentTimeline(session.agentId, (message) => {
      this.handleTimelineMessage(session, message);
    });
    session.timelineSub = sub;
    await sub.ready;
  }

  private releaseTimelineSub(session: SessionState): void {
    const sub = session.timelineSub;
    session.timelineSub = null;
    if (!sub) {
      return;
    }
    try {
      sub();
      void sub.release?.().catch(() => {});
    } catch {
      // Ignore subscription cleanup failures during teardown.
    }
  }

  private handleTimelineMessage(session: SessionState, message: PaseoTimelineMessage): void {
    if (
      message.type === "agent.timeline.subscription_restored" ||
      message.type === "agent.timeline.replacement"
    ) {
      if (message.payload.agentId === session.agentId) {
        void this.reconcileSessionTurn(session);
      }
      return;
    }

    if (message.type === "agent.timeline.error") {
      if (message.payload.agentId !== session.agentId) {
        return;
      }
      this.releaseTimelineSub(session);
      const turn = session.currentTurn;
      if (turn && !turn.finished) {
        this.clearSessionPendingApprovals(session.sessionRef.sessionId);
        this.emitExit(session, turn, {
          kind: "exit",
          at: new Date().toISOString(),
          reason: "failed",
          detail: message.payload.error,
        });
      }
      return;
    }

    if (message.type !== "agent_stream") {
      return;
    }

    if (message.payload.agentId !== session.agentId) {
      return;
    }

    const turn = session.currentTurn;
    if (!turn || turn.finished) {
      return;
    }

    const ev = message.payload.event;
    const at =
      message.payload.timestamp ||
      ("timestamp" in ev && typeof ev.timestamp === "string" ? ev.timestamp : undefined) ||
      new Date().toISOString();

    this.handleAgentStreamEvent(session, turn, ev, at);
  }

  private handleAgentStreamEvent(
    session: SessionState,
    turn: TurnState,
    ev: PaseoAgentStreamEvent,
    at: string,
  ): void {
    turn.dispatched = true;
    switch (ev.type) {
      case "turn_started": {
        if (ev.turnId) {
          turn.providerTurnId = ev.turnId;
        }
        break;
      }
      case "timeline": {
        if (ev.turnId && !turn.providerTurnId) {
          turn.providerTurnId = ev.turnId;
        }
        this.handleTimelineItem(turn, ev.item, at);
        break;
      }
      case "permission_requested": {
        this.handlePermissionRequest(session, ev.request, at);
        break;
      }
      case "permission_resolved": {
        this.pendingApprovals.delete(ev.requestId);
        break;
      }
      case "turn_canceled": {
        this.clearSessionPendingApprovals(session.sessionRef.sessionId);
        this.emitExit(session, turn, {
          kind: "exit",
          at,
          reason: "cancelled",
          ...(ev.reason ? { detail: ev.reason } : {}),
        });
        break;
      }
      case "turn_failed": {
        this.clearSessionPendingApprovals(session.sessionRef.sessionId);
        this.emitExit(session, turn, {
          kind: "exit",
          at,
          reason: "failed",
          ...(ev.error ? { detail: ev.error } : {}),
        });
        break;
      }
      case "turn_completed": {
        if (turn.completing) {
          return;
        }
        turn.completing = true;
        if (hasAnyTokenCounter(ev.usage)) {
          this.completeTurnWithUsage(
            session,
            turn,
            ev.usage,
            "turn_completed",
            ev.turnId,
            at,
          );
        } else {
          void this.completeTurnFromFetchedAgent(session, turn, ev.turnId, at);
        }
        break;
      }
      default:
        break;
    }
  }

  private handleTimelineItem(
    turn: TurnState,
    item: Extract<PaseoAgentStreamEvent, { type: "timeline" }>["item"],
    at: string,
  ): void {
    switch (item.type) {
      case "assistant_message": {
        this.pushEvent(turn, {
          kind: "message",
          at,
          text: item.text,
          delta: true,
        });
        break;
      }
      case "reasoning": {
        this.pushEvent(turn, {
          kind: "thinking",
          at,
        });
        break;
      }
      case "tool_call": {
        const isWriteOrEdit = item.detail.type === "write" || item.detail.type === "edit";
        if (isWriteOrEdit && item.status === "running") {
          return;
        }

        if (item.callId) {
          if (turn.seenToolCallIds.has(item.callId)) {
            return;
          }
          turn.seenToolCallIds.add(item.callId);
        }

        if (
          isWriteOrEdit &&
          item.status === "completed" &&
          "filePath" in item.detail &&
          typeof item.detail.filePath === "string" &&
          item.detail.filePath.length > 0
        ) {
          this.pushEvent(turn, {
            kind: "file_write",
            at,
            path: item.detail.filePath,
          });
          return;
        }

        const target = extractToolTarget(item.detail);
        const name = item.name || item.detail.type || "tool";
        this.pushEvent(turn, {
          kind: "tool",
          at,
          name,
          ...(target !== undefined ? { target } : {}),
        });
        break;
      }
      default:
        break;
    }
  }

  private completeTurnWithUsage(
    session: SessionState,
    turn: TurnState,
    rawUsage: PaseoAgentSnapshot["lastUsage"],
    source: "turn_completed" | "last_usage",
    evTurnId: string | undefined,
    at: string,
  ): void {
    if (turn.finished) {
      return;
    }
    try {
      const normalized = normalizeTurnUsage({
        provider: session.canonicalProvider,
        model: session.runSpec.model,
        agentId: session.agentId,
        rawUsage,
        source,
        state: session.usageState,
        candidateTurnIds: [evTurnId, turn.providerTurnId, turn.turnId],
      });
      if (normalized) {
        this.pushEvent(turn, {
          kind: "usage",
          at,
          ...normalized,
        });
      }
      this.clearSessionPendingApprovals(session.sessionRef.sessionId);
      this.emitExit(session, turn, {
        kind: "exit",
        at,
        reason: "completed",
      });
    } catch (error) {
      this.clearSessionPendingApprovals(session.sessionRef.sessionId);
      this.emitExit(session, turn, {
        kind: "exit",
        at: new Date().toISOString(),
        reason: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async completeTurnFromFetchedAgent(
    session: SessionState,
    turn: TurnState,
    evTurnId: string | undefined,
    at: string,
  ): Promise<void> {
    try {
      const fetched = await this.daemonClient.fetchAgent({ agentId: session.agentId });
      if (turn.finished) {
        return;
      }
      if (fetched?.agent.capabilities) {
        this.agentCapabilitiesCache.set(
          this.normalizeProviderKey(session.canonicalProvider),
          fetched.agent.capabilities,
        );
      }
      this.completeTurnWithUsage(
        session,
        turn,
        fetched?.agent.lastUsage,
        "last_usage",
        evTurnId,
        at,
      );
    } catch (error) {
      if (!turn.finished) {
        if (!this.disposed && (this.reconnectableDisconnect || this.disconnectTimer !== null)) {
          turn.completing = false;
          return;
        }
        this.clearSessionPendingApprovals(session.sessionRef.sessionId);
        this.emitExit(session, turn, {
          kind: "exit",
          at: new Date().toISOString(),
          reason: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private handleDaemonEvent(event: PaseoDaemonEvent): void {
    switch (event.type) {
      case "agent_permission_request": {
        const session = this.sessions.get(event.agentId);
        if (!session) {
          return;
        }
        this.handlePermissionRequest(session, event.request, new Date().toISOString());
        break;
      }
      case "agent_permission_resolved": {
        this.pendingApprovals.delete(event.requestId);
        break;
      }
      case "agent_deleted": {
        const session = this.sessions.get(event.agentId);
        if (!session) {
          return;
        }
        this.clearSessionPendingApprovals(session.sessionRef.sessionId);
        const turn = session.currentTurn;
        if (turn && !turn.finished) {
          this.emitExit(session, turn, {
            kind: "exit",
            at: new Date().toISOString(),
            reason: "failed",
            detail: "Agent deleted",
          });
        }
        session.status = "closed";
        session.activeTurnId = null;
        this.releaseTimelineSub(session);
        break;
      }
      case "agent_update": {
        const session = this.sessions.get(event.agentId);
        if (!session) {
          return;
        }
        if (event.payload.kind === "remove") {
          this.clearSessionPendingApprovals(session.sessionRef.sessionId);
          const turn = session.currentTurn;
          if (turn && !turn.finished) {
            this.emitExit(session, turn, {
              kind: "exit",
              at: new Date().toISOString(),
              reason: "failed",
              detail: "Agent removed",
            });
          }
          session.status = "closed";
          session.activeTurnId = null;
          this.releaseTimelineSub(session);
        } else {
          const agent = event.payload.agent;
          if (agent.capabilities) {
            this.agentCapabilitiesCache.set(
              this.normalizeProviderKey(session.canonicalProvider),
              agent.capabilities,
            );
          }
          if (agent.status === "closed") {
            this.clearSessionPendingApprovals(session.sessionRef.sessionId);
            const turn = session.currentTurn;
            if (turn && !turn.finished) {
              this.emitExit(session, turn, {
                kind: "exit",
                at: new Date().toISOString(),
                reason: "failed",
                detail: agent.lastError ?? "Agent closed",
              });
            }
            session.status = "closed";
            session.activeTurnId = null;
            this.releaseTimelineSub(session);
          }
        }
        break;
      }
      case "providers_snapshot_update": {
        this.updateProviderCache(event.payload.entries);
        break;
      }
      default:
        break;
    }
  }

  private failAllActiveTurns(detail: string): void {
    const at = new Date().toISOString();
    for (const session of this.sessions.values()) {
      const turn = session.currentTurn;
      if (turn && !turn.finished) {
        this.clearSessionPendingApprovals(session.sessionRef.sessionId);
        this.emitExit(session, turn, {
          kind: "exit",
          at,
          reason: "failed",
          detail,
        });
      }
    }
  }

  private async reconcileSessionTurn(session: SessionState): Promise<void> {
    const turn = session.currentTurn;
    if (this.disposed || !turn || turn.finished || turn.completing || turn.reconciling) {
      return;
    }

    turn.reconciling = true;
    try {
      const fetched = await this.daemonClient.fetchAgent({ agentId: session.agentId });
      if (
        this.disposed ||
        turn.finished ||
        turn.completing ||
        session.currentTurn !== turn
      ) {
        return;
      }

      const now = new Date().toISOString();
      if (!fetched) {
        this.clearSessionPendingApprovals(session.sessionRef.sessionId);
        this.emitExit(session, turn, {
          kind: "exit",
          at: now,
          reason: "failed",
          detail: "Agent disappeared during reconnect",
        });
        session.status = "closed";
        this.releaseTimelineSub(session);
        return;
      }

      const agent = fetched.agent;
      if (agent.capabilities) {
        this.agentCapabilitiesCache.set(
          this.normalizeProviderKey(session.canonicalProvider),
          agent.capabilities,
        );
      }

      for (const perm of agent.pendingPermissions ?? []) {
        this.handlePermissionRequest(session, perm, now);
      }
      if (turn.finished || turn.completing) {
        return;
      }

      if (agent.status === "closed") {
        this.clearSessionPendingApprovals(session.sessionRef.sessionId);
        this.emitExit(session, turn, {
          kind: "exit",
          at: now,
          reason: "failed",
          detail: agent.lastError ?? "Agent closed",
        });
        session.status = "closed";
        this.releaseTimelineSub(session);
        return;
      }

      if (agent.status === "error") {
        this.clearSessionPendingApprovals(session.sessionRef.sessionId);
        this.emitExit(session, turn, {
          kind: "exit",
          at: now,
          reason: "failed",
          detail: agent.lastError ?? "Agent entered error state",
        });
        return;
      }

      if (turn.dispatched && agent.status === "idle" && !agent.activeTurn) {
        turn.completing = true;
        this.completeTurnWithUsage(
          session,
          turn,
          agent.lastUsage,
          "last_usage",
          undefined,
          now,
        );
      }
    } catch {
      // Transient fetch failure during reconnect leaves turn open for timeline or disconnect grace timer.
    } finally {
      turn.reconciling = false;
    }
  }

  private handleConnectionState(state: PaseoConnectionState): void {
    if (this.disposed) {
      this.reconnectableDisconnect = false;
      this.clearDisconnectTimer();
      return;
    }

    if (state.status === "connected") {
      const recoveringDisconnect = this.reconnectableDisconnect || this.disconnectTimer !== null;
      this.reconnectableDisconnect = false;
      this.clearDisconnectTimer();
      this.ensureDaemonObservations();
      if (recoveringDisconnect) {
        for (const session of this.sessions.values()) {
          const turn = session.currentTurn;
          if (turn && !turn.finished) {
            void this.reconcileSessionTurn(session);
          }
        }
      }
      return;
    }

    if (
      state.status === "disposed" ||
      (state.status === "disconnected" && state.nextRetryAt === undefined)
    ) {
      this.reconnectableDisconnect = false;
      this.clearDisconnectTimer();
      const detail =
        state.status === "disconnected"
          ? state.reason ?? "Paseo daemon connection lost"
          : "Paseo daemon client disposed";
      this.failAllActiveTurns(detail);
      return;
    }

    if (state.status === "disconnected" && state.nextRetryAt !== undefined) {
      this.reconnectableDisconnect = true;
      if (!this.disconnectTimer) {
        const detail = state.reason ?? "Paseo daemon reconnect grace window elapsed";
        this.disconnectTimer = setTimeout(() => {
          this.disconnectTimer = null;
          this.reconnectableDisconnect = false;
          if (!this.disposed) {
            this.failAllActiveTurns(detail);
          }
        }, this.disconnectGraceMs);
        this.disconnectTimer.unref?.();
      }
    }
  }

  private handlePermissionRequest(
    session: SessionState,
    request: PaseoPermissionRequest,
    at: string,
  ): void {
    if (!request.id || this.seenPermissionIds.has(request.id)) {
      return;
    }
    const turn = session.currentTurn;
    if (!turn || turn.finished) {
      return;
    }

    this.seenPermissionIds.add(request.id);
    this.pendingApprovals.set(request.id, {
      id: request.id,
      agentId: session.agentId,
      sessionId: session.sessionRef.sessionId,
    });

    const action = request.name || request.kind || "permission";
    const detail = formatPermissionDetail(request);

    this.pushEvent(turn, {
      kind: "approval",
      at,
      id: request.id,
      action,
      detail,
    });

    const approvalEvent: ApprovalRequestEvent = {
      id: request.id,
      sessionRef: cloneSessionRef(session.sessionRef),
      action,
      detail,
      at,
    };

    for (const handler of [...this.approvalHandlers]) {
      try {
        const result = handler(approvalEvent);
        if (result && typeof (result as Promise<void>).then === "function") {
          void (result as Promise<void>).catch((error) => {
            this.pendingApprovals.delete(request.id);
            if (!turn.finished) {
              this.emitExit(session, turn, {
                kind: "exit",
                at: new Date().toISOString(),
                reason: "failed",
                detail: error instanceof Error ? error.message : String(error),
              });
            }
          });
        }
      } catch (error) {
        this.pendingApprovals.delete(request.id);
        if (!turn.finished) {
          this.emitExit(session, turn, {
            kind: "exit",
            at: new Date().toISOString(),
            reason: "failed",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  private clearSessionPendingApprovals(sessionId: string): void {
    for (const [id, pending] of this.pendingApprovals.entries()) {
      if (pending.sessionId === sessionId) {
        this.pendingApprovals.delete(id);
      }
    }
  }

  private async performCancel(session: SessionState, turn: TurnState): Promise<void> {
    this.clearSessionPendingApprovals(session.sessionRef.sessionId);

    try {
      await this.daemonClient.cancelAgent(session.agentId);
    } catch (error) {
      if (this.stopFallback) {
        try {
          await this.stopFallback(session.agentId);
        } catch (fallbackErr) {
          this.emitExit(session, turn, {
            kind: "exit",
            at: new Date().toISOString(),
            reason: "cancelled",
            detail:
              fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          });
          return;
        }
      } else {
        this.emitExit(session, turn, {
          kind: "exit",
          at: new Date().toISOString(),
          reason: "cancelled",
          detail: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }

    if (turn.finished) {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        turn.completionPromise,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            if (!turn.finished) {
              this.emitExit(session, turn, {
                kind: "exit",
                at: new Date().toISOString(),
                reason: "cancelled",
                detail: "Cancelled after interrupt timeout",
              });
            }
            resolve();
          }, this.cancelTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
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
      turn.resolveCompletion();
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
    if (session.status !== "closed") {
      session.status = "idle";
    }
    session.activeTurnId = null;
    this.pushEvent(turn, exitEvent);
  }
}
