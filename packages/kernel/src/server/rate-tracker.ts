export interface LiveRateSampleInput {
  taskId: string;
  text: string;
  timestampMs?: number;
}

export interface LiveRateSnapshot {
  tokPerSec: number;
  rates: Record<string, number>;
}

export interface RateTickPayload {
  rates: Record<string, number>;
  totals: {
    costUsd: number;
    tokPerSec: number;
  };
}

export interface LiveRateTrackerOptions {
  /** Sliding time window in milliseconds (default 4500ms). */
  windowMs?: number;
  /** Throttle interval in milliseconds for rate.tick broadcasts while active (default 500ms). */
  tickIntervalMs?: number;
  now?: () => number;
  getCostUsd?: () => number;
  onTick?: (payload: RateTickPayload) => void;
}

interface TokenSample {
  timestampMs: number;
  tokens: number;
}

const DEFAULT_WINDOW_MS = 4_500;
const DEFAULT_TICK_INTERVAL_MS = 500;

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Estimates incremental token count from delta text (`Math.max(1, Math.ceil(len / 4))` for non-empty chunks).
 */
export function approximateDeltaTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Sliding-window live token-rate tracker for running tasks.
 *
 * Schedules throttled `rate.tick` notifications ONLY while active samples exist in the window,
 * emitting one final zeroed tick once samples expire or tasks are cleared, and leaves zero
 * background `setInterval` timers running when idle.
 */
export class LiveRateTracker {
  readonly windowMs: number;
  readonly tickIntervalMs: number;

  private readonly now: () => number;
  private readonly getCostUsd: (() => number) | undefined;
  private readonly onTick: ((payload: RateTickPayload) => void) | undefined;

  private readonly samplesByTask = new Map<string, TokenSample[]>();
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEmitAtMs = 0;
  private hasEmittedNonZero = false;
  private stopped = false;

  constructor(options: LiveRateTrackerOptions = {}) {
    const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError(`LiveRateTracker windowMs must be positive, got: ${windowMs}`);
    }
    if (!Number.isFinite(tickIntervalMs) || tickIntervalMs < 0) {
      throw new RangeError(
        `LiveRateTracker tickIntervalMs must be non-negative, got: ${tickIntervalMs}`,
      );
    }

    this.windowMs = windowMs;
    this.tickIntervalMs = tickIntervalMs;
    this.now = options.now ?? (() => Date.now());
    this.getCostUsd = options.getCostUsd;
    this.onTick = options.onTick;
  }

  get activeTimerCount(): number {
    return this.tickTimer === null ? 0 : 1;
  }

  recordDelta(input: LiveRateSampleInput): number {
    if (this.stopped) {
      return 0;
    }

    const tokens = approximateDeltaTokens(input.text);
    if (tokens <= 0) {
      return 0;
    }

    const ts = input.timestampMs ?? this.now();
    this.pruneExpired(ts);

    let list = this.samplesByTask.get(input.taskId);
    if (!list) {
      list = [];
      this.samplesByTask.set(input.taskId, list);
    }
    list.push({ timestampMs: ts, tokens });
    this.hasEmittedNonZero = true;

    this.scheduleNextTick(ts);
    return tokens;
  }

  clearTask(taskId: string): boolean {
    const existed = this.samplesByTask.delete(taskId);
    if (existed && !this.stopped) {
      if (this.samplesByTask.size === 0) {
        this.clearTimer();
        if (this.hasEmittedNonZero) {
          this.hasEmittedNonZero = false;
          this.emitTick();
        }
      } else {
        this.emitTick();
      }
    }
    return existed;
  }

  snapshot(nowMs: number = this.now()): LiveRateSnapshot {
    this.pruneExpired(nowMs);
    const windowSeconds = this.windowMs / 1000;
    const rates: Record<string, number> = {};
    let total = 0;

    for (const [taskId, samples] of this.samplesByTask) {
      let sumTokens = 0;
      for (const s of samples) {
        sumTokens += s.tokens;
      }
      const rate = roundOneDecimal(sumTokens / windowSeconds);
      if (rate > 0) {
        rates[taskId] = rate;
        total += rate;
      } else {
        this.samplesByTask.delete(taskId);
      }
    }

    return {
      tokPerSec: roundOneDecimal(total),
      rates,
    };
  }

  emitTick(nowMs: number = this.now()): RateTickPayload {
    const snap = this.snapshot(nowMs);
    const rawCost = this.getCostUsd ? this.getCostUsd() : 0;
    const costUsd = Number.isFinite(rawCost) && rawCost >= 0 ? rawCost : 0;
    const payload: RateTickPayload = {
      rates: snap.rates,
      totals: {
        costUsd,
        tokPerSec: snap.tokPerSec,
      },
    };
    this.lastEmitAtMs = nowMs;
    if (snap.tokPerSec === 0) {
      this.hasEmittedNonZero = false;
    } else {
      this.hasEmittedNonZero = true;
    }
    this.onTick?.(payload);
    return payload;
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.samplesByTask.clear();
    this.hasEmittedNonZero = false;
  }

  private pruneExpired(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    for (const [taskId, samples] of this.samplesByTask) {
      while (samples.length > 0 && samples[0]!.timestampMs < cutoff) {
        samples.shift();
      }
      if (samples.length === 0) {
        this.samplesByTask.delete(taskId);
      }
    }
  }

  private clearTimer(): void {
    if (this.tickTimer !== null) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private scheduleNextTick(nowMs: number): void {
    if (this.stopped || !this.onTick || this.tickTimer !== null) {
      return;
    }
    if (this.samplesByTask.size === 0 && !this.hasEmittedNonZero) {
      return;
    }

    const elapsed = nowMs - this.lastEmitAtMs;
    const delayMs =
      this.lastEmitAtMs === 0 || elapsed >= this.tickIntervalMs
        ? Math.min(50, this.tickIntervalMs)
        : Math.max(1, this.tickIntervalMs - elapsed);

    const timer = setTimeout(() => {
      this.tickTimer = null;
      if (this.stopped) {
        return;
      }
      const tickNow = this.now();
      const payload = this.emitTick(tickNow);
      if (Object.keys(payload.rates).length > 0) {
        this.scheduleNextTick(tickNow);
      }
    }, delayMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
    this.tickTimer = timer;
  }
}
