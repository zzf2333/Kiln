import { z } from "zod";
import { PrioritySchema, StageIdSchema, TaskStatusSchema } from "./card.js";
import { COST_SOURCES, SPACE_SCRIPT_KEYS } from "./constants.js";
import type { OrthogonalUsageCounters } from "./pricing.js";

export const BackendCapabilitiesSchema = z.object({
  interactiveChat: z.boolean(),
  approvals: z.boolean(),
  mcpInjection: z.boolean(),
  usageCacheBreakdown: z.boolean(),
  interrupt: z.boolean(),
  imageInput: z.boolean().optional(),
  cacheWriteTelemetry: z.boolean().optional(),
  contextWindowTelemetry: z.boolean().optional(),
  nativeQuotaWindow: z.boolean().optional(),
  readOnlySandbox: z.boolean().optional(),
  warmSessionReuse: z.boolean().optional(),
});
export type BackendCapabilities = z.infer<typeof BackendCapabilitiesSchema>;

export const CostSourceSchema = z.enum(COST_SOURCES);

const RunUsageObjectSchema = z.object({
  turnId: z.string().min(1),
  agent: z.string().min(1),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative(),
  uncachedInputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  reasoningIncludedInOutput: z.boolean().optional(),
  providerCostUsd: z.number().finite().nonnegative().optional(),
  costSource: CostSourceSchema.optional(),
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

/**
 * Projects a V1 or V2 `RunUsage` record into orthogonal token buckets for 5-field billing.
 */
export function toOrthogonalUsage(usage: RunUsage): OrthogonalUsageCounters {
  return {
    uncachedInputTokens:
      usage.uncachedInputTokens ?? Math.max(0, usage.inputTokens - usage.cachedInputTokens),
    cacheReadTokens: usage.cacheReadTokens ?? usage.cachedInputTokens,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    outputTokens: usage.outputTokens,
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    reasoningIncludedInOutput: usage.reasoningIncludedInOutput ?? true,
  };
}

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
  z.object({
    kind: z.literal("session_bound"),
    at: z.string().min(1),
    providerSessionId: z.string().min(1),
    providerSessionPath: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("context_window"),
    at: z.string().min(1),
    usedTokens: z.number().int().nonnegative(),
    contextWindowTokens: z.number().int().positive(),
    percent: z.number().finite().min(0).max(100).optional(),
  }),
  z.object({
    kind: z.literal("rate_limited"),
    at: z.string().min(1),
    provider: z.string().min(1),
    retryAfterSec: z.number().finite().nonnegative().optional(),
    until: z.string().min(1).optional(),
    detail: z.string().optional(),
  }),
  RunUsageObjectSchema.extend({
    kind: z.literal("usage"),
    at: z.string().min(1),
  }),
  z.object({
    kind: z.literal("stall_warning"),
    at: z.string().min(1),
    phase: z.enum(["soft_warning", "aborted"]),
    silentSec: z.number().int().nonnegative(),
    probeAlive: z.boolean().nullable().optional(),
    probeStatus: z.enum(["running", "idle", "closed", "unknown"]).optional(),
    action: z.enum(["warn", "retry_stage", "invoke_advisor", "escalate_failure"]).optional(),
    detail: z.string().optional(),
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
  z.object({
    seq: z.number().int().positive(),
    type: z.literal("script.output"),
    spaceId: z.string().min(1),
    taskId: z.string().min(1).optional(),
    scriptRunId: z.string().min(1),
    scriptKey: z.enum(SPACE_SCRIPT_KEYS),
    stream: z.enum(["stdout", "stderr", "system"]),
    chunk: z.string(),
    done: z.boolean().optional(),
    exitCode: z.number().int().nullable().optional(),
    detectedUrls: z.array(z.string().min(1)).optional(),
    at: z.string().min(1),
  }),
  z.object({
    seq: z.number().int().positive(),
    type: z.literal("provider.status"),
    providerId: z.string().min(1),
    status: z.enum(["ready", "cooldown", "unavailable", "auth_required"]),
    cooldownUntil: z.string().min(1).optional(),
    detail: z.string().optional(),
    at: z.string().min(1),
  }),
]);
export type SseEvent = z.infer<typeof SseEventSchema>;
