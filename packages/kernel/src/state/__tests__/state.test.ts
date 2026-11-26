import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TASK_STATUSES,
  buildCustomWorkflow,
  buildWorkflowPreset,
  parseAndValidateReceipt,
  type GateReport,
  type PendingDecision,
  type ReviewerReceiptFrontmatter,
  type RunMeta,
  type TaskCard,
  type TaskStatus,
  type WorkerReceiptFrontmatter,
} from "@kiln/protocol";
import { KilnStore, deriveTaskStatus } from "../../store/index.js";
import {
  DependencyCycleError,
  InvalidStateTransitionError,
  MissingDependencyError,
  TaskStateMachine,
  UnauthorizedAdvisorCallError,
  UnsupportedTrackError,
  assertCanInvokeAdvisor,
  assertValidTransition,
  canTransition,
  checkCircuitBreaker,
  computeEffectivePriorities,
  computeGateFailureFingerprint,
  computeReviewerFailureFingerprint,
  evaluateAdvisorAuthorityGuard,
  evaluateReviewerStageOutcome,
  evaluateWorkerStageOutcome,
  findQueuedDownstreamTasks,
  getTaskPipelineStages,
  getTrackStages,
  handleExecutionFailure,
  nextStageAfter,
  nextTaskStageAfter,
  resolveExternalSideEffectRetry,
  validateDependsOnGraph,
  type StageCounters,
} from "../index.js";

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kiln-state-test-"));
}

function makeTaskCard(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    schema_version: 1,
    id: "t-100",
    title: "状态机测试任务",
    space: "kiln",
    priority: "P2",
    track: "L2",
    workspace_mode: "git_worktree",
    parent: null,
    depends_on: [],
    contract_version: 1,
    contract: {
      goal: "实现状态机与三级升级链",
      end: "通过全部真实存储集成测试",
      accept_cmd: "pnpm --filter @kiln/kernel test",
      accept_files_hash: "sha256:frozen-v1",
      scope: ["packages/kernel/src/state/**"],
      deliver: { mode: "merge_main", cmd: null },
      human_accept: false,
      external_actions: "ask",
    },
    limits: {
      retries_per_stage: 2,
      review_rounds: 2,
      advisor_calls: 1,
      max_tokens: 250_000,
    },
    created_at: "2026-11-19T10:00:00.000Z",
    updated_at: "2026-11-19T10:00:00.000Z",
    ...overrides,
  };
}

function makeRunMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    schema_version: 1,
    run_id: "run-001",
    task_id: "t-100",
    stage: "implement",
    round: 1,
    role: "worker",
    contract_version: 1,
    backend_id: "fake",
    agent: "codex",
    model: "gpt-5.4",
    session_ref: {
      backendId: "fake",
      sessionId: "sess-001",
    },
    started_at: "2026-11-19T10:01:00.000Z",
    ...overrides,
  };
}

function makeGateReport(overrides: Partial<GateReport> = {}): GateReport {
  return {
    schema_version: 1,
    run_id: "run-001",
    contract_version: 1,
    schema_ok: true,
    scope_ok: true,
    artifacts_ok: true,
    out_of_scope_paths: [],
    frozen_files_changed: [],
    accept_exit_code: 0,
    accept_duration_ms: 420,
    escalated_to_l2: false,
    checked_at: "2026-11-19T10:05:00.000Z",
    ...overrides,
  };
}

function makeWorkerReceipt(
  overrides: Partial<WorkerReceiptFrontmatter> = {},
): WorkerReceiptFrontmatter {
  return {
    run_id: "run-001",
    contract_version: 1,
    outcome: "completed",
    input_ref: "main@abc",
    output_ref: "work@def",
    changed_paths: ["packages/kernel/src/state/dag.ts"],
    accept_result: "pass",
    is_bugfix: false,
    complexity_escalate: false,
    ...overrides,
  };
}

function makeReviewerReceipt(
  overrides: Partial<ReviewerReceiptFrontmatter> = {},
): ReviewerReceiptFrontmatter {
  return {
    run_id: "run-002",
    contract_version: 1,
    reviewed_ref: "work@def",
    verdict: "pass",
    p0: 0,
    p1: 0,
    p2: 0,
    ...overrides,
  };
}

function makeCounters(overrides: Partial<StageCounters> = {}): StageCounters {
  return {
    stageRetries: 0,
    reviewRounds: 0,
    advisorCalls: 0,
    totalTokens: 1_000,
    ...overrides,
  };
}

function makePendingDecision(overrides: Partial<PendingDecision> = {}): PendingDecision {
  return {
    id: "dec-001",
    task_id: "t-100",
    contract_version: 1,
    reason: "need_scope_clarification",
    category: "scope_ambiguity",
    question: "是否允许扩展修改范围并同步放行？",
    options: [
      {
        id: "opt-resume",
        label: "允许扩展范围并继续推进",
        action: "resume",
        target_stage: "implement",
        recommended: true,
      },
      {
        id: "opt-ledger",
        label: "确认规则并沉淀长期账本",
        action: "resume",
        target_stage: "implement",
        recommended: false,
        ledger_rule: "状态机模块改动必须同步跑通删库重建验证",
      },
      {
        id: "opt-external",
        label: "保持外部 PR 等待",
        action: "return_external",
        recommended: false,
      },
      {
        id: "opt-finish",
        label: "直接完成归档",
        action: "finish",
        recommended: false,
      },
      {
        id: "opt-cancel",
        label: "放弃任务并取消",
        action: "cancel",
        recommended: false,
      },
    ],
    created_at: "2026-11-19T10:10:00.000Z",
    ...overrides,
  };
}

function deleteSqliteFiles(kilnHome: string): void {
  const dbPath = path.join(kilnHome, "index.sqlite");
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

describe("DAG validation, effective priority inheritance, and queued downstream lookup", () => {
  it("rejects self-loop, 2-node cycle, 3-node cycle, and missing prerequisites", () => {
    const existing = new Map<string, readonly string[]>([
      ["t-a", []],
      ["t-b", ["t-a"]],
      ["t-c", ["t-b"]],
    ]);

    // Self-loop: A -> A
    expect(() => validateDependsOnGraph(existing, "t-a", ["t-a"])).toThrowError(
      DependencyCycleError,
    );
    try {
      validateDependsOnGraph(existing, "t-a", ["t-a"]);
    } catch (err) {
      expect(err).toBeInstanceOf(DependencyCycleError);
      expect((err as DependencyCycleError).cycle).toEqual(["t-a", "t-a"]);
    }

    // 2-node cycle: t-a -> t-b -> t-a
    try {
      validateDependsOnGraph(existing, "t-a", ["t-b"]);
      expect.unreachable("Expected 2-node cycle to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DependencyCycleError);
      expect((err as DependencyCycleError).cycle).toEqual(["t-a", "t-b", "t-a"]);
      expect((err as Error).message).toContain("t-a -> t-b -> t-a");
    }

    // 3-node cycle: t-a -> t-c -> t-b -> t-a
    try {
      validateDependsOnGraph(existing, "t-a", ["t-c"]);
      expect.unreachable("Expected 3-node cycle to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DependencyCycleError);
      expect((err as DependencyCycleError).cycle).toEqual(["t-a", "t-c", "t-b", "t-a"]);
      expect((err as Error).message).toContain("t-a -> t-c -> t-b -> t-a");
    }

    // Missing prerequisite
    expect(() => validateDependsOnGraph(existing, "t-d", ["t-missing"])).toThrowError(
      MissingDependencyError,
    );

    // Explicitly disabling existence check permits forward reference without cycle
    expect(() =>
      validateDependsOnGraph(existing, "t-d", ["t-missing"], {
        requireExistingDeps: false,
      }),
    ).not.toThrow();

    // Valid DAG edge
    expect(() => validateDependsOnGraph(existing, "t-d", ["t-c"])).not.toThrow();
  });

  it("propagates effective priorities across incomplete nodes and isolates terminal nodes", () => {
    const nodes = new Map([
      ["t-root", { priority: "P3" as const, status: "queued" as const, dependsOn: [] }],
      ["t-mid", { priority: "P2" as const, status: "waiting" as const, dependsOn: ["t-root"] }],
      ["t-leaf", { priority: "P0" as const, status: "running" as const, dependsOn: ["t-mid"] }],
      // Terminal done/cancelled nodes must neither receive nor propagate boosts
      ["t-done-parent", { priority: "P3" as const, status: "done" as const, dependsOn: [] }],
      [
        "t-blocked-by-done",
        {
          priority: "P0" as const,
          status: "queued" as const,
          dependsOn: ["t-done-parent"],
        },
      ],
      [
        "t-cancelled-mid",
        {
          priority: "P3" as const,
          status: "cancelled" as const,
          dependsOn: ["t-root-2"],
        },
      ],
      ["t-root-2", { priority: "P3" as const, status: "queued" as const, dependsOn: [] }],
      [
        "t-below-cancelled",
        {
          priority: "P0" as const,
          status: "queued" as const,
          dependsOn: ["t-cancelled-mid"],
        },
      ],
      [
        "t-done-child",
        {
          priority: "P0" as const,
          status: "done" as const,
          dependsOn: ["t-root-2"],
        },
      ],
    ]);

    const effective = computeEffectivePriorities(nodes);
    expect(effective.get("t-root")).toBe("P0");
    expect(effective.get("t-mid")).toBe("P0");
    expect(effective.get("t-leaf")).toBe("P0");

    // Done parent does NOT receive boost from P0 child
    expect(effective.get("t-done-parent")).toBe("P3");
    // Cancelled middle node neither receives nor passes boost to t-root-2
    expect(effective.get("t-cancelled-mid")).toBe("P3");
    // Done child does NOT propagate P0 to t-root-2
    expect(effective.get("t-done-child")).toBe("P0");
    expect(effective.get("t-root-2")).toBe("P3");
  });

  it("finds only directly queued downstream tasks in deterministic sorted order", () => {
    const nodes = new Map([
      ["t-z", { status: "queued" as const, dependsOn: ["t-up"] }],
      ["t-a", { status: "queued" as const, dependsOn: ["t-up"] }],
      ["t-waiting", { status: "waiting" as const, dependsOn: ["t-up"] }],
      ["t-paused", { status: "paused" as const, dependsOn: ["t-up"] }],
      ["t-indirect", { status: "queued" as const, dependsOn: ["t-a"] }],
    ]);

    expect(findQueuedDownstreamTasks(nodes, "t-up")).toEqual(["t-a", "t-z"]);
  });
});

describe("6+1 state transitions, track stages, and external side-effect idempotency", () => {
  it("enforces terminal states and paused isolation in transition table", () => {
    for (const target of TASK_STATUSES) {
      expect(canTransition("done", target)).toBe(false);
      expect(canTransition("cancelled", target)).toBe(false);
    }

    expect(canTransition("paused", "queued")).toBe(true);
    expect(canTransition("paused", "cancelled")).toBe(true);
    expect(canTransition("paused", "waiting")).toBe(false);
    expect(canTransition("paused", "running")).toBe(false);
    expect(canTransition("paused", "done")).toBe(false);
    expect(canTransition("paused", "external")).toBe(false);

    expect(() => assertValidTransition("paused", "waiting")).toThrowError(
      InvalidStateTransitionError,
    );
    expect(() => assertValidTransition("done", "queued")).toThrowError(InvalidStateTransitionError);
    expect(() => assertValidTransition("cancelled", "queued")).toThrowError(
      InvalidStateTransitionError,
    );

    const expectedPairs: Array<[TaskStatus, TaskStatus]> = [
      ["queued", "running"],
      ["queued", "paused"],
      ["queued", "waiting"],
      ["queued", "cancelled"],
      ["running", "queued"],
      ["running", "paused"],
      ["running", "waiting"],
      ["running", "external"],
      ["running", "done"],
      ["running", "cancelled"],
      ["waiting", "queued"],
      ["waiting", "external"],
      ["waiting", "done"],
      ["waiting", "cancelled"],
      ["external", "done"],
      ["external", "waiting"],
      ["external", "cancelled"],
    ];
    for (const [from, to] of expectedPairs) {
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it("resolves L1/L2 stage pipelines and throws UnsupportedTrackError for L3", () => {
    expect(getTrackStages("L1", false)).toEqual(["implement", "verify", "deliver"]);
    expect(getTrackStages("L1", true)).toEqual(["implement", "verify", "accept", "deliver"]);
    expect(getTrackStages("L2", false)).toEqual(["implement", "verify", "review", "deliver"]);
    expect(getTrackStages("L2", true)).toEqual([
      "implement",
      "verify",
      "review",
      "accept",
      "deliver",
    ]);

    expect(nextStageAfter("L1", "implement", false)).toBe("verify");
    expect(nextStageAfter("L1", "verify", false)).toBe("deliver");
    expect(nextStageAfter("L1", "verify", true)).toBe("accept");
    expect(nextStageAfter("L1", "accept", true)).toBe("deliver");
    expect(nextStageAfter("L1", "deliver", false)).toBeNull();
    expect(nextStageAfter("L2", "verify", false)).toBe("review");
    expect(nextStageAfter("L2", "review", true)).toBe("accept");

    expect(() => getTrackStages("L3", false)).toThrowError(UnsupportedTrackError);
    expect(() => nextStageAfter("L3", "implement", false)).toThrowError(UnsupportedTrackError);
    expect(() => nextStageAfter("L1", "review", false)).toThrow();
  });

  it("guards external side-effect retries against blind replay", () => {
    const skipped = resolveExternalSideEffectRetry({
      action: "open_pr",
      alreadyApplied: true,
      ref: "https://github.com/org/repo/pull/42",
    });
    expect(skipped).toEqual({
      shouldExecute: false,
      disposition: "skip_already_applied",
      action: "open_pr",
      ref: "https://github.com/org/repo/pull/42",
    });

    const execute = resolveExternalSideEffectRetry({
      action: "merge_main",
      alreadyApplied: false,
    });
    expect(execute).toEqual({
      shouldExecute: true,
      disposition: "execute_side_effect",
      action: "merge_main",
    });
  });
});

describe("Escalation chain, circuit breaker, advisor authorization, and gate verdicts", () => {
  it("trips circuit breaker when any limit reaches or exceeds threshold", () => {
    const limits = makeTaskCard().limits;
    expect(checkCircuitBreaker(makeCounters(), limits)).toEqual({
      tripped: false,
      reasons: [],
      details: [],
    });

    const tripped = checkCircuitBreaker(
      {
        stageRetries: 2,
        reviewRounds: 2,
        advisorCalls: 1,
        totalTokens: 250_000,
      },
      limits,
    );
    expect(tripped.tripped).toBe(true);
    expect(tripped.reasons).toEqual([
      "retries_per_stage_exceeded",
      "review_rounds_exceeded",
      "advisor_calls_exceeded",
      "max_tokens_exceeded",
    ]);
  });

  it("allows only kernel or triage to invoke advisor and blocks all other roles", () => {
    expect(() => assertCanInvokeAdvisor("kernel")).not.toThrow();
    expect(() => assertCanInvokeAdvisor("triage")).not.toThrow();

    const forbidden: Array<"worker" | "reviewer" | "verifier" | "intake" | "resolver" | "advisor"> =
      ["worker", "reviewer", "verifier", "intake", "resolver", "advisor"];
    for (const role of forbidden) {
      expect(() => assertCanInvokeAdvisor(role)).toThrowError(UnauthorizedAdvisorCallError);
    }
  });

  it("never counts rate limiting toward retries, failures, or circuit breaking", () => {
    const limits = makeTaskCard().limits;

    // Even when stageRetries & tokens look maxed or near limit, rate limit only queues cooldown.
    const rateLimited = handleExecutionFailure({
      stage: "implement",
      failure: { kind: "rate_limited", retryAfterMs: 15_000 },
      counters: makeCounters({ stageRetries: 2, totalTokens: 250_000 }),
      limits,
    });
    expect(rateLimited).toEqual({
      action: "cooldown_requeue",
      level: "none",
      retryAfterMs: 15_000,
      countAsFailure: false,
      incrementRetry: false,
      reason: "rate_limited",
    });

    // Normal failure escalates L0 -> L2 triage -> L3 waiting
    const l0 = handleExecutionFailure({
      stage: "implement",
      failure: { kind: "timeout" },
      counters: makeCounters({ stageRetries: 0 }),
      limits,
    });
    expect(l0.action).toBe("retry_stage");
    expect(l0.level).toBe("L0");
    expect(l0.incrementRetry).toBe(true);

    const l2 = handleExecutionFailure({
      stage: "implement",
      failure: { kind: "schema_invalid", errors: ["Missing section"] },
      counters: makeCounters({ stageRetries: 2 }),
      limits,
      triageAttempted: false,
    });
    expect(l2.action).toBe("invoke_triage");
    expect(l2.level).toBe("L2");

    const l3 = handleExecutionFailure({
      stage: "implement",
      failure: { kind: "runtime_error", message: "boom" },
      counters: makeCounters({ stageRetries: 2 }),
      limits,
      triageAttempted: true,
    });
    expect(l3.action).toBe("wait_human");
    expect(l3.level).toBe("L3");
  });

  it("rejects self-reported worker pass when gate fails and escalates L1 frozen test edits to L2", () => {
    const l1Card = makeTaskCard({ track: "L1" });

    // Worker claims accept_result: "pass", but kernel gate failed
    const failedGate = makeGateReport({ accept_exit_code: 1 });
    const rejectedPass = evaluateWorkerStageOutcome(
      l1Card,
      makeWorkerReceipt({ accept_result: "pass" }),
      failedGate,
      makeCounters({ stageRetries: 0 }),
    );
    expect(rejectedPass.action).toBe("retry_stage");
    expect(rejectedPass.gatePassed).toBe(false);
    expect(rejectedPass.ignoredSelfReportedPass).toBe(true);

    // Out of scope gate failure also overrides self-reported pass
    const outOfScope = evaluateWorkerStageOutcome(
      l1Card,
      makeWorkerReceipt({ accept_result: "pass" }),
      makeGateReport({ scope_ok: false, out_of_scope_paths: ["README.md"] }),
      makeCounters({ stageRetries: 2 }),
    );
    expect(outOfScope.action).toBe("invoke_triage");
    expect(outOfScope.gatePassed).toBe(false);
    expect(outOfScope.ignoredSelfReportedPass).toBe(true);

    // L1 modified frozen test files -> auto-escalates to L2 and adds review after verify
    const frozenEscalated = evaluateWorkerStageOutcome(
      l1Card,
      makeWorkerReceipt({ accept_result: "pass" }),
      makeGateReport({
        frozen_files_changed: ["packages/kernel/src/state/__tests__/state.test.ts"],
      }),
      makeCounters(),
      { currentStage: "verify" },
    );
    expect(frozenEscalated).toMatchObject({
      action: "advance_stage",
      gatePassed: true,
      escalateToL2: true,
      escalateReason: "frozen_files_changed",
      effectiveTrack: "L2",
      nextStage: "review",
    });

    // L1 complexity_escalate -> auto-escalates to L2
    const complexityEscalated = evaluateWorkerStageOutcome(
      l1Card,
      makeWorkerReceipt({ complexity_escalate: true }),
      makeGateReport(),
      makeCounters(),
      { currentStage: "implement" },
    );
    expect(complexityEscalated).toMatchObject({
      action: "advance_stage",
      escalateToL2: true,
      escalateReason: "complexity_escalate",
      effectiveTrack: "L2",
      nextStage: "verify",
    });

    // need_decision escalates
    const needDecision = evaluateWorkerStageOutcome(
      l1Card,
      makeWorkerReceipt({ outcome: "need_decision" }),
      makeGateReport(),
      makeCounters(),
    );
    expect(needDecision.action).toBe("invoke_triage");
    expect(needDecision.level).toBe("L2");

    // L1 clean pass advances without escalating
    const l1CleanImpl = evaluateWorkerStageOutcome(
      l1Card,
      makeWorkerReceipt({ accept_result: "pass" }),
      makeGateReport(),
      makeCounters(),
      { currentStage: "implement" },
    );
    expect(l1CleanImpl).toEqual({
      action: "advance_stage",
      level: "none",
      gatePassed: true,
      ignoredSelfReportedPass: false,
      escalateToL2: false,
      effectiveTrack: "L1",
      nextStage: "verify",
    });

    const l1CleanVerify = evaluateWorkerStageOutcome(
      l1Card,
      makeWorkerReceipt({ accept_result: "pass" }),
      makeGateReport(),
      makeCounters(),
      { currentStage: "verify" },
    );
    expect(l1CleanVerify).toEqual({
      action: "advance_stage",
      level: "none",
      gatePassed: true,
      ignoredSelfReportedPass: false,
      escalateToL2: false,
      effectiveTrack: "L1",
      nextStage: "deliver",
    });

    // Token soft cap trips circuit breaker directly to L3 waiting even if gate passed
    const tokenCapTripped = evaluateWorkerStageOutcome(
      l1Card,
      makeWorkerReceipt({ accept_result: "pass" }),
      makeGateReport(),
      makeCounters({ totalTokens: 250_000 }),
    );
    expect(tokenCapTripped.action).toBe("wait_human");
    expect(tokenCapTripped.level).toBe("L3");

    // Invalid parsed receipt markdown triggers L0 retry
    const invalidParsed = parseAndValidateReceipt("worker", "not frontmatter");
    const invalidOutcome = evaluateWorkerStageOutcome(
      l1Card,
      invalidParsed,
      makeGateReport({ schema_ok: false }),
      makeCounters(),
    );
    expect(invalidOutcome.action).toBe("retry_stage");
    expect(invalidOutcome.level).toBe("L0");
  });

  it("blocks reviewer pass if p0 > 0 or p1 > 0 and routes rework vs escalation", () => {
    const l2Card = makeTaskCard({ track: "L2" });

    // Forged pass: verdict="pass" but p1=1 -> rejected, rework implement (L1)
    const forgedPass = evaluateReviewerStageOutcome(
      l2Card,
      makeReviewerReceipt({ verdict: "pass", p0: 0, p1: 1, p2: 2 }),
      makeCounters({ reviewRounds: 0 }),
    );
    expect(forgedPass).toMatchObject({
      action: "rework_implement",
      level: "L1",
      passed: false,
      forgedPassIgnored: true,
      targetStage: "implement",
      nextReviewRound: 1,
    });

    // Forged pass with p0 > 0 when review_rounds exceeded -> escalates to L2 triage / L3 waiting
    const exceededTriage = evaluateReviewerStageOutcome(
      l2Card,
      makeReviewerReceipt({ verdict: "pass", p0: 1, p1: 0 }),
      makeCounters({ reviewRounds: 2 }),
    );
    expect(exceededTriage).toMatchObject({
      action: "invoke_triage",
      level: "L2",
      passed: false,
      forgedPassIgnored: true,
    });

    const exceededHuman = evaluateReviewerStageOutcome(
      l2Card,
      makeReviewerReceipt({ verdict: "changes_requested", p0: 0, p1: 1 }),
      makeCounters({ reviewRounds: 2 }),
      { triageAttempted: true },
    );
    expect(exceededHuman).toMatchObject({
      action: "wait_human",
      level: "L3",
      passed: false,
      forgedPassIgnored: false,
    });

    // Clean pass (p0=0, p1=0, p2=3) advances to deliver (or accept if human_accept=true)
    const cleanPass = evaluateReviewerStageOutcome(
      l2Card,
      makeReviewerReceipt({ verdict: "pass", p0: 0, p1: 0, p2: 3 }),
      makeCounters(),
    );
    expect(cleanPass).toEqual({
      action: "advance_stage",
      level: "none",
      passed: true,
      forgedPassIgnored: false,
      nextStage: "deliver",
    });

    const humanAcceptPass = evaluateReviewerStageOutcome(
      makeTaskCard({
        track: "L2",
        contract: { ...makeTaskCard().contract, human_accept: true },
      }),
      makeReviewerReceipt({ verdict: "pass", p0: 0, p1: 0 }),
      makeCounters(),
    );
    expect(humanAcceptPass).toEqual({
      action: "advance_stage",
      level: "none",
      passed: true,
      forgedPassIgnored: false,
      nextStage: "accept",
    });
  });
});

describe("TaskStateMachine integration with real KilnStore and SQLite disk rebuild", () => {
  let kilnHome: string;
  let store: KilnStore;
  let sm: TaskStateMachine;

  beforeEach(() => {
    kilnHome = makeTempHome();
    store = new KilnStore({ kilnHome });
    sm = new TaskStateMachine(store);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(kilnHome, { recursive: true, force: true });
  });

  it("rejects DAG cycles, unknown prerequisites, and L3 tasks on creation while syncing effective priorities across disk rebuild", () => {
    // Reject L3 Post-MVP task
    expect(() => sm.createTask(makeTaskCard({ id: "t-l3", track: "L3" }), "# L3")).toThrowError(
      UnsupportedTrackError,
    );

    // Reject self-loop on createTask
    expect(() =>
      sm.createTask(makeTaskCard({ id: "t-self", depends_on: ["t-self"] }), "# Self loop"),
    ).toThrowError(DependencyCycleError);

    // Reject missing dependency
    expect(() =>
      sm.createTask(makeTaskCard({ id: "t-bad", depends_on: ["t-nonexistent"] }), "# Bad"),
    ).toThrowError(MissingDependencyError);

    sm.createTask(makeTaskCard({ id: "t-1", priority: "P3" }), "# Task 1");
    sm.createTask(makeTaskCard({ id: "t-2", priority: "P2", depends_on: ["t-1"] }), "# Task 2");
    sm.createTask(makeTaskCard({ id: "t-3", priority: "P0", depends_on: ["t-2"] }), "# Task 3");

    expect(store.getTaskIndex("t-1")?.effective_priority).toBe("P0");
    expect(store.getTaskIndex("t-2")?.effective_priority).toBe("P0");
    expect(store.getTaskIndex("t-3")?.effective_priority).toBe("P0");

    // Change t-3 down to P2 -> t-1 & t-2 relax to P2
    sm.changePriority("t-3", "P2", "2026-11-19T10:05:00.000Z");
    expect(store.getTaskIndex("t-1")?.effective_priority).toBe("P2");
    expect(store.getTaskIndex("t-2")?.effective_priority).toBe("P2");
    expect(store.getTaskIndex("t-3")?.effective_priority).toBe("P2");

    // Change t-3 back to P1 -> t-1 & t-2 boost to P1
    sm.changePriority("t-3", "P1", "2026-11-19T10:06:00.000Z");
    const preRebuild = store.listTasks();

    store.close();
    deleteSqliteFiles(kilnHome);
    store = new KilnStore({ kilnHome });
    expect(store.listTasks()).toEqual(preRebuild);
  });

  it("isolates paused tasks from waiting, decisions.md, and ledger/, and preserves stage across resume and disk rebuild", () => {
    sm.createTask(makeTaskCard({ id: "t-pause", track: "L2" }), "# Pause test");
    const lease = store.persistRunBeforeDispatch(
      makeRunMeta({ task_id: "t-pause", run_id: "run-p1", stage: "review", round: 1 }),
      "001-review",
    );
    expect(lease).toEqual({ acquired: true });
    expect(store.listActiveStageLeases()).toHaveLength(1);

    const pausedState = sm.pauseTask("t-pause", "用户临时叫停检查", "2026-11-19T10:03:00.000Z");
    expect(pausedState.status).toBe("paused");
    expect(pausedState.stage).toBe("review");
    expect(store.listActiveStageLeases()).toHaveLength(0);
    expect(store.listTasks({ status: "waiting" })).toHaveLength(0);
    expect(fs.existsSync(store.paths.decisionsMd("t-pause"))).toBe(false);
    expect(fs.existsSync(store.paths.ledgerDir)).toBe(false);

    // Paused tasks cannot be moved into waiting
    expect(() =>
      sm.requestDecision(
        "t-pause",
        makePendingDecision({ task_id: "t-pause" }),
        "2026-11-19T10:04:00.000Z",
      ),
    ).toThrowError(InvalidStateTransitionError);

    // Rebuild SQLite while paused
    const pausedSnapshot = store.listTasks();
    store.close();
    deleteSqliteFiles(kilnHome);
    store = new KilnStore({ kilnHome });
    sm = new TaskStateMachine(store);
    expect(store.listTasks()).toEqual(pausedSnapshot);
    expect(store.listActiveStageLeases()).toHaveLength(0);
    expect(fs.existsSync(store.paths.decisionsMd("t-pause"))).toBe(false);

    // Resume returns to queued at preserved stage without touching decisions.md/ledger
    const resumedState = sm.resumeTask("t-pause", "2026-11-19T10:05:00.000Z");
    expect(resumedState.status).toBe("queued");
    expect(resumedState.stage).toBe("review");
    expect(fs.existsSync(store.paths.decisionsMd("t-pause"))).toBe(false);
    expect(fs.existsSync(store.paths.ledgerDir)).toBe(false);

    const resumedSnapshot = store.listTasks();
    store.close();
    deleteSqliteFiles(kilnHome);
    store = new KilnStore({ kilnHome });
    expect(store.listTasks()).toEqual(resumedSnapshot);
  });

  it("cascades upstream_cancelled to queued downstream tasks, supports unbinding, and matches disk rebuild", () => {
    sm.createTask(makeTaskCard({ id: "t-up", priority: "P3" }), "# Upstream");
    sm.createTask(
      makeTaskCard({ id: "t-down-q", priority: "P0", depends_on: ["t-up"] }),
      "# Direct queued downstream",
    );
    sm.createTask(
      makeTaskCard({ id: "t-leaf-q", priority: "P2", depends_on: ["t-down-q"] }),
      "# Indirect queued downstream",
    );
    sm.createTask(
      makeTaskCard({ id: "t-down-w", priority: "P1", depends_on: ["t-up"] }),
      "# Already waiting downstream",
    );
    sm.requestDecision(
      "t-down-w",
      makePendingDecision({ id: "dec-w", task_id: "t-down-w" }),
      "2026-11-19T10:02:00.000Z",
    );

    // Before cancellation, t-up inherited P0 from t-down-q
    expect(store.getTaskIndex("t-up")?.effective_priority).toBe("P0");

    // Cannot unbind before upstream is cancelled
    expect(() => sm.unbindCancelledDependency("t-down-q", "t-up")).toThrowError(
      /expected "cancelled"/,
    );

    // Cancel t-up -> t-down-q enters waiting(upstream_cancelled); t-leaf-q remains queued; t-up relaxes to P3
    const cancelRes = sm.cancelTask("t-up", "需求作废", "2026-11-19T10:05:00.000Z");
    expect(cancelRes.state.status).toBe("cancelled");
    expect(cancelRes.waitingDownstreamTaskIds).toEqual(["t-down-q"]);

    expect(store.getTaskIndex("t-up")?.effective_priority).toBe("P3");
    expect(store.getTaskIndex("t-down-q")?.status).toBe("waiting");
    expect(store.getTaskIndex("t-leaf-q")?.status).toBe("queued");
    expect(store.readStateEvents("t-down-q").at(-1)).toEqual({
      type: "waiting",
      at: "2026-11-19T10:05:00.000Z",
      reason: "upstream_cancelled",
    });

    // Unbind cancelled dependency and resume via decision
    const unbindRes = sm.unbindCancelledDependency("t-down-q", "t-up", "2026-11-19T10:06:00.000Z");
    expect(unbindRes.dependsOn).toEqual([]);
    expect(store.readTaskCard("t-down-q").depends_on).toEqual([]);

    sm.applyDecision({
      taskId: "t-down-q",
      decision: makePendingDecision({
        id: "dec-unbind",
        task_id: "t-down-q",
        reason: "upstream_cancelled",
      }),
      optionId: "opt-resume",
      rationale: "解绑已取消前置依赖并继续推进",
      now: "2026-11-19T10:07:00.000Z",
    });
    expect(store.getTaskIndex("t-down-q")?.status).toBe("queued");

    const snapshot = store.listTasks();
    store.close();
    deleteSqliteFiles(kilnHome);
    store = new KilnStore({ kilnHome });
    expect(store.listTasks()).toEqual(snapshot);
    expect(store.readTaskCard("t-down-q").depends_on).toEqual([]);
  });

  it("handles all 4 applyDecision actions, isolates ledger writes, bumps contractVersion with receipt archiving, and escalates L1 -> L2", () => {
    // 1. Task with single resume without ledger_rule -> NO ledger file created
    sm.createTask(makeTaskCard({ id: "t-dec", track: "L1" }), "# Decision test");
    store.persistRunBeforeDispatch(
      makeRunMeta({ task_id: "t-dec", run_id: "run-v1", stage: "implement" }),
      "001-implement",
    );
    const receiptV1 = store.submitReceipt({
      taskId: "t-dec",
      runId: "run-v1",
      contractVersion: 1,
      runDirName: "001-implement",
      markdown: "receipt v1 content",
      now: "2026-11-19T10:02:00.000Z",
    });
    expect(receiptV1.accepted).toBe(true);

    // Escalate L1 -> L2 atomically, and verify repeated call is idempotent
    const escalated = sm.escalateTrackToL2(
      "t-dec",
      "frozen_files_changed",
      "2026-11-19T10:03:00.000Z",
    );
    expect(escalated.track).toBe("L2");
    expect(store.readTaskCard("t-dec").track).toBe("L2");
    expect(store.getTaskIndex("t-dec")?.track).toBe("L2");

    const eventCountAfterEscalate = store.readStateEvents("t-dec").length;
    const escalatedAgain = sm.escalateTrackToL2("t-dec", "duplicate", "2026-11-19T10:03:10.000Z");
    expect(escalatedAgain.track).toBe("L2");
    expect(store.readStateEvents("t-dec")).toHaveLength(eventCountAfterEscalate);

    // Request decision -> apply resume WITHOUT ledger_rule
    const decision1 = makePendingDecision({ id: "dec-1", task_id: "t-dec" });
    sm.requestDecision("t-dec", decision1, "2026-11-19T10:04:00.000Z");

    // Mismatched decision_id fails without mutating state
    expect(() =>
      sm.applyDecision({
        taskId: "t-dec",
        decision: makePendingDecision({ id: "dec-wrong", task_id: "t-dec" }),
        optionId: "opt-resume",
      }),
    ).toThrowError(/waiting on decision "dec-1"/);

    // Unknown option fails without mutating state
    expect(() =>
      sm.applyDecision({
        taskId: "t-dec",
        decision: decision1,
        optionId: "opt-nonexistent",
      }),
    ).toThrowError(/does not exist/);

    const res1 = sm.applyDecision({
      taskId: "t-dec",
      decision: decision1,
      optionId: "opt-resume",
      now: "2026-11-19T10:05:00.000Z",
    });

    // Re-applying decision after task left waiting fails
    expect(() =>
      sm.applyDecision({
        taskId: "t-dec",
        decision: decision1,
        optionId: "opt-resume",
      }),
    ).toThrowError(InvalidStateTransitionError);
    expect(res1.state.status).toBe("queued");
    expect(res1.ledgerEntry).toBeUndefined();
    expect(store.readLedger("kiln")).toBeNull();
    expect(fs.existsSync(store.paths.ledgerFile("kiln"))).toBe(false);
    expect(fs.readFileSync(store.paths.decisionsMd("t-dec"), "utf8")).toContain("dec-1");

    // 2. Request second decision -> apply resume WITH ledger_rule AND contractUpdate
    const decision2 = makePendingDecision({ id: "dec-2", task_id: "t-dec" });
    sm.requestDecision("t-dec", decision2, "2026-11-19T10:06:00.000Z");

    const res2 = sm.applyDecision({
      taskId: "t-dec",
      decision: decision2,
      optionId: "opt-ledger",
      contractUpdate: {
        contractPatch: { accept_cmd: "pnpm --filter @kiln/kernel test -- --run" },
        affectedStages: ["implement", "verify"],
        acceptFilesHash: "sha256:frozen-v2",
      },
      now: "2026-11-19T10:07:00.000Z",
    });
    expect(res2.state.status).toBe("queued");
    expect(res2.contractVersion).toBe(2);
    expect(res2.archivedReceipts).toHaveLength(1);
    expect(fs.existsSync(store.paths.receiptMd("t-dec", "001-implement"))).toBe(false);
    expect(fs.existsSync(res2.archivedReceipts![0]!)).toBe(true);
    expect(res2.ledgerEntry?.rule).toBe("状态机模块改动必须同步跑通删库重建验证");

    const ledger = store.readLedger("kiln");
    expect(ledger?.entries).toHaveLength(1);
    expect(ledger?.entries[0]?.source_decision_id).toBe("dec-2");

    const decisionsContent = fs.readFileSync(store.paths.decisionsMd("t-dec"), "utf8");
    expect(decisionsContent).toContain("dec-1");
    expect(decisionsContent).toContain("dec-2");

    // 3. return_external -> then re-request decision -> finish
    const decision3 = makePendingDecision({
      id: "dec-3",
      task_id: "t-dec",
      contract_version: 2,
    });
    sm.requestDecision("t-dec", decision3, "2026-11-19T10:08:00.000Z");
    const res3 = sm.applyDecision({
      taskId: "t-dec",
      decision: decision3,
      optionId: "opt-external",
      now: "2026-11-19T10:09:00.000Z",
    });
    expect(res3.state.status).toBe("external");

    const decision4 = makePendingDecision({
      id: "dec-4",
      task_id: "t-dec",
      contract_version: 2,
    });
    sm.requestDecision("t-dec", decision4, "2026-11-19T10:10:00.000Z");
    const res4 = sm.applyDecision({
      taskId: "t-dec",
      decision: decision4,
      optionId: "opt-finish",
      now: "2026-11-19T10:11:00.000Z",
    });
    expect(res4.state.status).toBe("done");

    // 4. Cancel action inside applyDecision cascades upstream_cancelled to queued downstream
    sm.createTask(makeTaskCard({ id: "t-parent" }), "# Parent");
    sm.createTask(makeTaskCard({ id: "t-child", depends_on: ["t-parent"] }), "# Child");
    const cancelDecision = makePendingDecision({
      id: "dec-cancel",
      task_id: "t-parent",
    });
    sm.requestDecision("t-parent", cancelDecision, "2026-11-19T10:12:00.000Z");
    const resCancel = sm.applyDecision({
      taskId: "t-parent",
      decision: cancelDecision,
      optionId: "opt-cancel",
      now: "2026-11-19T10:13:00.000Z",
    });
    expect(resCancel.state.status).toBe("cancelled");
    expect(resCancel.waitingDownstreamTaskIds).toEqual(["t-child"]);
    expect(store.getTaskIndex("t-child")?.status).toBe("waiting");

    // Verify full disk rebuild matches SQLite state 100%
    const preRebuildTasks = store.listTasks();
    const preRebuildCard = store.readTaskCard("t-dec");
    const preRebuildLedger = store.readLedger("kiln");

    store.close();
    deleteSqliteFiles(kilnHome);
    store = new KilnStore({ kilnHome });

    expect(store.listTasks()).toEqual(preRebuildTasks);
    expect(store.readTaskCard("t-dec")).toEqual(preRebuildCard);
    expect(store.readLedger("kiln")).toEqual(preRebuildLedger);
    expect(store.getTaskIndex("t-dec")?.track).toBe("L2");
    expect(store.getTaskIndex("t-dec")?.contract_version).toBe(2);
    expect(store.getTaskIndex("t-dec")?.status).toBe("done");
    expect(store.getTaskIndex("t-parent")?.status).toBe("cancelled");
    expect(store.getTaskIndex("t-child")?.status).toBe("waiting");
  });

  it("projects target_stage on resume decision, requires new accept_files_hash when accept_cmd changes, and releases host_path_locks on terminal status", () => {
    sm.createTask(
      makeTaskCard({ id: "t-rollback-stage", workspace_mode: "host_scoped" }),
      "# Stage rollback & host lock release",
    );
    store.persistRunBeforeDispatch(
      makeRunMeta({
        task_id: "t-rollback-stage",
        run_id: "run-rev-1",
        stage: "review",
        round: 2,
      }),
      "001-review",
    );
    store.acquireHostPathLocks(
      "t-rollback-stage",
      ["/tmp/kiln-lock-test.conf"],
      "2026-11-19T10:02:00.000Z",
    );
    expect(store.listHostPathLocks("t-rollback-stage")).toHaveLength(1);

    const decision = makePendingDecision({
      id: "dec-rb",
      task_id: "t-rollback-stage",
      options: [
        {
          id: "opt-rb",
          label: "退回实施修改",
          action: "resume",
          target_stage: "implement",
          recommended: true,
        },
        {
          id: "opt-cancel",
          label: "取消任务",
          action: "cancel",
          recommended: false,
        },
      ],
    });
    sm.requestDecision("t-rollback-stage", decision, "2026-11-19T10:03:00.000Z");

    // Changing accept_cmd without updating accept_files_hash throws BEFORE touching card.yaml or decisions.md
    expect(() =>
      sm.applyDecision({
        taskId: "t-rollback-stage",
        decision,
        optionId: "opt-rb",
        contractUpdate: {
          contractPatch: { accept_cmd: "pnpm test --changed" },
          affectedStages: ["implement", "verify"],
        },
        now: "2026-11-19T10:04:00.000Z",
      }),
    ).toThrow(/accept_files_hash/i);
    expect(store.readTaskCard("t-rollback-stage").contract_version).toBe(1);
    expect(fs.existsSync(store.paths.decisionsMd("t-rollback-stage"))).toBe(false);

    // Empty rationale with contractUpdate fails DecisionRecordSchema BEFORE bumping contract_version
    expect(() =>
      sm.applyDecision({
        taskId: "t-rollback-stage",
        decision,
        optionId: "opt-rb",
        rationale: "",
        contractUpdate: {
          contractPatch: { accept_cmd: "pnpm test --changed" },
          affectedStages: ["implement", "verify"],
          acceptFilesHash: "sha256:frozen-changed",
        },
        now: "2026-11-19T10:04:30.000Z",
      }),
    ).toThrow();
    expect(store.readTaskCard("t-rollback-stage").contract_version).toBe(1);

    // Valid rollback decision with new acceptFilesHash projects stage="implement" and preserves rebuild parity
    const resumed = sm.applyDecision({
      taskId: "t-rollback-stage",
      decision,
      optionId: "opt-rb",
      contractUpdate: {
        contractPatch: { accept_cmd: "pnpm test --changed" },
        affectedStages: ["implement", "verify"],
        acceptFilesHash: "sha256:frozen-changed",
      },
      now: "2026-11-19T10:05:00.000Z",
    });
    expect(resumed.state.status).toBe("queued");
    expect(resumed.state.stage).toBe("implement");
    expect(resumed.state.round).toBeNull();

    // Rebuild while task is in queued (before cancelling) preserves derived.stage === "implement"
    store.close();
    deleteSqliteFiles(kilnHome);
    store = new KilnStore({ kilnHome });
    sm = new TaskStateMachine(store);
    const queuedAfterRebuild = deriveTaskStatus(
      store.readTaskCard("t-rollback-stage"),
      store.readStateEvents("t-rollback-stage"),
    );
    expect(queuedAfterRebuild.status).toBe("queued");
    expect(queuedAfterRebuild.stage).toBe("implement");

    // Terminal state via cancelTask releases host_path_locks immediately in live SQLite
    sm.cancelTask("t-rollback-stage", "abort", "2026-11-19T10:06:00.000Z");
    expect(store.listHostPathLocks("t-rollback-stage")).toEqual([]);

    // Rebuilding from disk reproduces zero locks on cancelled task
    store.close();
    deleteSqliteFiles(kilnHome);
    store = new KilnStore({ kilnHome });
    const rebuiltEvents = store.readStateEvents("t-rollback-stage");
    const lastDecided = rebuiltEvents.find((e) => e.type === "decided");
    expect(lastDecided?.type === "decided" ? lastDecided.target_stage : null).toBe("implement");
    expect(store.getTaskIndex("t-rollback-stage")?.status).toBe("cancelled");
    expect(store.listHostPathLocks("t-rollback-stage")).toEqual([]);
  });

  it("moves paused downstream to waiting(upstream_cancelled) on resumeTask and checks cancelled deps on createTask", () => {
    sm.createTask(makeTaskCard({ id: "t-up" }), "# Up");
    sm.createTask(makeTaskCard({ id: "t-down-p", depends_on: ["t-up"] }), "# Paused downstream");

    sm.pauseTask("t-down-p", "manual_pause", "2026-11-19T10:01:00.000Z");
    sm.cancelTask("t-up", "cancelled upstream", "2026-11-19T10:02:00.000Z");

    // While paused, downstream must remain paused with zero decisions.md / waiting entry
    expect(store.getTaskIndex("t-down-p")?.status).toBe("paused");
    expect(fs.existsSync(store.paths.decisionsMd("t-down-p"))).toBe(false);

    // Resuming after prerequisite cancelled immediately places downstream in waiting(upstream_cancelled)
    const resumedState = sm.resumeTask("t-down-p", "2026-11-19T10:03:00.000Z");
    expect(resumedState.status).toBe("waiting");
    expect(store.getTaskIndex("t-down-p")?.status).toBe("waiting");
    expect(store.readStateEvents("t-down-p").at(-1)).toMatchObject({
      type: "waiting",
      reason: "upstream_cancelled",
    });

    // New task bound to already-cancelled prerequisite starts in waiting(upstream_cancelled)
    const createdDepCancelled = sm.createTask(
      makeTaskCard({ id: "t-born-blocked", depends_on: ["t-up"] }),
      "# Created blocked",
    );
    expect(createdDepCancelled.state.status).toBe("waiting");
    expect(store.getTaskIndex("t-born-blocked")?.status).toBe("waiting");
    expect(store.readStateEvents("t-born-blocked").at(-1)).toMatchObject({
      type: "waiting",
      reason: "upstream_cancelled",
    });
  });

  it("handles updateContract across running, paused, waiting, and rejects terminal tasks", () => {
    // 1. running -> queued at earliest affected stage with lease expired & rebuild parity
    sm.createTask(makeTaskCard({ id: "t-uc-run" }), "# Running updateContract");
    store.persistRunBeforeDispatch(
      makeRunMeta({ task_id: "t-uc-run", run_id: "run-uc-1", stage: "review", round: 1 }),
      "001-review",
    );
    const runRes = sm.updateContract({
      taskId: "t-uc-run",
      contractPatch: { accept_cmd: "pnpm test --v2" },
      affectedStages: ["review", "implement"],
      acceptFilesHash: "sha256:uc-v2",
      now: "2026-11-19T11:00:00.000Z",
    });
    expect(runRes.newVersion).toBe(2);
    expect(runRes.state.status).toBe("queued");
    expect(runRes.state.stage).toBe("implement");
    expect(runRes.state.round).toBeNull();
    expect(store.getTaskIndex("t-uc-run")?.status).toBe("queued");
    expect(store.getStageLease("t-uc-run")?.state).toBe("expired");

    // 2. paused -> paused with rolled-back resume stage
    sm.createTask(makeTaskCard({ id: "t-uc-pause" }), "# Paused updateContract");
    store.persistRunBeforeDispatch(
      makeRunMeta({ task_id: "t-uc-pause", run_id: "run-uc-p1", stage: "verify", round: 1 }),
      "001-verify",
    );
    sm.pauseTask("t-uc-pause", "hold", "2026-11-19T11:01:00.000Z");
    const pauseRes = sm.updateContract({
      taskId: "t-uc-pause",
      contractPatch: { goal: "Updated goal" },
      affectedStages: ["implement", "verify"],
      now: "2026-11-19T11:02:00.000Z",
    });
    expect(pauseRes.state.status).toBe("paused");
    expect(pauseRes.state.stage).toBe("implement");
    const resumedAfterUpdate = sm.resumeTask("t-uc-pause", "2026-11-19T11:03:00.000Z");
    expect(resumedAfterUpdate.status).toBe("queued");
    expect(resumedAfterUpdate.stage).toBe("implement");

    // 3. waiting -> waiting with contract version bumped and stage updated
    sm.createTask(makeTaskCard({ id: "t-uc-wait" }), "# Waiting updateContract");
    sm.requestDecision(
      "t-uc-wait",
      makePendingDecision({ id: "dec-uc-w", task_id: "t-uc-wait" }),
      "2026-11-19T11:04:00.000Z",
    );
    const waitRes = sm.updateContract({
      taskId: "t-uc-wait",
      contractPatch: { goal: "Clarified goal" },
      affectedStages: ["implement"],
      now: "2026-11-19T11:05:00.000Z",
    });
    expect(waitRes.state.status).toBe("waiting");
    expect(waitRes.state.contractVersion).toBe(2);

    // 4. done & cancelled reject updateContract
    sm.createTask(makeTaskCard({ id: "t-uc-done" }), "# Done");
    store.appendStateEvent("t-uc-done", {
      type: "running",
      at: "2026-11-19T11:06:00.000Z",
      stage: "deliver",
      round: 1,
      run_id: "run-done-1",
    });
    store.appendStateEvent("t-uc-done", {
      type: "done",
      at: "2026-11-19T11:07:00.000Z",
    });
    expect(() =>
      sm.updateContract({
        taskId: "t-uc-done",
        contractPatch: { goal: "Illegal" },
        affectedStages: ["implement"],
      }),
    ).toThrow(/terminal task/i);

    sm.createTask(makeTaskCard({ id: "t-uc-cancel" }), "# Cancel");
    sm.cancelTask("t-uc-cancel");
    expect(() =>
      sm.updateContract({
        taskId: "t-uc-cancel",
        contractPatch: { goal: "Illegal" },
        affectedStages: ["implement"],
      }),
    ).toThrow(/terminal task/i);

    // Rebuild parity after updateContract
    store.close();
    deleteSqliteFiles(kilnHome);
    store = new KilnStore({ kilnHome });
    expect(store.getTaskIndex("t-uc-run")?.status).toBe("queued");
    expect(store.getTaskIndex("t-uc-run")?.contract_version).toBe(2);
    expect(store.getTaskIndex("t-uc-wait")?.status).toBe("waiting");
    expect(store.getTaskIndex("t-uc-wait")?.contract_version).toBe(2);
  });

  it("transitions normal waiting task to waiting(upstream_cancelled) on applyDecision(resume) when prerequisite was cancelled while waiting, and rejects empty contractUpdate.affectedStages", () => {
    sm.createTask(makeTaskCard({ id: "t-wait-up" }), "# Up");
    sm.createTask(
      makeTaskCard({ id: "t-wait-down", depends_on: ["t-wait-up"] }),
      "# Already waiting downstream",
    );

    const normalDec = makePendingDecision({
      id: "dec-normal-w",
      task_id: "t-wait-down",
      reason: "design_choice",
    });
    sm.requestDecision("t-wait-down", normalDec, "2026-11-19T12:00:00.000Z");

    // Upstream is cancelled while t-wait-down is waiting on normal decision
    sm.cancelTask("t-wait-up", "cancelled during wait", "2026-11-19T12:01:00.000Z");

    // Empty contractUpdate.affectedStages throws BEFORE bumping contract_version
    expect(() =>
      sm.applyDecision({
        taskId: "t-wait-down",
        decision: normalDec,
        optionId: "opt-resume",
        contractUpdate: {
          contractPatch: { goal: "Should fail" },
          affectedStages: [],
        },
        now: "2026-11-19T12:02:00.000Z",
      }),
    ).toThrow(/affectedStages/i);
    expect(store.readTaskCard("t-wait-down").contract_version).toBe(1);

    // Resolving normal decision with action="resume" must NOT leave task stuck in queued
    const firstResolve = sm.applyDecision({
      taskId: "t-wait-down",
      decision: normalDec,
      optionId: "opt-resume",
      rationale: "Design confirmed",
      now: "2026-11-19T12:03:00.000Z",
    });
    expect(firstResolve.state.status).toBe("waiting");
    expect(store.getTaskIndex("t-wait-down")?.status).toBe("waiting");
    expect(store.readStateEvents("t-wait-down").at(-1)).toMatchObject({
      type: "waiting",
      reason: "upstream_cancelled",
    });

    // Resolving with unbindCancelledDependencies=true atomically unbinds and enters queued
    const secondResolve = sm.applyDecision({
      taskId: "t-wait-down",
      decision: makePendingDecision({
        id: "dec-unbind-w",
        task_id: "t-wait-down",
        reason: "upstream_cancelled",
      }),
      optionId: "opt-resume",
      rationale: "Unbind cancelled t-wait-up",
      unbindCancelledDependencies: true,
      now: "2026-11-19T12:04:00.000Z",
    });
    expect(secondResolve.unboundDependencyIds).toEqual(["t-wait-up"]);
    expect(secondResolve.state.status).toBe("queued");
    expect(store.readTaskCard("t-wait-down").depends_on).toEqual([]);
  });

  it("supports resuming external tasks back to queued (with optional targetStage and upstream_cancelled check) and completing external tasks to done", () => {
    sm.createTask(makeTaskCard({ id: "t-ext-up" }), "# Up");
    sm.createTask(makeTaskCard({ id: "t-ext-resume", track: "L2" }), "# External resume");
    const dec = makePendingDecision({
      id: "dec-ext-1",
      task_id: "t-ext-resume",
    });
    sm.requestDecision("t-ext-resume", dec, "2026-11-22T01:00:00.000Z");
    const extState = sm.applyDecision({
      taskId: "t-ext-resume",
      decision: dec,
      optionId: "opt-external",
      now: "2026-11-22T01:01:00.000Z",
    });
    expect(extState.state.status).toBe("external");

    const resumed = sm.resumeTask("t-ext-resume", "2026-11-22T01:02:00.000Z", "review");
    expect(resumed.status).toBe("queued");
    expect(resumed.stage).toBe("review");

    // External task with cancelled prerequisite transitions to waiting(upstream_cancelled) on resume
    sm.createTask(
      makeTaskCard({ id: "t-ext-dep", depends_on: ["t-ext-up"] }),
      "# Dependent external",
    );
    const depDec = makePendingDecision({
      id: "dec-ext-dep",
      task_id: "t-ext-dep",
    });
    sm.requestDecision("t-ext-dep", depDec, "2026-11-22T01:03:00.000Z");
    sm.applyDecision({
      taskId: "t-ext-dep",
      decision: depDec,
      optionId: "opt-external",
      now: "2026-11-22T01:04:00.000Z",
    });
    sm.cancelTask("t-ext-up", "cancelled before resume", "2026-11-22T01:05:00.000Z");
    const resumedBlocked = sm.resumeTask("t-ext-dep", "2026-11-22T01:06:00.000Z");
    expect(resumedBlocked.status).toBe("waiting");
    expect(store.readStateEvents("t-ext-dep").at(-1)).toMatchObject({
      type: "waiting",
      reason: "upstream_cancelled",
    });

    // completeExternalTask moves external -> done and rejects non-external tasks
    sm.createTask(makeTaskCard({ id: "t-ext-done" }), "# Complete external");
    const doneDec = makePendingDecision({
      id: "dec-ext-done",
      task_id: "t-ext-done",
    });
    sm.requestDecision("t-ext-done", doneDec, "2026-11-22T01:07:00.000Z");
    sm.applyDecision({
      taskId: "t-ext-done",
      decision: doneDec,
      optionId: "opt-external",
      now: "2026-11-22T01:08:00.000Z",
    });

    const completed = sm.completeExternalTask(
      "t-ext-done",
      "pr#42-merged",
      "2026-11-22T01:09:00.000Z",
    );
    expect(completed.status).toBe("done");
    expect(store.readStateEvents("t-ext-done").at(-1)).toMatchObject({
      type: "done",
      deliver_ref: "pr#42-merged",
    });

    expect(() => sm.completeExternalTask("t-ext-resume")).toThrow(InvalidStateTransitionError);
  });

  it("drives task pipeline stages via composable workflow blueprints, honors loop max_rounds, and injects review on L1->L2 escalation", () => {
    const quickCard = makeTaskCard({
      id: "t-wf-quick",
      track: "L1",
      workflow: buildWorkflowPreset("quick"),
    });
    expect(getTaskPipelineStages(quickCard)).toEqual(["implement", "verify", "deliver"]);
    expect(nextTaskStageAfter(quickCard, "implement")).toBe("verify");
    expect(nextTaskStageAfter(quickCard, "verify")).toBe("deliver");

    const hostOpCard = makeTaskCard({
      id: "t-wf-host",
      track: "L1",
      workspace_mode: "host_scoped",
      workflow: buildWorkflowPreset("host_op", { hasDeliverCmd: true }),
    });
    expect(getTaskPipelineStages(hostOpCard)).toEqual(["implement", "verify", "deliver"]);

    const fullCard = makeTaskCard({
      id: "t-wf-full",
      track: "L2",
      workflow: buildWorkflowPreset("full_delivery"),
    });
    expect(getTaskPipelineStages(fullCard)).toEqual([
      "plan",
      "implement",
      "verify",
      "review",
      "accept",
      "deliver",
    ]);
    expect(nextTaskStageAfter(fullCard, "plan")).toBe("implement");
    expect(nextTaskStageAfter(fullCard, "review")).toBe("accept");

    // Loop policy max_rounds=4 permits 3 rework rounds even when limits.review_rounds=1
    const loopCard = makeTaskCard({
      id: "t-wf-loop",
      track: "L2",
      workflow: buildCustomWorkflow({
        preset: "custom",
        includePlan: false,
        includeReview: true,
        includeAccept: false,
        deliverApproval: false,
        hostTwoPhase: false,
        hasDeliverCmd: false,
        maxRounds: 4,
        stuckThreshold: 2,
      }),
      limits: { retries_per_stage: 2, review_rounds: 1, advisor_calls: 1, max_tokens: 100_000 },
    });
    const revRetry = evaluateReviewerStageOutcome(
      loopCard,
      {
        run_id: "run-rev-2",
        contract_version: 1,
        reviewed_ref: "HEAD",
        verdict: "changes_requested",
        p0: 0,
        p1: 1,
        p2: 0,
      },
      { stageRetries: 0, reviewRounds: 2, advisorCalls: 0, totalTokens: 500 },
    );
    expect(revRetry.action).toBe("rework_implement");

    const revEscalate = evaluateReviewerStageOutcome(
      loopCard,
      {
        run_id: "run-rev-4",
        contract_version: 1,
        reviewed_ref: "HEAD",
        verdict: "changes_requested",
        p0: 0,
        p1: 1,
        p2: 0,
      },
      { stageRetries: 0, reviewRounds: 3, advisorCalls: 0, totalTokens: 500 },
    );
    expect(revEscalate.action).toBe("invoke_triage");

    // Escalating a quick L1 blueprint card to L2 injects independent review into card.workflow
    sm.createTask(quickCard, "# Quick L1");
    sm.escalateTrackToL2("t-wf-quick", "frozen_files_changed");
    const escalatedCard = store.readTaskCard("t-wf-quick");
    expect(escalatedCard.track).toBe("L2");
    expect(getTaskPipelineStages(escalatedCard)).toEqual([
      "implement",
      "verify",
      "review",
      "deliver",
    ]);
  });

  it("enforces advisor authority guardrails, computes failure fingerprints, and short-circuits stuck loops", () => {
    expect(
      evaluateAdvisorAuthorityGuard({
        requires_contract_change: false,
        requires_scope_expansion: false,
        requires_human_approval: false,
      }),
    ).toEqual({ allowed: true });

    const blockedMutation = evaluateAdvisorAuthorityGuard(
      {
        requires_contract_change: false,
        requires_scope_expansion: false,
        requires_human_approval: false,
      },
      { workspaceMutated: true },
    );
    expect(blockedMutation.allowed).toBe(false);
    if (!blockedMutation.allowed) {
      expect(blockedMutation.reason).toBe("advisor_workspace_mutation");
    }

    const blockedContract = evaluateAdvisorAuthorityGuard({
      requires_contract_change: true,
      requires_scope_expansion: false,
      requires_human_approval: false,
    });
    expect(blockedContract.allowed).toBe(false);
    if (!blockedContract.allowed) {
      expect(blockedContract.reason).toBe("advisor_requires_contract_change");
    }

    const blockedScope = evaluateAdvisorAuthorityGuard({
      requires_contract_change: false,
      requires_scope_expansion: true,
      requires_human_approval: false,
    });
    expect(blockedScope.allowed).toBe(false);
    if (!blockedScope.allowed) {
      expect(blockedScope.reason).toBe("advisor_requires_scope_expansion");
    }

    const blockedHuman = evaluateAdvisorAuthorityGuard({
      requires_contract_change: false,
      requires_scope_expansion: false,
      requires_human_approval: true,
    });
    expect(blockedHuman.allowed).toBe(false);
    if (!blockedHuman.allowed) {
      expect(blockedHuman.reason).toBe("advisor_requires_human_approval");
    }

    expect(
      computeGateFailureFingerprint({
        schema_version: 1,
        run_id: "r1",
        contract_version: 1,
        schema_ok: true,
        scope_ok: true,
        artifacts_ok: true,
        out_of_scope_paths: [],
        frozen_files_changed: [],
        accept_exit_code: 0,
        accept_duration_ms: 10,
        escalated_to_l2: false,
        checked_at: "2026-11-22T08:00:00.000Z",
      }),
    ).toBeNull();

    const gateFp1 = computeGateFailureFingerprint({
      schema_version: 1,
      run_id: "r1",
      contract_version: 1,
      schema_ok: true,
      scope_ok: false,
      artifacts_ok: true,
      out_of_scope_paths: ["b.ts", "a.ts"],
      frozen_files_changed: [],
      accept_exit_code: 2,
      accept_duration_ms: 10,
      escalated_to_l2: false,
      checked_at: "2026-11-22T08:00:00.000Z",
    });
    expect(gateFp1).toBe("gate:scope:a.ts,b.ts|gate:accept:exit=2");

    const revFp = computeReviewerFailureFingerprint(
      {
        run_id: "rev-1",
        contract_version: 1,
        reviewed_ref: "HEAD",
        verdict: "changes_requested",
        p0: 1,
        p1: 1,
        p2: 2,
      },
      `## 结论\n未通过\n\n## 缺陷清单\n- [P1] \`src/b.ts:20\` — missing null check\n- [P0] \`src/a.ts:5\` — race condition\n- [P2] style note\n\n## 测试真实性与复现核查\n已测\n`,
    );
    expect(revFp).toBe("review:P0:src/a.ts:5|P1:src/b.ts:20");

    // Stuck threshold with card.workflow + advisorAvailable short-circuits retries
    const wfCard = makeTaskCard({
      id: "t-stuck",
      track: "L2",
      workflow: buildWorkflowPreset("standard_dev", { maxRounds: 3, stuckThreshold: 2 }),
      limits: { retries_per_stage: 3, review_rounds: 3, advisor_calls: 1, max_tokens: 100_000 },
    });
    const stuckWorkerAdvise = evaluateWorkerStageOutcome(
      wfCard,
      {
        run_id: "r-w2",
        contract_version: 1,
        outcome: "completed",
        input_ref: "HEAD",
        output_ref: "src/a.ts",
        changed_paths: ["src/a.ts"],
        accept_result: "fail",
        is_bugfix: false,
        complexity_escalate: false,
      },
      {
        schema_version: 1,
        run_id: "r-w2",
        contract_version: 1,
        schema_ok: true,
        scope_ok: true,
        artifacts_ok: true,
        out_of_scope_paths: [],
        frozen_files_changed: [],
        accept_exit_code: 2,
        accept_duration_ms: 10,
        escalated_to_l2: false,
        checked_at: "2026-11-22T08:00:00.000Z",
      },
      { stageRetries: 1, reviewRounds: 0, advisorCalls: 0, totalTokens: 500 },
      { consecutiveSameFailureCount: 2, advisorAvailable: true },
    );
    expect(stuckWorkerAdvise.action).toBe("invoke_advisor");

    // Exhausted advisor budget falls back to triage then human
    const stuckWorkerTriage = evaluateWorkerStageOutcome(
      wfCard,
      {
        run_id: "r-w3",
        contract_version: 1,
        outcome: "completed",
        input_ref: "HEAD",
        output_ref: "src/a.ts",
        changed_paths: ["src/a.ts"],
        accept_result: "fail",
        is_bugfix: false,
        complexity_escalate: false,
      },
      {
        schema_version: 1,
        run_id: "r-w3",
        contract_version: 1,
        schema_ok: true,
        scope_ok: true,
        artifacts_ok: true,
        out_of_scope_paths: [],
        frozen_files_changed: [],
        accept_exit_code: 2,
        accept_duration_ms: 10,
        escalated_to_l2: false,
        checked_at: "2026-11-22T08:00:00.000Z",
      },
      { stageRetries: 1, reviewRounds: 0, advisorCalls: 1, totalTokens: 500 },
      { consecutiveSameFailureCount: 2, advisorAvailable: true, triageAttempted: false },
    );
    expect(stuckWorkerTriage.action).toBe("invoke_triage");

    // Reviewer stuck threshold short-circuits review rework
    const stuckReviewAdvise = evaluateReviewerStageOutcome(
      wfCard,
      {
        run_id: "r-rev2",
        contract_version: 1,
        reviewed_ref: "HEAD",
        verdict: "changes_requested",
        p0: 1,
        p1: 0,
        p2: 0,
      },
      { stageRetries: 0, reviewRounds: 0, advisorCalls: 0, totalTokens: 500 },
      { consecutiveSameFailureCount: 2, advisorAvailable: true },
    );
    expect(stuckReviewAdvise.action).toBe("invoke_advisor");

    // Legacy card without card.workflow ignores consecutiveSameFailureCount
    const legacyCard = makeTaskCard({ id: "t-legacy-stuck", track: "L2" });
    const legacyRetry = evaluateWorkerStageOutcome(
      legacyCard,
      {
        run_id: "r-w2",
        contract_version: 1,
        outcome: "completed",
        input_ref: "HEAD",
        output_ref: "src/a.ts",
        changed_paths: ["src/a.ts"],
        accept_result: "fail",
        is_bugfix: false,
        complexity_escalate: false,
      },
      {
        schema_version: 1,
        run_id: "r-w2",
        contract_version: 1,
        schema_ok: true,
        scope_ok: true,
        artifacts_ok: true,
        out_of_scope_paths: [],
        frozen_files_changed: [],
        accept_exit_code: 2,
        accept_duration_ms: 10,
        escalated_to_l2: false,
        checked_at: "2026-11-22T08:00:00.000Z",
      },
      { stageRetries: 0, reviewRounds: 0, advisorCalls: 0, totalTokens: 500 },
      { consecutiveSameFailureCount: 5, advisorAvailable: true },
    );
    expect(legacyRetry.action).toBe("retry_stage");
  });

  it("extracts reviewer failure fingerprints from numbered P0/P1 findings and routes review_rounds_exceeded to advisor before triage/human", () => {
    const numberedFp1 = computeReviewerFailureFingerprint(
      {
        run_id: "r-rev-num1",
        contract_version: 2,
        reviewed_ref: "HEAD",
        verdict: "changes_requested",
        p0: 0,
        p1: 2,
        p2: 0,
      },
      [
        "## 结论",
        "退回",
        "",
        "## 缺陷清单",
        "1. P1 · OpenVPN Connect 的系统组件回执未纳入排除判断。",
        "2. P1 — `cleanup.sh:373` activity() 丢弃 team 与 app_groups。",
      ].join("\n"),
    );
    expect(numberedFp1).toBe(
      "review:P1:cleanup.sh:373|P1:openvpn connect 的系统组件回执未纳入排除判断",
    );

    const structuredFp = computeReviewerFailureFingerprint(
      {
        run_id: "r-rev-struct",
        contract_version: 2,
        reviewed_ref: "HEAD",
        verdict: "changes_requested",
        p0: 0,
        p1: 1,
        p2: 1,
        findings: [
          {
            severity: "P1",
            title: "OpenVPN 未排除",
            location: "staged/report.md:148",
          },
          {
            severity: "P2",
            title: "风格提示",
            location: "staged/report.md:10",
          },
        ],
      },
      "## 缺陷清单\n无",
    );
    expect(structuredFp).toBe("review:P1:staged/report.md:148");

    const wfCard = makeTaskCard({
      id: "t-rev-adv",
      track: "L2",
      limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
    });

    const routeToAdvisor = evaluateReviewerStageOutcome(
      wfCard,
      {
        run_id: "r-rev-exceeded",
        contract_version: 1,
        reviewed_ref: "HEAD",
        verdict: "changes_requested",
        p0: 0,
        p1: 1,
        p2: 0,
      },
      { stageRetries: 0, reviewRounds: 2, advisorCalls: 0, totalTokens: 10_000 },
      { consecutiveSameFailureCount: 1, advisorAvailable: true, triageAttempted: false },
    );
    expect(routeToAdvisor).toMatchObject({
      action: "invoke_advisor",
      level: "L2",
      reason: "review_rounds_exceeded",
    });

    const afterAdvisorExhausted = evaluateReviewerStageOutcome(
      wfCard,
      {
        run_id: "r-rev-exceeded-2",
        contract_version: 1,
        reviewed_ref: "HEAD",
        verdict: "changes_requested",
        p0: 0,
        p1: 1,
        p2: 0,
      },
      { stageRetries: 0, reviewRounds: 2, advisorCalls: 1, totalTokens: 20_000 },
      { consecutiveSameFailureCount: 1, advisorAvailable: true, triageAttempted: true },
    );
    expect(afterAdvisorExhausted).toMatchObject({
      action: "wait_human",
      level: "L3",
      reason: "review_rounds_exceeded",
    });
  });
});
