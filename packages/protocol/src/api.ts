import { z } from "zod";
import {
  AcceptEntryConfigSchema,
  DecisionActionSchema,
  PrioritySchema,
  SpaceScriptsSchema,
  StageIdSchema,
} from "./card.js";
import {
  PricingConfigSchema,
  PricingSyncSourceSchema,
  ProviderAdapterKindSchema,
  PublicPairedDeviceSchema,
  RemoteNotificationChannelSchema,
  RoleIdSchema,
  TuiTerminalIdSchema,
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
  suggested_accept_entry: AcceptEntryConfigSchema.optional(),
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
  accept_entry: AcceptEntryConfigSchema.optional(),
  freeze_patterns: z.array(z.string().trim().min(1)).default([]),
  pinned: z.boolean().optional(),
  scripts: SpaceScriptsSchema.optional(),
  intake_checklist: z.array(z.string().trim().min(1)).optional(),
  accept_scenarios: z.array(z.string().trim().min(1)).optional(),
  default_workflow_preset: z.enum(["quick", "host_op", "standard_dev", "full_delivery"]).optional(),
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
export type RemotePairChallengeResponse = z.infer<typeof RemotePairChallengeResponseSchema>;

export const RemoteAuthStatusResponseSchema = z.object({
  ok: z.literal(true),
  mode: z.enum(["local", "remote"]),
  authenticated: z.boolean(),
  device: PublicPairedDeviceSchema.nullable(),
});
export type RemoteAuthStatusResponse = z.infer<typeof RemoteAuthStatusResponseSchema>;

export const RemoteNotificationTestRequestSchema = z.object({
  channel: RemoteNotificationChannelSchema.optional(),
  url: z.string().trim().min(1).optional(),
  secret: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(160).optional(),
  body: z.string().trim().min(1).max(1000).optional(),
});
export type RemoteNotificationTestRequest = z.infer<typeof RemoteNotificationTestRequestSchema>;

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
export type TailscaleStatusResponse = z.infer<typeof TailscaleStatusResponseSchema>;

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

export const DetectedTuiTerminalSchema = z.object({
  id: TuiTerminalIdSchema,
  label: z.string().min(1),
  available: z.boolean(),
  isDefaultFallback: z.boolean().optional(),
});
export type DetectedTuiTerminal = z.infer<typeof DetectedTuiTerminalSchema>;

export const OpenRunTuiResponseSchema = z.object({
  ok: z.literal(true),
  taskId: z.string().min(1),
  runDir: z.string().min(1),
  agent: z.string().min(1),
  providerSessionId: z.string().min(1),
  cwd: z.string().min(1),
  cwdFallback: z.boolean().default(false),
  commandPreview: z.string().min(1),
  terminal: z.string().min(1).optional(),
  terminalId: TuiTerminalIdSchema.optional(),
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

export const UpdateTaskLimitsRequestSchema = z.object({
  max_cost_usd: z.number().finite().positive().nullable().optional(),
});
export type UpdateTaskLimitsRequest = z.infer<typeof UpdateTaskLimitsRequestSchema>;

export const ImportGithubIssueRequestSchema = z.object({
  space: z.string().trim().min(1),
  issue: z.string().trim().min(1),
});
export type ImportGithubIssueRequest = z.infer<typeof ImportGithubIssueRequestSchema>;

export const GithubCheckRunItemSchema = z.object({
  name: z.string().min(1),
  status: z.string().min(1),
  conclusion: z.string().nullable().optional(),
  details_url: z.string().optional(),
});
export type GithubCheckRunItem = z.infer<typeof GithubCheckRunItemSchema>;

export const GithubPrCommentItemSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["comment", "review"]),
  author: z.string().min(1),
  body: z.string(),
  created_at: z.string().optional(),
  url: z.string().optional(),
  state: z.string().optional(),
});
export type GithubPrCommentItem = z.infer<typeof GithubPrCommentItemSchema>;

export const GithubPrFeedbackSnapshotSchema = z.object({
  repo: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().min(1),
  title: z.string().min(1),
  state: z.string().min(1),
  head_branch: z.string().min(1),
  base_branch: z.string().min(1),
  mergeable: z.string().nullable().optional(),
  checks: z.array(GithubCheckRunItemSchema),
  comments: z.array(GithubPrCommentItemSchema),
  fetched_at: z.string().min(1),
});
export type GithubPrFeedbackSnapshot = z.infer<typeof GithubPrFeedbackSnapshotSchema>;

export const PrFeedbackReworkRequestSchema = z
  .object({
    pr_ref: z.string().trim().min(1).optional(),
    failed_check_names: z.array(z.string().trim().min(1)).default([]),
    comment_ids: z.array(z.string().trim().min(1)).default([]),
    extra_note: z.string().trim().max(1500).optional(),
    interrupt: z.boolean().default(false),
  })
  .refine(
    (v) =>
      v.failed_check_names.length > 0 ||
      v.comment_ids.length > 0 ||
      Boolean(v.extra_note && v.extra_note.length > 0),
    {
      message: "Must select at least one failed check, comment, or provide extra_note",
    },
  );
export type PrFeedbackReworkRequest = z.infer<typeof PrFeedbackReworkRequestSchema>;

export const MergeQueueEntrySchema = z.object({
  task_id: z.string().min(1),
  space: z.string().min(1),
  title: z.string().min(1),
  state: z.enum(["merging", "queued"]),
  position: z.number().int().positive(),
  priority: PrioritySchema,
});
export type MergeQueueEntry = z.infer<typeof MergeQueueEntrySchema>;

const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*[a-zA-Z]/g;
const LOCAL_URL_CANDIDATE_RE =
  /(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):(\d{1,5})(\/[^\s"'<>)\]]*)?/gi;

/**
 * Extracts normalized, validated local preview URLs (`localhost`, `127.0.0.1`, `[::1]`)
 * from noisy script output (stripping ANSI escapes and normalizing `0.0.0.0` / `[::]`).
 */
export function extractLocalPreviewUrls(text: string, maxCount = 6): string[] {
  if (!text) return [];
  const clean = text.replace(ANSI_ESCAPE_RE, "");

  const result: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(LOCAL_URL_CANDIDATE_RE.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(clean)) !== null) {
    const scheme = match[1]!.toLowerCase();
    const rawHost = match[2]!.toLowerCase();
    const portNum = Number.parseInt(match[3]!, 10);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      continue;
    }
    const host = rawHost === "0.0.0.0" ? "127.0.0.1" : rawHost === "[::]" ? "localhost" : rawHost;
    const rawSuffix = (match[4] ?? "").replace(/[.,;:)\]]+$/, "");
    const suffix = rawSuffix.length > 0 ? rawSuffix : "/";
    const normalized = `${scheme}://${host}:${portNum}${suffix}`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maxCount) break;
  }
  return result;
}

export const CHECKLIST_ITEM_SOURCES = ["review", "accept"] as const;
export type ChecklistItemSource = (typeof CHECKLIST_ITEM_SOURCES)[number];

export const CHECKLIST_DISPOSITIONS = ["rework", "waive"] as const;
export type ChecklistDisposition = (typeof CHECKLIST_DISPOSITIONS)[number];

export const ChecklistItemSeveritySchema = z.enum(["P0", "P1", "P2", "fail", "skipped", "pass"]);
export type ChecklistItemSeverity = z.infer<typeof ChecklistItemSeveritySchema>;

export const ChecklistItemSchema = z.object({
  id: z.string().min(1),
  run_dir: z.string().min(1),
  run_id: z.string().min(1).optional(),
  source: z.enum(CHECKLIST_ITEM_SOURCES),
  severity: ChecklistItemSeveritySchema,
  title: z.string().min(1),
  location: z.string().min(1).optional(),
  detail: z.string().min(1).optional(),
  evidence_files: z.array(z.string().min(1)).optional(),
  disposition: z.enum(CHECKLIST_DISPOSITIONS).optional(),
  rationale: z.string().min(1).optional(),
  decided_at: z.string().min(1).optional(),
  contract_version: z.number().int().positive().optional(),
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const ChecklistDispositionRecordSchema = z.object({
  item_id: z.string().min(1),
  run_dir: z.string().min(1),
  source: z.enum(CHECKLIST_ITEM_SOURCES),
  disposition: z.enum(CHECKLIST_DISPOSITIONS),
  rationale: z.string().optional(),
  decided_at: z.string().min(1),
  contract_version: z.number().int().positive(),
});
export type ChecklistDispositionRecord = z.infer<typeof ChecklistDispositionRecordSchema>;

export const TaskChecklistDispositionsFileSchema = z.object({
  schema_version: z.literal(1).default(1),
  task_id: z.string().min(1),
  updated_at: z.string().min(1),
  records: z.array(ChecklistDispositionRecordSchema),
});
export type TaskChecklistDispositionsFile = z.infer<typeof TaskChecklistDispositionsFileSchema>;

export const ChecklistResolveActionItemSchema = z
  .object({
    item_id: z.string().trim().min(1),
    disposition: z.enum(CHECKLIST_DISPOSITIONS),
    rationale: z.string().trim().max(1500).optional(),
  })
  .superRefine((v, ctx) => {
    if (
      v.disposition === "waive" &&
      (v.rationale === undefined || v.rationale.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Waiving a checklist item requires a non-empty rationale",
        path: ["rationale"],
      });
    }
  });
export type ChecklistResolveActionItem = z.infer<typeof ChecklistResolveActionItemSchema>;

export const ResolveTaskChecklistRequestSchema = z.object({
  items: z.array(ChecklistResolveActionItemSchema).min(1).max(100),
  extra_note: z.string().trim().max(1500).optional(),
  interrupt: z.boolean().default(false),
  advance_after_waive: z.boolean().default(false),
});
export type ResolveTaskChecklistRequest = z.infer<typeof ResolveTaskChecklistRequestSchema>;
