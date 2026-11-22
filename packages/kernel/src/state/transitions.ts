import {
  getWorkflowStages,
  type StageId,
  type TaskStatus,
  type Track,
  type WorkflowCardLike,
} from "@kiln/protocol";

/**
 * Exhaustive transition table for the 6+1 task status model.
 * - `done` and `cancelled` are terminal (no outgoing edges).
 * - `paused` can only return to `queued` (via `resumed`) or transition to `cancelled` (never `waiting`).
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["running", "paused", "waiting", "cancelled"],
  running: ["queued", "paused", "waiting", "external", "done", "cancelled"],
  paused: ["queued", "cancelled"],
  waiting: ["queued", "external", "done", "cancelled"],
  external: ["queued", "waiting", "done", "cancelled"],
  done: [],
  cancelled: [],
};

/**
 * Raised when an invalid state transition is attempted under the 6+1 state machine.
 */
export class InvalidStateTransitionError extends Error {
  readonly from: TaskStatus;
  readonly to: TaskStatus;

  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Invalid task state transition: "${from}" -> "${to}"`);
    this.name = "InvalidStateTransitionError";
    this.from = from;
    this.to = to;
  }
}

/**
 * Raised when an operation requests a Post-MVP track (such as `L3` research).
 */
export class UnsupportedTrackError extends Error {
  readonly track: Track;

  constructor(track: Track) {
    super(`Track "${track}" is Post-MVP and is not supported in M1/MVP`);
    this.name = "UnsupportedTrackError";
    this.track = track;
  }
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertValidTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}

/**
 * Returns the ordered execution stages for a supported track (`L1` / `L2`).
 * Explicitly throws `UnsupportedTrackError` for `L3` (Post-MVP boundary).
 */
export function getTrackStages(track: Track, humanAccept: boolean): readonly StageId[] {
  switch (track) {
    case "L1":
      return humanAccept
        ? (["implement", "verify", "accept", "deliver"] as const)
        : (["implement", "verify", "deliver"] as const);
    case "L2":
      return humanAccept
        ? (["implement", "verify", "review", "accept", "deliver"] as const)
        : (["implement", "verify", "review", "deliver"] as const);
    case "L3":
      throw new UnsupportedTrackError(track);
  }
}

/**
 * Computes the next stage in the track pipeline after `currentStage`,
 * or `null` when `currentStage` is the final stage (`deliver`).
 */
export function nextStageAfter(
  track: Track,
  currentStage: StageId,
  humanAccept: boolean,
): StageId | null {
  const stages = getTrackStages(track, humanAccept);
  const index = stages.indexOf(currentStage);
  if (index === -1) {
    throw new Error(
      `Stage "${currentStage}" is not part of track "${track}" pipeline (${stages.join(" -> ")})`,
    );
  }
  return stages[index + 1] ?? null;
}

/**
 * Resolves the ordered execution stages for a task card:
 * delegates to `card.workflow` when present, or falls back to legacy `L1`/`L2` track pipelines.
 */
export function getTaskPipelineStages(
  card: WorkflowCardLike,
  effectiveTrack: Track = card.track,
): readonly StageId[] {
  if (effectiveTrack === "L3") {
    throw new UnsupportedTrackError("L3");
  }
  if (!card.workflow) {
    return getTrackStages(effectiveTrack, Boolean(card.contract.human_accept));
  }
  return getWorkflowStages(card, effectiveTrack);
}

/**
 * Computes the next stage in the task's effective blueprint/track pipeline after `currentStage`.
 */
export function nextTaskStageAfter(
  card: WorkflowCardLike,
  currentStage: StageId,
  effectiveTrack: Track = card.track,
): StageId | null {
  const stages = getTaskPipelineStages(card, effectiveTrack);
  const index = stages.indexOf(currentStage);
  if (index === -1) {
    throw new Error(
      `Stage "${currentStage}" is not part of task pipeline (${stages.join(" -> ")})`,
    );
  }
  return stages[index + 1] ?? null;
}

export interface ExternalSideEffectProbe {
  action: string;
  alreadyApplied: boolean;
  ref?: string;
}

export type ExternalSideEffectRetryDecision =
  | {
      shouldExecute: false;
      disposition: "skip_already_applied";
      action: string;
      ref?: string;
    }
  | {
      shouldExecute: true;
      disposition: "execute_side_effect";
      action: string;
    };

/**
 * Idempotency guard before replaying any external side effect (merge/push/PR/release)
 * after a timeout or disconnect (`REVIEW.md §3.1 #6`).
 */
export function resolveExternalSideEffectRetry(
  probe: ExternalSideEffectProbe,
): ExternalSideEffectRetryDecision {
  if (probe.action.trim().length === 0) {
    throw new Error("External side-effect action must be a non-empty string");
  }

  if (probe.alreadyApplied) {
    return {
      shouldExecute: false,
      disposition: "skip_already_applied",
      action: probe.action,
      ...(probe.ref !== undefined ? { ref: probe.ref } : {}),
    };
  }

  return {
    shouldExecute: true,
    disposition: "execute_side_effect",
    action: probe.action,
  };
}
