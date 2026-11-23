import { z } from "zod";
import {
  CardContractSchema,
  CardLimitsSchema,
  DecisionOptionSchema,
  PrioritySchema,
  StageIdSchema,
  TaskAttachmentSchema,
  TaskStatusSchema,
  TrackSchema,
  WorkspaceModeSchema,
} from "./card.js";
import { RoleIdSchema } from "./config.js";
import { WorkflowBlueprintSchema, validateSplitCardsDag } from "./workflow.js";
import {
  MCP_ROLE_ALLOWLIST,
  MCP_TOOL_NAMES,
  isRoleAllowedForTool,
  type McpToolName,
} from "./constants.js";

export { MCP_ROLE_ALLOWLIST, MCP_TOOL_NAMES, isRoleAllowedForTool, type McpToolName };

export const McpToolNameSchema = z.enum(MCP_TOOL_NAMES);

export const RunTokenClaimsSchema = z.object({
  taskId: z.string().min(1),
  runId: z.string().min(1),
  role: RoleIdSchema,
  contractVersion: z.number().int().positive(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});
export type RunTokenClaims = z.infer<typeof RunTokenClaimsSchema>;

export const WbGetContextInputSchema = z.object({});

export const WbListTasksInputSchema = z.object({
  space: z.string().min(1).optional(),
  status: TaskStatusSchema.optional(),
});

export const WbReadLedgerInputSchema = z.object({
  space: z.string().min(1),
});

export const SplitCardPlanItemSchema = z.object({
  temp_id: z.string().min(1),
  title: z.string().min(1),
  space: z.string().min(1),
  priority: PrioritySchema.default("P2"),
  track: TrackSchema.default("L2"),
  workspace_mode: WorkspaceModeSchema,
  depends_on_temp_ids: z.array(z.string().min(1)).default([]),
  depends_on: z.array(z.string().min(1)).default([]),
  workflow: WorkflowBlueprintSchema.optional(),
  attachments: z.array(TaskAttachmentSchema).optional(),
  contract: CardContractSchema,
  limits: CardLimitsSchema.optional(),
  brief_markdown: z.string().min(1),
});
export type SplitCardPlanItem = z.infer<typeof SplitCardPlanItemSchema>;

export const WbSplitCardsPlanInputSchema = z.object({
  mode: z.literal("commit_split_cards"),
  draft_id: z.string().min(1).optional(),
  cards: z
    .array(SplitCardPlanItemSchema)
    .min(2)
    .max(12)
    .superRefine((cards, ctx) => {
      const dag = validateSplitCardsDag(cards);
      if (!dag.ok) {
        for (const err of dag.errors) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: err,
          });
        }
      }
    }),
});
export type WbSplitCardsPlanInput = z.infer<typeof WbSplitCardsPlanInputSchema>;

export const WbPlanInputSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("upsert_draft"),
    draft_id: z.string().min(1),
    title: z.string().optional(),
    space: z.string().min(1).optional(),
    priority: PrioritySchema.optional(),
    track: TrackSchema.optional(),
    workspace_mode: WorkspaceModeSchema.optional(),
    depends_on: z.array(z.string().min(1)).optional(),
    open_questions: z.array(z.string().min(1)).optional(),
    workflow: WorkflowBlueprintSchema.optional(),
    attachments: z.array(TaskAttachmentSchema).optional(),
    contract: CardContractSchema.partial().optional(),
    brief_markdown: z.string().optional(),
  }),
  z.object({
    mode: z.literal("commit_card"),
    draft_id: z.string().min(1).optional(),
    title: z.string().min(1),
    space: z.string().min(1),
    priority: PrioritySchema.default("P2"),
    track: TrackSchema.default("L2"),
    workspace_mode: WorkspaceModeSchema,
    parent: z.string().min(1).nullable().default(null),
    depends_on: z.array(z.string().min(1)).default([]),
    workflow: WorkflowBlueprintSchema.optional(),
    attachments: z.array(TaskAttachmentSchema).optional(),
    contract: CardContractSchema,
    limits: CardLimitsSchema.optional(),
    brief_markdown: z.string().min(1),
  }),
  z.object({
    mode: z.literal("update_contract"),
    task_id: z.string().min(1),
    contract: CardContractSchema.partial(),
    affected_stages: z.array(StageIdSchema).min(1),
    rationale: z.string().min(1),
  }),
]);

export const WbAskDecisionInputSchema = z.object({
  category: z.string().min(1),
  reason: z.string().min(1),
  question: z.string().min(1),
  options: z.array(DecisionOptionSchema).min(1),
});

export const WbSubmitReceiptInputSchema = z.object({
  markdown: z.string().min(1),
});

export const WbProposeLedgerInputSchema = z.object({
  space: z.string().min(1),
  rule: z.string().min(1),
  rationale: z.string().min(1),
});
