import { z } from "zod";
import { PrioritySchema, StageIdSchema, TaskStatusSchema } from "./card.js";

export const BackendCapabilitiesSchema = z.object({
  interactiveChat: z.boolean(),
  approvals: z.boolean(),
  mcpInjection: z.boolean(),
  usageCacheBreakdown: z.boolean(),
  interrupt: z.boolean(),
});
export type BackendCapabilities = z.infer<typeof BackendCapabilitiesSchema>;

const RunUsageObjectSchema = z.object({
  turnId: z.string().min(1),
  agent: z.string().min(1),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative(),
});

export const RunUsageSchema = RunUsageObjectSchema.superRefine((u, ctx) => {
  if (u.cachedInputTokens > u.inputTokens) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "cachedInputTokens cannot exceed inputTokens",
      path: ["cachedInputTokens"],
    });
  }
});
export type RunUsage = z.infer<typeof RunUsageSchema>;

const RunEventBaseUnionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thinking"), at: z.string().min(1) }),
  z.object({
    kind: z.literal("message"),
    at: z.string().min(1),
    text: z.string(),
    delta: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("tool"),
    at: z.string().min(1),
    name: z.string().min(1),
    target: z.string().optional(),
  }),
  z.object({
    kind: z.literal("file_write"),
    at: z.string().min(1),
    path: z.string().min(1),
  }),
  z.object({
    kind: z.literal("approval"),
    at: z.string().min(1),
    id: z.string().min(1),
    action: z.string().min(1),
    detail: z.string(),
  }),
  RunUsageObjectSchema.extend({
    kind: z.literal("usage"),
    at: z.string().min(1),
  }),
  z.object({
    kind: z.literal("exit"),
    at: z.string().min(1),
    reason: z.enum(["completed", "cancelled", "failed"]),
    detail: z.string().optional(),
  }),
]);

export const RunEventSchema = RunEventBaseUnionSchema.superRefine((ev, ctx) => {
  if (ev.kind === "usage" && ev.cachedInputTokens > ev.inputTokens) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "cachedInputTokens cannot exceed inputTokens",
      path: ["cachedInputTokens"],
    });
  }
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const SseEventSchema = z.discriminatedUnion("type", [
  z.object({
    seq: z.number().int().positive(),
    type: z.literal("task.updated"),
    taskId: z.string().min(1),
    patch: z.object({
      status: TaskStatusSchema.optional(),
      stage: StageIdSchema.optional(),
      round: z.number().int().positive().optional(),
      priority: PrioritySchema.optional(),
      effectivePriority: PrioritySchema.optional(),
      contractVersion: z.number().int().positive().optional(),
    }),
  }),
  z.object({
    seq: z.number().int().positive(),
    type: z.literal("rate.tick"),
    rates: z.record(z.string().min(1), z.number().nonnegative()),
    totals: z.object({
      costUsd: z.number().nonnegative(),
      tokPerSec: z.number().nonnegative(),
    }),
  }),
  z.object({
    seq: z.number().int().positive(),
    type: z.literal("decision.requested"),
    taskId: z.string().min(1),
    priority: PrioritySchema,
    question: z.string().min(1),
  }),
  z.object({
    seq: z.number().int().positive(),
    type: z.literal("run.event"),
    taskId: z.string().min(1),
    runId: z.string().min(1),
    event: RunEventSchema,
  }),
  z.object({
    seq: z.number().int().positive(),
    type: z.literal("intake.progress"),
    draftId: z.string().min(1),
    kind: z.enum(["thinking", "tool", "draft_updated"]),
    text: z.string().min(1),
    toolName: z.string().min(1).optional(),
    at: z.string().min(1),
  }),
]);
export type SseEvent = z.infer<typeof SseEventSchema>;
