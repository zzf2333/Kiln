import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunMeta, TaskCard } from "@kiln/protocol";
import { KilnStore } from "../index.js";

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kiln-rebuild-test-"));
}

function makeCard(id: string, overrides: Partial<TaskCard> = {}): TaskCard {
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
      end: `End for ${id}`,
      accept_cmd: "pnpm test",
      accept_files_hash: "sha256:accept-hash",
      scope: ["packages/kernel/**"],
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
    created_at: "2026-11-19T09:00:00.000Z",
    updated_at: "2026-11-19T09:00:00.000Z",
    ...overrides,
  };
}

function makeRun(taskId: string, runId: string, overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    schema_version: 1,
    run_id: runId,
    task_id: taskId,
    stage: "implement",
    round: 1,
    role: "worker",
    contract_version: 1,
    backend_id: "paseo",
    agent: "codex",
    model: "gpt-5.4",
    session_ref: {
      backendId: "paseo",
      sessionId: `paseo-sess-${runId}`,
      meta: { modeId: "auto", workspace: `/tmp/wt/${taskId}` },
    },
    started_at: "2026-11-19T09:05:00.000Z",
    ...overrides,
  };
}

describe("KilnStore disk rebuild after deleting index.sqlite", () => {
  let kilnHome: string;

  beforeEach(() => {
    kilnHome = makeTempHome();
  });

  afterEach(() => {
    fs.rmSync(kilnHome, { recursive: true, force: true });
  });

  it("rebuilds tasks_index, active stage_leases with session_ref, and usage_turns 100% from disk", () => {
    const store1 = new KilnStore({ kilnHome });

    // 1. Queued upstream task (P2) blocked-by P0 downstream -> effective_priority becomes P0
    store1.createTask(makeCard("t-queued", { priority: "P2" }), "# Queued task");
    store1.createTask(
      makeCard("t-p0-child", {
        priority: "P0",
        depends_on: ["t-queued"],
        created_at: "2026-11-19T09:01:00.000Z",
        updated_at: "2026-11-19T09:01:00.000Z",
      }),
      "# P0 downstream",
    );

    // 2. Running task with active lease, rich session_ref, multiple usage turns (incl. overwrite),
    //    plus a failed competing run RUN.yaml that never acquired the lease
    store1.createTask(
      makeCard("t-running", {
        priority: "P1",
        track: "L1",
        created_at: "2026-11-19T09:02:00.000Z",
        updated_at: "2026-11-19T09:02:00.000Z",
      }),
      "# Running task",
    );
    store1.appendStateEvent("t-running", {
      type: "track_escalated",
      at: "2026-11-19T09:03:00.000Z",
      from: "L1",
      to: "L2",
      reason: "frozen_tests_changed",
    });

    const activeRun = makeRun("t-running", "run-active-1", {
      stage: "implement",
      round: 2,
      session_ref: {
        backendId: "paseo",
        sessionId: "sess-live-xyz",
        meta: { modeId: "auto", host: "local-daemon" },
      },
    });
    expect(store1.persistRunBeforeDispatch(activeRun, "001-implement")).toEqual({
      acquired: true,
    });

    // Competing dispatch writes RUN.yaml on disk but loses the lease
    const competingRun = makeRun("t-running", "run-loser-2");
    expect(store1.persistRunBeforeDispatch(competingRun, "002-implement")).toEqual({
      acquired: false,
      activeRunId: "run-active-1",
    });

    store1.recordRunEvent("t-running", "001-implement", {
      kind: "thinking",
      at: "2026-11-19T09:05:10.000Z",
    });
    store1.recordRunEvent("t-running", "001-implement", {
      kind: "usage",
      at: "2026-11-19T09:05:20.000Z",
      turnId: "turn-1",
      agent: "codex",
      model: "gpt-5.4",
      inputTokens: 800,
      cachedInputTokens: 200,
      outputTokens: 150,
    });
    // Idempotent overwrite of turn-1
    store1.recordRunEvent("t-running", "001-implement", {
      kind: "usage",
      at: "2026-11-19T09:05:25.000Z",
      turnId: "turn-1",
      agent: "codex",
      model: "gpt-5.4",
      inputTokens: 1000,
      cachedInputTokens: 300,
      outputTokens: 200,
    });
    store1.recordRunEvent("t-running", "001-implement", {
      kind: "usage",
      at: "2026-11-19T09:06:00.000Z",
      turnId: "turn-2",
      agent: "codex",
      model: "gpt-5.4",
      inputTokens: 600,
      cachedInputTokens: 100,
      outputTokens: 100,
    });

    // 3. Paused task (had an active run before pausing; must NOT revive as active lease)
    store1.createTask(
      makeCard("t-paused", {
        created_at: "2026-11-19T09:04:00.000Z",
        updated_at: "2026-11-19T09:04:00.000Z",
      }),
      "# Paused task",
    );
    store1.persistRunBeforeDispatch(makeRun("t-paused", "run-paused-1"), "001-implement");
    store1.appendStateEvent("t-paused", {
      type: "paused",
      at: "2026-11-19T09:07:00.000Z",
      stage: "implement",
      reason: "manual_pause",
    });

    // 4. Done task (completed receipt + usage + done state event)
    store1.createTask(
      makeCard("t-done", {
        priority: "P3",
        created_at: "2026-11-19T09:05:00.000Z",
        updated_at: "2026-11-19T09:05:00.000Z",
      }),
      "# Done task",
    );
    store1.persistRunBeforeDispatch(makeRun("t-done", "run-done-1"), "001-implement");
    store1.recordRunEvent("t-done", "001-implement", {
      kind: "usage",
      at: "2026-11-19T09:08:00.000Z",
      turnId: "turn-done-1",
      agent: "codex",
      model: "gpt-5.4",
      inputTokens: 400,
      cachedInputTokens: 50,
      outputTokens: 80,
    });
    expect(
      store1.submitReceipt({
        taskId: "t-done",
        runId: "run-done-1",
        contractVersion: 1,
        runDirName: "001-implement",
        markdown: "# Completed receipt",
        now: "2026-11-19T09:08:30.000Z",
      }).accepted,
    ).toBe(true);
    store1.appendStateEvent("t-done", {
      type: "done",
      at: "2026-11-19T09:09:00.000Z",
      deliver_ref: "main@abc123",
    });

    // 5. Contract-bumped task (active v1 lease expired during bump, must NOT revive on rebuild)
    store1.createTask(
      makeCard("t-bumped", {
        created_at: "2026-11-19T09:06:00.000Z",
        updated_at: "2026-11-19T09:06:00.000Z",
      }),
      "# Bumped task",
    );
    store1.persistRunBeforeDispatch(makeRun("t-bumped", "run-bump-v1"), "001-implement");
    store1.bumpContractVersion({
      taskId: "t-bumped",
      contractPatch: { goal: "Updated goal v2" },
      affectedStages: ["implement"],
      acceptFilesHash: "sha256:accept-v2",
      now: "2026-11-19T09:09:30.000Z",
    });

    const expectedRunningTokens = store1.getTaskTotalTokens("t-running");
    const expectedDoneTokens = store1.getTaskTotalTokens("t-done");
    store1.close();

    // Physically wipe index.sqlite + WAL + SHM
    const dbFile = path.join(kilnHome, "index.sqlite");
    fs.rmSync(dbFile, { force: true });
    fs.rmSync(`${dbFile}-wal`, { force: true });
    fs.rmSync(`${dbFile}-shm`, { force: true });
    expect(fs.existsSync(dbFile)).toBe(false);

    // Reopen store -> automatic full rebuild from disk
    const store2 = new KilnStore({ kilnHome });
    try {
      expect(fs.existsSync(dbFile)).toBe(true);

      const allTasks = store2.listTasks();
      expect(allTasks).toHaveLength(6);

      const queuedIdx = store2.getTaskIndex("t-queued");
      expect(queuedIdx?.status).toBe("queued");
      expect(queuedIdx?.priority).toBe("P2");
      expect(queuedIdx?.effective_priority).toBe("P0");

      const runningIdx = store2.getTaskIndex("t-running");
      expect(runningIdx?.status).toBe("running");
      expect(runningIdx?.track).toBe("L2");
      expect(runningIdx?.priority).toBe("P1");
      expect(runningIdx?.contract_version).toBe(1);

      expect(store2.getTaskIndex("t-paused")?.status).toBe("paused");
      expect(store2.getTaskIndex("t-done")?.status).toBe("done");
      expect(store2.getTaskIndex("t-bumped")?.contract_version).toBe(2);
      expect(store2.getStageLease("t-bumped")).toBeNull();
      expect(
        store2.submitReceipt({
          taskId: "t-bumped",
          runId: "run-bump-v1",
          contractVersion: 1,
          runDirName: "001-implement",
          markdown: "# Stale v1 after rebuild",
        }).accepted,
      ).toBe(false);

      // Only the genuine running task has an active stage lease
      const activeLeases = store2.listActiveStageLeases();
      expect(activeLeases).toHaveLength(1);
      const restoredLease = activeLeases[0];
      expect(restoredLease?.task_id).toBe("t-running");
      expect(restoredLease?.run_id).toBe("run-active-1");
      expect(restoredLease?.stage).toBe("implement");
      expect(restoredLease?.round).toBe(2);
      expect(restoredLease?.heartbeat_at).toBe("2026-11-19T09:06:00.000Z");
      expect(JSON.parse(restoredLease?.session_ref ?? "{}")).toEqual({
        backendId: "paseo",
        sessionId: "sess-live-xyz",
        meta: { modeId: "auto", host: "local-daemon" },
      });

      // Usage turns restored idempotently
      expect(store2.getTaskTotalTokens("t-running")).toEqual(expectedRunningTokens);
      expect(store2.getTaskTotalTokens("t-done")).toEqual(expectedDoneTokens);
      expect(store2.listUsageTurns({ taskId: "t-running" })).toHaveLength(2);

      // Stale/loser run_id and paused task's old run_id are rejected after rebuild
      const loserAttempt = store2.submitReceipt({
        taskId: "t-running",
        runId: "run-loser-2",
        contractVersion: 1,
        runDirName: "002-implement",
        markdown: "# Loser late submit",
      });
      expect(loserAttempt.accepted).toBe(false);

      const pausedAttempt = store2.submitReceipt({
        taskId: "t-paused",
        runId: "run-paused-1",
        contractVersion: 1,
        runDirName: "001-implement",
        markdown: "# Paused stale submit",
      });
      expect(pausedAttempt.accepted).toBe(false);

      // Active restored lease accepts valid receipt after rebuild
      const validAttempt = store2.submitReceipt({
        taskId: "t-running",
        runId: "run-active-1",
        contractVersion: 1,
        runDirName: "001-implement",
        markdown: "# Valid receipt after crash rebuild",
        now: "2026-11-19T09:10:00.000Z",
      });
      expect(validAttempt.accepted).toBe(true);
      expect(store2.getStageLease("t-running")?.state).toBe("completed");

      // Duplicate submission of that same run_id after completion is rejected
      const duplicateAttempt = store2.submitReceipt({
        taskId: "t-running",
        runId: "run-active-1",
        contractVersion: 1,
        runDirName: "001-implement",
        markdown: "# Duplicate submit after rebuild",
      });
      expect(duplicateAttempt.accepted).toBe(false);
    } finally {
      store2.close();
    }
  });

  it("does not leave an empty index.sqlite behind when disk validation fails during rebuild", () => {
    const store1 = new KilnStore({ kilnHome });
    const card = makeCard("t-corrupt");
    store1.createTask(card, "# Corrupt test");
    const dbFile = store1.paths.indexSqlite;
    const cardFile = store1.paths.cardYaml("t-corrupt");
    store1.close();

    // Corrupt card.yaml with mismatched id and delete index.sqlite
    fs.writeFileSync(
      cardFile,
      fs.readFileSync(cardFile, "utf8").replace("id: t-corrupt", "id: t-wrong"),
      "utf8",
    );
    fs.rmSync(dbFile, { force: true });
    fs.rmSync(`${dbFile}-wal`, { force: true });
    fs.rmSync(`${dbFile}-shm`, { force: true });

    expect(() => new KilnStore({ kilnHome })).toThrow(/Corrupted task directory/);
    expect(fs.existsSync(dbFile)).toBe(false);

    // Repair card.yaml -> subsequent startup rebuilds and indexes the task cleanly
    fs.writeFileSync(
      cardFile,
      fs.readFileSync(cardFile, "utf8").replace("id: t-wrong", "id: t-corrupt"),
      "utf8",
    );
    const recovered = new KilnStore({ kilnHome });
    try {
      expect(fs.existsSync(dbFile)).toBe(true);
      expect(recovered.getTaskIndex("t-corrupt")?.status).toBe("queued");
    } finally {
      recovered.close();
    }
  });
});
