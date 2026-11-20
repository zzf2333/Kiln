import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BackendCapabilities,
  LimitsConfig,
  RolesConfig,
  RunMeta,
  TaskCard,
} from "@kiln/protocol";
import { IneligibleRoleAgentError } from "../../backend/index.js";
import { resolveCanonicalHostTarget } from "../../gate/index.js";
import { TaskStateMachine, handleExecutionFailure } from "../../state/index.js";
import { KilnStore } from "../../store/index.js";
import {
  CapabilityMismatchError,
  HeterogeneousReviewConflictError,
  KilnScheduler,
  RateLimitTracker,
  RoleNotConfiguredError,
  resolveRoleAssignment,
  scopesOverlap,
  type DispatchPlan,
  type RateLimitDeferredEvent,
  type WaitingAttentionBlockedEvent,
} from "../index.js";

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kiln-scheduler-test-"));
}

function makeTaskCard(overrides: Partial<TaskCard> = {}): TaskCard {
  const id = overrides.id ?? "t-1";
  return {
    schema_version: 1,
    id,
    title: `Task ${id}`,
    space: "kiln",
    priority: "P2",
    track: "L2",
    workspace_mode: "git_worktree",
    parent: null,
    depends_on: [],
    contract_version: 1,
    contract: {
      goal: `Goal for ${id}`,
      end: "Tests pass",
      accept_cmd: "pnpm test",
      accept_files_hash: "sha256:frozen",
      scope: [`packages/kernel/src/${id}/**`],
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

function makeRunMeta(
  plan: Pick<
    DispatchPlan,
    "taskId" | "stage" | "round" | "role" | "contractVersion"
  >,
  runId: string,
  startedAt = "2026-11-19T10:05:00.000Z",
): RunMeta {
  return {
    schema_version: 1,
    run_id: runId,
    task_id: plan.taskId,
    stage: plan.stage,
    round: plan.round,
    role: plan.role ?? "worker",
    contract_version: plan.contractVersion,
    backend_id: "fake",
    agent: "codex",
    model: "gpt-5.4",
    session_ref: {
      backendId: "fake",
      sessionId: `sess-${runId}`,
    },
    started_at: startedAt,
  };
}

function makeRolesConfig(overrides: Partial<RolesConfig> = {}): RolesConfig {
  return {
    schema_version: 1,
    heterogeneous_review: true,
    roles: {
      intake: {
        agent: "codex",
        model: "gpt-5.4",
        backend_id: "paseo",
        allow_full_access_fallback: false,
      },
      worker: {
        agent: "codex",
        model: "gpt-5.4",
        backend_id: "paseo",
        allow_full_access_fallback: false,
      },
      reviewer: {
        agent: "pi",
        model: "magpie/review",
        backend_id: "paseo",
        allow_full_access_fallback: false,
      },
      verifier: {
        agent: "codex",
        model: "gpt-5.4-mini",
        backend_id: "paseo",
        allow_full_access_fallback: false,
      },
      triage: {
        agent: "codex",
        model: "gpt-5.4",
        backend_id: "paseo",
        allow_full_access_fallback: false,
      },
      advisor: {
        agent: "codex",
        model: "gpt-5.4-pro",
        backend_id: "paseo",
        allow_full_access_fallback: false,
      },
      resolver: {
        agent: "codex",
        model: "gpt-5.4",
        backend_id: "paseo",
        allow_full_access_fallback: false,
      },
    },
    ...overrides,
  };
}

function makeLimitsConfig(overrides: Partial<LimitsConfig> = {}): LimitsConfig {
  return {
    schema_version: 1,
    max_concurrent_slots: 5,
    p0_extra_slot: true,
    max_waiting_wip: 5,
    retries_per_stage: 2,
    review_rounds: 2,
    advisor_calls: 1,
    max_card_tokens: 250_000,
    ...overrides,
  };
}

const CODEX_CAPS: BackendCapabilities = {
  interactiveChat: true,
  approvals: true,
  mcpInjection: true,
  usageCacheBreakdown: true,
  interrupt: true,
};

const PI_CAPS: BackendCapabilities = {
  interactiveChat: true,
  approvals: false,
  mcpInjection: false,
  usageCacheBreakdown: false,
  interrupt: true,
};

describe("scopesOverlap", () => {
  it("treats empty scopes and global wildcards as overlapping", () => {
    expect(scopesOverlap([], ["src/a.ts"])).toBe(true);
    expect(scopesOverlap(["src/a.ts"], [])).toBe(true);
    expect(scopesOverlap(["**"], ["src/a.ts"])).toBe(true);
    expect(scopesOverlap(["*"], ["src/a.ts"])).toBe(true);
    expect(scopesOverlap(["."], ["src/a.ts"])).toBe(true);
    expect(scopesOverlap(["./"], ["src/a.ts"])).toBe(true);
    expect(scopesOverlap(["./**"], ["src/a.ts"])).toBe(true);
    expect(scopesOverlap(["**/*"], ["src/a.ts"])).toBe(true);
  });

  it("detects overlapping paths, prefixes, and globs while allowing disjoint scopes", () => {
    expect(scopesOverlap(["src/a.ts"], ["src/a.ts"])).toBe(true);
    expect(scopesOverlap(["./src/a.ts"], ["src\\a.ts"])).toBe(true);
    expect(scopesOverlap(["src/a.ts"], ["src/b.ts"])).toBe(false);

    expect(
      scopesOverlap(["packages/kernel/src/state/**"], ["packages/kernel/src/gate/**"]),
    ).toBe(false);
    expect(
      scopesOverlap(["packages/kernel/**"], ["packages/kernel/src/store/**"]),
    ).toBe(true);
    expect(scopesOverlap(["packages/kernel/**"], ["packages/kernel/*.ts"])).toBe(true);
    expect(scopesOverlap(["packages/kernel/*.ts"], ["packages/kernel/index.ts"])).toBe(
      true,
    );
    expect(scopesOverlap(["packages/kernel/*.ts"], ["packages/kernel/index.js"])).toBe(
      false,
    );
    expect(scopesOverlap(["packages/kernel/*.ts"], ["packages/kernel/src/**"])).toBe(
      false,
    );
    expect(scopesOverlap(["packages/kernel"], ["packages/kernel/src/index.ts"])).toBe(
      true,
    );
    expect(scopesOverlap(["packages/kernel"], ["packages/kernel-extra/index.ts"])).toBe(
      false,
    );
    expect(scopesOverlap(["src/{a,b}.ts"], ["src/b.ts"])).toBe(true);
    expect(scopesOverlap(["src/{a,b}.ts"], ["src/c.ts"])).toBe(false);
    expect(scopesOverlap(["src/**/index.ts"], ["src/a/b/index.ts"])).toBe(true);
    expect(scopesOverlap(["src/**/index.ts"], ["src/**/other.ts"])).toBe(false);
    expect(scopesOverlap(["src/a/b/index.ts"], ["src/a/b/other.ts"])).toBe(false);
    expect(scopesOverlap(["apps/web.v2"], ["apps/web.v2/**"])).toBe(true);
    expect(scopesOverlap(["src/*.ts"], ["src/foo.*"])).toBe(true);
    expect(scopesOverlap(["src/*.ts"], ["src/*.md"])).toBe(false);
  });
});

describe("RateLimitTracker", () => {
  it("tracks cooldowns by (backendId, agent, model) with (agent, model) fallback matching", () => {
    const tracker = new RateLimitTracker();
    const t0 = 1_000_000;

    const deadline = tracker.markRateLimited(
      { backendId: "paseo", agent: "codex", model: "gpt-5.4" },
      5_000,
      t0,
    );
    expect(deadline).toBe(t0 + 5_000);

    expect(
      tracker.isCoolingDown({ backendId: "paseo", agent: "codex", model: "gpt-5.4" }, t0),
    ).toBe(true);
    expect(
      tracker.isCoolingDown(
        { backendId: "other", agent: "codex", model: "gpt-5.4" },
        t0,
      ),
    ).toBe(false);
    // Compatible query omitting backendId
    expect(tracker.isCoolingDown({ agent: "codex", model: "gpt-5.4" }, t0)).toBe(true);

    // Wildcard cooldown applies across backends for (agent, model)
    tracker.markRateLimited({ agent: "pi", model: "magpie/work" }, 3_000, t0);
    expect(
      tracker.isCoolingDown({ backendId: "paseo", agent: "pi", model: "magpie/work" }, t0),
    ).toBe(true);

    expect(tracker.nextCooldownExpiryMs(t0)).toBe(t0 + 3_000);
    expect(tracker.getCooldownUntil({ agent: "pi", model: "magpie/work" }, t0 + 3_000)).toBeNull();
    expect(tracker.isCoolingDown({ agent: "pi", model: "magpie/work" }, t0 + 3_000)).toBe(
      false,
    );
    expect(tracker.pruneExpired(t0 + 3_000)).toBe(1);
    expect(tracker.nextCooldownExpiryMs(t0 + 3_000)).toBe(t0 + 5_000);

    // Shorter cooldown never shrinks existing deadline
    const kept = tracker.markRateLimited(
      { backendId: "paseo", agent: "codex", model: "gpt-5.4" },
      500,
      t0 + 1_000,
    );
    expect(kept).toBe(t0 + 5_000);
  });
});

describe("resolveRoleAssignment", () => {
  it("switches reviewer to fallback when colliding with worker under heterogeneous_review", () => {
    const config = makeRolesConfig({
      heterogeneous_review: true,
      roles: {
        worker: {
          agent: "codex",
          model: "gpt-5.4",
          backend_id: "paseo",
          allow_full_access_fallback: false,
        },
        reviewer: {
          agent: "codex",
          model: "gpt-5.4",
          backend_id: "paseo",
          reasoning_effort: "high",
          fallback: {
            agent: "pi",
            model: "magpie/review",
            reasoning_effort: "medium",
          },
          allow_full_access_fallback: false,
        },
      },
    });

    const resolved = resolveRoleAssignment(config, "reviewer");
    expect(resolved).toEqual({
      role: "reviewer",
      backendId: "paseo",
      agent: "pi",
      model: "magpie/review",
      reasoningEffort: "medium",
      freshContext: true,
      allowFullAccessFallback: false,
      usedFallback: true,
    });

    // Respects explicit avoid_same_model_as pointing to a custom role
    const customAvoidConfig = makeRolesConfig({
      heterogeneous_review: true,
      roles: {
        worker: {
          agent: "pi",
          model: "magpie/work",
          allow_full_access_fallback: false,
        },
        triage: {
          agent: "codex",
          model: "gpt-5.4",
          allow_full_access_fallback: false,
        },
        reviewer: {
          agent: "codex",
          model: "gpt-5.4",
          avoid_same_model_as: "triage",
          fallback: { agent: "pi", model: "magpie/review" },
          allow_full_access_fallback: false,
        },
      },
    });
    const customResolved = resolveRoleAssignment(customAvoidConfig, "reviewer");
    expect(customResolved.agent).toBe("pi");
    expect(customResolved.model).toBe("magpie/review");
    expect(customResolved.usedFallback).toBe(true);
  });

  it("throws HeterogeneousReviewConflictError when collision has no non-colliding fallback", () => {
    const noFallbackConfig = makeRolesConfig({
      heterogeneous_review: true,
      roles: {
        worker: {
          agent: "codex",
          model: "gpt-5.4",
          allow_full_access_fallback: false,
        },
        reviewer: {
          agent: "codex",
          model: "gpt-5.4",
          allow_full_access_fallback: false,
        },
      },
    });
    expect(() => resolveRoleAssignment(noFallbackConfig, "reviewer")).toThrow(
      HeterogeneousReviewConflictError,
    );

    const sameFallbackConfig = makeRolesConfig({
      heterogeneous_review: true,
      roles: {
        worker: {
          agent: "codex",
          model: "gpt-5.4",
          allow_full_access_fallback: false,
        },
        reviewer: {
          agent: "codex",
          model: "gpt-5.4",
          fallback: {
            agent: "codex",
            model: "gpt-5.4",
          },
          allow_full_access_fallback: false,
        },
      },
    });
    expect(() => resolveRoleAssignment(sameFallbackConfig, "reviewer")).toThrow(
      HeterogeneousReviewConflictError,
    );

    // Allowed when heterogeneous_review is disabled
    const disabledConfig: RolesConfig = {
      ...noFallbackConfig,
      heterogeneous_review: false,
    };
    const sameModelAllowed = resolveRoleAssignment(disabledConfig, "reviewer");
    expect(sameModelAllowed.agent).toBe("codex");
    expect(sameModelAllowed.model).toBe("gpt-5.4");
    expect(sameModelAllowed.usedFallback).toBe(false);
    expect(sameModelAllowed.freshContext).toBe(true);
  });

  it("allows interactiveChat agents like pi for intake/resolver while rejecting non-interactive agents", () => {
    const config = makeRolesConfig({
      roles: {
        intake: {
          agent: "pi",
          model: "magpie/chat",
          allow_full_access_fallback: false,
        },
        resolver: {
          agent: "headless",
          model: "gpt-5.4",
          allow_full_access_fallback: false,
        },
      },
    });

    const capsMap = new Map<string, BackendCapabilities>([
      ["pi", PI_CAPS],
      [
        "headless",
        {
          interactiveChat: false,
          approvals: true,
          mcpInjection: true,
          usageCacheBreakdown: true,
          interrupt: true,
        },
      ],
      ["codex", CODEX_CAPS],
    ]);

    const piIntake = resolveRoleAssignment(config, "intake", { agentCapabilitiesMap: capsMap });
    expect(piIntake.agent).toBe("pi");
    const piSingle = resolveRoleAssignment(config, "intake", { capabilities: PI_CAPS });
    expect(piSingle.agent).toBe("pi");

    expect(() =>
      resolveRoleAssignment(config, "resolver", { agentCapabilitiesMap: capsMap }),
    ).toThrow(CapabilityMismatchError);
    expect(() =>
      resolveRoleAssignment(config, "resolver", { agentCapabilitiesMap: capsMap }),
    ).toThrow(IneligibleRoleAgentError);

    const validIntake = resolveRoleAssignment(makeRolesConfig(), "intake", {
      agentCapabilitiesMap: capsMap,
    });
    expect(validIntake.agent).toBe("codex");
    expect(validIntake.freshContext).toBe(true);
  });

  it("always sets freshContext: true for reviewer, verifier, advisor and passes allowFullAccessFallback", () => {
    const config = makeRolesConfig({
      roles: {
        worker: {
          agent: "pi",
          model: "magpie/work",
          allow_full_access_fallback: true,
        },
        reviewer: {
          agent: "codex",
          model: "gpt-5.4",
          allow_full_access_fallback: false,
        },
        verifier: {
          agent: "codex",
          model: "gpt-5.4-mini",
          allow_full_access_fallback: false,
        },
        advisor: {
          agent: "codex",
          model: "gpt-5.4-pro",
          allow_full_access_fallback: true,
        },
      },
    });

    expect(resolveRoleAssignment(config, "worker").freshContext).toBe(false);
    expect(resolveRoleAssignment(config, "worker").allowFullAccessFallback).toBe(true);
    expect(resolveRoleAssignment(config, "reviewer").freshContext).toBe(true);
    expect(resolveRoleAssignment(config, "verifier").freshContext).toBe(true);
    expect(resolveRoleAssignment(config, "advisor").freshContext).toBe(true);
    expect(resolveRoleAssignment(config, "advisor").allowFullAccessFallback).toBe(true);
    expect(() => resolveRoleAssignment(config, "triage")).toThrow(
      RoleNotConfiguredError,
    );
  });
});

describe("KilnScheduler", () => {
  let tempDirs: string[] = [];
  let store: KilnStore;
  let sm: TaskStateMachine;
  let activeScheduler: KilnScheduler | null = null;

  beforeEach(() => {
    const home = makeTempHome();
    tempDirs.push(home);
    store = new KilnStore({ kilnHome: home });
    sm = new TaskStateMachine(store);
    store.writeConfig("roles", makeRolesConfig());
    store.writeConfig("limits", makeLimitsConfig());
  });

  afterEach(() => {
    activeScheduler?.stop();
    activeScheduler = null;
    vi.useRealTimers();
    store.close();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it("sorts candidates by effective_priority, blocked incomplete downstream count, wait time, and id", async () => {
    // Dispatched one at a time via max_concurrent_slots = 1? Wait: if max_concurrent_slots = 10
    // and different spaces, tick() dispatches ALL in exact priority order!
    store.writeConfig("limits", makeLimitsConfig({ max_concurrent_slots: 10 }));

    // t-p3: lowest priority
    sm.createTask(
      makeTaskCard({
        id: "t-p3",
        space: "s-p3",
        priority: "P3",
        created_at: "2026-11-19T09:00:00.000Z",
        updated_at: "2026-11-19T09:00:00.000Z",
      }),
      "# P3",
    );

    // t-p2-blocks-2: P2, blocks two incomplete downstream tasks (t-down-1, t-down-2)
    sm.createTask(
      makeTaskCard({
        id: "t-p2-blocks-2",
        space: "s-b2",
        priority: "P2",
        created_at: "2026-11-19T09:30:00.000Z",
        updated_at: "2026-11-19T09:30:00.000Z",
      }),
      "# P2 blocks 2",
    );
    sm.createTask(
      makeTaskCard({
        id: "t-down-1",
        space: "s-d1",
        priority: "P2",
        depends_on: ["t-p2-blocks-2"],
      }),
      "# D1",
    );
    sm.createTask(
      makeTaskCard({
        id: "t-down-2",
        space: "s-d2",
        priority: "P2",
        depends_on: ["t-down-1"],
      }),
      "# D2",
    );

    // t-p2-earlier: P2, blocks 0, earlier wait time
    sm.createTask(
      makeTaskCard({
        id: "t-p2-earlier",
        space: "s-e",
        priority: "P2",
        created_at: "2026-11-19T09:10:00.000Z",
        updated_at: "2026-11-19T09:10:00.000Z",
      }),
      "# P2 earlier",
    );

    // t-p2-tie-b & t-p2-tie-a: exact same priority, blocked count (0), and wait time -> id asc
    sm.createTask(
      makeTaskCard({
        id: "t-p2-tie-b",
        space: "s-tb",
        priority: "P2",
        created_at: "2026-11-19T09:20:00.000Z",
        updated_at: "2026-11-19T09:20:00.000Z",
      }),
      "# P2 tie B",
    );
    sm.createTask(
      makeTaskCard({
        id: "t-p2-tie-a",
        space: "s-ta",
        priority: "P2",
        created_at: "2026-11-19T09:20:00.000Z",
        updated_at: "2026-11-19T09:20:00.000Z",
      }),
      "# P2 tie A",
    );

    // t-p1: P1
    sm.createTask(
      makeTaskCard({
        id: "t-p1",
        space: "s-p1",
        priority: "P1",
        created_at: "2026-11-19T09:50:00.000Z",
        updated_at: "2026-11-19T09:50:00.000Z",
      }),
      "# P1",
    );

    // t-p0-boosted: P3 boosted to P0 because t-p0-child depends on it
    sm.createTask(
      makeTaskCard({
        id: "t-p0-boosted",
        space: "s-boost",
        priority: "P3",
        created_at: "2026-11-19T09:59:00.000Z",
        updated_at: "2026-11-19T09:59:00.000Z",
      }),
      "# Boosted",
    );
    sm.createTask(
      makeTaskCard({
        id: "t-p0-child",
        space: "s-p0c",
        priority: "P0",
        depends_on: ["t-p0-boosted"],
      }),
      "# P0 child",
    );

    const order: string[] = [];
    const scheduler = new KilnScheduler({
      store,
      stateMachine: sm,
      onDispatch: (plan) => {
        order.push(plan.taskId);
      },
    });
    activeScheduler = scheduler;

    await scheduler.wake();
    expect(order).toEqual([
      "t-p0-boosted",
      "t-p1",
      "t-p2-blocks-2",
      "t-p2-earlier",
      "t-p2-tie-a",
      "t-p2-tie-b",
      "t-p3",
    ]);
  });

  it("blocks dependent tasks until upstream is done and never dispatches when upstream is cancelled", async () => {
    sm.createTask(makeTaskCard({ id: "t-up", space: "s1" }), "# Upstream");
    sm.createTask(
      makeTaskCard({ id: "t-down", space: "s2", depends_on: ["t-up"] }),
      "# Downstream",
    );
    sm.createTask(makeTaskCard({ id: "t-cancel-up", space: "s3" }), "# Cancel up");
    sm.createTask(
      makeTaskCard({
        id: "t-cancel-down",
        space: "s4",
        depends_on: ["t-cancel-up"],
      }),
      "# Cancel down",
    );
    sm.cancelTask("t-cancel-up", "no longer needed");

    let runSeq = 0;
    const dispatched: string[] = [];
    const scheduler = new KilnScheduler({
      store,
      stateMachine: sm,
      onDispatch: (plan) => {
        dispatched.push(plan.taskId);
        runSeq++;
        store.persistRunBeforeDispatch(
          makeRunMeta(plan, `run-${runSeq}`),
          `00${runSeq}-${plan.stage}`,
        );
      },
    });
    activeScheduler = scheduler;

    await scheduler.wake();
    expect(dispatched).toEqual(["t-up"]);

    // While t-up is running, t-down stays queued
    await scheduler.wake();
    expect(dispatched).toEqual(["t-up"]);

    // Mark t-up done -> wake() immediately dispatches t-down
    store.appendStateEvent("t-up", {
      type: "done",
      at: "2026-11-19T10:10:00.000Z",
      deliver_ref: "main@abc",
    });
    await scheduler.wake();
    expect(dispatched).toEqual(["t-up", "t-down"]);
    expect(dispatched).not.toContain("t-cancel-down");
  });

  it("enforces max_concurrent_slots and grants 1 extra slot to P0 when p0_extra_slot is enabled without preempting running tasks", async () => {
    store.writeConfig(
      "limits",
      makeLimitsConfig({ max_concurrent_slots: 2, p0_extra_slot: true }),
    );

    sm.createTask(makeTaskCard({ id: "t-run-1", space: "s1", priority: "P2" }), "# R1");
    sm.createTask(makeTaskCard({ id: "t-run-2", space: "s2", priority: "P2" }), "# R2");
    store.persistRunBeforeDispatch(
      makeRunMeta(
        {
          taskId: "t-run-1",
          stage: "implement",
          round: 1,
          role: "worker",
          contractVersion: 1,
        },
        "run-1",
      ),
      "001-implement",
    );
    store.persistRunBeforeDispatch(
      makeRunMeta(
        {
          taskId: "t-run-2",
          stage: "implement",
          round: 1,
          role: "worker",
          contractVersion: 1,
        },
        "run-2",
      ),
      "001-implement",
    );

    sm.createTask(makeTaskCard({ id: "t-p1", space: "s3", priority: "P1" }), "# P1");
    sm.createTask(makeTaskCard({ id: "t-p0-a", space: "s4", priority: "P0" }), "# P0-A");
    sm.createTask(makeTaskCard({ id: "t-p0-b", space: "s5", priority: "P0" }), "# P0-B");

    const dispatched: string[] = [];
    const scheduler = new KilnScheduler({
      store,
      stateMachine: sm,
      onDispatch: (plan) => {
        dispatched.push(plan.taskId);
        store.persistRunBeforeDispatch(
          makeRunMeta(plan, `run-${plan.taskId}`),
          "001-implement",
        );
      },
    });
    activeScheduler = scheduler;

    await scheduler.wake();
    // P0-A gets the single extra slot (slot 3); P0-B and P1 wait.
    expect(dispatched).toEqual(["t-p0-a"]);
    // Existing running P2 tasks are never killed or preempted.
    expect(store.getTaskIndex("t-run-1")?.status).toBe("running");
    expect(store.getTaskIndex("t-run-2")?.status).toBe("running");
    expect(store.listActiveStageLeases()).toHaveLength(3);
  });

  it("blocks P2/P3 when waiting >= max_waiting_wip while isolating paused tasks and allowing P0/P1", async () => {
    store.writeConfig(
      "limits",
      makeLimitsConfig({ max_concurrent_slots: 10, max_waiting_wip: 2 }),
    );

    // Create 4 paused tasks -> MUST NOT count toward waitingCount OR running slots!
    for (let i = 1; i <= 4; i++) {
      const id = `t-paused-${i}`;
      sm.createTask(makeTaskCard({ id, space: `sp-${i}`, priority: "P2" }), "# Paused");
      sm.pauseTask(id, "manual_pause");
    }

    // Create 1 waiting task (below max_waiting_wip = 2) -> P2 should STILL dispatch
    sm.createTask(makeTaskCard({ id: "t-wait-1", space: "sw1", priority: "P2" }), "# W1");
    store.appendStateEvent("t-wait-1", {
      type: "waiting",
      at: "2026-11-19T10:01:00.000Z",
      reason: "need_human",
    });
    sm.createTask(makeTaskCard({ id: "t-p2-ok", space: "sok", priority: "P2" }), "# P2 ok");

    const blockedEvents: WaitingAttentionBlockedEvent[] = [];
    const dispatched: string[] = [];
    const scheduler = new KilnScheduler({
      store,
      stateMachine: sm,
      onDispatch: (plan) => {
        dispatched.push(plan.taskId);
        store.persistRunBeforeDispatch(
          makeRunMeta(plan, `run-${plan.taskId}`),
          "001-implement",
        );
      },
      onWaitingAttentionBlocked: (ev) => {
        blockedEvents.push(ev);
      },
    });
    activeScheduler = scheduler;

    await scheduler.wake();
    expect(dispatched).toEqual(["t-p2-ok"]);
    expect(blockedEvents).toHaveLength(0);

    // Add 2nd waiting task -> waitingCount === 2 === max_waiting_wip
    sm.createTask(makeTaskCard({ id: "t-wait-2", space: "sw2", priority: "P2" }), "# W2");
    store.appendStateEvent("t-wait-2", {
      type: "waiting",
      at: "2026-11-19T10:02:00.000Z",
      reason: "need_human",
    });

    sm.createTask(
      makeTaskCard({ id: "t-p2-blocked", space: "sb2", priority: "P2" }),
      "# P2 blocked",
    );
    sm.createTask(
      makeTaskCard({ id: "t-p3-blocked", space: "sb3", priority: "P3" }),
      "# P3 blocked",
    );
    sm.createTask(
      makeTaskCard({ id: "t-p1-urgent", space: "su1", priority: "P1" }),
      "# P1 urgent",
    );
    sm.createTask(
      makeTaskCard({ id: "t-p0-urgent", space: "su0", priority: "P0" }),
      "# P0 urgent",
    );

    const tick2 = await scheduler.wake();
    expect(tick2.dispatched.map((p) => p.taskId)).toEqual(["t-p0-urgent", "t-p1-urgent"]);
    expect(tick2.blockedByAttentionGate.map((e) => e.taskId)).toEqual([
      "t-p2-blocked",
      "t-p3-blocked",
    ]);
    expect(blockedEvents.map((e) => e.waitingCount)).toEqual([2, 2]);
  });

  it("serializes overlapping git_worktree scopes in the same space while parallelizing disjoint scopes", async () => {
    store.writeConfig("limits", makeLimitsConfig({ max_concurrent_slots: 5 }));

    sm.createTask(
      makeTaskCard({
        id: "t-state",
        space: "kiln",
        priority: "P1",
        contract: {
          goal: "State work",
          end: "Done",
          accept_cmd: "pnpm test",
          accept_files_hash: "sha256:1",
          scope: ["packages/kernel/src/state/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      }),
      "# State",
    );
    sm.createTask(
      makeTaskCard({
        id: "t-state-conflict",
        space: "kiln",
        priority: "P2",
        contract: {
          goal: "State file work",
          end: "Done",
          accept_cmd: "pnpm test",
          accept_files_hash: "sha256:2",
          scope: ["packages/kernel/src/state/dag.ts"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      }),
      "# Conflict",
    );
    sm.createTask(
      makeTaskCard({
        id: "t-gate",
        space: "kiln",
        priority: "P2",
        contract: {
          goal: "Gate work",
          end: "Done",
          accept_cmd: "pnpm test",
          accept_files_hash: "sha256:3",
          scope: ["packages/kernel/src/gate/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      }),
      "# Gate",
    );

    const dispatched: string[] = [];
    const scheduler = new KilnScheduler({
      store,
      stateMachine: sm,
      onDispatch: (plan) => {
        dispatched.push(plan.taskId);
        store.persistRunBeforeDispatch(
          makeRunMeta(plan, `run-${plan.taskId}`),
          "001-implement",
        );
      },
    });
    activeScheduler = scheduler;

    await scheduler.wake();
    expect(dispatched).toEqual(["t-state", "t-gate"]);

    // Once t-state finishes, t-state-conflict dispatches on next wake()
    store.appendStateEvent("t-state", {
      type: "done",
      at: "2026-11-19T10:15:00.000Z",
    });
    await scheduler.wake();
    expect(dispatched).toEqual(["t-state", "t-gate", "t-state-conflict"]);
  });

  it("blocks conflicting host_scoped tasks via host_path_locks and pre-dispatch planned paths", async () => {
    const hostDir = makeTempHome();
    tempDirs.push(hostDir);
    const fileA = path.join(hostDir, "a.conf");
    const fileB = path.join(hostDir, "b.conf");
    fs.writeFileSync(fileA, "a=1\n");
    fs.writeFileSync(fileB, "b=1\n");
    const canonicalFileA = resolveCanonicalHostTarget(fileA);

    // Task 1 already holds a SQLite host_path_lock (even while in waiting approval state)
    sm.createTask(
      makeTaskCard({
        id: "t-host-holder",
        space: "local",
        workspace_mode: "host_scoped",
        contract: {
          goal: "Modify a.conf",
          end: "Done",
          accept_cmd: "true",
          accept_files_hash: "sha256:h1",
          scope: [fileA],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      }),
      "# Host holder",
    );
    store.acquireHostPathLocks("t-host-holder", [canonicalFileA]);
    store.appendStateEvent("t-host-holder", {
      type: "waiting",
      at: "2026-11-19T10:01:00.000Z",
      reason: "host_scoped_approval",
    });

    // Task 2 conflicts with fileA -> blocked
    sm.createTask(
      makeTaskCard({
        id: "t-host-conflict",
        space: "local",
        workspace_mode: "host_scoped",
        contract: {
          goal: "Also modify a.conf",
          end: "Done",
          accept_cmd: "true",
          accept_files_hash: "sha256:h2",
          scope: [fileA],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      }),
      "# Host conflict",
    );

    // Task 3 & Task 4 both target fileB (not yet in SQLite) -> Task 3 runs, Task 4 waits in same tick!
    sm.createTask(
      makeTaskCard({
        id: "t-host-b1",
        space: "local",
        priority: "P1",
        workspace_mode: "host_scoped",
        contract: {
          goal: "Modify b.conf",
          end: "Done",
          accept_cmd: "true",
          accept_files_hash: "sha256:h3",
          scope: [fileB],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      }),
      "# Host B1",
    );
    sm.createTask(
      makeTaskCard({
        id: "t-host-b2",
        space: "local",
        priority: "P2",
        workspace_mode: "host_scoped",
        contract: {
          goal: "Also modify b.conf",
          end: "Done",
          accept_cmd: "true",
          accept_files_hash: "sha256:h4",
          scope: [fileB],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      }),
      "# Host B2",
    );

    const dispatched: string[] = [];
    const scheduler = new KilnScheduler({
      store,
      stateMachine: sm,
      onDispatch: (plan) => {
        dispatched.push(plan.taskId);
        store.persistRunBeforeDispatch(
          makeRunMeta(plan, `run-${plan.taskId}`),
          "001-implement",
        );
      },
    });
    activeScheduler = scheduler;

    await scheduler.wake();
    expect(dispatched).toEqual(["t-host-b1"]);

    // Once t-host-holder becomes done (which releases host_path_locks), t-host-conflict can dispatch
    store.appendStateEvent("t-host-holder", {
      type: "done",
      at: "2026-11-19T10:10:00.000Z",
    });
    await scheduler.wake();
    expect(dispatched).toEqual(["t-host-b1", "t-host-conflict"]);
  });

  it("defers rate-limited roles without incrementing failures/retries and auto-wakes on single cooldown timer", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-11-19T12:00:00.000Z").getTime();
    vi.setSystemTime(t0);

    // Align with state/escalation.ts: rate_limited does NOT count as failure or retry.
    const escalationDecision = handleExecutionFailure({
      stage: "implement",
      failure: { kind: "rate_limited", retryAfterMs: 5_000 },
      counters: {
        stageRetries: 2,
        reviewRounds: 0,
        advisorCalls: 0,
        totalTokens: 1_000,
      },
      limits: {
        retries_per_stage: 2,
        review_rounds: 2,
        advisor_calls: 1,
        max_tokens: 250_000,
      },
    });
    expect(escalationDecision.countAsFailure).toBe(false);
    expect(escalationDecision.incrementRetry).toBe(false);

    // t-worker uses codex/gpt-5.4 (rate-limited); t-review uses pi/magpie/review (healthy)
    sm.createTask(
      makeTaskCard({ id: "t-worker", space: "s1", priority: "P1" }),
      "# Worker",
    );
    sm.createTask(
      makeTaskCard({ id: "t-review", space: "s2", priority: "P2" }),
      "# Review",
    );
    store.appendStateEvent("t-review", {
      type: "resumed",
      at: "2026-11-19T11:59:00.000Z",
      stage: "review",
    });

    const deferred: RateLimitDeferredEvent[] = [];
    const dispatched: string[] = [];
    const scheduler = new KilnScheduler({
      store,
      stateMachine: sm,
      onDispatch: (plan) => {
        dispatched.push(plan.taskId);
        store.persistRunBeforeDispatch(
          makeRunMeta(plan, `run-${plan.taskId}`),
          `001-${plan.stage}`,
        );
      },
      onRateLimitDeferred: (ev) => {
        deferred.push(ev);
      },
    });
    activeScheduler = scheduler;

    scheduler.markRateLimited(
      { backendId: "paseo", agent: "codex", model: "gpt-5.4" },
      5_000,
    );

    const tick1 = await scheduler.wake();
    expect(dispatched).toEqual(["t-review"]);
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.taskId).toBe("t-worker");
    expect(tick1.nextCooldownWakeAtMs).toBe(t0 + 5_000);

    // Before 5000ms elapses, still deferred
    await vi.advanceTimersByTimeAsync(4_999);
    expect(dispatched).toEqual(["t-review"]);

    // At 5000ms, single timer fires wake() automatically and dispatches t-worker!
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatched).toEqual(["t-review", "t-worker"]);
  });

  it("clears cooldown timer on stop() and coalesces concurrent/re-entrant wake() calls safely", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-11-19T12:00:00.000Z").getTime();
    vi.setSystemTime(t0);

    sm.createTask(makeTaskCard({ id: "t-1", space: "s1" }), "# T1");

    const dispatched: string[] = [];
    let triggeredReentrantWake = false;
    const scheduler = new KilnScheduler({
      store,
      stateMachine: sm,
      onDispatch: async (plan) => {
        await Promise.resolve();
        dispatched.push(plan.taskId);
        store.persistRunBeforeDispatch(
          makeRunMeta(plan, `run-${plan.taskId}`),
          "001-implement",
        );
        if (!triggeredReentrantWake) {
          triggeredReentrantWake = true;
          sm.createTask(makeTaskCard({ id: "t-2", space: "s2" }), "# T2");
          void scheduler.wake();
        }
      },
    });
    activeScheduler = scheduler;

    // Concurrent wake() calls coalesce and drain t-1 + newly created t-2 without double dispatch
    await Promise.all([scheduler.wake(), scheduler.wake()]);
    expect(dispatched).toEqual(["t-1", "t-2"]);

    // Cooldown timer scheduled then cancelled via stop() must not fire
    sm.createTask(makeTaskCard({ id: "t-3", space: "s3" }), "# T3");
    scheduler.markRateLimited(
      { backendId: "paseo", agent: "codex", model: "gpt-5.4" },
      1_000,
    );
    await scheduler.wake();
    expect(dispatched).toEqual(["t-1", "t-2"]);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dispatched).toEqual(["t-1", "t-2"]);
  });

  it("isolates leaf running slot count from parent container cards", async () => {
    store.writeConfig("limits", makeLimitsConfig({ max_concurrent_slots: 2 }));

    sm.createTask(makeTaskCard({ id: "t-epic", space: "s1" }), "# Epic");
    store.appendStateEvent("t-epic", {
      type: "running",
      at: "2026-11-19T10:00:00.000Z",
      stage: "implement",
      round: 1,
      run_id: "run-epic",
    });
    sm.createTask(
      makeTaskCard({ id: "t-child-1", space: "s2", parent: "t-epic" }),
      "# Child 1",
    );
    store.persistRunBeforeDispatch(
      makeRunMeta(
        {
          taskId: "t-child-1",
          stage: "implement",
          round: 1,
          role: "worker",
          contractVersion: 1,
        },
        "run-c1",
      ),
      "001-implement",
    );

    sm.createTask(
      makeTaskCard({ id: "t-child-2", space: "s3", parent: "t-epic" }),
      "# Child 2",
    );

    const dispatched: string[] = [];
    const scheduler = new KilnScheduler({
      store,
      stateMachine: sm,
      onDispatch: (plan) => {
        dispatched.push(plan.taskId);
      },
    });
    activeScheduler = scheduler;

    // t-epic has child t-child-1, so only t-child-1 (1 leaf) occupies a slot -> t-child-2 gets slot 2!
    await scheduler.wake();
    expect(dispatched).toEqual(["t-child-2"]);
  });

  it("allows overlapping git_worktree scopes across distinct spaces and enforces p0_extra_slot: false", async () => {
    store.writeConfig(
      "limits",
      makeLimitsConfig({ max_concurrent_slots: 2, p0_extra_slot: false }),
    );

    sm.createTask(
      makeTaskCard({
        id: "t-space-a",
        space: "repo-a",
        priority: "P2",
        contract: {
          goal: "A",
          end: "Done",
          accept_cmd: "pnpm test",
          accept_files_hash: "sha256:a",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      }),
      "# A",
    );
    sm.createTask(
      makeTaskCard({
        id: "t-space-b",
        space: "repo-b",
        priority: "P2",
        contract: {
          goal: "B",
          end: "Done",
          accept_cmd: "pnpm test",
          accept_files_hash: "sha256:b",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      }),
      "# B",
    );
    sm.createTask(
      makeTaskCard({ id: "t-p0-no-extra", space: "repo-c", priority: "P0" }),
      "# P0 blocked",
    );

    const dispatched: string[] = [];
    const scheduler = new KilnScheduler({
      store,
      stateMachine: sm,
      onDispatch: (plan) => {
        dispatched.push(plan.taskId);
        store.persistRunBeforeDispatch(
          makeRunMeta(plan, `run-${plan.taskId}`),
          "001-implement",
        );
      },
    });
    activeScheduler = scheduler;

    // t-p0-no-extra goes first (slot 1), then t-space-a (slot 2), while t-space-b waits due to p0_extra_slot: false
    await scheduler.wake();
    expect(dispatched).toEqual(["t-p0-no-extra", "t-space-a"]);

    // Free t-p0-no-extra -> t-space-b dispatches even though its scope "src/**" matches t-space-a in another space
    store.appendStateEvent("t-p0-no-extra", {
      type: "done",
      at: "2026-11-19T10:20:00.000Z",
    });
    await scheduler.wake();
    expect(dispatched).toEqual(["t-p0-no-extra", "t-space-a", "t-space-b"]);
  });

  it("detects host_scoped conflicts through symlinked paths and hot-reloads roles.yaml on next wake()", async () => {
    const hostDir = makeTempHome();
    tempDirs.push(hostDir);
    const realFile = path.join(hostDir, "real.conf");
    const linkDir = path.join(hostDir, "link-dir");
    fs.writeFileSync(realFile, "x=1\n");
    fs.mkdirSync(linkDir);
    const linkFile = path.join(linkDir, "alias.conf");
    fs.symlinkSync(realFile, linkFile);

    sm.createTask(
      makeTaskCard({
        id: "t-real",
        space: "local",
        priority: "P1",
        workspace_mode: "host_scoped",
        contract: {
          goal: "Write real.conf",
          end: "Done",
          accept_cmd: "true",
          accept_files_hash: "sha256:r1",
          scope: [realFile],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      }),
      "# Real",
    );
    sm.createTask(
      makeTaskCard({
        id: "t-alias",
        space: "local",
        priority: "P2",
        workspace_mode: "host_scoped",
        contract: {
          goal: "Write via symlink",
          end: "Done",
          accept_cmd: "true",
          accept_files_hash: "sha256:r2",
          scope: [linkFile],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      }),
      "# Alias",
    );

    const dispatched: DispatchPlan[] = [];
    const scheduler = new KilnScheduler({
      store,
      stateMachine: sm,
      onDispatch: (plan) => {
        dispatched.push(plan);
        store.persistRunBeforeDispatch(
          makeRunMeta(plan, `run-${plan.taskId}`),
          "001-implement",
        );
      },
    });
    activeScheduler = scheduler;

    await scheduler.wake();
    expect(dispatched.map((p) => p.taskId)).toEqual(["t-real"]);
    expect(dispatched[0]?.roleAssignment?.model).toBe("gpt-5.4");

    // Hot-swap roles.yaml model and finish t-real -> t-alias picks up new model immediately
    store.writeConfig(
      "roles",
      makeRolesConfig({
        roles: {
          ...makeRolesConfig().roles,
          worker: {
            agent: "codex",
            model: "gpt-5.4-mini",
            backend_id: "paseo",
            allow_full_access_fallback: false,
          },
        },
      }),
    );
    store.appendStateEvent("t-real", {
      type: "done",
      at: "2026-11-19T10:30:00.000Z",
    });

    await scheduler.wake();
    expect(dispatched.map((p) => p.taskId)).toEqual(["t-real", "t-alias"]);
    expect(dispatched[1]?.roleAssignment?.model).toBe("gpt-5.4-mini");
  });

  it("replaces later rate-limit timer when an earlier cooldown is registered and isolates per-task role errors", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-11-19T12:00:00.000Z").getTime();
    vi.setSystemTime(t0);

    // Reviewer collides with worker and has NO fallback -> review task fails resolution while worker task still runs
    store.writeConfig(
      "roles",
      makeRolesConfig({
        heterogeneous_review: true,
        roles: {
          worker: {
            agent: "codex",
            model: "gpt-5.4",
            backend_id: "paseo",
            allow_full_access_fallback: false,
          },
          reviewer: {
            agent: "codex",
            model: "gpt-5.4",
            backend_id: "paseo",
            allow_full_access_fallback: false,
          },
          triage: {
            agent: "pi",
            model: "magpie/triage",
            backend_id: "paseo",
            allow_full_access_fallback: false,
          },
        },
      }),
    );

    sm.createTask(
      makeTaskCard({ id: "t-bad-review", space: "s1", priority: "P0" }),
      "# Bad review",
    );
    store.appendStateEvent("t-bad-review", {
      type: "resumed",
      at: "2026-11-19T11:58:00.000Z",
      stage: "review",
    });
    sm.createTask(
      makeTaskCard({ id: "t-triage", space: "s2", priority: "P1" }),
      "# Triage",
    );
    store.appendStateEvent("t-triage", {
      type: "resumed",
      at: "2026-11-19T11:59:00.000Z",
      stage: "triage",
    });

    const dispatched: string[] = [];
    const errors: Array<{ taskId: string; error: unknown }> = [];
    const scheduler = new KilnScheduler({
      store,
      stateMachine: sm,
      onDispatch: (plan) => {
        dispatched.push(plan.taskId);
      },
      onDispatchError: (taskId, error) => {
        errors.push({ taskId, error });
      },
    });
    activeScheduler = scheduler;

    // Schedule long cooldown (10s) then shorter cooldown (2s) on triage -> earliest (2s) wins
    scheduler.markRateLimited(
      { backendId: "paseo", agent: "codex", model: "gpt-5.4" },
      10_000,
    );
    scheduler.markRateLimited(
      { backendId: "paseo", agent: "pi", model: "magpie/triage" },
      2_000,
    );

    const tick1 = await scheduler.wake();
    expect(dispatched).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toBeInstanceOf(HeterogeneousReviewConflictError);
    expect(tick1.nextCooldownWakeAtMs).toBe(t0 + 2_000);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(dispatched).toEqual(["t-triage"]);
  });

  it("re-wakes immediately when a rate-limit cooldown expires during executeTick before syncCooldownTimer", async () => {
    let clockMs = 1_000;
    let tickCalls = 0;

    sm.createTask(
      makeTaskCard({ id: "t-fast-expiry", space: "s1", priority: "P2" }),
      "# Fast expiry",
    );

    const dispatched: string[] = [];
    const scheduler = new KilnScheduler({
      store,
      stateMachine: sm,
      rolesConfig: {
        schema_version: 1,
        heterogeneous_review: true,
        roles: {
          worker: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
        },
      },
      now: () => {
        tickCalls += 1;
        // Call 1 (markRateLimited): 1000 -> cooldownUntil = 1010
        // Call 2 (executeTick start): 1009 -> task deferred
        // Call 3 (executeTick end syncCooldownTimer): 1011 -> cooldown already expired!
        if (tickCalls === 1) return clockMs;
        if (tickCalls === 2) return 1_009;
        clockMs = 1_011;
        return clockMs;
      },
      onDispatch: (plan) => {
        dispatched.push(plan.taskId);
      },
    });
    activeScheduler = scheduler;

    scheduler.markRateLimited({ agent: "codex", model: "gpt-5.4" }, 10);
    const result = await scheduler.wake();

    expect(dispatched).toEqual(["t-fast-expiry"]);
    expect(result.nextCooldownWakeAtMs).toBeNull();
  });
});
