import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoleForbiddenErrorSchema, type SseEvent, SseEventSchema } from "@kiln/protocol";
import { isWindowsNamedPipe } from "../../store/index.js";
import { KilndServer, sendNetHttpRequest } from "../index.js";

function makeTempDir(prefix = "kiln-srv-socket-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function requestUnixSocket(
  socketPath: string,
  options: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);

  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: options.path,
        method: options.method,
        headers: {
          Host: "kilnd.local",
          ...(payload !== undefined
            ? {
                "Content-Type": "application/json",
                "Content-Length": String(Buffer.byteLength(payload)),
              }
            : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            json: (raw.length > 0 ? JSON.parse(raw) : {}) as Record<string, unknown>,
          });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

function parseSseFrames(chunkText: string): Array<{ id: number; event: string; data: SseEvent }> {
  const frames: Array<{ id: number; event: string; data: SseEvent }> = [];
  for (const block of chunkText.split("\n\n").filter((b) => b.trim().length > 0)) {
    let id = -1;
    let event = "";
    let dataRaw = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) id = Number(line.slice(4));
      else if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) dataRaw = line.slice(6);
    }
    frames.push({ id, event, data: SseEventSchema.parse(JSON.parse(dataRaw)) });
  }
  return frames;
}

describe("KilndServer OS socket smoke suite (requires unsandboxed connect)", () => {
  const tempDirs: string[] = [];
  const servers: KilndServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()!.stop();
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("handles real Unix Domain Socket RPC and loopback TCP HTTP + SSE", async () => {
    const kilnHome = makeTempDir();
    tempDirs.push(kilnHome);

    const server = new KilndServer({
      kilnHome,
      port: 0,
      tokenSecret: "socket-smoke-secret-1234567890",
    });
    servers.push(server);
    const addr = await server.start();

    if (!isWindowsNamedPipe(addr.socketPath)) {
      expect(fs.statSync(addr.socketPath).mode & 0o777).toBe(0o600);
    }

    const healthRes = await fetch(`${addr.baseUrl}/api/health`);
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as { ok: boolean; pid: number };
    expect(healthJson.ok).toBe(true);
    expect(healthJson.pid).toBe(process.pid);

    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-sock-1",
        title: "Socket smoke task",
        space: "kiln",
        priority: "P1",
        track: "L2",
        workspace_mode: "scratch_dir",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Verify live socket transport",
          end: "Transport works end to end",
          accept_cmd: "echo ok",
          accept_files_hash: "sha256:sock",
          scope: ["out/**"],
          deliver: { mode: "manual", cmd: null },
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
      },
      "# Socket smoke brief",
    );

    const workerToken = server.issueRunToken({
      taskId: "t-sock-1",
      runId: "run-sock-1",
      role: "worker",
      contractVersion: 1,
    });

    const ctxRes = await requestUnixSocket(addr.socketPath, {
      method: "POST",
      path: "/rpc/mcp/wb_get_context",
      headers: { Authorization: `Bearer ${workerToken}` },
      body: {},
    });
    expect(ctxRes.status).toBe(200);
    expect((ctxRes.json.card as { id: string }).id).toBe("t-sock-1");

    const forbiddenRes = await requestUnixSocket(addr.socketPath, {
      method: "POST",
      path: "/rpc/mcp/wb_plan",
      headers: { Authorization: `Bearer ${workerToken}` },
      body: { mode: "upsert_draft", draft_id: "d-bad" },
    });
    expect(forbiddenRes.status).toBe(403);
    expect(RoleForbiddenErrorSchema.parse(forbiddenRes.json).code).toBe("role_forbidden");

    const abort = new AbortController();
    const sseRes = await fetch(`${addr.baseUrl}/api/events`, { signal: abort.signal });
    expect(sseRes.status).toBe(200);
    const reader = sseRes.body!.getReader();
    server.sseHub.publish({
      type: "task.updated",
      taskId: "t-sock-1",
      patch: { status: "running", stage: "implement", round: 1 },
    });
    const chunk = await reader.read();
    const frames = parseSseFrames(new TextDecoder().decode(chunk.value));
    expect(frames[0]?.data.type).toBe("task.updated");
    abort.abort();
    await reader.cancel().catch(() => {});
  });

  it("closes active HTTP SSE streams cleanly on server.stop() without ERR_INCOMPLETE_CHUNKED_ENCODING", async () => {
    const kilnHome = makeTempDir("kiln-srv-sse-stop-");
    tempDirs.push(kilnHome);

    const server = new KilndServer({
      kilnHome,
      port: 0,
      tokenSecret: "socket-sse-stop-secret-1234567890",
    });
    servers.push(server);
    const addr = await server.start();

    let firstFrameResolve!: () => void;
    const firstFrameReceived = new Promise<void>((resolve) => {
      firstFrameResolve = resolve;
    });
    const stopPromise = firstFrameReceived.then(async () => {
      await server.stop();
    });

    const sseOutcomePromise = new Promise<{
      statusCode: number | undefined;
      headers: http.IncomingHttpHeaders;
      endedCleanly: boolean;
      complete: boolean;
      aborted: boolean;
      errors: string[];
      bodyText: string;
    }>((resolve, reject) => {
      let bodyText = "";
      let firstFrameSeen = false;
      let aborted = false;
      let settled = false;
      const errors: string[] = [];

      const req = http.get(`${addr.baseUrl}/api/events`, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          bodyText += chunk;
          if (!firstFrameSeen && bodyText.includes("\n\n")) {
            firstFrameSeen = true;
            firstFrameResolve();
          }
        });
        res.on("aborted", () => {
          aborted = true;
        });
        res.on("error", (err) => {
          errors.push(err.message);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            endedCleanly: true,
            complete: res.complete,
            aborted,
            errors,
            bodyText,
          });
        });
        res.on("close", () => {
          if (!settled && !res.complete) {
            settled = true;
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              endedCleanly: false,
              complete: res.complete,
              aborted,
              errors,
              bodyText,
            });
          }
        });

        server.sseHub.publish({
          type: "task.updated",
          taskId: "t-sse-graceful",
          patch: { status: "running", stage: "implement", round: 1 },
        });
      });

      req.on("error", (err) => {
        errors.push(err.message);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });

    const [sseOutcome] = await Promise.all([sseOutcomePromise, stopPromise]);

    expect(sseOutcome.statusCode).toBe(200);
    expect(sseOutcome.headers["content-type"]).toContain("text/event-stream");
    expect(sseOutcome.endedCleanly).toBe(true);
    expect(sseOutcome.complete).toBe(true);
    expect(sseOutcome.aborted).toBe(false);
    expect(sseOutcome.errors).toEqual([]);

    const frames = parseSseFrames(sseOutcome.bodyText);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data.type).toBe("task.updated");
    if (frames[0]?.data.type === "task.updated") {
      expect(frames[0].data.taskId).toBe("t-sse-graceful");
    }
  });

  it("dynamically starts/stops authenticated dual-port remote listener over real loopback TCP and disconnects revoked SSE", async () => {
    const kilnHome = makeTempDir("kiln-srv-remote-dual-");
    tempDirs.push(kilnHome);

    const server = new KilndServer({
      kilnHome,
      port: 0,
      remotePort: 0,
      tokenSecret: "socket-remote-dual-secret-1234567890",
    });
    servers.push(server);
    const addr = await server.start();

    // Disabled by default -> remote listener not started
    expect(server.remoteAddress).toBeNull();

    // Local port rejects reverse-proxy header over real TCP
    const proxyOnLocal = await fetch(`${addr.baseUrl}/api/health`, {
      headers: { "X-Forwarded-For": "198.51.100.7" },
    });
    expect(proxyOnLocal.status).toBe(403);
    expect(((await proxyOnLocal.json()) as { error: string }).error).toBe("remote_port_required");

    // Local port rejects DNS-rebinding Host header over real TCP
    const rebindStatus = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: addr.port,
          path: "/api/health",
          method: "GET",
          headers: { Host: "evil.rebinding.test" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(rebindStatus).toBe(403);

    // Enable remote dynamically via local PUT /api/settings/remote -> starts remote listener
    const enableRes = await fetch(`${addr.baseUrl}/api/settings/remote`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        enabled: true,
        remote_port: 4311,
      }),
    });
    expect(enableRes.status).toBe(200);
    const remoteAddr = server.remoteAddress;
    expect(remoteAddr).not.toBeNull();
    expect(remoteAddr!.port).not.toBe(addr.port);

    // Remote port requires session cookie even over 127.0.0.1
    const unauthRemote = await fetch(`${remoteAddr!.baseUrl}/api/bootstrap`);
    expect(unauthRemote.status).toBe(401);

    // Pair via local :4310 + remote :4311
    const pairCreateRes = await fetch(`${addr.baseUrl}/api/remote/pair`, {
      method: "POST",
    });
    expect(pairCreateRes.status).toBe(201);
    const challenge = (await pairCreateRes.json()) as { token: string };

    const pairFinishRes = await fetch(`${remoteAddr!.baseUrl}/api/auth/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: challenge.token, label: "Socket Phone" }),
    });
    expect(pairFinishRes.status).toBe(200);
    const setCookie = pairFinishRes.headers.get("set-cookie") ?? "";
    const cookieToken = /^kiln_session=([^;]+)/.exec(setCookie)?.[1];
    expect(cookieToken).toBeTruthy();
    const pairedBody = (await pairFinishRes.json()) as { device: { id: string } };

    // Authenticated remote REST + SSE succeed over real TCP
    const authBoot = await fetch(`${remoteAddr!.baseUrl}/api/bootstrap`, {
      headers: { Cookie: `kiln_session=${cookieToken}` },
    });
    expect(authBoot.status).toBe(200);

    // Open real TCP remote SSE stream and verify revoke closes it cleanly
    const sseClosed = new Promise<boolean>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: remoteAddr!.port,
          path: "/api/events",
          method: "GET",
          headers: { Cookie: `kiln_session=${cookieToken}` },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          res.once("data", () => {
            void fetch(`${addr.baseUrl}/api/remote/devices/${pairedBody.device.id}`, {
              method: "DELETE",
            });
          });
          res.on("end", () => resolve(true));
        },
      );
      req.on("error", reject);
      req.end();
      setTimeout(() => {
        server.sseHub.publish({
          type: "task.updated",
          taskId: "t-remote-tcp-sse",
          patch: { status: "running" },
        });
      }, 30);
    });
    expect(await sseClosed).toBe(true);

    // Disable remote dynamically -> stops remote listener cleanly
    const disableRes = await fetch(`${addr.baseUrl}/api/settings/remote`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        enabled: false,
        remote_port: 4311,
      }),
    });
    expect(disableRes.status).toBe(200);
    expect(server.remoteAddress).toBeNull();

    // Concurrent enable + stop() must never leak a late-bound remote listener
    const inflightEnable = server.applyRemoteConfig({
      schema_version: 1,
      enabled: true,
      remote_port: 4311,
      keep_awake_on_ac: false,
      notifications: {
        enabled: false,
        channel: "webhook",
        url: "",
        priorities: ["P0", "P1"],
      },
    });
    const stopPromise = server.stop();
    await Promise.all([inflightEnable, stopPromise]);
    expect(server.remoteAddress).toBeNull();
  });

  it("authenticates POST /rpc/shutdown over live local IPC with 0600 control token and stops cleanly", async () => {
    const kilnHome = makeTempDir("kiln-srv-rpc-shutdown-");
    tempDirs.push(kilnHome);

    const server = new KilndServer({
      kilnHome,
      port: 0,
      tokenSecret: "socket-shutdown-secret-1234567890",
    });
    servers.push(server);
    const addr = await server.start();

    const tokenPath = server.store.paths.shutdownTokenFile;
    expect(fs.existsSync(tokenPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    }
    const shutdownToken = fs.readFileSync(tokenPath, "utf8").trim();
    expect(shutdownToken.length).toBeGreaterThanOrEqual(32);

    const badRes = await requestUnixSocket(addr.socketPath, {
      method: "POST",
      path: "/rpc/shutdown",
      headers: { Authorization: "Bearer wrong-shutdown-token" },
    });
    expect(badRes.status).toBe(401);
    expect(server.address).not.toBeNull();

    const okRes = await requestUnixSocket(addr.socketPath, {
      method: "POST",
      path: "/rpc/shutdown",
      headers: { Authorization: `Bearer ${shutdownToken}` },
    });
    expect(okRes.status).toBe(200);
    expect(okRes.json).toEqual({ ok: true, shuttingDown: true });

    const deadline = Date.now() + 3_000;
    while (server.address !== null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(server.address).toBeNull();
    expect(fs.existsSync(tokenPath)).toBe(false);
  });

  it("serves strict HTTP/1.1 RPC and /rpc/shutdown over node:net (Windows Named Pipe transport parity)", async () => {
    const kilnHome = makeTempDir("kiln-srv-net-ipc-");
    tempDirs.push(kilnHome);

    const server = new KilndServer({
      kilnHome,
      port: 0,
      ipcTransportMode: "net",
      maxRpcBodyBytes: 512,
      tokenSecret: "socket-net-ipc-secret-1234567890",
    });
    servers.push(server);
    const addr = await server.start();

    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-net-1",
        title: "Net IPC parity task",
        space: "kiln",
        priority: "P1",
        track: "L2",
        workspace_mode: "scratch_dir",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Verify node:net HTTP/1.1 transport",
          end: "All RPC routes behave identically to node:http",
          accept_cmd: "echo ok",
          accept_files_hash: "sha256:net",
          scope: ["out/**"],
          deliver: { mode: "manual", cmd: null },
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
      },
      "# Net IPC brief",
    );

    const workerToken = server.issueRunToken({
      taskId: "t-net-1",
      runId: "run-net-1",
      role: "worker",
      contractVersion: 1,
    });

    // 1. sendNetHttpRequest client -> createNetHttpServer (200 OK)
    const ctxNet = await sendNetHttpRequest({
      socketPath: addr.socketPath,
      method: "POST",
      path: "/rpc/mcp/wb_get_context",
      headers: {
        Authorization: `Bearer ${workerToken}`,
        "Content-Type": "application/json",
      },
      rawBody: "{}",
      timeoutMs: 2_000,
    });
    expect(ctxNet.status).toBe(200);
    expect((JSON.parse(ctxNet.rawBody) as { card: { id: string } }).card.id).toBe("t-net-1");

    // 2. Role allowlist (403 role_forbidden) & bad auth (401)
    const forbiddenNet = await sendNetHttpRequest({
      socketPath: addr.socketPath,
      method: "POST",
      path: "/rpc/mcp/wb_plan",
      headers: {
        Authorization: `Bearer ${workerToken}`,
        "Content-Type": "application/json",
      },
      rawBody: JSON.stringify({ mode: "upsert_draft", draft_id: "d-net-bad" }),
    });
    expect(forbiddenNet.status).toBe(403);
    expect(RoleForbiddenErrorSchema.parse(JSON.parse(forbiddenNet.rawBody)).code).toBe(
      "role_forbidden",
    );

    const unauthNet = await sendNetHttpRequest({
      socketPath: addr.socketPath,
      method: "POST",
      path: "/rpc/mcp/wb_get_context",
      headers: { Authorization: "Bearer invalid-token" },
      rawBody: "{}",
    });
    expect(unauthNet.status).toBe(401);

    // 3. Bounded body size check (413 payload_too_large)
    const oversizeRes = await sendNetHttpRequest({
      socketPath: addr.socketPath,
      method: "POST",
      path: "/rpc/mcp/wb_get_context",
      headers: {
        Authorization: `Bearer ${workerToken}`,
        "Content-Type": "application/json",
      },
      rawBody: JSON.stringify({ pad: "x".repeat(700) }),
    });
    expect(oversizeRes.status).toBe(413);

    // 4. Cross-interop: Node http.request({ socketPath }) against node:net HTTP server
    const stdHttpRes = await requestUnixSocket(addr.socketPath, {
      method: "POST",
      path: "/rpc/mcp/wb_get_context",
      headers: { Authorization: `Bearer ${workerToken}` },
      body: {},
    });
    expect(stdHttpRes.status).toBe(200);
    expect((stdHttpRes.json.card as { id: string }).id).toBe("t-net-1");

    // 5. Graceful POST /rpc/shutdown via sendNetHttpRequest
    const shutdownToken = fs.readFileSync(server.store.paths.shutdownTokenFile, "utf8").trim();
    const badShutdown = await sendNetHttpRequest({
      socketPath: addr.socketPath,
      method: "POST",
      path: "/rpc/shutdown",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(badShutdown.status).toBe(401);
    expect(server.address).not.toBeNull();

    const okShutdown = await sendNetHttpRequest({
      socketPath: addr.socketPath,
      method: "POST",
      path: "/rpc/shutdown",
      headers: { Authorization: `Bearer ${shutdownToken}` },
    });
    expect(okShutdown.status).toBe(200);
    expect(JSON.parse(okShutdown.rawBody)).toEqual({ ok: true, shuttingDown: true });

    const deadline = Date.now() + 3_000;
    while (server.address !== null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(server.address).toBeNull();
    expect(fs.existsSync(server.store.paths.shutdownTokenFile)).toBe(false);
  });
});
