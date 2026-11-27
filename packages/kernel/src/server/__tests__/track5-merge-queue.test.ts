import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskCardSchema, buildWorkflowPreset } from "@kiln/protocol";
import { BackendRegistry, FakeBackend, type BackendAgentDescriptor } from "../../backend/index.js";
import { KilnScheduler } from "../../scheduler/index.js";
import { KilnStore } from "../../store/index.js";
import {
  KilndServer,
  SpaceMergeLock,
  computeMergeQueueSnapshot,
  countRefineryAutoReworks,
} from "../index.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initTempGitRepo(repoPath: string, initialFiles: Record<string, string>): string {
  fs.mkdirSync(repoPath, { recursive: true });
  for (const [rel, content] of Object.entries(initialFiles)) {
    const abs = path.join(repoPath, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Kiln Test"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoPath, "config", "user.email", "test@kiln.local"], {
    stdio: "pipe",
  });
  execFileSync("git", ["-C", repoPath, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", repoPath, "commit", "-m", "init"], { stdio: "pipe" });
  return execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function createSliceWorktreeCommit(params: {
  store: KilnStore;
  repoPath: string;
  taskId: string;
  files: Record<string, string>;
  commitMessage: string;
}): string {
  const worktree = path.join(params.store.paths.workspaceDir(params.taskId), "worktree");
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  execFileSync(
    "git",
    ["-C", params.repoPath, "worktree", "add", "-b", `kiln/${params.taskId}`, worktree, "main"],
    { stdio: "pipe" },
  );
  for (const [rel, content] of Object.entries(params.files)) {
    const abs = path.join(worktree, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  execFileSync("git", ["-C", worktree, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", worktree, "commit", "-m", params.commitMessage], { stdio: "pipe" });
  return execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

const CODEX_DESCRIPTOR: BackendAgentDescriptor = {
  id: "codex",
  label: "Codex",
  capabilities: {
    interactiveChat: true,
    approvals: true,
    mcpInjection: false,
    usageCacheBreakdown: true,
    interrupt: true,
    imageInput: true,
    warmSessionReuse: false,
  },
  modes: [{ id: "auto", label: "Auto" }],
  defaultModeId: "auto",
};

async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

function makeDeliverCard(params: {
  id: string;
  title: string;
  priority: "P0" | "P1" | "P2" | "P3";
  scope: string[];
  acceptCmd: string;
  dependsOn?: string[];
}) {
  const now = "2026-11-24T04:00:00Z";
  return TaskCardSchema.parse({
    schema_version: 1,
    id: params.id,
    title: params.title,
    space: "proj",
    priority: params.priority,
    track: "L1",
    workspace_mode: "git_worktree",
    parent: null,
    depends_on: params.dependsOn ?? [],
    workflow: buildWorkflowPreset("quick"),
    contract_version: 1,
    contract: {
      goal: params.title,
      end: "Merged cleanly",
      accept_cmd: params.acceptCmd,
      accept_files_hash: `sha256:${"a".repeat(64)}`,
      scope: params.scope,
      deliver: { mode: "merge_main", cmd: null },
      human_accept: false,
      external_actions: "ask",
    },
    limits: {
      retries_per_stage: 2,
      review_rounds: 2,
      advisor_calls: 1,
      max_tokens: 150_000,
    },
    created_at: now,
    updated_at: now,
  });
}

describe("Track 5 [B12.2] Multi-slice serial merge queue (Refinery)", () => {
  const servers: KilndServer[] = [];
  const stores: KilnStore[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await s.orchestrator.stop().catch(() => {});
      await s.stop().catch(() => {});
    }
    for (const st of stores.splice(0)) {
      st.close();
    }
    for (const d of tempDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("serializes SpaceMergeLock and computes deterministic per-space merge queue snapshot & rework counters", async () => {
    const lock = new SpaceMergeLock();
    const order: string[] = [];
    await Promise.all([
      lock.withLock("/tmp/repo-a", async () => {
        order.push("a1-start");
        await new Promise((r) => setTimeout(r, 30));
        order.push("a1-end");
      }),
      lock.withLock("/tmp/repo-a", async () => {
        order.push("a2-start");
        order.push("a2-end");
      }),
    ]);
    expect(order).toEqual(["a1-start", "a1-end", "a2-start", "a2-end"]);

    expect(
      countRefineryAutoReworks(
        [
          {
            type: "steered",
            at: "2026-11-24T04:00:00Z",
            steer_id: "manual-1",
            message: "manual note",
            interrupt: false,
            contract_version: 1,
          },
          {
            type: "steered",
            at: "2026-11-24T04:01:00Z",
            steer_id: "refinery-conflict-abc",
            message: "conflict",
            interrupt: false,
            contract_version: 1,
          },
          {
            type: "steered",
            at: "2026-11-24T04:02:00Z",
            steer_id: "refinery-accept-def",
            message: "accept",
            interrupt: false,
            contract_version: 2,
          },
        ],
        1,
      ),
    ).toBe(1);

    const home = createTempDir("kiln-b12-snap-");
    const store = new KilnStore({ kilnHome: home });
    stores.push(store);
    const repoPath = createTempDir("kiln-b12-snap-repo-");
    initTempGitRepo(repoPath, { "README.md": "init\n" });
    store.writeSpace({
      schema_version: 1,
      id: "proj",
      name: "Proj",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
      scripts: {},
    });

    const cardRun = makeDeliverCard({
      id: "t-run",
      title: "Running Merge",
      priority: "P2",
      scope: ["a.ts"],
      acceptCmd: "echo ok",
    });
    const cardQ1 = makeDeliverCard({
      id: "t-q1",
      title: "High Prio Queue",
      priority: "P0",
      scope: ["b.ts"],
      acceptCmd: "echo ok",
    });
    const cardQ2 = makeDeliverCard({
      id: "t-q2",
      title: "Normal Prio Queue",
      priority: "P2",
      scope: ["c.ts"],
      acceptCmd: "echo ok",
    });

    store.createTask(cardRun, "# R");
    store.appendStateEvent("t-run", {
      type: "running",
      at: "2026-11-24T04:01:00Z",
      stage: "deliver",
      step_index: 2,
      round: 1,
      run_id: "r-run-deliver",
    });

    store.createTask(cardQ2, "# Q2");
    store.appendStateEvent("t-q2", {
      type: "resumed",
      at: "2026-11-24T04:00:30Z",
      stage: "deliver",
      step_index: 2,
    });

    store.createTask(cardQ1, "# Q1");
    store.appendStateEvent("t-q1", {
      type: "resumed",
      at: "2026-11-24T04:02:00Z",
      stage: "deliver",
      step_index: 2,
    });

    const snap = computeMergeQueueSnapshot(store);
    expect(snap).toEqual([
      {
        task_id: "t-run",
        space: "proj",
        title: "Running Merge",
        state: "merging",
        position: 1,
        priority: "P2",
      },
      {
        task_id: "t-q1",
        space: "proj",
        title: "High Prio Queue",
        state: "queued",
        position: 2,
        priority: "P0",
      },
      {
        task_id: "t-q2",
        space: "proj",
        title: "Normal Prio Queue",
        state: "queued",
        position: 3,
        priority: "P2",
      },
    ]);
  });

  it("enforces at most one in-flight merge_main deliver per space in KilnScheduler even when scopes are disjoint", async () => {
    const home = createTempDir("kiln-b12-sched-");
    const repoPath = createTempDir("kiln-b12-sched-repo-");
    initTempGitRepo(repoPath, { "README.md": "init\n" });

    const store = new KilnStore({ kilnHome: home });
    stores.push(store);
    store.writeSpace({
      schema_version: 1,
      id: "proj",
      name: "Proj",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
      scripts: {},
    });

    const c1 = makeDeliverCard({
      id: "t-s1",
      title: "Slice 1",
      priority: "P1",
      scope: ["src/a.ts"],
      acceptCmd: "echo ok",
    });
    const c2 = makeDeliverCard({
      id: "t-s2",
      title: "Slice 2",
      priority: "P1",
      scope: ["src/b.ts"],
      acceptCmd: "echo ok",
    });
    store.createTask(c1, "# 1");
    store.createTask(c2, "# 2");
    store.appendStateEvent("t-s1", {
      type: "resumed",
      at: "2026-11-24T04:01:00Z",
      stage: "deliver",
      step_index: 2,
    });
    store.appendStateEvent("t-s2", {
      type: "resumed",
      at: "2026-11-24T04:01:01Z",
      stage: "deliver",
      step_index: 2,
    });

    const dispatched: string[] = [];
    const scheduler = new KilnScheduler({
      store,
      onDispatch: (plan) => {
        dispatched.push(plan.taskId);
      },
    });

    const tick = await scheduler.wake();
    expect(tick.dispatched.map((d) => d.taskId)).toEqual(["t-s1"]);
    expect(dispatched).toEqual(["t-s1"]);
  });

  it("serializes two overlapping/disjoint slices on a real git repo: auto-rebases Slice B onto updated main and re-runs accept_cmd", async () => {
    const home = createTempDir("kiln-b12-rebase-home-");
    const repoPath = createTempDir("kiln-b12-rebase-repo-");
    initTempGitRepo(repoPath, {
      "a.txt": "init-a\n",
      "b.txt": "init-b\n",
    });

    const store = new KilnStore({ kilnHome: home });
    stores.push(store);
    store.writeSpace({
      schema_version: 1,
      id: "proj",
      name: "Proj",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
      scripts: {},
    });

    // Both slices branch from initial `main`; Slice A advances main, then Slice B rebases & verifies both files coexist!
    const combinedAccept =
      "node -e \"const fs=require('fs'); if(!fs.readFileSync('a.txt','utf8').includes('from-a') || !fs.readFileSync('b.txt','utf8').includes('from-b')) process.exit(1)\"";
    const cardA = makeDeliverCard({
      id: "t-a",
      title: "Slice A",
      priority: "P0",
      scope: ["a.txt"],
      acceptCmd:
        "node -e \"if(!require('fs').readFileSync('a.txt','utf8').includes('from-a')) process.exit(1)\"",
    });
    const cardB = makeDeliverCard({
      id: "t-b",
      title: "Slice B",
      priority: "P2",
      scope: ["b.txt"],
      acceptCmd: combinedAccept,
    });

    createSliceWorktreeCommit({
      store,
      repoPath,
      taskId: "t-a",
      files: { "a.txt": "from-a\n" },
      commitMessage: "feat(a): update a.txt",
    });
    createSliceWorktreeCommit({
      store,
      repoPath,
      taskId: "t-b",
      files: { "b.txt": "from-b\n" },
      commitMessage: "feat(b): update b.txt",
    });

    store.createTask(cardA, "# A");
    store.createTask(cardB, "# B");
    store.appendStateEvent("t-a", {
      type: "resumed",
      at: "2026-11-24T04:01:00Z",
      stage: "deliver",
      step_index: 2,
    });
    store.appendStateEvent("t-b", {
      type: "resumed",
      at: "2026-11-24T04:01:01Z",
      stage: "deliver",
      step_index: 2,
    });

    const registry = new BackendRegistry();
    registry.register(new FakeBackend({ backendId: "fake", agents: [CODEX_DESCRIPTOR] }));
    const server = new KilndServer({
      store,
      backendRegistry: registry,
      publicDir: null,
      enableOrchestrator: true,
    });
    servers.push(server);

    await server.orchestrator.start();
    await waitUntil(
      () =>
        store.getTaskIndex("t-a")?.status === "done" &&
        store.getTaskIndex("t-b")?.status === "done",
      "both t-a and t-b merged serially",
    );

    expect(fs.readFileSync(path.join(repoPath, "a.txt"), "utf8")).toContain("from-a");
    expect(fs.readFileSync(path.join(repoPath, "b.txt"), "utf8")).toContain("from-b");
    expect(computeMergeQueueSnapshot(store)).toEqual([]);
  });

  it("handles post-rebase accept_cmd regression and text rebase conflicts with <=1 auto-rework before waiting", async () => {
    const home = createTempDir("kiln-b12-err-home-");
    const repoPath = createTempDir("kiln-b12-err-repo-");
    initTempGitRepo(repoPath, {
      "shared.txt": "base\n",
      "feature.txt": "init\n",
    });

    const store = new KilnStore({ kilnHome: home });
    stores.push(store);
    store.writeSpace({
      schema_version: 1,
      id: "proj",
      name: "Proj",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
      scripts: {},
    });

    // 1) Task with clean rebase that fails post-rebase accept_cmd; 2) Task with real text conflict on shared.txt
    const cardAcceptFail = makeDeliverCard({
      id: "t-reg1",
      title: "Accept regression rework",
      priority: "P1",
      scope: ["feature.txt"],
      acceptCmd: "node -e \"if(require('fs').existsSync('blocker.txt')) process.exit(1)\"",
    });
    const cardAcceptExhausted = makeDeliverCard({
      id: "t-reg2",
      title: "Accept regression waiting",
      priority: "P1",
      scope: ["feature2.txt"],
      acceptCmd: "node -e \"if(require('fs').existsSync('blocker.txt')) process.exit(1)\"",
    });
    const cardConflict = makeDeliverCard({
      id: "t-conf",
      title: "Rebase text conflict",
      priority: "P1",
      scope: ["shared.txt"],
      acceptCmd: "echo ok",
    });

    createSliceWorktreeCommit({
      store,
      repoPath,
      taskId: "t-reg1",
      files: { "feature.txt": "ok\n" },
      commitMessage: "feat: feature 1",
    });
    createSliceWorktreeCommit({
      store,
      repoPath,
      taskId: "t-reg2",
      files: { "feature2.txt": "ok2\n" },
      commitMessage: "feat: feature 2",
    });
    createSliceWorktreeCommit({
      store,
      repoPath,
      taskId: "t-conf",
      files: { "shared.txt": "from-task\n" },
      commitMessage: "feat: conflict shared",
    });

    // Now advance `main` with blocker.txt + conflicting shared.txt edit AFTER all 3 worktrees branched!
    fs.writeFileSync(path.join(repoPath, "blocker.txt"), "main-added-blocker\n", "utf8");
    fs.writeFileSync(path.join(repoPath, "shared.txt"), "from-main\n", "utf8");
    execFileSync("git", ["-C", repoPath, "add", "."], { stdio: "pipe" });
    execFileSync("git", ["-C", repoPath, "commit", "-m", "main advance"], { stdio: "pipe" });
    const mainShaBefore = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    store.createTask(cardAcceptFail, "# R1");
    store.appendStateEvent("t-reg1", {
      type: "resumed",
      at: "2026-11-24T04:01:00Z",
      stage: "deliver",
      step_index: 2,
    });

    store.createTask(cardAcceptExhausted, "# R2");
    // Seed 1 prior refinery rework so next accept failure goes straight to waiting
    store.appendStateEvent("t-reg2", {
      type: "steered",
      at: "2026-11-24T04:00:30Z",
      steer_id: "refinery-accept-prior",
      message: "prior rework",
      interrupt: false,
      contract_version: 1,
      stage: "implement",
    });
    store.appendStateEvent("t-reg2", {
      type: "resumed",
      at: "2026-11-24T04:01:10Z",
      stage: "deliver",
      step_index: 2,
    });

    store.createTask(cardConflict, "# C1");
    store.appendStateEvent("t-conf", {
      type: "resumed",
      at: "2026-11-24T04:01:20Z",
      stage: "deliver",
      step_index: 2,
    });

    // Keep worker turns stalled in wait_for_cancel so we observe clean handoff to `implement` stage without completing
    const fakeBackend = new FakeBackend({ backendId: "fake", agents: [CODEX_DESCRIPTOR] });
    fakeBackend.enqueueScript([{ kind: "thinking" }, { kind: "wait_for_cancel" }]);
    fakeBackend.enqueueScript([{ kind: "thinking" }, { kind: "wait_for_cancel" }]);

    const registry = new BackendRegistry();
    registry.register(fakeBackend);
    const server = new KilndServer({
      store,
      backendRegistry: registry,
      publicDir: null,
      enableOrchestrator: true,
    });
    servers.push(server);

    await server.orchestrator.start();

    await waitUntil(
      () =>
        store
          .readStateEvents("t-reg1")
          .some((ev) => ev.type === "steered" && ev.steer_id.startsWith("refinery-accept-")) &&
        store.getTaskIndex("t-reg2")?.status === "waiting" &&
        store
          .readStateEvents("t-conf")
          .some((ev) => ev.type === "steered" && ev.steer_id.startsWith("refinery-conflict-")),
      "rework and waiting verdicts recorded",
    );

    expect(server.pendingDecisions.get("t-reg2")?.reason).toBe("refinery_accept_failed");
    // Conflict worktree was cleanly aborted before rework
    const conflictWorktreeStatus = execFileSync(
      "git",
      ["-C", path.join(store.paths.workspaceDir("t-conf"), "worktree"), "status", "--porcelain"],
      { encoding: "utf8" },
    ).trim();
    expect(conflictWorktreeStatus).toBe("");
    // Main branch HEAD remained completely untouched
    const mainShaAfter = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    expect(mainShaAfter).toBe(mainShaBefore);
  });
});
