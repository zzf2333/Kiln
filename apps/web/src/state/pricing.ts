import {
  calculateCacheNetSavedUsd,
  calculateOrthogonalTurnCostUsd,
  resolveEffectiveCacheWritePrice,
  type ModelPricing,
  type PricingConfig,
} from "@kiln/protocol/web";
import type {
  BootstrapTask,
  ProviderQuotaWindow,
  ProviderRuntimeStatus,
  RawProviderUsageEntry,
  UsageBucketSummary,
  UsageSnapshot,
  UsageTurnRow,
} from "../api/types";

function sanitizeCounters(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  cacheWriteTokens = 0,
): {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
} {
  const safeIn = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const safeCachedRaw =
    Number.isFinite(cachedInputTokens) && cachedInputTokens > 0
      ? cachedInputTokens
      : 0;
  const safeCached = Math.min(safeIn, safeCachedRaw);
  const safeWrite =
    Number.isFinite(cacheWriteTokens) && cacheWriteTokens > 0 ? cacheWriteTokens : 0;
  const safeOut = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  return {
    inputTokens: safeIn,
    cachedInputTokens: safeCached,
    cacheWriteTokens: safeWrite,
    outputTokens: safeOut,
  };
}

function isValidModelPricing(p: ModelPricing | undefined): p is ModelPricing {
  return (
    p !== undefined &&
    Number.isFinite(p.in) &&
    p.in >= 0 &&
    Number.isFinite(p.cached) &&
    p.cached >= 0 &&
    Number.isFinite(p.out) &&
    p.out >= 0 &&
    (p.cache_write === undefined || (Number.isFinite(p.cache_write) && p.cache_write >= 0))
  );
}

export function computeBucketCostUsd(
  modelName: string,
  bucket: Pick<
    UsageBucketSummary,
    "inputTokens" | "cachedInputTokens" | "cacheWriteTokens" | "outputTokens" | "costUsd"
  >,
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
    bucket.cacheWriteTokens ?? 0,
  );
  return calculateOrthogonalTurnCostUsd(
    {
      uncachedInputTokens: counters.inputTokens - counters.cachedInputTokens,
      cacheReadTokens: counters.cachedInputTokens,
      cacheWriteTokens: counters.cacheWriteTokens,
      outputTokens: counters.outputTokens,
      reasoningIncludedInOutput: true,
    },
    modelPrice,
    modelName,
  );
}

export function computeBucketSavedUsd(
  modelName: string,
  bucket: Pick<UsageBucketSummary, "inputTokens" | "cachedInputTokens" | "cacheWriteTokens">,
  pricing: PricingConfig | null,
): number {
  const modelPrice = pricing?.models[modelName];
  if (!isValidModelPricing(modelPrice)) {
    return 0;
  }
  const { cachedInputTokens, cacheWriteTokens } = sanitizeCounters(
    bucket.inputTokens,
    bucket.cachedInputTokens,
    0,
    bucket.cacheWriteTokens ?? 0,
  );
  return calculateCacheNetSavedUsd(
    {
      cacheReadTokens: cachedInputTokens,
      cacheWriteTokens,
    },
    modelPrice,
    modelName,
  );
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
      const counters = sanitizeCounters(
        turn.input_tokens,
        turn.cached_input_tokens,
        turn.output_tokens,
        turn.cache_write_tokens ?? 0,
      );
      sum += calculateOrthogonalTurnCostUsd(
        {
          uncachedInputTokens: counters.inputTokens - counters.cachedInputTokens,
          cacheReadTokens: counters.cachedInputTokens,
          cacheWriteTokens: counters.cacheWriteTokens,
          outputTokens: counters.outputTokens,
          reasoningIncludedInOutput: true,
        },
        modelPrice,
        turn.model,
      );
    } else if (
      typeof turn.provider_cost_usd === "number" &&
      Number.isFinite(turn.provider_cost_usd) &&
      turn.provider_cost_usd >= 0
    ) {
      sum += turn.provider_cost_usd;
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

export function formatModelPricingSummary(
  modelId: string,
  modelPrice: ModelPricing | undefined,
): string {
  if (!modelPrice) return "未配置单价";
  const writePrice = resolveEffectiveCacheWritePrice(modelId, modelPrice);
  const fmtRate = (n: number): string => `$${Number(n.toFixed(4))}`;
  return `${fmtRate(modelPrice.in)} / ${fmtRate(modelPrice.cached)} / ${fmtRate(writePrice)} / ${fmtRate(modelPrice.out)}`;
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

export function extractEffectiveQuotas(
  providerStatuses: readonly ProviderRuntimeStatus[] | undefined,
  providerUsage: Record<string, RawProviderUsageEntry> | RawProviderUsageEntry[] | undefined,
): Record<string, ProviderQuotaWindow> {
  const result = extractAgentQuotas(providerUsage);
  if (!providerStatuses) return result;
  for (const ps of providerStatuses) {
    if (!ps.native_quota) continue;
    const mins = ps.native_quota.window_duration_mins;
    const label = mins
      ? mins >= 60 && mins % 60 === 0
        ? `${mins / 60} 小时窗口`
        : `${mins} 分钟窗口`
      : "官方配额窗口";
    result[ps.provider_id] = {
      label,
      usedRatio: Math.max(0, Math.min(1, ps.native_quota.used_percent / 100)),
      ...(ps.native_quota.resets_at ? { resetAt: ps.native_quota.resets_at } : {}),
      ...(ps.native_quota.plan_type ? { note: ps.native_quota.plan_type } : {}),
    };
  }
  return result;
}

export function quotaClassName(usedRatio: number): string {
  if (usedRatio >= 0.85) return "bad";
  if (usedRatio >= 0.6) return "warn";
  return "";
}
