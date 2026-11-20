import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GateReportSchema,
  serializeFrontmatterMarkdown,
  type RunMeta,
  type SpaceConfig,
  type TaskCard,
} from "@kiln/protocol";
import { KilnStore, readYamlValidated, writeFileAtomic } from "../../store/index.js";
import { evaluateWorkerStageOutcome } from "../../state/index.js";
import {
  HostBackupManifestSchema,
  applyApprovedHostScopedChanges,
  buildHostStagedDiffs,
  buildSanitizedEnv,
  checkScope,
  cleanupGitWorktree,
  computeFrozenSnapshot,
  detectFrozenFilesChanged,
  inspectGitWorktreeChanges,
  isHostTargetWithinScope,
  matchesAnyGlobPattern,
  normalizeRepoRelativePath,
  prepareGitWorktree,
  prepareScratchWorkspace,
  readHostBackupManifest,
  resolveCanonicalHostTarget,
  restoreHostScopedBackup,
  runIsolatedCommand,
  runVerificationGate,
  stageHostScopedChanges,
  verifyScratchWorkspace,
} from "../index.js";

const tempDirs: string[] = [];

function makeTempDir(prefix = "kiln-gate-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(args: readonly string[], cwd?: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function initGitRepoWithBareRemote(): {
  rootDir: string;
  bareRemotePath: string;
  repoPath: string;
  initialCommit: string;
} {
  const rootDir = makeTempDir("kiln-git-test-");
  const bareRemotePath = path.join(rootDir, "remote.git");
  const repoPath = path.join(rootDir, "repo");

  git(["init", "--bare", bareRemotePath]);
  git(["init", "-b", "main", repoPath]);
  git(["config", "user.name", "Kiln Test"], repoPath);
  git(["config", "user.email", "kiln-test@example.com"], repoPath);

  fs.writeFileSync(path.join(repoPath, ".gitignore"), ".env.local\nnode_modules/\n");
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, "src", "app.ts"), "export const ok = true;\n");
  fs.mkdirSync(path.join(repoPath, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(repoPath, "tests", "frozen.test.ts"),
    "export const frozenAssertion = 1;\n",
  );

  git(["add", "."], repoPath);
  git(["commit", "-m", "initial commit"], repoPath);
  git(["remote", "add", "origin", bareRemotePath], repoPath);
  git(["push", "-u", "origin", "main"], repoPath);

  const initialCommit = git(["rev-parse", "HEAD"], repoPath).trim();
  return { rootDir, bareRemotePath, repoPath, initialCommit };
}

function makeTaskCard(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    schema_version: 1,
    id: "t-201",
    title: "Gate verification test task",
    space: "kiln",
    priority: "P1",
    track: "L2",
    workspace_mode: "git_worktree",
    parent: null,
    depends_on: [],
    contract_version: 1,
    contract: {
      goal: "Verify gate safety invariants",
      end: "Gate passes deterministically",
      accept_cmd: "node -e \"process.exit(0)\"",
      accept_files_hash: "sha256:placeholder",
      scope: ["src/**"],
      deliver: { mode: "merge_main", cmd: null },
      human_accept: false,
      external_actions: "ask",
    },
    limits: {
      retries_per_stage: 2,
      review_rounds: 2,
      advisor_calls: 1,
      max_tokens: 100_000,
    },
    created_at: "2026-11-19T12:00:00.000Z",
    updated_at: "2026-11-19T12:00:00.000Z",
    ...overrides,
  };
}

function makeRunMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    schema_version: 1,
    run_id: "run-201",
    task_id: "t-201",
    stage: "implement",
    round: 1,
    role: "worker",
    contract_version: 1,
    backend_id: "fake",
    agent: "codex",
    model: "gpt-5.4",
    session_ref: { backendId: "fake", sessionId: "sess-201" },
    started_at: "2026-11-19T12:01:00.000Z",
    ...overrides,
  };
}

function makeWorkerReceiptMarkdown(overrides: {
  run_id?: string;
  contract_version?: number;
  outcome?: "completed" | "need_decision";
  input_ref?: string;
  output_ref?: string;
  changed_paths?: string[];
  accept_result?: "pass" | "fail" | "skipped";
  is_bugfix?: boolean;
  includeBugfixRepro?: boolean;
} = {}): string {
  const fm = {
    run_id: overrides.run_id ?? "run-201",
    contract_version: overrides.contract_version ?? 1,
    outcome: overrides.outcome ?? "completed",
    input_ref: overrides.input_ref ?? "HEAD",
    output_ref: overrides.output_ref ?? "HEAD",
    changed_paths: overrides.changed_paths ?? ["src/app.ts"],
    accept_result: overrides.accept_result ?? "pass",
    is_bugfix: overrides.is_bugfix ?? false,
    complexity_escalate: false,
  };

  const sections = [
    overrides.includeBugfixRepro
      ? "## 修前复现证据\n复现命令返回 exit code 1\n"
      : "",
    "## 改动说明\n完成实现改动\n",
    "## 验证命令与真实输出\nexit code 0\n",
    "## 未完成或待决问题\n无\n",
  ]
    .filter((s) => s.length > 0)
    .join("\n");

  return serializeFrontmatterMarkdown(fm, sections);
}

describe("scope & frozen snapshot", () => {
  it("normalizes POSIX relative paths and blocks traversal, NUL, and absolute paths", () => {
    expect(normalizeRepoRelativePath("./src\\gate/scope.ts")).toBe("src/gate/scope.ts");
    expect(normalizeRepoRelativePath("a//b/./c.ts")).toBe("a/b/c.ts");

    const invalidInputs = [
      "",
      "   ",
      ".",
      "./",
      "..",
      "../secret",
      "src/../../etc/passwd",
      "/etc/passwd",
      "\\Windows\\System32",
      "C:\\foo\\bar",
      "bad\0path",
      "bad\npath",
    ];
    for (const bad of invalidInputs) {
      expect(() => normalizeRepoRelativePath(bad)).toThrow();
    }
  });

  it("supports **, *, ?, braces, directory, and single-file patterns with fail-closed empty scope", () => {
    expect(matchesAnyGlobPattern("src/a.ts", ["src/**/a.ts"])).toBe(true);
    expect(matchesAnyGlobPattern("src/deep/sub/a.ts", ["src/**/a.ts"])).toBe(true);
    expect(matchesAnyGlobPattern("src/file1.ts", ["src/file?.ts"])).toBe(true);
    expect(matchesAnyGlobPattern("src/file12.ts", ["src/file?.ts"])).toBe(false);
    expect(matchesAnyGlobPattern("src/a.tsx", ["**/*.{ts,tsx}"])).toBe(true);
    expect(matchesAnyGlobPattern(".github/workflows/ci.yml", [".github/**"])).toBe(true);

    // Directory patterns (with and without trailing slash) vs single-file patterns
    expect(
      checkScope(
        ["packages/kernel/src/gate/scope.ts", "packages/kernel/src/index.ts"],
        ["packages/kernel/src/gate/", "packages/kernel/src/index.ts"],
      ),
    ).toEqual({ ok: true, outOfScopePaths: [] });

    expect(
      checkScope(
        ["packages/kernel/src/gate/scope.ts", "packages/kernel/src/store/paths.ts"],
        ["packages/kernel/src/gate"],
      ),
    ).toEqual({
      ok: false,
      outOfScopePaths: ["packages/kernel/src/store/paths.ts"],
    });

    // Fail-closed when scopePatterns is empty and changes exist
    expect(checkScope(["src/app.ts"], [])).toEqual({
      ok: false,
      outOfScopePaths: ["src/app.ts"],
    });

    expect(checkScope([], [])).toEqual({
      ok: true,
      outOfScopePaths: [],
    });
  });

  it("computes deterministic frozen snapshots and detects modifications or deletions even when receipt omits them", () => {
    const repo = makeTempDir("kiln-frozen-");
    fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
    const testA = path.join(repo, "tests", "a.test.ts");
    const testB = path.join(repo, "tests", "b.test.ts");
    fs.writeFileSync(testA, "expect(1).toBe(1);\n");
    fs.writeFileSync(testB, "expect(2).toBe(2);\n");

    const baseline1 = computeFrozenSnapshot(repo, ["tests/*.test.ts"], "pnpm test");
    const baseline2 = computeFrozenSnapshot(repo, ["tests/*.test.ts"], "pnpm test");
    expect(baseline1.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(baseline1.hash).toBe(baseline2.hash);
    expect(baseline1.files.map((f) => f.path)).toEqual([
      "tests/a.test.ts",
      "tests/b.test.ts",
    ]);

    // Different acceptCmd changes snapshot hash
    const diffCmd = computeFrozenSnapshot(repo, ["tests/*.test.ts"], "pnpm test --run");
    expect(diffCmd.hash).not.toBe(baseline1.hash);

    // Modify frozen file without reporting it in changedPaths
    fs.writeFileSync(testA, "expect(1).toBe(2); // loosened\n");
    const modDetection = detectFrozenFilesChanged({
      rootDir: repo,
      freezePatterns: ["tests/*.test.ts"],
      acceptCmd: "pnpm test",
      baselineHash: baseline1.hash,
      changedPaths: [], // Dishonest receipt omitted tests/a.test.ts
    });
    expect(modDetection.hashMatched).toBe(false);
    expect(modDetection.frozenFilesChanged.length).toBeGreaterThan(0);

    // Delete frozen file and verify detection both with baselineSnapshot and without it
    fs.rmSync(testA);
    const delDetectionWithoutBaseline = detectFrozenFilesChanged({
      rootDir: repo,
      freezePatterns: ["tests/*.test.ts"],
      acceptCmd: "pnpm test",
      baselineHash: baseline1.hash,
      changedPaths: [],
    });
    expect(delDetectionWithoutBaseline.hashMatched).toBe(false);
    expect(delDetectionWithoutBaseline.frozenFilesChanged.length).toBeGreaterThan(0);

    const delDetectionWithBaseline = detectFrozenFilesChanged({
      rootDir: repo,
      freezePatterns: ["tests/*.test.ts"],
      acceptCmd: "pnpm test",
      baselineHash: baseline1.hash,
      baselineSnapshot: baseline1,
    });
    expect(delDetectionWithBaseline.hashMatched).toBe(false);
    expect(delDetectionWithBaseline.frozenFilesChanged).toEqual(["tests/a.test.ts"]);
  });
});

describe("command-runner isolation & process group kill", () => {
  it("strips credential environment variables and forces GIT_TERMINAL_PROMPT=0", async () => {
    const cwd = makeTempDir("kiln-cmd-env-");
    const pollutedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? cwd,
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      SSH_AGENT_PID: "99999",
      GH_TOKEN: "ghp_secret",
      GITHUB_TOKEN: "ghp_secret2",
      NPM_TOKEN: "npm_secret",
      AWS_ACCESS_KEY_ID: "AKIA123",
      AWS_SECRET_ACCESS_KEY: "aws_secret",
      AWS_SESSION_TOKEN: "aws_sess",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/gcp.json",
      AZURE_CLIENT_SECRET: "azure_sec",
      DOCKER_PASSWORD: "docker_pw",
      PYPI_API_TOKEN: "pypi_tok",
      CARGO_REGISTRY_TOKEN: "cargo_tok",
      HOMEBREW_GITHUB_API_TOKEN: "brew_tok",
      GIT_ASKPASS: "/bin/false",
      SSH_ASKPASS: "/bin/false",
      KILN_RUN_TOKEN: "hmac_tok",
      CUSTOM_API_KEY: "k123",
      MY_SERVICE_SECRET: "s123",
      GIT_TERMINAL_PROMPT: "1",
    };

    const sanitized = buildSanitizedEnv(pollutedEnv, { KILN_SAFE_FLAG: "yes" });
    expect(sanitized.GIT_TERMINAL_PROMPT).toBe("0");
    expect(sanitized.KILN_SAFE_FLAG).toBe("yes");
    expect(sanitized.GH_TOKEN).toBeUndefined();
    expect(sanitized.SSH_AUTH_SOCK).toBeUndefined();
    expect(sanitized.KILN_RUN_TOKEN).toBeUndefined();
    expect(sanitized.CUSTOM_API_KEY).toBeUndefined();
    expect(sanitized.MY_SERVICE_SECRET).toBeUndefined();

    expect(() =>
      buildSanitizedEnv(pollutedEnv, { EXTRA_TOKEN: "nope" }),
    ).toThrow();

    const result = await runIsolatedCommand(
      `node -e 'console.log(JSON.stringify({
        gh: process.env.GH_TOKEN ?? null,
        ssh: process.env.SSH_AUTH_SOCK ?? null,
        aws: process.env.AWS_SECRET_ACCESS_KEY ?? null,
        runTok: process.env.KILN_RUN_TOKEN ?? null,
        customSec: process.env.MY_SERVICE_SECRET ?? null,
        prompt: process.env.GIT_TERMINAL_PROMPT ?? null,
        safe: process.env.KILN_SAFE_FLAG ?? null
      }))'`,
      {
        cwd,
        env: pollutedEnv,
        extraSafeEnv: { KILN_SAFE_FLAG: "yes" },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      gh: null,
      ssh: null,
      aws: null,
      runTok: null,
      customSec: null,
      prompt: "0",
      safe: "yes",
    });
  });

  async function expectProcessGone(pid: number, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe("ESRCH");
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(() => process.kill(pid, 0)).toThrow();
  }

  it("kills the entire process group including spawned grandchild processes on timeout", async () => {
    const cwd = makeTempDir("kiln-cmd-pgkill-");
    const pidFile = path.join(cwd, "grandchild.pid");
    const tickFile = path.join(cwd, "ticks.log");
    const scriptFile = path.join(cwd, "grandchild.cjs");

    fs.writeFileSync(
      scriptFile,
      [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        `setInterval(() => { fs.appendFileSync(${JSON.stringify(tickFile)}, "tick\\n"); }, 30);`,
      ].join("\n"),
    );

    // Spawn grandchild in background inside the shell's process group, then block in parent shell
    const command = `node ${JSON.stringify(scriptFile)} & wait`;

    const result = await runIsolatedCommand(command, {
      cwd,
      timeoutMs: 350,
    });

    expect(result.timedOut).toBe(true);
    expect(result.killedProcessGroup).toBe(true);
    expect(result.exitCode).not.toBe(0);

    // Confirm grandchild was actually started and then killed with the process group
    const grandchildPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(grandchildPid).toBeGreaterThan(0);

    await expectProcessGone(grandchildPid);

    const sizeAtKill = fs.existsSync(tickFile) ? fs.statSync(tickFile).size : 0;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const sizeLater = fs.existsSync(tickFile) ? fs.statSync(tickFile).size : 0;
    expect(sizeLater).toBe(sizeAtKill);
  });

  it("kills process group on AbortSignal abort with timedOut=false", async () => {
    const cwd = makeTempDir("kiln-cmd-abort-");
    const pidFile = path.join(cwd, "child.pid");
    const scriptFile = path.join(cwd, "sleeper.cjs");

    fs.writeFileSync(
      scriptFile,
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );

    const controller = new AbortController();
    const waitForPid = async (): Promise<void> => {
      for (let i = 0; i < 40; i++) {
        if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim().length > 0) {
          controller.abort();
          return;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      controller.abort();
    };

    const [result] = await Promise.all([
      runIsolatedCommand(`node ${JSON.stringify(scriptFile)}`, {
        cwd,
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
      waitForPid(),
    ]);

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.killedProcessGroup).toBe(true);
    expect(result.exitCode).not.toBe(0);

    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    await expectProcessGone(pid);
  });

  it("caps large command output without hanging or blowing memory", async () => {
    const cwd = makeTempDir("kiln-cmd-cap-");
    const result = await runIsolatedCommand(
      `node -e 'process.stdout.write("A".repeat(4096)); process.stderr.write("B".repeat(4096));'`,
      {
        cwd,
        maxOutputBytes: 512,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(512);
  });
});

describe("git_worktree isolation, pre-push hook, and safe cleanup", () => {
  it("prepares worktree with copy_untracked, clone_deps, and worktree-scoped pre-push block without polluting main repo", async () => {
    const { rootDir, repoPath } = initGitRepoWithBareRemote();
    fs.writeFileSync(path.join(repoPath, ".env.local"), "LOCAL_PORT=4310\n");
    fs.mkdirSync(path.join(repoPath, "node_modules", "demo-pkg"), { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, "node_modules", "demo-pkg", "index.js"),
      "module.exports = 42;\n",
    );

    const worktreePath = path.join(rootDir, "wt-task-1");
    const prep = await prepareGitWorktree({
      repoPath,
      worktreePath,
      branchName: "kiln/t-201",
      baseRef: "main",
      copyUntracked: [".env.local"],
      cloneDeps: ["node_modules"],
    });

    expect(fs.readFileSync(path.join(prep.worktreePath, ".env.local"), "utf8")).toBe(
      "LOCAL_PORT=4310\n",
    );
    expect(
      fs.readFileSync(
        path.join(prep.worktreePath, "node_modules", "demo-pkg", "index.js"),
        "utf8",
      ),
    ).toBe("module.exports = 42;\n");

    // Commit a change inside worktree and verify pre-push hook blocks push
    fs.writeFileSync(path.join(prep.worktreePath, "src", "app.ts"), "export const ok = 2;\n");
    git(["add", "src/app.ts"], prep.worktreePath);
    git(["commit", "-m", "worktree commit"], prep.worktreePath);

    expect(() =>
      git(["push", "origin", "kiln/t-201"], prep.worktreePath),
    ).toThrow();

    // Main repo hooks remain unpolluted and main repo can still push
    let mainHooksPath = "";
    try {
      mainHooksPath = git(["config", "--get", "core.hooksPath"], repoPath).trim();
    } catch {
      mainHooksPath = "";
    }
    expect(mainHooksPath).toBe("");

    fs.writeFileSync(path.join(repoPath, "src", "main-only.ts"), "export const m = 1;\n");
    git(["add", "src/main-only.ts"], repoPath);
    git(["commit", "-m", "main commit"], repoPath);
    expect(() => git(["push", "origin", "main"], repoPath)).not.toThrow();

    // Inspect changes relative to baseCommit
    const changesCleanCommit = await inspectGitWorktreeChanges(
      prep.worktreePath,
      prep.baseCommit,
    );
    expect(changesCleanCommit.changedPaths).toEqual(["src/app.ts"]);
    expect(changesCleanCommit.isDirty).toBe(false);

    // Untracked non-ignored dirty file blocks cleanup even in done+gatePassed
    const strayFile = path.join(prep.worktreePath, "stray-hand-edit.txt");
    fs.writeFileSync(strayFile, "unsaved manual edit\n");

    const dirtyCleanup = await cleanupGitWorktree({
      repoPath,
      worktreePath: prep.worktreePath,
      taskStatus: "done",
      gatePassed: true,
      awaitingHumanReview: false,
    });
    expect(dirtyCleanup).toEqual({
      deleted: false,
      retainedReason: "dirty_worktree",
      worktreePath: prep.worktreePath,
      dirtyPaths: ["stray-hand-edit.txt"],
    });
    expect(fs.existsSync(prep.worktreePath)).toBe(true);

    // Remove stray file; non-passed gate or awaiting review or non-terminal status still retains
    fs.rmSync(strayFile);

    const gateFailedCleanup = await cleanupGitWorktree({
      repoPath,
      worktreePath: prep.worktreePath,
      taskStatus: "done",
      gatePassed: false,
      awaitingHumanReview: false,
    });
    expect(gateFailedCleanup.deleted).toBe(false);
    expect(gateFailedCleanup.retainedReason).toBe("gate_not_passed");

    const reviewCleanup = await cleanupGitWorktree({
      repoPath,
      worktreePath: prep.worktreePath,
      taskStatus: "done",
      gatePassed: true,
      awaitingHumanReview: true,
    });
    expect(reviewCleanup.deleted).toBe(false);
    expect(reviewCleanup.retainedReason).toBe("awaiting_human_review");

    const runningCleanup = await cleanupGitWorktree({
      repoPath,
      worktreePath: prep.worktreePath,
      taskStatus: "running",
      gatePassed: true,
      awaitingHumanReview: false,
    });
    expect(runningCleanup.deleted).toBe(false);
    expect(runningCleanup.retainedReason).toBe("non_terminal_status");
    expect(fs.existsSync(prep.worktreePath)).toBe(true);

    // Clean terminal done + gatePassed removes worktree (even with gitignored .env.local & node_modules)
    const okCleanup = await cleanupGitWorktree({
      repoPath,
      worktreePath: prep.worktreePath,
      taskStatus: "done",
      gatePassed: true,
      awaitingHumanReview: false,
    });
    expect(okCleanup).toEqual({
      deleted: true,
      retainedReason: null,
      worktreePath: prep.worktreePath,
      dirtyPaths: [],
    });
    expect(fs.existsSync(prep.worktreePath)).toBe(false);
  });
});

describe("host_scoped two-stage staging, locking, rollback, and 409 hash conflict", () => {
  function setupHostStore(): { store: KilnStore; homeDir: string; hostRoot: string } {
    const base = makeTempDir("kiln-host-");
    const homeDir = path.join(base, "kiln-home");
    const hostRoot = path.join(base, "host-root");
    fs.mkdirSync(hostRoot, { recursive: true });
    const store = new KilnStore({ kilnHome: homeDir });
    return { store, homeDir, hostRoot };
  }

  it("blocks symlink escapes (including dangling symlinks) and resolves macOS /var -> /private/var canonically", () => {
    const base = makeTempDir("kiln-host-sym-");
    const allowedDir = path.join(base, "allowed");
    const outsideDir = path.join(base, "outside");
    fs.mkdirSync(allowedDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const outsideExisting = path.join(outsideDir, "secret.conf");
    fs.writeFileSync(outsideExisting, "secret=1\n");

    const symlinkToOutside = path.join(allowedDir, "escape.conf");
    fs.symlinkSync(outsideExisting, symlinkToOutside);

    const danglingEscape = path.join(allowedDir, "dangling-escape.conf");
    fs.symlinkSync(path.join(outsideDir, "future-secret.conf"), danglingEscape);

    const scope = [path.join(allowedDir, "**")];

    const canonicalNew = resolveCanonicalHostTarget(path.join(allowedDir, "sub", "new.conf"));
    expect(canonicalNew).toBe(path.join(fs.realpathSync(allowedDir), "sub", "new.conf"));
    expect(isHostTargetWithinScope(canonicalNew, scope)).toBe(true);

    const canonicalEscape = resolveCanonicalHostTarget(symlinkToOutside);
    expect(isHostTargetWithinScope(canonicalEscape, scope)).toBe(false);

    const canonicalDangling = resolveCanonicalHostTarget(danglingEscape);
    expect(isHostTargetWithinScope(canonicalDangling, scope)).toBe(false);
  });

  it("enforces two-stage approval, cross-task path locks, verify rollback, and 409 hash_mismatch protection", async () => {
    const { store, hostRoot } = setupHostStore();
    try {
      const allowedDir = path.join(hostRoot, "allowed");
      const outsideDir = path.join(hostRoot, "outside");
      fs.mkdirSync(allowedDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });

      const existingTarget = path.join(allowedDir, "app.conf");
      const originalContent = "mode=safe\nport=4310\n";
      fs.writeFileSync(existingTarget, originalContent);

      const newTarget = path.join(allowedDir, "nested", "extra.conf");

      const cardA = makeTaskCard({
        id: "t-host-a",
        workspace_mode: "host_scoped",
        track: "L1",
        contract: {
          goal: "Update host config",
          end: "Config applied",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:host",
          scope: [`${allowedDir}/**`],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      });
      const cardB = makeTaskCard({
        id: "t-host-b",
        workspace_mode: "host_scoped",
        track: "L1",
        contract: { ...cardA.contract },
      });
      store.createTask(cardA, "# Host A");
      store.createTask(cardB, "# Host B");

      // Prepare staged files for Task A & Task B
      writeFileAtomic(
        path.join(store.paths.stagedDir("t-host-a"), "app.conf"),
        "mode=updated\nport=4311\n",
      );
      writeFileAtomic(
        path.join(store.paths.stagedDir("t-host-a"), "extra.conf"),
        "created=true\n",
      );
      writeFileAtomic(
        path.join(store.paths.stagedDir("t-host-b"), "app.conf"),
        "mode=competing\n",
      );

      // Symlink escape inside staged/ is rejected
      const escapeLink = path.join(store.paths.stagedDir("t-host-b"), "evil-link");
      fs.symlinkSync("/etc/hosts", escapeLink);
      expect(() =>
        stageHostScopedChanges(store, {
          taskId: "t-host-b",
          contractScope: [`${allowedDir}/**`],
          stagedFiles: [{ stagedRelativePath: "evil-link", targetPath: existingTarget }],
        }),
      ).toThrow();

      // Out-of-scope host target via symlink is rejected
      const symlinkTarget = path.join(allowedDir, "out-link.conf");
      fs.symlinkSync(path.join(outsideDir, "nope.conf"), symlinkTarget);
      expect(() =>
        stageHostScopedChanges(store, {
          taskId: "t-host-a",
          contractScope: [`${allowedDir}/**`],
          stagedFiles: [{ stagedRelativePath: "app.conf", targetPath: symlinkTarget }],
        }),
      ).toThrow();

      // Stage Task A successfully -> requires approval, target NOT modified yet
      const stageResA = stageHostScopedChanges(store, {
        taskId: "t-host-a",
        contractScope: [`${allowedDir}/**`],
        stagedFiles: [
          { stagedRelativePath: "app.conf", targetPath: existingTarget },
          { stagedRelativePath: "extra.conf", targetPath: newTarget },
        ],
      });
      expect(stageResA.ok).toBe(true);
      if (!stageResA.ok) throw new Error("Expected stage A ok");
      expect(stageResA.requiresApproval).toBe(true);
      expect(stageResA.manifest.status).toBe("staged_awaiting_approval");
      expect(fs.readFileSync(existingTarget, "utf8")).toBe(originalContent);
      expect(fs.existsSync(newTarget)).toBe(false);

      // Task B trying to stage the same canonical path hits lock_conflict
      const stageResB = stageHostScopedChanges(store, {
        taskId: "t-host-b",
        contractScope: [`${allowedDir}/**`],
        stagedFiles: [{ stagedRelativePath: "app.conf", targetPath: existingTarget }],
      });
      expect(stageResB.ok).toBe(false);
      if (stageResB.ok) throw new Error("Expected lock conflict");
      expect(stageResB.reason).toBe("lock_conflict");
      expect(stageResB.conflicts[0]?.heldByTaskId).toBe("t-host-a");

      // Unapproved apply refuses and leaves files unchanged
      const unapprovedRes = await applyApprovedHostScopedChanges(store, {
        taskId: "t-host-a",
        approved: false,
      });
      expect(unapprovedRes.ok).toBe(false);
      if (unapprovedRes.ok) throw new Error("Expected not_approved");
      expect(unapprovedRes.reason).toBe("not_approved");
      expect(fs.readFileSync(existingTarget, "utf8")).toBe(originalContent);

      // Approved apply with failing verifyCmd rolls back existing file & deletes newly created file
      const failedVerifyRes = await applyApprovedHostScopedChanges(store, {
        taskId: "t-host-a",
        approved: true,
        verifyCmd: "node -e \"process.exit(2)\"",
      });
      expect(failedVerifyRes.ok).toBe(false);
      if (failedVerifyRes.ok || failedVerifyRes.reason !== "verify_failed_rolled_back") {
        throw new Error("Expected verify_failed_rolled_back");
      }
      expect(failedVerifyRes.manifest.status).toBe("rolled_back");
      expect(fs.readFileSync(existingTarget, "utf8")).toBe(originalContent);
      expect(fs.existsSync(newTarget)).toBe(false);
      expect(store.listHostPathLocks("t-host-a")).toEqual([]);

      // Re-stage and apply with passing verifyCmd
      const stageResA2 = stageHostScopedChanges(store, {
        taskId: "t-host-a",
        contractScope: [`${allowedDir}/**`],
        stagedFiles: [
          { stagedRelativePath: "app.conf", targetPath: existingTarget },
          { stagedRelativePath: "extra.conf", targetPath: newTarget },
        ],
      });
      expect(stageResA2.ok).toBe(true);

      const appliedRes = await applyApprovedHostScopedChanges(store, {
        taskId: "t-host-a",
        approved: true,
        verifyCmd: "node -e \"process.exit(0)\"",
      });
      expect(appliedRes.ok).toBe(true);
      if (!appliedRes.ok) throw new Error("Expected apply success");
      expect(appliedRes.manifest.status).toBe("applied");
      expect(fs.readFileSync(existingTarget, "utf8")).toBe("mode=updated\nport=4311\n");
      expect(fs.readFileSync(newTarget, "utf8")).toBe("created=true\n");
      expect(store.listHostPathLocks("t-host-a")).toEqual([]);

      // Verify persisted manifest.json conforms to HostBackupManifestSchema
      const persistedManifest = readHostBackupManifest(store, "t-host-a");
      expect(HostBackupManifestSchema.parse(persistedManifest).status).toBe("applied");

      // Simulate external edit after apply -> restore MUST return 409 hash_mismatch and NOT overwrite
      const humanEditedContent = "mode=updated\nport=9999\n";
      fs.writeFileSync(existingTarget, humanEditedContent);

      const conflictRestore = restoreHostScopedBackup(store, { taskId: "t-host-a" });
      expect(conflictRestore.ok).toBe(false);
      if (conflictRestore.ok || conflictRestore.reason !== "hash_mismatch") {
        throw new Error("Expected 409 hash_mismatch");
      }
      expect(conflictRestore.statusCode).toBe(409);
      expect(conflictRestore.conflicts).toHaveLength(1);
      expect(conflictRestore.conflicts[0]?.diff).toContain("-port=4311");
      expect(conflictRestore.conflicts[0]?.diff).toContain("+port=9999");
      expect(fs.readFileSync(existingTarget, "utf8")).toBe(humanEditedContent);
      expect(fs.readFileSync(newTarget, "utf8")).toBe("created=true\n");
      expect(store.listHostPathLocks("t-host-a")).toEqual([]);

      // Restore succeeds cleanly once target matches post_sha256
      fs.writeFileSync(existingTarget, "mode=updated\nport=4311\n");
      const cleanRestore = restoreHostScopedBackup(store, { taskId: "t-host-a" });
      expect(cleanRestore.ok).toBe(true);
      if (!cleanRestore.ok) throw new Error("Expected clean restore");
      expect(cleanRestore.statusCode).toBe(200);
      expect(cleanRestore.manifest.status).toBe("restored");
      expect(fs.readFileSync(existingTarget, "utf8")).toBe(originalContent);
      expect(fs.existsSync(newTarget)).toBe(false);
      expect(store.listHostPathLocks("t-host-a")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("buildHostStagedDiffs projects modified, new, binary, missing-backup, and truncated diffs only during staged_awaiting_approval", async () => {
    const { store, hostRoot } = setupHostStore();
    try {
      const allowedDir = path.join(hostRoot, "allowed");
      fs.mkdirSync(allowedDir, { recursive: true });

      const modTarget = path.join(allowedDir, "app.conf");
      const newTarget = path.join(allowedDir, "new.conf");
      const binTarget = path.join(allowedDir, "logo.bin");
      const largeLinesTarget = path.join(allowedDir, "many-lines.txt");
      const largeBytesTarget = path.join(allowedDir, "huge-bytes.txt");

      fs.writeFileSync(modTarget, "mode=before\nport=4310\n");
      fs.writeFileSync(binTarget, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
      fs.writeFileSync(
        largeLinesTarget,
        Array.from({ length: 240 }, (_, i) => `old-line-${i}`).join("\n") + "\n",
      );
      fs.writeFileSync(largeBytesTarget, "A".repeat(70 * 1024));

      const card = makeTaskCard({
        id: "t-host-diffs",
        workspace_mode: "host_scoped",
        track: "L1",
        contract: {
          goal: "Preview staged host diffs",
          end: "Diffs accurate and bounded",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:diffs",
          scope: [`${allowedDir}/**`],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      });
      store.createTask(card, "# Diffs");

      // No manifest yet -> []
      expect(buildHostStagedDiffs(store, card.id)).toEqual([]);

      const stagedDir = store.paths.stagedDir(card.id);
      writeFileAtomic(path.join(stagedDir, "app.conf"), "mode=after\nport=4311\n");
      writeFileAtomic(path.join(stagedDir, "new.conf"), "created=yes\nline2=ok\n");
      writeFileAtomic(
        path.join(stagedDir, "logo.bin"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02, 0x03]),
      );
      writeFileAtomic(
        path.join(stagedDir, "many-lines.txt"),
        Array.from({ length: 240 }, (_, i) => `new-line-${i}`).join("\n") + "\n",
      );
      writeFileAtomic(path.join(stagedDir, "huge-bytes.txt"), "B".repeat(70 * 1024));

      const stageRes = stageHostScopedChanges(store, {
        taskId: card.id,
        contractScope: card.contract.scope,
        stagedFiles: [
          { stagedRelativePath: "app.conf", targetPath: modTarget },
          { stagedRelativePath: "new.conf", targetPath: newTarget },
          { stagedRelativePath: "logo.bin", targetPath: binTarget },
          { stagedRelativePath: "many-lines.txt", targetPath: largeLinesTarget },
          { stagedRelativePath: "huge-bytes.txt", targetPath: largeBytesTarget },
        ],
      });
      expect(stageRes.ok).toBe(true);
      if (!stageRes.ok) throw new Error("Expected stage ok");

      const diffs = buildHostStagedDiffs(store, card.id);
      expect(diffs).toHaveLength(5);

      const modEntry = diffs.find((d) => d.targetPath === fs.realpathSync(modTarget))!;
      expect(modEntry.existedBefore).toBe(true);
      expect(modEntry.preSha256).toMatch(/^sha256:/);
      expect(modEntry.truncated).toBe(false);
      expect(modEntry.diff).toContain("-mode=before");
      expect(modEntry.diff).toContain("+mode=after");

      const newEntry = diffs.find((d) => d.targetPath.endsWith("/new.conf"))!;
      expect(newEntry.existedBefore).toBe(false);
      expect(newEntry.preSha256).toBeNull();
      expect(newEntry.truncated).toBe(false);
      expect(newEntry.diff).toContain("+created=yes");
      expect(newEntry.diff).toContain("+line2=ok");

      const binEntry = diffs.find((d) => d.targetPath === fs.realpathSync(binTarget))!;
      expect(binEntry.diff).toBe("[binary file diff omitted]");
      expect(binEntry.truncated).toBe(false);

      const manyLinesEntry = diffs.find((d) => d.targetPath === fs.realpathSync(largeLinesTarget))!;
      expect(manyLinesEntry.truncated).toBe(true);
      expect(manyLinesEntry.diff.split("\n").length).toBeLessThanOrEqual(200);

      const hugeBytesEntry = diffs.find((d) => d.targetPath === fs.realpathSync(largeBytesTarget))!;
      expect(hugeBytesEntry.truncated).toBe(true);
      expect(hugeBytesEntry.diff.split("\n").length).toBeLessThanOrEqual(200);

      // Missing backup file on disk must not throw
      const modBackupPath = path.join(
        store.paths.backupDir(card.id),
        stageRes.manifest.files[0]!.backup_relative_path!,
      );
      const savedBackup = fs.readFileSync(modBackupPath);
      fs.rmSync(modBackupPath);
      const missingBackupDiffs = buildHostStagedDiffs(store, card.id);
      expect(missingBackupDiffs[0]?.diff).toBe("[backup file unavailable]");
      writeFileAtomic(modBackupPath, savedBackup);

      // After approval apply (status === "applied"), returns []
      const applied = await applyApprovedHostScopedChanges(store, {
        taskId: card.id,
        approved: true,
      });
      expect(applied.ok).toBe(true);
      expect(buildHostStagedDiffs(store, card.id)).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("scratch_dir workspace & verification", () => {
  it("fails on missing, zero-byte, or escaping artifacts and passes when non-empty artifacts + acceptCmd pass", async () => {
    const homeDir = makeTempDir("kiln-scratch-home-");
    const store = new KilnStore({ kilnHome: homeDir });
    try {
      const card = makeTaskCard({
        id: "t-scratch-1",
        workspace_mode: "scratch_dir",
        track: "L1",
      });
      store.createTask(card, "# Scratch task");
      const wsDir = prepareScratchWorkspace(store, "t-scratch-1");
      expect(fs.existsSync(wsDir)).toBe(true);

      // Rejects traversal / absolute artifact specs
      await expect(
        verifyScratchWorkspace({
          workspaceDir: wsDir,
          expectedArtifacts: ["../escape.md"],
        }),
      ).rejects.toThrow();
      await expect(
        verifyScratchWorkspace({
          workspaceDir: wsDir,
          expectedArtifacts: ["/etc/passwd"],
        }),
      ).rejects.toThrow();

      // Missing artifact fails
      const missingRes = await verifyScratchWorkspace({
        workspaceDir: wsDir,
        expectedArtifacts: ["report.md"],
        acceptCmd: "node -e \"process.exit(0)\"",
      });
      expect(missingRes.ok).toBe(false);
      expect(missingRes.missingArtifacts).toEqual(["report.md"]);

      // Zero-byte artifact fails
      const reportPath = path.join(wsDir, "report.md");
      fs.writeFileSync(reportPath, "");
      const emptyRes = await verifyScratchWorkspace({
        workspaceDir: wsDir,
        expectedArtifacts: ["report.md"],
        acceptCmd: "node -e \"process.exit(0)\"",
      });
      expect(emptyRes.ok).toBe(false);
      expect(emptyRes.emptyArtifacts).toEqual(["report.md"]);

      // Non-empty artifact + passing accept_cmd succeeds
      fs.writeFileSync(reportPath, "# Summary\nAll good.\n");
      const okRes = await verifyScratchWorkspace({
        workspaceDir: wsDir,
        expectedArtifacts: ["report.md"],
        acceptCmd: "node -e \"const fs=require('fs'); process.exit(fs.readFileSync('report.md','utf8').length > 0 ? 0 : 1)\"",
      });
      expect(okRes.ok).toBe(true);
      expect(okRes.verifiedArtifacts).toEqual(["report.md"]);
      expect(okRes.acceptResult?.exitCode).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("runVerificationGate end-to-end", () => {
  it("rejects Post-MVP external_only explicitly", async () => {
    const homeDir = makeTempDir("kiln-gate-ext-");
    const store = new KilnStore({ kilnHome: homeDir });
    try {
      const card = makeTaskCard({
        id: "t-ext-1",
        workspace_mode: "external_only",
      });
      store.createTask(card, "# External");

      await expect(
        runVerificationGate(store, {
          taskId: "t-ext-1",
          runDirName: "001-implement",
        }),
      ).rejects.toThrow(/external_only/i);
    } finally {
      store.close();
    }
  });

  it("never trusts dishonest accept_result=pass when real accept_cmd exits non-zero and writes GATE.yaml", async () => {
    const { rootDir, repoPath, initialCommit } = initGitRepoWithBareRemote();
    const homeDir = makeTempDir("kiln-gate-lie-");
    const store = new KilnStore({ kilnHome: homeDir });
    try {
      const space: SpaceConfig = {
        schema_version: 1,
        id: "kiln",
        name: "Kiln",
        repo_path: repoPath,
        default_branch: "main",
        copy_untracked: [],
        clone_deps: [],
        freeze_patterns: ["tests/**"],
      };
      store.writeSpace(space);

      const acceptCmd = "node -e \"process.exit(1)\"";
      const snap = computeFrozenSnapshot(repoPath, ["tests/**"], acceptCmd);

      const card = makeTaskCard({
        id: "t-gate-lie",
        track: "L2",
        workspace_mode: "git_worktree",
        contract: {
          goal: "Must pass real test command",
          end: "Done",
          accept_cmd: acceptCmd,
          accept_files_hash: snap.hash,
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      });
      store.createTask(card, "# Task");

      const wtPath = path.join(rootDir, "wt-lie");
      const prep = await prepareGitWorktree({
        repoPath,
        worktreePath: wtPath,
        branchName: "kiln/t-gate-lie",
        baseRef: initialCommit,
      });

      fs.writeFileSync(path.join(prep.worktreePath, "src", "app.ts"), "export const ok = 99;\n");

      const runDirName = "001-implement";
      const runMeta = makeRunMeta({
        task_id: card.id,
        run_id: "run-lie-1",
        input_ref: prep.baseCommit,
      });
      store.persistRunBeforeDispatch(runMeta, runDirName);
      store.submitReceipt({
        taskId: card.id,
        runId: runMeta.run_id,
        contractVersion: 1,
        runDirName,
        markdown: makeWorkerReceiptMarkdown({
          run_id: runMeta.run_id,
          contract_version: 1,
          input_ref: prep.baseCommit,
          changed_paths: ["src/app.ts"],
          accept_result: "pass", // Dishonest pass!
        }),
      });

      const gateRes = await runVerificationGate(store, {
        taskId: card.id,
        runDirName,
        worktreePath: prep.worktreePath,
      });

      expect(gateRes.passed).toBe(false);
      expect(gateRes.report.schema_ok).toBe(true);
      expect(gateRes.report.scope_ok).toBe(true);
      expect(gateRes.report.accept_exit_code).toBe(1);
      expect(gateRes.report.escalated_to_l2).toBe(false);

      const persistedGate = readYamlValidated(gateRes.gatePath, GateReportSchema);
      expect(persistedGate.accept_exit_code).toBe(1);
      expect(persistedGate.run_id).toBe(runMeta.run_id);
    } finally {
      store.close();
    }
  });

  it("escalates L1 to L2 when frozen test is edited/deleted and blocks out-of-scope edits even if omitted from receipt", async () => {
    const { rootDir, repoPath, initialCommit } = initGitRepoWithBareRemote();
    const homeDir = makeTempDir("kiln-gate-escalate-");
    const store = new KilnStore({ kilnHome: homeDir });
    try {
      store.writeSpace({
        schema_version: 1,
        id: "kiln",
        name: "Kiln",
        repo_path: repoPath,
        default_branch: "main",
        copy_untracked: [],
        clone_deps: [],
        freeze_patterns: ["tests/**"],
      });

      const acceptCmd = "node -e \"process.exit(0)\"";
      const baseline = computeFrozenSnapshot(repoPath, ["tests/**"], acceptCmd);

      const card = makeTaskCard({
        id: "t-l1-tamper",
        track: "L1",
        workspace_mode: "git_worktree",
        contract: {
          goal: "Modify src only",
          end: "Tests pass",
          accept_cmd: acceptCmd,
          accept_files_hash: baseline.hash,
          scope: ["src/**", "tests/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      });
      store.createTask(card, "# L1 Tamper");

      const wtPath = path.join(rootDir, "wt-l1-tamper");
      const prep = await prepareGitWorktree({
        repoPath,
        worktreePath: wtPath,
        branchName: "kiln/t-l1-tamper",
        baseRef: initialCommit,
      });

      // Worker edits frozen test AND an out-of-scope file (README.md), but lies in RECEIPT.md
      fs.writeFileSync(path.join(prep.worktreePath, "tests", "frozen.test.ts"), "// tampered\n");
      fs.writeFileSync(path.join(prep.worktreePath, "README.md"), "# sneaky edit\n");

      const runDirName = "001-implement";
      const runMeta = makeRunMeta({
        task_id: card.id,
        run_id: "run-tamper-1",
        input_ref: prep.baseCommit,
      });
      store.persistRunBeforeDispatch(runMeta, runDirName);
      store.submitReceipt({
        taskId: card.id,
        runId: runMeta.run_id,
        contractVersion: 1,
        runDirName,
        markdown: makeWorkerReceiptMarkdown({
          run_id: runMeta.run_id,
          contract_version: 1,
          input_ref: prep.baseCommit,
          changed_paths: ["src/app.ts"], // Omitted tests/frozen.test.ts and README.md!
          accept_result: "pass",
        }),
      });

      const gateRes = await runVerificationGate(store, {
        taskId: card.id,
        runDirName,
        worktreePath: prep.worktreePath,
      });

      expect(gateRes.passed).toBe(false);
      expect(gateRes.report.scope_ok).toBe(false);
      expect(gateRes.report.out_of_scope_paths).toEqual(["README.md"]);
      expect(gateRes.report.frozen_files_changed).toEqual(["tests/frozen.test.ts"]);
      expect(gateRes.report.escalated_to_l2).toBe(true);

      const persistedGate = readYamlValidated(gateRes.gatePath, GateReportSchema);
      expect(persistedGate.escalated_to_l2).toBe(true);
      expect(persistedGate.frozen_files_changed).toEqual(["tests/frozen.test.ts"]);
    } finally {
      store.close();
    }
  });

  it("rejects bugfix receipt lacking pre-fix reproduction evidence and mismatched run_id", async () => {
    const { rootDir, repoPath, initialCommit } = initGitRepoWithBareRemote();
    const homeDir = makeTempDir("kiln-gate-schema-");
    const store = new KilnStore({ kilnHome: homeDir });
    try {
      const card = makeTaskCard({ id: "t-bugfix-1" });
      store.createTask(card, "# Bugfix");

      const wtPath = path.join(rootDir, "wt-bugfix");
      const prep = await prepareGitWorktree({
        repoPath,
        worktreePath: wtPath,
        branchName: "kiln/t-bugfix-1",
        baseRef: initialCommit,
      });

      const runDirName = "001-implement";
      const runMeta = makeRunMeta({
        task_id: card.id,
        run_id: "run-bug-1",
        input_ref: prep.baseCommit,
      });
      store.persistRunBeforeDispatch(runMeta, runDirName);
      store.submitReceipt({
        taskId: card.id,
        runId: runMeta.run_id,
        contractVersion: 1,
        runDirName,
        markdown: makeWorkerReceiptMarkdown({
          run_id: runMeta.run_id,
          contract_version: 1,
          is_bugfix: true,
          includeBugfixRepro: false,
        }),
      });

      const gateRes = await runVerificationGate(store, {
        taskId: card.id,
        runDirName,
        worktreePath: prep.worktreePath,
      });

      expect(gateRes.passed).toBe(false);
      expect(gateRes.report.schema_ok).toBe(false);
      expect(gateRes.schemaErrors.some((e) => e.includes("修前复现证据"))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("detects frozen test deletion in git_worktree and mismatched run_id in receipt", async () => {
    const { rootDir, repoPath, initialCommit } = initGitRepoWithBareRemote();
    const homeDir = makeTempDir("kiln-gate-del-");
    const store = new KilnStore({ kilnHome: homeDir });
    try {
      store.writeSpace({
        schema_version: 1,
        id: "kiln",
        name: "Kiln",
        repo_path: repoPath,
        default_branch: "main",
        copy_untracked: [],
        clone_deps: [],
        freeze_patterns: ["tests/**"],
      });

      const acceptCmd = "node -e \"process.exit(0)\"";
      const baseline = computeFrozenSnapshot(repoPath, ["tests/**"], acceptCmd);

      const card = makeTaskCard({
        id: "t-del-frozen",
        track: "L1",
        workspace_mode: "git_worktree",
        contract: {
          goal: "Keep tests intact",
          end: "Done",
          accept_cmd: acceptCmd,
          accept_files_hash: baseline.hash,
          scope: ["src/**", "tests/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      });
      store.createTask(card, "# Delete frozen test");

      const wtPath = path.join(rootDir, "wt-del");
      const prep = await prepareGitWorktree({
        repoPath,
        worktreePath: wtPath,
        branchName: "kiln/t-del-frozen",
        baseRef: initialCommit,
      });

      // Delete frozen test and commit without reporting in receipt
      fs.rmSync(path.join(prep.worktreePath, "tests", "frozen.test.ts"));
      git(["add", "-A"], prep.worktreePath);
      git(["commit", "-m", "delete test"], prep.worktreePath);

      const runDirName = "001-implement";
      const runMeta = makeRunMeta({
        task_id: card.id,
        run_id: "run-del-1",
        input_ref: prep.baseCommit,
      });
      store.persistRunBeforeDispatch(runMeta, runDirName);
      store.submitReceipt({
        taskId: card.id,
        runId: runMeta.run_id,
        contractVersion: 1,
        runDirName,
        markdown: makeWorkerReceiptMarkdown({
          run_id: runMeta.run_id,
          contract_version: 1,
          input_ref: prep.baseCommit,
          changed_paths: [],
          accept_result: "pass",
        }),
      });

      const gateRes = await runVerificationGate(store, {
        taskId: card.id,
        runDirName,
        worktreePath: prep.worktreePath,
      });
      expect(gateRes.report.frozen_files_changed).toEqual(["tests/frozen.test.ts"]);
      expect(gateRes.report.escalated_to_l2).toBe(true);

      // Mismatched run_id inside RECEIPT.md fails schema validation
      writeFileAtomic(
        store.paths.receiptMd(card.id, runDirName),
        makeWorkerReceiptMarkdown({
          run_id: "forged-run-id",
          contract_version: 1,
        }),
      );
      const forgedGate = await runVerificationGate(store, {
        taskId: card.id,
        runDirName,
        worktreePath: prep.worktreePath,
      });
      expect(forgedGate.passed).toBe(false);
      expect(forgedGate.report.schema_ok).toBe(false);
      expect(forgedGate.schemaErrors.some((e) => e.includes("run_id"))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("verifies scratch_dir and host_scoped tasks end-to-end through runVerificationGate", async () => {
    const homeDir = makeTempDir("kiln-gate-modes-");
    const hostRoot = makeTempDir("kiln-gate-host-");
    const store = new KilnStore({ kilnHome: homeDir });
    try {
      // 1. scratch_dir end-to-end
      const scratchCard = makeTaskCard({
        id: "t-gate-scratch",
        track: "L1",
        workspace_mode: "scratch_dir",
        contract: {
          goal: "Produce non-empty summary",
          end: "Artifact exists",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:scratch",
          scope: ["summary.md"],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      });
      store.createTask(scratchCard, "# Scratch");
      const wsDir = prepareScratchWorkspace(store, scratchCard.id);
      fs.writeFileSync(path.join(wsDir, "summary.md"), "findings\n");

      const scratchRunMeta = makeRunMeta({
        task_id: scratchCard.id,
        run_id: "run-scratch-1",
      });
      store.persistRunBeforeDispatch(scratchRunMeta, "001-implement");
      store.submitReceipt({
        taskId: scratchCard.id,
        runId: scratchRunMeta.run_id,
        contractVersion: 1,
        runDirName: "001-implement",
        markdown: makeWorkerReceiptMarkdown({
          run_id: scratchRunMeta.run_id,
          changed_paths: ["summary.md"],
        }),
      });

      const scratchPass = await runVerificationGate(store, {
        taskId: scratchCard.id,
        runDirName: "001-implement",
        expectedArtifacts: ["summary.md"],
      });
      expect(scratchPass.passed).toBe(true);
      expect(scratchPass.report.scope_ok).toBe(true);
      expect(scratchPass.report.accept_exit_code).toBe(0);

      // Missing artifact causes gate to fail
      const scratchFail = await runVerificationGate(store, {
        taskId: scratchCard.id,
        runDirName: "001-implement",
        expectedArtifacts: ["missing.md"],
      });
      expect(scratchFail.passed).toBe(false);

      // 2. host_scoped end-to-end
      const targetFile = path.join(hostRoot, "settings.json");
      fs.writeFileSync(targetFile, '{"ok":false}\n');
      const hostCard = makeTaskCard({
        id: "t-gate-host",
        track: "L1",
        workspace_mode: "host_scoped",
        contract: {
          goal: "Update settings.json",
          end: "Updated",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:host",
          scope: [`${hostRoot}/**`],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      });
      store.createTask(hostCard, "# Host");
      writeFileAtomic(
        path.join(store.paths.stagedDir(hostCard.id), "settings.json"),
        '{"ok":true}\n',
      );
      const stagedRes = stageHostScopedChanges(store, {
        taskId: hostCard.id,
        contractScope: hostCard.contract.scope,
        stagedFiles: [{ stagedRelativePath: "settings.json", targetPath: targetFile }],
      });
      expect(stagedRes.ok).toBe(true);

      const hostRunMeta = makeRunMeta({
        task_id: hostCard.id,
        run_id: "run-host-1",
      });
      store.persistRunBeforeDispatch(hostRunMeta, "001-implement");
      store.submitReceipt({
        taskId: hostCard.id,
        runId: hostRunMeta.run_id,
        contractVersion: 1,
        runDirName: "001-implement",
        markdown: makeWorkerReceiptMarkdown({
          run_id: hostRunMeta.run_id,
          changed_paths: ["settings.json"],
        }),
      });

      const hostGate = await runVerificationGate(store, {
        taskId: hostCard.id,
        runDirName: "001-implement",
      });
      expect(hostGate.passed).toBe(true);
      expect(hostGate.report.scope_ok).toBe(true);
    } finally {
      store.close();
    }
  });

  it("handles cancelled git_worktree cleanup and host_scoped pre_hash_mismatch TOCTOU guard", async () => {
    const { rootDir, repoPath, initialCommit } = initGitRepoWithBareRemote();
    const wtPath = path.join(rootDir, "wt-cancel");
    const prep = await prepareGitWorktree({
      repoPath,
      worktreePath: wtPath,
      branchName: "kiln/t-cancel",
      baseRef: initialCommit,
    });

    // Dirty cancelled worktree is retained
    fs.writeFileSync(path.join(prep.worktreePath, "uncommitted.txt"), "keep me\n");
    const dirtyCancel = await cleanupGitWorktree({
      repoPath,
      worktreePath: prep.worktreePath,
      taskStatus: "cancelled",
      gatePassed: false,
      awaitingHumanReview: false,
    });
    expect(dirtyCancel.deleted).toBe(false);
    expect(dirtyCancel.retainedReason).toBe("dirty_worktree");

    // Clean cancelled worktree can be deleted even with gatePassed=false
    fs.rmSync(path.join(prep.worktreePath, "uncommitted.txt"));
    const cleanCancel = await cleanupGitWorktree({
      repoPath,
      worktreePath: prep.worktreePath,
      taskStatus: "cancelled",
      gatePassed: false,
      awaitingHumanReview: false,
    });
    expect(cleanCancel.deleted).toBe(true);
    expect(fs.existsSync(prep.worktreePath)).toBe(false);

    // host_scoped TOCTOU guard: external edit between stage and apply aborts apply
    const homeDir = makeTempDir("kiln-host-toctou-");
    const hostRoot = makeTempDir("kiln-host-toctou-target-");
    const store = new KilnStore({ kilnHome: homeDir });
    try {
      const target = path.join(hostRoot, "rc.conf");
      fs.writeFileSync(target, "v1\n");
      const card = makeTaskCard({
        id: "t-toctou",
        workspace_mode: "host_scoped",
        contract: {
          goal: "Test TOCTOU",
          end: "Safe",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:t",
          scope: [`${hostRoot}/**`],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      });
      store.createTask(card, "# TOCTOU");
      writeFileAtomic(path.join(store.paths.stagedDir(card.id), "rc.conf"), "v2\n");
      stageHostScopedChanges(store, {
        taskId: card.id,
        contractScope: card.contract.scope,
        stagedFiles: [{ stagedRelativePath: "rc.conf", targetPath: target }],
      });

      // External actor edits target before approval apply
      fs.writeFileSync(target, "external-v1.5\n");
      const toctouRes = await applyApprovedHostScopedChanges(store, {
        taskId: card.id,
        approved: true,
      });
      expect(toctouRes.ok).toBe(false);
      if (toctouRes.ok) throw new Error("Expected pre_hash_mismatch");
      expect(toctouRes.reason).toBe("pre_hash_mismatch");
      expect(fs.readFileSync(target, "utf8")).toBe("external-v1.5\n");
      // pre_hash_mismatch preserves lock while manifest remains staged_awaiting_approval
      expect(store.listHostPathLocks(card.id)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("closes all M1-S3 Round 1 P0/P1/P2 gate invariants cleanly", async () => {
    // 1. scratch_dir: missing artifact sets report.artifacts_ok=false -> evaluateWorkerStageOutcome blocks advancing;
    //    real out-of-scope file written in workspaceDir + empty scope [] fail closed even if receipt lies changed_paths=[]
    const homeDir = makeTempDir("kiln-gate-p0-");
    let store = new KilnStore({ kilnHome: homeDir });
    try {
      const scratchCard = makeTaskCard({
        id: "t-scratch-fail",
        track: "L1",
        workspace_mode: "scratch_dir",
        contract: {
          goal: "Produce artifact",
          end: "Non-empty artifact",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:s1",
          scope: [],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      });
      store.createTask(scratchCard, "# Scratch P0");
      const wsDir = prepareScratchWorkspace(store, scratchCard.id);
      fs.writeFileSync(path.join(wsDir, "unreported.txt"), "secret out of scope");
      const outsideSecret = path.join(makeTempDir("kiln-scratch-outside-"), "outside.txt");
      fs.writeFileSync(outsideSecret, "leak");
      fs.symlinkSync(outsideSecret, path.join(wsDir, "escape-link.txt"));

      const runMeta = makeRunMeta({ task_id: scratchCard.id, run_id: "run-sc-p0" });
      store.persistRunBeforeDispatch(runMeta, "001-implement");
      store.submitReceipt({
        taskId: scratchCard.id,
        runId: runMeta.run_id,
        contractVersion: 1,
        runDirName: "001-implement",
        markdown: makeWorkerReceiptMarkdown({
          run_id: runMeta.run_id,
          changed_paths: [],
          accept_result: "pass",
        }),
      });

      const gateRes = await runVerificationGate(store, {
        taskId: scratchCard.id,
        runDirName: "001-implement",
        expectedArtifacts: ["missing.md"],
      });
      expect(gateRes.passed).toBe(false);
      expect(gateRes.report.artifacts_ok).toBe(false);
      expect(gateRes.report.scope_ok).toBe(false);
      expect(gateRes.report.out_of_scope_paths).toContain("unreported.txt");
      expect(gateRes.report.out_of_scope_paths).toContain("escape-link.txt");

      // Even if scope were valid, artifacts_ok=false still blocks stage advance in evaluateWorkerStageOutcome
      const outcome = evaluateWorkerStageOutcome(
        scratchCard,
        {
          run_id: runMeta.run_id,
          contract_version: 1,
          outcome: "completed",
          input_ref: "n/a",
          output_ref: "n/a",
          changed_paths: [],
          accept_result: "pass",
          is_bugfix: false,
          complexity_escalate: false,
        },
        { ...gateRes.report, scope_ok: true, out_of_scope_paths: [] },
        { stageRetries: 0, reviewRounds: 0, advisorCalls: 0, totalTokens: 100 },
      );
      expect(outcome.action).toBe("retry_stage");
      expect(outcome.gatePassed).toBe(false);

      // 2. git_worktree: missing authoritative inputRef fails closed; git mv out-of-scope -> in-scope caught via --no-renames
      const { rootDir, repoPath, initialCommit } = initGitRepoWithBareRemote();
      const wtPath = path.join(rootDir, "wt-mv");
      const prep = await prepareGitWorktree({
        repoPath,
        worktreePath: wtPath,
        branchName: "kiln/t-mv",
        baseRef: initialCommit,
      });

      const mvCard = makeTaskCard({ id: "t-mv" });
      store.createTask(mvCard, "# git mv test");
      // RunMeta without input_ref
      store.persistRunBeforeDispatch(
        makeRunMeta({ task_id: mvCard.id, run_id: "run-mv-1" }),
        "001-implement",
      );
      store.submitReceipt({
        taskId: mvCard.id,
        runId: "run-mv-1",
        contractVersion: 1,
        runDirName: "001-implement",
        markdown: makeWorkerReceiptMarkdown({
          run_id: "run-mv-1",
          input_ref: "HEAD",
        }),
      });

      await expect(
        runVerificationGate(store, {
          taskId: mvCard.id,
          runDirName: "001-implement",
          worktreePath: prep.worktreePath,
        }),
      ).rejects.toThrow(/inputRef/i);

      // Commit a git mv from tests/frozen.test.ts (outside scope src/**) into src/moved.ts (inside scope)
      git(["mv", "tests/frozen.test.ts", "src/moved.ts"], prep.worktreePath);
      git(["commit", "-m", "move out-of-scope file into scope"], prep.worktreePath);
      const mvGate = await runVerificationGate(store, {
        taskId: mvCard.id,
        runDirName: "001-implement",
        worktreePath: prep.worktreePath,
        inputRef: initialCommit,
      });
      expect(mvGate.passed).toBe(false);
      expect(mvGate.report.scope_ok).toBe(false);
      expect(mvGate.report.out_of_scope_paths).toContain("tests/frozen.test.ts");

      // 3. host_scoped: files in staged/ without manifest fail closed, POSIX mode 0o600 preserved,
      //    and pre_hash_mismatch + disk rebuild preserves lock cleanly without crash
      const hostDir = makeTempDir("kiln-host-mode-");
      const secretConf = path.join(hostDir, "secret.conf");
      fs.writeFileSync(secretConf, "secret=1\n");
      fs.chmodSync(secretConf, 0o600);
      const canonicalSecret = fs.realpathSync(secretConf);

      const hostModeCard = makeTaskCard({
        id: "t-host-mode",
        workspace_mode: "host_scoped",
        contract: {
          goal: "Keep mode 0600",
          end: "Mode preserved",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:hm",
          scope: [canonicalSecret],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      });
      store.createTask(hostModeCard, "# Host mode");
      writeFileAtomic(path.join(store.paths.stagedDir(hostModeCard.id), "secret.conf"), "secret=2\n");

      store.persistRunBeforeDispatch(
        makeRunMeta({ task_id: hostModeCard.id, run_id: "run-hm-1" }),
        "001-implement",
      );
      store.submitReceipt({
        taskId: hostModeCard.id,
        runId: "run-hm-1",
        contractVersion: 1,
        runDirName: "001-implement",
        markdown: makeWorkerReceiptMarkdown({
          run_id: "run-hm-1",
          changed_paths: [canonicalSecret],
        }),
      });

      // Without manifest.json, self-reporting a whitelisted path must NOT bypass staged/ check
      const noManifestGate = await runVerificationGate(store, {
        taskId: hostModeCard.id,
        runDirName: "001-implement",
      });
      expect(noManifestGate.report.scope_ok).toBe(false);
      expect(noManifestGate.report.out_of_scope_paths).toContain("secret.conf");

      // Now stage with manifest -> 0o600 mode captured, apply -> preserves 0o600, restore -> preserves 0o600
      const staged = stageHostScopedChanges(store, {
        taskId: hostModeCard.id,
        contractScope: [canonicalSecret],
        stagedFiles: [{ stagedRelativePath: "secret.conf", targetPath: secretConf }],
      });
      expect(staged.ok).toBe(true);

      // Compete with t-host-other after pre_hash_mismatch -> lock still held -> rebuild works without duplicate error
      const hostCompeteCard = makeTaskCard({
        id: "t-host-compete",
        workspace_mode: "host_scoped",
        contract: {
          goal: "Compete",
          end: "Blocked",
          accept_cmd: "echo ok",
          accept_files_hash: "sha256:hc",
          scope: [canonicalSecret],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      });
      store.createTask(hostCompeteCard, "# Compete");

      fs.writeFileSync(secretConf, "secret=external\n");
      fs.chmodSync(secretConf, 0o600);
      const mismatchApply = await applyApprovedHostScopedChanges(store, {
        taskId: hostModeCard.id,
        approved: true,
      });
      expect(mismatchApply.ok).toBe(false);
      expect(store.listHostPathLocks(hostModeCard.id)).toHaveLength(1);

      writeFileAtomic(path.join(store.paths.stagedDir(hostCompeteCard.id), "secret.conf"), "secret=3\n");
      const competeStage = stageHostScopedChanges(store, {
        taskId: hostCompeteCard.id,
        contractScope: [canonicalSecret],
        stagedFiles: [{ stagedRelativePath: "secret.conf", targetPath: secretConf }],
      });
      expect(competeStage).toEqual({
        ok: false,
        reason: "lock_conflict",
        conflicts: [{ path: canonicalSecret, heldByTaskId: hostModeCard.id }],
      });

      store.rebuildIndexFromDisk();
      expect(store.listHostPathLocks(hostModeCard.id)).toHaveLength(1);

      // Reset target to original v1 (pre_sha256 match) -> apply preserves 0o600 -> restore preserves 0o600
      fs.writeFileSync(secretConf, "secret=1\n");
      fs.chmodSync(secretConf, 0o600);
      const applied = await applyApprovedHostScopedChanges(store, {
        taskId: hostModeCard.id,
        approved: true,
      });
      expect(applied.ok).toBe(true);
      expect(fs.statSync(canonicalSecret).mode & 0o777).toBe(0o600);

      const restored = restoreHostScopedBackup(store, { taskId: hostModeCard.id });
      expect(restored.ok).toBe(true);
      expect(fs.readFileSync(canonicalSecret, "utf8")).toBe("secret=1\n");
      expect(fs.statSync(canonicalSecret).mode & 0o777).toBe(0o600);
    } finally {
      store.close();
    }
  });

  it("handles host_scoped empty staged/, invalid host paths/scopes, and missing RECEIPT.md safely without uncaught throws", async () => {
    const kilnHome = makeTempDir("kiln-gate-neg-");
    const hostDir = makeTempDir("kiln-host-neg-");
    const targetFile = path.join(hostDir, "good.conf");
    fs.writeFileSync(targetFile, "ok=1\n");
    const canonicalTarget = fs.realpathSync(targetFile);

    const store = new KilnStore({ kilnHome });
    try {
      // 1. Empty staged/ + no manifest + self-reported whitelisted path -> fail closed
      const emptyStagedCard = makeTaskCard({
        id: "t-host-empty-staged",
        workspace_mode: "host_scoped",
        contract: {
          goal: "Fail closed when staged/ is empty",
          end: "Self-reported paths rejected",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:neg1",
          scope: [canonicalTarget],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      });
      store.createTask(emptyStagedCard, "# Empty staged");
      store.persistRunBeforeDispatch(
        makeRunMeta({ task_id: emptyStagedCard.id, run_id: "run-empty-1" }),
        "001-implement",
      );
      store.submitReceipt({
        taskId: emptyStagedCard.id,
        runId: "run-empty-1",
        contractVersion: 1,
        runDirName: "001-implement",
        markdown: makeWorkerReceiptMarkdown({
          run_id: "run-empty-1",
          changed_paths: [canonicalTarget],
        }),
      });
      const emptyStagedGate = await runVerificationGate(store, {
        taskId: emptyStagedCard.id,
        runDirName: "001-implement",
      });
      expect(emptyStagedGate.passed).toBe(false);
      expect(emptyStagedGate.report.scope_ok).toBe(false);
      expect(emptyStagedGate.report.out_of_scope_paths).toContain(canonicalTarget);

      // 2. Invalid path in hostChangedPaths / receipt.changed_paths (caught, no uncaught throw)
      const invalidPathGate = await runVerificationGate(store, {
        taskId: emptyStagedCard.id,
        runDirName: "001-implement",
        hostChangedPaths: ["relative/invalid.conf"],
      });
      expect(invalidPathGate.passed).toBe(false);
      expect(invalidPathGate.report.scope_ok).toBe(false);
      expect(invalidPathGate.report.out_of_scope_paths).toContain("relative/invalid.conf");

      // 3. Misconfigured relative scope in host_scoped card -> isHostTargetWithinScope error caught & persisted
      const badScopeCard = makeTaskCard({
        id: "t-host-bad-scope",
        workspace_mode: "host_scoped",
        contract: {
          goal: "Catch bad host scope",
          end: "GATE.yaml persisted",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:neg2",
          scope: ["relative/foo.conf"],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      });
      store.createTask(badScopeCard, "# Bad host scope");
      store.persistRunBeforeDispatch(
        makeRunMeta({ task_id: badScopeCard.id, run_id: "run-bad-scope-1" }),
        "001-implement",
      );
      store.submitReceipt({
        taskId: badScopeCard.id,
        runId: "run-bad-scope-1",
        contractVersion: 1,
        runDirName: "001-implement",
        markdown: makeWorkerReceiptMarkdown({
          run_id: "run-bad-scope-1",
          changed_paths: [canonicalTarget],
        }),
      });
      const badScopeGate = await runVerificationGate(store, {
        taskId: badScopeCard.id,
        runDirName: "001-implement",
        hostChangedPaths: [canonicalTarget],
      });
      expect(badScopeGate.passed).toBe(false);
      expect(badScopeGate.report.scope_ok).toBe(false);
      expect(badScopeGate.report.out_of_scope_paths).toContain(canonicalTarget);

      // 4. Missing RECEIPT.md -> fails schema gate cleanly without ENOENT throw
      store.persistRunBeforeDispatch(
        makeRunMeta({ task_id: emptyStagedCard.id, run_id: "run-no-receipt-2", round: 2 }),
        "002-implement",
      );
      const missingReceiptGate = await runVerificationGate(store, {
        taskId: emptyStagedCard.id,
        runDirName: "002-implement",
      });
      expect(missingReceiptGate.passed).toBe(false);
      expect(missingReceiptGate.report.schema_ok).toBe(false);
      expect(missingReceiptGate.schemaErrors[0]).toContain("Missing RECEIPT.md");
      expect(fs.existsSync(missingReceiptGate.gatePath)).toBe(true);

      // 5. Existing manifest MUST still reject extra unmanifested files placed in staged/
      const partialTarget = path.join(hostDir, "mapped.conf");
      fs.writeFileSync(partialTarget, "a=1\n");
      const canonicalMapped = fs.realpathSync(partialTarget);
      const partialCard = makeTaskCard({
        id: "t-host-stray-staged",
        workspace_mode: "host_scoped",
        contract: {
          goal: "Reject stray staged file even when manifest exists",
          end: "scope_ok false",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:neg3",
          scope: [canonicalMapped],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
      });
      store.createTask(partialCard, "# Partial");
      writeFileAtomic(path.join(store.paths.stagedDir(partialCard.id), "mapped.conf"), "a=2\n");
      const partialStage = stageHostScopedChanges(store, {
        taskId: partialCard.id,
        contractScope: partialCard.contract.scope,
        stagedFiles: [{ stagedRelativePath: "mapped.conf", targetPath: canonicalMapped }],
      });
      expect(partialStage.ok).toBe(true);
      writeFileAtomic(path.join(store.paths.stagedDir(partialCard.id), "stray.txt"), "evil=1\n");
      store.persistRunBeforeDispatch(
        makeRunMeta({ task_id: partialCard.id, run_id: "run-stray-1" }),
        "001-implement",
      );
      store.submitReceipt({
        taskId: partialCard.id,
        runId: "run-stray-1",
        contractVersion: 1,
        runDirName: "001-implement",
        markdown: makeWorkerReceiptMarkdown({
          run_id: "run-stray-1",
          changed_paths: [canonicalMapped],
        }),
      });
      const strayGate = await runVerificationGate(store, {
        taskId: partialCard.id,
        runDirName: "001-implement",
      });
      expect(strayGate.passed).toBe(false);
      expect(strayGate.report.scope_ok).toBe(false);
      expect(strayGate.report.out_of_scope_paths).toContain("stray.txt");
    } finally {
      store.close();
    }
  });
});
