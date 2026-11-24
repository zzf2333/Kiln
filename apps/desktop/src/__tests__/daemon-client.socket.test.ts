import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { KilndClient } from "../daemon-client.js";
import { isTrayStateOnline, validateKilndUrl, type SseEventFrame } from "../model.js";

const servers: http.Server[] = [];

async function startServer(
  handler: http.RequestListener,
): Promise<{ baseUrl: string; server: http.Server }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Expected numeric loopback port");
  }
  return { baseUrl: `http://127.0.0.1:${addr.port}`, server };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0, servers.length).map(
      (srv) =>
        new Promise<void>((resolve) => {
          srv.closeAllConnections?.();
          srv.close(() => resolve());
        }),
    ),
  );
});

describe("@kiln/desktop KilndClient loopback timeout & SSE lifecycle", () => {
  it("keeps idle SSE stream open beyond sseConnectTimeoutMs and delivers late events", async () => {
    const { baseUrl } = await startServer((req, res) => {
      if (req.url === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.flushHeaders?.();
        const timer = setTimeout(() => {
          if (!res.destroyed) {
            res.write('id: 1\nevent: task.updated\ndata: {"id":"t-1"}\n\n');
          }
        }, 320);
        req.on("close", () => clearTimeout(timer));
        return;
      }
      res.writeHead(404).end();
    });

    const client = new KilndClient(validateKilndUrl(baseUrl), {
      sseConnectTimeoutMs: 120,
    });
    const ac = new AbortController();
    const events: SseEventFrame[] = [];
    const closes: string[] = [];

    const firstEventPromise = new Promise<void>((resolve, reject) => {
      const guard = setTimeout(
        () => reject(new Error("Timed out waiting for late SSE frame")),
        2000,
      );
      client.openSseStream({
        lastEventId: null,
        signal: ac.signal,
        onEvent: (frame) => {
          events.push(frame);
          clearTimeout(guard);
          resolve();
        },
        onClose: (reason) => {
          closes.push(reason);
          if (reason !== "aborted") {
            clearTimeout(guard);
            reject(new Error(`Unexpected SSE close: ${reason}`));
          }
        },
      });
    });

    await firstEventPromise;
    expect(events).toEqual([{ id: "1", event: "task.updated", data: '{"id":"t-1"}' }]);
    expect(closes).toEqual([]);

    ac.abort();
    expect(closes).toEqual(["aborted"]);
  });

  it("times out SSE connections that never send response headers", async () => {
    const { baseUrl } = await startServer((req, res) => {
      if (req.url === "/api/events") {
        // Deliberately withhold response headers to simulate stalled connect handshake
        req.on("close", () => {
          if (!res.destroyed) res.destroy();
        });
        return;
      }
      res.writeHead(404).end();
    });

    const client = new KilndClient(validateKilndUrl(baseUrl), {
      sseConnectTimeoutMs: 100,
    });
    const ac = new AbortController();

    const closeReason = await new Promise<string>((resolve) => {
      client.openSseStream({
        lastEventId: null,
        signal: ac.signal,
        onEvent: () => {},
        onClose: (reason) => resolve(reason),
      });
    });

    expect(closeReason).toContain("SSE connect timeout");
  });

  it("allows slow /api/bootstrap responses beyond healthTimeoutMs to complete cleanly", async () => {
    const { baseUrl } = await startServer((req, res) => {
      if (req.url === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, pid: 1001, version: "0.0.5" }));
        return;
      }
      if (req.url === "/api/bootstrap") {
        const timer = setTimeout(() => {
          if (!res.destroyed) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                tasks: [{ id: "t-1" }],
                pendingDecisions: [],
                liveRates: { totals: { costUsd: 0.42, tokPerSec: 12.5 } },
                runningCount: 1,
              }),
            );
          }
        }, 260);
        req.on("close", () => clearTimeout(timer));
        return;
      }
      res.writeHead(404).end();
    });

    const client = new KilndClient(validateKilndUrl(baseUrl), {
      healthTimeoutMs: 150,
      bootstrapTimeoutMs: 800,
    });

    const snapshot = await client.probeTraySnapshot();
    expect(snapshot.daemonVersion).toBe("0.0.5");
    expect(isTrayStateOnline(snapshot.state)).toBe(true);
    expect(snapshot.state).toEqual({
      kind: "running",
      runningCount: 1,
      tokPerSec: 12.5,
      costUsd: 0.42,
    });
  });
});
