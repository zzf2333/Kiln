import { z } from "zod";
import { RoleIdSchema } from "./config.js";

export const TASK_STATUSES = [
  "queued",
  "running",
  "paused",
  "waiting",
  "external",
  "done",
  "cancelled",
] as const;

export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export const PrioritySchema = z.enum(PRIORITIES);
export type Priority = z.infer<typeof PrioritySchema>;

export const PRIORITY_RANK: Record<Priority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

export const TRACKS = ["L1", "L2", "L3"] as const;
export const TrackSchema = z.enum(TRACKS);
export type Track = z.infer<typeof TrackSchema>;

export const WORKSPACE_MODES = [
  "git_worktree",
  "host_scoped",
  "scratch_dir",
  "external_only",
] as const;

export const WorkspaceModeSchema = z.enum(WORKSPACE_MODES);
export type WorkspaceMode = z.infer<typeof WorkspaceModeSchema>;

export const STAGE_IDS = [
  "intake",
  "implement",
  "research",
  "verify",
  "review",
  "accept",
  "triage",
  "advise",
  "deliver",
] as const;

export const StageIdSchema = z.enum(STAGE_IDS);
export type StageId = z.infer<typeof StageIdSchema>;

export const DeliverConfigSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("merge_main"), cmd: z.null().optional() }),
  z.object({ mode: z.literal("open_pr"), cmd: z.null().optional() }),
  z.object({ mode: z.literal("run_cmd"), cmd: z.string().trim().min(1) }),
  z.object({ mode: z.literal("manual"), cmd: z.null().optional() }),
]);
export type DeliverConfig = z.infer<typeof DeliverConfigSchema>;

export const CardContractSchema = z.object({
  goal: z.string().min(1),
  end: z.string().min(1),
  accept_cmd: z.string().min(1),
  accept_files_hash: z.string().min(1),
  scope: z.array(z.string().min(1)),
  deliver: DeliverConfigSchema,
  human_accept: z.boolean().default(false),
  external_actions: z.literal("ask").default("ask"),
});
export type CardContract = z.infer<typeof CardContractSchema>;

export const CardLimitsSchema = z.object({
  retries_per_stage: z.number().int().min(0),
  review_rounds: z.number().int().min(0),
  advisor_calls: z.number().int().min(0),
  max_tokens: z.number().int().min(1),
});
export type CardLimits = z.infer<typeof CardLimitsSchema>;

export const TaskCardSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  title: z.string().min(1),
  space: z.string().min(1),
  priority: PrioritySchema,
  track: TrackSchema,
  workspace_mode: WorkspaceModeSchema,
  parent: z.string().min(1).nullable().default(null),
  depends_on: z.array(z.string().min(1)).default([]),
  contract_version: z.number().int().positive(),
  contract: CardContractSchema,
  limits: CardLimitsSchema,
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});
export type TaskCard = z.infer<typeof TaskCardSchema>;

export const SessionRefSchema = z.object({
  backendId: z.string().min(1),
  sessionId: z.string().min(1),
  meta: z.record(z.string(), z.string()).optional(),
});
export type SessionRef = z.infer<typeof SessionRefSchema>;

export const DraftCardSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  title: z.string().default(""),
  space: z.string().default("local"),
  priority: PrioritySchema.default("P2"),
  track: TrackSchema.default("L2"),
  workspace_mode: WorkspaceModeSchema.default("git_worktree"),
  depends_on: z.array(z.string().min(1)).default([]),
  contract: CardContractSchema.partial().default({}),
  session_ref: SessionRefSchema.nullable().optional(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});
export type DraftCard = z.infer<typeof DraftCardSchema>;

export const RunMetaSchema = z.object({
  schema_version: z.literal(1).default(1),
  run_id: z.string().min(1),
  task_id: z.string().min(1),
  stage: StageIdSchema,
  round: z.number().int().positive(),
  role: RoleIdSchema,
  contract_version: z.number().int().positive(),
  backend_id: z.string().min(1),
  agent: z.string().min(1),
  model: z.string().min(1),
  session_ref: SessionRefSchema,
  input_ref: z.string().min(1).optional(),
  started_at: z.string().min(1),
});
export type RunMeta = z.infer<typeof RunMetaSchema>;

export const DECISION_ACTIONS = [
  "resume",
  "return_external",
  "finish",
  "cancel",
] as const;

export const DecisionActionSchema = z.enum(DECISION_ACTIONS);
export type DecisionAction = z.infer<typeof DecisionActionSchema>;

export const DecisionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  action: DecisionActionSchema,
  target_stage: StageIdSchema.optional(),
  cost_note: z.string().optional(),
  recommended: z.boolean().default(false),
  ledger_rule: z.string().min(1).optional(),
});
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

export const PendingDecisionSchema = z.object({
  id: z.string().min(1),
  task_id: z.string().min(1),
  run_id: z.string().min(1).optional(),
  contract_version: z.number().int().positive(),
  reason: z.string().min(1),
  category: z.string().min(1),
  question: z.string().min(1),
  options: z.array(DecisionOptionSchema).min(1),
  created_at: z.string().min(1),
});
export type PendingDecision = z.infer<typeof PendingDecisionSchema>;

export const DecisionRecordSchema = z.object({
  schema_version: z.literal(1).default(1),
  id: z.string().min(1),
  task_id: z.string().min(1),
  contract_version: z.number().int().positive(),
  category: z.string().min(1),
  decider: z.enum(["human", "triage", "advisor", "kernel"]),
  action: DecisionActionSchema,
  chosen_option_id: z.string().min(1).optional(),
  affected_stages: z.array(StageIdSchema),
  ledger_proposal: z.string().min(1).optional(),
  rationale: z.string().min(1),
  decided_at: z.string().min(1),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export const StateEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("queued"), at: z.string().min(1) }),
  z.object({
    type: z.literal("running"),
    at: z.string().min(1),
    stage: StageIdSchema,
    round: z.number().int().positive(),
    run_id: z.string().min(1),
  }),
  z.object({
    type: z.literal("paused"),
    at: z.string().min(1),
    stage: StageIdSchema.optional(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal("resumed"),
    at: z.string().min(1),
    stage: StageIdSchema,
  }),
  z.object({
    type: z.literal("waiting"),
    at: z.string().min(1),
    reason: z.string().min(1),
    decision_id: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("decided"),
    at: z.string().min(1),
    decision_id: z.string().min(1),
    action: DecisionActionSchema,
    target_stage: StageIdSchema.optional(),
  }),
  z.object({
    type: z.literal("external"),
    at: z.string().min(1),
    detail: z.string().optional(),
  }),
  z.object({
    type: z.literal("done"),
    at: z.string().min(1),
    deliver_ref: z.string().optional(),
  }),
  z.object({
    type: z.literal("cancelled"),
    at: z.string().min(1),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal("contract_updated"),
    at: z.string().min(1),
    from_version: z.number().int().positive(),
    to_version: z.number().int().positive(),
    affected_stages: z.array(StageIdSchema),
  }),
  z.object({
    type: z.literal("priority_changed"),
    at: z.string().min(1),
    from: PrioritySchema,
    to: PrioritySchema,
  }),
  z.object({
    type: z.literal("track_escalated"),
    at: z.string().min(1),
    from: TrackSchema,
    to: TrackSchema,
    reason: z.string().min(1),
  }),
]);
export type StateEvent = z.infer<typeof StateEventSchema>;

export const GateReportSchema = z.object({
  schema_version: z.literal(1),
  run_id: z.string().min(1),
  contract_version: z.number().int().positive(),
  schema_ok: z.boolean(),
  scope_ok: z.boolean(),
  artifacts_ok: z.boolean().default(true),
  out_of_scope_paths: z.array(z.string()),
  frozen_files_changed: z.array(z.string()),
  accept_exit_code: z.number().int(),
  accept_duration_ms: z.number().int().nonnegative(),
  escalated_to_l2: z.boolean(),
  checked_at: z.string().min(1),
});
export type GateReport = z.infer<typeof GateReportSchema>;

export const SpaceConfigSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  repo_path: z.string().min(1).optional(),
  default_branch: z.string().min(1).default("main"),
  copy_untracked: z.array(z.string()).default([]),
  clone_deps: z.array(z.string()).default([]),
  default_accept_cmd: z.string().min(1).optional(),
  freeze_patterns: z.array(z.string()).default([]),
});
export type SpaceConfig = z.infer<typeof SpaceConfigSchema>;

export const LedgerEntrySchema = z.object({
  id: z.string().min(1),
  space: z.string().min(1),
  rule: z.string().min(1),
  source_task_id: z.string().min(1),
  source_decision_id: z.string().min(1).optional(),
  created_at: z.string().min(1),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const LedgerFileSchema = z.object({
  schema_version: z.literal(1),
  space: z.string().min(1),
  entries: z.array(LedgerEntrySchema),
});
export type LedgerFile = z.infer<typeof LedgerFileSchema>;
