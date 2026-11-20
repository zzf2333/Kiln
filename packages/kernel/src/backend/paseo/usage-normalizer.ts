import {
  diffCumulativeUsage,
  normalizeUncachedUsage,
  type RunUsage,
  RunUsageSchema,
  type TurnUsageCounters,
} from "@kiln/protocol";
import type { PaseoAgentUsage } from "./types.js";

export interface ProviderUsageRule {
  cumulative: boolean;
  inputExcludesCached: boolean;
}

const DEFAULT_PROVIDER_USAGE_RULES: Readonly<Record<string, ProviderUsageRule>> = {
  pi: { cumulative: true, inputExcludesCached: true },
  codex: { cumulative: false, inputExcludesCached: false },
  claude: { cumulative: false, inputExcludesCached: false },
  opencode: { cumulative: false, inputExcludesCached: false },
  antigravity: { cumulative: false, inputExcludesCached: false },
};

const FALLBACK_USAGE_RULE: ProviderUsageRule = {
  cumulative: false,
  inputExcludesCached: false,
};

export interface SessionUsageState {
  lastCumulativeRawUsage: TurnUsageCounters | null;
  usedTurnIds: Set<string>;
  turnSeq: number;
}

export function createSessionUsageState(): SessionUsageState {
  return {
    lastCumulativeRawUsage: null,
    usedTurnIds: new Set<string>(),
    turnSeq: 0,
  };
}

export function getProviderUsageRule(
  provider: string,
  overrides?: Readonly<Record<string, ProviderUsageRule>>,
): ProviderUsageRule {
  const key = provider.trim().toLowerCase();
  return overrides?.[key] ?? DEFAULT_PROVIDER_USAGE_RULES[key] ?? FALLBACK_USAGE_RULE;
}

export function allocateUniqueTurnId(
  state: SessionUsageState,
  agentId: string,
  candidates: readonly (string | null | undefined)[] = [],
): string {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed.length > 0 && !state.usedTurnIds.has(trimmed)) {
      state.usedTurnIds.add(trimmed);
      return trimmed;
    }
  }

  let generated: string;
  do {
    generated = `${agentId}-turn-${++state.turnSeq}`;
  } while (state.usedTurnIds.has(generated));

  state.usedTurnIds.add(generated);
  return generated;
}

export interface NormalizeTurnUsageInput {
  provider: string;
  model: string;
  agentId: string;
  rawUsage: PaseoAgentUsage | null | undefined;
  source: "turn_completed" | "last_usage";
  state: SessionUsageState;
  candidateTurnIds?: readonly (string | null | undefined)[];
  rules?: Readonly<Record<string, ProviderUsageRule>>;
}

export function hasAnyTokenCounter(
  usage: PaseoAgentUsage | null | undefined,
): usage is PaseoAgentUsage {
  if (!usage) {
    return false;
  }
  return (
    usage.inputTokens !== undefined ||
    usage.cachedInputTokens !== undefined ||
    usage.outputTokens !== undefined
  );
}

/**
 * Normalizes Paseo per-turn or cumulative/uncached-only usage into canonical Kiln `RunUsage`
 * (`inputTokens = uncached + cached`, non-decreasing per-turn deltas, unique `turnId`).
 */
export function normalizeTurnUsage(input: NormalizeTurnUsageInput): RunUsage | null {
  if (!hasAnyTokenCounter(input.rawUsage)) {
    return null;
  }

  const currRaw: TurnUsageCounters = {
    inputTokens: input.rawUsage.inputTokens ?? 0,
    cachedInputTokens: input.rawUsage.cachedInputTokens ?? 0,
    outputTokens: input.rawUsage.outputTokens ?? 0,
  };
  const currCached = currRaw.cachedInputTokens ?? 0;
  const rule = getProviderUsageRule(input.provider, input.rules);

  if (
    input.source === "turn_completed" &&
    !rule.cumulative &&
    !rule.inputExcludesCached &&
    currRaw.inputTokens >= currCached
  ) {
    const turnId = allocateUniqueTurnId(input.state, input.agentId, input.candidateTurnIds);
    return RunUsageSchema.parse({
      turnId,
      agent: input.provider,
      model: input.model,
      inputTokens: currRaw.inputTokens,
      cachedInputTokens: currCached,
      outputTokens: currRaw.outputTokens,
    });
  }

  const delta = rule.cumulative
    ? diffCumulativeUsage(input.state.lastCumulativeRawUsage, currRaw)
    : {
        inputTokens: currRaw.inputTokens,
        cachedInputTokens: currCached,
        outputTokens: currRaw.outputTokens,
      };

  if (rule.cumulative) {
    input.state.lastCumulativeRawUsage = { ...currRaw };
  }

  const normalized =
    rule.inputExcludesCached || delta.cachedInputTokens > delta.inputTokens
      ? normalizeUncachedUsage({
          uncachedInputTokens: delta.inputTokens,
          cachedInputTokens: delta.cachedInputTokens,
          outputTokens: delta.outputTokens,
        })
      : delta;

  const turnId = allocateUniqueTurnId(input.state, input.agentId, input.candidateTurnIds);
  return RunUsageSchema.parse({
    turnId,
    agent: input.provider,
    model: input.model,
    inputTokens: normalized.inputTokens,
    cachedInputTokens: normalized.cachedInputTokens,
    outputTokens: normalized.outputTokens,
  });
}
