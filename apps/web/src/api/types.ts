import type {
  BackendCapabilities,
  CardContract,
  CardLimits,
  DecisionAction,
  DraftCard,
  GateReport,
  HashMismatchError,
  InspectSpaceResponse,
  LedgerEntry,
  LedgerFile,
  LimitsConfig,
  PairCompleteRequest,
  PendingDecision,
  PricingConfig,
  Priority,
  PublicPairedDevice,
  ReasoningEffort,
  RemoteAuthStatusResponse,
  RemoteConfig,
  RemoteNotificationChannel,
  RemoteNotificationTestRequest,
  RemotePairChallengeResponse,
  RoleId,
  RolesConfig,
  RunEvent,
  RunMeta,
  SpaceConfig,
  StageId,
  StateEvent,
  TailscaleStatusResponse,
  TaskCard,
  TaskStatus,
  Track,
  UpsertSpaceRequest,
  WorkspaceMode,
} from "@kiln/protocol/web";

export interface BootstrapTask {
  id: string;
  space: string;
  parent_id: string | null;
  title: string;
  priority: Priority;
  effective_priority: Priority;
  track: Track;
  workspace_mode: WorkspaceMode;
  status: TaskStatus;
  stage: StageId | null;
  round: number | null;
  active_run_id: string | null;
  contract_version: number;
  depends_on: string[];
  created_at: string;
  updated_at: string;
  tokens: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  cost_usd: number;
  tokens_by_model?: Record<string, UsageBucketSummary>;
  summary?: string;
  agent?: string;
  model?: string;
  executor?: string;
  has_host_backup?: boolean;
  waiting_reason?: string;
  waiting_since?: string;
  delivered_ref?: string;
  kind?: string;
}

export interface UsageBucketSummary {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface UsageSnapshot {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  byAgent: Record<string, UsageBucketSummary>;
  byModel: Record<string, UsageBucketSummary>;
  byAgentModel?: Record<string, Record<string, UsageBucketSummary>>;
}

export interface ProviderQuotaWindow {
  label: string;
  usedRatio: number; // 0..1
  resetAt?: string;
  note?: string;
}

export interface RawProviderUsageEntry {
  agent?: string;
  label?: string;
  usedRatio?: number;
  usedPercent?: number;
  used?: number;
  resetAt?: string;
  reset?: string;
  note?: string;
  quota?: {
    label?: string;
    used?: number;
    usedRatio?: number;
    usedPercent?: number;
    reset?: string;
    resetAt?: string;
  } | null;
}

export interface AgentModeInfo {
  id: string;
  label: string;
  description?: string;
  isFullAccess?: boolean;
}

export interface AgentModelInfo {
  id: string;
  label?: string;
  description?: string;
  thinkingOptions?: ReasoningEffort[];
  defaultThinkingOptionId?: ReasoningEffort;
}

export interface AgentDescriptorInfo {
  id: string;
  label?: string;
  backendId?: string;
  capabilities: BackendCapabilities;
  modes?: AgentModeInfo[];
  defaultModeId?: string | null;
  models?: Array<string | AgentModelInfo>;
}

export interface BackendConnectionInfo {
  backendId?: string;
  id?: string;
  kind?: string;
  connected: boolean;
  status?: string;
  url?: string;
  detail?: string;
}

export interface BootstrapResponse {
  tasks: BootstrapTask[];
  pendingDecisions: PendingDecision[];
  drafts: DraftCard[];
  spaces: Record<string, SpaceConfig>;
  settings?: {
    roles: RolesConfig | null;
    limits: LimitsConfig | null;
    pricing: PricingConfig | null;
  };
  roles: RolesConfig | null;
  limits: LimitsConfig | null;
  pricing: PricingConfig | null;
  usage: UsageSnapshot;
  runningCount: number;
  ledgers?: Record<string, LedgerFile> | LedgerFile[] | Array<{ space: string; entries: LedgerEntry[] }>;
  agents?: AgentDescriptorInfo[];
  backends?: BackendConnectionInfo[];
  providerUsage?: Record<string, RawProviderUsageEntry> | RawProviderUsageEntry[];
  liveRates?: {
    rates: Record<string, number>;
    totals?: { costUsd: number; tokPerSec: number };
  };
}

export interface UsageTurnRow {
  run_id: string;
  turn_id: string;
  task_id: string;
  agent: string;
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  recorded_at: string;
}

export interface LedgerProposalItem {
  id: string;
  task_id: string;
  run_id: string;
  role: RoleId;
  space: string;
  rule: string;
  rationale: string;
  status: string;
  proposed_at: string;
}

export interface HostBackupFileInfo {
  target_canonical_path: string;
  staged_relative_path: string;
  backup_relative_path: string | null;
  existed_before: boolean;
  pre_sha256: string | null;
  post_sha256: string | null;
  updated_at: string;
}

export interface HostBackupManifestInfo {
  schema_version: 1;
  task_id: string;
  status: "staged_awaiting_approval" | "applied" | "rolled_back" | "restored";
  files: HostBackupFileInfo[];
  created_at: string;
  updated_at: string;
}

export interface HostStagedDiffEntry {
  targetPath: string;
  existedBefore: boolean;
  preSha256: string | null;
  diff: string;
  truncated: boolean;
}

export interface TaskRunDetail {
  dirName: string;
  meta: RunMeta | null;
  handoff: string | null;
  receipt: string | null;
  gate: GateReport | null;
  events: RunEvent[];
  eventsCount: number;
  startedAt?: string;
  endedAt?: string | null;
  status?: string;
}

export interface ChatMessage {
  id?: string;
  role?: "user" | "assistant" | "system" | "tool";
  who?: "me" | "agent" | "tool";
  name?: string;
  text: string;
  at?: string;
  toolName?: string;
}

export interface TaskDetailResponse {
  card: TaskCard;
  state: {
    status: TaskStatus;
    stage: StageId | null;
    round: number | null;
    activeRunId: string | null;
    priority: Priority;
    effectivePriority: Priority;
    track: Track;
    contractVersion: number;
    updatedAt: string;
  };
  brief: string;
  decisions: string;
  pendingDecision: PendingDecision | null;
  ledgerProposals: LedgerProposalItem[];
  runs: TaskRunDetail[];
  usageTurns: UsageTurnRow[];
  usage: UsageSnapshot;
  liveViewUrl?: string | null;
  hostBackup?: HostBackupManifestInfo | null;
  hostStagedDiffs?: HostStagedDiffEntry[];
  stateEvents?: StateEvent[];
  chatMessages?: ChatMessage[];
}

export interface HostRestoreConflictDetail {
  targetCanonicalPath: string;
  expectedPostSha256: string | null;
  actualSha256: string | null;
  expectedSummary?: string;
  actualSummary?: string;
  diff: string;
}

export type RestoreHostBackupResult =
  | { ok: true; manifest: HostBackupManifestInfo }
  | {
      ok: false;
      status: 409 | 404;
      code: "hash_mismatch" | "lock_conflict" | "invalid_backup_state" | "backup_not_found";
      message: string;
      hashMismatch?: HashMismatchError;
      conflicts?: HostRestoreConflictDetail[];
      lockConflicts?: Array<{ path: string; heldByTaskId: string }>;
    };

export interface SubmitDecisionPayload {
  decision_id: string;
  option_id: string;
  action: DecisionAction;
  rationale?: string;
  apply_ledger_rule: boolean;
  contract_update?: {
    contract_patch: Partial<CardContract>;
    affected_stages: StageId[];
    accept_files_hash?: string;
  };
}

export interface UpsertDraftPayload {
  id?: string;
  title?: string;
  space?: string;
  priority?: Priority;
  track?: Track;
  workspace_mode?: WorkspaceMode;
  depends_on?: string[];
  contract?: Partial<CardContract>;
}

export interface CommitDraftPayload {
  id?: string;
  title?: string;
  space?: string;
  priority?: Priority;
  track?: Track;
  workspace_mode?: WorkspaceMode;
  parent?: string | null;
  depends_on?: string[];
  contract?: Partial<CardContract>;
  limits?: CardLimits;
  brief_markdown: string;
}

export interface ChatResponsePayload {
  messages?: ChatMessage[];
  reply?: ChatMessage | string;
  draft?: DraftCard;
  pendingDecision?: PendingDecision | null;
  contractPatch?: Partial<CardContract>;
  card?: TaskCard;
}

export type SettingsSectionMap = {
  roles: RolesConfig;
  limits: LimitsConfig;
  pricing: PricingConfig;
};

export type InspectSpaceResult = InspectSpaceResponse;
export type UpsertSpacePayload = UpsertSpaceRequest;

export interface RemoteRuntimeStatus {
  listening: boolean;
  port: number | null;
  baseUrl: string | null;
}

export interface RemoteSettingsResponse {
  ok: true;
  remote: RemoteConfig;
  runtime: RemoteRuntimeStatus;
  activeDeviceCount: number;
}

export interface UpdateRemoteSettingsResponse {
  ok: true;
  section: "remote";
  data: RemoteConfig;
  runtime: RemoteRuntimeStatus;
}

export interface PairAuthResponse {
  ok: true;
  device: PublicPairedDevice;
}

export interface LogoutResponse {
  ok: true;
  loggedOut: boolean;
  revokedDeviceId: string | null;
}

export interface RemoteDevicesResponse {
  ok: true;
  devices: PublicPairedDevice[];
}

export interface RevokeDeviceResponse {
  ok: true;
  revoked: boolean;
  device: PublicPairedDevice;
  closedStreams: number;
}

export interface RevokeAllDevicesResponse {
  ok: true;
  revokedCount: number;
  closedStreams: number;
}

export interface RemoteNotificationTestResponse {
  ok: true;
  delivered: true;
  channel?: RemoteNotificationChannel;
  status?: number;
}

export type {
  PairCompleteRequest,
  PublicPairedDevice,
  RemoteAuthStatusResponse,
  RemoteConfig,
  RemoteNotificationChannel,
  RemoteNotificationTestRequest,
  RemotePairChallengeResponse,
  TailscaleStatusResponse,
};
