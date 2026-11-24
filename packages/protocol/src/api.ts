import { z } from "zod";
import { DecisionActionSchema, PrioritySchema, SpaceScriptsSchema, StageIdSchema } from "./card.js";
import {
  PricingConfigSchema,
  PricingSyncSourceSchema,
  ProviderAdapterKindSchema,
  PublicPairedDeviceSchema,
  RemoteNotificationChannelSchema,
  RoleIdSchema,
} from "./config.js";
import { SPACE_SCRIPT_KEYS } from "./constants.js";
import { McpToolNameSchema } from "./mcp.js";

export const DecideRequestSchema = z.object({
  decision_id: z.string().min(1),
  option_id: z.string().min(1),
  action: DecisionActionSchema.optional(),
  rationale: z.string().min(1).optional(),
  apply_ledger_rule: z.boolean().default(false),
});
export type DecideRequest = z.infer<typeof DecideRequestSchema>;

export const PriorityUpdateRequestSchema = z.object({
  priority: PrioritySchema,
});
export type PriorityUpdateRequest = z.infer<typeof PriorityUpdateRequestSchema>;

export const HashMismatchErrorSchema = z.object({
  code: z.literal("hash_mismatch"),
  path: z.string().min(1),
  expectedSha256: z.string().min(1),
  actualSha256: z.string().min(1),
  diff: z.string(),
});
export type HashMismatchError = z.infer<typeof HashMismatchErrorSchema>;

export const RoleForbiddenErrorSchema = z.object({
  code: z.literal("role_forbidden"),
  role: RoleIdSchema,
  tool: McpToolNameSchema,
  message: z.string().min(1),
});
export type RoleForbiddenError = z.infer<typeof RoleForbiddenErrorSchema>;

export const InspectSpaceRequestSchema = z.object({
  path: z.string().trim().min(1),
});
export type InspectSpaceRequest = z.infer<typeof InspectSpaceRequestSchema>;

export const InspectSpaceResponseSchema = z.object({
  ok: z.literal(true),
  repo_path: z.string().min(1),
  suggested_id: z.string().min(1),
  suggested_name: z.string().min(1),
  default_branch: z.string().min(1),
  default_accept_cmd: z.string().min(1).optional(),
  copy_untracked: z.array(z.string()).default([]),
  clone_deps: z.array(z.string()).default([]),
});
export type InspectSpaceResponse = z.infer<typeof InspectSpaceResponseSchema>;

export const DiscoveredGitRepoSchema = z.object({
  repo_path: z.string().min(1),
  display_path: z.string().min(1),
  name: z.string().min(1),
  suggested_id: z.string().min(1),
  default_branch: z.string().min(1),
  modified_at: z.string().min(1),
  already_added: z.boolean(),
  space_id: z.string().min(1).optional(),
});
export type DiscoveredGitRepo = z.infer<typeof DiscoveredGitRepoSchema>;

export const DiscoverSpacesResponseSchema = z.object({
  ok: z.literal(true),
  repos: z.array(DiscoveredGitRepoSchema),
  scanned_roots: z.array(z.string()),
  truncated: z.boolean().default(false),
});
export type DiscoverSpacesResponse = z.infer<typeof DiscoverSpacesResponseSchema>;

export const PickDirectoryResponseSchema = z.object({
  ok: z.literal(true),
  cancelled: z.boolean(),
  path: z.string().min(1).nullable(),
});
export type PickDirectoryResponse = z.infer<typeof PickDirectoryResponseSchema>;

export const UpsertSpaceRequestSchema = z.object({
  name: z.string().trim().min(1),
  repo_path: z.string().trim().min(1),
  default_branch: z.string().trim().min(1).default("main"),
  copy_untracked: z.array(z.string().trim().min(1)).default([]),
  clone_deps: z.array(z.string().trim().min(1)).default([]),
  default_accept_cmd: z.string().trim().min(1).optional(),
  freeze_patterns: z.array(z.string().trim().min(1)).default([]),
  pinned: z.boolean().optional(),
  scripts: SpaceScriptsSchema.optional(),
});
export type UpsertSpaceRequest = z.infer<typeof UpsertSpaceRequestSchema>;

export const PairCompleteRequestSchema = z
  .object({
    token: z.string().trim().min(1).optional(),
    code: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).max(120).optional(),
  })
  .refine((v) => v.token !== undefined || v.code !== undefined, {
    message: "Either token or code must be provided",
  });
export type PairCompleteRequest = z.infer<typeof PairCompleteRequestSchema>;

export const RemotePairChallengeResponseSchema = z.object({
  ok: z.literal(true),
  challengeId: z.string().min(1),
  code: z.string().min(1),
  token: z.string().min(1),
  expiresAt: z.string().min(1),
  pairUrl: z.string().min(1).nullable(),
});
export type RemotePairChallengeResponse = z.infer<
  typeof RemotePairChallengeResponseSchema
>;

export const RemoteAuthStatusResponseSchema = z.object({
  ok: z.literal(true),
  mode: z.enum(["local", "remote"]),
  authenticated: z.boolean(),
  device: PublicPairedDeviceSchema.nullable(),
});
export type RemoteAuthStatusResponse = z.infer<
  typeof RemoteAuthStatusResponseSchema
>;

export const RemoteNotificationTestRequestSchema = z.object({
  channel: RemoteNotificationChannelSchema.optional(),
  url: z.string().trim().min(1).optional(),
  secret: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(160).optional(),
  body: z.string().trim().min(1).max(1000).optional(),
});
export type RemoteNotificationTestRequest = z.infer<
  typeof RemoteNotificationTestRequestSchema
>;

export const TailscaleStatusResponseSchema = z.object({
  ok: z.literal(true),
  installed: z.boolean(),
  running: z.boolean(),
  backendState: z.string().nullable(),
  dnsName: z.string().nullable(),
  magicDnsUrl: z.string().nullable(),
  serveActive: z.boolean(),
  serveConfiguredForPort: z.boolean(),
  serveTargets: z.array(z.string()).default([]),
  remotePort: z.number().int().min(1).max(65535),
  recommendedCommand: z.string().min(1),
  detail: z.string().optional(),
});
export type TailscaleStatusResponse = z.infer<
  typeof TailscaleStatusResponseSchema
>;

export const SyncPricingRequestSchema = z.object({
  force: z.boolean().optional(),
  restore_model: z.string().trim().min(1).optional(),
});
export type SyncPricingRequest = z.infer<typeof SyncPricingRequestSchema>;

export const SyncPricingResponseSchema = z.object({
  ok: z.literal(true),
  pricing: PricingConfigSchema,
  source: PricingSyncSourceSchema,
  synced_at: z.string().min(1),
  from_cache: z.boolean(),
  matched_models: z.array(z.string()),
  unmatched_models: z.array(z.string()),
  preserved_overrides: z.array(z.string()),
  warning: z.string().optional(),
});
export type SyncPricingResponse = z.infer<typeof SyncPricingResponseSchema>;

export const ChatCommandSourceSchema = z.enum(["kiln", "skill"]);
export type ChatCommandSource = z.infer<typeof ChatCommandSourceSchema>;

export const ChatCommandKindSchema = z.enum(["command", "skill"]);
export type ChatCommandKind = z.infer<typeof ChatCommandKindSchema>;

export const ChatCommandActionSchema = z.enum([
  "new_draft",
  "fill_draft",
  "generate_brief",
  "split_slices",
]);
export type ChatCommandAction = z.infer<typeof ChatCommandActionSchema>;

export const ChatCommandItemSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  argumentHint: z.string().default(""),
  kind: ChatCommandKindSchema.default("command"),
  source: ChatCommandSourceSchema,
  scope: z.enum(["project", "user"]).optional(),
  action: ChatCommandActionSchema.optional(),
});
export type ChatCommandItem = z.infer<typeof ChatCommandItemSchema>;

export const ChatMcpServerItemSchema = z.object({
  name: z.string().min(1),
  scope: z.enum(["project", "kiln", "agent"]),
  origin: z.string().min(1),
});
export type ChatMcpServerItem = z.infer<typeof ChatMcpServerItemSchema>;

export const ChatCommandsResponseSchema = z.object({
  ok: z.literal(true),
  role: z.enum(["intake", "resolver"]),
  agent: z.string().nullable(),
  model: z.string().nullable(),
  commands: z.array(ChatCommandItemSchema),
  mcpServers: z.array(ChatMcpServerItemSchema).default([]),
});
export type ChatCommandsResponse = z.infer<typeof ChatCommandsResponseSchema>;

export const SpaceFileEntrySchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["file", "dir"]),
});
export type SpaceFileEntry = z.infer<typeof SpaceFileEntrySchema>;

export const SpaceFilesResponseSchema = z.object({
  ok: z.literal(true),
  spaceId: z.string().min(1),
  query: z.string(),
  rootLabel: z.string().optional(),
  files: z.array(SpaceFileEntrySchema),
  truncated: z.boolean(),
});
export type SpaceFilesResponse = z.infer<typeof SpaceFilesResponseSchema>;

export const OpenRunTuiResponseSchema = z.object({
  ok: z.literal(true),
  taskId: z.string().min(1),
  runDir: z.string().min(1),
  agent: z.string().min(1),
  providerSessionId: z.string().min(1),
  cwd: z.string().min(1),
  cwdFallback: z.boolean().default(false),
  commandPreview: z.string().min(1),
});
export type OpenRunTuiResponse = z.infer<typeof OpenRunTuiResponseSchema>;

export const ProviderNativeQuotaSchema = z.object({
  source: z.string().min(1),
  used_percent: z.number().finite().min(0).max(100),
  window_duration_mins: z.number().int().positive().nullable().optional(),
  resets_at: z.string().min(1).nullable().optional(),
  plan_type: z.string().min(1).nullable().optional(),
});
export type ProviderNativeQuota = z.infer<typeof ProviderNativeQuotaSchema>;

export const ProviderRuntimeStatusSchema = z.object({
  provider_id: z.string().min(1),
  label: z.string().min(1),
  adapter: ProviderAdapterKindSchema,
  status: z.enum(["ready", "cooldown", "unavailable", "auth_required"]),
  version: z.string().min(1).nullable().optional(),
  cooldown_until: z.string().min(1).nullable().optional(),
  detail: z.string().optional(),
  native_quota: ProviderNativeQuotaSchema.nullable().optional(),
  local_window_cost_usd: z.number().finite().nonnegative().optional(),
  local_window_tokens: z.number().int().nonnegative().optional(),
});
export type ProviderRuntimeStatus = z.infer<typeof ProviderRuntimeStatusSchema>;

export const RunSpaceScriptRequestSchema = z.object({
  script: z.enum(SPACE_SCRIPT_KEYS),
  taskId: z.string().min(1).optional(),
});
export type RunSpaceScriptRequest = z.infer<typeof RunSpaceScriptRequestSchema>;

export const RunSpaceScriptResponseSchema = z.object({
  ok: z.literal(true),
  scriptRunId: z.string().min(1),
  spaceId: z.string().min(1),
  script: z.enum(SPACE_SCRIPT_KEYS),
  command: z.string().min(1),
  cwd: z.string().min(1),
});
export type RunSpaceScriptResponse = z.infer<typeof RunSpaceScriptResponseSchema>;

export const RollbackCheckpointRequestSchema = z.object({
  checkpoint_ref: z
    .string()
    .min(1)
    .refine((r) => r.startsWith("refs/kiln/checkpoints/"), {
      message: 'checkpoint_ref must start with "refs/kiln/checkpoints/"',
    }),
  confirm: z.literal(true),
});
export type RollbackCheckpointRequest = z.infer<typeof RollbackCheckpointRequestSchema>;

export const CommitPrActionRequestSchema = z.object({
  action: z.enum(["commit", "push", "open_pr"]),
  commit_message: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
  base_branch: z.string().trim().min(1).optional(),
  pr_title: z.string().trim().min(1).optional(),
  pr_body: z.string().optional(),
  confirm: z.literal(true),
});
export type CommitPrActionRequest = z.infer<typeof CommitPrActionRequestSchema>;

export const SteerTaskRequestSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  interrupt: z.boolean().default(false),
});
export type SteerTaskRequest = z.infer<typeof SteerTaskRequestSchema>;

export const SteerNoteSchema = z.object({
  id: z.string().min(1),
  at: z.string().min(1),
  message: z.string().min(1),
  interrupt: z.boolean(),
  contract_version: z.number().int().positive(),
  stage: StageIdSchema.optional(),
});
export type SteerNote = z.infer<typeof SteerNoteSchema>;
