import {
  calculateTurnCostUsd,
  type ModelPricing,
  type PricingConfig,
} from "@kiln/protocol/web";
import type {
  BootstrapTask,
  ProviderQuotaWindow,
  RawProviderUsageEntry,
  UsageBucketSummary,
  UsageSnapshot,
  UsageTurnRow,
} from "../api/types";

function sanitizeCounters(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): { inputTokens: number; cachedInputTokens: number; outputTokens: number } {
  const safeIn = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const safeCachedRaw =
    Number.isFinite(cachedInputTokens) && cachedInputTokens > 0
      ? cachedInputTokens
      : 0;
  const safeCached = Math.min(safeIn, safeCachedRaw);
  const safeOut = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  return { inputTokens: safeIn, cachedInputTokens: safeCached, outputTokens: safeOut };
}

function isValidModelPricing(p: ModelPricing | undefined): p is ModelPricing {
  return (
    p !== undefined &&
    Number.isFinite(p.in) &&
    p.in >= 0 &&
    Number.isFinite(p.cached) &&
    p.cached >= 0 &&
    Number.isFinite(p.out) &&
    p.out >= 0
  );
}

export function computeBucketCostUsd(
  modelName: string,
  bucket: Pick<UsageBucketSummary, "inputTokens" | "cachedInputTokens" | "outputTokens" | "costUsd">,
  pricing: PricingConfig | null,
): number {
  const modelPrice = pricing?.models[modelName];
  if (!isValidModelPricing(modelPrice)) {
    return bucket.costUsd;
  }
  const counters = sanitizeCounters(
    bucket.inputTokens,
    bucket.cachedInputTokens,
    bucket.outputTokens,
  );
  return calculateTurnCostUsd(counters, modelPrice);
}

export function computeBucketSavedUsd(
  modelName: string,
  bucket: Pick<UsageBucketSummary, "inputTokens" | "cachedInputTokens">,
  pricing: PricingConfig | null,
): number {
  const modelPrice = pricing?.models[modelName];
  if (!isValidModelPricing(modelPrice)) {
    return 0;
  }
  const { cachedInputTokens } = sanitizeCounters(
    bucket.inputTokens,
    bucket.cachedInputTokens,
    0,
  );
  return (cachedInputTokens * Math.max(0, modelPrice.in - modelPrice.cached)) / 1_000_000;
}

export function computeGrandTotalCostUsd(
  usage: UsageSnapshot,
  pricing: PricingConfig | null,
): number {
  const entries = Object.entries(usage.byModel);
  if (entries.length === 0) {
    return usage.costUsd;
  }
  return entries.reduce(
    (sum, [modelName, bucket]) => sum + computeBucketCostUsd(modelName, bucket, pricing),
    0,
  );
}

export function computeGrandSavedUsd(
  usage: UsageSnapshot,
  pricing: PricingConfig | null,
): number {
  return Object.entries(usage.byModel).reduce(
    (sum, [modelName, bucket]) => sum + computeBucketSavedUsd(modelName, bucket, pricing),
    0,
  );
}

export function computeAgentCostUsd(
  agentName: string,
  usage: UsageSnapshot,
  pricing: PricingConfig | null,
): number {
  const modelMap = usage.byAgentModel?.[agentName];
  if (modelMap) {
    return Object.entries(modelMap).reduce(
      (sum, [modelName, bucket]) => sum + computeBucketCostUsd(modelName, bucket, pricing),
      0,
    );
  }
  const agentKeys = Object.keys(usage.byAgent);
  if (agentKeys.length === 1 && agentKeys[0] === agentName && Object.keys(usage.byModel).length > 0) {
    return computeGrandTotalCostUsd(usage, pricing);
  }
  return usage.byAgent[agentName]?.costUsd ?? 0;
}

export function computeTurnsCostUsd(
  turns: readonly UsageTurnRow[],
  fallbackCostUsd: number,
  pricing: PricingConfig | null,
): number {
  if (turns.length === 0) {
    return fallbackCostUsd;
  }
  let sum = 0;
  for (const turn of turns) {
    const modelPrice = pricing?.models[turn.model];
    if (isValidModelPricing(modelPrice)) {
      sum += calculateTurnCostUsd(
        sanitizeCounters(turn.input_tokens, turn.cached_input_tokens, turn.output_tokens),
        modelPrice,
      );
    }
  }
  return sum > 0 || pricing ? sum : fallbackCostUsd;
}

export function computeTaskCostUsd(
  task: BootstrapTask,
  pricing: PricingConfig | null,
): number {
  const byModel = task.tokens_by_model ? Object.entries(task.tokens_by_model) : [];
  if (byModel.length > 0) {
    return byModel.reduce(
      (sum, [modelName, bucket]) => sum + computeBucketCostUsd(modelName, bucket, pricing),
      0,
    );
  }
  return task.cost_usd;
}

function normalizeQuotaEntry(raw: RawProviderUsageEntry | undefined): ProviderQuotaWindow | null {
  if (!raw) return null;
  const q = raw.quota ?? raw;
  const rawUsed =
    typeof q.usedRatio === "number"
      ? q.usedRatio
      : typeof q.used === "number"
        ? q.used
        : typeof q.usedPercent === "number"
          ? q.usedPercent / 100
          : null;
  if (rawUsed === null || !Number.isFinite(rawUsed) || rawUsed < 0) {
    return null;
  }
  const usedRatio = Math.max(0, Math.min(1, rawUsed));
  const label = q.label ?? raw.label ?? "订阅窗口";
  const resetAt =
    ("resetAt" in q ? q.resetAt : undefined) ??
    ("reset" in q ? q.reset : undefined) ??
    raw.resetAt ??
    raw.reset;
  return {
    label,
    usedRatio,
    ...(resetAt ? { resetAt } : {}),
    ...(raw.note ? { note: raw.note } : {}),
  };
}

export function extractAgentQuotas(
  providerUsage: Record<string, RawProviderUsageEntry> | RawProviderUsageEntry[] | undefined,
): Record<string, ProviderQuotaWindow> {
  if (!providerUsage) return {};
  const result: Record<string, ProviderQuotaWindow> = {};
  if (Array.isArray(providerUsage)) {
    for (const item of providerUsage) {
      if (!item.agent) continue;
      const normalized = normalizeQuotaEntry(item);
      if (normalized) {
        result[item.agent] = normalized;
      }
    }
    return result;
  }
  for (const [agent, entry] of Object.entries(providerUsage)) {
    const normalized = normalizeQuotaEntry(entry);
    if (normalized) {
      result[agent] = normalized;
    }
  }
  return result;
}

export function quotaClassName(usedRatio: number): string {
  if (usedRatio >= 0.85) return "bad";
  if (usedRatio >= 0.6) return "warn";
  return "";
}
