import {
  getWorkflowLoopPolicy,
  type CardLimits,
  type GateReport,
  type ReceiptValidationResult,
  type ReviewerReceiptFrontmatter,
  type RoleId,
  type StageId,
  type TaskCard,
  type Track,
  type WorkerReceiptFrontmatter,
} from "@kiln/protocol";
import { getTaskPipelineStages, nextTaskStageAfter } from "./transitions.js";

export interface StageCounters {
  stageRetries: number;
  reviewRounds: number;
  advisorCalls: number;
  totalTokens: number;
}

export type CircuitBreakerReason =
  | "retries_per_stage_exceeded"
  | "review_rounds_exceeded"
  | "advisor_calls_exceeded"
  | "max_tokens_exceeded";

export interface CircuitBreakerResult {
  tripped: boolean;
  reasons: CircuitBreakerReason[];
  details: string[];
}

/**
 * Raised when a role other than `"kernel"` or `"triage"` attempts to invoke `advisor`.
 */
export class UnauthorizedAdvisorCallError extends Error {
  readonly caller: RoleId | "kernel";

  constructor(caller: RoleId | "kernel") {
    super(
      `Role "${caller}" is forbidden from invoking advisor; only "kernel" or "triage" may invoke advisor`,
    );
    this.name = "UnauthorizedAdvisorCallError";
    this.caller = caller;
  }
}

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number, got: ${value}`);
  }
}

/**
 * Evaluates all four card circuit-breaker thresholds (`retries_per_stage`,
 * `review_rounds`, `advisor_calls`, `max_tokens`). Reaching or exceeding any limit
 * trips the breaker and enumerates every triggered reason.
 */
export function checkCircuitBreaker(
  counters: StageCounters,
  limits: CardLimits,
): CircuitBreakerResult {
  assertNonNegativeFinite(counters.stageRetries, "counters.stageRetries");
  assertNonNegativeFinite(counters.reviewRounds, "counters.reviewRounds");
  assertNonNegativeFinite(counters.advisorCalls, "counters.advisorCalls");
  assertNonNegativeFinite(counters.totalTokens, "counters.totalTokens");

  const reasons: CircuitBreakerReason[] = [];
  const details: string[] = [];

  if (counters.stageRetries >= limits.retries_per_stage) {
    reasons.push("retries_per_stage_exceeded");
    details.push(
      `stageRetries (${counters.stageRetries}) >= retries_per_stage (${limits.retries_per_stage})`,
    );
  }
  if (counters.reviewRounds >= limits.review_rounds) {
    reasons.push("review_rounds_exceeded");
    details.push(
      `reviewRounds (${counters.reviewRounds}) >= review_rounds (${limits.review_rounds})`,
    );
  }
  if (counters.advisorCalls >= limits.advisor_calls) {
    reasons.push("advisor_calls_exceeded");
    details.push(
      `advisorCalls (${counters.advisorCalls}) >= advisor_calls (${limits.advisor_calls})`,
    );
  }
  if (counters.totalTokens >= limits.max_tokens) {
    reasons.push("max_tokens_exceeded");
    details.push(
      `totalTokens (${counters.totalTokens}) >= max_tokens (${limits.max_tokens})`,
    );
  }

  return {
    tripped: reasons.length > 0,
    reasons,
    details,
  };
}

/**
 * Enforces `docs/workflow-and-protocol.md §5.2`: only `"kernel"` or `"triage"` may wake `advisor`.
 */
export function assertCanInvokeAdvisor(caller: RoleId | "kernel"): void {
  if (caller !== "kernel" && caller !== "triage") {
    throw new UnauthorizedAdvisorCallError(caller);
  }
}

export type ExecutionFailureReason =
  | { kind: "rate_limited"; retryAfterMs: number; message?: string }
  | { kind: "timeout"; message?: string }
  | { kind: "schema_invalid"; errors: readonly string[]; message?: string }
  | { kind: "runtime_error"; message: string };

export interface HandleExecutionFailureInput {
  stage: StageId;
  failure: ExecutionFailureReason;
  counters: StageCounters;
  limits: CardLimits;
  triageAttempted?: boolean;
}

export type ExecutionFailureDecision =
  | {
      action: "cooldown_requeue";
      level: "none";
      retryAfterMs: number;
      countAsFailure: false;
      incrementRetry: false;
      reason: string;
    }
  | {
      action: "retry_stage";
      level: "L0";
      stage: StageId;
      countAsFailure: true;
      incrementRetry: true;
      nextRetryCount: number;
      reason: string;
    }
  | {
      action: "invoke_triage";
      level: "L2";
      countAsFailure: true;
      incrementRetry: false;
      reason: string;
      breaker: CircuitBreakerResult;
    }
  | {
      action: "wait_human";
      level: "L3";
      countAsFailure: true;
      incrementRetry: false;
      reason: string;
      breaker: CircuitBreakerResult;
    };

function formatFailureMessage(failure: Exclude<ExecutionFailureReason, { kind: "rate_limited" }>): string {
  switch (failure.kind) {
    case "timeout":
      return failure.message ?? "stage_timeout";
    case "schema_invalid":
      return failure.message ?? (failure.errors.join("; ") || "receipt_schema_invalid");
    case "runtime_error":
      return failure.message;
  }
}

/**
 * Routes execution failures through the 3-level escalation chain:
 * - Rate limits always queue for cooldown without counting as failures, retries, or trips (`REVIEW.md §3.1 #6`).
 * - Other failures follow L0 self-heal retry -> L2 `triage` -> L3 human `waiting`.
 */
export function handleExecutionFailure(
  input: HandleExecutionFailureInput,
): ExecutionFailureDecision {
  if (input.failure.kind === "rate_limited") {
    assertNonNegativeFinite(input.failure.retryAfterMs, "failure.retryAfterMs");
    return {
      action: "cooldown_requeue",
      level: "none",
      retryAfterMs: input.failure.retryAfterMs,
      countAsFailure: false,
      incrementRetry: false,
      reason: input.failure.message ?? "rate_limited",
    };
  }

  const breaker = checkCircuitBreaker(input.counters, input.limits);
  const failureMessage = formatFailureMessage(input.failure);

  if (input.counters.totalTokens >= input.limits.max_tokens) {
    return {
      action: "wait_human",
      level: "L3",
      countAsFailure: true,
      incrementRetry: false,
      reason: "max_tokens_exceeded",
      breaker,
    };
  }

  if (input.counters.stageRetries < input.limits.retries_per_stage) {
    return {
      action: "retry_stage",
      level: "L0",
      stage: input.stage,
      countAsFailure: true,
      incrementRetry: true,
      nextRetryCount: input.counters.stageRetries + 1,
      reason: failureMessage,
    };
  }

  if (!input.triageAttempted) {
    return {
      action: "invoke_triage",
      level: "L2",
      countAsFailure: true,
      incrementRetry: false,
      reason: failureMessage,
      breaker,
    };
  }

  return {
    action: "wait_human",
    level: "L3",
    countAsFailure: true,
    incrementRetry: false,
    reason: failureMessage,
    breaker,
  };
}

export type WorkerReceiptInput =
  | ReceiptValidationResult<WorkerReceiptFrontmatter>
  | WorkerReceiptFrontmatter;

export type ReviewerReceiptInput =
  | ReceiptValidationResult<ReviewerReceiptFrontmatter>
  | ReviewerReceiptFrontmatter;

function isValidationResult<T>(
  input: ReceiptValidationResult<T> | T,
): input is ReceiptValidationResult<T> {
  return typeof input === "object" && input !== null && "ok" in input;
}

export type WorkerStageEscalateReason = "frozen_files_changed" | "complexity_escalate";

export type WorkerStageDecision =
  | {
      action: "advance_stage";
      level: "none";
      gatePassed: true;
      ignoredSelfReportedPass: false;
      escalateToL2: boolean;
      escalateReason?: WorkerStageEscalateReason;
      effectiveTrack: Track;
      nextStage: StageId | null;
    }
  | {
      action: "retry_stage";
      level: "L0";
      stage: StageId;
      nextRetryCount: number;
      countAsFailure: true;
      incrementRetry: true;
      gatePassed: false;
      ignoredSelfReportedPass: boolean;
      escalateToL2: boolean;
      escalateReason?: WorkerStageEscalateReason;
      effectiveTrack: Track;
      reason: string;
    }
  | {
      action: "invoke_triage";
      level: "L2";
      gatePassed: boolean;
      ignoredSelfReportedPass: boolean;
      escalateToL2: boolean;
      escalateReason?: WorkerStageEscalateReason;
      effectiveTrack: Track;
      reason: string;
      breaker: CircuitBreakerResult;
    }
  | {
      action: "wait_human";
      level: "L3";
      gatePassed: boolean;
      ignoredSelfReportedPass: boolean;
      escalateToL2: boolean;
      escalateReason?: WorkerStageEscalateReason;
      effectiveTrack: Track;
      reason: string;
      breaker: CircuitBreakerResult;
    };

export interface EvaluateWorkerStageOptions {
  currentStage?: StageId;
  triageAttempted?: boolean;
}

function mapFailureToWorkerDecision(
  failureDecision: Exclude<ExecutionFailureDecision, { action: "cooldown_requeue" }>,
  meta: {
    gatePassed: boolean;
    ignoredSelfReportedPass: boolean;
    escalateToL2: boolean;
    escalateReason?: WorkerStageEscalateReason;
    effectiveTrack: Track;
  },
): WorkerStageDecision {
  const escalateMeta =
    meta.escalateReason !== undefined ? { escalateReason: meta.escalateReason } : {};
  switch (failureDecision.action) {
    case "retry_stage":
      return {
        action: "retry_stage",
        level: "L0",
        stage: failureDecision.stage,
        nextRetryCount: failureDecision.nextRetryCount,
        countAsFailure: true,
        incrementRetry: true,
        gatePassed: false,
        ignoredSelfReportedPass: meta.ignoredSelfReportedPass,
        escalateToL2: meta.escalateToL2,
        ...escalateMeta,
        effectiveTrack: meta.effectiveTrack,
        reason: failureDecision.reason,
      };
    case "invoke_triage":
      return {
        action: "invoke_triage",
        level: "L2",
        gatePassed: meta.gatePassed,
        ignoredSelfReportedPass: meta.ignoredSelfReportedPass,
        escalateToL2: meta.escalateToL2,
        ...escalateMeta,
        effectiveTrack: meta.effectiveTrack,
        reason: failureDecision.reason,
        breaker: failureDecision.breaker,
      };
    case "wait_human":
      return {
        action: "wait_human",
        level: "L3",
        gatePassed: meta.gatePassed,
        ignoredSelfReportedPass: meta.ignoredSelfReportedPass,
        escalateToL2: meta.escalateToL2,
        ...escalateMeta,
        effectiveTrack: meta.effectiveTrack,
        reason: failureDecision.reason,
        breaker: failureDecision.breaker,
      };
  }
}

/**
 * Evaluates a `worker` stage outcome strictly against kernel `gateReport` facts.
 * Never trusts self-reported `accept_result: "pass"` and escalates `L1 -> L2` when
 * frozen test files changed or the worker signals `complexity_escalate`.
 */
export function evaluateWorkerStageOutcome(
  card: TaskCard,
  receiptResult: WorkerReceiptInput,
  gateReport: GateReport,
  counters: StageCounters,
  options?: EvaluateWorkerStageOptions,
): WorkerStageDecision {
  // Reject L3 Post-MVP track upfront and validate blueprint pipeline.
  getTaskPipelineStages(card, card.track);

  const currentStage = options?.currentStage ?? "implement";
  const frozenChanged = gateReport.frozen_files_changed.length > 0;
  const breaker = checkCircuitBreaker(counters, card.limits);

  if (isValidationResult(receiptResult) && !receiptResult.ok) {
    const escalateToL2 = card.track === "L1" && frozenChanged;
    const escalateReason: WorkerStageEscalateReason | undefined = escalateToL2
      ? "frozen_files_changed"
      : undefined;
    const effectiveTrack: Track = escalateToL2 ? "L2" : card.track;

    const failureDecision = handleExecutionFailure({
      stage: currentStage,
      failure: { kind: "schema_invalid", errors: receiptResult.errors },
      counters,
      limits: card.limits,
      triageAttempted: options?.triageAttempted,
    });
    if (failureDecision.action === "cooldown_requeue") {
      throw new Error("Unexpected cooldown_requeue for schema_invalid receipt");
    }
    return mapFailureToWorkerDecision(failureDecision, {
      gatePassed: false,
      ignoredSelfReportedPass: false,
      escalateToL2,
      escalateReason,
      effectiveTrack,
    });
  }

  const receipt = isValidationResult(receiptResult)
    ? receiptResult.frontmatter
    : receiptResult;

  const escalateToL2 =
    card.track === "L1" && (frozenChanged || receipt.complexity_escalate);
  const escalateReason: WorkerStageEscalateReason | undefined =
    card.track === "L1"
      ? frozenChanged
        ? "frozen_files_changed"
        : receipt.complexity_escalate
          ? "complexity_escalate"
          : undefined
      : undefined;
  const effectiveTrack: Track = escalateToL2 ? "L2" : card.track;

  const artifactsOk = gateReport.artifacts_ok !== false;
  const gatePassed =
    gateReport.schema_ok &&
    gateReport.scope_ok &&
    artifactsOk &&
    gateReport.accept_exit_code === 0;

  if (receipt.outcome === "need_decision") {
    const escalateMeta =
      escalateReason !== undefined ? { escalateReason } : {};
    if (counters.totalTokens >= card.limits.max_tokens || options?.triageAttempted) {
      return {
        action: "wait_human",
        level: "L3",
        gatePassed,
        ignoredSelfReportedPass: false,
        escalateToL2,
        ...escalateMeta,
        effectiveTrack,
        reason: "worker_need_decision",
        breaker,
      };
    }
    return {
      action: "invoke_triage",
      level: "L2",
      gatePassed,
      ignoredSelfReportedPass: false,
      escalateToL2,
      ...escalateMeta,
      effectiveTrack,
      reason: "worker_need_decision",
      breaker,
    };
  }

  if (!gatePassed) {
    const ignoredSelfReportedPass = receipt.accept_result === "pass";
    const gateFailureReason = !gateReport.schema_ok
      ? "gate_schema_failed"
      : !gateReport.scope_ok
        ? `gate_scope_violation: ${gateReport.out_of_scope_paths.join(", ") || "out of scope"}`
        : !artifactsOk
          ? "gate_artifacts_failed"
          : `gate_accept_cmd_failed (exit=${gateReport.accept_exit_code})`;

    const failureDecision = handleExecutionFailure({
      stage: currentStage,
      failure: { kind: "runtime_error", message: gateFailureReason },
      counters,
      limits: card.limits,
      triageAttempted: options?.triageAttempted,
    });
    if (failureDecision.action === "cooldown_requeue") {
      throw new Error("Unexpected cooldown_requeue for gate failure");
    }
    return mapFailureToWorkerDecision(failureDecision, {
      gatePassed: false,
      ignoredSelfReportedPass,
      escalateToL2,
      escalateReason,
      effectiveTrack,
    });
  }

  if (counters.totalTokens >= card.limits.max_tokens) {
    return {
      action: "wait_human",
      level: "L3",
      gatePassed: true,
      ignoredSelfReportedPass: false,
      escalateToL2,
      ...(escalateReason !== undefined ? { escalateReason } : {}),
      effectiveTrack,
      reason: "max_tokens_exceeded",
      breaker,
    };
  }

  const nextStage = nextTaskStageAfter(card, currentStage, effectiveTrack);

  return {
    action: "advance_stage",
    level: "none",
    gatePassed: true,
    ignoredSelfReportedPass: false,
    escalateToL2,
    ...(escalateReason !== undefined ? { escalateReason } : {}),
    effectiveTrack,
    nextStage,
  };
}

export type ReviewerStageDecision =
  | {
      action: "advance_stage";
      level: "none";
      passed: true;
      forgedPassIgnored: false;
      nextStage: StageId | null;
    }
  | {
      action: "rework_implement";
      level: "L1";
      passed: false;
      forgedPassIgnored: boolean;
      targetStage: "implement";
      nextReviewRound: number;
      reason: string;
    }
  | {
      action: "retry_stage";
      level: "L0";
      stage: "review";
      passed: false;
      forgedPassIgnored: false;
      nextRetryCount: number;
      reason: string;
    }
  | {
      action: "invoke_triage";
      level: "L2";
      passed: boolean;
      forgedPassIgnored: boolean;
      reason: string;
      breaker: CircuitBreakerResult;
    }
  | {
      action: "wait_human";
      level: "L3";
      passed: boolean;
      forgedPassIgnored: boolean;
      reason: string;
      breaker: CircuitBreakerResult;
    };

export interface EvaluateReviewerStageOptions {
  triageAttempted?: boolean;
}

/**
 * Evaluates a `reviewer` stage outcome.
 * Hard invariant: even if `verdict === "pass"`, any `p0 > 0 || p1 > 0` blocks advancement
 * (`REVIEW.md §4`) and routes through L1 rework -> L2 `triage` -> L3 `waiting`.
 */
export function evaluateReviewerStageOutcome(
  card: TaskCard,
  receiptResult: ReviewerReceiptInput,
  counters: StageCounters,
  options?: EvaluateReviewerStageOptions,
): ReviewerStageDecision {
  const pipeline = getTaskPipelineStages(card, card.track);
  const reviewTrack: Track =
    card.track === "L1" && !pipeline.includes("review") ? "L2" : card.track;
  const breaker = checkCircuitBreaker(counters, card.limits);

  if (isValidationResult(receiptResult) && !receiptResult.ok) {
    const failureDecision = handleExecutionFailure({
      stage: "review",
      failure: { kind: "schema_invalid", errors: receiptResult.errors },
      counters,
      limits: card.limits,
      triageAttempted: options?.triageAttempted,
    });
    switch (failureDecision.action) {
      case "retry_stage":
        return {
          action: "retry_stage",
          level: "L0",
          stage: "review",
          passed: false,
          forgedPassIgnored: false,
          nextRetryCount: failureDecision.nextRetryCount,
          reason: failureDecision.reason,
        };
      case "invoke_triage":
        return {
          action: "invoke_triage",
          level: "L2",
          passed: false,
          forgedPassIgnored: false,
          reason: failureDecision.reason,
          breaker: failureDecision.breaker,
        };
      case "wait_human":
        return {
          action: "wait_human",
          level: "L3",
          passed: false,
          forgedPassIgnored: false,
          reason: failureDecision.reason,
          breaker: failureDecision.breaker,
        };
      case "cooldown_requeue":
        throw new Error("Unexpected cooldown_requeue for schema_invalid receipt");
    }
  }

  const receipt = isValidationResult(receiptResult)
    ? receiptResult.frontmatter
    : receiptResult;

  const hasBlockingIssues = receipt.p0 > 0 || receipt.p1 > 0;
  const forgedPassIgnored = receipt.verdict === "pass" && hasBlockingIssues;
  const effectivePassed = receipt.verdict === "pass" && !hasBlockingIssues;

  if (counters.totalTokens >= card.limits.max_tokens) {
    return {
      action: "wait_human",
      level: "L3",
      passed: effectivePassed,
      forgedPassIgnored,
      reason: "max_tokens_exceeded",
      breaker,
    };
  }

  if (effectivePassed) {
    return {
      action: "advance_stage",
      level: "none",
      passed: true,
      forgedPassIgnored: false,
      nextStage: nextTaskStageAfter(card, "review", reviewTrack),
    };
  }

  const reworkReason = forgedPassIgnored
    ? `reviewer_pass_rejected_due_to_blocking_issues (p0=${receipt.p0}, p1=${receipt.p1})`
    : "reviewer_changes_requested";

  const loopPolicy = getWorkflowLoopPolicy(card);
  const maxReworkRounds = loopPolicy
    ? Math.max(0, loopPolicy.maxRounds - 1)
    : card.limits.review_rounds;

  if (counters.reviewRounds < maxReworkRounds) {
    return {
      action: "rework_implement",
      level: "L1",
      passed: false,
      forgedPassIgnored,
      targetStage: "implement",
      nextReviewRound: counters.reviewRounds + 1,
      reason: reworkReason,
    };
  }

  if (!options?.triageAttempted) {
    return {
      action: "invoke_triage",
      level: "L2",
      passed: false,
      forgedPassIgnored,
      reason: "review_rounds_exceeded",
      breaker,
    };
  }

  return {
    action: "wait_human",
    level: "L3",
    passed: false,
    forgedPassIgnored,
    reason: "review_rounds_exceeded",
    breaker,
  };
}
