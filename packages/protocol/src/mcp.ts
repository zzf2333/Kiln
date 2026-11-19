import { z } from "zod";
import {
  CardContractSchema,
  CardLimitsSchema,
  DecisionOptionSchema,
  PrioritySchema,
  StageIdSchema,
  TaskStatusSchema,
  TrackSchema,
  WorkspaceModeSchema,
} from "./card.js";
import { ROLE_IDS, RoleIdSchema, type RoleId } from "./config.js";

export const MCP_TOOL_NAMES = [
  "wb_get_context",
  "wb_list_tasks",
  "wb_read_ledger",
  "wb_plan",
  "wb_ask_decision",
  "wb_submit_receipt",
  "wb_propose_ledger",
] as const;

export const McpToolNameSchema = z.enum(MCP_TOOL_NAMES);
export type McpToolName = z.infer<typeof McpToolNameSchema>;

export const MCP_ROLE_ALLOWLIST: Record<McpToolName, readonly RoleId[]> = {
  wb_get_context: ROLE_IDS,
  wb_list_tasks: ["intake", "triage", "resolver"],
  wb_read_ledger: ROLE_IDS,
  wb_plan: ["intake", "triage", "resolver"],
  wb_ask_decision: ["worker", "reviewer", "verifier", "triage", "advisor"],
  wb_submit_receipt: ["worker", "reviewer", "verifier", "triage", "advisor"],
  wb_propose_ledger: ROLE_IDS,
};

export function isRoleAllowedForTool(role: RoleId, tool: McpToolName): boolean {
  return MCP_ROLE_ALLOWLIST[tool].includes(role);
}

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
    contract: CardContractSchema.partial().optional(),
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
