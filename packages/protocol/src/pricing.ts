import type { ModelPricing } from "./config.js";

export interface TurnUsageCounters {
  inputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens: number;
}

export interface OrthogonalUsageCounters {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  reasoningIncludedInOutput?: boolean;
}

export interface UncachedUsageInput {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface NormalizedUsageCounters {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

function assertValidCounter(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number, got: ${value}`);
  }
}

/**
 * Resolves effective cache-write price ($ / 1M tokens):
 * explicit `cache_write` -> `in * 1.25` for Claude family -> `in` otherwise.
 */
export function resolveEffectiveCacheWritePrice(
  modelId: string | undefined,
  modelPrice: ModelPricing,
): number {
  assertValidCounter(modelPrice.in, "modelPrice.in");
  if (modelPrice.cache_write !== undefined) {
    assertValidCounter(modelPrice.cache_write, "modelPrice.cache_write");
    return modelPrice.cache_write;
  }
  if (modelId && /claude/i.test(modelId)) {
    return modelPrice.in * 1.25;
  }
  return modelPrice.in;
}

export function calculateTurnCostUsd(
  usage: TurnUsageCounters,
  modelPrice: ModelPricing,
  modelId?: string,
): number {
  const cached = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  assertValidCounter(usage.inputTokens, "inputTokens");
  assertValidCounter(cached, "cachedInputTokens");
  assertValidCounter(cacheWrite, "cacheWriteTokens");
  assertValidCounter(usage.outputTokens, "outputTokens");
  assertValidCounter(modelPrice.in, "modelPrice.in");
  assertValidCounter(modelPrice.cached, "modelPrice.cached");
  assertValidCounter(modelPrice.out, "modelPrice.out");

  if (cached > usage.inputTokens) {
    throw new RangeError(
      `cachedInputTokens (${cached}) cannot exceed inputTokens (${usage.inputTokens})`,
    );
  }

  const uncachedInput = usage.inputTokens - cached;
  const writePrice = cacheWrite > 0 ? resolveEffectiveCacheWritePrice(modelId, modelPrice) : 0;
  return (
    (uncachedInput * modelPrice.in +
      cached * modelPrice.cached +
      cacheWrite * writePrice +
      usage.outputTokens * modelPrice.out) /
    1_000_000
  );
}

/**
 * Computes single-turn USD cost using V2 orthogonal token buckets without double-counting reasoning.
 */
export function calculateOrthogonalTurnCostUsd(
  usage: OrthogonalUsageCounters,
  modelPrice: ModelPricing,
  modelId?: string,
): number {
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const reasoning = usage.reasoningTokens ?? 0;
  assertValidCounter(usage.uncachedInputTokens, "uncachedInputTokens");
  assertValidCounter(usage.cacheReadTokens, "cacheReadTokens");
  assertValidCounter(cacheWrite, "cacheWriteTokens");
  assertValidCounter(usage.outputTokens, "outputTokens");
  assertValidCounter(reasoning, "reasoningTokens");
  assertValidCounter(modelPrice.in, "modelPrice.in");
  assertValidCounter(modelPrice.cached, "modelPrice.cached");
  assertValidCounter(modelPrice.out, "modelPrice.out");

  const effectiveCacheWrite = resolveEffectiveCacheWritePrice(modelId, modelPrice);
  const billedOutput =
    usage.reasoningIncludedInOutput === false ? usage.outputTokens + reasoning : usage.outputTokens;

  return (
    (usage.uncachedInputTokens * modelPrice.in +
      usage.cacheReadTokens * modelPrice.cached +
      cacheWrite * effectiveCacheWrite +
      billedOutput * modelPrice.out) /
    1_000_000
  );
}

/**
 * Computes net USD saved by prompt caching after deducting cache-write creation premium.
 */
export function calculateCacheNetSavedUsd(
  usage: Pick<OrthogonalUsageCounters, "cacheReadTokens" | "cacheWriteTokens">,
  modelPrice: ModelPricing,
  modelId?: string,
): number {
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  assertValidCounter(usage.cacheReadTokens, "cacheReadTokens");
  assertValidCounter(cacheWrite, "cacheWriteTokens");
  assertValidCounter(modelPrice.in, "modelPrice.in");
  assertValidCounter(modelPrice.cached, "modelPrice.cached");

  const effectiveCacheWrite = resolveEffectiveCacheWritePrice(modelId, modelPrice);
  return (
    (usage.cacheReadTokens * (modelPrice.in - modelPrice.cached) -
      cacheWrite * (effectiveCacheWrite - modelPrice.in)) /
    1_000_000
  );
}

/**
 * Normalizes providers (such as Pi / Anthropic) whose `inputTokens` excludes cached tokens
 * into Kiln's canonical `inputTokens = uncached + cached` representation.
 */
export function normalizeUncachedUsage(
  usage: UncachedUsageInput,
): NormalizedUsageCounters {
  assertValidCounter(usage.uncachedInputTokens, "uncachedInputTokens");
  assertValidCounter(usage.cachedInputTokens, "cachedInputTokens");
  assertValidCounter(usage.outputTokens, "outputTokens");

  return {
    inputTokens: usage.uncachedInputTokens + usage.cachedInputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
  };
}

/**
 * Diffs cumulative session-scoped counters (e.g. Pi `lastUsage`) into a single-turn delta.
 */
export function diffCumulativeUsage(
  previous: TurnUsageCounters | null,
  current: TurnUsageCounters,
): NormalizedUsageCounters {
  const currCached = current.cachedInputTokens ?? 0;
  assertValidCounter(current.inputTokens, "current.inputTokens");
  assertValidCounter(currCached, "current.cachedInputTokens");
  assertValidCounter(current.outputTokens, "current.outputTokens");

  if (previous === null) {
    return {
      inputTokens: current.inputTokens,
      cachedInputTokens: currCached,
      outputTokens: current.outputTokens,
    };
  }

  const prevCached = previous.cachedInputTokens ?? 0;
  assertValidCounter(previous.inputTokens, "previous.inputTokens");
  assertValidCounter(prevCached, "previous.cachedInputTokens");
  assertValidCounter(previous.outputTokens, "previous.outputTokens");

  if (
    current.inputTokens < previous.inputTokens ||
    currCached < prevCached ||
    current.outputTokens < previous.outputTokens
  ) {
    throw new RangeError("Cumulative usage counters decreased compared to previous turn");
  }

  return {
    inputTokens: current.inputTokens - previous.inputTokens,
    cachedInputTokens: currCached - prevCached,
    outputTokens: current.outputTokens - previous.outputTokens,
  };
}
