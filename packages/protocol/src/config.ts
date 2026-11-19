import { z } from "zod";

export const ROLE_IDS = [
  "intake",
  "worker",
  "reviewer",
  "verifier",
  "triage",
  "advisor",
  "resolver",
] as const;

export const RoleIdSchema = z.enum(ROLE_IDS);
export type RoleId = z.infer<typeof RoleIdSchema>;

export const REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export const ReasoningEffortSchema = z.enum(REASONING_EFFORTS);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const RoleFallbackSchema = z.object({
  agent: z.string().min(1),
  model: z.string().min(1),
  backend_id: z.string().min(1).optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
});
export type RoleFallback = z.infer<typeof RoleFallbackSchema>;

export const RoleAssignmentSchema = z.object({
  agent: z.string().min(1),
  model: z.string().min(1),
  backend_id: z.string().min(1).optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
  fallback: RoleFallbackSchema.optional(),
  avoid_same_model_as: RoleIdSchema.optional(),
  allow_full_access_fallback: z.boolean().default(false),
});
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

export const RolesMapSchema = z
  .object({
    intake: RoleAssignmentSchema.optional(),
    worker: RoleAssignmentSchema.optional(),
    reviewer: RoleAssignmentSchema.optional(),
    verifier: RoleAssignmentSchema.optional(),
    triage: RoleAssignmentSchema.optional(),
    advisor: RoleAssignmentSchema.optional(),
    resolver: RoleAssignmentSchema.optional(),
  })
  .strict();

export const RolesConfigSchema = z.object({
  schema_version: z.literal(1),
  heterogeneous_review: z.boolean().default(true),
  roles: RolesMapSchema,
});
export type RolesConfig = z.infer<typeof RolesConfigSchema>;

export const LimitsConfigSchema = z.object({
  schema_version: z.literal(1),
  max_concurrent_slots: z.number().int().min(1).default(5),
  p0_extra_slot: z.boolean().default(true),
  max_waiting_wip: z.number().int().min(1).default(5),
  retries_per_stage: z.number().int().min(0).default(2),
  review_rounds: z.number().int().min(0).default(2),
  advisor_calls: z.number().int().min(0).default(1),
  max_card_tokens: z.number().int().min(1).default(250_000),
});
export type LimitsConfig = z.infer<typeof LimitsConfigSchema>;

export const ModelPricingSchema = z.object({
  in: z.number().finite().nonnegative(),
  cached: z.number().finite().nonnegative(),
  out: z.number().finite().nonnegative(),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export const PricingConfigSchema = z.object({
  schema_version: z.literal(1),
  models: z.record(z.string().min(1), ModelPricingSchema),
});
export type PricingConfig = z.infer<typeof PricingConfigSchema>;
