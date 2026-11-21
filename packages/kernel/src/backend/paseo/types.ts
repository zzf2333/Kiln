import type { RoleId } from "@kiln/protocol";

export interface PaseoAgentMode {
  id: string;
  label: string;
  description?: string;
}

export interface PaseoAgentThinkingOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

export interface PaseoAgentModel {
  provider: string;
  id: string;
  isSelectable?: boolean;
  label: string;
  description?: string;
  isDefault?: boolean;
  contextWindowMaxTokens?: number;
  thinkingOptions?: PaseoAgentThinkingOption[];
  defaultThinkingOptionId?: string;
}

export interface PaseoProviderSnapshotEntry {
  provider: string;
  status: "ready" | "loading" | "error" | "unavailable";
  enabled: boolean;
  error?: string;
  models?: PaseoAgentModel[];
  modes?: PaseoAgentMode[];
  label?: string;
  description?: string;
  defaultModeId?: string | null;
}

export interface PaseoProvidersSnapshot {
  cwd?: string;
  requestId?: string;
  entries: PaseoProviderSnapshotEntry[];
}

export interface PaseoAgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

export interface PaseoAgentCapabilityFlags {
  [capability: string]: boolean | undefined;
  supportsStreaming: boolean;
  supportsSessionPersistence: boolean;
  supportsSessionListing?: boolean;
  supportsDynamicModes: boolean;
  supportsMcpServers: boolean;
  supportsReasoningStream: boolean;
  supportsToolInvocations: boolean;
}

export type PaseoToolCallDetail =
  | {
      type: "shell";
      command: string;
      cwd?: string;
    }
  | {
      type: "read";
      filePath: string;
    }
  | {
      type: "edit";
      filePath: string;
    }
  | {
      type: "write";
      filePath: string;
    }
  | {
      type: "search";
      query: string;
    }
  | {
      type: "fetch";
      url: string;
    }
  | {
      type: "worktree_setup";
      worktreePath: string;
      branchName: string;
    }
  | {
      type: "sub_agent";
      subAgentType?: string;
      description?: string;
    }
  | {
      type: "plain_text";
      label?: string;
      text?: string;
    }
  | {
      type: "plan";
      text: string;
    }
  | {
      type: "unknown";
      input: unknown;
      output: unknown;
    };

export type PaseoAgentTimelineItem =
  | {
      type: "user_message";
      text: string;
      messageId?: string;
    }
  | {
      type: "assistant_message";
      text: string;
      messageId?: string;
    }
  | {
      type: "reasoning";
      text: string;
    }
  | {
      type: "tool_call";
      callId: string;
      name: string;
      detail: PaseoToolCallDetail;
      status: "running" | "completed" | "failed" | "canceled";
      error: unknown;
    }
  | {
      type: "todo";
      items: unknown[];
    }
  | {
      type: "error";
      message: string;
    }
  | {
      type: "notification";
      level: "info" | "warning" | "error";
      message: string;
    }
  | {
      type: "compaction";
      status: "loading" | "completed";
    }
  | {
      type: "plugin";
      id: string;
      pluginId: string;
      kind: string;
      version: number;
      data: unknown;
    };

export interface PaseoPermissionRequest {
  id: string;
  provider: string;
  name: string;
  kind: "tool" | "plan" | "question" | "mode" | "other";
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  detail?: PaseoToolCallDetail;
}

export type PaseoPermissionResponse =
  | {
      behavior: "allow";
      selectedActionId?: string;
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: Record<string, unknown>[];
    }
  | {
      behavior: "deny";
      selectedActionId?: string;
      message?: string;
      interrupt?: boolean;
    };

export type PaseoAgentStreamEvent =
  | {
      type: "thread_started";
      sessionId: string;
      provider: string;
    }
  | {
      type: "turn_started";
      provider: string;
      turnId?: string;
    }
  | {
      type: "turn_completed";
      provider: string;
      usage?: PaseoAgentUsage | null;
      turnId?: string;
    }
  | {
      type: "usage_updated";
      provider: string;
      usage: PaseoAgentUsage;
      turnId?: string;
    }
  | {
      type: "mode_changed";
      provider: string;
      currentModeId: string | null;
      availableModes: PaseoAgentMode[];
    }
  | {
      type: "model_changed";
      provider: string;
      runtimeInfo: Record<string, unknown>;
    }
  | {
      type: "thinking_option_changed";
      provider: string;
      thinkingOptionId: string | null;
    }
  | {
      type: "turn_failed";
      provider: string;
      error: string;
      code?: string;
      diagnostic?: string;
      turnId?: string;
    }
  | {
      type: "turn_canceled";
      provider: string;
      reason: string;
      turnId?: string;
    }
  | {
      type: "timeline";
      item: PaseoAgentTimelineItem;
      provider: string;
      turnId?: string;
      timestamp?: string;
    }
  | {
      type: "permission_requested";
      provider: string;
      request: PaseoPermissionRequest;
      turnId?: string;
    }
  | {
      type: "permission_resolved";
      provider: string;
      requestId: string;
      resolution: PaseoPermissionResponse;
      turnId?: string;
    }
  | {
      type: "attention_required";
      provider: string;
      reason: "finished" | "error" | "permission";
      timestamp: string;
    };

export interface PaseoAgentStreamPayload {
  subscriptionId?: string;
  agentId: string;
  event: PaseoAgentStreamEvent;
  timestamp: string;
  seq?: number;
  epoch?: string;
}

export type PaseoTimelineMessage =
  | {
      type: "agent_stream";
      payload: PaseoAgentStreamPayload;
    }
  | {
      type: "agent.timeline.replacement";
      payload: {
        agentId: string;
        epoch: string;
      };
    }
  | {
      type: "agent.timeline.subscription_restored";
      payload: {
        agentId: string;
        subscriptionId: string;
      };
    }
  | {
      type: "agent.timeline.error";
      payload: {
        agentId: string;
        error: string;
      };
    };

export type PaseoTimelineSubscription = (() => void) & {
  readonly ready: Promise<void>;
  readonly subscriptionId?: string | null;
  release?: () => Promise<void>;
};

export interface PaseoAgentSnapshot {
  id: string;
  provider: string;
  model: string | null;
  status: "error" | "initializing" | "idle" | "running" | "closed";
  capabilities: PaseoAgentCapabilityFlags;
  availableModes: PaseoAgentMode[];
  currentModeId: string | null;
  pendingPermissions: PaseoPermissionRequest[];
  activeTurn?: {
    turnId: string;
    startedAt: string | null;
  } | null;
  lastUsage?: PaseoAgentUsage;
  lastError?: string;
}

export type PaseoDaemonEvent =
  | {
      type: "agent_update";
      agentId: string;
      payload:
        | { kind: "upsert"; agent: PaseoAgentSnapshot }
        | { kind: "remove"; agentId: string };
    }
  | {
      type: "agent_deleted";
      agentId: string;
    }
  | {
      type: "agent_permission_request";
      agentId: string;
      request: PaseoPermissionRequest;
    }
  | {
      type: "agent_permission_resolved";
      agentId: string;
      requestId: string;
      resolution: PaseoPermissionResponse;
    }
  | {
      type: "providers_snapshot_update";
      payload: {
        cwd?: string;
        entries: PaseoProviderSnapshotEntry[];
      };
    }
  | {
      type: "error";
      message: string;
    }
  | {
      type:
        | "workspace_update"
        | "project.update"
        | "workspace_setup_progress"
        | "agent_stream"
        | "status";
      [key: string]: unknown;
    };

export interface PaseoServerFeatures {
  backgroundWorkspaces?: boolean;
  backgroundAgents?: boolean;
  providerUsageList?: boolean;
  [key: string]: unknown;
}

export interface PaseoServerInfo {
  serverId: string;
  features?: PaseoServerFeatures;
}

export type PaseoConnectionState =
  | { status: "idle" }
  | { status: "connecting"; attempt: number }
  | { status: "connected" }
  | { status: "disconnected"; reason?: string; nextRetryAt?: string; failureCode?: string }
  | { status: "disposed" };

export interface PaseoMcpStdioServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface PaseoToolPolicy {
  preapproved: Array<{
    kind: "mcp";
    server: string;
    tool: string;
  }>;
}

export interface PaseoCreateAgentConfig {
  provider: string;
  cwd: string;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  systemPrompt?: string;
  toolPolicy?: PaseoToolPolicy;
  mcpServers?: Record<string, PaseoMcpStdioServerConfig>;
}

export interface PaseoCreateAgentOptions {
  config: PaseoCreateAgentConfig;
  env?: Record<string, string>;
  background?: boolean;
}

export interface PaseoProviderUsageWindowItem {
  id: string;
  label: string;
  shortLabel?: string;
  summary?: boolean;
  usedPct?: number | null;
  remainingPct?: number | null;
  resetsAt?: string | null;
  runsOutAt?: string | null;
  shortfallPct?: number | null;
  tone?: "default" | "warning" | "danger" | "ok";
}

export interface PaseoProviderUsageEntry {
  providerId: string;
  displayName: string;
  status: "error" | "unavailable" | "available";
  planLabel: string | null;
  windows: PaseoProviderUsageWindowItem[];
  error?: string | null;
}

export interface PaseoProviderUsageResponse {
  requestId: string;
  fetchedAt: string;
  providers: PaseoProviderUsageEntry[];
}

export interface PaseoProviderUsageWindow {
  providerId: string;
  displayName: string;
  status: "available" | "unavailable" | "error";
  planLabel: string | null;
  windowId: string;
  label: string;
  shortLabel?: string;
  usedPct: number | null;
  remainingPct: number | null;
  resetsAt: string | null;
  tone?: "default" | "warning" | "danger" | "ok";
}

export interface PaseoObservationHandle {
  readonly ready: Promise<unknown>;
  release(): Promise<void>;
}

/**
 * Narrow structural interface satisfied by `@getpaseo/client`'s `DaemonClient`
 * as well as in-memory test mocks.
 */
export interface PaseoDaemonLike {
  readonly isConnected?: boolean;
  connect(): Promise<void>;
  close(): Promise<void>;
  getLastServerInfoMessage(): PaseoServerInfo | null;
  getProvidersSnapshot(options?: {
    cwd?: string;
    ifNoneMatch?: string;
    requestId?: string;
  }): Promise<PaseoProvidersSnapshot>;
  refreshProvidersSnapshot?(options?: {
    cwd?: string;
    requestId?: string;
  }): Promise<unknown>;
  createAgent(options: PaseoCreateAgentOptions): Promise<PaseoAgentSnapshot>;
  fetchAgent(options: {
    agentId: string;
    requestId?: string;
    timeout?: number;
  }): Promise<{ agent: PaseoAgentSnapshot; project: unknown } | null>;
  deleteAgent(agentId: string): Promise<void>;
  sendAgentMessage(
    agentId: string,
    text: string,
    options?: { messageId?: string },
  ): Promise<{ deliveryStatus?: "queued" }>;
  cancelAgent(agentId: string): Promise<void>;
  respondToPermission(
    agentId: string,
    requestId: string,
    response: PaseoPermissionResponse,
  ): Promise<void>;
  subscribe(handler: (event: PaseoDaemonEvent) => void): () => void;
  subscribeAgentTimeline(
    agentId: string,
    handler: (message: PaseoTimelineMessage) => void,
  ): PaseoTimelineSubscription;
  observeEvents?(
    events: Array<
      | "agent_permission_request"
      | "agent_permission_resolved"
      | "providers_snapshot_update"
    >,
    options?: { notifications?: boolean },
  ): PaseoObservationHandle;
  observeAgents?(options?: { includeBackground?: boolean }): PaseoObservationHandle;
  subscribeConnectionStatus?(listener: (status: PaseoConnectionState) => void): () => void;
  listProviderUsage?(options?: { requestId?: string }): Promise<PaseoProviderUsageResponse>;
  listCommands?(options: {
    agentId: string;
    requestId?: string;
    draftConfig?: {
      provider: string;
      cwd: string;
      modeId?: string;
      model?: string;
      thinkingOptionId?: string;
    };
  }): Promise<{
    agentId: string;
    commands: Array<{
      name: string;
      description: string;
      argumentHint: string;
      kind?: "command" | "skill";
    }>;
    error: string | null;
    requestId: string;
  }>;
}

/**
 * Narrow structural interface satisfied by `@getpaseo/client`'s `createPaseoApi()`
 * result as well as lightweight test doubles.
 */
export interface PaseoApiLike {
  readonly providers: {
    waitForReady(options?: { cwd?: string; timeoutMs?: number }): Promise<PaseoProvidersSnapshot>;
    refresh?(options?: { cwd?: string; requestId?: string }): Promise<unknown>;
    listUsage(options?: { requestId?: string }): Promise<PaseoProviderUsageResponse>;
  };
  dispose?(): Promise<void>;
}

/** Public configuration accepted by `PaseoBackend` (never exposes internal Paseo wire types). */
export interface PaseoBackendPublicOptions {
  backendId?: string;
  url?: string;
  clientId?: string;
  password?: string;
  authHeader?: string;
  connectTimeoutMs?: number;
  reconnect?: {
    enabled?: boolean;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  stopFallback?: (agentId: string) => Promise<void>;
  cancelTimeoutMs?: number;
  disconnectGraceMs?: number;
  providerReadyTimeoutMs?: number;
  preapprovedToolsByRole?: Partial<Record<RoleId, readonly string[]>>;
}

/** Internal test-only options allowing dependency injection of Paseo mock doubles. */
export interface PaseoBackendInternalOptions extends PaseoBackendPublicOptions {
  daemonClient?: PaseoDaemonLike;
  api?: PaseoApiLike;
}

export type PaseoBackendOptions = PaseoBackendInternalOptions;
