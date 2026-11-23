import {
  RunEventSchema,
  RunUsageSchema,
  type CostSource,
  type ProviderUsageRule,
  type RunEvent,
  type RunUsage,
} from "@kiln/protocol";

export interface RawProviderUsage {
  inputTokens?: number;
  cachedReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  providerCostUsd?: number;
  costSource?: CostSource;
}

export interface CumulativeCountersSnapshot {
  inputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface ProviderTurnAccum {
  inputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  providerCostUsd?: number;
  costSource?: CostSource;
  hasData: boolean;
}

export interface ProviderUsageNormalizerState {
  lastCumulative: CumulativeCountersSnapshot | null;
  turnAccum: ProviderTurnAccum;
  usedTurnIds: Set<string>;
  turnSeq: number;
}

export const DEFAULT_PROVIDER_USAGE_RULES: Readonly<Record<string, ProviderUsageRule>> = {
  codex: {
    scope: "cumulative_thread",
    input_includes_cache: true,
    reasoning_included_in_output: true,
  },
  pi: {
    scope: "per_message",
    input_includes_cache: false,
    reasoning_included_in_output: true,
  },
  agy: {
    scope: "per_turn",
    input_includes_cache: false,
    reasoning_included_in_output: true,
  },
  claude: {
    scope: "per_turn",
    input_includes_cache: false,
    reasoning_included_in_output: true,
  },
  gemini: {
    scope: "per_turn",
    input_includes_cache: false,
    reasoning_included_in_output: true,
  },
  opencode: {
    scope: "per_turn",
    input_includes_cache: false,
    reasoning_included_in_output: true,
  },
};

function createEmptyTurnAccum(): ProviderTurnAccum {
  return {
    inputTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    hasData: false,
  };
}

export function createProviderUsageNormalizerState(): ProviderUsageNormalizerState {
  return {
    lastCumulative: null,
    turnAccum: createEmptyTurnAccum(),
    usedTurnIds: new Set<string>(),
    turnSeq: 0,
  };
}

export function resolveProviderUsageRule(
  providerId: string,
  override?: ProviderUsageRule,
): ProviderUsageRule {
  if (override) {
    return override;
  }
  const key = providerId.trim().toLowerCase();
  return (
    DEFAULT_PROVIDER_USAGE_RULES[key] ?? {
      scope: "per_turn",
      input_includes_cache: false,
      reasoning_included_in_output: true,
    }
  );
}

export function hasRawUsageCounters(raw: RawProviderUsage | null | undefined): raw is RawProviderUsage {
  if (!raw) {
    return false;
  }
  return (
    raw.inputTokens !== undefined ||
    raw.cachedReadTokens !== undefined ||
    raw.cacheWriteTokens !== undefined ||
    raw.outputTokens !== undefined ||
    raw.reasoningTokens !== undefined
  );
}

export function allocateUniqueUsageTurnId(
  state: ProviderUsageNormalizerState,
  agentId: string,
  candidates: readonly (string | null | undefined)[] = [],
): string {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
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

function assertNonNegativeIntOrZero(value: number | undefined, label: string): number {
  const num = value ?? 0;
  if (!Number.isFinite(num) || num < 0) {
    throw new RangeError(`${label} must be a non-negative finite number, got: ${num}`);
  }
  return Math.trunc(num);
}

export interface NormalizeProviderTurnUsageInput {
  provider: string;
  model: string;
  agentId: string;
  raw: RawProviderUsage | null | undefined;
  rule: ProviderUsageRule;
  state: ProviderUsageNormalizerState;
  candidateTurnIds?: readonly (string | null | undefined)[];
}

/**
 * Normalizes multi-CLI usage (Codex cumulative_thread, Pi per_message, ACP/Claude per_turn)
 * into orthogonal V2 + legacy-compatible `RunUsage`.
 */
export function normalizeProviderTurnUsage(
  input: NormalizeProviderTurnUsageInput,
): RunUsage | null {
  if (!hasRawUsageCounters(input.raw)) {
    return null;
  }

  const curr: CumulativeCountersSnapshot = {
    inputTokens: assertNonNegativeIntOrZero(input.raw.inputTokens, "raw.inputTokens"),
    cachedReadTokens: assertNonNegativeIntOrZero(input.raw.cachedReadTokens, "raw.cachedReadTokens"),
    cacheWriteTokens: assertNonNegativeIntOrZero(input.raw.cacheWriteTokens, "raw.cacheWriteTokens"),
    outputTokens: assertNonNegativeIntOrZero(input.raw.outputTokens, "raw.outputTokens"),
    reasoningTokens: assertNonNegativeIntOrZero(input.raw.reasoningTokens, "raw.reasoningTokens"),
  };

  let delta: CumulativeCountersSnapshot;
  if (input.rule.scope === "cumulative_thread") {
    const prev = input.state.lastCumulative;
    if (prev === null) {
      delta = curr;
    } else {
      if (
        curr.inputTokens < prev.inputTokens ||
        curr.cachedReadTokens < prev.cachedReadTokens ||
        curr.cacheWriteTokens < prev.cacheWriteTokens ||
        curr.outputTokens < prev.outputTokens ||
        curr.reasoningTokens < prev.reasoningTokens
      ) {
        throw new RangeError("Cumulative thread usage counters decreased compared to previous snapshot");
      }
      delta = {
        inputTokens: curr.inputTokens - prev.inputTokens,
        cachedReadTokens: curr.cachedReadTokens - prev.cachedReadTokens,
        cacheWriteTokens: curr.cacheWriteTokens - prev.cacheWriteTokens,
        outputTokens: curr.outputTokens - prev.outputTokens,
        reasoningTokens: curr.reasoningTokens - prev.reasoningTokens,
      };
    }
    input.state.lastCumulative = { ...curr };
  } else {
    delta = curr;
  }

  let uncachedInputTokens: number;
  let canonicalInputTokens: number;
  if (input.rule.input_includes_cache) {
    uncachedInputTokens = Math.max(0, delta.inputTokens - delta.cachedReadTokens);
    canonicalInputTokens = Math.max(delta.inputTokens, delta.cachedReadTokens);
  } else {
    uncachedInputTokens = delta.inputTokens;
    canonicalInputTokens = delta.inputTokens + delta.cachedReadTokens;
  }

  const turnId = allocateUniqueUsageTurnId(input.state, input.agentId, input.candidateTurnIds);
  const providerCost =
    input.raw.providerCostUsd !== undefined &&
    Number.isFinite(input.raw.providerCostUsd) &&
    input.raw.providerCostUsd >= 0
      ? input.raw.providerCostUsd
      : undefined;

  return RunUsageSchema.parse({
    turnId,
    agent: input.provider,
    model: input.model,
    inputTokens: canonicalInputTokens,
    cachedInputTokens: delta.cachedReadTokens,
    outputTokens: delta.outputTokens,
    uncachedInputTokens,
    cacheReadTokens: delta.cachedReadTokens,
    cacheWriteTokens: delta.cacheWriteTokens,
    reasoningTokens: delta.reasoningTokens,
    reasoningIncludedInOutput: input.rule.reasoning_included_in_output,
    ...(providerCost !== undefined ? { providerCostUsd: providerCost } : {}),
    ...(input.raw.costSource !== undefined ? { costSource: input.raw.costSource } : {}),
  });
}

/**
 * Accumulates per-message deltas inside a single multi-step agent turn (e.g. `pi --mode rpc`).
 */
export function accumulateMessageUsage(
  state: ProviderUsageNormalizerState,
  raw: RawProviderUsage | null | undefined,
): void {
  if (!hasRawUsageCounters(raw)) {
    return;
  }
  state.turnAccum.inputTokens += assertNonNegativeIntOrZero(raw.inputTokens, "raw.inputTokens");
  state.turnAccum.cachedReadTokens += assertNonNegativeIntOrZero(
    raw.cachedReadTokens,
    "raw.cachedReadTokens",
  );
  state.turnAccum.cacheWriteTokens += assertNonNegativeIntOrZero(
    raw.cacheWriteTokens,
    "raw.cacheWriteTokens",
  );
  state.turnAccum.outputTokens += assertNonNegativeIntOrZero(raw.outputTokens, "raw.outputTokens");
  state.turnAccum.reasoningTokens += assertNonNegativeIntOrZero(
    raw.reasoningTokens,
    "raw.reasoningTokens",
  );
  if (
    raw.providerCostUsd !== undefined &&
    Number.isFinite(raw.providerCostUsd) &&
    raw.providerCostUsd >= 0
  ) {
    state.turnAccum.providerCostUsd = (state.turnAccum.providerCostUsd ?? 0) + raw.providerCostUsd;
  }
  if (raw.costSource !== undefined) {
    state.turnAccum.costSource = raw.costSource;
  }
  state.turnAccum.hasData = true;
}

export function flushAccumulatedTurnUsage(
  state: ProviderUsageNormalizerState,
  meta: {
    provider: string;
    model: string;
    agentId: string;
    rule: ProviderUsageRule;
    candidateTurnIds?: readonly (string | null | undefined)[];
  },
): RunUsage | null {
  if (!state.turnAccum.hasData) {
    return null;
  }
  const snapshot: RawProviderUsage = {
    inputTokens: state.turnAccum.inputTokens,
    cachedReadTokens: state.turnAccum.cachedReadTokens,
    cacheWriteTokens: state.turnAccum.cacheWriteTokens,
    outputTokens: state.turnAccum.outputTokens,
    reasoningTokens: state.turnAccum.reasoningTokens,
    ...(state.turnAccum.providerCostUsd !== undefined
      ? { providerCostUsd: state.turnAccum.providerCostUsd }
      : {}),
    ...(state.turnAccum.costSource !== undefined
      ? { costSource: state.turnAccum.costSource }
      : {}),
  };
  state.turnAccum = createEmptyTurnAccum();
  return normalizeProviderTurnUsage({
    provider: meta.provider,
    model: meta.model,
    agentId: meta.agentId,
    raw: snapshot,
    rule: meta.rule,
    state,
    candidateTurnIds: meta.candidateTurnIds,
  });
}

/**
 * Emits a live context-window occupancy `RunEvent` (strictly decoupled from billing ledger).
 */
export function createContextWindowEvent(
  usedTokens: number,
  contextWindowTokens: number,
  at = new Date().toISOString(),
): RunEvent {
  const safeUsed = Math.max(0, Math.trunc(usedTokens));
  const safeMax = Math.max(1, Math.trunc(contextWindowTokens));
  const rawPct = (safeUsed / safeMax) * 100;
  const percent = Math.min(100, Math.max(0, Math.round(rawPct * 100) / 100));

  return RunEventSchema.parse({
    kind: "context_window",
    at,
    usedTokens: safeUsed,
    contextWindowTokens: safeMax,
    percent,
  });
}
