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
import { ensureDir, writeFileAtomic } from "../../store/index.js";
import {
  CaffeinateController,
  KilndServer,
  RunTokenAuthError,
  SseHub,
  formatSseFrame,
  signRunToken,
  verifyRunToken,
  type CaffeinateChildProcess,
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

    const sockMode = fs.statSync(addr.socketPath).mode & 0o777;
    expect(sockMode).toBe(0o600);

    server.store.writeSpace({
      schema_version: 1,
      id: "kiln",
      name: "Kiln Core",
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
    const receiptMd = "---\nrun_id: run-w-1\ncontract_version: 1\n---\n# Receipt";
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

    // Create a stale Unix socket file left behind by a crashed daemon
    const staleSockPath = path.join(kilnHome, "run", "kilnd.sock");
    ensureDir(path.dirname(staleSockPath));
    const deadServer = net.createServer();
    await new Promise<void>((resolve) => deadServer.listen(staleSockPath, resolve));
    const tempSock = path.join(kilnHome, "run", "tmp-stale.sock");
    fs.renameSync(staleSockPath, tempSock);
    await new Promise<void>((resolve) => deadServer.close(() => resolve()));
    fs.renameSync(tempSock, staleSockPath);
    expect(fs.lstatSync(staleSockPath).isSocket()).toBe(true);

    const server = new KilndServer({ kilnHome, port: 0 });
    servers.push(server);
    const addr = await server.start();
    expect(fs.statSync(addr.socketPath).mode & 0o777).toBe(0o600);

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
        body: { markdown: "---\nrun_id: run-race-1\ncontract_version: 1\n---\n# Winner 1" },
      }),
      requestMcpRpc(server, {
        method: "POST",
        path: "/rpc/mcp/wb_submit_receipt",
        headers: { Authorization: `Bearer ${raceToken}` },
        body: { markdown: "---\nrun_id: run-race-1\ncontract_version: 1\n---\n# Winner 2" },
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
});
