import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  DraftCard,
  LedgerFile,
  LimitsConfig,
  PricingConfig,
  RolesConfig,
  RunEvent,
  RunMeta,
  SpaceConfig,
  TaskCard,
} from "@kiln/protocol";
import {
  RosterConfigSchema,
  TaskCardSchema,
  createDefaultBuiltinRosterMetadata,
  createDefaultWorkflowsConfig,
  deriveLegacyRolesConfigFromRoster,
  projectWorkflowsConfigToRoster,
} from "@kiln/protocol";
import {
  KilnPaths,
  KilnStore,
  appendNdjsonLine,
  assertSafeSegment,
  deriveTaskStatus,
  detectSqliteRuntime,
  isWindowsNamedPipe,
  openSqliteDatabase,
  readNdjsonValidated,
  readYamlValidated,
  resolveDefaultIpcPath,
  resolveKilnHome,
  writeFileAtomic,
  writeYamlAtomic,
} from "../index.js";

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kiln-store-test-"));
}

function makeTaskCard(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    schema_version: 1,
    id: "t-101",
    title: "测试任务卡",
    space: "kiln",
    priority: "P1",
    track: "L2",
    workspace_mode: "git_worktree",
    parent: null,
    depends_on: [],
    contract_version: 1,
    contract: {
      goal: "验证存储层租约与原子写盘",
      end: "全部单测通过",
      accept_cmd: "pnpm test",
      accept_files_hash: "sha256:hash-v1",
      scope: ["packages/kernel/src/store/**"],
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
    task_id: "t-101",
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
      meta: { mode: "auto" },
    },
    started_at: "2026-11-19T10:01:00.000Z",
    ...overrides,
  };
}

describe("paths & traversal protection", () => {
  const originalKilnHome = process.env.KILN_HOME;

  afterEach(() => {
    if (originalKilnHome === undefined) {
      delete process.env.KILN_HOME;
    } else {
      process.env.KILN_HOME = originalKilnHome;
    }
  });

  it("resolves kiln home from override, KILN_HOME, and default ~/.kiln", () => {
    process.env.KILN_HOME = "/tmp/kiln-env-home";
    expect(resolveKilnHome("/tmp/kiln-override")).toBe(path.resolve("/tmp/kiln-override"));
    expect(resolveKilnHome()).toBe(path.resolve("/tmp/kiln-env-home"));

    delete process.env.KILN_HOME;
    expect(resolveKilnHome()).toBe(path.resolve(os.homedir(), ".kiln"));

    expect(() => resolveKilnHome("   ")).toThrow();
  });

  it("blocks empty, dot, dot-dot, separators, NUL, and control characters", () => {
    const badInputs = [
      "",
      "   ",
      ".",
      "..",
      " .. ",
      "../secret",
      "a/b",
      "a\\b",
      "bad\0id",
      "bad\nid",
      "bad\rid",
      "bad\tid",
      "bad\x1b[31m",
    ];

    const paths = new KilnPaths("/tmp/kiln-safe-test");
    for (const bad of badInputs) {
      expect(() => assertSafeSegment(bad, "taskId")).toThrow();
      expect(() => paths.taskDir(bad)).toThrow();
      expect(() => paths.spaceFile(bad)).toThrow();
      expect(() => paths.ledgerFile(bad)).toThrow();
      expect(() => paths.draftYaml(bad)).toThrow();
      expect(() => paths.runDir("t-101", bad)).toThrow();
    }

    expect(paths.configFile("roles")).toBe(path.resolve("/tmp/kiln-safe-test/config/roles.yaml"));
    expect(paths.kilndSock).toBe(resolveDefaultIpcPath(paths.home));
    expect(paths.shutdownTokenFile).toBe(path.resolve("/tmp/kiln-safe-test/run/kilnd.shutdown"));
    expect(paths.stagedDir("t-101")).toBe(
      path.resolve("/tmp/kiln-safe-test/workspaces/t-101/staged"),
    );
    expect(paths.backupManifest("t-101")).toBe(
      path.resolve("/tmp/kiln-safe-test/backups/t-101/manifest.json"),
    );
  });

  it("resolves cross-platform local IPC paths and identifies Windows Named Pipes", () => {
    expect(isWindowsNamedPipe("\\\\.\\pipe\\kiln-rpc-0123456789abcdef")).toBe(true);
    expect(isWindowsNamedPipe("\\\\?\\pipe\\kiln-rpc-0123456789abcdef")).toBe(true);
    expect(isWindowsNamedPipe("\\\\.\\PIPE\\KILN-RPC-TEST")).toBe(true);
    expect(isWindowsNamedPipe("/tmp/kiln/run/kilnd.sock")).toBe(false);
    expect(isWindowsNamedPipe("C:\\Users\\Alice\\.kiln\\run\\kilnd.sock")).toBe(false);

    expect(resolveDefaultIpcPath("/tmp/kiln-xplat", "darwin")).toBe(
      path.join(path.resolve("/tmp/kiln-xplat"), "run", "kilnd.sock"),
    );
    expect(resolveDefaultIpcPath("/tmp/kiln-xplat", "linux")).toBe(
      path.join(path.resolve("/tmp/kiln-xplat"), "run", "kilnd.sock"),
    );

    const winPipeA = resolveDefaultIpcPath("C:\\Users\\Alice\\.kiln", "win32");
    const winPipeB = resolveDefaultIpcPath("c:/users/alice/.kiln/", "win32");
    const expectedHash = crypto
      .createHash("sha256")
      .update("c:\\users\\alice\\.kiln")
      .digest("hex")
      .slice(0, 16);
    expect(winPipeA).toBe(`\\\\.\\pipe\\kiln-rpc-${expectedHash}`);
    expect(winPipeB).toBe(winPipeA);
    expect(isWindowsNamedPipe(winPipeA)).toBe(true);
    expect(winPipeA.length).toBeLessThanOrEqual(256);
  });
});

describe("fs-atomic & ndjson validation", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempHome();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes files atomically without leaving temporary files behind on success or failure", () => {
    const targetFile = path.join(tempDir, "nested", "test.txt");
    writeFileAtomic(targetFile, "hello kiln");
    expect(fs.readFileSync(targetFile, "utf8")).toBe("hello kiln");
    expect(fs.readdirSync(path.dirname(targetFile))).toEqual(["test.txt"]);

    // Overwrite atomically with Uint8Array
    writeFileAtomic(targetFile, new TextEncoder().encode("updated bytes"));
    expect(fs.readFileSync(targetFile, "utf8")).toBe("updated bytes");
    expect(fs.readdirSync(path.dirname(targetFile))).toEqual(["test.txt"]);

    // Failure case: target path is a non-empty directory so renameSync fails
    const blockingDir = path.join(tempDir, "blocking-dir");
    fs.mkdirSync(path.join(blockingDir, "child"), { recursive: true });
    expect(() => writeFileAtomic(blockingDir, "should fail")).toThrow();

    const tempLeftovers = fs.readdirSync(tempDir).filter((name) => name.startsWith(".tmp."));
    expect(tempLeftovers).toEqual([]);
  });

  it("validates YAML and NDJSON and reports line numbers on malformed lines", () => {
    const cardPath = path.join(tempDir, "card.yaml");
    const card = makeTaskCard();
    writeYamlAtomic(cardPath, card, TaskCardSchema);
    const readCard = readYamlValidated(cardPath, TaskCardSchema);
    expect(readCard.id).toBe(card.id);

    const ndjsonPath = path.join(tempDir, "events.ndjson");
    expect(readNdjsonValidated(ndjsonPath, TaskCardSchema)).toEqual([]);

    appendNdjsonLine(ndjsonPath, card);
    fs.appendFileSync(ndjsonPath, "{broken json line\n", "utf8");
    expect(() => readNdjsonValidated(ndjsonPath, TaskCardSchema)).toThrow(/2/);
  });
});

describe("KilnStore concurrency, contract bump, locks, usage, and isolation", () => {
  let tempHome: string;
  let store: KilnStore;

  beforeEach(() => {
    tempHome = makeTempHome();
    store = new KilnStore({ kilnHome: tempHome });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("initializes SQLite with WAL, synchronous=NORMAL, and foreign_keys=ON", () => {
    expect(store.sqlite.driver).toBe(detectSqliteRuntime());
    const pragmas = store.sqlite.getPragmaSettings();
    expect(pragmas.journalMode.toLowerCase()).toBe("wal");
    expect(pragmas.synchronous).toBe(1);
    expect(pragmas.foreignKeys).toBe(1);
  });

  it("normalizes dual SQLite driver rows, undefined misses, number changes, and nested SAVEPOINT rollback", () => {
    const dbPath = path.join(tempHome, "driver-check.sqlite");
    const db = openSqliteDatabase(dbPath);
    try {
      db.exec("CREATE TABLE items (id TEXT PRIMARY KEY, val TEXT NOT NULL)");
      const ins = db.prepare("INSERT INTO items (id, val) VALUES (@id, @val)");
      const runInfo = ins.run({ id: "a", val: "one", ignoredExtraKey: 42 });
      expect(typeof runInfo.changes).toBe("number");
      expect(runInfo.changes).toBe(1);

      const getStmt = db.prepare("SELECT * FROM items WHERE id = ?");
      expect(getStmt.get("missing")).toBeUndefined();
      const hit = getStmt.get("a");
      expect(hit).toEqual({ id: "a", val: "one" });
      expect(Object.getPrototypeOf(hit)).toBe(Object.prototype);

      const allRows = db.prepare("SELECT * FROM items").all();
      expect(allRows).toEqual([{ id: "a", val: "one" }]);
      expect(Object.getPrototypeOf(allRows[0])).toBe(Object.prototype);

      // Nested SAVEPOINT rollback keeps outer transaction intact when inner error is caught
      db.transaction(() => {
        ins.run({ id: "outer", val: "kept" });
        expect(() =>
          db.transaction(() => {
            ins.run({ id: "inner", val: "rolled-back" });
            throw new Error("abort inner savepoint");
          }),
        ).toThrow("abort inner savepoint");
      });

      expect(getStmt.get("outer")).toEqual({ id: "outer", val: "kept" });
      expect(getStmt.get("inner")).toBeUndefined();

      // Outer transaction rollback reverts all statements
      expect(() =>
        db.transaction(() => {
          ins.run({ id: "reverted", val: "nope" });
          throw new Error("abort outer tx");
        }),
      ).toThrow("abort outer tx");
      expect(getStmt.get("reverted")).toBeUndefined();
      ins.finalize();
      ins.finalize();
      getStmt.finalize();
    } finally {
      db.close();
    }

    // writeFileAtomic honors mode 0o600 on POSIX without throwing on Windows
    const secretFile = path.join(tempHome, "secret.token");
    writeFileAtomic(secretFile, "token-value\n", { mode: 0o600 });
    expect(fs.readFileSync(secretFile, "utf8")).toBe("token-value\n");
    if (process.platform !== "win32") {
      expect(fs.statSync(secretFile).mode & 0o777).toBe(0o600);
    }
  });

  it("handles dual-runner concurrent lease acquisition and stale receipt archiving", () => {
    const card = makeTaskCard();
    store.createTask(card, "# Brief\nTest brief");

    const run1 = makeRunMeta({ run_id: "run-001" });
    const firstAcquire = store.persistRunBeforeDispatch(run1, "001-implement", "# Handoff 1");
    expect(firstAcquire).toEqual({ acquired: true });
    expect(fs.existsSync(store.paths.runYaml("t-101", "001-implement"))).toBe(true);
    expect(fs.existsSync(store.paths.handoffMd("t-101", "001-implement"))).toBe(true);

    // Second concurrent dispatch for the same task is rejected while keeping its RUN.yaml trace
    const run2 = makeRunMeta({
      run_id: "run-002",
      session_ref: { backendId: "fake", sessionId: "sess-002" },
    });
    const secondAcquire = store.persistRunBeforeDispatch(run2, "002-implement");
    expect(secondAcquire).toEqual({ acquired: false, activeRunId: "run-001" });
    expect(fs.existsSync(store.paths.runYaml("t-101", "002-implement"))).toBe(true);

    // Active runner submits receipt first -> committed
    const receipt1 = store.submitReceipt({
      taskId: "t-101",
      runId: "run-001",
      contractVersion: 1,
      runDirName: "001-implement",
      markdown: "---\nrun_id: run-001\n---\n# Done",
      now: "2026-11-19T10:02:00.000Z",
    });
    expect(receipt1.accepted).toBe(true);
    expect(fs.readFileSync(store.paths.receiptMd("t-101", "001-implement"), "utf8")).toContain(
      "run-001",
    );

    // Late/duplicate submission by run-001 or run-002 -> rejected & archived to history/
    const staleSubmit = store.submitReceipt({
      taskId: "t-101",
      runId: "run-001",
      contractVersion: 1,
      runDirName: "001-implement",
      markdown: "---\nrun_id: run-001\n---\n# Late overwrite attempt",
      now: "2026-11-19T10:03:00.000Z",
    });
    expect(staleSubmit.accepted).toBe(false);
    if (!staleSubmit.accepted) {
      expect(staleSubmit.reason).toBe("lease_mismatch_or_expired");
      expect(staleSubmit.archivedPath).toContain(
        path.join("001-implement", "history", "run-001-stale-"),
      );
      expect(fs.existsSync(staleSubmit.archivedPath)).toBe(true);
    }

    // Official RECEIPT.md remains untouched
    expect(fs.readFileSync(store.paths.receiptMd("t-101", "001-implement"), "utf8")).not.toContain(
      "Late overwrite attempt",
    );
  });

  it("bumps contract_version, expires active lease, rejects old version receipt, and supersedes old RECEIPT.md", () => {
    const card = makeTaskCard();
    store.createTask(card, "# Brief");

    // Stage 1: research (completed under v1)
    store.persistRunBeforeDispatch(
      makeRunMeta({ run_id: "run-res", stage: "research", round: 1 }),
      "001-research",
    );
    const resSubmit = store.submitReceipt({
      taskId: "t-101",
      runId: "run-res",
      contractVersion: 1,
      runDirName: "001-research",
      markdown: "# Research v1",
    });
    expect(resSubmit.accepted).toBe(true);

    // Stage 2: implement (completed under v1)
    store.persistRunBeforeDispatch(
      makeRunMeta({ run_id: "run-imp-v1", stage: "implement", round: 1 }),
      "002-implement",
    );
    const impSubmit = store.submitReceipt({
      taskId: "t-101",
      runId: "run-imp-v1",
      contractVersion: 1,
      runDirName: "002-implement",
      markdown: "# Implement v1",
    });
    expect(impSubmit.accepted).toBe(true);

    // Stage 3: review (downstream completed under v1; not explicitly listed in affectedStages!)
    store.persistRunBeforeDispatch(
      makeRunMeta({ run_id: "run-rev-v1", stage: "review", round: 1 }),
      "003-review",
    );
    const revSubmit = store.submitReceipt({
      taskId: "t-101",
      runId: "run-rev-v1",
      contractVersion: 1,
      runDirName: "003-review",
      markdown: "# Review v1",
    });
    expect(revSubmit.accepted).toBe(true);

    // Stage 4: verify (still running under v1 when contract is bumped!)
    store.persistRunBeforeDispatch(
      makeRunMeta({ run_id: "run-ver-v1", stage: "verify", round: 1 }),
      "004-verify",
    );

    const bump = store.bumpContractVersion({
      taskId: "t-101",
      contractPatch: { goal: "Updated goal v2" },
      affectedStages: ["implement"],
      acceptFilesHash: "sha256:hash-v2",
      now: "2026-11-19T10:10:00.000Z",
    });

    expect(bump.newVersion).toBe(2);
    expect(bump.archivedReceipts).toHaveLength(2);
    expect(
      bump.archivedReceipts.some((p) =>
        p.includes(path.join("002-implement", "history", "run-imp-v1-superseded-v1")),
      ),
    ).toBe(true);
    expect(
      bump.archivedReceipts.some((p) =>
        p.includes(path.join("003-review", "history", "run-rev-v1-superseded-v1")),
      ),
    ).toBe(true);
    expect(fs.existsSync(store.paths.receiptMd("t-101", "002-implement"))).toBe(false);
    expect(fs.existsSync(store.paths.receiptMd("t-101", "003-review"))).toBe(false);
    // Research stage before implement remains valid
    expect(fs.existsSync(store.paths.receiptMd("t-101", "001-research"))).toBe(true);

    const updatedCard = store.readTaskCard("t-101");
    expect(updatedCard.contract_version).toBe(2);
    expect(updatedCard.contract.goal).toBe("Updated goal v2");
    expect(updatedCard.contract.accept_files_hash).toBe("sha256:hash-v2");

    const lease = store.getStageLease("t-101");
    expect(lease?.state).toBe("expired");

    // Dispatching with stale contract_version=1 after bump is rejected before writing RUN.yaml
    expect(() =>
      store.persistRunBeforeDispatch(
        makeRunMeta({
          run_id: "run-stale-v1",
          stage: "implement",
          round: 2,
          contract_version: 1,
        }),
        "005-stale-dispatch",
      ),
    ).toThrow(/contract_version/i);
    expect(fs.existsSync(store.paths.runYaml("t-101", "005-stale-dispatch"))).toBe(false);

    // Direct SQLite acquireStageLease also enforces task contract_version match
    expect(() =>
      store.sqlite.acquireStageLease({
        task_id: "t-101",
        run_id: "run-sqlite-stale-v1",
        stage: "implement",
        round: 2,
        contract_version: 1,
        session_ref: JSON.stringify({ backendId: "fake", sessionId: "s" }),
        started_at: "2026-11-19T10:10:30.000Z",
        heartbeat_at: "2026-11-19T10:10:30.000Z",
      }),
    ).toThrow(/contract_version/i);

    // Old v1 runner tries to submit receipt after contract bump -> rejected
    const staleVerify = store.submitReceipt({
      taskId: "t-101",
      runId: "run-ver-v1",
      contractVersion: 1,
      runDirName: "004-verify",
      markdown: "# Stale verify v1",
      now: "2026-11-19T10:11:00.000Z",
    });
    expect(staleVerify.accepted).toBe(false);
    if (!staleVerify.accepted) {
      expect(staleVerify.reason).toBe("lease_mismatch_or_expired");
      expect(fs.existsSync(staleVerify.archivedPath)).toBe(true);
    }

    // New v2 runner can dispatch and submit with contract_version=2
    const v2Acquire = store.persistRunBeforeDispatch(
      makeRunMeta({
        run_id: "run-imp-v2",
        stage: "implement",
        round: 2,
        contract_version: 2,
        started_at: "2026-11-19T10:12:00.000Z",
      }),
      "006-implement",
    );
    expect(v2Acquire).toEqual({ acquired: true });

    // Submitting with mismatched runDirName belonging to an older run throws without consuming active lease
    expect(() =>
      store.submitReceipt({
        taskId: "t-101",
        runId: "run-imp-v2",
        contractVersion: 2,
        runDirName: "001-research",
        markdown: "# Wrong directory attempt",
      }),
    ).toThrow(/belongs to/i);
    expect(fs.readFileSync(store.paths.receiptMd("t-101", "001-research"), "utf8")).toBe(
      "# Research v1",
    );
    expect(store.getStageLease("t-101")?.state).toBe("active");

    // Submitting with old version against active v2 lease is also rejected
    const wrongVersion = store.submitReceipt({
      taskId: "t-101",
      runId: "run-imp-v2",
      contractVersion: 1,
      runDirName: "006-implement",
      markdown: "# Wrong version",
    });
    expect(wrongVersion.accepted).toBe(false);

    const rightVersion = store.submitReceipt({
      taskId: "t-101",
      runId: "run-imp-v2",
      contractVersion: 2,
      runDirName: "006-implement",
      markdown: "# Accepted v2",
    });
    expect(rightVersion.accepted).toBe(true);
  });

  it("enforces cross-task host_path_locks atomically with rollback on conflict and releases cleanly", () => {
    store.createTask(makeTaskCard({ id: "t-host-1", workspace_mode: "host_scoped" }), "# H1");
    store.createTask(makeTaskCard({ id: "t-host-2", workspace_mode: "host_scoped" }), "# H2");

    const lockA = store.acquireHostPathLocks(
      "t-host-1",
      ["/Users/test/.zshrc", "/Users/test/.gitconfig"],
      "2026-11-19T10:00:00.000Z",
    );
    expect(lockA).toEqual({ acquired: true });

    // t-host-2 tries to lock a brand new path AND an already-locked path -> whole batch rolls back
    const lockB = store.acquireHostPathLocks(
      "t-host-2",
      ["/Users/test/.vimrc", "/Users/test/.zshrc"],
      "2026-11-19T10:01:00.000Z",
    );
    expect(lockB).toEqual({
      acquired: false,
      conflicts: [{ path: "/Users/test/.zshrc", heldByTaskId: "t-host-1" }],
    });
    expect(store.listHostPathLocks("t-host-2")).toEqual([]);

    // Releasing t-host-1 frees the path for t-host-2
    expect(store.releaseHostPathLocks("t-host-1")).toBe(2);
    const lockBRetry = store.acquireHostPathLocks(
      "t-host-2",
      ["/Users/test/.vimrc", "/Users/test/.zshrc"],
      "2026-11-19T10:02:00.000Z",
    );
    expect(lockBRetry).toEqual({ acquired: true });
    expect(store.listHostPathLocks("t-host-2")).toHaveLength(2);
  });

  it("idempotently overwrites usage_turns by (run_id, turn_id) and rejects cached > input", () => {
    store.createTask(makeTaskCard({ id: "t-usage" }), "# Usage");
    store.persistRunBeforeDispatch(
      makeRunMeta({ run_id: "run-u1", task_id: "t-usage" }),
      "001-implement",
    );

    const turn1Initial: RunEvent = {
      kind: "usage",
      at: "2026-11-19T10:01:10.000Z",
      turnId: "turn-1",
      agent: "codex",
      model: "gpt-5.4",
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 200,
    };
    const turn1Corrected: RunEvent = {
      kind: "usage",
      at: "2026-11-19T10:01:15.000Z",
      turnId: "turn-1",
      agent: "codex",
      model: "gpt-5.4",
      inputTokens: 1200,
      cachedInputTokens: 600,
      outputTokens: 250,
    };
    const turn2: RunEvent = {
      kind: "usage",
      at: "2026-11-19T10:02:00.000Z",
      turnId: "turn-2",
      agent: "codex",
      model: "gpt-5.4",
      inputTokens: 500,
      cachedInputTokens: 100,
      outputTokens: 50,
    };

    store.recordRunEvent("t-usage", "001-implement", turn1Initial);
    store.recordRunEvent("t-usage", "001-implement", turn1Corrected);
    store.recordRunEvent("t-usage", "001-implement", turn2);

    const turns = store.listUsageTurns({ taskId: "t-usage" });
    expect(turns).toHaveLength(2);
    expect(store.getTaskTotalTokens("t-usage")).toEqual({
      input_tokens: 1700,
      cached_input_tokens: 700,
      output_tokens: 300,
      total_tokens: 2000,
    });

    // Reject cached > input at both SQLite layer and recordRunEvent layer
    expect(() =>
      store.sqlite.upsertUsageTurn({
        run_id: "run-u1",
        turn_id: "turn-bad",
        task_id: "t-usage",
        agent: "codex",
        model: "gpt-5.4",
        input_tokens: 100,
        cached_input_tokens: 150,
        output_tokens: 10,
        recorded_at: "2026-11-19T10:03:00.000Z",
      }),
    ).toThrow(RangeError);

    expect(() =>
      store.recordRunEvent("t-usage", "001-implement", {
        kind: "usage",
        at: "2026-11-19T10:03:00.000Z",
        turnId: "turn-bad",
        agent: "codex",
        model: "gpt-5.4",
        inputTokens: 100,
        cachedInputTokens: 150,
        outputTokens: 10,
      }),
    ).toThrow();
  });

  it("keeps paused isolated from waiting, decisions.md, and ledger/, and handles cancelled lease cleanup", () => {
    store.createTask(makeTaskCard({ id: "t-pause", space: "my-space" }), "# Pause test");
    store.persistRunBeforeDispatch(
      makeRunMeta({ run_id: "run-p1", task_id: "t-pause" }),
      "001-implement",
    );

    const pausedState = store.appendStateEvent("t-pause", {
      type: "paused",
      at: "2026-11-19T10:05:00.000Z",
      stage: "implement",
      reason: "user_paused",
    });

    expect(pausedState.status).toBe("paused");
    expect(store.getTaskIndex("t-pause")?.status).toBe("paused");
    expect(store.getStageLease("t-pause")?.state).toBe("expired");
    expect(store.listTasks({ status: "waiting" })).toEqual([]);
    expect(fs.existsSync(store.paths.decisionsMd("t-pause"))).toBe(false);
    expect(fs.existsSync(store.paths.ledgerFile("my-space"))).toBe(false);

    // Resumed returns to queued until next dispatch
    const resumedState = store.appendStateEvent("t-pause", {
      type: "resumed",
      at: "2026-11-19T10:06:00.000Z",
      stage: "implement",
    });
    expect(resumedState.status).toBe("queued");

    // Re-dispatch and then cancel -> active lease cancelled cleanly, still no fake decision/ledger
    store.persistRunBeforeDispatch(
      makeRunMeta({
        run_id: "run-p2",
        task_id: "t-pause",
        started_at: "2026-11-19T10:07:00.000Z",
      }),
      "002-implement",
    );
    const cancelledState = store.appendStateEvent("t-pause", {
      type: "cancelled",
      at: "2026-11-19T10:08:00.000Z",
      reason: "no_longer_needed",
    });
    expect(cancelledState.status).toBe("cancelled");
    expect(store.getStageLease("t-pause")?.state).toBe("cancelled");
    expect(fs.existsSync(store.paths.decisionsMd("t-pause"))).toBe(false);
    expect(fs.existsSync(store.paths.ledgerFile("my-space"))).toBe(false);

    // Pure derivation checks
    const derived = deriveTaskStatus(
      store.readTaskCard("t-pause"),
      store.readStateEvents("t-pause"),
    );
    expect(derived.status).toBe("cancelled");
  });

  it("reads and writes config, space, ledger, and drafts cleanly", () => {
    expect(store.readConfig("roles")).toBeNull();
    expect(store.readSpace("kiln")).toBeNull();
    expect(store.readLedger("kiln")).toBeNull();
    expect(store.listDrafts()).toEqual([]);

    const roles: RolesConfig = {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        worker: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
      },
    };
    const limits: LimitsConfig = {
      schema_version: 1,
      max_concurrent_slots: 5,
      p0_extra_slot: true,
      max_waiting_wip: 5,
      retries_per_stage: 2,
      review_rounds: 2,
      advisor_calls: 1,
      max_card_tokens: 250_000,
    };
    const pricing: PricingConfig = {
      schema_version: 1,
      models: {
        "gpt-5.4": { in: 1.25, cached: 0.125, out: 10 },
      },
    };

    store.writeConfig("roles", roles);
    store.writeConfig("limits", limits);
    store.writeConfig("pricing", pricing);
    expect(store.readConfig("roles")?.roles.worker?.model).toBe("gpt-5.4");
    expect(store.readConfig("limits")?.max_concurrent_slots).toBe(5);
    expect(store.readConfig("pricing")?.models["gpt-5.4"]?.cached).toBe(0.125);

    const space: SpaceConfig = {
      schema_version: 1,
      id: "kiln",
      name: "Kiln",
      default_branch: "main",
      copy_untracked: [".env.local"],
      clone_deps: ["node_modules"],
      freeze_patterns: ["**/*.test.ts"],
    };
    store.writeSpace(space);
    expect(store.readSpace("kiln")?.copy_untracked).toEqual([".env.local"]);
    expect(store.listSpaces().map((s) => s.id)).toEqual(["kiln"]);
    expect(store.deleteSpace("kiln")).toBe(true);
    expect(store.deleteSpace("kiln")).toBe(false);
    expect(store.listSpaces()).toEqual([]);

    const ledger: LedgerFile = {
      schema_version: 1,
      space: "kiln",
      entries: [
        {
          id: "led-1",
          space: "kiln",
          rule: "Always run pnpm test before merge",
          source_task_id: "t-101",
          created_at: "2026-11-19T10:00:00.000Z",
        },
      ],
    };
    store.writeLedger(ledger);
    expect(store.readLedger("kiln")?.entries).toHaveLength(1);

    const draft: DraftCard = {
      schema_version: 1,
      id: "draft-1",
      title: "New idea",
      space: "kiln",
      priority: "P2",
      track: "L2",
      workspace_mode: "git_worktree",
      depends_on: [],
      contract: {},
      created_at: "2026-11-19T10:00:00.000Z",
      updated_at: "2026-11-19T10:01:00.000Z",
    };
    store.writeDraft(draft);
    expect(store.readDraft("draft-1")?.title).toBe("New idea");
    expect(store.listDrafts()).toHaveLength(1);
    writeFileAtomic(path.join(store.paths.draftsDir, "draft-1-chat.ndjson"), "{}\n");
    expect(store.deleteDraft("draft-1")).toBe(true);
    expect(store.deleteDraft("draft-1")).toBe(false);
    expect(store.listDrafts()).toEqual([]);
    expect(fs.existsSync(path.join(store.paths.draftsDir, "draft-1-chat.ndjson"))).toBe(false);
  });

  it("expires active leases on queued/resumed state events and validates RUN.yaml before appending usage events", () => {
    store.createTask(makeTaskCard({ id: "t-requeue" }), "# Requeue test");
    store.persistRunBeforeDispatch(
      makeRunMeta({ run_id: "run-rq-1", task_id: "t-requeue" }),
      "001-implement",
    );
    expect(store.getStageLease("t-requeue")?.state).toBe("active");

    // Re-queueing a running task expires active lease and blocks stale receipt submission
    const queuedAgain = store.appendStateEvent("t-requeue", {
      type: "queued",
      at: "2026-11-19T10:02:00.000Z",
    });
    expect(queuedAgain.status).toBe("queued");
    expect(queuedAgain.activeRunId).toBeNull();
    expect(store.getStageLease("t-requeue")?.state).toBe("expired");
    expect(
      store.submitReceipt({
        taskId: "t-requeue",
        runId: "run-rq-1",
        contractVersion: 1,
        runDirName: "001-implement",
        markdown: "# Stale after queued",
      }).accepted,
    ).toBe(false);

    // Dispatch new run, then emit resumed directly -> also expires active lease
    store.persistRunBeforeDispatch(
      makeRunMeta({
        run_id: "run-rq-2",
        task_id: "t-requeue",
        started_at: "2026-11-19T10:03:00.000Z",
      }),
      "002-implement",
    );
    const resumed = store.appendStateEvent("t-requeue", {
      type: "resumed",
      at: "2026-11-19T10:04:00.000Z",
      stage: "implement",
    });
    expect(resumed.status).toBe("queued");
    expect(store.getStageLease("t-requeue")?.state).toBe("expired");

    // recordRunEvent validates RUN.yaml BEFORE appending usage line to events.ndjson
    expect(() =>
      store.recordRunEvent("t-requeue", "999-missing-run", {
        kind: "usage",
        at: "2026-11-19T10:05:00.000Z",
        turnId: "turn-orphan",
        agent: "codex",
        model: "gpt-5.4",
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 10,
      }),
    ).toThrow();
    expect(fs.existsSync(store.paths.runEventsNdjson("t-requeue", "999-missing-run"))).toBe(false);
  });

  it("derives task status correctly across all decided action branches", () => {
    const card = makeTaskCard({ id: "t-decide" });
    expect(
      deriveTaskStatus(card, [
        { type: "waiting", at: "2026-11-19T10:01:00.000Z", reason: "ask" },
        { type: "decided", at: "2026-11-19T10:02:00.000Z", decision_id: "d1", action: "resume" },
      ]).status,
    ).toBe("queued");
    expect(
      deriveTaskStatus(card, [
        { type: "waiting", at: "2026-11-19T10:01:00.000Z", reason: "ask" },
        {
          type: "decided",
          at: "2026-11-19T10:02:00.000Z",
          decision_id: "d2",
          action: "return_external",
        },
      ]).status,
    ).toBe("external");
    expect(
      deriveTaskStatus(card, [
        { type: "waiting", at: "2026-11-19T10:01:00.000Z", reason: "ask" },
        { type: "decided", at: "2026-11-19T10:02:00.000Z", decision_id: "d3", action: "finish" },
      ]).status,
    ).toBe("done");
    expect(
      deriveTaskStatus(card, [
        { type: "waiting", at: "2026-11-19T10:01:00.000Z", reason: "ask" },
        { type: "decided", at: "2026-11-19T10:02:00.000Z", decision_id: "d4", action: "cancel" },
      ]).status,
    ).toBe("cancelled");
  });

  it("rejects submitReceipt when RUN.yaml is missing and rolls back lease when writing RECEIPT.md fails", () => {
    store.createTask(makeTaskCard({ id: "t-atomic" }), "# Atomic receipt test");
    const acquired = store.persistRunBeforeDispatch(
      makeRunMeta({ run_id: "run-atomic-1", task_id: "t-atomic" }),
      "001-implement",
    );
    expect(acquired).toEqual({ acquired: true });

    // Missing RUN.yaml directory throws before touching active lease or creating orphan files
    expect(() =>
      store.submitReceipt({
        taskId: "t-atomic",
        runId: "run-atomic-1",
        contractVersion: 1,
        runDirName: "009-missing-run",
        markdown: "# Orphan attempt",
      }),
    ).toThrow();
    expect(store.getStageLease("t-atomic")?.state).toBe("active");
    expect(fs.existsSync(store.paths.receiptMd("t-atomic", "009-missing-run"))).toBe(false);
    expect(fs.existsSync(store.paths.runHistoryDir("t-atomic", "009-missing-run"))).toBe(false);

    // Force writeFileAtomic failure by placing a directory at RECEIPT.md -> lease rolls back to active
    const receiptPath = store.paths.receiptMd("t-atomic", "001-implement");
    fs.mkdirSync(receiptPath, { recursive: true });
    expect(() =>
      store.submitReceipt({
        taskId: "t-atomic",
        runId: "run-atomic-1",
        contractVersion: 1,
        runDirName: "001-implement",
        markdown: "# Should roll back",
      }),
    ).toThrow();
    expect(store.getStageLease("t-atomic")?.state).toBe("active");

    // Removing the obstacle lets the same active runner retry and commit cleanly
    fs.rmSync(receiptPath, { recursive: true, force: true });
    const retried = store.submitReceipt({
      taskId: "t-atomic",
      runId: "run-atomic-1",
      contractVersion: 1,
      runDirName: "001-implement",
      markdown: "# Committed on retry",
    });
    expect(retried).toEqual({ accepted: true, receiptPath });
    expect(store.getStageLease("t-atomic")?.state).toBe("completed");
    expect(fs.readFileSync(receiptPath, "utf8")).toBe("# Committed on retry");
  });

  it("readEffectiveRosterConfig backfills missing built-in entries (e.g. advisor) without overwriting existing entries", () => {
    const seed = createDefaultBuiltinRosterMetadata();
    const { advisor: _omitted, ...legacyRoster } = seed;
    store.writeConfig(
      "roster",
      RosterConfigSchema.parse({
        schema_version: 2,
        roster: {
          ...legacyRoster,
          architect: {
            ...seed.architect,
            enabled: true,
            primary: { provider: "codex", model: "gpt-5.4" },
          },
        },
      }),
    );

    const effective = store.readEffectiveRosterConfig();
    expect(effective.roster.advisor).toMatchObject({
      group: "core",
      name: "技术顾问",
      stage: "advise",
      perm: "read_only",
      enabled: false,
      builtin: true,
    });
    expect(effective.roster.architect?.enabled).toBe(true);
    expect(effective.roster.architect?.primary?.model).toBe("gpt-5.4");
  });

  it("readEffectiveWorkflowsConfig initializes clean defaults, migrates legacy roster, and projects back losslessly", () => {
    // 1. Fresh store defaults to single-subscription friendly heterogeneous_review=false + 2 builtin templates
    const fresh = store.readEffectiveWorkflowsConfig();
    expect(fresh.default_template_id).toBe("standard_dev");
    expect(fresh.heterogeneous_review).toBe(false);
    expect(fresh.templates.map((t) => t.id)).toEqual(["standard_dev", "quick"]);

    // 2. Migrating an existing roster preserves all bindings, fallbacks, and full-access flags
    const seed = createDefaultBuiltinRosterMetadata();
    store.writeConfig(
      "roster",
      RosterConfigSchema.parse({
        schema_version: 2,
        heterogeneous_review: true,
        roster: {
          ...seed,
          pm: {
            ...seed.pm,
            enabled: true,
            primary: { provider: "codex", model: "gpt-5.4", effort: "high" },
            allow_full_access_fallback: true,
          },
          main_dev: {
            ...seed.main_dev,
            enabled: true,
            primary: { provider: "codex", model: "gpt-5.4", effort: "medium" },
          },
          reviewer: {
            ...seed.reviewer,
            enabled: true,
            primary: { provider: "codex", model: "gpt-5.4" },
            fallbacks: [{ provider: "claude", model: "claude-opus-4-6" }],
          },
          advisor: {
            ...seed.advisor,
            enabled: true,
            primary: { provider: "claude", model: "claude-opus-4-6" },
          },
        },
      }),
    );

    const migrated = store.readEffectiveWorkflowsConfig();
    expect(migrated.heterogeneous_review).toBe(true);
    expect(migrated.stage_bindings.intake).toEqual({
      provider: "codex",
      model: "gpt-5.4",
      effort: "high",
    });
    expect(migrated.allow_full_access_fallback.intake).toBe(true);
    expect(migrated.stage_bindings.implement?.model).toBe("gpt-5.4");
    expect(migrated.stage_fallbacks.review).toEqual([
      { provider: "claude", model: "claude-opus-4-6" },
    ]);
    expect(migrated.stage_bindings.advisor?.model).toBe("claude-opus-4-6");

    // 3. Updating & persisting workflows projects back into roster & legacy roles cleanly
    const updated = createDefaultWorkflowsConfig(null);
    updated.stage_bindings.intake = { provider: "agy", model: "gemini-3-pro", effort: "high" };
    updated.stage_bindings.implement = { provider: "agy", model: "gemini-3-pro", effort: "medium" };
    updated.stage_bindings.review = { provider: "agy", model: "gemini-3-pro", effort: "medium" };
    store.writeConfig("workflows", updated);
    const projectedRoster = projectWorkflowsConfigToRoster(
      store.readEffectiveWorkflowsConfig(),
      store.readEffectiveRosterConfig(),
    );
    expect(projectedRoster.heterogeneous_review).toBe(false);
    expect(projectedRoster.roster.pm?.primary?.model).toBe("gemini-3-pro");
    expect(projectedRoster.roster.reviewer?.primary?.model).toBe("gemini-3-pro");
    const projectedLegacyRoles = deriveLegacyRolesConfigFromRoster(projectedRoster);
    expect(projectedLegacyRoles.heterogeneous_review).toBe(false);
    expect(projectedLegacyRoles.roles.intake?.model).toBe("gemini-3-pro");
    expect(projectedLegacyRoles.roles.worker?.model).toBe("gemini-3-pro");
  });
});
