import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAcceptEnvSession, type AcceptEnvSession } from "../index.js";

function httpGetText(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
  });
}

describe("Track 3 OS multi-process accept_entry & observer proxy suite (requires unsandboxed loopback)", () => {
  const tempDirs: string[] = [];
  const sessions: AcceptEnvSession[] = [];

  afterEach(async () => {
    for (const s of sessions.splice(0)) {
      await s.stop().catch(() => {});
    }
    for (const d of tempDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("boots dependent api -> web services with {{ports.api}}, ignores health probes in proxy counter, captures 500 & crash, and frees ports on stop()", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kiln-accept-os-"));
    tempDirs.push(root);
    const worktree = path.join(root, "worktree");
    const envDir = path.join(root, "accept-env");
    fs.mkdirSync(worktree, { recursive: true });

    fs.writeFileSync(
      path.join(worktree, "api.mjs"),
      [
        "import http from 'node:http';",
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "const port = Number(process.env.PORT);",
        "fs.writeFileSync(path.join(process.env.KILN_ACCEPT_TMPDIR, 'api.txt'), 'ok');",
        "const server = http.createServer((req, res) => {",
        "  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }",
        "  if (req.url === '/boom') { res.writeHead(500); res.end('err'); return; }",
        "  if (req.url === '/crash') { res.writeHead(200); res.end('bye'); setTimeout(() => process.exit(42), 20); return; }",
        "  res.writeHead(200); res.end('api-ok');",
        "});",
        "server.listen(port, '127.0.0.1');",
      ].join("\n"),
      "utf8",
    );

    fs.writeFileSync(
      path.join(worktree, "web.mjs"),
      [
        "import http from 'node:http';",
        "const port = Number(process.env.PORT);",
        "const apiPort = Number(process.env.KILN_PORT_API);",
        "const server = http.createServer((req, res) => {",
        "  if (req.url === '/') {",
        "    http.get(`http://127.0.0.1:${apiPort}/data`, (apiRes) => {",
        "      const chunks = [];",
        "      apiRes.on('data', (c) => chunks.push(c));",
        "      apiRes.on('end', () => {",
        "        res.writeHead(200);",
        "        res.end(`web+${Buffer.concat(chunks).toString('utf8')}`);",
        "      });",
        "    }).on('error', (err) => { res.writeHead(502); res.end(err.message); });",
        "    return;",
        "  }",
        "  res.writeHead(200); res.end('web-health');",
        "});",
        "server.listen(port, '127.0.0.1');",
      ].join("\n"),
      "utf8",
    );

    const started = await startAcceptEnvSession({
      cwd: worktree,
      acceptEnvDir: envDir,
      entry: {
        kind: "http_server",
        observe_http: true,
        required_capability: "browser",
        services: [
          {
            name: "api",
            cmd: `${JSON.stringify(process.execPath)} api.mjs`,
            needs_port: true,
            depends_on: [],
            ready: { kind: "http", path: "/health" },
            ready_timeout_ms: 10_000,
          },
          {
            name: "web",
            cmd: `${JSON.stringify(process.execPath)} web.mjs`,
            needs_port: true,
            primary: true,
            depends_on: ["api"],
            ready: { kind: "http", path: "/healthz" },
            ready_timeout_ms: 10_000,
          },
        ],
      },
    });

    if (!started.ok) {
      throw new Error(
        `startAcceptEnvSession failed: ${started.errorMessage} | services=${JSON.stringify(started.services)}`,
      );
    }
    expect(started.ok).toBe(true);
    expect(started.session).toBeTruthy();
    sessions.push(started.session!);
    // Before verifier hits proxy, health checks bypassed proxy -> 0 real requests!
    expect(started.traffic.total_requests).toBe(0);
    expect(started.primaryUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const webRes = await httpGetText(`${started.primaryUrl!}/`);
    expect(webRes.status).toBe(200);
    expect(webRes.body).toBe("web+api-ok");

    const apiSvc = started.services.find((s) => s.name === "api")!;
    const boomRes = await httpGetText(`${apiSvc.url!}/boom`);
    expect(boomRes.status).toBe(500);

    const midSnap = started.session!.getLiveSnapshot();
    // 1 web "/" + 1 api "/data" + 1 api "/boom" = 3 observed requests!
    expect(midSnap.traffic.total_requests).toBe(3);
    expect(midSnap.traffic.error_responses).toEqual([
      { method: "GET", path: "/boom", status: 500, service: "api" },
    ]);

    // Trigger mid-run crash in api service
    await httpGetText(`${apiSvc.url!}/crash`);
    await new Promise((r) => setTimeout(r, 120));
    const crashSnap = started.session!.getLiveSnapshot();
    const crashedApi = crashSnap.services.find((s) => s.name === "api")!;
    expect(crashedApi.status).toBe("crashed");
    expect(crashedApi.exit_code).toBe(42);

    await started.session!.stop();
    // Proxy port should now refuse connections after full cleanup
    await expect(httpGetText(`${started.primaryUrl!}/`)).rejects.toThrow();
    expect(fs.existsSync(path.join(envDir, "api.log"))).toBe(true);
    expect(fs.existsSync(path.join(envDir, "web.log"))).toBe(true);
  });
});
