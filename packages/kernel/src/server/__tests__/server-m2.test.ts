import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SseEventSchema, type RolesConfig, type TaskCard } from "@kiln/protocol";
import { FakeBackend, type ExecutionBackend } from "../../backend/index.js";
import { stageHostScopedChanges } from "../../gate/index.js";
import { writeFileAtomic } from "../../store/index.js";
import {
  KilndServer,
  LiveRateTracker,
  approximateDeltaTokens,
  type RateTickPayload,
} from "../index.js";

describe("M2 server modules: LiveRateTracker, static-files, chat & extended endpoints", () => {
  const tempDirs: string[] = [];
  const servers: KilndServer[] = [];

  function makeTempDir(prefix = "kiln-srv-m2-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()!.stop();
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("LiveRateTracker computes sliding-window tok/s, emits zeroed tick on clearTask, and leaves zero idle timers", async () => {
    let fakeNow = 10_000;
    const ticks: RateTickPayload[] = [];

    const tracker = new LiveRateTracker({
      windowMs: 4_000,
      tickIntervalMs: 25,
      now: () => fakeNow,
      getCostUsd: () => 1.25,
      onTick: (payload) => {
        ticks.push(payload);
      },
    });

    expect(approximateDeltaTokens("")).toBe(0);
    expect(approximateDeltaTokens("a")).toBe(1);
    expect(approximateDeltaTokens("12345678")).toBe(2);
    expect(tracker.activeTimerCount).toBe(0);

    // 40 chars -> 10 tokens; 20 chars -> 5 tokens => 15 / 4s = 3.8 tok/s
    tracker.recordDelta({ taskId: "t-1", text: "x".repeat(40), timestampMs: fakeNow });
    tracker.recordDelta({ taskId: "t-1", text: "y".repeat(20), timestampMs: fakeNow + 500 });
    tracker.recordDelta({ taskId: "t-2", text: "z".repeat(16), timestampMs: fakeNow + 500 });

    expect(tracker.activeTimerCount).toBe(1);

    const snap1 = tracker.snapshot(fakeNow + 1_000);
    expect(snap1.rates["t-1"]).toBe(3.8);
    expect(snap1.rates["t-2"]).toBe(1);
    expect(snap1.tokPerSec).toBe(4.8);

    // Wait for throttled tick broadcast & schema validation
    await new Promise((r) => setTimeout(r, 50));
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    const parsedTick = SseEventSchema.parse({ seq: 1, type: "rate.tick", ...ticks.at(-1)! });
    expect(parsedTick.type).toBe("rate.tick");

    // Advance past 4_000ms window -> samples expire & timer stops
    fakeNow = 20_000;
    const snapExpired = tracker.snapshot(fakeNow);
    expect(snapExpired).toEqual({ tokPerSec: 0, rates: {} });

    await new Promise((r) => setTimeout(r, 60));
    expect(tracker.activeTimerCount).toBe(0);

    // Clear active task immediately emits zeroed tick and leaves no idle timer
    fakeNow = 30_000;
    tracker.recordDelta({ taskId: "t-3", text: "abcd".repeat(4), timestampMs: fakeNow });
    expect(tracker.clearTask("t-3")).toBe(true);
    expect(ticks.at(-1)).toEqual({ rates: {}, totals: { costUsd: 1.25, tokPerSec: 0 } });
    expect(tracker.activeTimerCount).toBe(0);

    tracker.stop();
    expect(tracker.activeTimerCount).toBe(0);
  });

  it("static-files serves SPA assets, sets cache headers, isolates /api/* 404, and blocks traversal/NUL/symlink escapes", async () => {
    const kilnHome = makeTempDir("kiln-static-home-");
    const publicDir = makeTempDir("kiln-static-pub-");
    const outsideDir = makeTempDir("kiln-static-outside-");
    const outsideSecret = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideSecret, "TOP_SECRET_DATA\n");

    fs.mkdirSync(path.join(publicDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(publicDir, "index.html"), "<html><body>Kiln UI</body></html>");
    fs.writeFileSync(path.join(publicDir, "assets", "app-abcdef12.js"), "console.log('kiln');");
    fs.writeFileSync(path.join(publicDir, "assets", "style-abcdef12.css"), "body{}");
    fs.symlinkSync(outsideSecret, path.join(publicDir, "escaped.txt"));

    const server = new KilndServer({
      kilnHome,
      publicDir,
      port: 0,
      tokenSecret: "static-test-secret-0123456789abc",
    });
    servers.push(server);

    // 1. Root & index.html -> no-cache + text/html
    const rootRes = await server.app.request(new Request("http://127.0.0.1/"));
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get("content-type")).toContain("text/html");
    expect(rootRes.headers.get("cache-control")).toBe("no-cache");
    expect(await rootRes.text()).toContain("Kiln UI");

    // 2. Hashed assets -> immutable + proper MIME
    const jsRes = await server.app.request(
      new Request("http://127.0.0.1/assets/app-abcdef12.js"),
    );
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("content-type")).toContain("text/javascript");
    expect(jsRes.headers.get("cache-control")).toContain("immutable");

    const cssRes = await server.app.request(
      new Request("http://127.0.0.1/assets/style-abcdef12.css"),
    );
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("content-type")).toContain("text/css");

    // 3. SPA route fallback works, missing static asset extension returns 404
    const spaRes = await server.app.request(new Request("http://127.0.0.1/settings/roles"));
    expect(spaRes.status).toBe(200);
    expect(await spaRes.text()).toContain("Kiln UI");

    const missingAssetRes = await server.app.request(
      new Request("http://127.0.0.1/assets/missing.js"),
    );
    expect(missingAssetRes.status).toBe(404);

    // 4. /api/* NEVER falls back to index.html
    const missingApiRes = await server.app.request(
      new Request("http://127.0.0.1/api/does-not-exist"),
    );
    expect(missingApiRes.status).toBe(404);
    expect(missingApiRes.headers.get("content-type")).toContain("application/json");
    const apiErr = (await missingApiRes.json()) as { error: string };
    expect(apiErr.error).toBe("not_found");

    // 5. Traversal, encoded traversal, backslash, NUL byte, symlink escape -> 403/404 and zero secret leak
    const strictlyForbiddenPaths = [
      "/%2e%2e%5csecret.txt",
      "/index.html%00.png",
      "/escaped.txt",
    ];
    for (const attackPath of strictlyForbiddenPaths) {
      const res = await server.app.request(
        new Request(`http://127.0.0.1${attackPath}`),
      );
      expect(res.status).toBe(403);
      const body = await res.text();
      expect(body).not.toContain("TOP_SECRET_DATA");
    }

    for (const normalizedByFetch of [
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/assets/%2e%2e/%2e%2e/secret.txt",
    ]) {
      const res = await server.app.request(
        new Request(`http://127.0.0.1${normalizedByFetch}`),
      );
      expect([403, 404]).toContain(res.status);
      expect(await res.text()).not.toContain("TOP_SECRET_DATA");
    }

    // Verify raw handler directly returns 403 for un-collapsed "/../" and "/%2e%2e/" paths
    const { createStaticFilesHandler } = await import("../static-files.js");
    const rawHandler = createStaticFilesHandler({ publicDir });
    for (const rawPath of [
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/assets/%2e%2e/%2e%2e/secret.txt",
    ]) {
      const rawRes = rawHandler({
        req: {
          path: "/",
          method: "GET",
          raw: { url: rawPath },
        },
        json(payload: unknown, status = 200) {
          return new Response(JSON.stringify(payload), { status });
        },
      } as any);
      expect(rawRes.status).toBe(403);
    }

    // 6. Missing publicDir degrades cleanly to 404 without crashing
    const missingPubServer = new KilndServer({
      kilnHome: makeTempDir("kiln-missing-pub-home-"),
      publicDir: path.join(outsideDir, "nonexistent-public"),
      port: 0,
      tokenSecret: "missing-pub-secret-0123456789abc",
    });
    servers.push(missingPubServer);
    const noPubRes = await missingPubServer.app.request(new Request("http://127.0.0.1/"));
    expect(noPubRes.status).toBe(404);
  });

  it("degrades /api/agents and /api/bootstrap safely when backend fails/times out and enforces role eligibility in chat", async () => {
    const kilnHome = makeTempDir("kiln-chat-home-");
    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      backendQueryTimeoutMs: 50,
      tokenSecret: "chat-test-secret-0123456789abcde",
    });
    servers.push(server);

    // Offline/slow backend that fails listAgents() -> /api/agents & /api/bootstrap still return 200
    const brokenBackend: ExecutionBackend = {
      backendId: "paseo-offline",
      async listAgents() {
        await new Promise((r) => setTimeout(r, 200));
        return [];
      },
      async listModels() {
        return [];
      },
      async capabilities() {
        throw new Error("offline");
      },
      async start() {
        throw new Error("offline");
      },
      async send() {},
      async *events() {},
      onApproval() {
        return () => {};
      },
      async answer() {},
      async cancel() {},
      async probe() {
        return { alive: false, status: "closed" };
      },
      async liveViewUrl() {
        return null;
      },
    };
    const fakeBackend = new FakeBackend({ liveViewBaseUrl: "paseo://h/local/agent" });
    server.backendRegistry.register(brokenBackend);
    server.backendRegistry.register(fakeBackend);

    // Seed space + ledger
    server.store.writeSpace({
      schema_version: 1,
      id: "kiln",
      name: "Kiln",
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
          id: "led-1",
          space: "kiln",
          rule: "Always enforce strict Zod schema validation",
          source_task_id: "t-001",
          created_at: "2026-11-19T10:00:00.000Z",
        },
      ],
    });

    const agentsRes = await server.app.request(new Request("http://127.0.0.1/api/agents"));
    expect(agentsRes.status).toBe(200);
    const agentsBody = (await agentsRes.json()) as {
      ok: boolean;
      agents: Array<{ id: string }>;
      backends: Array<{ backendId: string; connected: boolean }>;
    };
    expect(agentsBody.ok).toBe(true);
    expect(agentsBody.agents.map((a) => a.id)).toContain("codex");
    expect(agentsBody.backends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ backendId: "paseo-offline", connected: false }),
        expect.objectContaining({ backendId: "fake", connected: true }),
      ]),
    );

    const backendsRes = await server.app.request(new Request("http://127.0.0.1/api/backends"));
    expect(backendsRes.status).toBe(200);
    const backendsBody = (await backendsRes.json()) as {
      ok: boolean;
      backends: Array<{ backendId: string; connected: boolean }>;
      agents: Array<{ id: string }>;
    };
    expect(backendsBody.ok).toBe(true);
    expect(backendsBody.backends).toEqual(agentsBody.backends);
    expect(backendsBody.agents.map((a) => a.id)).toContain("codex");

    const ledgersRes = await server.app.request(new Request("http://127.0.0.1/api/ledgers"));
    expect(ledgersRes.status).toBe(200);
    const ledgersBody = (await ledgersRes.json()) as {
      ledgers: Record<string, { entries: Array<{ rule: string }> }>;
    };
    expect(ledgersBody.ledgers.kiln?.entries[0]?.rule).toContain("Zod schema");

    // Bootstrap still succeeds with extended fields even with slow/offline backend
    const bootRes = await server.app.request(new Request("http://127.0.0.1/api/bootstrap"));
    expect(bootRes.status).toBe(200);
    const bootJson = (await bootRes.json()) as {
      ledgers: Record<string, unknown>;
      agents: unknown[];
      backends: Array<{ backendId: string; connected: boolean }>;
      providerUsage: unknown[];
      liveRates: { rates: Record<string, number>; totals: { costUsd: number; tokPerSec: number } };
    };
    expect(bootJson.ledgers).toHaveProperty("kiln");
    expect(bootJson.agents.length).toBeGreaterThan(0);
    expect(bootJson.backends).toHaveLength(2);
    expect(bootJson.providerUsage).toEqual([]);
    expect(bootJson.liveRates.totals.tokPerSec).toBe(0);

    // Configure intake -> antigravity-full-only without allow_full_access_fallback => rejected with 409 full_access_only_provider
    const badRoles: RolesConfig = {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        intake: {
          agent: "antigravity-full-only",
          model: "gemini-3-pro",
          allow_full_access_fallback: false,
        },
        resolver: {
          agent: "antigravity-full-only",
          model: "gemini-3-pro",
          allow_full_access_fallback: false,
        },
      },
    };
    server.store.writeConfig("roles", badRoles);

    await server.app.request(
      new Request("http://127.0.0.1/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "d-chat-1", title: "Chat Draft", space: "kiln" }),
      }),
    );

    const blockedRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-chat-1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "帮我立项" }),
      }),
    );
    expect(blockedRes.status).toBe(409);
    const blockedErr = (await blockedRes.json()) as { error: string; agent: string };
    expect(blockedErr.error).toBe("full_access_only_provider");
    expect(blockedErr.agent).toBe("antigravity-full-only");
    expect(fakeBackend.getRecordedSpecs()).toHaveLength(0);

    // Switch intake/resolver -> codex => multi-turn chat works & persists to drafts/<id>-chat.ndjson
    server.store.writeConfig("roles", {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        intake: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
        resolver: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
      },
    });

    fakeBackend.enqueueScript(
      [
        { kind: "tool", name: "wb_read_ledger", target: "kiln" },
        { kind: "message", text: "已查阅空间账本，请问验收命令是什么？", delta: false },
        { kind: "exit", reason: "completed" },
      ],
      { role: "intake", turnNumber: 1 },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "message", text: "已补全验收命令并更新草稿。", delta: false },
        { kind: "exit", reason: "completed" },
      ],
      { role: "intake", turnNumber: 2 },
    );

    const turn1Res = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-chat-1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "新增导出功能" }),
      }),
    );
    expect(turn1Res.status).toBe(200);
    const turn1Json = (await turn1Res.json()) as {
      reply: { text: string };
      draft: { session_ref: { sessionId: string } | null };
      messages: Array<{ who: string; text: string }>;
    };
    expect(turn1Json.reply.text).toContain("验收命令");
    expect(turn1Json.draft.session_ref).not.toBeNull();

    const turn2Res = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-chat-1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "验收命令 pnpm test" }),
      }),
    );
    expect(turn2Res.status).toBe(200);
    // Reused the same session via send() rather than starting a second session
    expect(fakeBackend.getRecordedSpecs()).toHaveLength(1);

    const getDraftRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-chat-1"),
    );
    expect(getDraftRes.status).toBe(200);
    const getDraftJson = (await getDraftRes.json()) as {
      messages: Array<{ who: string; text: string }>;
    };
    expect(getDraftJson.messages.filter((m) => m.who === "me")).toHaveLength(2);
    expect(getDraftJson.messages.filter((m) => m.who === "agent")).toHaveLength(2);

    // Task detail includes liveViewUrl, hostBackup, stateEvents, chatMessages
    const card: TaskCard = {
      schema_version: 1,
      id: "t-detail-1",
      title: "Detail checks",
      space: "kiln",
      priority: "P2",
      track: "L2",
      workspace_mode: "scratch_dir",
      parent: null,
      depends_on: [],
      contract_version: 1,
      contract: {
        goal: "Check detail fields",
        end: "All fields returned",
        accept_cmd: "echo ok",
        accept_files_hash: "sha256:test",
        scope: ["**"],
        deliver: { mode: "manual", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 100_000 },
      created_at: "2026-11-19T10:00:00.000Z",
      updated_at: "2026-11-19T10:00:00.000Z",
    };
    server.stateMachine.createTask(card, "# Brief");
    const sessRef = await fakeBackend.start({
      runId: "run-detail-1",
      taskId: card.id,
      role: "worker",
      agent: "codex",
      model: "gpt-5.4",
      cwd: makeTempDir("kiln-detail-cwd-"),
      prompt: "run",
      freshContext: false,
    });
    server.persistRunForDispatch(
      {
        schema_version: 1,
        run_id: "run-detail-1",
        task_id: card.id,
        stage: "implement",
        round: 1,
        role: "worker",
        contract_version: 1,
        backend_id: "fake",
        agent: "codex",
        model: "gpt-5.4",
        session_ref: sessRef,
        started_at: "2026-11-19T10:01:00.000Z",
      },
      "001-implement",
    );
    writeFileAtomic(
      path.join(server.store.paths.taskDir(card.id), "resolver_chat.ndjson"),
      `${JSON.stringify({ who: "agent", name: "resolver", text: "你好" })}\n`,
    );

    const taskRes = await server.app.request(
      new Request(`http://127.0.0.1/api/tasks/${card.id}`),
    );
    expect(taskRes.status).toBe(200);
    const taskJson = (await taskRes.json()) as {
      liveViewUrl: string | null;
      hostBackup: unknown;
      hostStagedDiffs: unknown[];
      stateEvents: unknown[];
      chatMessages: Array<{ text: string }>;
    };
    expect(taskJson.liveViewUrl).toBe(`paseo://h/local/agent/${sessRef.sessionId}`);
    expect(taskJson.hostBackup).toBeNull();
    expect(taskJson.hostStagedDiffs).toEqual([]);
    expect(taskJson.stateEvents.length).toBeGreaterThanOrEqual(2);
    expect(taskJson.chatMessages[0]?.text).toBe("你好");
  });

  it("includes hostStagedDiffs in GET /api/tasks/:id for staged_awaiting_approval host_scoped tasks", async () => {
    const kilnHome = makeTempDir("kiln-m2-host-diff-home-");
    const hostRoot = makeTempDir("kiln-m2-host-diff-root-");
    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      tokenSecret: "m2-host-diff-secret-0123456789abcd",
    });
    servers.push(server);

    const existingFile = path.join(hostRoot, "service.conf");
    const createdFile = path.join(hostRoot, "added.conf");
    const binaryFile = path.join(hostRoot, "blob.bin");
    const largeFile = path.join(hostRoot, "large.log");
    fs.writeFileSync(existingFile, "port=4310\nmode=before\n");
    fs.writeFileSync(binaryFile, Buffer.from([0x00, 0x01, 0x02]));
    fs.writeFileSync(largeFile, "X".repeat(70 * 1024));

    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-host-detail-diff",
        title: "Host staged diff detail check",
        space: "kiln",
        priority: "P1",
        track: "L1",
        workspace_mode: "host_scoped",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Expose staged host diffs before approval",
          end: "Diffs rendered in task detail",
          accept_cmd: "echo ok",
          accept_files_hash: "sha256:host-detail",
          scope: [`${hostRoot}/**`],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 100_000 },
        created_at: "2026-11-19T10:00:00.000Z",
        updated_at: "2026-11-19T10:00:00.000Z",
      },
      "# Host staged diff brief",
    );

    const stagedDir = server.store.paths.stagedDir("t-host-detail-diff");
    writeFileAtomic(path.join(stagedDir, "service.conf"), "port=4311\nmode=after\n");
    writeFileAtomic(path.join(stagedDir, "added.conf"), "enabled=true\n");
    writeFileAtomic(path.join(stagedDir, "blob.bin"), Buffer.from([0x00, 0x02, 0x03]));
    writeFileAtomic(path.join(stagedDir, "large.log"), "Y".repeat(70 * 1024));

    const staged = stageHostScopedChanges(server.store, {
      taskId: "t-host-detail-diff",
      contractScope: [`${hostRoot}/**`],
      stagedFiles: [
        { stagedRelativePath: "service.conf", targetPath: existingFile },
        { stagedRelativePath: "added.conf", targetPath: createdFile },
        { stagedRelativePath: "blob.bin", targetPath: binaryFile },
        { stagedRelativePath: "large.log", targetPath: largeFile },
      ],
    });
    expect(staged.ok).toBe(true);

    const detailRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-host-detail-diff"),
    );
    expect(detailRes.status).toBe(200);
    const detailJson = (await detailRes.json()) as {
      hostStagedDiffs: Array<{
        targetPath: string;
        existedBefore: boolean;
        preSha256: string | null;
        diff: string;
        truncated: boolean;
      }>;
    };
    expect(detailJson.hostStagedDiffs).toHaveLength(4);

    const modifiedDiff = detailJson.hostStagedDiffs.find((d) =>
      d.targetPath.endsWith("/service.conf"),
    )!;
    expect(modifiedDiff.existedBefore).toBe(true);
    expect(modifiedDiff.preSha256).toMatch(/^sha256:/);
    expect(modifiedDiff.diff).toContain("-mode=before");
    expect(modifiedDiff.diff).toContain("+mode=after");
    expect(modifiedDiff.truncated).toBe(false);

    const addedDiff = detailJson.hostStagedDiffs.find((d) =>
      d.targetPath.endsWith("/added.conf"),
    )!;
    expect(addedDiff.existedBefore).toBe(false);
    expect(addedDiff.preSha256).toBeNull();
    expect(addedDiff.diff).toContain("+enabled=true");

    const binDiff = detailJson.hostStagedDiffs.find((d) =>
      d.targetPath.endsWith("/blob.bin"),
    )!;
    expect(binDiff.diff).toBe("[binary file diff omitted]");

    const largeDiff = detailJson.hostStagedDiffs.find((d) =>
      d.targetPath.endsWith("/large.log"),
    )!;
    expect(largeDiff.truncated).toBe(true);
  });

  it("closes SSE streams before draining HTTP server in stop() and only invokes closeAllConnections after grace timeout", async () => {
    try {
      // 1. Natural close: sseHub.closeAll() -> server.close() completes cleanly without calling closeAllConnections
      const server1 = new KilndServer({
        kilnHome: makeTempDir("kiln-stop-grace-1-"),
        port: 0,
        publicDir: null,
        tokenSecret: "m2-stop-grace-secret-1-0123456789",
      });
      servers.push(server1);
      await server1.start();

      const sseRes = await server1.app.request(new Request("http://127.0.0.1/api/events"));
      expect(sseRes.status).toBe(200);
      const reader = sseRes.body!.getReader();
      server1.sseHub.publish({
        type: "task.updated",
        taskId: "t-sse-stop",
        patch: { status: "running" },
      });
      const firstChunk = await reader.read();
      expect(new TextDecoder().decode(firstChunk.value)).toContain("t-sse-stop");

      const tcpHttpServer1 = (server1 as unknown as { httpServer: http.Server }).httpServer;
      expect(tcpHttpServer1).toBeInstanceOf(http.Server);

      const callOrder: string[] = [];
      const origCloseAll = server1.sseHub.closeAll.bind(server1.sseHub);
      vi.spyOn(server1.sseHub, "closeAll").mockImplementation(() => {
        callOrder.push("sseHub.closeAll");
        origCloseAll();
      });

      const origServerClose1 = tcpHttpServer1.close.bind(tcpHttpServer1);
      vi.spyOn(tcpHttpServer1, "close").mockImplementation(((cb?: (err?: Error) => void) => {
        callOrder.push("httpServer.close");
        return origServerClose1(cb);
      }) as typeof tcpHttpServer1.close);
      const closeIdleSpy = vi.spyOn(tcpHttpServer1, "closeIdleConnections");
      const closeAllSpy = vi.spyOn(tcpHttpServer1, "closeAllConnections");

      await server1.stop();
      servers.pop();

      expect(callOrder.indexOf("sseHub.closeAll")).toBeGreaterThanOrEqual(0);
      expect(callOrder.indexOf("httpServer.close")).toBeGreaterThan(
        callOrder.indexOf("sseHub.closeAll"),
      );
      expect(closeIdleSpy).toHaveBeenCalled();
      expect(closeAllSpy).not.toHaveBeenCalled();

      const eof = await reader.read();
      expect(eof.done).toBe(true);

      // 2. Stuck connection fallback: closeAllConnections is invoked only after grace timeout (~350ms)
      const server2 = new KilndServer({
        kilnHome: makeTempDir("kiln-stop-grace-2-"),
        port: 0,
        publicDir: null,
        tokenSecret: "m2-stop-grace-secret-2-0123456789",
      });
      servers.push(server2);
      await server2.start();

      const tcpHttpServer2 = (server2 as unknown as { httpServer: http.Server }).httpServer;
      let heldCloseCb: ((err?: Error) => void) | undefined;
      const origServerClose2 = tcpHttpServer2.close.bind(tcpHttpServer2);
      vi.spyOn(tcpHttpServer2, "close").mockImplementation(((cb?: (err?: Error) => void) => {
        heldCloseCb = cb;
        return origServerClose2();
      }) as typeof tcpHttpServer2.close);
      const fallbackCloseAllSpy = vi
        .spyOn(tcpHttpServer2, "closeAllConnections")
        .mockImplementation(() => {
          heldCloseCb?.();
          heldCloseCb = undefined;
        });

      const stopPromise = server2.stop();
      await Promise.resolve();
      expect(fallbackCloseAllSpy).not.toHaveBeenCalled();

      await stopPromise;
      servers.pop();
      expect(fallbackCloseAllSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("handles unknown backend_id with 409, invalidates chat sessions on role hot-swap, and restricts resolver update_contract to bound task", async () => {
    const kilnHome = makeTempDir("kiln-m2-chat-sec-");
    const fakeBackend = new FakeBackend();
    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      tokenSecret: "m2-chat-sec-secret-0123456789abcdef",
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    await server.start();

    await server.app.request(
      new Request("http://127.0.0.1/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "d-swap-1", title: "Model Swap", space: "local" }),
      }),
    );

    // 1. Unknown backend_id in roles config returns 409 backend_unavailable (never 500)
    server.store.writeConfig("roles", {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        intake: {
          backend_id: "nonexistent-backend",
          agent: "codex",
          model: "gpt-5.4",
          allow_full_access_fallback: false,
        },
      },
    });
    const missingBackendRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-swap-1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi" }),
      }),
    );
    expect(missingBackendRes.status).toBe(409);

    // 2. Chat with gpt-5.4, then hot-swap intake model to gpt-6-luna -> creates NEW session instead of reusing old
    server.store.writeConfig("roles", {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        intake: {
          backend_id: "fake",
          agent: "codex",
          model: "gpt-5.4",
          allow_full_access_fallback: false,
        },
      },
    });
    fakeBackend.enqueueScript(
      [{ kind: "message", text: "turn1", delta: false }, { kind: "exit", reason: "completed" }],
      { role: "intake" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "message", text: "turn2", delta: false }, { kind: "exit", reason: "completed" }],
      { role: "intake" },
    );

    const chat1 = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-swap-1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "first" }),
      }),
    );
    expect(chat1.status).toBe(200);
    const draftAfter1 = server.store.readDraft("d-swap-1")!;
    const firstSessionId = draftAfter1.session_ref?.sessionId;
    expect(draftAfter1.session_ref?.meta?.kiln_chat_model).toBe("gpt-5.4");

    server.store.writeConfig("roles", {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        intake: {
          backend_id: "fake",
          agent: "codex",
          model: "gpt-6-luna",
          allow_full_access_fallback: false,
        },
      },
    });
    const chat2 = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-swap-1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "second" }),
      }),
    );
    expect(chat2.status).toBe(200);
    const draftAfter2 = server.store.readDraft("d-swap-1")!;
    expect(draftAfter2.session_ref?.sessionId).not.toBe(firstSessionId);
    expect(draftAfter2.session_ref?.meta?.kiln_chat_model).toBe("gpt-6-luna");
    expect(fakeBackend.getRecordedSpecs().map((s) => s.model)).toEqual(["gpt-5.4", "gpt-6-luna"]);

    // 3. Resolver role bound to task A cannot call wb_plan(update_contract) against task B
    const resolverToken = server.issueRunToken({
      taskId: "t-bound-a",
      runId: "run-res-a",
      role: "resolver",
      contractVersion: 1,
    });
    const forbiddenRes = await server.invokeMcpRpc({
      method: "POST",
      url: "/rpc/mcp/wb_plan",
      headers: { Authorization: `Bearer ${resolverToken}` },
      rawBody: JSON.stringify({
        mode: "update_contract",
        task_id: "t-other-b",
        contract: { goal: "hijack" },
        affected_stages: ["implement"],
        rationale: "attempt unauthorized update",
      }),
    });
    expect(forbiddenRes.status).toBe(403);
    expect((forbiddenRes.body as { error: string }).error).toBe("task_scope_forbidden");
  });

  it("mounts intake chat cwd onto space.repo_path, injects read-only constraints & registered spaces, and resets session with prior summary when space changes", async () => {
    const kilnHome = makeTempDir("kiln-m2-intake-space-");
    const repoAlpha = makeTempDir("kiln-repo-alpha-");
    const repoBeta = makeTempDir("kiln-repo-beta-");
    const fakeBackend = new FakeBackend();
    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      tokenSecret: "m2-intake-space-secret-0123456789",
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    await server.start();

    server.store.writeConfig("roles", {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        intake: {
          backend_id: "fake",
          agent: "codex",
          model: "gpt-5.4",
          allow_full_access_fallback: false,
        },
      },
    });
    server.store.writeSpace({
      schema_version: 1,
      id: "alpha",
      name: "Alpha Project",
      repo_path: repoAlpha,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      default_accept_cmd: "pnpm --filter alpha test",
      freeze_patterns: [],
    });
    server.store.writeSpace({
      schema_version: 1,
      id: "beta",
      name: "Beta Service",
      repo_path: repoBeta,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      default_accept_cmd: "cargo test",
      freeze_patterns: [],
    });

    await server.app.request(
      new Request("http://127.0.0.1/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "d-space-ctx",
          title: "Alpha feature",
          space: "alpha",
          workspace_mode: "git_worktree",
        }),
      }),
    );

    fakeBackend.enqueueScript(
      [{ kind: "message", text: "已在 Alpha 仓库检查结构", delta: false }, { kind: "exit", reason: "completed" }],
      { role: "intake" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "message", text: "已切换到 Beta 仓库继续聊", delta: false }, { kind: "exit", reason: "completed" }],
      { role: "intake" },
    );

    const turn1 = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-space-ctx/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "帮我看看测试怎么跑" }),
      }),
    );
    expect(turn1.status).toBe(200);

    // Switch draft space -> beta; next turn must NOT reuse alpha session and must carry prior summary
    await server.app.request(
      new Request("http://127.0.0.1/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "d-space-ctx",
          space: "beta",
          workspace_mode: "git_worktree",
        }),
      }),
    );

    const turn2 = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-space-ctx/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "改做 Beta 仓库吧" }),
      }),
    );
    expect(turn2.status).toBe(200);

    const specs = fakeBackend.getRecordedSpecs();
    expect(specs).toHaveLength(2);
    expect(specs[0]!.cwd).toBe(repoAlpha);
    expect(specs[0]!.systemPrompt).toContain(repoAlpha);
    expect(specs[0]!.systemPrompt).toContain("只读探索约束");
    expect(specs[0]!.systemPrompt).toContain("beta (Beta Service)");
    expect(specs[1]!.cwd).toBe(repoBeta);
    expect(specs[1]!.systemPrompt).toContain("帮我看看测试怎么跑");
    expect(specs[1]!.systemPrompt).toContain("已在 Alpha 仓库检查结构");
  });

  it("allows non-MCP interactive agents (pi) on intake & resolver via structured patches, blocks batch interactiveChat=false, supports Antigravity fallback opt-in, and handles /api/agents?refresh=1 & cached timeout", async () => {
    const kilnHome = makeTempDir("kiln-m2-nonmcp-chat-");
    const repoDir = makeTempDir("kiln-m2-nonmcp-repo-");
    const fakeBackend = new FakeBackend();

    let modelListVersion = 1;
    let refreshCalls = 0;
    let shouldTimeOut = false;
    const customBackend: ExecutionBackend = {
      backendId: "custom-probe",
      async listAgents() {
        if (shouldTimeOut) {
          await new Promise((r) => setTimeout(r, 200));
        }
        return [
          {
            id: "batch-only",
            label: "Batch Runner",
            capabilities: {
              interactiveChat: false,
              approvals: false,
              mcpInjection: false,
              usageCacheBreakdown: false,
              interrupt: true,
            },
            modes: [],
            defaultModeId: null,
          },
          {
            id: "dyn-pi",
            label: "Dynamic Pi",
            capabilities: {
              interactiveChat: true,
              approvals: false,
              mcpInjection: false,
              usageCacheBreakdown: true,
              interrupt: true,
            },
            modes: [],
            defaultModeId: null,
          },
        ];
      },
      async listModels(agent) {
        if (agent === "dyn-pi") {
          return modelListVersion >= 2
            ? [
                { id: "magpie/group/fast", label: "Fast", thinkingOptions: ["low"] },
                { id: "magpie/group/strong", label: "Strong", thinkingOptions: ["high"] },
              ]
            : [{ id: "magpie/group/fast", label: "Fast", thinkingOptions: ["low"] }];
        }
        return [{ id: "batch-v1", label: "Batch", thinkingOptions: [] }];
      },
      async refreshProviders() {
        refreshCalls += 1;
        modelListVersion = 2;
      },
      async capabilities(agent) {
        return {
          interactiveChat: agent === "dyn-pi",
          approvals: false,
          mcpInjection: false,
          usageCacheBreakdown: false,
          interrupt: true,
        };
      },
      async start(spec) {
        return await fakeBackend.start({
          ...spec,
          agent: "pi",
          model: "magpie/group/fast",
        });
      },
      async send(ref, msg) {
        await fakeBackend.send({ ...ref, backendId: fakeBackend.backendId }, msg);
      },
      events(ref) {
        return fakeBackend.events({ ...ref, backendId: fakeBackend.backendId });
      },
      onApproval(h) {
        return fakeBackend.onApproval(h);
      },
      async answer(id, allow, msg) {
        await fakeBackend.answer(id, allow, msg);
      },
      async cancel(ref) {
        await fakeBackend.cancel({ ...ref, backendId: fakeBackend.backendId });
      },
      async probe(ref) {
        return await fakeBackend.probe({ ...ref, backendId: fakeBackend.backendId });
      },
      async liveViewUrl() {
        return null;
      },
    };

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      backendQueryTimeoutMs: 50,
      tokenSecret: "m2-nonmcp-chat-secret-0123456789abcd",
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    server.backendRegistry.register(customBackend);
    await server.start();

    server.store.writeSpace({
      schema_version: 1,
      id: "proj",
      name: "Proj",
      repo_path: repoDir,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });

    // 1. Non-refresh populates cache, cached fallback returns last snapshot on transient timeout, and ?refresh=1 calls refreshProviders()
    const firstAgentsRes = await server.app.request(new Request("http://127.0.0.1/api/agents"));
    expect(firstAgentsRes.status).toBe(200);
    const firstAgentsJson = (await firstAgentsRes.json()) as {
      agents: Array<{ id: string; models: Array<{ id: string }> }>;
    };
    expect(firstAgentsJson.agents.find((a) => a.id === "dyn-pi")?.models.map((m) => m.id)).toEqual([
      "magpie/group/fast",
    ]);

    shouldTimeOut = true;
    const cachedAgentsRes = await server.app.request(new Request("http://127.0.0.1/api/agents"));
    expect(cachedAgentsRes.status).toBe(200);
    const cachedAgentsJson = (await cachedAgentsRes.json()) as {
      agents: Array<{ id: string }>;
      backends: Array<{ backendId: string; connected: boolean; detail: string }>;
    };
    expect(cachedAgentsJson.agents.some((a) => a.id === "dyn-pi")).toBe(true);
    expect(
      cachedAgentsJson.backends.find((b) => b.backendId === "custom-probe")?.detail,
    ).toContain("cached");

    shouldTimeOut = false;
    const refreshedRes = await server.app.request(
      new Request("http://127.0.0.1/api/agents?refresh=1"),
    );
    expect(refreshedRes.status).toBe(200);
    expect(refreshCalls).toBe(1);
    const refreshedJson = (await refreshedRes.json()) as {
      agents: Array<{ id: string; models: Array<{ id: string }> }>;
    };
    expect(refreshedJson.agents.find((a) => a.id === "dyn-pi")?.models.map((m) => m.id)).toEqual([
      "magpie/group/fast",
      "magpie/group/strong",
    ]);

    // 2. interactiveChat: false is rejected with 409 role_agent_ineligible (missingCapabilities: ["interactiveChat"])
    await server.app.request(
      new Request("http://127.0.0.1/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "d-nonmcp-1", title: "Local Non-MCP", space: "local", workspace_mode: "scratch_dir" }),
      }),
    );
    server.store.writeConfig("roles", {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        intake: {
          backend_id: "custom-probe",
          agent: "batch-only",
          model: "batch-v1",
          allow_full_access_fallback: false,
        },
      },
    });
    const batchRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-nonmcp-1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi" }),
      }),
    );
    expect(batchRes.status).toBe(409);
    expect((await batchRes.json()) as Record<string, unknown>).toMatchObject({
      error: "role_agent_ineligible",
      missingCapabilities: ["interactiveChat"],
    });

    // 3. Antigravity full-access-only allowed on intake ONLY when allow_full_access_fallback is true
    server.store.writeConfig("roles", {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        intake: {
          backend_id: "fake",
          agent: "antigravity-full-only",
          model: "gemini-3-pro",
          allow_full_access_fallback: true,
        },
      },
    });
    fakeBackend.enqueueScript(
      [{ kind: "message", text: "Antigravity opt-in reply", delta: false }, { kind: "exit", reason: "completed" }],
      { role: "intake" },
    );
    const agyOkRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-nonmcp-1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "用 Antigravity 试试" }),
      }),
    );
    expect(agyOkRes.status).toBe(200);

    // 4. Pi non-MCP intake applies kiln-draft-patch, strips JSON block from visible reply, preserves local mode invariant, and degrades safely on malformed JSON
    server.store.writeConfig("roles", {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        intake: {
          backend_id: "fake",
          agent: "pi",
          model: "magpie/group/fast",
          allow_full_access_fallback: false,
        },
        resolver: {
          backend_id: "fake",
          agent: "pi",
          model: "magpie/group/fast",
          allow_full_access_fallback: false,
        },
      },
    });
    fakeBackend.enqueueScript(
      [
        {
          kind: "message",
          text: [
            "好的，我已经帮你整理好本机任务立项单。",
            "```kiln-draft-patch",
            JSON.stringify({
              title: "整理本地配置文件",
              priority: "P1",
              track: "L1",
              workspace_mode: "git_worktree",
              contract: {
                end: "完成配置模板整理",
                accept_cmd: "echo ok",
                scope: ["notes.md"],
              },
            }),
            "```",
          ].join("\n"),
          delta: false,
        },
        { kind: "exit", reason: "completed" },
      ],
      { role: "intake" },
    );
    fakeBackend.enqueueScript(
      [
        {
          kind: "message",
          text: "这是正文提示。\n```kiln-draft-patch\n{ broken json }\n```",
          delta: false,
        },
        { kind: "exit", reason: "completed" },
      ],
      { role: "intake" },
    );

    const piTurn1 = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-nonmcp-1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "帮我立一个本机配置任务" }),
      }),
    );
    expect(piTurn1.status).toBe(200);
    const piTurn1Json = (await piTurn1.json()) as {
      reply: { text: string };
      draft: {
        title: string;
        priority: string;
        track: string;
        space: string;
        workspace_mode: string;
        contract: { end?: string; accept_cmd?: string; scope?: string[] };
      };
      messages: Array<{ who: string; text: string }>;
    };
    expect(piTurn1Json.reply.text).toBe("好的，我已经帮你整理好本机任务立项单。");
    expect(piTurn1Json.reply.text).not.toContain("kiln-draft-patch");
    expect(piTurn1Json.draft.title).toBe("整理本地配置文件");
    expect(piTurn1Json.draft.priority).toBe("P1");
    expect(piTurn1Json.draft.track).toBe("L1");
    expect(piTurn1Json.draft.space).toBe("local");
    // local invariant rejects git_worktree patch
    expect(piTurn1Json.draft.workspace_mode).toBe("scratch_dir");
    expect(piTurn1Json.draft.contract.end).toBe("完成配置模板整理");
    expect(piTurn1Json.draft.contract.accept_cmd).toBe("echo ok");
    expect(piTurn1Json.draft.contract.scope).toEqual(["notes.md"]);

    const piTurn2 = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-nonmcp-1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "再调整一下" }),
      }),
    );
    expect(piTurn2.status).toBe(200);
    const piTurn2Json = (await piTurn2.json()) as {
      reply: { text: string };
      messages: Array<{ who: string; text: string }>;
    };
    expect(piTurn2Json.reply.text).toBe("这是正文提示。");
    expect(piTurn2Json.messages.some((m) => m.who === "tool" && m.text.includes("格式校验失败"))).toBe(
      true,
    );

    const piIntakeSpecs = fakeBackend
      .getRecordedSpecs()
      .filter((s) => s.agent === "pi" && s.role === "intake");
    expect(piIntakeSpecs).toHaveLength(1);
    expect(piIntakeSpecs[0]!.mcpServers).toBeUndefined();
    expect(piIntakeSpecs[0]!.systemPrompt).toContain("无 MCP 模式");

    // 5. Pi non-MCP resolver applies kiln-contract-patch, bumps contract_version & rebinds PendingDecision
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-nonmcp-res",
        title: "Non-MCP Resolver Task",
        space: "proj",
        priority: "P1",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Old goal",
          end: "Old end",
          accept_cmd: "pnpm test",
          accept_files_hash: "sha256:old",
          scope: ["src/a.ts"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 100_000 },
        created_at: "2026-11-20T00:00:00.000Z",
        updated_at: "2026-11-20T00:00:00.000Z",
      },
      "# Non-MCP Resolver",
    );
    const nonMcpDecision = {
      id: "dec-nonmcp-1",
      task_id: "t-nonmcp-res",
      contract_version: 1,
      reason: "needs_scope",
      category: "scope" as const,
      question: "是否需要扩大可改范围？",
      options: [{ id: "resume", label: "继续推进", action: "resume" as const, recommended: true }],
      created_at: "2026-11-20T00:02:00.000Z",
    };
    server.pendingDecisions.set(nonMcpDecision);
    server.stateMachine.requestDecision(
      "t-nonmcp-res",
      nonMcpDecision,
      "2026-11-20T00:02:00.000Z",
    );

    fakeBackend.enqueueScript(
      [
        {
          kind: "message",
          text: [
            "已扩展可改范围到 src/** 并更新终点。",
            "```kiln-contract-patch",
            JSON.stringify({
              contract: {
                end: "New end",
                scope: ["src/**"],
              },
              affected_stages: ["implement"],
              rationale: "Need wider scope",
            }),
            "```",
          ].join("\n"),
          delta: false,
        },
        { kind: "exit", reason: "completed" },
      ],
      { role: "resolver" },
    );

    const piResolverRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-nonmcp-res/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "请把可改范围放宽到 src/**" }),
      }),
    );
    expect(piResolverRes.status).toBe(200);
    const piResolverJson = (await piResolverRes.json()) as {
      reply: { text: string };
      card: { contract_version: number; contract: { end: string; scope: string[] } };
      pendingDecision: { contract_version: number } | null;
    };
    expect(piResolverJson.reply.text).toBe("已扩展可改范围到 src/** 并更新终点。");
    expect(piResolverJson.card.contract_version).toBe(2);
    expect(piResolverJson.card.contract.end).toBe("New end");
    expect(piResolverJson.card.contract.scope).toEqual(["src/**"]);
    expect(piResolverJson.pendingDecision?.contract_version).toBe(2);

    const piResolverSpecs = fakeBackend
      .getRecordedSpecs()
      .filter((s) => s.agent === "pi" && s.role === "resolver");
    expect(piResolverSpecs).toHaveLength(1);
    expect(piResolverSpecs[0]!.mcpServers).toBeUndefined();
  });

  it("serves embedded static assets with MIME types & SPA fallback when disk publicDir is absent, and detects compiled Bun binary MCP invocation", async () => {
    const encoder = new TextEncoder();
    const embeddedPublicAssets = new Map([
      [
        "index.html",
        { readBytes: () => encoder.encode("<!doctype html><html><body>Embedded Kiln</body></html>") },
      ],
      [
        "manifest.webmanifest",
        { readBytes: () => encoder.encode('{"name":"Kiln","display":"standalone"}') },
      ],
      [
        "assets/app-abc12345.js",
        { readBytes: () => encoder.encode("console.log('embedded');") },
      ],
      [
        "assets/style-abc12345.css",
        { readBytes: () => encoder.encode("body { color: #222; }") },
      ],
      [
        "icon.svg",
        { readBytes: () => encoder.encode("<svg/>") },
      ],
    ]);

    const outsideDir = makeTempDir("kiln-embedded-static-");
    // 1. When publicDir is NOT explicitly provided and embeddedPublicAssets is populated,
    //    serve embedded assets directly without probing disk (prevents reading host `/public` in compiled binaries).
    const defaultEmbeddedServer = new KilndServer({
      kilnHome: makeTempDir("kiln-embedded-default-home-"),
      embeddedPublicAssets,
      port: 0,
      tokenSecret: "embedded-default-secret-01234567",
    });
    servers.push(defaultEmbeddedServer);
    const defaultRootRes = await defaultEmbeddedServer.app.request(new Request("http://127.0.0.1/"));
    expect(defaultRootRes.status).toBe(200);
    expect(await defaultRootRes.text()).toContain("Embedded Kiln");

    // 2. When explicit publicDir exists on disk, disk overrides embedded assets.
    const explicitDiskDir = makeTempDir("kiln-explicit-disk-pub-");
    fs.writeFileSync(
      path.join(explicitDiskDir, "index.html"),
      "<!doctype html><html><body>Disk Override Kiln</body></html>",
      "utf8",
    );
    const diskOverrideServer = new KilndServer({
      kilnHome: makeTempDir("kiln-disk-override-home-"),
      publicDir: explicitDiskDir,
      embeddedPublicAssets,
      port: 0,
      tokenSecret: "disk-override-secret-01234567890",
    });
    servers.push(diskOverrideServer);
    const overrideRes = await diskOverrideServer.app.request(new Request("http://127.0.0.1/"));
    expect(overrideRes.status).toBe(200);
    expect(await overrideRes.text()).toContain("Disk Override Kiln");

    // 3. When explicit publicDir is absent on disk, fall back to embedded assets.
    const server = new KilndServer({
      kilnHome: makeTempDir("kiln-embedded-home-"),
      publicDir: path.join(outsideDir, "nonexistent-public"),
      embeddedPublicAssets,
      port: 0,
      tokenSecret: "embedded-static-secret-012345678",
    });
    servers.push(server);

    const rootRes = await server.app.request(new Request("http://127.0.0.1/"));
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get("content-type")).toContain("text/html");
    expect(rootRes.headers.get("cache-control")).toBe("no-cache");
    expect(await rootRes.text()).toContain("Embedded Kiln");

    const headRes = await server.app.request(new Request("http://127.0.0.1/", { method: "HEAD" }));
    expect(headRes.status).toBe(200);
    expect(await headRes.text()).toBe("");

    const manifestRes = await server.app.request(
      new Request("http://127.0.0.1/manifest.webmanifest"),
    );
    expect(manifestRes.status).toBe(200);
    expect(manifestRes.headers.get("content-type")).toBe("application/manifest+json; charset=utf-8");

    const jsRes = await server.app.request(
      new Request("http://127.0.0.1/assets/app-abc12345.js"),
    );
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("content-type")).toContain("text/javascript");
    expect(jsRes.headers.get("cache-control")).toContain("immutable");

    const spaRes = await server.app.request(new Request("http://127.0.0.1/tasks/t-123"));
    expect(spaRes.status).toBe(200);
    expect(await spaRes.text()).toContain("Embedded Kiln");

    const missingAssetRes = await server.app.request(
      new Request("http://127.0.0.1/assets/missing.js"),
    );
    expect(missingAssetRes.status).toBe(404);

    const apiMissingRes = await server.app.request(new Request("http://127.0.0.1/api/nope"));
    expect(apiMissingRes.status).toBe(404);

    const { createStaticFilesHandler, isCompiledKilnBinary, resolveMcpServerCommand } =
      await import("../index.js");

    const rawHandler = createStaticFilesHandler({
      publicDir: path.join(outsideDir, "nonexistent-public"),
      embeddedAssets: embeddedPublicAssets,
    });
    const traversalRes = rawHandler({
      req: { path: "/", method: "GET", raw: { url: "/%2e%2e/etc/passwd" } },
      json(payload: unknown, status = 200) {
        return new Response(JSON.stringify(payload), { status });
      },
    } as any);
    expect(traversalRes.status).toBe(403);

    // Compiled binary detection & MCP command resolution
    expect(isCompiledKilnBinary({ isBun: false, argv1: "/$bunfs/root/kiln" })).toBe(false);
    expect(
      isCompiledKilnBinary({
        isBun: true,
        argv1: "/repo/packages/cli/src/bin.ts",
        moduleUrl: "file:///repo/packages/kernel/src/server/chat.ts",
        bunMain: "/repo/packages/cli/src/bin.ts",
      }),
    ).toBe(false);
    expect(
      isCompiledKilnBinary({
        isBun: true,
        argv1: "/$bunfs/root/kiln",
        moduleUrl: "file:///$bunfs/root/kiln",
        bunMain: "/$bunfs/root/kiln",
      }),
    ).toBe(true);
    expect(
      isCompiledKilnBinary({
        isBun: true,
        argv1: "B:/~BUN/root/kiln.exe",
        moduleUrl: "file:///B:/~BUN/root/kiln.exe",
        bunMain: "B:/~BUN/root/kiln.exe",
      }),
    ).toBe(true);

    expect(
      resolveMcpServerCommand(undefined, {
        compiledBinary: true,
        execPath: "/Applications/Kiln.app/Contents/MacOS/kiln",
      }),
    ).toEqual({
      command: "/Applications/Kiln.app/Contents/MacOS/kiln",
      args: ["__mcp"],
    });
  });
});
