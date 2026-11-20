import { z } from "zod";
import { DecisionActionSchema, PrioritySchema } from "./card.js";
import { RoleIdSchema } from "./config.js";
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

export const UpsertSpaceRequestSchema = z.object({
  name: z.string().trim().min(1),
  repo_path: z.string().trim().min(1),
  default_branch: z.string().trim().min(1).default("main"),
  copy_untracked: z.array(z.string().trim().min(1)).default([]),
  clone_deps: z.array(z.string().trim().min(1)).default([]),
  default_accept_cmd: z.string().trim().min(1).optional(),
  freeze_patterns: z.array(z.string().trim().min(1)).default([]),
});
export type UpsertSpaceRequest = z.infer<typeof UpsertSpaceRequestSchema>;
