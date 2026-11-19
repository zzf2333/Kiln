import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoleForbiddenErrorSchema, type SseEvent, SseEventSchema } from "@kiln/protocol";
import { KilndServer } from "../index.js";

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
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
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

    expect(fs.statSync(addr.socketPath).mode & 0o777).toBe(0o600);

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
});
