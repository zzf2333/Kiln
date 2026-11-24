import type { SessionRef } from "@kiln/protocol";
import type { ExecutionBackend, SessionProbeResult } from "../backend/types.js";

export const DEFAULT_STALL_TIMEOUT_SEC = 600;
export const DEFAULT_STALL_CHECK_INTERVAL_MS = 15_000;
export const HARD_STALL_MULTIPLIER = 2;
export const STALL_PROBE_TIMEOUT_MS = 5_000;

export interface EvaluateRunStallInput {
  silentMs: number;
  stallTimeoutMs: number;
  alreadyWarned: boolean;
  probeResult: SessionProbeResult | null;
}

export type EvaluateRunStallResult =
  | { action: "none"; silentSec: number }
  | { action: "soft_warn"; silentSec: number }
  | { action: "abort_dead"; silentSec: number }
  | { action: "abort_hard_timeout"; silentSec: number };

/**
 * Pure Witness decision policy for evaluating whether a silent running turn needs
 * a soft alert, an immediate dead-process abort, a 2x hard timeout abort, or no action.
 */
export function evaluateRunStallState(input: EvaluateRunStallInput): EvaluateRunStallResult {
  const silentSec = Math.max(0, Math.floor(input.silentMs / 1_000));
  if (input.stallTimeoutMs <= 0 || input.silentMs < input.stallTimeoutMs) {
    return { action: "none", silentSec };
  }

  if (
    input.probeResult !== null &&
    (!input.probeResult.alive || input.probeResult.status === "closed")
  ) {
    return { action: "abort_dead", silentSec };
  }

  if (input.silentMs >= input.stallTimeoutMs * HARD_STALL_MULTIPLIER) {
    return { action: "abort_hard_timeout", silentSec };
  }

  if (!input.alreadyWarned) {
    return { action: "soft_warn", silentSec };
  }

  return { action: "none", silentSec };
}

/**
 * Bounded-timeout wrapper around `backend.probe(sessionRef)` so stalled/hung backends
 * never block the watchdog sweep loop.
 */
export async function probeSessionWithTimeout(
  backend: ExecutionBackend,
  sessionRef: SessionRef,
  timeoutMs = STALL_PROBE_TIMEOUT_MS,
): Promise<SessionProbeResult | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      backend.probe(sessionRef),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(10, timeoutMs));
        timer.unref?.();
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
