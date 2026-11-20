import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SseEventSchema, type RolesConfig, type TaskCard } from "@kiln/protocol";
import { FakeBackend, type ExecutionBackend } from "../../backend/index.js";
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

    // Configure intake -> pi (mcpInjection: false) => rejected with 409 role_agent_ineligible & never starts session
    const badRoles: RolesConfig = {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        intake: { agent: "pi", model: "magpie/group/work", allow_full_access_fallback: false },
        resolver: { agent: "pi", model: "magpie/group/work", allow_full_access_fallback: false },
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

    const piIntakeRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-chat-1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "帮我立项" }),
      }),
    );
    expect(piIntakeRes.status).toBe(409);
    const piErr = (await piIntakeRes.json()) as { error: string; missingCapabilities: string[] };
    expect(piErr.error).toBe("role_agent_ineligible");
    expect(piErr.missingCapabilities).toContain("mcpInjection");
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
      stateEvents: unknown[];
      chatMessages: Array<{ text: string }>;
    };
    expect(taskJson.liveViewUrl).toBe(`paseo://h/local/agent/${sessRef.sessionId}`);
    expect(taskJson.hostBackup).toBeNull();
    expect(taskJson.stateEvents.length).toBeGreaterThanOrEqual(2);
    expect(taskJson.chatMessages[0]?.text).toBe("你好");
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
});
