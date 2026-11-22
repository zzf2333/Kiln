import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HashMismatchErrorSchema,
  RoleForbiddenErrorSchema,
  SseEventSchema,
  serializeFrontmatterMarkdown,
  type CardContract,
  type PricingConfig,
  type RunMeta,
  type SseEvent,
  type TaskCard,
} from "@kiln/protocol";
import {
  applyApprovedHostScopedChanges,
  stageHostScopedChanges,
} from "../../gate/index.js";
import { ensureDir, isWindowsNamedPipe, realpathCanonical, writeFileAtomic } from "../../store/index.js";
import {
  CaffeinateController,
  ES_CONTINUOUS,
  ES_SYSTEM_REQUIRED,
  KilndServer,
  RunTokenAuthError,
  SseHub,
  WindowsPowerController,
  discoverLocalGitRepos,
  formatSseFrame,
  pickLocalDirectory,
  prepareIpcSocketPath,
  revealLocalPath,
  signRunToken,
  verifyRunToken,
  type AcPowerStatus,
  type CaffeinateChildProcess,
  type PickLocalDirectoryExecFn,
} from "../index.js";

async function readJson<T = Record<string, any>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function makeTempDir(prefix = "kiln-srv-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeContract(overrides: Partial<CardContract> = {}): CardContract {
  return {
    goal: "Implement server RPC and HTTP API",
    end: "All integration assertions pass",
    accept_cmd: "pnpm --filter @kiln/kernel test",
    accept_files_hash: "sha256:frozen-baseline-v1",
    scope: ["packages/kernel/src/server/**"],
    deliver: { mode: "manual", cmd: null },
    human_accept: false,
    external_actions: "ask",
    ...overrides,
  };
}

function makeTaskCard(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    schema_version: 1,
    id: "t-srv-1",
    title: "Server integration task",
    space: "kiln",
    priority: "P2",
    track: "L2",
    workspace_mode: "git_worktree",
    parent: null,
    depends_on: [],
    contract_version: 1,
    contract: makeContract(),
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
    run_id: "run-srv-1",
    task_id: "t-srv-1",
    stage: "implement",
    round: 1,
    role: "worker",
    contract_version: 1,
    backend_id: "fake",
    agent: "codex",
    model: "gpt-5.4",
    session_ref: {
      backendId: "fake",
      sessionId: "sess-1",
    },
    input_ref: "abc123def",
    started_at: "2026-11-19T10:01:00.000Z",
    ...overrides,
  };
}

function makeValidWorkerReceiptMarkdown(
  runId: string,
  contractVersion: number,
  summary = "Implemented server RPC changes",
): string {
  return serializeFrontmatterMarkdown(
    {
      run_id: runId,
      contract_version: contractVersion,
      outcome: "completed",
      input_ref: "deadbeef123",
      output_ref: "deadbeef456",
      changed_paths: ["packages/kernel/src/server/mcp-rpc.ts"],
      accept_result: "pass",
      is_bugfix: false,
      complexity_escalate: false,
    },
    [
      `## 改动说明\n${summary}\n`,
      "## 验证命令与真实输出\npnpm --filter @kiln/kernel test -> pass\n",
      "## 未完成或待决问题\n无\n",
    ].join("\n"),
  );
}

function makeFakeChild(): CaffeinateChildProcess & {
  killCalls: Array<NodeJS.Signals | number | undefined>;
  emitter: EventEmitter;
} {
  const emitter = new EventEmitter();
  const killCalls: Array<NodeJS.Signals | number | undefined> = [];
  return {
    emitter,
    killCalls,
    kill(signal?: NodeJS.Signals | number): boolean {
      killCalls.push(signal);
      emitter.emit("exit", 0, typeof signal === "string" ? signal : null);
      return true;
    },
    once(event: "exit" | "error", listener: (...args: any[]) => void) {
      emitter.once(event, listener);
      return this;
    },
    unref() {
      return this;
    },
  };
}

async function requestMcpRpc(
  server: KilndServer,
  options: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<{ status: number; json: any; raw: string }> {
  const payload =
    options.body === undefined
      ? undefined
      : typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);

  const res = await server.invokeMcpRpc({
    method: options.method,
    url: options.path,
    headers: options.headers,
    rawBody: payload,
  });
  return {
    status: res.status,
    json: res.body,
    raw: JSON.stringify(res.body),
  };
}

async function requestHttp(
  server: KilndServer,
  reqPath: string,
  init?: RequestInit,
): Promise<Response> {
  return await server.app.request(new Request(`http://127.0.0.1${reqPath}`, init));
}

function parseSseFrames(chunkText: string): Array<{ id: number; event: string; data: SseEvent }> {
  const frames: Array<{ id: number; event: string; data: SseEvent }> = [];
  const blocks = chunkText.split("\n\n").filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    let id = -1;
    let event = "";
    let dataRaw = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) {
        id = Number(line.slice(4));
      } else if (line.startsWith("event: ")) {
        event = line.slice(7);
      } else if (line.startsWith("data: ")) {
        dataRaw = line.slice(6);
      }
    }
    frames.push({
      id,
      event,
      data: SseEventSchema.parse(JSON.parse(dataRaw)),
    });
  }
  return frames;
}

describe("RunToken HMAC signing & verification", () => {
  const secret = "kiln-test-hmac-secret-32-bytes-ok";
  const baseClaims = {
    taskId: "t-1",
    runId: "run-1",
    role: "worker" as const,
    contractVersion: 1,
    iat: 1_700_000_000,
    exp: 1_700_000_600,
  };

  it("signs and verifies valid tokens up to exact exp boundary", () => {
    const token = signRunToken(baseClaims, secret);
    expect(token.split(".")).toHaveLength(3);
    expect(verifyRunToken(token, secret, 1_700_000_000 * 1000)).toEqual(baseClaims);
    expect(verifyRunToken(token, secret, 1_700_000_600 * 1000)).toEqual(baseClaims);
  });

  it("rejects malformed, tampered, wrong-header, invalid-claims, and expired tokens", () => {
    const token = signRunToken(baseClaims, secret);
    const parts = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...baseClaims, role: "intake" }),
      "utf8",
    ).toString("base64url");
    const tamperedSig = `${parts[2]!.slice(0, -1)}${parts[2]!.endsWith("a") ? "b" : "a"}`;

    expect(() => verifyRunToken("not-a-jwt", secret)).toThrowError(RunTokenAuthError);
    expect(() => verifyRunToken(`${parts[0]}.${tamperedPayload}.${parts[2]}`, secret)).toThrowError(
      RunTokenAuthError,
    );
    expect(() => verifyRunToken(`${parts[0]}.${parts[1]}.${tamperedSig}`, secret)).toThrowError(
      RunTokenAuthError,
    );
    expect(() => verifyRunToken(token, "wrong-secret")).toThrowError(RunTokenAuthError);
    expect(() => verifyRunToken(token, secret, 1_700_000_601 * 1000)).toThrowError(
      RunTokenAuthError,
    );

    try {
      verifyRunToken(token, secret, 1_700_000_601 * 1000);
    } catch (err) {
      expect(err).toBeInstanceOf(RunTokenAuthError);
      expect((err as RunTokenAuthError).reason).toBe("expired");
    }

    const badHeaderToken = `${Buffer.from(JSON.stringify({ alg: "none", typ: "KILN-RUN" })).toString("base64url")}.${parts[1]}`;
    const badHeaderSig = signRunToken(baseClaims, secret).split(".")[2]!;
    expect(() => verifyRunToken(`${badHeaderToken}.${badHeaderSig}`, secret)).toThrowError(
      RunTokenAuthError,
    );
  });
});

describe("SseHub ring buffer & framing", () => {
  it("assigns monotonic seq, bounds replay buffer, and validates event schema", () => {
    const hub = new SseHub({ bufferCapacity: 3 });

    for (let i = 1; i <= 5; i++) {
      const ev = hub.publish({
        type: "task.updated",
        taskId: `t-${i}`,
        patch: { status: "queued" },
      });
      expect(ev.seq).toBe(i);
    }

    expect(hub.currentSeq).toBe(5);
    expect(hub.replaySince(0).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(hub.replaySince(4).map((e) => e.seq)).toEqual([5]);
    expect(hub.replaySince(5)).toEqual([]);

    const frame = formatSseFrame(hub.replaySince(4)[0]!);
    expect(frame).toMatch(/^id: 5\nevent: task\.updated\ndata: \{.*\}\n\n$/);

    expect(() =>
      hub.publish({
        type: "task.updated",
        taskId: "",
        patch: {},
      }),
    ).toThrow();
    expect(hub.currentSeq).toBe(5);
  });
});

describe("CaffeinateController state machine", () => {
  it("follows 0 -> 1 -> 2 -> 1 -> 0 lifecycle spawning once on 0->1 and terminating on 0", () => {
    const spawns: Array<{ command: string; args: readonly string[] }> = [];
    const children: ReturnType<typeof makeFakeChild>[] = [];

    const controller = new CaffeinateController({
      platform: "darwin",
      existsSync: () => true,
      pid: 4242,
      spawnProcess: (command, args) => {
        spawns.push({ command, args });
        const child = makeFakeChild();
        children.push(child);
        return child;
      },
    });

    expect(controller.isActive).toBe(false);

    controller.syncRunningCount(0);
    expect(spawns).toHaveLength(0);

    controller.syncRunningCount(1);
    expect(spawns).toEqual([{ command: "/usr/bin/caffeinate", args: ["-i", "-w", "4242"] }]);
    expect(controller.isActive).toBe(true);
    expect(children[0]!.killCalls).toEqual([]);

    controller.syncRunningCount(2);
    controller.syncRunningCount(2);
    controller.syncRunningCount(1);
    expect(spawns).toHaveLength(1);
    expect(controller.isActive).toBe(true);
    expect(children[0]!.killCalls).toEqual([]);

    controller.syncRunningCount(0);
    expect(children[0]!.killCalls).toEqual(["SIGTERM"]);
    expect(controller.isActive).toBe(false);

    controller.syncRunningCount(0);
    expect(children[0]!.killCalls).toEqual(["SIGTERM"]);
  });

  it("does not spawn on non-darwin platforms or missing binary", () => {
    let spawned = 0;
    const linuxCtrl = new CaffeinateController({
      platform: "linux",
      existsSync: () => true,
      spawnProcess: () => {
        spawned += 1;
        return makeFakeChild();
      },
    });
    linuxCtrl.syncRunningCount(1);
    expect(spawned).toBe(0);

    const missingBinCtrl = new CaffeinateController({
      platform: "darwin",
      existsSync: () => false,
      spawnProcess: () => {
        spawned += 1;
        return makeFakeChild();
      },
    });
    missingBinCtrl.syncRunningCount(1);
    expect(spawned).toBe(0);
  });

  it("prevents idle sleep on win32 via SetThreadExecutionState and enforces AC-only gating on battery", () => {
    const flagsSeen: number[] = [];
    let powerState: AcPowerStatus = "ac";

    const fakePowerApi = {
      setThreadExecutionState(flags: number): number {
        flagsSeen.push(flags >>> 0);
        return ES_CONTINUOUS >>> 0;
      },
      getAcPowerStatus(): AcPowerStatus {
        return powerState;
      },
    };

    const winCtrl = new CaffeinateController({
      platform: "win32",
      windowsPowerApi: fakePowerApi,
      spawnProcess: () => {
        throw new Error("win32 must not spawn /usr/bin/caffeinate");
      },
    });

    expect(winCtrl.isActive).toBe(false);
    winCtrl.syncRunningCount(0);
    expect(flagsSeen).toEqual([]);

    winCtrl.syncRunningCount(1);
    expect(winCtrl.isActive).toBe(true);
    expect(flagsSeen).toEqual([(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0]);

    winCtrl.syncRunningCount(3);
    winCtrl.syncRunningCount(1);
    expect(flagsSeen).toHaveLength(1);

    winCtrl.syncRunningCount(0);
    expect(winCtrl.isActive).toBe(false);
    expect(flagsSeen).toEqual([
      (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0,
      ES_CONTINUOUS >>> 0,
    ]);

    // AC-only standby mode: fails closed on battery/unknown and releases immediately when unplugged
    const acFlags: number[] = [];
    let pollCb: (() => void) | null = null;
    let clearedCount = 0;
    const acController = new WindowsPowerController({
      powerApi: {
        setThreadExecutionState(flags: number): number {
          acFlags.push(flags >>> 0);
          return ES_CONTINUOUS >>> 0;
        },
        getAcPowerStatus(): AcPowerStatus {
          return powerState;
        },
      },
      acPollIntervalMs: 15_000,
      setIntervalFn: (cb) => {
        pollCb = cb;
        return { unref: () => {} };
      },
      clearIntervalFn: () => {
        clearedCount += 1;
        pollCb = null;
      },
    });

    powerState = "battery";
    expect(acController.acquire({ requireAc: true })).toBe(false);
    expect(acController.isActive).toBe(false);
    expect(acFlags).toEqual([]);

    powerState = "ac";
    expect(pollCb).not.toBeNull();
    pollCb!();
    expect(acController.isActive).toBe(true);
    expect(acFlags).toEqual([(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0]);

    // Unplugging AC immediately releases the execution state assertion
    powerState = "battery";
    pollCb!();
    expect(acController.isActive).toBe(false);
    expect(acFlags).toEqual([
      (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0,
      ES_CONTINUOUS >>> 0,
    ]);

    acController.release();
    expect(clearedCount).toBe(1);
  });

  it("maps CaffeinateController active_tasks and remote_ac_standby onto win32 WindowsPowerController with fail-closed battery gating", () => {
    const flagsSeen: number[] = [];
    let powerState: AcPowerStatus = "battery";
    let pollCb: (() => void) | null = null;
    let clearedCount = 0;

    const windowsPower = new WindowsPowerController({
      powerApi: {
        setThreadExecutionState(flags: number): number {
          flagsSeen.push(flags >>> 0);
          return ES_CONTINUOUS >>> 0;
        },
        getAcPowerStatus(): AcPowerStatus {
          return powerState;
        },
      },
      acPollIntervalMs: 15_000,
      setIntervalFn: (cb) => {
        pollCb = cb;
        return { unref: () => {} };
      },
      clearIntervalFn: () => {
        clearedCount += 1;
        pollCb = null;
      },
    });

    const winCtrl = new CaffeinateController({
      platform: "win32",
      windowsPower,
      spawnProcess: () => {
        throw new Error("win32 must not spawn /usr/bin/caffeinate");
      },
    });

    // 1. remote_ac_standby on battery -> fails closed (no execution state asserted)
    winCtrl.setRemoteKeepAwakeOnAc(true);
    expect(winCtrl.mode).toBe("remote_ac_standby");
    expect(winCtrl.isActive).toBe(false);
    expect(windowsPower.isRequireAcMode).toBe(true);
    expect(flagsSeen).toEqual([]);
    expect(pollCb).not.toBeNull();

    // 2. AC plugged in -> poll asserts ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    powerState = "ac";
    pollCb!();
    expect(winCtrl.isActive).toBe(true);
    expect(flagsSeen).toEqual([(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0]);

    // 3. Task starts -> active_tasks switches requireAc=false and stops AC poll
    winCtrl.syncRunningCount(1);
    expect(winCtrl.mode).toBe("active_tasks");
    expect(winCtrl.isActive).toBe(true);
    expect(windowsPower.isRequireAcMode).toBe(false);
    expect(clearedCount).toBe(1);

    // 4. Task finishes while on battery & remote_ac_standby enabled -> immediately releases
    powerState = "battery";
    winCtrl.syncRunningCount(0);
    expect(winCtrl.mode).toBe("remote_ac_standby");
    expect(windowsPower.isRequireAcMode).toBe(true);
    expect(winCtrl.isActive).toBe(false);
    expect(flagsSeen).toEqual([
      (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0,
      ES_CONTINUOUS >>> 0,
    ]);

    // 5. stop() transitions to off and clears AC poll
    winCtrl.stop();
    expect(winCtrl.mode).toBe("off");
    expect(winCtrl.isActive).toBe(false);
    expect(windowsPower.isRequireAcMode).toBe(false);
    expect(clearedCount).toBe(2);
  });
});

describe("Windows Named Pipe guards & local IPC /rpc/shutdown authentication", () => {
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

  it("skips ensureDir, lstatSync, unlinkSync, and probe on Windows Named Pipe paths", async () => {
    let fsCalls = 0;
    await prepareIpcSocketPath("\\\\.\\pipe\\kiln-rpc-0123456789abcdef", {
      ensureDirFn: () => {
        fsCalls += 1;
      },
      lstatSyncFn: () => {
        fsCalls += 1;
        throw new Error("should not call lstatSync on named pipe");
      },
      unlinkSyncFn: () => {
        fsCalls += 1;
      },
      probeActiveFn: async () => {
        fsCalls += 1;
        return false;
      },
    });
    expect(fsCalls).toBe(0);
  });

  it("authenticates POST /rpc/shutdown via timingSafeEqual and manages 0600 kilnd.shutdown lifecycle", async () => {
    const kilnHome = makeTempDir("kiln-srv-shutdown-");
    tempDirs.push(kilnHome);

    let shutdownCount = 0;
    const server = new KilndServer({
      kilnHome,
      port: 0,
      shutdownToken: "unit-test-shutdown-token-abcdef0123456789",
      onShutdownRequested: () => {
        shutdownCount += 1;
      },
    });
    servers.push(server);

    const addr = await server.start();
    expect(addr.socketPath.length).toBeGreaterThan(0);

    const tokenFile = server.store.paths.shutdownTokenFile;
    expect(fs.existsSync(tokenFile)).toBe(true);
    expect(fs.readFileSync(tokenFile, "utf8").trim()).toBe(
      "unit-test-shutdown-token-abcdef0123456789",
    );
    if (process.platform !== "win32") {
      expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    }

    // Missing auth -> 401
    const noAuth = await server.invokeMcpRpc({
      method: "POST",
      url: "/rpc/shutdown",
    });
    expect(noAuth.status).toBe(401);

    // Wrong length & wrong value -> 401
    const shortWrong = await server.invokeMcpRpc({
      method: "POST",
      url: "/rpc/shutdown",
      headers: { Authorization: "Bearer short" },
    });
    expect(shortWrong.status).toBe(401);

    const sameLenWrong = await server.invokeMcpRpc({
      method: "POST",
      url: "/rpc/shutdown",
      headers: { Authorization: "Bearer unit-test-shutdown-token-abcdef0123456780" },
    });
    expect(sameLenWrong.status).toBe(401);
    expect(shutdownCount).toBe(0);

    // Valid token -> 200 and idempotent trigger
    const ok1 = await server.invokeMcpRpc({
      method: "POST",
      url: "/rpc/shutdown",
      headers: { Authorization: "Bearer unit-test-shutdown-token-abcdef0123456789" },
    });
    const ok2 = await server.invokeMcpRpc({
      method: "POST",
      url: "/rpc/shutdown",
      headers: { Authorization: "Bearer unit-test-shutdown-token-abcdef0123456789" },
    });
    expect(ok1).toEqual({ status: 200, body: { ok: true, shuttingDown: true } });
    expect(ok2).toEqual({ status: 200, body: { ok: true, shuttingDown: true } });

    await new Promise((r) => setImmediate(r));
    expect(shutdownCount).toBe(1);

    await server.stop();
    expect(fs.existsSync(tokenFile)).toBe(false);
  });
});

describe("KilndServer end-to-end (UDS MCP RPC + HTTP REST + SSE + host_scoped)", () => {
  const tempDirs: string[] = [];
  const servers: KilndServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const srv = servers.pop()!;
      await srv.stop();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces 0600 socket, HMAC auth, 403 role_forbidden, 404 unknown tools, ledger isolation, and stale receipt archiving", async () => {
    const kilnHome = makeTempDir();
    tempDirs.push(kilnHome);

    const server = new KilndServer({
      kilnHome,
      port: 0,
      tokenSecret: "test-server-secret-value-1234567890",
    });
    servers.push(server);
    const addr = await server.start();

    if (!isWindowsNamedPipe(addr.socketPath)) {
      const sockMode = fs.statSync(addr.socketPath).mode & 0o777;
      expect(sockMode).toBe(0o600);
    }

    server.store.writeSpace({
      schema_version: 1,
      id: "kiln",
      name: "Kiln Core",
      repo_path: kilnHome,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    server.store.writeLedger({
      schema_version: 1,
      space: "kiln",
      entries: [
        {
          id: "led-init",
          space: "kiln",
          rule: "All persistent writes must be atomic",
          source_task_id: "t-seed",
          created_at: "2026-11-19T09:00:00.000Z",
        },
      ],
    });

    const intakeToken = server.issueRunToken({
      taskId: "t-intake-session",
      runId: "run-intake-1",
      role: "intake",
      contractVersion: 1,
    });

    // 1. Unauthenticated / tampered / expired tokens -> 401
    const unauthRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_list_tasks",
      body: {},
    });
    expect(unauthRes.status).toBe(401);

    const badTokenRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_list_tasks",
      headers: { Authorization: `Bearer ${intakeToken}x` },
      body: {},
    });
    expect(badTokenRes.status).toBe(401);

    const expiredToken = server.issueRunToken({
      taskId: "t-intake-session",
      runId: "run-exp",
      role: "intake",
      contractVersion: 1,
      iat: 1_000,
      exp: 1_001,
    });
    const expiredRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_list_tasks",
      headers: { Authorization: `Bearer ${expiredToken}` },
      body: {},
    });
    expect(expiredRes.status).toBe(401);

    // 2. Non-whitelisted tools & non-POST routes -> 404
    for (const forbiddenTool of [
      "wb_push",
      "wb_merge",
      "wb_publish",
      "wb_delete_branch",
      "wb_close_task",
    ]) {
      const unknownRes = await requestMcpRpc(server, {
        method: "POST",
        path: `/rpc/mcp/${forbiddenTool}`,
        headers: { Authorization: `Bearer ${intakeToken}` },
        body: {},
      });
      expect(unknownRes.status).toBe(404);
    }

    const wrongMethodRes = await requestMcpRpc(server, {
      method: "GET",
      path: "/rpc/mcp/wb_list_tasks",
      headers: { Authorization: `Bearer ${intakeToken}` },
    });
    expect(wrongMethodRes.status).toBe(404);

    // 3. intake plans draft -> commits card -> lists tasks
    const draftRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_plan",
      headers: { Authorization: `Bearer ${intakeToken}` },
      body: {
        mode: "upsert_draft",
        draft_id: "d-mcp-1",
        title: "MCP draft title",
        space: "kiln",
      },
    });
    expect(draftRes.status).toBe(200);
    expect(server.store.readDraft("d-mcp-1")?.title).toBe("MCP draft title");

    const commitRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_plan",
      headers: { Authorization: `Bearer ${intakeToken}` },
      body: {
        mode: "commit_card",
        draft_id: "d-mcp-1",
        title: "Committed via wb_plan",
        space: "kiln",
        priority: "P1",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        contract: makeContract(),
        brief_markdown: "# Brief\nBuild server",
      },
    });
    expect(commitRes.status).toBe(200);
    const taskId = commitRes.json.card.id as string;
    expect(taskId).toMatch(/^t-/);

    const listRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_list_tasks",
      headers: { Authorization: `Bearer ${intakeToken}` },
      body: { space: "kiln" },
    });
    expect(listRes.status).toBe(200);
    expect(listRes.json.tasks).toHaveLength(1);
    expect(listRes.json.spaceConfig.id).toBe("kiln");

    // Persist run with input_ref before issuing worker token
    const leaseRes = server.persistRunForDispatch(
      makeRunMeta({
        task_id: taskId,
        run_id: "run-w-1",
        stage: "implement",
        role: "worker",
        contract_version: 1,
        input_ref: "deadbeef123",
      }),
      "001-implement",
    );
    expect(leaseRes).toEqual({ acquired: true });

    const workerToken = server.issueRunToken({
      taskId,
      runId: "run-w-1",
      role: "worker",
      contractVersion: 1,
    });

    // 4. Role allowlist enforcement -> 403 RoleForbiddenErrorSchema
    const workerPlanRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_plan",
      headers: { Authorization: `Bearer ${workerToken}` },
      body: {
        mode: "upsert_draft",
        draft_id: "d-illegal",
        title: "Should fail",
      },
    });
    expect(workerPlanRes.status).toBe(403);
    const parsedForbidden = RoleForbiddenErrorSchema.parse(workerPlanRes.json);
    expect(parsedForbidden.code).toBe("role_forbidden");
    expect(parsedForbidden.role).toBe("worker");
    expect(parsedForbidden.tool).toBe("wb_plan");

    const intakeSubmitRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_submit_receipt",
      headers: { Authorization: `Bearer ${intakeToken}` },
      body: { markdown: "# Forbidden" },
    });
    expect(intakeSubmitRes.status).toBe(403);
    expect(RoleForbiddenErrorSchema.parse(intakeSubmitRes.json).tool).toBe("wb_submit_receipt");

    // 5. worker reads context & ledger
    const ctxRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_get_context",
      headers: { Authorization: `Bearer ${workerToken}` },
      body: {},
    });
    expect(ctxRes.status).toBe(200);
    expect(ctxRes.json.card.id).toBe(taskId);
    expect(ctxRes.json.run.input_ref).toBe("deadbeef123");
    expect(ctxRes.json.contract_version).toBe(1);

    const ledgerReadRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_read_ledger",
      headers: { Authorization: `Bearer ${workerToken}` },
      body: { space: "kiln" },
    });
    expect(ledgerReadRes.status).toBe(200);
    expect(ledgerReadRes.json.ledger.entries).toHaveLength(1);

    // 6. wb_propose_ledger NEVER writes directly to ledger/<space>.yaml
    const proposeRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_propose_ledger",
      headers: { Authorization: `Bearer ${workerToken}` },
      body: {
        space: "kiln",
        rule: "Never auto-write ledger entries",
        rationale: "Requires human sign-off",
      },
    });
    expect(proposeRes.status).toBe(200);
    expect(proposeRes.json.status).toBe("proposed");
    expect(server.store.readLedger("kiln")?.entries).toHaveLength(1);

    // 7. worker submits receipt -> accepted once; second submission -> archived stale
    const receiptMd = makeValidWorkerReceiptMarkdown("run-w-1", 1, "Worker receipt 1");
    const submit1 = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_submit_receipt",
      headers: { Authorization: `Bearer ${workerToken}` },
      body: { markdown: receiptMd },
    });
    expect(submit1.status).toBe(200);
    expect(submit1.json.accepted).toBe(true);

    const submitStale = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_submit_receipt",
      headers: { Authorization: `Bearer ${workerToken}` },
      body: { markdown: `${receiptMd}\n\nstale` },
    });
    expect(submitStale.status).toBe(200);
    expect(submitStale.json.accepted).toBe(false);
    expect(submitStale.json.reason).toBe("lease_mismatch_or_expired");
    expect(fs.existsSync(submitStale.json.archivedPath as string)).toBe(true);
    expect(server.store.getTaskIndex(taskId)?.status).toBe("running");

    // 8. update_contract validates accept_files_hash when changing accept_cmd and bumps version
    const badUpdateRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_plan",
      headers: { Authorization: `Bearer ${intakeToken}` },
      body: {
        mode: "update_contract",
        task_id: taskId,
        contract: { accept_cmd: "pnpm test --changed" },
        affected_stages: ["implement"],
        rationale: "Missing hash should fail",
      },
    });
    expect(badUpdateRes.status).toBe(400);

    const goodUpdateRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_plan",
      headers: { Authorization: `Bearer ${intakeToken}` },
      body: {
        mode: "update_contract",
        task_id: taskId,
        contract: {
          accept_cmd: "pnpm test --changed",
          accept_files_hash: "sha256:frozen-baseline-v2",
        },
        affected_stages: ["implement"],
        rationale: "Updated command and frozen hash",
      },
    });
    expect(goodUpdateRes.status).toBe(200);
    expect(goodUpdateRes.json.contractVersion).toBe(2);
    expect(goodUpdateRes.json.archivedReceipts).toHaveLength(1);

    // Old v1 token can no longer request decisions once contract_version is 2
    const staleAskRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_ask_decision",
      headers: { Authorization: `Bearer ${workerToken}` },
      body: {
        category: "scope",
        reason: "Need approval",
        question: "Proceed?",
        options: [{ id: "opt-1", label: "Resume", action: "resume", recommended: true }],
      },
    });
    expect(staleAskRes.status).toBe(409);
  });

  it("supports HTTP REST lifecycle, pricing bootstrap, SSE Last-Event-ID replay, and sqlite rebuild survival", async () => {
    const kilnHome = makeTempDir();
    tempDirs.push(kilnHome);

    const caffeinateSpawns: string[][] = [];
    const spawnedChildren: ReturnType<typeof makeFakeChild>[] = [];
    const caffeinate = new CaffeinateController({
      platform: "darwin",
      existsSync: () => true,
      pid: 9999,
      spawnProcess: (_cmd, args) => {
        caffeinateSpawns.push([...args]);
        const child = makeFakeChild();
        spawnedChildren.push(child);
        return child;
      },
    });

    const server1 = new KilndServer({
      kilnHome,
      port: 0,
      tokenSecret: "restart-invariant-secret-1234567890",
      caffeinate,
    });
    servers.push(server1);
    await server1.start();

    // 1. Health & settings
    const healthRes = await requestHttp(server1, "/api/health");
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as { ok: boolean; pid: number; version: string };
    expect(healthJson.ok).toBe(true);
    expect(healthJson.pid).toBe(process.pid);

    const pricingConfig: PricingConfig = {
      schema_version: 1,
      models: {
        "gpt-5.4": { in: 2.5, cached: 0.25, out: 10 },
      },
    };
    const putPricing = await requestHttp(server1, "/api/settings/pricing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pricingConfig),
    });
    expect(putPricing.status).toBe(200);

    const badSettings = await requestHttp(server1, "/api/settings/unknown", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(badSettings.status).toBe(400);

    // 2. Connect SSE stream and capture initial event
    const abort1 = new AbortController();
    const sseRes1 = await requestHttp(server1, "/api/events", { signal: abort1.signal });
    expect(sseRes1.status).toBe(200);
    expect(sseRes1.headers.get("content-type")).toContain("text/event-stream");
    const reader1 = sseRes1.body!.getReader();
    const decoder = new TextDecoder();

    // 3. Draft -> commit upstream + downstream tasks via HTTP
    const draftCreate = await requestHttp(server1, "/api/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "d-http-1",
        title: "Upstream task",
        space: "kiln",
        priority: "P3",
        track: "L2",
        workspace_mode: "scratch_dir",
        contract: makeContract(),
      }),
    });
    expect(draftCreate.status).toBe(201);

    const commitUp = await requestHttp(server1, "/api/drafts/d-http-1/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "t-up",
        brief_markdown: "# Upstream brief",
      }),
    });
    expect(commitUp.status).toBe(201);

    const firstChunk = await reader1.read();
    const firstFrames = parseSseFrames(decoder.decode(firstChunk.value));
    expect(firstFrames.length).toBeGreaterThanOrEqual(1);
    const lastSeenSeq = firstFrames.at(-1)!.id;
    expect(firstFrames[0]!.data.type).toBe("task.updated");

    // Disconnect SSE client before publishing missed events
    abort1.abort();
    await reader1.cancel().catch(() => {});

    // Create downstream task & test pause / resume / priority propagation
    const draftDown = await requestHttp(server1, "/api/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "d-http-2",
        title: "Downstream task",
        space: "kiln",
        priority: "P2",
        track: "L1",
        workspace_mode: "scratch_dir",
        depends_on: ["t-up"],
        contract: makeContract(),
      }),
    });
    expect(draftDown.status).toBe(201);

    const commitDown = await requestHttp(server1, "/api/drafts/d-http-2/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "t-down",
        brief_markdown: "# Downstream brief",
      }),
    });
    expect(commitDown.status).toBe(201);

    const prioRes = await requestHttp(server1, "/api/tasks/t-down/priority", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priority: "P0" }),
    });
    expect(prioRes.status).toBe(200);
    expect(server1.store.getTaskIndex("t-up")?.effective_priority).toBe("P0");

    // Reconnect SSE with Last-Event-ID header and verify exact replay + live delivery
    const abort2 = new AbortController();
    const sseRes2 = await requestHttp(server1, "/api/events", {
      headers: { "Last-Event-ID": String(lastSeenSeq) },
      signal: abort2.signal,
    });
    expect(sseRes2.status).toBe(200);
    const reader2 = sseRes2.body!.getReader();

    let replayText = "";
    const replayFrames: Array<{ id: number; event: string; data: SseEvent }> = [];
    while (replayFrames.length < 3) {
      const next = await reader2.read();
      if (next.done) break;
      replayText += decoder.decode(next.value, { stream: true });
      replayFrames.splice(0, replayFrames.length, ...parseSseFrames(replayText));
    }
    expect(replayFrames.every((f) => f.id > lastSeenSeq)).toBe(true);
    expect(replayFrames.map((f) => f.id)).toEqual([
      lastSeenSeq + 1,
      lastSeenSeq + 2,
      lastSeenSeq + 3,
    ]);

    // Pause -> verify isolated from pendingDecisions & ledger; then resume
    const pauseRes = await requestHttp(server1, "/api/tasks/t-up/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Manual pause check" }),
    });
    expect(pauseRes.status).toBe(200);
    expect((await readJson(pauseRes)).state.status).toBe("paused");
    expect(fs.existsSync(server1.store.paths.decisionsMd("t-up"))).toBe(false);
    expect(server1.store.readLedger("kiln")).toBeNull();

    const resumeRes = await requestHttp(server1, "/api/tasks/t-up/resume", {
      method: "POST",
    });
    expect(resumeRes.status).toBe(200);
    expect((await readJson(resumeRes)).state.status).toBe("queued");

    // Dispatch run on t-up (caffeinate 0 -> 1) and record usage turn with cache breakdown
    server1.persistRunForDispatch(
      makeRunMeta({
        task_id: "t-up",
        run_id: "run-up-1",
        stage: "implement",
        role: "worker",
        contract_version: 1,
        input_ref: undefined,
      }),
      "001-implement",
    );
    expect(caffeinateSpawns).toHaveLength(1);
    expect(caffeinate.isActive).toBe(true);

    server1.store.recordRunEvent("t-up", "001-implement", {
      kind: "usage",
      at: "2026-11-19T10:02:00.000Z",
      turnId: "turn-1",
      agent: "codex",
      model: "gpt-5.4",
      inputTokens: 1_000_000,
      cachedInputTokens: 400_000,
      outputTokens: 100_000,
    });
    // Expected cost: ((1M - 400k)*2.5 + 400k*0.25 + 100k*10)/1e6 = 1.5 + 0.1 + 1.0 = 2.6

    // Worker requests decision via MCP RPC -> waiting + SSE decision.requested + caffeinate 1 -> 0
    const upWorkerToken = server1.issueRunToken({
      taskId: "t-up",
      runId: "run-up-1",
      role: "worker",
      contractVersion: 1,
    });
    const askRes = await requestMcpRpc(server1, {
      method: "POST",
      path: "/rpc/mcp/wb_ask_decision",
      headers: { Authorization: `Bearer ${upWorkerToken}` },
      body: {
        category: "scope_change",
        reason: "Need test command update",
        question: "Approve updating accept_cmd?",
        options: [
          {
            id: "opt-approve",
            label: "Approve and continue",
            action: "resume",
            target_stage: "implement",
            recommended: true,
            ledger_rule: "Always verify accept_cmd changes with new hash",
          },
          {
            id: "opt-cancel",
            label: "Cancel task",
            action: "cancel",
            recommended: false,
          },
        ],
      },
    });
    expect(askRes.status).toBe(200);
    const decisionId = askRes.json.decision.id as string;
    expect(caffeinate.isActive).toBe(false);
    expect(spawnedChildren[0]!.killCalls).toEqual(["SIGTERM"]);

    // Verify live SSE stream received decision.requested
    let liveText = "";
    const liveFrames: Array<{ id: number; event: string; data: SseEvent }> = [];
    while (!liveFrames.some((f) => f.data.type === "decision.requested")) {
      const next = await reader2.read();
      if (next.done) break;
      liveText += decoder.decode(next.value, { stream: true });
      liveFrames.splice(0, liveFrames.length, ...parseSseFrames(liveText));
    }
    expect(liveFrames.some((f) => f.data.type === "decision.requested")).toBe(true);
    abort2.abort();
    await reader2.cancel().catch(() => {});

    // 4. Stop daemon, DELETE index.sqlite, restart fresh KilndServer -> pendingDecision & usage survive!
    await server1.stop();
    servers.pop();
    fs.rmSync(path.join(kilnHome, "index.sqlite"), { force: true });
    fs.rmSync(path.join(kilnHome, "index.sqlite-wal"), { force: true });
    fs.rmSync(path.join(kilnHome, "index.sqlite-shm"), { force: true });

    const server2 = new KilndServer({
      kilnHome,
      port: 0,
      tokenSecret: "restart-invariant-secret-1234567890",
    });
    servers.push(server2);
    await server2.start();

    const bootRes = await requestHttp(server2, "/api/bootstrap");
    expect(bootRes.status).toBe(200);
    const bootJson = await readJson(bootRes);
    expect(bootJson.pendingDecisions).toHaveLength(1);
    expect(bootJson.pendingDecisions[0].id).toBe(decisionId);
    expect(bootJson.usage.costUsd).toBeCloseTo(2.6, 8);
    expect(bootJson.tasks.find((t: any) => t.id === "t-up").effective_priority).toBe("P0");

    const taskDetailRes = await requestHttp(server2, "/api/tasks/t-up");
    expect(taskDetailRes.status).toBe(200);
    const taskDetail = await readJson(taskDetailRes);
    expect(taskDetail.usage.costUsd).toBeCloseTo(2.6, 8);
    expect(taskDetail.runs).toHaveLength(1);
    expect(taskDetail.pendingDecision.id).toBe(decisionId);

    // 5. Decide with apply_ledger_rule=false (default) and contractUpdate passthrough acceptFilesHash
    const decideRes = await requestHttp(server2, "/api/tasks/t-up/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision_id: decisionId,
        option_id: "opt-approve",
        apply_ledger_rule: false,
        contractUpdate: {
          contractPatch: { accept_cmd: "pnpm test --updated" },
          affectedStages: ["implement"],
          acceptFilesHash: "sha256:frozen-baseline-v2",
        },
      }),
    });
    expect(decideRes.status).toBe(200);
    const decideJson = await readJson(decideRes);
    expect(decideJson.state.status).toBe("queued");
    expect(decideJson.contractVersion).toBe(2);
    expect(decideJson.ledgerEntry).toBeUndefined();
    expect(server2.store.readLedger("kiln")).toBeNull();

    // Verify apply_ledger_rule=true DOES write ledger when explicitly approved
    server2.persistRunForDispatch(
      makeRunMeta({
        task_id: "t-up",
        run_id: "run-up-2",
        stage: "implement",
        round: 2,
        role: "worker",
        contract_version: 2,
        input_ref: undefined,
      }),
      "002-implement",
    );
    const upWorkerTokenV2 = server2.issueRunToken({
      taskId: "t-up",
      runId: "run-up-2",
      role: "worker",
      contractVersion: 2,
    });
    const ask2 = await requestMcpRpc(server2, {
      method: "POST",
      path: "/rpc/mcp/wb_ask_decision",
      headers: { Authorization: `Bearer ${upWorkerTokenV2}` },
      body: {
        category: "architecture",
        reason: "Establish rule",
        question: "Record ledger rule?",
        options: [
          {
            id: "opt-ledger",
            label: "Yes and record to ledger",
            action: "resume",
            recommended: true,
            ledger_rule: "Always verify accept_cmd changes with new hash",
          },
        ],
      },
    });
    expect(ask2.status).toBe(200);

    const decideWithLedger = await requestHttp(server2, "/api/tasks/t-up/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision_id: ask2.json.decision.id,
        option_id: "opt-ledger",
        apply_ledger_rule: true,
      }),
    });
    expect(decideWithLedger.status).toBe(200);
    expect(server2.store.readLedger("kiln")?.entries).toHaveLength(1);

    // 6. Cancel t-up -> cascades upstream_cancelled waiting to queued t-down
    const cancelRes = await requestHttp(server2, "/api/tasks/t-up/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "No longer needed" }),
    });
    expect(cancelRes.status).toBe(200);
    const cancelJson = await readJson(cancelRes);
    expect(cancelJson.state.status).toBe("cancelled");
    expect(cancelJson.waitingDownstreamTaskIds).toEqual(["t-down"]);
    expect(server2.store.getTaskIndex("t-down")?.status).toBe("waiting");
  });

  it("handles stale socket cleanup, concurrent receipt races, query lastEventId SSE replay, settings validation, and traversal guards", async () => {
    const kilnHome = makeTempDir();
    tempDirs.push(kilnHome);

    // Create a stale Unix socket file left behind by a crashed daemon (POSIX only; Windows Named Pipes have no disk files)
    if (process.platform !== "win32") {
      const staleSockPath = path.join(kilnHome, "run", "kilnd.sock");
      ensureDir(path.dirname(staleSockPath));
      const deadServer = net.createServer();
      await new Promise<void>((resolve) => deadServer.listen(staleSockPath, resolve));
      const tempSock = path.join(kilnHome, "run", "tmp-stale.sock");
      fs.renameSync(staleSockPath, tempSock);
      await new Promise<void>((resolve) => deadServer.close(() => resolve()));
      fs.renameSync(tempSock, staleSockPath);
      expect(fs.lstatSync(staleSockPath).isSocket()).toBe(true);
    }

    const server = new KilndServer({ kilnHome, port: 0 });
    servers.push(server);
    const addr = await server.start();
    if (!isWindowsNamedPipe(addr.socketPath)) {
      expect(fs.statSync(addr.socketPath).mode & 0o777).toBe(0o600);
    }

    // Settings validation for roles & limits
    const putRoles = await requestHttp(server, "/api/settings/roles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        heterogeneous_review: true,
        roles: {
          worker: { agent: "codex", model: "gpt-5.4" },
          reviewer: {
            agent: "pi",
            model: "magpie/group/work",
            fallback: { agent: "codex", model: "gpt-5.4" },
          },
        },
      }),
    });
    expect(putRoles.status).toBe(200);
    expect(server.store.readConfig("roles")?.roles.worker?.model).toBe("gpt-5.4");

    const badLimits = await requestHttp(server, "/api/settings/limits", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema_version: 1, max_concurrent_slots: 0 }),
    });
    expect(badLimits.status).toBe(400);

    // Path traversal rejection on HTTP & UDS
    const traversalDraft = await requestHttp(server, "/api/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "../evil", title: "Escape" }),
    });
    expect(traversalDraft.status).toBe(400);

    const traversalTaskParam = await requestHttp(server, "/api/tasks/..%5Cevil");
    expect(traversalTaskParam.status).toBe(400);

    const traversalLedger = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_read_ledger",
      headers: {
        Authorization: `Bearer ${server.issueRunToken({
          taskId: "t-any",
          runId: "run-any",
          role: "intake",
          contractVersion: 1,
        })}`,
      },
      body: { space: "../etc" },
    });
    expect(traversalLedger.status).toBe(400);

    // Concurrent wb_submit_receipt race: strictly 1 accepted, 1 archived stale
    server.stateMachine.createTask(
      makeTaskCard({ id: "t-race", workspace_mode: "scratch_dir" }),
      "# Race brief",
    );
    server.persistRunForDispatch(
      makeRunMeta({
        task_id: "t-race",
        run_id: "run-race-1",
        contract_version: 1,
        input_ref: undefined,
      }),
      "001-implement",
    );
    const raceToken = server.issueRunToken({
      taskId: "t-race",
      runId: "run-race-1",
      role: "worker",
      contractVersion: 1,
    });

    const [r1, r2] = await Promise.all([
      requestMcpRpc(server, {
        method: "POST",
        path: "/rpc/mcp/wb_submit_receipt",
        headers: { Authorization: `Bearer ${raceToken}` },
        body: { markdown: makeValidWorkerReceiptMarkdown("run-race-1", 1, "Winner 1") },
      }),
      requestMcpRpc(server, {
        method: "POST",
        path: "/rpc/mcp/wb_submit_receipt",
        headers: { Authorization: `Bearer ${raceToken}` },
        body: { markdown: makeValidWorkerReceiptMarkdown("run-race-1", 1, "Winner 2") },
      }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const acceptedFlags = [Boolean(r1.json.accepted), Boolean(r2.json.accepted)].sort();
    expect(acceptedFlags).toEqual([false, true]);

    // SSE replay via ?lastEventId= query param + invalid lastEventId 400
    const badSse = await requestHttp(server, "/api/events?lastEventId=-1");
    expect(badSse.status).toBe(400);

    const sseAbort = new AbortController();
    const sseQueryRes = await requestHttp(server, "/api/events?lastEventId=0", {
      signal: sseAbort.signal,
    });
    expect(sseQueryRes.status).toBe(200);
    const queryReader = sseQueryRes.body!.getReader();
    const firstBatch = await queryReader.read();
    const replayed = parseSseFrames(new TextDecoder().decode(firstBatch.value));
    expect(replayed.length).toBeGreaterThanOrEqual(1);
    expect(replayed[0]!.id).toBe(1);
    sseAbort.abort();
    await queryReader.cancel().catch(() => {});

    // Decide error guards: rogue run_id without active dispatch -> 409; valid dispatched run -> 200; mismatched decision_id -> 409; missing acceptFilesHash -> 400
    const rogueTriageToken = server.issueRunToken({
      taskId: "t-race",
      runId: "run-race-2",
      role: "triage",
      contractVersion: 1,
    });
    const rogueAsk = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_ask_decision",
      headers: { Authorization: `Bearer ${rogueTriageToken}` },
      body: {
        category: "gate",
        reason: "Unauthorized run check",
        question: "Should fail?",
        options: [{ id: "opt-go", label: "Continue", action: "resume", recommended: true }],
      },
    });
    expect(rogueAsk.status).toBe(409);

    server.persistRunForDispatch(
      makeRunMeta({
        task_id: "t-race",
        run_id: "run-race-2",
        stage: "triage",
        round: 1,
        role: "triage",
        contract_version: 1,
        input_ref: undefined,
      }),
      "002-triage",
    );
    const ask3 = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_ask_decision",
      headers: { Authorization: `Bearer ${rogueTriageToken}` },
      body: {
        category: "gate",
        reason: "Need guidance",
        question: "Which command?",
        options: [{ id: "opt-go", label: "Continue", action: "resume", recommended: true }],
      },
    });
    expect(ask3.status).toBe(200);

    const wrongDecId = await requestHttp(server, "/api/tasks/t-race/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision_id: "dec-wrong", option_id: "opt-go" }),
    });
    expect(wrongDecId.status).toBe(409);

    const missingHashDecide = await requestHttp(server, "/api/tasks/t-race/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision_id: ask3.json.decision.id,
        option_id: "opt-go",
        contractUpdate: {
          contractPatch: { accept_cmd: "pnpm test --changed" },
          affectedStages: ["implement"],
        },
      }),
    });
    expect(missingHashDecide.status).toBe(400);
  });

  it("returns HTTP 409 HashMismatchError without overwriting tampered host_scoped targets, and 200 when unmodified", async () => {
    const kilnHome = makeTempDir();
    const hostRoot = makeTempDir("kiln-host-");
    tempDirs.push(kilnHome, hostRoot);

    const server = new KilndServer({ kilnHome, port: 0 });
    servers.push(server);
    await server.start();

    // Case 1: Tampered host file -> 409 hash_mismatch, file untouched
    const targetConflict = path.join(hostRoot, "zshrc.conf");
    fs.writeFileSync(targetConflict, "export PATH=/usr/bin\n", "utf8");

    server.stateMachine.createTask(
      makeTaskCard({
        id: "t-host-conflict",
        workspace_mode: "host_scoped",
        contract: makeContract({ scope: [hostRoot] }),
      }),
      "# Host conflict test",
    );
    writeFileAtomic(
      path.join(server.store.paths.stagedDir("t-host-conflict"), "zshrc.conf"),
      "export PATH=/opt/kiln/bin\n",
    );

    const staged1 = stageHostScopedChanges(server.store, {
      taskId: "t-host-conflict",
      contractScope: [hostRoot],
      stagedFiles: [{ stagedRelativePath: "zshrc.conf", targetPath: targetConflict }],
    });
    expect(staged1.ok).toBe(true);

    const applied1 = await applyApprovedHostScopedChanges(server.store, {
      taskId: "t-host-conflict",
      approved: true,
    });
    expect(applied1.ok).toBe(true);

    const tamperedText = "export PATH=/opt/manual-edit/bin\n";
    fs.writeFileSync(targetConflict, tamperedText, "utf8");

    const conflictRes = await requestHttp(
      server,
      "/api/tasks/t-host-conflict/restore-backup",
      { method: "POST" },
    );
    expect(conflictRes.status).toBe(409);
    const conflictJson = await conflictRes.json();
    const parsedErr = HashMismatchErrorSchema.parse(conflictJson);
    expect(parsedErr.code).toBe("hash_mismatch");
    expect(parsedErr.diff).toContain("-export PATH=/opt/kiln/bin");
    expect(parsedErr.diff).toContain("+export PATH=/opt/manual-edit/bin");
    expect(fs.readFileSync(targetConflict, "utf8")).toBe(tamperedText);

    // Case 2: Unmodified host file -> 200 and original contents restored
    const targetClean = path.join(hostRoot, "clean.conf");
    fs.writeFileSync(targetClean, "ORIGINAL=1\n", "utf8");

    server.stateMachine.createTask(
      makeTaskCard({
        id: "t-host-clean",
        workspace_mode: "host_scoped",
        contract: makeContract({ scope: [hostRoot] }),
      }),
      "# Host clean restore test",
    );
    writeFileAtomic(
      path.join(server.store.paths.stagedDir("t-host-clean"), "clean.conf"),
      "APPLIED=2\n",
    );

    stageHostScopedChanges(server.store, {
      taskId: "t-host-clean",
      contractScope: [hostRoot],
      stagedFiles: [{ stagedRelativePath: "clean.conf", targetPath: targetClean }],
    });
    await applyApprovedHostScopedChanges(server.store, {
      taskId: "t-host-clean",
      approved: true,
    });
    expect(fs.readFileSync(targetClean, "utf8")).toBe("APPLIED=2\n");

    const restoreOkRes = await requestHttp(server, "/api/tasks/t-host-clean/restore-backup", {
      method: "POST",
    });
    expect(restoreOkRes.status).toBe(200);
    expect(fs.readFileSync(targetClean, "utf8")).toBe("ORIGINAL=1\n");
  });

  it("rejects wb_ask_decision when lease is null or expired across pause/resume cycles", async () => {
    const kilnHome = makeTempDir();
    tempDirs.push(kilnHome);

    const server = new KilndServer({ kilnHome, port: 0, tokenSecret: "lease-guard-secret-123456" });
    servers.push(server);
    await server.start();

    // 1. Task has never been dispatched (lease === null)
    server.stateMachine.createTask(
      makeTaskCard({ id: "t-never-dispatched", workspace_mode: "scratch_dir" }),
      "# Never dispatched",
    );
    const rogueNeverToken = server.issueRunToken({
      taskId: "t-never-dispatched",
      runId: "run-rogue-never",
      role: "worker",
      contractVersion: 1,
    });
    const askNever = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_ask_decision",
      headers: { Authorization: `Bearer ${rogueNeverToken}` },
      body: {
        category: "scope",
        reason: "Unauthorized",
        question: "Proceed?",
        options: [{ id: "opt-1", label: "Resume", action: "resume", recommended: true }],
      },
    });
    expect(askNever.status).toBe(409);
    expect(server.store.getTaskIndex("t-never-dispatched")?.status).toBe("queued");
    expect(server.pendingDecisions.get("t-never-dispatched")).toBeNull();

    // 2. Dispatch run-1 -> pause -> resume -> dispatch run-2 -> pause -> resume (lease expired on run-2, task queued)
    server.stateMachine.createTask(
      makeTaskCard({ id: "t-paused-stale", workspace_mode: "scratch_dir" }),
      "# Pause resume cycle",
    );
    expect(
      server.persistRunForDispatch(
        makeRunMeta({ task_id: "t-paused-stale", run_id: "run-cycle-1", input_ref: undefined }),
        "001-implement",
      ),
    ).toEqual({ acquired: true });
    const tok1 = server.issueRunToken({
      taskId: "t-paused-stale",
      runId: "run-cycle-1",
      role: "worker",
      contractVersion: 1,
    });
    expect((await requestHttp(server, "/api/tasks/t-paused-stale/pause", { method: "POST" })).status).toBe(200);
    expect((await requestHttp(server, "/api/tasks/t-paused-stale/resume", { method: "POST" })).status).toBe(200);

    expect(
      server.persistRunForDispatch(
        makeRunMeta({ task_id: "t-paused-stale", run_id: "run-cycle-2", round: 2, input_ref: undefined }),
        "002-implement",
      ),
    ).toEqual({ acquired: true });
    const tok2 = server.issueRunToken({
      taskId: "t-paused-stale",
      runId: "run-cycle-2",
      role: "worker",
      contractVersion: 1,
    });
    expect((await requestHttp(server, "/api/tasks/t-paused-stale/pause", { method: "POST" })).status).toBe(200);
    expect((await requestHttp(server, "/api/tasks/t-paused-stale/resume", { method: "POST" })).status).toBe(200);

    expect(server.store.getTaskIndex("t-paused-stale")?.status).toBe("queued");
    expect(server.store.getStageLease("t-paused-stale")?.state).toBe("expired");

    const staleAsk1 = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_ask_decision",
      headers: { Authorization: `Bearer ${tok1}` },
      body: {
        category: "scope",
        reason: "Hijack via old run-1",
        question: "Should fail?",
        options: [{ id: "opt-1", label: "Resume", action: "resume", recommended: true }],
      },
    });
    expect(staleAsk1.status).toBe(409);

    const staleAsk2 = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_ask_decision",
      headers: { Authorization: `Bearer ${tok2}` },
      body: {
        category: "scope",
        reason: "Hijack via expired run-2",
        question: "Should fail?",
        options: [{ id: "opt-1", label: "Resume", action: "resume", recommended: true }],
      },
    });
    expect(staleAsk2.status).toBe(409);
    expect(server.store.getTaskIndex("t-paused-stale")?.status).toBe("queued");
    expect(server.pendingDecisions.get("t-paused-stale")).toBeNull();
    expect(
      fs.existsSync(path.join(server.store.paths.taskDir("t-paused-stale"), "pending_decision.json")),
    ).toBe(false);
  });

  it("registers, recovers, and resolves upstream_cancelled pending decisions over HTTP /decide", async () => {
    const kilnHome = makeTempDir();
    tempDirs.push(kilnHome);

    const server = new KilndServer({ kilnHome, port: 0, tokenSecret: "upstream-decide-secret-123" });
    servers.push(server);
    await server.start();

    server.stateMachine.createTask(makeTaskCard({ id: "t-a", workspace_mode: "scratch_dir" }), "# A");
    server.stateMachine.createTask(makeTaskCard({ id: "t-x", workspace_mode: "scratch_dir" }), "# X");
    server.stateMachine.createTask(
      makeTaskCard({ id: "t-b", workspace_mode: "scratch_dir", depends_on: ["t-a"] }),
      "# B",
    );
    server.stateMachine.createTask(
      makeTaskCard({ id: "t-c", workspace_mode: "scratch_dir", depends_on: ["t-b"] }),
      "# C",
    );
    server.stateMachine.createTask(
      makeTaskCard({ id: "t-d", workspace_mode: "scratch_dir", depends_on: ["t-a", "t-x"] }),
      "# D",
    );

    const cancelA = await requestHttp(server, "/api/tasks/t-a/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Superseded upstream" }),
    });
    expect(cancelA.status).toBe(200);
    const cancelAJson = await readJson(cancelA);
    expect(cancelAJson.waitingDownstreamTaskIds).toEqual(["t-b", "t-d"]);

    const boot1 = await readJson(await requestHttp(server, "/api/bootstrap"));
    const pendingTaskIds = (boot1.pendingDecisions as Array<{ task_id: string }>).map((d) => d.task_id).sort();
    expect(pendingTaskIds).toEqual(["t-b", "t-d"]);

    const detailB = await readJson(await requestHttp(server, "/api/tasks/t-b"));
    expect(detailB.pendingDecision?.reason).toBe("upstream_cancelled");
    const originalDecIdB = detailB.pendingDecision.id as string;

    // Even if pending_decision.json is absent, hydrateFromDisk/get deterministically recreates it
    fs.rmSync(path.join(server.store.paths.taskDir("t-b"), "pending_decision.json"), { force: true });
    server.pendingDecisions.hydrateFromDisk();
    expect(server.pendingDecisions.get("t-b")?.id).toBe(originalDecIdB);

    // Resolve t-d via unbind_resume: unbinds cancelled t-a, preserves active t-x
    const decD = server.pendingDecisions.get("t-d")!;
    const decideD = await requestHttp(server, "/api/tasks/t-d/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision_id: decD.id,
        option_id: "unbind_resume",
        rationale: "Continue without t-a",
      }),
    });
    expect(decideD.status).toBe(200);
    const decideDJson = await readJson(decideD);
    expect(decideDJson.state.status).toBe("queued");
    expect(decideDJson.unboundDependencyIds).toEqual(["t-a"]);
    expect(server.store.readTaskCard("t-d").depends_on).toEqual(["t-x"]);
    expect(server.pendingDecisions.get("t-d")).toBeNull();

    // Resolve t-b via cancel_downstream: t-b cancelled -> registers upstream_cancelled pendingDecision for t-c
    const decideB = await requestHttp(server, "/api/tasks/t-b/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision_id: originalDecIdB,
        option_id: "cancel_downstream",
        rationale: "Cancel B too",
      }),
    });
    expect(decideB.status).toBe(200);
    const decideBJson = await readJson(decideB);
    expect(decideBJson.state.status).toBe("cancelled");
    expect(decideBJson.waitingDownstreamTaskIds).toEqual(["t-c"]);

    const boot2 = await readJson(await requestHttp(server, "/api/bootstrap"));
    expect((boot2.pendingDecisions as Array<{ task_id: string }>).map((d) => d.task_id)).toEqual(["t-c"]);

    const decC = server.pendingDecisions.get("t-c")!;
    const decideC = await requestHttp(server, "/api/tasks/t-c/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision_id: decC.id,
        option_id: "unbind_resume",
      }),
    });
    expect(decideC.status).toBe(200);
    expect(server.store.getTaskIndex("t-c")?.status).toBe("queued");
    expect(server.store.readTaskCard("t-c").depends_on).toEqual([]);
  });

  it("handles wb_plan(update_contract) across running/waiting/terminal states, paused-dep resume, commit_card blocked dep, and multi-dep pending decision sync", async () => {
    const kilnHome = makeTempDir();
    tempDirs.push(kilnHome);

    const caffeinate = new CaffeinateController({
      platform: "darwin",
      existsSync: () => true,
      pid: 4321,
      spawnProcess: () => makeFakeChild(),
    });
    const server = new KilndServer({
      kilnHome,
      port: 0,
      tokenSecret: "round2-closure-secret-123456",
      caffeinate,
    });
    servers.push(server);
    await server.start();

    const resolverTokenFor = (taskId: string, contractVersion = 1) =>
      server.issueRunToken({
        taskId,
        runId: `run-res-${taskId}`,
        role: "resolver",
        contractVersion,
      });

    // 1. running -> wb_plan(update_contract) transitions to queued, earliest affected stage, and drops caffeinate 1 -> 0
    server.stateMachine.createTask(
      makeTaskCard({ id: "t-run-uc", workspace_mode: "scratch_dir" }),
      "# Running task",
    );
    server.persistRunForDispatch(
      makeRunMeta({ task_id: "t-run-uc", run_id: "run-exec-1", stage: "review", round: 1, input_ref: undefined }),
      "001-review",
    );
    expect(caffeinate.isActive).toBe(true);

    const runUpdateRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_plan",
      headers: { Authorization: `Bearer ${resolverTokenFor("t-run-uc")}` },
      body: {
        mode: "update_contract",
        task_id: "t-run-uc",
        contract: { goal: "Updated running goal" },
        affected_stages: ["review", "implement"],
        rationale: "Rerun from implement",
      },
    });
    expect(runUpdateRes.status).toBe(200);
    expect(runUpdateRes.json.status).toBe("queued");
    expect(runUpdateRes.json.stage).toBe("implement");
    expect(runUpdateRes.json.contractVersion).toBe(2);
    expect(server.store.getTaskIndex("t-run-uc")?.status).toBe("queued");
    expect(server.store.getStageLease("t-run-uc")?.state).toBe("expired");
    expect(caffeinate.isActive).toBe(false);

    // 2. waiting -> wb_plan(update_contract) rebinds PendingDecision contract_version so hydrateFromDisk & /decide succeed
    server.stateMachine.createTask(
      makeTaskCard({ id: "t-wait-uc", workspace_mode: "scratch_dir" }),
      "# Waiting task",
    );
    server.persistRunForDispatch(
      makeRunMeta({ task_id: "t-wait-uc", run_id: "run-wait-1", stage: "implement", round: 1, input_ref: undefined }),
      "001-implement",
    );
    const waitToken = server.issueRunToken({
      taskId: "t-wait-uc",
      runId: "run-wait-1",
      role: "worker",
      contractVersion: 1,
    });
    const askWait = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_ask_decision",
      headers: { Authorization: `Bearer ${waitToken}` },
      body: {
        category: "scope",
        reason: "Need new contract clarification",
        question: "Proceed with updated spec?",
        options: [{ id: "opt-go", label: "Continue", action: "resume", recommended: true }],
      },
    });
    expect(askWait.status).toBe(200);
    const waitDecId = askWait.json.decision.id as string;

    const waitUpdateRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_plan",
      headers: { Authorization: `Bearer ${resolverTokenFor("t-wait-uc")}` },
      body: {
        mode: "update_contract",
        task_id: "t-wait-uc",
        contract: { goal: "Updated waiting goal" },
        affected_stages: ["implement"],
        rationale: "Updated contract during resolver discussion",
      },
    });
    expect(waitUpdateRes.status).toBe(200);
    expect(waitUpdateRes.json.status).toBe("waiting");
    expect(waitUpdateRes.json.contractVersion).toBe(2);

    server.pendingDecisions.hydrateFromDisk();
    const reboundDec = server.pendingDecisions.get("t-wait-uc");
    expect(reboundDec?.id).toBe(waitDecId);
    expect(reboundDec?.contract_version).toBe(2);

    const decideWaitRes = await requestHttp(server, "/api/tasks/t-wait-uc/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision_id: waitDecId,
        option_id: "opt-go",
        rationale: "Approved updated v2 contract",
      }),
    });
    expect(decideWaitRes.status).toBe(200);
    expect(server.store.getTaskIndex("t-wait-uc")?.status).toBe("queued");

    // 3. terminal tasks reject wb_plan(update_contract) with 409
    server.stateMachine.createTask(
      makeTaskCard({ id: "t-term-cancel", workspace_mode: "scratch_dir" }),
      "# Cancelled",
    );
    await requestHttp(server, "/api/tasks/t-term-cancel/cancel", { method: "POST" });
    const termUpdateRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_plan",
      headers: { Authorization: `Bearer ${resolverTokenFor("t-term-cancel")}` },
      body: {
        mode: "update_contract",
        task_id: "t-term-cancel",
        contract: { goal: "Should fail" },
        affected_stages: ["implement"],
        rationale: "Rejected on terminal task",
      },
    });
    expect(termUpdateRes.status).toBe(409);

    // 4. paused downstream whose prerequisite cancels while paused enters waiting(upstream_cancelled) upon /resume
    server.stateMachine.createTask(
      makeTaskCard({ id: "t-up1", workspace_mode: "scratch_dir" }),
      "# Up 1",
    );
    server.stateMachine.createTask(
      makeTaskCard({ id: "t-up2", workspace_mode: "scratch_dir" }),
      "# Up 2",
    );
    server.stateMachine.createTask(
      makeTaskCard({ id: "t-paused-down", workspace_mode: "scratch_dir", depends_on: ["t-up1", "t-up2"] }),
      "# Paused down",
    );
    expect((await requestHttp(server, "/api/tasks/t-paused-down/pause", { method: "POST" })).status).toBe(200);
    expect((await requestHttp(server, "/api/tasks/t-up1/cancel", { method: "POST" })).status).toBe(200);
    expect(server.store.getTaskIndex("t-paused-down")?.status).toBe("paused");

    const resumeRes = await requestHttp(server, "/api/tasks/t-paused-down/resume", { method: "POST" });
    expect(resumeRes.status).toBe(200);
    const resumeJson = await readJson(resumeRes);
    expect(resumeJson.state.status).toBe("waiting");
    const firstDownDec = server.pendingDecisions.get("t-paused-down");
    expect(firstDownDec?.reason).toBe("upstream_cancelled");
    expect(firstDownDec?.question).toContain("t-up1");

    // 5. Second prerequisite cancels later -> get() preserves same decision ID & refreshes question with both t-up1 and t-up2
    expect((await requestHttp(server, "/api/tasks/t-up2/cancel", { method: "POST" })).status).toBe(200);
    const refreshedDec = server.pendingDecisions.get("t-paused-down");
    expect(refreshedDec?.id).toBe(firstDownDec?.id);
    expect(refreshedDec?.question).toContain("t-up1");
    expect(refreshedDec?.question).toContain("t-up2");

    const decideDown = await requestHttp(server, "/api/tasks/t-paused-down/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision_id: refreshedDec!.id,
        option_id: "unbind_resume",
      }),
    });
    expect(decideDown.status).toBe(200);
    const decideDownJson = await readJson(decideDown);
    expect(decideDownJson.unboundDependencyIds).toEqual(["t-up1", "t-up2"]);
    expect(server.store.getTaskIndex("t-paused-down")?.status).toBe("queued");

    // 6. commit_card (MCP) and draft commit (HTTP) with cancelled dep auto-register upstream_cancelled pendingDecision
    const commitBlockedRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_plan",
      headers: { Authorization: `Bearer ${resolverTokenFor("t-up1")}` },
      body: {
        mode: "commit_card",
        title: "Born blocked by t-up1",
        space: "kiln",
        workspace_mode: "scratch_dir",
        depends_on: ["t-up1"],
        contract: makeContract({ scope: ["out.md"] }),
        brief_markdown: "# Blocked",
      },
    });
    expect(commitBlockedRes.status).toBe(200);
    const bornBlockedId = commitBlockedRes.json.card.id as string;
    expect(commitBlockedRes.json.state.status).toBe("waiting");
    expect(server.pendingDecisions.get(bornBlockedId)?.reason).toBe("upstream_cancelled");

    // 7. PendingDecisionStore.get() clears stale non-matching decision_id file
    server.stateMachine.createTask(
      makeTaskCard({ id: "t-stale-dec", workspace_mode: "scratch_dir" }),
      "# Stale dec",
    );
    server.persistRunForDispatch(
      makeRunMeta({ task_id: "t-stale-dec", run_id: "run-sd-1", input_ref: undefined }),
      "001-implement",
    );
    const sdTok = server.issueRunToken({
      taskId: "t-stale-dec",
      runId: "run-sd-1",
      role: "worker",
      contractVersion: 1,
    });
    const askSd = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_ask_decision",
      headers: { Authorization: `Bearer ${sdTok}` },
      body: {
        category: "scope",
        reason: "Question 1",
        question: "Proceed?",
        options: [{ id: "opt-1", label: "Go", action: "resume", recommended: true }],
      },
    });
    expect(askSd.status).toBe(200);
    // Append a newer waiting event bound to another decision_id
    server.store.appendStateEvent("t-stale-dec", {
      type: "waiting",
      at: "2026-11-19T12:10:00.000Z",
      reason: "Question 2",
      decision_id: "dec-newer-expected",
    });
    expect(server.pendingDecisions.get("t-stale-dec")).toBeNull();
    expect(
      fs.existsSync(path.join(server.store.paths.taskDir("t-stale-dec"), "pending_decision.json")),
    ).toBe(false);
  });

  it("closes Round 3 decide/commit upstream_cancelled transitions, SSE notifications, and affectedStages.min(1) validation", async () => {
    const kilnHome = makeTempDir();
    tempDirs.push(kilnHome);

    const server = new KilndServer({ kilnHome, port: 0, tokenSecret: "round3-closure-secret-123" });
    servers.push(server);
    await server.start();

    const decoder = new TextDecoder();
    const sseAbort = new AbortController();
    const sseRes = await requestHttp(server, "/api/events", { signal: sseAbort.signal });
    expect(sseRes.status).toBe(200);
    const reader = sseRes.body!.getReader();

    // Wait for initial heartbeat/stream open without blocking
    server.stateMachine.createTask(
      makeTaskCard({ id: "t-r3-up", workspace_mode: "scratch_dir" }),
      "# Upstream",
    );
    server.stateMachine.createTask(
      makeTaskCard({ id: "t-r3-down", workspace_mode: "scratch_dir", depends_on: ["t-r3-up"] }),
      "# Downstream",
    );
    server.persistRunForDispatch(
      makeRunMeta({ task_id: "t-r3-down", run_id: "run-r3-1", input_ref: undefined }),
      "001-implement",
    );
    const workerTok = server.issueRunToken({
      taskId: "t-r3-down",
      runId: "run-r3-1",
      role: "worker",
      contractVersion: 1,
    });
    const askNormal = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_ask_decision",
      headers: { Authorization: `Bearer ${workerTok}` },
      body: {
        category: "design",
        reason: "Choose format",
        question: "Use YAML or JSON?",
        options: [{ id: "opt-yaml", label: "Use YAML", action: "resume", recommended: true }],
      },
    });
    expect(askNormal.status).toBe(200);
    const normalDecId = askNormal.json.decision.id as string;

    // Upstream cancels while t-r3-down is waiting on normal decision
    expect((await requestHttp(server, "/api/tasks/t-r3-up/cancel", { method: "POST" })).status).toBe(200);

    // Reject empty contractUpdate.affectedStages with 400
    const badAffected = await requestHttp(server, "/api/tasks/t-r3-down/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision_id: normalDecId,
        option_id: "opt-yaml",
        contractUpdate: { contractPatch: { goal: "x" }, affectedStages: [] },
      }),
    });
    expect(badAffected.status).toBe(400);

    // Resolve normal decision with action="resume" -> immediately lands in waiting(upstream_cancelled) with registered PendingDecision & SSE
    const resolveNormal = await requestHttp(server, "/api/tasks/t-r3-down/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision_id: normalDecId,
        option_id: "opt-yaml",
        rationale: "YAML selected",
      }),
    });
    expect(resolveNormal.status).toBe(200);
    const resolveNormalJson = await readJson(resolveNormal);
    expect(resolveNormalJson.state.status).toBe("waiting");

    const bootAfterNormal = await readJson(await requestHttp(server, "/api/bootstrap"));
    const upstreamDec = (bootAfterNormal.pendingDecisions as Array<{ id: string; task_id: string; reason: string }>)
      .find((d) => d.task_id === "t-r3-down");
    expect(upstreamDec).toBeDefined();
    expect(upstreamDec?.reason).toBe("upstream_cancelled");

    // HTTP POST /api/drafts -> POST /api/drafts/:id/commit depending on already-cancelled t-r3-up
    const createDraftRes = await requestHttp(server, "/api/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "draft-r3-blocked",
        title: "HTTP draft depending on cancelled dep",
        space: "kiln",
        workspace_mode: "scratch_dir",
        depends_on: ["t-r3-up"],
        contract: makeContract({ scope: ["out.md"] }),
      }),
    });
    expect(createDraftRes.status).toBe(201);

    const commitDraftRes = await requestHttp(server, "/api/drafts/draft-r3-blocked/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "t-r3-draft-born",
        brief_markdown: "# HTTP blocked commit",
      }),
    });
    expect(commitDraftRes.status).toBe(201);
    const commitDraftJson = await readJson(commitDraftRes);
    expect(commitDraftJson.state.status).toBe("waiting");
    expect(server.pendingDecisions.get("t-r3-draft-born")?.reason).toBe("upstream_cancelled");

    // Resolve t-r3-down's newly created upstream_cancelled decision -> unbinds t-r3-up & queues
    const resolveUpstream = await requestHttp(server, "/api/tasks/t-r3-down/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision_id: upstreamDec!.id,
        option_id: "unbind_resume",
      }),
    });
    expect(resolveUpstream.status).toBe(200);
    const resolveUpstreamJson = await readJson(resolveUpstream);
    expect(resolveUpstreamJson.state.status).toBe("queued");
    expect(resolveUpstreamJson.unboundDependencyIds).toEqual(["t-r3-up"]);

    // Verify SSE stream received decision.requested frames for both t-r3-down and t-r3-draft-born
    let sseText = "";
    const frames: Array<{ id: number; event: string; data: SseEvent }> = [];
    while (
      !frames.some((f) => f.data.type === "decision.requested" && f.data.taskId === "t-r3-draft-born") ||
      frames.filter((f) => f.data.type === "decision.requested" && f.data.taskId === "t-r3-down").length < 2
    ) {
      const chunk = await reader.read();
      if (chunk.done) break;
      sseText += decoder.decode(chunk.value, { stream: true });
      frames.splice(0, frames.length, ...parseSseFrames(sseText));
    }
    expect(
      frames.some((f) => f.data.type === "decision.requested" && f.data.taskId === "t-r3-draft-born"),
    ).toBe(true);
    expect(
      frames.filter((f) => f.data.type === "decision.requested" && f.data.taskId === "t-r3-down").length,
    ).toBeGreaterThanOrEqual(2);

    sseAbort.abort();
    await reader.cancel().catch(() => {});
  });

  it("P1 #6: wb_submit_receipt rejects malformed or mismatched receipts with 400 invalid_receipt without consuming the active lease, allowing same-turn resubmission", async () => {
    const kilnHome = makeTempDir();
    tempDirs.push(kilnHome);

    const server = new KilndServer({ kilnHome, port: 0, tokenSecret: "p1-6-receipt-secret-123" });
    servers.push(server);
    await server.start();

    server.stateMachine.createTask(
      makeTaskCard({ id: "t-p1-6", workspace_mode: "scratch_dir" }),
      "# Receipt validation test",
    );
    server.persistRunForDispatch(
      makeRunMeta({
        task_id: "t-p1-6",
        run_id: "run-p1-6-rev",
        stage: "review",
        round: 1,
        role: "reviewer",
        contract_version: 1,
        input_ref: "deadbeef",
      }),
      "001-review",
    );
    const reviewerToken = server.issueRunToken({
      taskId: "t-p1-6",
      runId: "run-p1-6-rev",
      role: "reviewer",
      contractVersion: 1,
    });

    // 1. Reviewer sends p0: [] (array instead of integer) AND misses required sections -> 400 invalid_receipt, lease remains active
    const badArrayRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_submit_receipt",
      headers: { Authorization: `Bearer ${reviewerToken}` },
      body: {
        markdown: serializeFrontmatterMarkdown(
          {
            run_id: "run-p1-6-rev",
            contract_version: 1,
            reviewed_ref: "deadbeef",
            verdict: "pass",
            p0: [],
            p1: 0,
            p2: 0,
          },
          "## 结论\npass\n",
        ),
      },
    });
    expect(badArrayRes.status).toBe(400);
    expect(badArrayRes.json.error).toBe("invalid_receipt");
    expect(badArrayRes.json.role).toBe("reviewer");
    expect(Array.isArray(badArrayRes.json.errors)).toBe(true);
    expect((badArrayRes.json.errors as string[]).some((e) => e.includes("p0"))).toBe(true);
    expect(
      (badArrayRes.json.errors as string[]).some((e) => e.includes("缺陷清单")),
    ).toBe(true);
    expect(server.store.getStageLease("t-p1-6")?.state).toBe("active");
    expect(fs.existsSync(server.store.paths.receiptMd("t-p1-6", "001-review"))).toBe(false);

    // 2. Reviewer sends mismatched run_id -> 400 invalid_receipt, lease STILL active
    const mismatchRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_submit_receipt",
      headers: { Authorization: `Bearer ${reviewerToken}` },
      body: {
        markdown: serializeFrontmatterMarkdown(
          {
            run_id: "run-wrong",
            contract_version: 1,
            reviewed_ref: "deadbeef",
            verdict: "pass",
            p0: 0,
            p1: 0,
            p2: 0,
          },
          "## 结论\nok\n\n## 缺陷清单\n无\n\n## 测试真实性与复现核查\nok\n",
        ),
      },
    });
    expect(mismatchRes.status).toBe(400);
    expect(mismatchRes.json.error).toBe("invalid_receipt");
    expect(server.store.getStageLease("t-p1-6")?.state).toBe("active");
    expect(fs.existsSync(server.store.paths.receiptMd("t-p1-6", "001-review"))).toBe(false);

    // 3. Same-turn corrected resubmission succeeds -> 200 accepted: true and completes lease
    const goodReviewerRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_submit_receipt",
      headers: { Authorization: `Bearer ${reviewerToken}` },
      body: {
        markdown: serializeFrontmatterMarkdown(
          {
            run_id: "run-p1-6-rev",
            contract_version: 1,
            reviewed_ref: "deadbeef",
            verdict: "pass",
            p0: 0,
            p1: 0,
            p2: 0,
          },
          "## 结论\n通过\n\n## 缺陷清单\n无\n\n## 测试真实性与复现核查\n已验证\n",
        ),
      },
    });
    expect(goodReviewerRes.status).toBe(200);
    expect(goodReviewerRes.json.accepted).toBe(true);
    expect(server.store.getStageLease("t-p1-6")?.state).toBe("completed");
    expect(fs.existsSync(server.store.paths.receiptMd("t-p1-6", "001-review"))).toBe(true);

    // 4. Worker missing required section fails 400 without consuming lease, then valid worker receipt succeeds
    server.stateMachine.createTask(
      makeTaskCard({ id: "t-p1-6-w", workspace_mode: "scratch_dir" }),
      "# Worker validation test",
    );
    server.persistRunForDispatch(
      makeRunMeta({
        task_id: "t-p1-6-w",
        run_id: "run-p1-6-w",
        stage: "implement",
        round: 1,
        role: "worker",
        contract_version: 1,
        input_ref: undefined,
      }),
      "001-implement",
    );
    const workerToken = server.issueRunToken({
      taskId: "t-p1-6-w",
      runId: "run-p1-6-w",
      role: "worker",
      contractVersion: 1,
    });
    const badWorkerRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_submit_receipt",
      headers: { Authorization: `Bearer ${workerToken}` },
      body: {
        markdown: serializeFrontmatterMarkdown(
          {
            run_id: "run-p1-6-w",
            contract_version: 1,
            outcome: "completed",
            input_ref: "scratch_dir",
            output_ref: "out.txt",
            changed_paths: ["out.txt"],
            accept_result: "pass",
            is_bugfix: false,
            complexity_escalate: false,
          },
          "## 改动说明\n只写了部分章节\n",
        ),
      },
    });
    expect(badWorkerRes.status).toBe(400);
    expect(badWorkerRes.json.error).toBe("invalid_receipt");
    expect(server.store.getStageLease("t-p1-6-w")?.state).toBe("active");

    const goodWorkerRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_submit_receipt",
      headers: { Authorization: `Bearer ${workerToken}` },
      body: { markdown: makeValidWorkerReceiptMarkdown("run-p1-6-w", 1) },
    });
    expect(goodWorkerRes.status).toBe(200);
    expect(goodWorkerRes.json.accepted).toBe(true);
    expect(server.store.getStageLease("t-p1-6-w")?.state).toBe("completed");
  });

  it("supports space CRUD + inspect, draft delete, commit validation/cleanup, and wb_list_tasks discovery for empty spaces", async () => {
    const kilnHome = makeTempDir("kiln-space-home-");
    const repoRoot = makeTempDir("kiln-space-repo-");
    const nonGitDir = makeTempDir("kiln-non-git-");
    tempDirs.push(kilnHome, repoRoot, nonGitDir);

    const runGit = (args: string[], cwd = repoRoot) =>
      execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });

    runGit(["init", "-b", "main"]);
    runGit(["config", "user.name", "Kiln Test"]);
    runGit(["config", "user.email", "kiln@example.com"]);
    fs.mkdirSync(path.join(repoRoot, "src", "nested"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "node_modules"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ name: "My Cool App", scripts: { test: "vitest run" } }),
    );
    fs.writeFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    runGit(["add", "."]);
    runGit(["commit", "-m", "init"]);

    const server = new KilndServer({
      kilnHome,
      port: 0,
      tokenSecret: "space-crud-secret-0123456789abcde",
    });
    servers.push(server);
    await server.start();

    // 1. Inspect subdirectory normalizes to canonical Git root and detects branch/test/deps
    const inspectRes = await requestHttp(server, "/api/spaces/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path.join(repoRoot, "src", "nested") }),
    });
    expect(inspectRes.status).toBe(200);
    const inspectJson = await readJson(inspectRes);
    const canonicalRepo = realpathCanonical(repoRoot);
    expect(inspectJson.ok).toBe(true);
    expect(inspectJson.repo_path).toBe(canonicalRepo);
    expect(inspectJson.default_branch).toBe("main");
    expect(inspectJson.default_accept_cmd).toBe("pnpm test");
    expect(inspectJson.clone_deps).toEqual(["node_modules"]);
    expect(inspectJson.suggested_id).toMatch(/^[a-z0-9_-]+$/);

    // Non-Git dir fails cleanly with 400 invalid_repo_path
    const badInspectRes = await requestHttp(server, "/api/spaces/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: nonGitDir }),
    });
    expect(badInspectRes.status).toBe(400);
    expect((await readJson(badInspectRes)).error).toBe("invalid_repo_path");

    // 2. Reject reserved space IDs ("local" and "all")
    for (const reserved of ["local", "all"]) {
      const reservedRes = await requestHttp(server, `/api/spaces/${reserved}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Reserved", repo_path: repoRoot }),
      });
      expect(reservedRes.status).toBe(400);
      expect((await readJson(reservedRes)).error).toBe("reserved_space_id");
    }

    // 3. Create + update space via PUT /api/spaces/:id, verify GET /api/spaces & wb_list_tasks visibility with 0 tasks
    const createSpaceRes = await requestHttp(server, "/api/spaces/my-app", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "My App",
        repo_path: path.join(repoRoot, "src"),
        default_branch: "main",
        default_accept_cmd: "pnpm test",
        clone_deps: ["node_modules"],
      }),
    });
    expect(createSpaceRes.status).toBe(201);
    const createSpaceJson = await readJson(createSpaceRes);
    expect(createSpaceJson.space.repo_path).toBe(canonicalRepo);

    const updateSpaceRes = await requestHttp(server, "/api/spaces/my-app", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "My App Renamed",
        repo_path: repoRoot,
        default_branch: "main",
      }),
    });
    expect(updateSpaceRes.status).toBe(200);

    const listSpacesRes = await requestHttp(server, "/api/spaces");
    expect(listSpacesRes.status).toBe(200);
    const listSpacesJson = await readJson(listSpacesRes);
    expect(listSpacesJson.spaces["my-app"]?.name).toBe("My App Renamed");
    expect(listSpacesJson.spaces.local).toMatchObject({
      id: "local",
      name: "本机与临时",
    });
    expect(listSpacesJson.spaces.local?.repo_path).toBeUndefined();

    const bootDefaultLocalRes = await requestHttp(server, "/api/bootstrap");
    expect(bootDefaultLocalRes.status).toBe(200);
    const bootDefaultLocalJson = await readJson(bootDefaultLocalRes);
    expect(bootDefaultLocalJson.spaces.local).toMatchObject({
      id: "local",
      name: "本机与临时",
    });
    expect(bootDefaultLocalJson.spaces.local?.repo_path).toBeUndefined();

    const intakeToken = server.issueRunToken({
      taskId: "d-empty-list",
      runId: "run-empty-list",
      role: "intake",
      contractVersion: 1,
    });
    const mcpListEmptyRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_list_tasks",
      headers: { Authorization: `Bearer ${intakeToken}` },
      body: {},
    });
    expect(mcpListEmptyRes.status).toBe(200);
    expect(mcpListEmptyRes.json.spaces["my-app"]?.repo_path).toBe(canonicalRepo);

    // 4. Commit hard validation: local + git_worktree and missing repo_path fail with 400
    await requestHttp(server, "/api/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "d-bad-local",
        title: "Invalid local git_worktree",
        space: "local",
        workspace_mode: "git_worktree",
        contract: makeContract(),
      }),
    });
    const badLocalCommit = await requestHttp(server, "/api/drafts/d-bad-local/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief_markdown: "# Bad commit" }),
    });
    expect(badLocalCommit.status).toBe(400);
    expect((await readJson(badLocalCommit)).error).toBe("invalid_workspace_space");

    const mcpBadSpaceCommit = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_plan",
      headers: { Authorization: `Bearer ${intakeToken}` },
      body: {
        mode: "commit_card",
        title: "Missing repo_path space",
        space: "unknown-space",
        workspace_mode: "git_worktree",
        contract: makeContract(),
        brief_markdown: "# Missing repo",
      },
    });
    expect(mcpBadSpaceCommit.status).toBe(400);
    expect(mcpBadSpaceCommit.json.error).toBe("space_repo_required");

    // 5. Delete draft removes both draft directory and chat log; valid commit also deletes source draft
    writeFileAtomic(path.join(server.store.paths.draftsDir, "d-bad-local-chat.ndjson"), "{}\n");
    const delDraftRes = await requestHttp(server, "/api/drafts/d-bad-local", {
      method: "DELETE",
    });
    expect(delDraftRes.status).toBe(200);
    expect(server.store.readDraft("d-bad-local")).toBeNull();
    expect(fs.existsSync(path.join(server.store.paths.draftsDir, "d-bad-local-chat.ndjson"))).toBe(
      false,
    );

    await requestHttp(server, "/api/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "d-good-proj",
        title: "Valid Project Task",
        space: "my-app",
        workspace_mode: "git_worktree",
        contract: makeContract(),
      }),
    });
    const goodCommitRes = await requestHttp(server, "/api/drafts/d-good-proj/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "t-proj-1", brief_markdown: "# Valid project task" }),
    });
    expect(goodCommitRes.status).toBe(201);
    expect(server.store.readDraft("d-good-proj")).toBeNull();

    // 6. Deleting space with active task returns 409 space_in_use; succeeds once cancelled
    const delBusySpace = await requestHttp(server, "/api/spaces/my-app", {
      method: "DELETE",
    });
    expect(delBusySpace.status).toBe(409);
    expect((await readJson(delBusySpace)).error).toBe("space_in_use");

    const cancelRes = await requestHttp(server, "/api/tasks/t-proj-1/cancel", {
      method: "POST",
    });
    expect(cancelRes.status).toBe(200);

    const delFreeSpace = await requestHttp(server, "/api/spaces/my-app", {
      method: "DELETE",
    });
    expect(delFreeSpace.status).toBe(200);
    expect(server.store.readSpace("my-app")).toBeNull();
  });

  it("exposes per-model tokens_by_model on /api/bootstrap for heterogeneous multi-model tasks", async () => {
    const kilnHome = makeTempDir("kiln-hetero-boot-");
    tempDirs.push(kilnHome);

    const server = new KilndServer({
      kilnHome,
      port: 0,
      tokenSecret: "hetero-boot-secret-0123456789abcdef",
    });
    servers.push(server);
    await server.start();

    server.store.writeConfig("pricing", {
      schema_version: 1,
      models: {
        "gpt-6-luna": { in: 0.15, cached: 0.015, out: 0.6 },
        "gpt-6.2-sol": { in: 2.5, cached: 0.25, out: 10 },
      },
    });

    server.store.createTask(
      makeTaskCard({
        id: "t-hetero",
        space: "local",
        workspace_mode: "scratch_dir",
      }),
      "# Multi-model task",
    );

    server.store.persistRunBeforeDispatch(
      makeRunMeta({
        task_id: "t-hetero",
        run_id: "run-hetero-impl",
        stage: "implement",
        role: "worker",
        model: "gpt-6-luna",
      }),
      "001-implement",
    );
    server.store.recordRunEvent("t-hetero", "001-implement", {
      kind: "usage",
      at: "2026-11-21T04:50:00.000Z",
      turnId: "turn-impl-1",
      agent: "codex",
      model: "gpt-6-luna",
      inputTokens: 60_000,
      cachedInputTokens: 50_000,
      outputTokens: 1_000,
    });

    server.store.persistRunBeforeDispatch(
      makeRunMeta({
        task_id: "t-hetero",
        run_id: "run-hetero-rev",
        stage: "review",
        role: "reviewer",
        model: "gpt-6.2-sol",
        started_at: "2026-11-21T04:51:00.000Z",
      }),
      "002-review",
    );
    server.store.recordRunEvent("t-hetero", "002-review", {
      kind: "usage",
      at: "2026-11-21T04:51:10.000Z",
      turnId: "turn-rev-1",
      agent: "codex",
      model: "gpt-6.2-sol",
      inputTokens: 10_000,
      cachedInputTokens: 6_000,
      outputTokens: 1_037,
    });

    const res = await requestHttp(server, "/api/bootstrap");
    expect(res.status).toBe(200);
    const boot = await readJson<{
      tasks: Array<{
        id: string;
        model?: string;
        cost_usd: number;
        tokens_by_model?: Record<
          string,
          {
            inputTokens: number;
            cachedInputTokens: number;
            outputTokens: number;
            totalTokens: number;
            costUsd: number;
          }
        >;
      }>;
    }>(res);

    const task = boot.tasks.find((t) => t.id === "t-hetero");
    expect(task).toBeDefined();
    expect(task?.model).toBe("gpt-6.2-sol");
    expect(task?.tokens_by_model?.["gpt-6-luna"]).toMatchObject({
      inputTokens: 60_000,
      cachedInputTokens: 50_000,
      outputTokens: 1_000,
      totalTokens: 61_000,
    });
    expect(task?.tokens_by_model?.["gpt-6-luna"]?.costUsd).toBeCloseTo(0.00285, 8);
    expect(task?.tokens_by_model?.["gpt-6.2-sol"]).toMatchObject({
      inputTokens: 10_000,
      cachedInputTokens: 6_000,
      outputTokens: 1_037,
      totalTokens: 11_037,
    });
    expect(task?.tokens_by_model?.["gpt-6.2-sol"]?.costUsd).toBeCloseTo(0.02187, 8);
    expect(task?.cost_usd).toBeCloseTo(0.02472, 8);
  });

  it("discovers local Git repos without Paseo, picks native directories cross-platform, and persists draft intake_open", async () => {
    const fakeHome = makeTempDir("kiln-discover-home-");
    const kilnHome = path.join(fakeHome, ".kiln");
    const customParent = makeTempDir("kiln-discover-custom-");
    tempDirs.push(fakeHome, customParent);

    const repoAlpha = path.join(fakeHome, "AI", "alpha-app");
    const repoBeta = path.join(fakeHome, "Code", "nested", "beta-lib");
    const repoWorktree = path.join(fakeHome, "Projects", "wt-repo");
    const fakeBareGitDir = path.join(fakeHome, "Projects", ".wt-meta");
    const repoNodeModules = path.join(repoAlpha, "node_modules", "nested-git-ignored");
    const kilnWorkspaceRepo = path.join(kilnHome, "workspaces", "t-1");
    const customExistingRepo = path.join(customParent, "pinned-repo");
    const customSiblingRepo = path.join(customParent, "sibling-repo");

    for (const dir of [
      path.join(repoAlpha, ".git"),
      path.join(repoBeta, ".git"),
      path.join(fakeBareGitDir),
      path.join(repoNodeModules, ".git"),
      path.join(kilnWorkspaceRepo, ".git"),
      path.join(customExistingRepo, ".git"),
      path.join(customSiblingRepo, ".git"),
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.mkdirSync(repoWorktree, { recursive: true });
    fs.writeFileSync(path.join(repoAlpha, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(repoBeta, ".git", "HEAD"), "ref: refs/heads/develop\n");
    fs.writeFileSync(path.join(fakeBareGitDir, "HEAD"), "ref: refs/heads/feat/wt\n");
    fs.writeFileSync(path.join(repoWorktree, ".git"), `gitdir: ${fakeBareGitDir}\n`);
    fs.writeFileSync(path.join(customExistingRepo, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(customSiblingRepo, ".git", "HEAD"), "ref: refs/heads/release\n");

    // 1. discoverLocalGitRepos finds regular + worktree repos & sibling of registered space, skips node_modules & kilnHome
    const discovered = await discoverLocalGitRepos({
      homeDir: fakeHome,
      kilnHome,
      existingSpaces: {
        pinned: {
          schema_version: 1,
          id: "pinned",
          name: "Pinned",
          repo_path: customExistingRepo,
          default_branch: "main",
          copy_untracked: [],
          clone_deps: [],
          freeze_patterns: [],
        },
      },
    });
    const canonicalAlpha = realpathCanonical(repoAlpha);
    const canonicalBeta = realpathCanonical(repoBeta);
    const canonicalWt = realpathCanonical(repoWorktree);
    const canonicalPinned = realpathCanonical(customExistingRepo);
    const canonicalSibling = realpathCanonical(customSiblingRepo);
    const paths = discovered.repos.map((r) => r.repo_path);

    expect(paths).toContain(canonicalAlpha);
    expect(paths).toContain(canonicalBeta);
    expect(paths).toContain(canonicalWt);
    expect(paths).toContain(canonicalPinned);
    expect(paths).toContain(canonicalSibling);
    expect(paths).not.toContain(realpathCanonical(repoNodeModules));
    expect(paths).not.toContain(realpathCanonical(kilnWorkspaceRepo));

    const betaEntry = discovered.repos.find((r) => r.repo_path === canonicalBeta);
    expect(betaEntry?.default_branch).toBe("develop");
    expect(betaEntry?.display_path).toBe(`~${path.sep}Code${path.sep}nested${path.sep}beta-lib`);
    expect(betaEntry?.already_added).toBe(false);

    const wtEntry = discovered.repos.find((r) => r.repo_path === canonicalWt);
    expect(wtEntry?.default_branch).toBe("feat/wt");

    const pinnedEntry = discovered.repos.find((r) => r.repo_path === canonicalPinned);
    expect(pinnedEntry?.already_added).toBe(true);
    expect(pinnedEntry?.space_id).toBe("pinned");
    // Unadded repos must sort before already-added repos
    expect(discovered.repos.at(-1)?.repo_path).toBe(canonicalPinned);

    // 2. pickLocalDirectory across darwin / win32 / linux (including cancel & fallback)
    const darwinOk: PickLocalDirectoryExecFn = async () => ({
      stdout: "/Users/me/Projects/kiln/\n",
      stderr: "",
    });
    expect(await pickLocalDirectory({ platform: "darwin", execFileFn: darwinOk })).toEqual({
      ok: true,
      cancelled: false,
      path: "/Users/me/Projects/kiln",
    });

    const darwinCancel: PickLocalDirectoryExecFn = async () => {
      const err = new Error("User canceled. (-128)") as Error & { stderr?: string };
      err.stderr = "execution error: User canceled. (-128)";
      throw err;
    };
    expect(await pickLocalDirectory({ platform: "darwin", execFileFn: darwinCancel })).toEqual({
      ok: true,
      cancelled: true,
      path: null,
    });

    const winCancel: PickLocalDirectoryExecFn = async () => ({ stdout: "\r\n", stderr: "" });
    expect(await pickLocalDirectory({ platform: "win32", execFileFn: winCancel })).toEqual({
      ok: true,
      cancelled: true,
      path: null,
    });

    const linuxFallback: PickLocalDirectoryExecFn = async (file) => {
      if (file === "zenity") {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return { stdout: "/home/me/code\n", stderr: "" };
    };
    expect(await pickLocalDirectory({ platform: "linux", execFileFn: linuxFallback })).toEqual({
      ok: true,
      cancelled: false,
      path: "/home/me/code",
    });

    const linuxUnavailable: PickLocalDirectoryExecFn = async () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    await expect(
      pickLocalDirectory({ platform: "linux", execFileFn: linuxUnavailable }),
    ).rejects.toMatchObject({ statusCode: 501 });

    // 3. HTTP endpoints + draft intake_open lifecycle
    const server = new KilndServer({
      kilnHome,
      port: 0,
      tokenSecret: "discover-pick-secret-0123456789abc",
      discoverSpaces: async () => discovered,
      pickDirectory: async () => ({ ok: true, cancelled: false, path: canonicalAlpha }),
      chatResponder: async () => ({ replyText: "## 立项确认\n\n已探索仓库。" }),
    });
    servers.push(server);
    await server.start();

    const discoverRes = await requestHttp(server, "/api/spaces/discover");
    expect(discoverRes.status).toBe(200);
    expect((await readJson(discoverRes)).repos.length).toBe(discovered.repos.length);

    const pickRes = await requestHttp(server, "/api/spaces/pick-directory", { method: "POST" });
    expect(pickRes.status).toBe(200);
    expect(await readJson(pickRes)).toEqual({
      ok: true,
      cancelled: false,
      path: canonicalAlpha,
    });

    // POST /api/drafts + POST /api/drafts/:id/chat sets intake_open: true, and closing sets false
    const createDraftRes = await requestHttp(server, "/api/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "d-open-1", title: "进行中立项" }),
    });
    expect(createDraftRes.status).toBe(201);

    const chatRes = await requestHttp(server, "/api/drafts/d-open-1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "帮我拆解这个需求" }),
    });
    expect(chatRes.status).toBe(200);
    expect((await readJson(chatRes)).draft.intake_open).toBe(true);

    const closeRes = await requestHttp(server, "/api/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "d-open-1", intake_open: false }),
    });
    expect(closeRes.status).toBe(200);
    expect((await readJson(closeRes)).draft.intake_open).toBe(false);
    expect(server.store.readDraft("d-open-1")?.title).toBe("进行中立项");
  });

  it("persists drafts/<id>/BRIEF.md and open_questions via wb_plan(upsert_draft), emits SSE intake.progress, and commits full BRIEF.md into tasks/<id>/BRIEF.md", async () => {
    const kilnHome = makeTempDir("kiln-draft-brief-");
    tempDirs.push(kilnHome);

    const server = new KilndServer({
      kilnHome,
      port: 0,
      tokenSecret: "draft-brief-secret-0123456789abcde",
    });
    servers.push(server);
    await server.start();

    const sseEvents: SseEvent[] = [];
    const unsubscribe = server.sseHub.subscribe((ev) => {
      sseEvents.push(ev);
    });

    const intakeToken = server.issueRunToken({
      taskId: "d-brief-mcp",
      runId: "chat-intake-brief",
      role: "intake",
      contractVersion: 1,
    });

    const fullBrief = [
      "## 1. 目标与用户场景",
      "支持从立项讨论直接沉淀完整产品设计并无损流转下游。",
      "",
      "## 2. 已确认规则与关键流程 / 边界",
      "- 未确认事项同步写入 open_questions，确认后清零。",
      "",
      "## 3. 选定落地方案与关键取舍",
      "采用 drafts/<id>/BRIEF.md 文件存储，删除草稿时级联清理。",
    ].join("\n");

    const upsertMcpRes = await requestMcpRpc(server, {
      method: "POST",
      path: "/rpc/mcp/wb_plan",
      headers: { Authorization: `Bearer ${intakeToken}` },
      body: {
        mode: "upsert_draft",
        draft_id: "d-brief-mcp",
        title: "无损 BRIEF 传递",
        space: "local",
        workspace_mode: "scratch_dir",
        open_questions: ["是否支持编辑原文"],
        brief_markdown: fullBrief,
      },
    });
    unsubscribe();

    expect(upsertMcpRes.status).toBe(200);
    expect(upsertMcpRes.json.brief_markdown).toContain("支持从立项讨论直接沉淀完整产品设计");
    expect(server.store.readDraft("d-brief-mcp")?.open_questions).toEqual(["是否支持编辑原文"]);
    expect(server.store.readDraftBrief("d-brief-mcp")).toContain("## 3. 选定落地方案与关键取舍");

    // SSE published intake.progress draft_updated event
    const progressEv = sseEvents.find((e) => e.type === "intake.progress");
    expect(progressEv).toMatchObject({
      type: "intake.progress",
      draftId: "d-brief-mcp",
      kind: "draft_updated",
      toolName: "wb_plan",
    });

    // GET /api/drafts/:id and /api/bootstrap surface persisted brief_markdown & open_questions
    const detailRes = await requestHttp(server, "/api/drafts/d-brief-mcp");
    expect(detailRes.status).toBe(200);
    const detailJson = await readJson(detailRes);
    expect(detailJson.brief_markdown).toContain("## 2. 已确认规则与关键流程 / 边界");
    expect(detailJson.draft.open_questions).toEqual(["是否支持编辑原文"]);
    expect(detailJson.draft.brief_markdown).toContain("## 1. 目标与用户场景");

    const bootJson = await readJson(await requestHttp(server, "/api/bootstrap"));
    const bootDraft = (bootJson.drafts as Array<Record<string, unknown>>).find(
      (d) => d.id === "d-brief-mcp",
    );
    expect(bootDraft?.brief_markdown).toContain("## 3. 选定落地方案与关键取舍");

    // Clear open_questions via HTTP POST /api/drafts, then commit WITHOUT passing brief_markdown -> inherits persisted BRIEF.md
    const clearOqRes = await requestHttp(server, "/api/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "d-brief-mcp",
        open_questions: [],
        contract: makeContract(),
      }),
    });
    expect(clearOqRes.status).toBe(200);
    expect(server.store.readDraft("d-brief-mcp")?.open_questions).toEqual([]);

    const commitRes = await requestHttp(server, "/api/drafts/d-brief-mcp/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "t-brief-ok" }),
    });
    expect(commitRes.status).toBe(201);
    const taskBrief = fs.readFileSync(server.store.paths.briefMd("t-brief-ok"), "utf8");
    expect(taskBrief).toContain("## 1. 目标与用户场景");
    expect(taskBrief).toContain("## 3. 选定落地方案与关键取舍");
    expect(server.store.readDraft("d-brief-mcp")).toBeNull();
    expect(server.store.readDraftBrief("d-brief-mcp")).toBeNull();
  });

  it("exposes version in /api/bootstrap and restricts POST /api/system/reveal-path to local listener", async () => {
    const kilnHome = makeTempDir("kiln-ver-reveal-");
    const sampleDir = makeTempDir("kiln-reveal-target-");
    const sampleFile = path.join(sampleDir, "notes.txt");
    fs.writeFileSync(sampleFile, "hello", "utf8");
    tempDirs.push(kilnHome, sampleDir);

    // 1. revealLocalPath unit checks across darwin / win32 / linux + file:// + tilde + guards
    const recorded: Array<{ file: string; args: readonly string[] }> = [];
    const fakeExec: PickLocalDirectoryExecFn = async (file, args) => {
      recorded.push({ file, args });
      return { stdout: "", stderr: "" };
    };

    const resDarwin = await revealLocalPath(`file://${sampleFile}#L12`, {
      platform: "darwin",
      execFileFn: fakeExec,
    });
    expect(resDarwin).toEqual({ ok: true, path: path.resolve(sampleFile) });
    expect(recorded[0]).toEqual({ file: "/usr/bin/open", args: ["-R", path.resolve(sampleFile)] });

    const resWin = await revealLocalPath("~/notes.txt", {
      platform: "win32",
      homedir: sampleDir,
      execFileFn: fakeExec,
    });
    expect(resWin).toEqual({ ok: true, path: path.resolve(sampleFile) });
    expect(recorded[1]).toEqual({
      file: "explorer.exe",
      args: [`/select,${path.resolve(sampleFile)}`],
    });

    await revealLocalPath(sampleFile, {
      platform: "linux",
      execFileFn: fakeExec,
    });
    expect(recorded[2]).toEqual({
      file: "xdg-open",
      args: [path.resolve(sampleDir)],
    });

    const localhostUrl = `file://localhost${sampleFile.startsWith("/") ? sampleFile : `/${sampleFile.replace(/\\/g, "/")}`}`;
    const resLocalhost = await revealLocalPath(localhostUrl, {
      platform: "darwin",
      execFileFn: fakeExec,
    });
    expect(resLocalhost).toEqual({ ok: true, path: path.resolve(sampleFile) });

    await expect(revealLocalPath("relative/path.txt")).rejects.toMatchObject({ statusCode: 400 });
    await expect(revealLocalPath("file://evil.example.com/etc/passwd")).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      revealLocalPath("file://evil.example.com/C:/Windows/win.ini"),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(revealLocalPath("\\\\evil.example.com\\share\\notes.txt")).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(revealLocalPath("//evil.example.com/share/notes.txt")).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      revealLocalPath(path.join(sampleDir, "missing.txt")),
    ).rejects.toMatchObject({ statusCode: 404 });

    // 2. Local & remote HTTP listener parity
    const revealedCalls: string[] = [];
    const localServer = new KilndServer({
      kilnHome,
      port: 0,
      version: "0.0.3-test",
      tokenSecret: "ver-reveal-secret-0123456789abcde",
      revealPath: async (target) => {
        revealedCalls.push(target);
        return { ok: true, path: target };
      },
    });
    servers.push(localServer);
    await localServer.start();

    const bootJson = await readJson(await requestHttp(localServer, "/api/bootstrap"));
    expect(bootJson.version).toBe("0.0.3-test");

    const revealOk = await requestHttp(localServer, "/api/system/reveal-path", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sampleFile }),
    });
    expect(revealOk.status).toBe(200);
    expect(await readJson(revealOk)).toEqual({ ok: true, path: sampleFile });
    expect(revealedCalls).toEqual([sampleFile]);

    // Remote listener blocks /api/system/reveal-path fail-closed
    const remoteRes = await localServer.remoteApp.request(
      new Request("http://127.0.0.1/api/system/reveal-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: sampleFile }),
      }),
    );
    expect(remoteRes.status).toBe(403);
    expect((await readJson(remoteRes)).error).toBe("local_only_endpoint");
  });
});
