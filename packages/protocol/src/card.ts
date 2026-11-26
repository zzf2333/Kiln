import { z } from "zod";
import { RoleIdSchema } from "./config.js";
import {
  ACCEPT_ENTRY_KINDS,
  ACCEPT_PROBE_KINDS,
  ADVISOR_ELIGIBLE_DECISION_CATEGORIES,
  ATTACHMENT_MIME_TYPES,
  DECISION_ACTIONS,
  IMPROVEMENT_PROPOSAL_STATUSES,
  IMPROVEMENT_TARGET_KINDS,
  MAX_ACTIVE_LEDGER_INJECT,
  MAX_ATTACHMENT_BYTES,
  PRIORITIES,
  PRIORITY_RANK,
  RETRO_ATTRIBUTION_CATEGORIES,
  SHA256_HEX_RE,
  STAGE_IDS,
  TASK_STATUSES,
  TRACKS,
  VERIFIER_CAPABILITIES,
  VERIFIER_ENTRY_MODES,
  WORKFLOW_PRESETS,
  WORKSPACE_MODES,
  isAdvisorEligibleDecisionCategory,
  type AcceptEntryKind,
  type AcceptProbeKind,
  type AdvisorEligibleDecisionCategory,
  type AttachmentMimeType,
  type DecisionAction,
  type ImprovementProposalStatus,
  type ImprovementTargetKind,
  type Priority,
  type RetroAttributionCategory,
  type StageId,
  type TaskStatus,
  type Track,
  type VerifierCapability,
  type VerifierEntryMode,
  type WorkflowPreset,
  type WorkspaceMode,
} from "./constants.js";
import { MidFlightSubtaskSpecSchema } from "./receipts.js";
import { WorkflowBlueprintSchema } from "./workflow.js";

export {
  ACCEPT_ENTRY_KINDS,
  ACCEPT_PROBE_KINDS,
  ADVISOR_ELIGIBLE_DECISION_CATEGORIES,
  ATTACHMENT_MIME_TYPES,
  DECISION_ACTIONS,
  IMPROVEMENT_PROPOSAL_STATUSES,
  IMPROVEMENT_TARGET_KINDS,
  MAX_ACTIVE_LEDGER_INJECT,
  MAX_ATTACHMENT_BYTES,
  PRIORITIES,
  PRIORITY_RANK,
  RETRO_ATTRIBUTION_CATEGORIES,
  STAGE_IDS,
  TASK_STATUSES,
  TRACKS,
  VERIFIER_CAPABILITIES,
  VERIFIER_ENTRY_MODES,
  WORKFLOW_PRESETS,
  WORKSPACE_MODES,
  isAdvisorEligibleDecisionCategory,
  type AcceptEntryKind,
  type AcceptProbeKind,
  type AdvisorEligibleDecisionCategory,
  type AttachmentMimeType,
  type DecisionAction,
  type ImprovementProposalStatus,
  type ImprovementTargetKind,
  type Priority,
  type RetroAttributionCategory,
  type StageId,
  type TaskStatus,
  type Track,
  type VerifierCapability,
  type VerifierEntryMode,
  type WorkflowPreset,
  type WorkspaceMode,
};

export const TaskStatusSchema = z.enum(TASK_STATUSES);

export const PrioritySchema = z.enum(PRIORITIES);

export const TrackSchema = z.enum(TRACKS);

export const WorkspaceModeSchema = z.enum(WORKSPACE_MODES);

export const StageIdSchema = z.enum(STAGE_IDS);

export const DeliverConfigSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("merge_main"), cmd: z.null().optional() }),
  z.object({ mode: z.literal("open_pr"), cmd: z.null().optional() }),
  z.object({ mode: z.literal("run_cmd"), cmd: z.string().trim().min(1) }),
  z.object({ mode: z.literal("manual"), cmd: z.null().optional() }),
]);
export type DeliverConfig = z.infer<typeof DeliverConfigSchema>;

export const TaskAttachmentSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  mime_type: z.enum(ATTACHMENT_MIME_TYPES),
  size_bytes: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  sha256: z.string().regex(SHA256_HEX_RE, "sha256 must be a 64-char lowercase hex digest"),
  rel_path: z.string().min(1),
  added_at: z.string().min(1),
});
export type TaskAttachment = z.infer<typeof TaskAttachmentSchema>;

export const TaskExternalRefSchema = z.object({
  provider: z.literal("github"),
  repo: z.string().min(1),
  issue_number: z.number().int().positive().optional(),
  issue_url: z.string().min(1).optional(),
  pr_number: z.number().int().positive().optional(),
  pr_url: z.string().min(1).optional(),
  pr_branch: z.string().min(1).optional(),
});
export type TaskExternalRef = z.infer<typeof TaskExternalRefSchema>;

export const AcceptReadyProbeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("http"),
    path: z.string().trim().min(1).default("/"),
    expected_status: z.number().int().min(100).max(599).optional(),
  }),
  z.object({
    kind: z.literal("tcp"),
  }),
  z.object({
    kind: z.literal("stdout_regex"),
    pattern: z.string().min(1),
  }),
  z.object({
    kind: z.literal("delay"),
    ms: z.number().int().min(100).max(30_000).default(500),
  }),
]);
export type AcceptReadyProbe = z.infer<typeof AcceptReadyProbeSchema>;

const ACCEPT_SERVICE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function isSafeRelativeServiceCwd(cwd: string): boolean {
  const trimmed = cwd.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[A-Za-z]:/.test(trimmed)) {
    return false;
  }
  const parts = trimmed.split(/[\\/]+/);
  return !parts.some((p) => p === "..");
}

export const AcceptServiceSpecSchema = z.object({
  name: z
    .string()
    .regex(ACCEPT_SERVICE_NAME_RE, "service name must match ^[a-z0-9][a-z0-9_-]{0,31}$"),
  cmd: z.string().trim().min(1),
  cwd: z
    .string()
    .trim()
    .min(1)
    .refine(isSafeRelativeServiceCwd, {
      message: "service cwd must be a relative path inside the workspace without .. segments",
    })
    .optional(),
  needs_port: z.boolean().default(true),
  primary: z.boolean().optional(),
  depends_on: z.array(z.string().min(1)).default([]),
  ready: AcceptReadyProbeSchema.optional(),
  ready_timeout_ms: z.number().int().min(1000).max(180_000).default(30_000),
  env: z.record(z.string().min(1), z.string()).optional(),
});
export type AcceptServiceSpec = z.infer<typeof AcceptServiceSpecSchema>;

function validateAcceptServiceGraph(
  services: readonly AcceptServiceSpec[],
  ctx: z.RefinementCtx,
): void {
  const nameMap = new Map<string, number>();
  services.forEach((svc, idx) => {
    if (nameMap.has(svc.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate accept service name "${svc.name}"`,
        path: ["services", idx, "name"],
      });
    } else {
      nameMap.set(svc.name, idx);
    }
  });

  services.forEach((svc, idx) => {
    for (const dep of svc.depends_on) {
      if (dep === svc.name) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Service "${svc.name}" cannot depend on itself`,
          path: ["services", idx, "depends_on"],
        });
      } else if (!nameMap.has(dep)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Service "${svc.name}" depends on unknown service "${dep}"`,
          path: ["services", idx, "depends_on"],
        });
      }
    }
  });

  // Cycle detection via 3-color DFS
  const color = new Map<string, 0 | 1 | 2>();
  const byName = new Map(services.map((s) => [s.name, s]));
  const hasCycle = (name: string): boolean => {
    const c = color.get(name) ?? 0;
    if (c === 1) return true;
    if (c === 2) return false;
    color.set(name, 1);
    const svc = byName.get(name);
    if (svc) {
      for (const dep of svc.depends_on) {
        if (byName.has(dep) && hasCycle(dep)) {
          return true;
        }
      }
    }
    color.set(name, 2);
    return false;
  };
  for (const svc of services) {
    if (hasCycle(svc.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Cyclic service dependency detected involving "${svc.name}"`,
        path: ["services"],
      });
      break;
    }
  }
}

export const AcceptEntryConfigSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("http_server"),
      prepare_cmd: z.string().trim().min(1).optional(),
      services: z.array(AcceptServiceSpecSchema).min(1).max(4),
      observe_http: z.boolean().default(true),
      required_capability: z.enum(["browser", "cli"]).default("browser"),
    }),
    z.object({
      kind: z.literal("desktop_app"),
      prepare_cmd: z.string().trim().min(1).optional(),
      services: z.array(AcceptServiceSpecSchema).min(1).max(4),
      required_capability: z.literal("desktop_gui").default("desktop_gui"),
    }),
    z.object({
      kind: z.literal("cli_binary"),
      prepare_cmd: z.string().trim().min(1).optional(),
      entry_hint: z.string().trim().min(1).optional(),
      required_capability: z.literal("cli").default("cli"),
    }),
    z.object({
      kind: z.literal("none"),
    }),
  ])
  .superRefine((entry, ctx) => {
    if (entry.kind === "http_server" || entry.kind === "desktop_app") {
      validateAcceptServiceGraph(entry.services, ctx);
    }
  });
export type AcceptEntryConfig = z.infer<typeof AcceptEntryConfigSchema>;

export const CardContractSchema = z.object({
  goal: z.string().min(1),
  end: z.string().min(1),
  accept_cmd: z.string().min(1),
  accept_files_hash: z.string().min(1),
  scope: z.array(z.string().min(1)),
  non_goals: z.array(z.string().min(1)).optional(),
  accept_entry: AcceptEntryConfigSchema.optional(),
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
  max_cost_usd: z.number().finite().positive().optional(),
});
export type CardLimits = z.infer<typeof CardLimitsSchema>;

export const BudgetScopeStatusSchema = z.object({
  scope: z.enum(["card", "daily", "monthly"]),
  spent_usd: z.number().finite().nonnegative(),
  limit_usd: z.number().finite().positive().nullable(),
  ratio: z.number().finite().nonnegative().nullable(),
  level: z.enum(["ok", "warning", "exceeded"]),
});
export type BudgetScopeStatus = z.infer<typeof BudgetScopeStatusSchema>;

export const GlobalBudgetStatusSchema = z.object({
  daily: BudgetScopeStatusSchema,
  monthly: BudgetScopeStatusSchema,
  soft_warning_ratio: z.number().finite().min(0.1).max(0.99),
  exclude_subscription_providers: z.boolean(),
  computed_at: z.string().min(1),
});
export type GlobalBudgetStatus = z.infer<typeof GlobalBudgetStatusSchema>;

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
  workflow: WorkflowBlueprintSchema.optional(),
  attachments: z.array(TaskAttachmentSchema).optional(),
  external_ref: TaskExternalRefSchema.optional(),
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
  open_questions: z.array(z.string().min(1)).optional(),
  workflow: WorkflowBlueprintSchema.optional(),
  attachments: z.array(TaskAttachmentSchema).optional(),
  external_ref: TaskExternalRefSchema.optional(),
  contract: CardContractSchema.partial().default({}),
  session_ref: SessionRefSchema.nullable().optional(),
  intake_open: z.boolean().optional(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});
export type DraftCard = z.infer<typeof DraftCardSchema>;

export const RunMetaSchema = z.object({
  schema_version: z.literal(1).default(1),
  run_id: z.string().min(1),
  task_id: z.string().min(1),
  stage: StageIdSchema,
  step_index: z.number().int().nonnegative().optional(),
  round: z.number().int().positive(),
  role: RoleIdSchema,
  roster_role: z.string().min(1).optional(),
  contract_version: z.number().int().positive(),
  backend_id: z.string().min(1),
  agent: z.string().min(1),
  model: z.string().min(1),
  session_ref: SessionRefSchema,
  session_reused: z.boolean().optional(),
  parent_run_id: z.string().min(1).optional(),
  escalated_from: z.string().min(1).optional(),
  heterogeneity_level: z.enum(["dual", "single", "none"]).optional(),
  cwd: z.string().min(1).optional(),
  input_ref: z.string().min(1).optional(),
  checkpoint_ref: z.string().min(1).optional(),
  started_at: z.string().min(1),
});
export type RunMeta = z.infer<typeof RunMetaSchema>;

export const DecisionActionSchema = z.enum(DECISION_ACTIONS);

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
  resolution_summary: z.string().min(1).optional(),
  updated_at: z.string().min(1).optional(),
  created_at: z.string().min(1),
});
export type PendingDecision = z.infer<typeof PendingDecisionSchema>;

/**
 * Durable advisor escalation context written to `~/.kiln/tasks/<id>/advisor-request.yaml`
 * so mid-flight technical ambiguity or stuck-loop handoffs survive daemon restarts.
 */
export const AdvisorRequestSchema = z.object({
  schema_version: z.literal(1).default(1),
  contract_version: z.number().int().positive(),
  trigger: z.enum([
    "technical_ambiguity",
    "stuck_same_failure",
    "review_deadlock",
    "triage_escalation",
    "run_stalled",
  ]),
  source_stage: StageIdSchema,
  source_run_id: z.string().min(1),
  source_role: RoleIdSchema.optional(),
  category: z.string().min(1),
  reason: z.string().min(1),
  question: z.string().min(1),
  options: z.array(DecisionOptionSchema).default([]),
  failure_fingerprint: z.string().min(1).optional(),
  consecutive_failures: z.number().int().positive().optional(),
  created_at: z.string().min(1),
});
export type AdvisorRequest = z.infer<typeof AdvisorRequestSchema>;

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
    step_index: z.number().int().nonnegative().optional(),
    round: z.number().int().positive(),
    run_id: z.string().min(1),
  }),
  z.object({
    type: z.literal("paused"),
    at: z.string().min(1),
    stage: StageIdSchema.optional(),
    step_index: z.number().int().nonnegative().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal("resumed"),
    at: z.string().min(1),
    stage: StageIdSchema,
    step_index: z.number().int().nonnegative().optional(),
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
    step_index: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("steered"),
    at: z.string().min(1),
    steer_id: z.string().min(1),
    message: z.string().min(1),
    interrupt: z.boolean().default(false),
    contract_version: z.number().int().positive(),
    stage: StageIdSchema.optional(),
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
  z.object({
    type: z.literal("checkpoint_rolled_back"),
    at: z.string().min(1),
    checkpoint_ref: z.string().min(1),
    commit_sha: z.string().min(1),
  }),
  z.object({
    type: z.literal("workflow_patched"),
    at: z.string().min(1),
    run_id: z.string().min(1),
    contract_version: z.number().int().positive(),
    preserved_prefix_steps: z.number().int().nonnegative(),
    new_total_steps: z.number().int().positive(),
    resume_stage: StageIdSchema,
    resume_step_index: z.number().int().nonnegative(),
    rationale: z.string().min(1),
  }),
  z.object({
    type: z.literal("subtasks_spawned"),
    at: z.string().min(1),
    run_id: z.string().min(1),
    contract_version: z.number().int().positive(),
    child_task_ids: z.array(z.string().min(1)).min(2),
    base_ref_sha: z.string().min(1).optional(),
    resume_stage: StageIdSchema,
    resume_step_index: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("stage_fast_forwarded"),
    at: z.string().min(1),
    skipped_stage: StageIdSchema,
    skipped_step_index: z.number().int().nonnegative().optional(),
    to_stage: StageIdSchema,
    to_step_index: z.number().int().nonnegative().optional(),
    reason: z.enum(["docs_only", "tests_only"]),
    changed_paths: z.array(z.string()),
  }),
]);
export type StateEvent = z.infer<typeof StateEventSchema>;

export const PendingSubtaskSplitSchema = z.object({
  schema_version: z.literal(1).default(1),
  decision_id: z.string().min(1),
  contract_version: z.number().int().positive(),
  source_run_id: z.string().min(1),
  source_stage: z.enum(["plan", "advise"]),
  rationale: z.string().min(1),
  subtasks: z.array(MidFlightSubtaskSpecSchema).min(2).max(12),
  created_at: z.string().min(1),
});
export type PendingSubtaskSplit = z.infer<typeof PendingSubtaskSplitSchema>;

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

export const SpaceScriptsSchema = z
  .object({
    setup: z.string().trim().min(1).optional(),
    dev: z.string().trim().min(1).optional(),
    test: z.string().trim().min(1).optional(),
    lint: z.string().trim().min(1).optional(),
    deliver: z.string().trim().min(1).optional(),
  })
  .strict();
export type SpaceScripts = z.infer<typeof SpaceScriptsSchema>;

export const SpaceConfigSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  repo_path: z.string().min(1).optional(),
  default_branch: z.string().min(1).default("main"),
  copy_untracked: z.array(z.string()).default([]),
  clone_deps: z.array(z.string()).default([]),
  default_accept_cmd: z.string().min(1).optional(),
  accept_entry: AcceptEntryConfigSchema.optional(),
  freeze_patterns: z.array(z.string()).default([]),
  pinned: z.boolean().optional(),
  scripts: SpaceScriptsSchema.optional(),
  intake_checklist: z.array(z.string().trim().min(1)).optional(),
  accept_scenarios: z.array(z.string().trim().min(1)).optional(),
  default_workflow_preset: z.enum(["quick", "host_op", "standard_dev", "full_delivery"]).optional(),
});
export type SpaceConfig = z.infer<typeof SpaceConfigSchema>;

export const AcceptServiceStatusSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["ready", "failed", "crashed", "stopped"]),
  port: z.number().int().positive().optional(),
  proxy_port: z.number().int().positive().optional(),
  url: z.string().min(1).optional(),
  exit_code: z.number().int().nullable().optional(),
  log_file: z.string().min(1).optional(),
  tail_log: z.string().optional(),
});
export type AcceptServiceStatus = z.infer<typeof AcceptServiceStatusSchema>;

export const AcceptTrafficErrorResponseSchema = z.object({
  method: z.string().min(1),
  path: z.string().min(1),
  status: z.number().int(),
  service: z.string().min(1),
});
export type AcceptTrafficErrorResponse = z.infer<typeof AcceptTrafficErrorResponseSchema>;

export const AcceptTrafficSummarySchema = z.object({
  observed: z.boolean(),
  total_requests: z.number().int().nonnegative(),
  unique_paths: z.array(z.string()),
  error_responses: z.array(AcceptTrafficErrorResponseSchema),
});
export type AcceptTrafficSummary = z.infer<typeof AcceptTrafficSummarySchema>;

export const AcceptEvidenceFileCheckSchema = z.object({
  rel_path: z.string().min(1),
  kind: z.enum(["image", "file"]),
  size_bytes: z.number().int().nonnegative(),
  mime_type: z.string().min(1).optional(),
  valid: z.boolean(),
  error: z.string().min(1).optional(),
});
export type AcceptEvidenceFileCheck = z.infer<typeof AcceptEvidenceFileCheckSchema>;

export const AcceptScenarioOutcomeSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["pass", "fail", "skipped"]),
  note: z.string().optional(),
  evidence_files: z.array(z.string().min(1)).optional(),
});
export type AcceptScenarioOutcome = z.infer<typeof AcceptScenarioOutcomeSchema>;

export const AcceptVerificationReportSchema = z.object({
  schema_version: z.literal(1).default(1),
  run_id: z.string().min(1),
  contract_version: z.number().int().positive(),
  checked_at: z.string().min(1),
  entry_kind: z.enum(ACCEPT_ENTRY_KINDS),
  entry_mode: z.enum(VERIFIER_ENTRY_MODES).optional(),
  verdict: z.enum(["pass", "fail", "blocked"]),
  gate_ok: z.boolean(),
  rejection_reasons: z.array(z.string()).default([]),
  services: z.array(AcceptServiceStatusSchema).default([]),
  traffic: AcceptTrafficSummarySchema.default({
    observed: false,
    total_requests: 0,
    unique_paths: [],
    error_responses: [],
  }),
  evidence_files: z.array(AcceptEvidenceFileCheckSchema).default([]),
  scenarios: z.array(AcceptScenarioOutcomeSchema).default([]),
  console_errors_count: z.number().int().nonnegative().optional(),
  prepare_error: z.string().optional(),
});
export type AcceptVerificationReport = z.infer<typeof AcceptVerificationReportSchema>;

export const CheckpointRecordSchema = z.object({
  schema_version: z.literal(1).default(1),
  run_id: z.string().min(1),
  task_id: z.string().min(1),
  stage: StageIdSchema,
  round: z.number().int().positive(),
  ref: z
    .string()
    .min(1)
    .refine((r) => r.startsWith("refs/kiln/checkpoints/"), {
      message: 'checkpoint ref must start with "refs/kiln/checkpoints/"',
    }),
  commit_sha: z.string().regex(/^[a-f0-9]{7,64}$/, "commit_sha must be a valid hex SHA"),
  created_at: z.string().min(1),
});
export type CheckpointRecord = z.infer<typeof CheckpointRecordSchema>;

export const RunAntiDriftSummarySchema = z.object({
  input: z.string().min(1),
  alignment_points: z.array(z.string().min(1)).max(5),
  output: z.string().min(1),
  gate_proof: z.object({
    schema_ok: z.boolean(),
    scope_ok: z.boolean(),
    frozen_ok: z.boolean(),
    accept_ok: z.boolean(),
  }),
});
export type RunAntiDriftSummary = z.infer<typeof RunAntiDriftSummarySchema>;

export const LedgerEntrySchema = z.object({
  id: z.string().min(1),
  space: z.string().min(1),
  rule: z.string().min(1),
  source_task_id: z.string().min(1),
  source_decision_id: z.string().min(1).optional(),
  created_at: z.string().min(1),
  failure_mode: z.string().min(1).optional(),
  detection_signal: z.string().min(1).optional(),
  prevention_rule: z.string().min(1).optional(),
  scope_tags: z.array(z.string().min(1)).optional(),
  evidence_task_ids: z.array(z.string().min(1)).optional(),
  merged_from: z.array(z.string().min(1)).optional(),
  hit_count: z.number().int().nonnegative().optional(),
  last_triggered_at: z.string().min(1).optional(),
  status: z.enum(["active", "archived"]).optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const LedgerFileSchema = z.object({
  schema_version: z.literal(1),
  space: z.string().min(1),
  entries: z.array(LedgerEntrySchema),
});
export type LedgerFile = z.infer<typeof LedgerFileSchema>;

export const RetroAttributionSchema = z.object({
  category: z.enum(RETRO_ATTRIBUTION_CATEGORIES),
  summary: z.string().min(1),
  earliest_preventable_stage: StageIdSchema,
  evidence: z.string().min(1),
});
export type RetroAttribution = z.infer<typeof RetroAttributionSchema>;

export const TaskRetroMetricsSchema = z.object({
  total_runs: z.number().int().nonnegative(),
  rework_rounds: z.number().int().nonnegative(),
  retries_count: z.number().int().nonnegative(),
  review_rejections: z.number().int().nonnegative(),
  accept_failures: z.number().int().nonnegative(),
  escalations_count: z.number().int().nonnegative(),
  track_escalated_to_l2: z.boolean(),
  steer_count: z.number().int().nonnegative(),
  contract_updates: z.number().int().nonnegative(),
  first_pass: z.boolean(),
  cache_hit_rate: z.number().min(0).max(1),
  total_cost_usd: z.number().nonnegative(),
});
export type TaskRetroMetrics = z.infer<typeof TaskRetroMetricsSchema>;

export const TaskRetroReportSchema = z.object({
  schema_version: z.literal(1).default(1),
  task_id: z.string().min(1),
  space: z.string().min(1),
  terminal_status: z.enum(["done", "cancelled"]),
  mode: z.enum(["deterministic", "ai_enriched"]),
  high_signal: z.boolean(),
  signals: z.array(z.string().min(1)).default([]),
  metrics: TaskRetroMetricsSchema,
  attributions: z.array(RetroAttributionSchema).default([]),
  summary: z.string().min(1),
  proposal_ids: z.array(z.string().min(1)).default([]),
  generated_at: z.string().min(1),
  retro_run_id: z.string().min(1).optional(),
});
export type TaskRetroReport = z.infer<typeof TaskRetroReportSchema>;

export const ImprovementProposalSchema = z.object({
  id: z.string().min(1),
  status: z.enum(IMPROVEMENT_PROPOSAL_STATUSES).default("pending"),
  source: z.enum(["retro", "analytics", "ledger_hygiene"]),
  target_kind: z.enum(IMPROVEMENT_TARGET_KINDS),
  space: z.string().min(1).optional(),
  roster_role: z.string().min(1).optional(),
  title: z.string().min(1),
  rationale: z.string().min(1),
  expected_impact: z.string().min(1),
  evidence_task_ids: z.array(z.string().min(1)).default([]),
  payload: z.record(z.string(), z.unknown()),
  created_at: z.string().min(1),
  decided_at: z.string().min(1).optional(),
  policy_change_id: z.string().min(1).optional(),
});
export type ImprovementProposal = z.infer<typeof ImprovementProposalSchema>;

export const ImprovementProposalsFileSchema = z.object({
  schema_version: z.literal(1).default(1),
  proposals: z.array(ImprovementProposalSchema),
});
export type ImprovementProposalsFile = z.infer<typeof ImprovementProposalsFileSchema>;

export const PolicyMetricWindowSchema = z.object({
  task_count: z.number().int().nonnegative(),
  first_pass_rate: z.number().min(0).max(1),
  avg_rework_rounds: z.number().nonnegative(),
  cache_hit_rate: z.number().min(0).max(1),
  median_cost_usd: z.number().nonnegative(),
  p90_cost_usd: z.number().nonnegative(),
  accept_defect_catch_rate: z.number().min(0).max(1),
});
export type PolicyMetricWindow = z.infer<typeof PolicyMetricWindowSchema>;

export const PolicyChangeRecordSchema = z.object({
  schema_version: z.literal(1).default(1),
  id: z.string().min(1),
  proposal_id: z.string().min(1),
  target_kind: z.enum(IMPROVEMENT_TARGET_KINDS),
  target_ref: z.string().min(1),
  space: z.string().min(1).optional(),
  summary: z.string().min(1),
  applied_at: z.string().min(1),
  before_snapshot: z.unknown(),
  after_snapshot: z.unknown(),
  before_metrics: PolicyMetricWindowSchema,
  rolled_back_at: z.string().min(1).optional(),
});
export type PolicyChangeRecord = z.infer<typeof PolicyChangeRecordSchema>;
