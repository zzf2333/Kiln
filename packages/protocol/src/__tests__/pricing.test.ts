import { describe, expect, it } from "vitest";
import {
  calculateTurnCostUsd,
  diffCumulativeUsage,
  normalizeUncachedUsage,
} from "../pricing.js";

describe("pricing and usage normalization", () => {
  const price = { in: 3.0, cached: 0.3, out: 15.0 };

  it("computes exact API cost with cached token deduction", () => {
    const cost = calculateTurnCostUsd(
      {
        inputTokens: 1_000_000,
        cachedInputTokens: 800_000,
        outputTokens: 100_000,
      },
      price,
    );
    // (200k * 3.0 + 800k * 0.3 + 100k * 15.0) / 1e6 = 0.6 + 0.24 + 1.5 = 2.34
    expect(cost).toBeCloseTo(2.34, 8);

    const zeroCache = calculateTurnCostUsd(
      { inputTokens: 500_000, outputTokens: 50_000 },
      price,
    );
    expect(zeroCache).toBeCloseTo(1.5 + 0.75, 8);
  });

  it("throws explicitly when cachedInputTokens exceeds inputTokens or counters are negative", () => {
    expect(() =>
      calculateTurnCostUsd(
        { inputTokens: 12365, cachedInputTokens: 104704, outputTokens: 482 },
        price,
      ),
    ).toThrow(RangeError);

    expect(() =>
      calculateTurnCostUsd(
        { inputTokens: -1, cachedInputTokens: 0, outputTokens: 10 },
        price,
      ),
    ).toThrow(RangeError);
  });

  it("normalizes and diffs M0 V9 Pi cumulative uncached usage snapshots accurately", () => {
    // Real M0 V9 Pi probe observations:
    // Turn 1: inputTokens=12365 (uncached), cachedInputTokens=104704, outputTokens=482
    // Turn 2: inputTokens=12581 (uncached), cachedInputTokens=128640, outputTokens=484
    const turn1Raw = { inputTokens: 12365, cachedInputTokens: 104704, outputTokens: 482 };
    const turn2Raw = { inputTokens: 12581, cachedInputTokens: 128640, outputTokens: 484 };

    const turn1Delta = diffCumulativeUsage(null, turn1Raw);
    const turn2Delta = diffCumulativeUsage(turn1Raw, turn2Raw);

    expect(turn2Delta).toEqual({
      inputTokens: 216,
      cachedInputTokens: 23936,
      outputTokens: 2,
    });

    const turn1Normalized = normalizeUncachedUsage({
      uncachedInputTokens: turn1Delta.inputTokens,
      cachedInputTokens: turn1Delta.cachedInputTokens,
      outputTokens: turn1Delta.outputTokens,
    });
    const turn2Normalized = normalizeUncachedUsage({
      uncachedInputTokens: turn2Delta.inputTokens,
      cachedInputTokens: turn2Delta.cachedInputTokens,
      outputTokens: turn2Delta.outputTokens,
    });

    expect(turn1Normalized.inputTokens).toBe(12365 + 104704);
    expect(turn2Normalized.inputTokens).toBe(216 + 23936);

    const turn1Cost = calculateTurnCostUsd(turn1Normalized, price);
    const turn2Cost = calculateTurnCostUsd(turn2Normalized, price);
    expect(turn1Cost).toBeGreaterThan(0);
    expect(turn2Cost).toBeGreaterThan(0);
    expect(turn2Cost).toBeLessThan(turn1Cost);
  });

  it("rejects decreasing cumulative usage snapshots", () => {
    expect(() =>
      diffCumulativeUsage(
        { inputTokens: 100, cachedInputTokens: 50, outputTokens: 10 },
        { inputTokens: 90, cachedInputTokens: 50, outputTokens: 10 },
      ),
    ).toThrow(RangeError);
  });
});
