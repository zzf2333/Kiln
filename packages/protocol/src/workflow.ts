import { z } from "zod";
import { REASONING_EFFORTS, WORKFLOW_PRESETS } from "./constants.js";
import {
  WORKFLOW_AGENT_ROLES,
  WORKFLOW_AGENT_STAGES,
  WORKFLOW_APPROVAL_ITEMS,
  WORKFLOW_NODE_ON_FAIL_ACTIONS,
  validateWorkflowBlueprint,
} from "./workflow-core.js";

export * from "./workflow-core.js";

export const WorkflowPresetSchema = z.enum(WORKFLOW_PRESETS);

export const WorkflowAgentStageSchema = z.enum(WORKFLOW_AGENT_STAGES);

export const WorkflowAgentRoleSchema = z.enum(WORKFLOW_AGENT_ROLES);

export const WorkflowApprovalItemSchema = z.enum(WORKFLOW_APPROVAL_ITEMS);

export const WorkflowNodeBindingSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    backend_id: z.string().min(1).optional(),
    effort: z.enum(REASONING_EFFORTS).optional(),
  })
  .strict();

export const WorkflowNodeOnFailSchema = z.enum(WORKFLOW_NODE_ON_FAIL_ACTIONS);

export const WorkflowAgentNodeSchema = z.object({
  kind: z.literal("agent"),
  id: z.string().trim().min(1).max(64).optional(),
  label: z.string().trim().min(1).max(80).optional(),
  stage: WorkflowAgentStageSchema,
  role: WorkflowAgentRoleSchema,
  fresh_context: z.boolean(),
  mode: z.enum(["normal", "dry_run_only"]).optional(),
  roster_role: z.string().min(1).optional(),
  rationale: z.string().min(1).optional(),
  binding: WorkflowNodeBindingSchema.optional(),
  instructions: z.string().trim().min(1).max(4000).optional(),
  on_fail: WorkflowNodeOnFailSchema.optional(),
});

export const WorkflowGateNodeSchema = z.object({
  kind: z.literal("gate"),
  stage: z.literal("verify"),
  check: z.enum(["full", "staged_only"]),
});

export const WorkflowApprovalNodeSchema = z.object({
  kind: z.literal("approval"),
  stage: z.enum(["accept", "deliver"]),
  show: z.array(WorkflowApprovalItemSchema).min(1),
});

export const WorkflowCommandNodeSchema = z.object({
  kind: z.literal("command"),
  stage: z.literal("deliver"),
  apply_staged: z.boolean(),
  run_deliver_cmd: z.boolean(),
  verify_sha256: z.boolean(),
  final_accept_gate: z.boolean(),
});

export const WorkflowAtomicNodeSchema = z.discriminatedUnion("kind", [
  WorkflowAgentNodeSchema,
  WorkflowGateNodeSchema,
  WorkflowApprovalNodeSchema,
  WorkflowCommandNodeSchema,
]);

export const WorkflowLoopNodeSchema = z.object({
  kind: z.literal("loop"),
  max_rounds: z.number().int().min(1).max(10),
  stuck_threshold: z.number().int().min(1).max(5),
  steps: z.array(WorkflowAtomicNodeSchema).min(1),
});

export const WorkflowStepSchema = z.union([
  WorkflowAgentNodeSchema,
  WorkflowGateNodeSchema,
  WorkflowApprovalNodeSchema,
  WorkflowCommandNodeSchema,
  WorkflowLoopNodeSchema,
]);

export const WorkflowBlueprintSchema = z
  .object({
    schema_version: z.literal(1),
    preset: WorkflowPresetSchema,
    steps: z.array(WorkflowStepSchema).min(1),
    pm_rationale: z.string().min(1).optional(),
  })
  .superRefine((val, ctx) => {
    const check = validateWorkflowBlueprint(val);
    if (!check.ok) {
      for (const err of check.errors) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: err,
        });
      }
    }
  });
