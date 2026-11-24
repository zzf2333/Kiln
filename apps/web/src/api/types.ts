import type {
  AcceptEntryConfig,
  AcceptEntryKind,
  AcceptServiceSpec,
  AcceptServiceStatus,
  AcceptTrafficSummary,
  AcceptVerificationReport,
  BackendCapabilities,
  BudgetScopeStatus,
  CardContract,
  CardLimits,
  ChatCommandAction,
  ChatCommandItem,
  ChatCommandKind,
  ChatCommandsResponse,
  ChatCommandSource,
  ChatMcpServerItem,
  ChecklistDisposition,
  ChecklistItem,
  CheckpointRecord,
  DecisionAction,
  DiscoveredGitRepo,
  DiscoverSpacesResponse,
  DraftCard,
  GateReport,
  GithubCheckRunItem,
  GithubPrCommentItem,
  GithubPrFeedbackSnapshot,
  GlobalBudgetStatus,
  HashMismatchError,
  ImportGithubIssueRequest,
  ImprovementProposal,
  InspectSpaceResponse,
  LedgerEntry,
  LedgerFile,
  LimitsConfig,
  MergeQueueEntry,
  PairCompleteRequest,
  PendingDecision,
  PickDirectoryResponse,
  PmOrchestrationPolicy,
  PolicyChangeRecord,
  PolicyMetricWindow,
  PrFeedbackReworkRequest,
  PricingConfig,
  PricingSyncSource,
  Priority,
  ProviderAdapterKind,
  ProviderEntry,
  ProviderNativeQuota,
  ProviderRuntimeStatus,
  ProvidersConfig,
  PublicPairedDevice,
  ReasoningEffort,
  RemoteAuthStatusResponse,
  RemoteConfig,
  RemoteNotificationChannel,
  RemoteNotificationTestRequest,
  RemotePairChallengeResponse,
  ResolveTaskChecklistRequest,
  RetroAttribution,
  RoleId,
  RolesConfig,
  RosterConfig,
  RosterEntry,
  RosterExecutionMode,
  RosterGroup,
  RosterModelBinding,
  RosterPermission,
  RosterTierHint,
  RunAntiDriftSummary,
  RunEvent,
  RunMeta,
  RunSpaceScriptRequest,
  RunSpaceScriptResponse,
  SpaceConfig,
  SpaceFileEntry,
  SpaceFilesResponse,
  SpaceScriptKey,
  SpaceScripts,
  SplitCardPlanItem,
  StageId,
  StateEvent,
  SteerNote,
  SyncPricingRequest,
  SyncPricingResponse,
  TailscaleStatusResponse,
  TaskAttachment,
  TaskCard,
  TaskExternalRef,
  TaskRetroMetrics,
  TaskRetroReport,
  TaskStatus,
  Track,
  UpdateTaskLimitsRequest,
  UpsertSpaceRequest,
  VerifierCapability,
  WorkflowBlueprint,
  WorkflowPreset,
  WorkspaceMode,
  RollbackCheckpointRequest,
  CommitPrActionRequest,
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
  workflow?: WorkflowBlueprint;
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
    cache_write_tokens?: number;
    output_tokens: number;
    reasoning_tokens?: number;
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
  stall_silent_sec?: number;
  kind?: string;
}

export interface UsageBucketSummary {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  costUsd: number;
  cacheNetSavedUsd?: number;
}

export interface StageUsageBucketSummary extends UsageBucketSummary {
  runCount: number;
  reusedRunCount: number;
}

export interface WarmSessionStats {
  totalImplementRuns: number;
  reusedImplementRuns: number;
  warmCacheHitRate: number;
  coldCacheHitRate: number;
}

export interface UsageSnapshot {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  costUsd: number;
  cacheNetSavedUsd?: number;
  unknownPricingModels?: string[];
  byAgent: Record<string, UsageBucketSummary>;
  byModel: Record<string, UsageBucketSummary>;
  byAgentModel?: Record<string, Record<string, UsageBucketSummary>>;
  byStage?: Record<string, StageUsageBucketSummary>;
  byRosterRole?: Record<string, StageUsageBucketSummary>;
  warmSessionStats?: WarmSessionStats;
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

export type DraftCardWithBrief = DraftCard & {
  brief_markdown?: string;
  research_markdown?: string;
};

export interface BootstrapResponse {
  version?: string;
  tasks: BootstrapTask[];
  pendingDecisions: PendingDecision[];
  drafts: DraftCardWithBrief[];
  spaces: Record<string, SpaceConfig>;
  settings?: {
    roles: RolesConfig | null;
    limits: LimitsConfig | null;
    pricing: PricingConfig | null;
    roster?: RosterConfig | null;
    providers?: ProvidersConfig | null;
  };
  roles: RolesConfig | null;
  roster?: RosterConfig | null;
  limits: LimitsConfig | null;
  pricing: PricingConfig | null;
  providers?: ProviderRuntimeStatus[];
  usage: UsageSnapshot;
  budget?: GlobalBudgetStatus;
  runningCount: number;
  mergeQueue?: MergeQueueEntry[];
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
  cache_write_tokens?: number;
  output_tokens: number;
  reasoning_tokens?: number;
  provider_cost_usd?: number | null;
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
  stagedSha256?: string | null;
  diff: string;
  truncated: boolean;
}

export interface RunSessionInfo {
  backendId: string;
  sessionId: string;
  providerSessionId: string | null;
  providerSessionPath: string | null;
  displaySessionId: string | null;
  cwd: string | null;
  tuiSupported: boolean;
  tuiCommandPreview: string | null;
  tuiUnavailableReason: string | null;
}

export interface RunIoSummary {
  inputTitle: string;
  inputRef: string | null;
  outputVerdict: string;
  outputSummary: string;
  changedPaths: string[];
  gatePassed: boolean | null;
  totalTokens: number;
  costUsd: number;
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
  session?: RunSessionInfo;
  ioSummary?: RunIoSummary;
  antiDriftSummary?: RunAntiDriftSummary;
  acceptReport?: AcceptVerificationReport;
}

export interface ActiveAcceptEnvSnapshot {
  entryKind: AcceptEntryKind;
  primaryUrl?: string;
  services: AcceptServiceStatus[];
  traffic: AcceptTrafficSummary;
}

export interface OpenRunTuiResponse {
  ok: true;
  taskId: string;
  runDir: string;
  agent: string;
  providerSessionId: string;
  cwd: string;
  cwdFallback: boolean;
  commandPreview: string;
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
  plan?: string;
  research?: string;
  retro?: TaskRetroPayload | null;
  attachments?: TaskAttachment[];
  checkpoints?: CheckpointRecord[];
  decisions: string;
  pendingDecision: PendingDecision | null;
  ledgerProposals: LedgerProposalItem[];
  runs: TaskRunDetail[];
  usageTurns: UsageTurnRow[];
  usage: UsageSnapshot;
  budget?: BudgetScopeStatus;
  liveViewUrl?: string | null;
  activeAcceptEnv?: ActiveAcceptEnvSnapshot | null;
  hostBackup?: HostBackupManifestInfo | null;
  hostStagedDiffs?: HostStagedDiffEntry[];
  stateEvents?: StateEvent[];
  steers?: SteerNote[];
  chatMessages?: ChatMessage[];
  reviewChecklist?: ChecklistItem[];
  mergeQueueEntry?: MergeQueueEntry | null;
}

export interface ResolveTaskChecklistResponse {
  ok: true;
  mode: "steered" | "rework_queued" | "waived_and_advanced" | "recorded";
  taskId: string;
  status: TaskStatus;
  stage: StageId | null;
  reviewChecklist: ChecklistItem[];
  message?: string;
}

export interface HostRestoreConflictDetail {
  targetCanonicalPath: string;
  expectedPostSha256: string | null;
  actualSha256: string | null;
  expectedSummary?: string;
  actualSummary?: string;
  diff: string;
}

export interface TaskRetroPayload {
  report: TaskRetroReport;
  markdown: string | null;
}

export interface RoleModelEfficiencyStat {
  roster_role: string;
  agent: string;
  model: string;
  run_count: number;
  pass_rate: number;
  escalation_rate: number;
  cache_hit_rate: number;
  avg_cost_usd: number;
}

export interface WorkflowPresetEfficiencyStat {
  preset: string;
  metrics: PolicyMetricWindow;
}

export interface SpaceEfficiencyStat {
  space_id: string;
  space_name: string;
  metrics: PolicyMetricWindow;
}

export interface OrchestrationAnalytics {
  generated_at: string;
  overall: PolicyMetricWindow;
  by_space: SpaceEfficiencyStat[];
  by_role_model: RoleModelEfficiencyStat[];
  by_workflow_preset: WorkflowPresetEfficiencyStat[];
}

export interface PolicyChangeEvaluation extends PolicyChangeRecord {
  after_metrics: PolicyMetricWindow;
  regression_alert: boolean;
  regression_reasons: string[];
}

export interface ImprovementsSummaryResponse {
  ok: true;
  proposals: ImprovementProposal[];
  analytics: OrchestrationAnalytics;
  policyHistory: PolicyChangeEvaluation[];
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
  open_questions?: string[];
  workflow?: WorkflowBlueprint;
  contract?: Partial<CardContract>;
  brief_markdown?: string;
  intake_open?: boolean;
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
  workflow?: WorkflowBlueprint;
  contract?: Partial<CardContract>;
  limits?: CardLimits;
  brief_markdown: string;
}

export interface ChatResponsePayload {
  messages?: ChatMessage[];
  reply?: ChatMessage | string;
  draft?: DraftCardWithBrief;
  brief_markdown?: string;
  research_markdown?: string;
  pendingDecision?: PendingDecision | null;
  contractPatch?: Partial<CardContract>;
  card?: TaskCard;
}

export interface ReconDraftResponse {
  ok: true;
  draftId: string;
  ran: boolean;
  research_markdown?: string;
  skipped_reason?: string;
}

export type SettingsSectionMap = {
  roles: RolesConfig;
  limits: LimitsConfig;
  pricing: PricingConfig;
  providers: ProvidersConfig;
  roster: RosterConfig;
};

export interface ProvidersStatusResponse {
  ok: true;
  providers: ProviderRuntimeStatus[];
}

export interface TestProviderResponse {
  ok: true;
  status: ProviderRuntimeStatus;
  modelsCount?: number;
}

export interface ProviderSettingsResponse {
  ok: true;
  data: ProvidersConfig;
}

export interface RosterSettingsResponse {
  ok: true;
  data: RosterConfig;
}

export interface ScriptRunSummary {
  scriptRunId: string;
  spaceId: string;
  taskId?: string;
  script: SpaceScriptKey;
  command: string;
  cwd: string;
  running: boolean;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  outputTail: string;
  detectedUrls?: string[];
}

export interface ListScriptsResponse {
  ok: true;
  runs: ScriptRunSummary[];
}

export interface TaskCheckpointsResponse {
  ok: true;
  taskId: string;
  checkpoints: CheckpointRecord[];
}

export interface RollbackCheckpointResponse {
  ok: true;
  taskId: string;
  checkpoint_ref: string;
  commit_sha: string;
}

export interface PrDraftInfo {
  taskId: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}

export interface PrDraftResponse {
  ok: true;
  draft: PrDraftInfo;
}

export type DeliverGitResponse =
  | {
      ok: true;
      action: "commit";
      alreadyClean: boolean;
      branch: string;
      commitSha: string;
    }
  | {
      ok: true;
      action: "push";
      alreadyUpToDate: boolean;
      branch: string;
      commitSha: string;
    }
  | {
      ok: true;
      action: "open_pr";
      alreadyExists: boolean;
      prUrl: string;
      prNumber: number | null;
      prTitle: string;
      branch: string;
      baseBranch: string;
    };

export interface DraftAttachmentUploadPayload {
  filename: string;
  mime_type: TaskAttachment["mime_type"];
  data_base64: string;
}

export interface DraftAttachmentUploadResponse {
  ok: true;
  attachment: TaskAttachment;
  draft: DraftCardWithBrief;
}

export interface CommitSplitCardsResponse {
  ok: true;
  mode: "commit_split_cards";
  tempIdToTaskId: Record<string, string>;
  cards: TaskCard[];
  states: Array<Record<string, unknown>>;
}

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
  AcceptEntryConfig,
  AcceptEntryKind,
  AcceptServiceSpec,
  AcceptServiceStatus,
  AcceptTrafficSummary,
  AcceptVerificationReport,
  BudgetScopeStatus,
  ChatCommandAction,
  VerifierCapability,
  ChatCommandItem,
  ChatCommandKind,
  ChatCommandsResponse,
  ChatCommandSource,
  ChatMcpServerItem,
  ChecklistDisposition,
  ChecklistItem,
  CheckpointRecord,
  CommitPrActionRequest,
  DiscoveredGitRepo,
  DiscoverSpacesResponse,
  GithubCheckRunItem,
  GithubPrCommentItem,
  GithubPrFeedbackSnapshot,
  GlobalBudgetStatus,
  ImportGithubIssueRequest,
  ImprovementProposal,
  PairCompleteRequest,
  PickDirectoryResponse,
  PmOrchestrationPolicy,
  PolicyChangeRecord,
  PolicyMetricWindow,
  PrFeedbackReworkRequest,
  MergeQueueEntry,
  PricingSyncSource,
  ProviderAdapterKind,
  ProviderEntry,
  ProviderNativeQuota,
  ProviderRuntimeStatus,
  ProvidersConfig,
  PublicPairedDevice,
  RemoteAuthStatusResponse,
  RemoteConfig,
  RemoteNotificationChannel,
  RemoteNotificationTestRequest,
  RemotePairChallengeResponse,
  ResolveTaskChecklistRequest,
  RetroAttribution,
  RollbackCheckpointRequest,
  RosterConfig,
  RosterEntry,
  RosterExecutionMode,
  RosterGroup,
  RosterModelBinding,
  RosterPermission,
  RosterTierHint,
  RunAntiDriftSummary,
  RunSpaceScriptRequest,
  RunSpaceScriptResponse,
  SpaceFileEntry,
  SpaceFilesResponse,
  SpaceScriptKey,
  SpaceScripts,
  SplitCardPlanItem,
  SyncPricingRequest,
  SyncPricingResponse,
  TailscaleStatusResponse,
  TaskAttachment,
  TaskExternalRef,
  TaskRetroMetrics,
  TaskRetroReport,
  UpdateTaskLimitsRequest,
  WorkflowBlueprint,
  WorkflowPreset,
};
