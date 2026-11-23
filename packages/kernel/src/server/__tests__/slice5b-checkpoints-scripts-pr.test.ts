import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  RosterConfigSchema,
  RunAntiDriftSummarySchema,
  RunSpaceScriptResponseSchema,
  createDefaultBuiltinRosterMetadata,
  type BackendCapabilities,
  type RunEvent,
  type SessionRef,
  type SseEvent,
} from "@kiln/protocol";
import {
  BackendRegistry,
  type BackendRunSpec,
  type ExecutionBackend,
} from "../../backend/index.js";
import { cleanupTaskCheckpoints } from "../../gate/index.js";
import { KilnStore, writeFileAtomic } from "../../store/index.js";
import { KilndServer, type PrDeliverExecFn } from "../index.js";

const execFileAsync = promisify(execFile);

const VALID_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

function makeTempDir(prefix = "kiln-slice5b-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createFakeGitRepo(
  repoPath: string,
  options?: { withBareOrigin?: boolean },
): { bareOriginPath?: string } {
  fs.mkdirSync(repoPath, { recursive: true });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# repo\n", "utf8");
  fs.writeFileSync(path.join(repoPath, ".gitignore"), ".env\nnode_modules/\n.setup-ran\n", "utf8");
  execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Kiln Test"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoPath, "config", "user.email", "test@kiln.local"], {
    stdio: "pipe",
  });
  execFileSync("git", ["-C", repoPath, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", repoPath, "commit", "-m", "init"], { stdio: "pipe" });

  if (options?.withBareOrigin) {
    const bareOriginPath = `${repoPath}-origin.git`;
    execFileSync("git", ["init", "--bare", bareOriginPath], { stdio: "pipe" });
    execFileSync("git", ["-C", repoPath, "remote", "add", "origin", bareOriginPath], {
      stdio: "pipe",
    });
    execFileSync("git", ["-C", repoPath, "push", "-u", "origin", "main"], { stdio: "pipe" });
    return { bareOriginPath };
  }
  return {};
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

class ScriptedSlice5bBackend implements ExecutionBackend {
  readonly backendId = "scripted";
  readonly startedSpecs: BackendRunSpec[] = [];
  private seq = 0;

  constructor(
    private readonly onTurn: (spec: BackendRunSpec, ref: SessionRef) => Promise<void> | void,
    private readonly reuseProbeAlive = true,
  ) {}

  async listAgents() {
    const caps = await this.capabilities("codex");
    return ["codex", "pi"].map((id) => ({
      id,
      label: id,
      capabilities: caps,
      modes: [{ id: "default", label: "Default", isFullAccess: false }],
      defaultModeId: "default",
    }));
  }

  async listModels() {
    return [{ id: "gpt-5.4", label: "gpt-5.4", thinkingOptions: [] }];
  }

  async capabilities(_agent: string): Promise<BackendCapabilities> {
    return {
      interactiveChat: true,
      approvals: false,
      mcpInjection: true,
      usageCacheBreakdown: false,
      interrupt: false,
      imageInput: true,
      readOnlySandbox: false,
    };
  }

  async start(runSpec: BackendRunSpec): Promise<SessionRef> {
    this.seq += 1;
    this.startedSpecs.push(runSpec);
    return {
      backendId: this.backendId,
      sessionId: `sess-${this.seq}`,
      meta: { providerSessionId: `native-sess-${this.seq}` },
    };
  }

  async send(): Promise<void> {}

  async *events(sessionRef: SessionRef): AsyncIterable<RunEvent> {
    const idx = Number(sessionRef.sessionId.split("-").pop() ?? "1") - 1;
    const spec = this.startedSpecs[idx]!;
    await this.onTurn(spec, sessionRef);
    yield {
      kind: "message",
      at: new Date().toISOString(),
      text: `ok ${spec.role}`,
    };
    yield {
      kind: "exit",
      at: new Date().toISOString(),
      reason: "completed",
    };
  }

  onApproval(): () => void {
    return () => {};
  }

  async answer(): Promise<void> {}
  async cancel(): Promise<void> {}
  async probe(sessionRef: SessionRef) {
    return {
      alive: this.reuseProbeAlive,
      status: "idle" as const,
      activeTurnId: null,
      detail: sessionRef.sessionId,
    };
  }
  async liveViewUrl(): Promise<string | null> {
    return null;
  }
  async dispose(): Promise<void> {}
}

function findRunDirById(store: KilnStore, taskId: string, runId: string): string {
  const dir = store.paths.runsDir(taskId);
  for (const name of fs.readdirSync(dir)) {
    const runYaml = path.join(dir, name, "RUN.yaml");
    if (fs.existsSync(runYaml) && fs.readFileSync(runYaml, "utf8").includes(runId)) {
      return name;
    }
  }
  throw new Error(`Missing runDir for ${runId}`);
}

function writeWorkerReceipt(store: KilnStore, spec: BackendRunSpec, changedPaths: string[]): void {
  const handoffDir = path.join(
    store.paths.runsDir(spec.taskId),
    findRunDirById(store, spec.taskId, spec.runId),
  );
  const md = [
    "---",
    "schema_version: 1",
    `task_id: "${spec.taskId}"`,
    `run_id: "${spec.runId}"`,
    `contract_version: 1`,
    `outcome: "completed"`,
    `input_ref: "HEAD"`,
    `output_ref: "HEAD"`,
    `changed_paths: ${JSON.stringify(changedPaths)}`,
    `accept_result: "pass"`,
    "---",
    "## 改动说明",
    "",
    "已写入目标产物。",
    "",
    "## 验证命令与真实输出",
    "",
    "test -f app.txt -> ok",
    "",
    "## 未完成或待决问题",
    "",
    "无",
    "",
  ].join("\n");
  writeFileAtomic(path.join(handoffDir, "RECEIPT.md"), md);
}

describe("Slice 5b: Implicit Git Checkpoints, Streaming Scripts, Commit->Push->PR & Anti-Drift Summary", () => {
  const tempDirs: string[] = [];
  const servers: KilndServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()!.stop();
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("captures hidden pre/post checkpoints, runs setup script automatically, exposes antiDriftSummary, supports rollback keeping gitignored .env, and GCs refs on archive", async () => {
    const root = makeTempDir("kiln-ckpt-");
    tempDirs.push(root);
    const kilnHome = path.join(root, "kiln-home");
    const repoPath = path.join(root, "repo");
    createFakeGitRepo(repoPath);

    let storeRef!: KilnStore;
    const backend = new ScriptedSlice5bBackend((spec) => {
      if (spec.role === "worker") {
        // Note .setup-ran should already exist from automatic space.scripts.setup!
        expect(fs.existsSync(path.join(spec.cwd, ".setup-ran"))).toBe(true);
        fs.writeFileSync(path.join(spec.cwd, "app.txt"), "v1-from-worker\n", "utf8");
        writeWorkerReceipt(storeRef, spec, ["app.txt"]);
      }
    });
    const registry = new BackendRegistry();
    registry.register(backend);

    const server = new KilndServer({
      kilnHome,
      port: 0,
      enableOrchestrator: true,
      backendRegistry: registry,
      tokenSecret: "slice5b-ckpt-secret-0123456789abc",
    });
    storeRef = server.store;
    servers.push(server);

    const sseEvents: SseEvent[] = [];
    server.sseHub.subscribe((ev) => sseEvents.push(ev));

    const baseRoster = createDefaultBuiltinRosterMetadata();
    server.store.writeConfig(
      "roster",
      RosterConfigSchema.parse({
        schema_version: 2,
        heterogeneous_review: false,
        roster: {
          ...baseRoster,
          main_dev: {
            ...baseRoster.main_dev,
            enabled: true,
            primary: { provider: "codex", model: "gpt-5.4" },
          },
        },
      }),
    );

    await server.start();

    // Configure space with setup script + pinned via HTTP PUT
    const spaceRes = await server.app.request(
      new Request("http://127.0.0.1/api/spaces/demo", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Demo",
          repo_path: repoPath,
          pinned: true,
          scripts: {
            setup: "echo setup-ok > .setup-ran",
          },
        }),
      }),
    );
    expect(spaceRes.status).toBe(201);
    const savedSpace = server.store.readSpace("demo");
    expect(savedSpace?.pinned).toBe(true);
    expect(savedSpace?.scripts?.setup).toBe("echo setup-ok > .setup-ran");

    // Create task with human_accept=true so worktree pauses at waiting for rollback inspection before archive cleanup
    await server.app.request(
      new Request("http://127.0.0.1/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "d-ckpt", space: "demo", title: "Checkpoint E2E" }),
      }),
    );
    const commitRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-ckpt/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "t-ckpt-1",
          space: "demo",
          track: "L1",
          workspace_mode: "git_worktree",
          contract: {
            goal: "Build app.txt with checkpoint coverage",
            end: "app.txt exists",
            accept_cmd: "test -f app.txt",
            accept_files_hash: "pending",
            scope: ["app.txt"],
            non_goals: ["不改 README.md"],
            deliver: { mode: "merge_main" },
            human_accept: true,
          },
          brief_markdown: "# Brief\nTest implicit checkpoints",
        }),
      }),
    );
    expect(commitRes.status).toBe(201);

    await waitUntil(() => server.store.getTaskIndex("t-ckpt-1")?.status === "waiting");

    // Verify setup script streamed script.output events
    expect(
      sseEvents.some((e) => e.type === "script.output" && e.scriptKey === "setup" && e.done === true),
    ).toBe(true);

    const detailRes = await server.app.request(new Request("http://127.0.0.1/api/tasks/t-ckpt-1"));
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      checkpoints: Array<{ ref: string; commit_sha: string }>;
      runs: Array<{
        meta: { run_id: string; checkpoint_ref?: string } | null;
        antiDriftSummary?: unknown;
      }>;
    };

    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]!.meta?.checkpoint_ref).toMatch(
      /^refs\/kiln\/checkpoints\/t-ckpt-1\/.+-pre$/,
    );
    const parsedAntiDrift = RunAntiDriftSummarySchema.parse(detail.runs[0]!.antiDriftSummary);
    expect(parsedAntiDrift.gate_proof).toEqual({
      schema_ok: true,
      scope_ok: true,
      frozen_ok: true,
      accept_ok: true,
    });
    expect(parsedAntiDrift.alignment_points.some((p) => p.includes("非目标护栏"))).toBe(true);

    // Both -pre and -post checkpoints should exist under hidden refs in chronological (-pre before -post) order, without polluting HEAD log
    expect(detail.checkpoints).toHaveLength(2);
    expect(detail.checkpoints[0]!.ref.endsWith("-pre")).toBe(true);
    expect(detail.checkpoints[1]!.ref.endsWith("-post")).toBe(true);
    const postCkpt = detail.checkpoints[1]!;
    const preCkpt = detail.checkpoints[0]!;

    const worktreePath = path.join(server.store.paths.workspaceDir("t-ckpt-1"), "worktree");
    const logCount = execFileSync("git", ["-C", worktreePath, "rev-list", "--count", "HEAD"], {
      encoding: "utf8",
    }).trim();
    // Initial commit (1) + implement auto-commit (1) = 2 (no checkpoint commits on HEAD!)
    expect(Number(logCount)).toBe(2);

    // Dirty worktree post-checkpoint + add rogue untracked file + add gitignored .env
    fs.writeFileSync(path.join(worktreePath, "app.txt"), "corrupted-later\n", "utf8");
    fs.writeFileSync(path.join(worktreePath, "rogue.txt"), "should-be-cleaned\n", "utf8");
    fs.writeFileSync(path.join(worktreePath, ".env"), "LOCAL_SECRET=keep\n", "utf8");

    // Cross-task checkpoint ref injection MUST be rejected 400
    const badRollback = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-ckpt-1/checkpoints/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkpoint_ref: "refs/kiln/checkpoints/other-task/run-1-pre",
          confirm: true,
        }),
      }),
    );
    expect(badRollback.status).toBe(400);

    // Missing confirm: true MUST be rejected 400
    const unconfirmedRollback = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-ckpt-1/checkpoints/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkpoint_ref: postCkpt!.ref,
        }),
      }),
    );
    expect(unconfirmedRollback.status).toBe(400);

    // Roll back to -post -> restores v1-from-worker, cleans rogue.txt, preserves gitignored .env
    const rollPostRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-ckpt-1/checkpoints/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkpoint_ref: postCkpt!.ref,
          confirm: true,
        }),
      }),
    );
    expect(rollPostRes.status).toBe(200);
    expect(fs.readFileSync(path.join(worktreePath, "app.txt"), "utf8")).toBe("v1-from-worker\n");
    expect(fs.existsSync(path.join(worktreePath, "rogue.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(worktreePath, ".env"), "utf8")).toBe("LOCAL_SECRET=keep\n");

    // Roll back to -pre -> removes app.txt (which didn't exist pre-implement) while keeping .env
    const rollPreRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-ckpt-1/checkpoints/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkpoint_ref: preCkpt!.ref,
          confirm: true,
        }),
      }),
    );
    expect(rollPreRes.status).toBe(200);
    expect(fs.existsSync(path.join(worktreePath, "app.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(worktreePath, ".env"), "utf8")).toBe("LOCAL_SECRET=keep\n");

    const stateEvents = server.store.readStateEvents("t-ckpt-1");
    expect(stateEvents.filter((e) => e.type === "checkpoint_rolled_back")).toHaveLength(2);

    // Verify cleanupTaskCheckpoints removes all hidden refs cleanly
    const deletedCount = await cleanupTaskCheckpoints(repoPath, "t-ckpt-1");
    expect(deletedCount).toBeGreaterThanOrEqual(2);
    const afterGcRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-ckpt-1/checkpoints"),
    );
    const afterGcJson = (await afterGcRes.json()) as { checkpoints: unknown[] };
    expect(afterGcJson.checkpoints).toHaveLength(0);
  });

  it("streams project scripts over SSE without node-pty, strips sensitive env vars, and stops child trees", async () => {
    const root = makeTempDir("kiln-scripts-");
    tempDirs.push(root);
    const kilnHome = path.join(root, "kiln-home");
    const repoPath = path.join(root, "repo");
    createFakeGitRepo(repoPath);

    const server = new KilndServer({
      kilnHome,
      port: 0,
      enableOrchestrator: false,
      tokenSecret: "slice5b-script-secret-0123456789a",
    });
    servers.push(server);

    const scriptEvents: Array<Extract<SseEvent, { type: "script.output" }>> = [];
    server.sseHub.subscribe((ev) => {
      if (ev.type === "script.output") {
        scriptEvents.push(ev);
      }
    });

    await server.start();

    const prevGhToken = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "super-secret-gh-token";
    try {
      const putSpace = await server.app.request(
        new Request("http://127.0.0.1/api/spaces/proj", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Proj",
            repo_path: repoPath,
            scripts: {
              test: `${JSON.stringify(process.execPath)} -e "console.log('STDOUT_OK'); console.error('STDERR_OK');"`,
              lint: `${JSON.stringify(process.execPath)} -e "console.log(process.env.GH_TOKEN || 'STRIPPED')"`,
              dev: `${JSON.stringify(process.execPath)} -e "console.log('DEV_STARTED'); setInterval(()=>{}, 1000)"`,
            },
          }),
        }),
      );
      expect(putSpace.status).toBe(201);

      // Unconfigured script key MUST fail 400 script_not_configured
      const unconfigured = await server.app.request(
        new Request("http://127.0.0.1/api/spaces/proj/scripts/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ script: "deliver" }),
        }),
      );
      expect(unconfigured.status).toBe(400);
      expect(((await unconfigured.json()) as { error: string }).error).toBe("script_not_configured");

      // Run test & lint scripts and wait for done SSE events
      const runTest = await server.app.request(
        new Request("http://127.0.0.1/api/spaces/proj/scripts/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ script: "test" }),
        }),
      );
      expect(runTest.status).toBe(202);
      const testMeta = RunSpaceScriptResponseSchema.parse(await runTest.json());

      const runLint = await server.app.request(
        new Request("http://127.0.0.1/api/spaces/proj/scripts/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ script: "lint" }),
        }),
      );
      expect(runLint.status).toBe(202);
      const lintMeta = RunSpaceScriptResponseSchema.parse(await runLint.json());

      await waitUntil(
        () =>
          scriptEvents.some((e) => e.scriptRunId === testMeta.scriptRunId && e.done === true) &&
          scriptEvents.some((e) => e.scriptRunId === lintMeta.scriptRunId && e.done === true),
      );

      const testOut = scriptEvents
        .filter((e) => e.scriptRunId === testMeta.scriptRunId)
        .map((e) => e.chunk)
        .join("");
      expect(testOut).toContain("STDOUT_OK");
      expect(testOut).toContain("STDERR_OK");

      const lintOut = scriptEvents
        .filter((e) => e.scriptRunId === lintMeta.scriptRunId)
        .map((e) => e.chunk)
        .join("");
      expect(lintOut).toContain("STRIPPED");
      expect(lintOut).not.toContain("super-secret-gh-token");

      // Start long-running dev script, verify listing, then stop via POST /api/scripts/:id/stop
      const runDev = await server.app.request(
        new Request("http://127.0.0.1/api/spaces/proj/scripts/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ script: "dev" }),
        }),
      );
      expect(runDev.status).toBe(202);
      const devMeta = RunSpaceScriptResponseSchema.parse(await runDev.json());
      await waitUntil(() =>
        scriptEvents.some(
          (e) => e.scriptRunId === devMeta.scriptRunId && e.chunk.includes("DEV_STARTED"),
        ),
      );

      const listRes = await server.app.request(new Request("http://127.0.0.1/api/scripts?spaceId=proj"));
      expect(listRes.status).toBe(200);
      const listJson = (await listRes.json()) as {
        runs: Array<{ scriptRunId: string; running: boolean }>;
      };
      expect(listJson.runs.find((r) => r.scriptRunId === devMeta.scriptRunId)?.running).toBe(true);

      const stopRes = await server.app.request(
        new Request(`http://127.0.0.1/api/scripts/${devMeta.scriptRunId}/stop`, { method: "POST" }),
      );
      expect(stopRes.status).toBe(200);
      await waitUntil(() =>
        scriptEvents.some((e) => e.scriptRunId === devMeta.scriptRunId && e.done === true),
      );
    } finally {
      if (prevGhToken === undefined) {
        delete process.env.GH_TOKEN;
      } else {
        process.env.GH_TOKEN = prevGhToken;
      }
    }
  });

  it("supports human-approved idempotent Commit -> Push -> Open PR delivery without duplicate pushes or PRs", async () => {
    const root = makeTempDir("kiln-pr-");
    tempDirs.push(root);
    const kilnHome = path.join(root, "kiln-home");
    const repoPath = path.join(root, "repo");
    const { bareOriginPath } = createFakeGitRepo(repoPath, { withBareOrigin: true });

    let storeRef!: KilnStore;
    const backend = new ScriptedSlice5bBackend((spec) => {
      if (spec.role === "worker") {
        fs.writeFileSync(path.join(spec.cwd, "app.txt"), "feature\n", "utf8");
        writeWorkerReceipt(storeRef, spec, ["app.txt"]);
      }
    });
    const registry = new BackendRegistry();
    registry.register(backend);

    const ghCalls: string[][] = [];
    let prCreatedUrl: string | null = null;
    const prDeliverExec: PrDeliverExecFn = async (file, args, options) => {
      if (file === "gh") {
        ghCalls.push([...args]);
        if (args[0] === "pr" && args[1] === "list") {
          return {
            stdout: prCreatedUrl
              ? JSON.stringify([{ url: prCreatedUrl, number: 42, title: "[t-pr-1] PR Test" }])
              : "[]",
            stderr: "",
          };
        }
        if (args[0] === "pr" && args[1] === "create") {
          prCreatedUrl = "https://github.com/zzf2333/Kiln/pull/42";
          return { stdout: `${prCreatedUrl}\n`, stderr: "" };
        }
      }
      const res = await execFileAsync(file, [...args], {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        encoding: "utf8",
      });
      return { stdout: res.stdout, stderr: res.stderr };
    };

    const server = new KilndServer({
      kilnHome,
      port: 0,
      enableOrchestrator: true,
      backendRegistry: registry,
      prDeliverExec,
      tokenSecret: "slice5b-pr-secret-0123456789abcd",
    });
    storeRef = server.store;
    servers.push(server);

    const baseRoster = createDefaultBuiltinRosterMetadata();
    server.store.writeConfig(
      "roster",
      RosterConfigSchema.parse({
        schema_version: 2,
        heterogeneous_review: false,
        roster: {
          ...baseRoster,
          main_dev: {
            ...baseRoster.main_dev,
            enabled: true,
            primary: { provider: "codex", model: "gpt-5.4" },
          },
        },
      }),
    );

    await server.start();

    server.store.writeSpace({
      schema_version: 1,
      id: "demo",
      name: "Demo",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });

    await server.app.request(
      new Request("http://127.0.0.1/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "d-pr", space: "demo", title: "Open PR Flow" }),
      }),
    );
    await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-pr/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "t-pr-1",
          space: "demo",
          track: "L1",
          workspace_mode: "git_worktree",
          contract: {
            goal: "Ship feature via PR",
            end: "PR opened",
            accept_cmd: "test -f app.txt",
            accept_files_hash: "pending",
            scope: ["app.txt"],
            non_goals: ["不改 README.md"],
            deliver: { mode: "open_pr" },
            external_actions: "ask",
          },
          brief_markdown: "# Brief\nOpen PR flow test",
        }),
      }),
    );

    await waitUntil(() => server.store.getTaskIndex("t-pr-1")?.status === "waiting");

    // Verify editable PR draft content
    const draftRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-pr-1/deliver/pr-draft"),
    );
    expect(draftRes.status).toBe(200);
    const prDraft = (await draftRes.json()) as {
      draft: { branch: string; baseBranch: string; title: string; body: string };
    };
    expect(prDraft.draft.branch).toBe("kiln/t-pr-1");
    expect(prDraft.draft.baseBranch).toBe("main");
    expect(prDraft.draft.body).toContain("Ship feature via PR");
    expect(prDraft.draft.body).toContain("确定性门禁证据");

    // Mutate worktree to test dirty_worktree guard + manual human commit
    const worktreePath = path.join(server.store.paths.workspaceDir("t-pr-1"), "worktree");
    fs.writeFileSync(path.join(worktreePath, "notes.txt"), "human tweak\n", "utf8");

    // Missing confirm: true rejected 400
    const noConfirm = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-pr-1/deliver/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "commit" }),
      }),
    );
    expect(noConfirm.status).toBe(400);

    // Push while dirty MUST return 409 dirty_worktree
    const dirtyPush = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-pr-1/deliver/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "push", confirm: true }),
      }),
    );
    expect(dirtyPush.status).toBe(409);
    expect(((await dirtyPush.json()) as { error: string }).error).toBe("dirty_worktree");

    // Open PR before push MUST return 409 branch_not_pushed
    const prePushPr = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-pr-1/deliver/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "open_pr", confirm: true }),
      }),
    );
    expect(prePushPr.status).toBe(409);
    expect(((await prePushPr.json()) as { error: string }).error).toBe("branch_not_pushed");

    // 1. Commit (dirty -> clean) then retry idempotently
    const commitAction1 = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-pr-1/deliver/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "commit", confirm: true }),
      }),
    );
    expect(commitAction1.status).toBe(200);
    const c1Json = (await commitAction1.json()) as { alreadyClean: boolean; commitSha: string };
    expect(c1Json.alreadyClean).toBe(false);

    const commitAction2 = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-pr-1/deliver/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "commit", confirm: true }),
      }),
    );
    const c2Json = (await commitAction2.json()) as { alreadyClean: boolean };
    expect(c2Json.alreadyClean).toBe(true);

    // 2. Push to real bare origin (bypasses agent pre-push hook cleanly), retry hits alreadyUpToDate
    const push1 = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-pr-1/deliver/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "push", confirm: true }),
      }),
    );
    expect(push1.status).toBe(200);
    const p1Json = (await push1.json()) as { alreadyUpToDate: boolean; commitSha: string };
    expect(p1Json.alreadyUpToDate).toBe(false);
    const remoteBranchHead = execFileSync(
      "git",
      ["--git-dir", bareOriginPath!, "rev-parse", "refs/heads/kiln/t-pr-1"],
      { encoding: "utf8" },
    ).trim();
    expect(remoteBranchHead).toBe(p1Json.commitSha);

    const push2 = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-pr-1/deliver/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "push", confirm: true }),
      }),
    );
    expect(((await push2.json()) as { alreadyUpToDate: boolean }).alreadyUpToDate).toBe(true);

    // 3. Open PR twice -> gh pr create called ONLY ONCE thanks to gh pr list probe
    const pr1 = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-pr-1/deliver/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "open_pr", confirm: true }),
      }),
    );
    expect(pr1.status).toBe(200);
    const pr1Json = (await pr1.json()) as { alreadyExists: boolean; prUrl: string; prNumber: number };
    expect(pr1Json.alreadyExists).toBe(false);
    expect(pr1Json.prUrl).toBe("https://github.com/zzf2333/Kiln/pull/42");
    expect(pr1Json.prNumber).toBe(42);

    const pr2 = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-pr-1/deliver/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "open_pr", confirm: true }),
      }),
    );
    const pr2Json = (await pr2.json()) as { alreadyExists: boolean; prUrl: string };
    expect(pr2Json.alreadyExists).toBe(true);
    expect(pr2Json.prUrl).toBe("https://github.com/zzf2333/Kiln/pull/42");
    expect(ghCalls.filter((args) => args[0] === "pr" && args[1] === "create")).toHaveLength(1);
  });

  it("invalidates stale intake chat session reuse when draft attachments change between turns", async () => {
    const root = makeTempDir("kiln-chat-att-");
    tempDirs.push(root);
    const kilnHome = path.join(root, "kiln-home");

    const backend = new ScriptedSlice5bBackend(() => {}, true);
    const registry = new BackendRegistry();
    registry.register(backend);

    const server = new KilndServer({
      kilnHome,
      port: 0,
      enableOrchestrator: false,
      backendRegistry: registry,
      tokenSecret: "slice5b-chat-secret-0123456789abc",
    });
    servers.push(server);

    const baseRoster = createDefaultBuiltinRosterMetadata();
    server.store.writeConfig(
      "roster",
      RosterConfigSchema.parse({
        schema_version: 2,
        roster: {
          ...baseRoster,
          pm: {
            ...baseRoster.pm,
            enabled: true,
            primary: { provider: "codex", model: "gpt-5.4" },
          },
        },
      }),
    );

    await server.start();

    await server.app.request(
      new Request("http://127.0.0.1/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "d-chat-att", space: "local", title: "Turn 2 attachment" }),
      }),
    );

    // Turn 1: no attachments
    const turn1 = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-chat-att/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "First turn without image" }),
      }),
    );
    expect(turn1.status).toBe(200);
    expect(backend.startedSpecs).toHaveLength(1);
    expect(backend.startedSpecs[0]!.attachments).toBeUndefined();

    // Upload image attachment after Turn 1
    const upRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-chat-att/attachments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "turn2.png",
          mime_type: "image/png",
          data_base64: VALID_PNG_BYTES.toString("base64"),
        }),
      }),
    );
    expect(upRes.status).toBe(201);

    // Turn 2: session MUST NOT reuse turn 1 session because attachment signature changed
    const turn2 = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-chat-att/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Now look at this screenshot" }),
      }),
    );
    expect(turn2.status).toBe(200);
    expect(backend.startedSpecs).toHaveLength(2);
    expect(backend.startedSpecs[1]!.attachments).toHaveLength(1);
    expect(backend.startedSpecs[1]!.attachments![0]!.filename).toBe("turn2.png");
  });

  it("cleans up half-created worktree when setup throws, falls back to repo_path after cleanup, and GCs checkpoints on done", async () => {
    const root = makeTempDir("kiln-setup-err-");
    tempDirs.push(root);
    const kilnHome = path.join(root, "kiln-home");
    const repoPath = path.join(root, "repo");
    createFakeGitRepo(repoPath);

    let storeRef!: KilnStore;
    const backend = new ScriptedSlice5bBackend((spec) => {
      if (spec.role === "worker") {
        expect(fs.existsSync(path.join(spec.cwd, ".setup-ran"))).toBe(true);
        fs.writeFileSync(path.join(spec.cwd, "app.txt"), "built\n", "utf8");
        writeWorkerReceipt(storeRef, spec, ["app.txt"]);
      }
    });
    const registry = new BackendRegistry();
    registry.register(backend);

    const server = new KilndServer({
      kilnHome,
      port: 0,
      enableOrchestrator: true,
      backendRegistry: registry,
      tokenSecret: "slice5b-setup-err-0123456789abc",
    });
    storeRef = server.store;
    servers.push(server);

    const baseRoster = createDefaultBuiltinRosterMetadata();
    server.store.writeConfig(
      "roster",
      RosterConfigSchema.parse({
        schema_version: 2,
        heterogeneous_review: false,
        roster: {
          ...baseRoster,
          main_dev: {
            ...baseRoster.main_dev,
            enabled: true,
            primary: { provider: "codex", model: "gpt-5.4" },
          },
        },
      }),
    );

    await server.start();

    // Fill script runner concurrency pool by running 8 dev scripts before creating task -> setup throws 429 too_many_scripts
    server.store.writeSpace({
      schema_version: 1,
      id: "demo",
      name: "Demo",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
      scripts: {
        setup: "echo setup-ok > .setup-ran",
        dev: `${JSON.stringify(process.execPath)} -e "setInterval(()=>{}, 1000)"`,
        test: `${JSON.stringify(process.execPath)} -e "console.log('CWD=' + process.cwd())"`,
      },
    });

    const devIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await server.app.request(
        new Request("http://127.0.0.1/api/spaces/demo/scripts/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ script: "dev" }),
        }),
      );
      expect(r.status).toBe(202);
      devIds.push(((await r.json()) as { scriptRunId: string }).scriptRunId);
    }

    await server.app.request(
      new Request("http://127.0.0.1/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "d-setup-fail", space: "demo", title: "Setup fail cleanup" }),
      }),
    );
    await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-setup-fail/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "t-setup-fail",
          space: "demo",
          track: "L1",
          workspace_mode: "git_worktree",
          contract: {
            goal: "Test setup exception cleanup & done GC",
            end: "done cleanly",
            accept_cmd: "test -f app.txt",
            accept_files_hash: "pending",
            scope: ["app.txt"],
            deliver: { mode: "merge_main" },
          },
          brief_markdown: "# Brief\nSetup fail cleanup",
        }),
      }),
    );

    // Wait for dispatch_error waiting state AND confirm worktree directory was cleaned up!
    await waitUntil(() => server.store.getTaskIndex("t-setup-fail")?.status === "waiting");
    const worktreePath = path.join(server.store.paths.workspaceDir("t-setup-fail"), "worktree");
    expect(fs.existsSync(worktreePath)).toBe(false);

    // Release script slots and decide retry -> worktree re-created & setup runs cleanly -> task reaches done -> checkpoints GC'd!
    for (const id of devIds) {
      await server.scriptRunner.stop(id);
    }

    const pendingErr = server.pendingDecisions.get("t-setup-fail");
    expect(pendingErr?.reason).toBe("dispatch_error");
    const decideRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-setup-fail/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision_id: pendingErr!.id, option_id: "opt-retry" }),
      }),
    );
    expect(decideRes.status).toBe(200);
    await waitUntil(() => server.store.getTaskIndex("t-setup-fail")?.status === "done");

    // Worktree & checkpoints automatically garbage-collected right after completeTaskDelivery on merge_main done
    await waitUntil(() => !fs.existsSync(worktreePath));
    await waitUntil(async () => {
      const ckptsRes = await server.app.request(
        new Request("http://127.0.0.1/api/tasks/t-setup-fail/checkpoints"),
      );
      return ((await ckptsRes.json()) as { checkpoints: unknown[] }).checkpoints.length === 0;
    });

    // Running script with archived taskId after worktree cleanup falls back to space.repo_path
    const postCleanScript = await server.app.request(
      new Request("http://127.0.0.1/api/spaces/demo/scripts/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: "test", taskId: "t-setup-fail" }),
      }),
    );
    expect(postCleanScript.status).toBe(202);
    const postScriptJson = RunSpaceScriptResponseSchema.parse(await postCleanScript.json());
    expect(fs.realpathSync(postScriptJson.cwd)).toBe(fs.realpathSync(repoPath));
  });
});
