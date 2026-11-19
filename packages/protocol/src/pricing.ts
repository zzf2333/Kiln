import type { ModelPricing } from "./config.js";

export interface TurnUsageCounters {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
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

export function calculateTurnCostUsd(
  usage: TurnUsageCounters,
  modelPrice: ModelPricing,
): number {
  const cached = usage.cachedInputTokens ?? 0;
  assertValidCounter(usage.inputTokens, "inputTokens");
  assertValidCounter(cached, "cachedInputTokens");
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
  return (
    (uncachedInput * modelPrice.in +
      cached * modelPrice.cached +
      usage.outputTokens * modelPrice.out) /
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
