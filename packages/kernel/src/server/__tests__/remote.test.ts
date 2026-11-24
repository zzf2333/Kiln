import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SseEventSchema, type SseEvent } from "@kiln/protocol";
import {
  CaffeinateController,
  FORBIDDEN_LOCAL_PROXY_HEADERS,
  KilndServer,
  hashSessionToken,
  inspectTailscaleStatus,
  isStrictLoopbackHost,
  parseSessionCookie,
  timingSafeStringEqual,
  type CaffeinateChildProcess,
  type TailscaleExecFileFn,
} from "../index.js";

function makeTempDir(prefix = "kiln-remote-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFakeChild(): CaffeinateChildProcess & {
  killCalls: Array<NodeJS.Signals | number | undefined>;
  emitExit: () => void;
} {
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const killCalls: Array<NodeJS.Signals | number | undefined> = [];
  return {
    killCalls,
    kill(signal) {
      killCalls.push(signal);
      return true;
    },
    once(event, listener) {
      if (event === "exit") {
        exitListeners.push(
          listener as (code: number | null, signal: NodeJS.Signals | null) => void,
        );
      }
      return this;
    },
    unref() {
      return this;
    },
    emitExit() {
      for (const fn of exitListeners.splice(0)) {
        fn(0, null);
      }
    },
  };
}

function extractKilnSessionCookie(setCookieHeader: string | null): string {
  expect(setCookieHeader).toBeTruthy();
  const match = /^kiln_session=([^;]+)/.exec(setCookieHeader!);
  expect(match).toBeTruthy();
  return match![1]!;
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

describe("Tunnel-Agnostic Remote Access: Fail-Closed Dual-Port Security & Auth", () => {
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

  function createServer(overrides: ConstructorParameters<typeof KilndServer>[0] = {}): {
    server: KilndServer;
    kilnHome: string;
  } {
    const kilnHome = makeTempDir();
    tempDirs.push(kilnHome);
    const server = new KilndServer({
      kilnHome,
      publicDir: null,
      tokenSecret: "remote-test-secret-0123456789abcdef",
      ...overrides,
    });
    servers.push(server);
    return { server, kilnHome };
  }

  async function pairDevice(
    server: KilndServer,
    opts: {
      mode?: "token" | "code";
      label?: string;
      userAgent?: string;
      httpsProxy?: boolean;
    } = {},
  ): Promise<{
    deviceId: string;
    sessionToken: string;
    cookieHeader: string;
    setCookie: string;
    challenge: {
      challengeId: string;
      code: string;
      token: string;
      expiresAt: string;
      pairUrl: string | null;
    };
  }> {
    const createRes = await server.app.request(
      new Request("http://127.0.0.1:4310/api/remote/pair", { method: "POST" }),
    );
    expect(createRes.status).toBe(201);
    const challenge = (await createRes.json()) as {
      ok: true;
      challengeId: string;
      code: string;
      token: string;
      expiresAt: string;
      pairUrl: string | null;
    };

    const payload =
      opts.mode === "code"
        ? { code: challenge.code, ...(opts.label ? { label: opts.label } : {}) }
        : { token: challenge.token, ...(opts.label ? { label: opts.label } : {}) };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (opts.userAgent) {
      headers["User-Agent"] = opts.userAgent;
    }
    if (opts.httpsProxy) {
      headers["X-Forwarded-Proto"] = "https";
      headers["X-Forwarded-Host"] = "kiln.tail123.ts.net";
    }

    const pairRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/auth/pair", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      }),
    );
    expect(pairRes.status).toBe(200);
    const setCookie = pairRes.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    const sessionToken = extractKilnSessionCookie(setCookie);
    const body = (await pairRes.json()) as {
      ok: true;
      device: { id: string; label: string };
    };

    return {
      deviceId: body.device.id,
      sessionToken,
      cookieHeader: `kiln_session=${sessionToken}`,
      setCookie: setCookie!,
      challenge,
    };
  }

  it("local :4310 rejects all reverse-proxy headers with 403 remote_port_required and blocks Host DNS rebinding", async () => {
    const { server } = createServer();

    // Update configured remote_port to 4411 to ensure error guidance reflects configured port
    const putCfg = await server.app.request(
      new Request("http://127.0.0.1:4310/api/settings/remote", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema_version: 1,
          enabled: false,
          remote_port: 4411,
        }),
      }),
    );
    expect(putCfg.status).toBe(200);

    // Every reverse-proxy header (both explicit list and wildcard X-Forwarded-* / CF-* / Tailscale-*)
    // must be rejected on :4310 across API and root paths
    const allProxyHeadersToReject = [
      ...FORBIDDEN_LOCAL_PROXY_HEADERS,
      "x-forwarded-port",
      "x-forwarded-prefix",
      "cf-ipcountry",
      "cf-connecting-ipv6",
      "tailscale-user-id",
      "tailscale-caps",
    ];
    for (const headerName of allProxyHeadersToReject) {
      const res = await server.app.request(
        new Request("http://127.0.0.1:4310/api/health", {
          headers: { [headerName]: "203.0.113.42" },
        }),
      );
      expect(res.status, `header ${headerName} should return 403`).toBe(403);
      const body = (await res.json()) as {
        error: string;
        header: string;
        remotePort: number;
        message: string;
      };
      expect(body.error).toBe("remote_port_required");
      expect(body.header).toBe(headerName);
      expect(body.remotePort).toBe(4411);
      expect(body.message).toContain("4411");
    }

    // DNS rebinding / non-loopback Host headers must be rejected with 403 invalid_host
    const maliciousHosts = [
      "evil.example.com",
      "evil.example.com:4310",
      "127.0.0.1.evil.com",
      "localhost.evil.com",
      "192.168.1.50:4310",
      "10.0.0.1:4310",
      "0.0.0.0:4310",
      "127.0.0.1:99999",
      "",
    ];
    for (const badHost of maliciousHosts) {
      expect(isStrictLoopbackHost(badHost)).toBe(false);
      const res = await server.app.request(
        new Request("http://127.0.0.1:4310/api/bootstrap", {
          headers: { Host: badHost },
        }),
      );
      expect(res.status, `Host "${badHost}" must return 403`).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_host");
    }

    // Non-loopback URL with no explicit Host header is also blocked
    const nonLoopbackUrlRes = await server.app.request(
      new Request("http://attacker.local/api/health"),
    );
    expect(nonLoopbackUrlRes.status).toBe(403);

    // Valid loopback hosts succeed on :4310
    for (const goodHost of [
      "127.0.0.1",
      "127.0.0.1:4310",
      "localhost",
      "localhost:4310",
      "[::1]",
      "[::1]:4310",
    ]) {
      expect(isStrictLoopbackHost(goodHost)).toBe(true);
      const res = await server.app.request(
        new Request("http://127.0.0.1:4310/api/health", {
          headers: { Host: goodHost },
        }),
      );
      expect(res.status, `Host "${goodHost}" must be accepted`).toBe(200);
    }

    // Cross-origin mutating request against local :4310 (including legacy Tauri origins) is rejected
    for (const badOrigin of ["https://evil.com", "tauri://localhost", "http://tauri.localhost"]) {
      const crossOriginLocal = await server.app.request(
        new Request("http://127.0.0.1:4310/api/remote/pair", {
          method: "POST",
          headers: { Origin: badOrigin },
        }),
      );
      expect(crossOriginLocal.status, `Origin "${badOrigin}" must be rejected`).toBe(403);
      expect(((await crossOriginLocal.json()) as { error: string }).error).toBe(
        "csrf_origin_mismatch",
      );
    }
  });

  it("remote :4311 unconditionally requires kiln_session cookie (zero loopback bypass) and minimizes unauth /api/health", async () => {
    const publicDir = makeTempDir("kiln-remote-pub-");
    tempDirs.push(publicDir);
    fs.writeFileSync(path.join(publicDir, "index.html"), "<!doctype html><title>Kiln</title>");
    fs.writeFileSync(
      path.join(publicDir, "manifest.webmanifest"),
      JSON.stringify({ name: "Kiln" }),
    );
    fs.mkdirSync(path.join(publicDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(publicDir, "assets", "app.js"), "console.log('kiln');");

    const { server } = createServer({ publicDir });

    // Unauthenticated /api/health is minimal and MUST NOT leak pid, version, or paths
    const healthRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/health"),
    );
    expect(healthRes.status).toBe(200);
    const healthBody = (await healthRes.json()) as Record<string, unknown>;
    expect(healthBody).toEqual({ ok: true, mode: "remote" });
    expect("pid" in healthBody).toBe(false);
    expect("version" in healthBody).toBe(false);

    // Unauthenticated /api/auth/status works
    const authStatusRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/auth/status"),
    );
    expect(authStatusRes.status).toBe(200);
    expect(await authStatusRes.json()).toEqual({
      ok: true,
      mode: "remote",
      authenticated: false,
      device: null,
    });

    // Static frontend shell assets are accessible unauthenticated on :4311
    expect((await server.remoteApp.request(new Request("http://127.0.0.1:4311/"))).status).toBe(
      200,
    );
    expect(
      (await server.remoteApp.request(new Request("http://127.0.0.1:4311/manifest.webmanifest")))
        .status,
    ).toBe(200);
    expect(
      (await server.remoteApp.request(new Request("http://127.0.0.1:4311/assets/app.js"))).status,
    ).toBe(200);

    // Every protected API & SSE route returns 401 EVEN over 127.0.0.1 loopback!
    const protectedRequests = [
      new Request("http://127.0.0.1:4311/api/bootstrap"),
      new Request("http://localhost:4311/api/bootstrap"),
      new Request("http://127.0.0.1:4311/api/events"),
      new Request("http://127.0.0.1:4311/api/events?token=forged"),
      new Request("http://127.0.0.1:4311/api/spaces"),
      new Request("http://127.0.0.1:4311/api/ledgers"),
      new Request("http://127.0.0.1:4311/api/agents"),
      new Request("http://127.0.0.1:4311/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Kiln-Client": "web" },
        body: JSON.stringify({ title: "unauth draft" }),
      }),
      new Request("http://127.0.0.1:4311/api/settings/limits", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Kiln-Client": "web" },
        body: JSON.stringify({ schema_version: 1 }),
      }),
    ];

    for (const req of protectedRequests) {
      const res = await server.remoteApp.request(req);
      expect(res.status, `${req.method} ${req.url} must return 401`).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe("unauthorized");
    }
  });

  it("enforces pairing fragment URL, TTL expiry, single-use replay protection, max 5 failed attempts, 0600 SHA-256-only devices.yaml, and Secure cookie flag", async () => {
    let fakeNow = Date.parse("2026-11-20T12:00:00.000Z");
    const { server, kilnHome } = createServer({
      remoteAuthNow: () => fakeNow,
    });

    // Configure public_url -> pairUrl uses #pair=<token> fragment, NEVER query string
    const cfgRes = await server.app.request(
      new Request("http://127.0.0.1:4310/api/settings/remote", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema_version: 1,
          enabled: true,
          remote_port: 4311,
          public_url: "https://mac-mini.tail99.ts.net/",
        }),
      }),
    );
    expect(cfgRes.status).toBe(200);

    // 1. Test TTL expiry (5 min)
    const ch1Res = await server.app.request(
      new Request("http://127.0.0.1:4310/api/remote/pair", { method: "POST" }),
    );
    expect(ch1Res.status).toBe(201);
    const ch1 = (await ch1Res.json()) as {
      code: string;
      token: string;
      pairUrl: string | null;
    };
    expect(ch1.code).toMatch(/^\d{6}$/);
    expect(ch1.token.length).toBeGreaterThanOrEqual(40);
    expect(ch1.pairUrl).toBe(
      `https://mac-mini.tail99.ts.net/#pair=${encodeURIComponent(ch1.token)}`,
    );
    expect(ch1.pairUrl).not.toContain("?pair=");

    // Advance past 5-minute TTL
    fakeNow += 5 * 60 * 1000 + 1;
    const expiredRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/auth/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: ch1.token }),
      }),
    );
    expect(expiredRes.status).toBe(401);
    expect(((await expiredRes.json()) as { error: string }).error).toBe("pairing_expired");

    // 2. Test max 5 failed attempts invalidating active challenge
    const ch2Res = await server.app.request(
      new Request("http://127.0.0.1:4310/api/remote/pair", { method: "POST" }),
    );
    const ch2 = (await ch2Res.json()) as { code: string; token: string };
    const wrongCode = ch2.code === "000000" ? "111111" : "000000";

    // Cross-origin POST /api/auth/pair with mismatched Origin is blocked with 403
    // and MUST NOT consume pairing failure quota
    const crossOriginPairRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/auth/pair", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example.com",
        },
        body: JSON.stringify({ code: wrongCode }),
      }),
    );
    expect(crossOriginPairRes.status).toBe(403);
    expect(((await crossOriginPairRes.json()) as { error: string }).error).toBe(
      "csrf_origin_mismatch",
    );

    for (let attempt = 1; attempt <= 4; attempt++) {
      const badRes = await server.remoteApp.request(
        new Request("http://127.0.0.1:4311/api/auth/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: wrongCode }),
        }),
      );
      expect(badRes.status).toBe(401);
      const body = (await badRes.json()) as {
        error: string;
        attemptsRemaining: number;
      };
      expect(body.error).toBe("invalid_pairing_credentials");
      expect(body.attemptsRemaining).toBe(5 - attempt);
    }

    // 5th failure returns 429 and invalidates the challenge
    const fifthBadRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/auth/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: wrongCode }),
      }),
    );
    expect(fifthBadRes.status).toBe(429);
    expect(((await fifthBadRes.json()) as { error: string }).error).toBe(
      "pairing_attempts_exceeded",
    );

    // Even with the VALID token/code now, challenge is gone -> 401
    const afterLockoutRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/auth/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: ch2.token }),
      }),
    );
    expect(afterLockoutRes.status).toBe(401);
    expect(((await afterLockoutRes.json()) as { error: string }).error).toBe(
      "invalid_pairing_challenge",
    );

    // 3. Successful pairing via 6-digit code over HTTPS reverse proxy -> sets Secure cookie
    const paired = await pairDevice(server, {
      mode: "code",
      label: "iPhone 16 Pro",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      httpsProxy: true,
    });
    expect(paired.setCookie).toContain("HttpOnly");
    expect(paired.setCookie).toContain("SameSite=Lax");
    expect(paired.setCookie).toContain("Path=/");
    expect(paired.setCookie).toContain("Max-Age=2592000");
    expect(paired.setCookie).toContain("Secure");

    // Replaying the same code or token fails (single-use atomic consumption)
    const replayRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/auth/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: paired.challenge.token }),
      }),
    );
    expect(replayRes.status).toBe(401);

    // Plain HTTP pairing omits Secure attribute
    const pairedHttp = await pairDevice(server, { mode: "token", label: "iPad" });
    expect(pairedHttp.setCookie).toContain("HttpOnly");
    expect(pairedHttp.setCookie).not.toContain("; Secure");

    // Verify devices.yaml permissions (0600) and SHA-256-only storage (ZERO plaintext tokens)
    const devicesPath = path.join(kilnHome, "config", "devices.yaml");
    expect(fs.existsSync(devicesPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(devicesPath).mode & 0o777).toBe(0o600);
    }
    const rawDevicesYaml = fs.readFileSync(devicesPath, "utf8");
    expect(rawDevicesYaml).not.toContain(paired.sessionToken);
    expect(rawDevicesYaml).not.toContain(pairedHttp.sessionToken);
    expect(rawDevicesYaml).toContain(hashSessionToken(paired.sessionToken));
    expect(rawDevicesYaml).toContain(hashSessionToken(pairedHttp.sessionToken));

    // Verify GET /api/remote/devices on :4310 never leaks token_sha256
    const listRes = await server.app.request(
      new Request("http://127.0.0.1:4310/api/remote/devices"),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      ok: true;
      devices: Array<Record<string, unknown>>;
    };
    expect(listBody.devices).toHaveLength(2);
    for (const dev of listBody.devices) {
      expect("token_sha256" in dev).toBe(false);
      expect("token" in dev).toBe(false);
    }

    // Constant-time helper & strict cookie parser sanity checks
    expect(timingSafeStringEqual("abc", "abc")).toBe(true);
    expect(timingSafeStringEqual("abc", "abcd")).toBe(false);
    expect(parseSessionCookie("other_kiln_session=bad; kiln_session=real123; x=1")).toBe("real123");
    expect(parseSessionCookie("other_kiln_session=bad")).toBeNull();
  });

  it("enforces CSRF Origin checks and strict privilege separation (403 local_only_endpoint) on :4311 while allowing normal remote workflows", async () => {
    const { server } = createServer();
    const paired = await pairDevice(server, { label: "Phone" });

    // Authenticated GET /api/auth/status & /api/bootstrap succeed
    const statusRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/auth/status", {
        headers: { Cookie: paired.cookieHeader },
      }),
    );
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as {
      authenticated: boolean;
      device: { id: string } | null;
    };
    expect(statusBody.authenticated).toBe(true);
    expect(statusBody.device?.id).toBe(paired.deviceId);

    const bootRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/bootstrap", {
        headers: { Cookie: paired.cookieHeader },
      }),
    );
    expect(bootRes.status).toBe(200);

    // CSRF: missing Origin AND missing X-Kiln-Client -> 403
    const noCsrfRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/drafts", {
        method: "POST",
        headers: {
          Cookie: paired.cookieHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "No CSRF" }),
      }),
    );
    expect(noCsrfRes.status).toBe(403);
    expect(((await noCsrfRes.json()) as { error: string }).error).toBe("csrf_check_failed");

    // CSRF: mismatched Origin -> 403 EVEN IF X-Kiln-Client: web is present
    const badOriginRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/drafts", {
        method: "POST",
        headers: {
          Cookie: paired.cookieHeader,
          Origin: "https://evil.example.com",
          "X-Kiln-Client": "web",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Evil Origin" }),
      }),
    );
    expect(badOriginRes.status).toBe(403);
    expect(((await badOriginRes.json()) as { error: string }).error).toBe("csrf_origin_mismatch");

    // CSRF: Origin: null -> 403
    const nullOriginRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/drafts", {
        method: "POST",
        headers: {
          Cookie: paired.cookieHeader,
          Origin: "null",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Null Origin" }),
      }),
    );
    expect(nullOriginRes.status).toBe(403);

    // CSRF: protocol downgrade (X-Forwarded-Proto: https with http:// Origin) -> 403
    const downgradeRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/drafts", {
        method: "POST",
        headers: {
          Cookie: paired.cookieHeader,
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "kiln.tail123.ts.net",
          Origin: "http://kiln.tail123.ts.net",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Protocol Downgrade" }),
      }),
    );
    expect(downgradeRes.status).toBe(403);

    // CSRF: matching Origin behind HTTPS reverse proxy -> 201
    const okProxyOriginRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/drafts", {
        method: "POST",
        headers: {
          Cookie: paired.cookieHeader,
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "kiln.tail123.ts.net",
          Origin: "https://kiln.tail123.ts.net",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: "d-remote-1", title: "Phone draft" }),
      }),
    );
    expect(okProxyOriginRes.status).toBe(201);

    // CSRF: no Origin + X-Kiln-Client: web -> 200 (allowed for non-browser tests)
    const okClientHeaderRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/settings/limits", {
        method: "PUT",
        headers: {
          Cookie: paired.cookieHeader,
          "X-Kiln-Client": "web",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          schema_version: 1,
          max_concurrent_slots: 3,
        }),
      }),
    );
    expect(okClientHeaderRes.status).toBe(200);

    // Privilege separation: ALL remote-admin endpoints MUST return 403 local_only_endpoint on :4311
    const adminRequests = [
      new Request("http://127.0.0.1:4311/api/settings/remote", {
        method: "GET",
        headers: { Cookie: paired.cookieHeader },
      }),
      new Request("http://127.0.0.1:4311/api/settings/remote", {
        method: "PUT",
        headers: {
          Cookie: paired.cookieHeader,
          "X-Kiln-Client": "web",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ schema_version: 1, enabled: false }),
      }),
      new Request("http://127.0.0.1:4311/api/remote/pair", {
        method: "POST",
        headers: { Cookie: paired.cookieHeader, "X-Kiln-Client": "web" },
      }),
      new Request("http://127.0.0.1:4311/api/remote/devices", {
        method: "GET",
        headers: { Cookie: paired.cookieHeader },
      }),
      new Request(`http://127.0.0.1:4311/api/remote/devices/${paired.deviceId}`, {
        method: "DELETE",
        headers: { Cookie: paired.cookieHeader, "X-Kiln-Client": "web" },
      }),
      new Request("http://127.0.0.1:4311/api/remote/devices/revoke-all", {
        method: "POST",
        headers: { Cookie: paired.cookieHeader, "X-Kiln-Client": "web" },
      }),
      new Request("http://127.0.0.1:4311/api/remote/notifications/test", {
        method: "POST",
        headers: {
          Cookie: paired.cookieHeader,
          "X-Kiln-Client": "web",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      }),
      new Request("http://127.0.0.1:4311/api/remote/tailscale", {
        method: "GET",
        headers: { Cookie: paired.cookieHeader },
      }),
    ];

    for (const req of adminRequests) {
      const res = await server.remoteApp.request(req);
      expect(res.status, `${req.method} ${req.url} must return 403`).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("local_only_endpoint");
    }
  });

  it("authenticates remote SSE and immediately closes revoked device SSE streams without closing local or other devices", async () => {
    const { server } = createServer();
    const devA = await pairDevice(server, { label: "iPhone A" });
    const devB = await pairDevice(server, { label: "iPad B" });

    const localSseRes = await server.app.request(new Request("http://127.0.0.1:4310/api/events"));
    expect(localSseRes.status).toBe(200);
    const localReader = localSseRes.body!.getReader();

    const devASseRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/events", {
        headers: { Cookie: devA.cookieHeader },
      }),
    );
    expect(devASseRes.status).toBe(200);
    const devAReader = devASseRes.body!.getReader();

    const devBSseRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/events", {
        headers: { Cookie: devB.cookieHeader },
      }),
    );
    expect(devBSseRes.status).toBe(200);
    const devBReader = devBSseRes.body!.getReader();

    // Publish event -> all 3 receive it
    server.sseHub.publish({
      type: "task.updated",
      taskId: "t-sse-1",
      patch: { status: "running" },
    });

    const decoder = new TextDecoder();
    const [cLocal, cA, cB] = await Promise.all([
      localReader.read(),
      devAReader.read(),
      devBReader.read(),
    ]);
    expect(parseSseFrames(decoder.decode(cLocal.value))[0]?.data.type).toBe("task.updated");
    expect(parseSseFrames(decoder.decode(cA.value))[0]?.data.type).toBe("task.updated");
    expect(parseSseFrames(decoder.decode(cB.value))[0]?.data.type).toBe("task.updated");

    // Revoke device A -> immediately closes ONLY device A's SSE stream
    const revokeARes = await server.app.request(
      new Request(`http://127.0.0.1:4310/api/remote/devices/${devA.deviceId}`, {
        method: "DELETE",
      }),
    );
    expect(revokeARes.status).toBe(200);
    const revokeABody = (await revokeARes.json()) as {
      revoked: boolean;
      closedStreams: number;
    };
    expect(revokeABody.revoked).toBe(true);
    expect(revokeABody.closedStreams).toBe(1);

    // Device A stream ends cleanly right away
    const devAAfterRevoke = await devAReader.read();
    expect(devAAfterRevoke.done).toBe(true);

    // Device A cookie is now rejected with 401
    const devABoot = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/bootstrap", {
        headers: { Cookie: devA.cookieHeader },
      }),
    );
    expect(devABoot.status).toBe(401);

    // Local and Device B still receive new events
    server.sseHub.publish({
      type: "task.updated",
      taskId: "t-sse-2",
      patch: { status: "done" },
    });
    const [cLocal2, cB2] = await Promise.all([localReader.read(), devBReader.read()]);
    expect(cLocal2.done).toBe(false);
    expect(cB2.done).toBe(false);

    // Revoke all -> closes Device B's SSE stream while keeping local SSE stream open
    const revokeAllRes = await server.app.request(
      new Request("http://127.0.0.1:4310/api/remote/devices/revoke-all", {
        method: "POST",
      }),
    );
    expect(revokeAllRes.status).toBe(200);
    const revokeAllBody = (await revokeAllRes.json()) as {
      revokedCount: number;
      closedStreams: number;
    };
    expect(revokeAllBody.revokedCount).toBe(1);
    expect(revokeAllBody.closedStreams).toBe(1);

    expect((await devBReader.read()).done).toBe(true);

    server.sseHub.publish({
      type: "task.updated",
      taskId: "t-sse-3",
      patch: { status: "paused" },
    });
    const cLocal3 = await localReader.read();
    expect(cLocal3.done).toBe(false);
    await localReader.cancel();

    // Test POST /api/auth/logout revokes active device, closes its SSE, and clears cookie
    const devC = await pairDevice(server, { label: "Safari C" });
    const devCSseRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/events", {
        headers: { Cookie: devC.cookieHeader },
      }),
    );
    const devCReader = devCSseRes.body!.getReader();

    const logoutRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/auth/logout", {
        method: "POST",
        headers: {
          Cookie: devC.cookieHeader,
          Origin: "http://127.0.0.1:4311",
        },
      }),
    );
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await devCReader.read()).done).toBe(true);
    expect(
      (
        await server.remoteApp.request(
          new Request("http://127.0.0.1:4311/api/bootstrap", {
            headers: { Cookie: devC.cookieHeader },
          }),
        )
      ).status,
    ).toBe(401);
  });

  it("transitions CaffeinateController cleanly between off, active_tasks (-i), and remote_ac_standby (-s AC-only)", async () => {
    const spawns: Array<{ command: string; args: readonly string[] }> = [];
    const children: ReturnType<typeof makeFakeChild>[] = [];

    const controller = new CaffeinateController({
      platform: "darwin",
      existsSync: () => true,
      pid: 7777,
      spawnProcess: (command, args) => {
        spawns.push({ command, args });
        const child = makeFakeChild();
        children.push(child);
        return child;
      },
    });

    expect(controller.mode).toBe("off");
    expect(controller.isActive).toBe(false);

    // Enable remote AC standby while idle -> spawns -s -w <pid> (AC-only, preserves battery sleep)
    controller.setRemoteKeepAwakeOnAc(true);
    expect(controller.mode).toBe("remote_ac_standby");
    expect(controller.isActive).toBe(true);
    expect(spawns).toEqual([{ command: "/usr/bin/caffeinate", args: ["-s", "-w", "7777"] }]);

    // Idempotent repeat call does not respawn
    controller.setRemoteKeepAwakeOnAc(true);
    expect(spawns).toHaveLength(1);

    // Task starts (0 -> 1) -> switches from -s to -i -w <pid>
    controller.syncRunningCount(1);
    expect(controller.mode).toBe("active_tasks");
    expect(children[0]!.killCalls).toEqual(["SIGTERM"]);
    expect(spawns[1]).toEqual({
      command: "/usr/bin/caffeinate",
      args: ["-i", "-w", "7777"],
    });

    // Additional running task keeps -i without respawning
    controller.syncRunningCount(2);
    expect(spawns).toHaveLength(2);

    // Running count drops to 0 while AC keep-awake is still enabled -> returns to -s -w <pid>
    controller.syncRunningCount(0);
    expect(controller.mode).toBe("remote_ac_standby");
    expect(children[1]!.killCalls).toEqual(["SIGTERM"]);
    expect(spawns[2]).toEqual({
      command: "/usr/bin/caffeinate",
      args: ["-s", "-w", "7777"],
    });

    // Disable AC keep-awake -> terminates -s child
    controller.setRemoteKeepAwakeOnAc(false);
    expect(controller.mode).toBe("off");
    expect(controller.isActive).toBe(false);
    expect(children[2]!.killCalls).toEqual(["SIGTERM"]);

    // stop() terminates remote_ac_standby cleanly
    controller.setRemoteKeepAwakeOnAc(true);
    expect(controller.isActive).toBe(true);
    controller.stop();
    expect(controller.mode).toBe("off");
    expect(controller.isActive).toBe(false);
    expect(controller.remoteKeepAwakeOnAc).toBe(false);
    expect(children[3]!.killCalls).toEqual(["SIGTERM"]);

    // Verify PUT /api/settings/remote wires keep_awake_on_ac into KilndServer's caffeinate
    const { server } = createServer({ caffeinate: controller });
    const enableRes = await server.app.request(
      new Request("http://127.0.0.1:4310/api/settings/remote", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema_version: 1,
          enabled: true,
          remote_port: 4311,
          keep_awake_on_ac: true,
        }),
      }),
    );
    expect(enableRes.status).toBe(200);
    expect(controller.remoteKeepAwakeOnAc).toBe(true);
    expect(controller.mode).toBe("remote_ac_standby");

    // Disabling remote turns off standby keep-awake even if keep_awake_on_ac stays true
    const disableRes = await server.app.request(
      new Request("http://127.0.0.1:4310/api/settings/remote", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema_version: 1,
          enabled: false,
          remote_port: 4311,
          keep_awake_on_ac: true,
        }),
      }),
    );
    expect(disableRes.status).toBe(200);
    expect(controller.remoteKeepAwakeOnAc).toBe(false);
    expect(controller.mode).toBe("off");
  });

  it("filters P0/P1 decision.requested notifications (skipping P2/P3), signs webhook/bark/ntfy payloads, and never crashes on network error", async () => {
    const sentRequests: Array<{
      url: string;
      headers: Record<string, string>;
      body: string;
    }> = [];
    let nextResponseMode: "ok" | "http500" | "throw" = "ok";

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
      const body = typeof init?.body === "string" ? init.body : "";
      sentRequests.push({ url, headers: { ...rawHeaders }, body });

      if (nextResponseMode === "throw") {
        throw new Error("ECONNREFUSED");
      }
      if (nextResponseMode === "http500") {
        return new Response("upstream error", { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const { server } = createServer({ notifyFetchImpl: mockFetch });

    // 1. Webhook channel with default priorities ["P0", "P1"] and secret
    server.store.writeConfig("remote", {
      schema_version: 1,
      enabled: true,
      remote_port: 4311,
      public_url: "https://kiln.ts.net",
      keep_awake_on_ac: false,
      notifications: {
        enabled: true,
        channel: "webhook",
        url: "https://hooks.example.com/kiln",
        secret: "wh-secret-key",
        priorities: ["P0", "P1"],
      },
    });

    // P2 and P3 must be skipped
    const p2Res = await server.remoteNotifier.notifyDecisionRequested({
      taskId: "t-p2",
      priority: "P2",
      question: "Low priority question",
    });
    expect(p2Res.delivered).toBe(false);
    expect(p2Res.skipped).toBe("priority_filtered");

    const p3Res = await server.remoteNotifier.notifyDecisionRequested({
      taskId: "t-p3",
      priority: "P3",
      question: "Backlog question",
    });
    expect(p3Res.delivered).toBe(false);
    expect(p3Res.skipped).toBe("priority_filtered");
    expect(sentRequests).toHaveLength(0);

    // P0 triggers webhook with Bearer + HMAC-SHA256 signature
    const p0Res = await server.remoteNotifier.notifyDecisionRequested({
      taskId: "t-p0",
      priority: "P0",
      question: "Approve production rollback?",
    });
    expect(p0Res.delivered).toBe(true);
    expect(sentRequests).toHaveLength(1);
    const whReq = sentRequests[0]!;
    expect(whReq.url).toBe("https://hooks.example.com/kiln");
    expect(whReq.headers.Authorization).toBe("Bearer wh-secret-key");
    const expectedHmac =
      "sha256=" +
      crypto.createHmac("sha256", "wh-secret-key").update(whReq.body, "utf8").digest("hex");
    expect(whReq.headers["X-Kiln-Signature-256"]).toBe(expectedHmac);
    const whBody = JSON.parse(whReq.body) as {
      event: string;
      priority: string;
      taskId: string;
      url: string;
    };
    expect(whBody.event).toBe("decision.requested");
    expect(whBody.priority).toBe("P0");
    expect(whBody.url).toBe("https://kiln.ts.net/tasks/t-p0");

    // 2. Bark channel via SSE hub publish (P1 fires, P2 skips)
    server.store.writeConfig("remote", {
      schema_version: 1,
      enabled: true,
      remote_port: 4311,
      keep_awake_on_ac: false,
      notifications: {
        enabled: true,
        channel: "bark",
        url: "https://api.day.app/testkey",
        priorities: ["P0", "P1"],
      },
    });

    server.sseHub.publish({
      type: "decision.requested",
      taskId: "t-sse-p2",
      priority: "P2",
      question: "Should be ignored",
    });
    server.sseHub.publish({
      type: "decision.requested",
      taskId: "t-sse-p1",
      priority: "P1",
      question: "Review required",
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(sentRequests).toHaveLength(2);
    const barkBody = JSON.parse(sentRequests[1]!.body) as {
      level: string;
      group: string;
      body: string;
    };
    expect(barkBody.level).toBe("timeSensitive");
    expect(barkBody.group).toBe("Kiln");
    expect(barkBody.body).toBe("Review required");

    // 3. ntfy channel uses ASCII-safe Title header and UTF-8 body
    const ntfyTestRes = await server.app.request(
      new Request("http://127.0.0.1:4310/api/remote/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: "ntfy",
          url: "https://ntfy.sh/kiln-alerts",
          secret: "ntfy-token",
          title: "中文标题测试",
          body: "需要人工确认",
        }),
      }),
    );
    expect(ntfyTestRes.status).toBe(200);
    expect(sentRequests).toHaveLength(3);
    const ntfyReq = sentRequests[2]!;
    expect(ntfyReq.headers.Title).toMatch(/^[\x20-\x7e]+$/);
    expect(ntfyReq.headers.Authorization).toBe("Bearer ntfy-token");
    expect(ntfyReq.body).toContain("中文标题测试");
    expect(ntfyReq.body).toContain("需要人工确认");

    // 4. Network error never crashes daemon or throws from notifyDecisionRequested
    nextResponseMode = "throw";
    const failRes = await server.remoteNotifier.notifyDecisionRequested({
      taskId: "t-fail",
      priority: "P0",
      question: "Network down",
    });
    expect(failRes.delivered).toBe(false);
    expect(failRes.error).toContain("ECONNREFUSED");

    // POST /api/remote/notifications/test returns 502 on upstream failure
    nextResponseMode = "http500";
    const testFailRes = await server.app.request(
      new Request("http://127.0.0.1:4310/api/remote/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(testFailRes.status).toBe(502);

    // 5. Slow endpoint aborts within configured timeout without hanging or throwing
    const { server: slowServer } = createServer({
      notifyTimeoutMs: 100,
      notifyFetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const abortErr = new Error("Aborted");
            abortErr.name = "AbortError";
            reject(abortErr);
          });
        }),
    });
    slowServer.store.writeConfig("remote", {
      schema_version: 1,
      enabled: true,
      remote_port: 4311,
      keep_awake_on_ac: false,
      notifications: {
        enabled: true,
        channel: "webhook",
        url: "https://slow.example.com/hook",
        priorities: ["P0", "P1"],
      },
    });
    const timeoutRes = await slowServer.remoteNotifier.notifyDecisionRequested({
      taskId: "t-timeout",
      priority: "P0",
      question: "Slow hook test",
    });
    expect(timeoutRes.delivered).toBe(false);
    expect(timeoutRes.error).toContain("timed out");

    // 6. PUT /api/settings/remote rejects remote_port colliding with custom local port
    const { server: customPortServer } = createServer({ port: 5123 });
    const conflictRes = await customPortServer.app.request(
      new Request("http://127.0.0.1:5123/api/settings/remote", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema_version: 1,
          enabled: true,
          remote_port: 5123,
        }),
      }),
    );
    expect(conflictRes.status).toBe(400);
    expect(((await conflictRes.json()) as { error: string }).error).toBe("remote_port_conflict");
  });

  it("inspects Tailscale status read-only with graceful fallback when absent", async () => {
    // 1. Installed + running + serve configured on 4311
    const okExec: TailscaleExecFileFn = async (_file, args) => {
      if (args[0] === "status") {
        return {
          stdout: JSON.stringify({
            BackendState: "Running",
            Self: { DNSName: "my-mac.tail42.ts.net." },
          }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify({
          Web: {
            "my-mac.tail42.ts.net:443": {
              Handlers: {
                "/": { Proxy: "http://127.0.0.1:4311" },
              },
            },
          },
        }),
        stderr: "",
      };
    };

    const active = await inspectTailscaleStatus({
      remotePort: 4311,
      execFileImpl: okExec,
    });
    expect(active.installed).toBe(true);
    expect(active.running).toBe(true);
    expect(active.dnsName).toBe("my-mac.tail42.ts.net");
    expect(active.magicDnsUrl).toBe("https://my-mac.tail42.ts.net");
    expect(active.serveActive).toBe(true);
    expect(active.serveConfiguredForPort).toBe(true);
    expect(active.recommendedCommand).toBe("tailscale serve --bg http://127.0.0.1:4311");

    // 2. Not installed (ENOENT) -> graceful fallback
    const missingExec: TailscaleExecFileFn = async () => {
      const err = new Error("spawn tailscale ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    const absent = await inspectTailscaleStatus({
      remotePort: 4411,
      execFileImpl: missingExec,
      platform: "linux",
    });
    expect(absent.installed).toBe(false);
    expect(absent.running).toBe(false);
    expect(absent.serveConfiguredForPort).toBe(false);
    expect(absent.recommendedCommand).toBe("tailscale serve --bg http://127.0.0.1:4411");

    // 3. Exposed via local GET /api/remote/tailscale
    const { server } = createServer({ tailscaleExecFile: okExec });
    const tsRes = await server.app.request(
      new Request("http://127.0.0.1:4310/api/remote/tailscale"),
    );
    expect(tsRes.status).toBe(200);
    const tsBody = (await tsRes.json()) as {
      installed: boolean;
      recommendedCommand: string;
    };
    expect(tsBody.installed).toBe(true);
    expect(tsBody.recommendedCommand).toBe("tailscale serve --bg http://127.0.0.1:4311");
  });

  it("blocks /api/spaces/pick-directory with 403 local_only_endpoint on :4311 while keeping /api/spaces/discover auth-gated", async () => {
    const { server } = createServer({
      discoverSpaces: async () => ({
        ok: true,
        repos: [],
        scanned_roots: [],
        truncated: false,
      }),
      pickDirectory: async () => ({
        ok: true,
        cancelled: false,
        path: "/tmp/should-never-run",
      }),
    });

    await server.app.request(
      new Request("http://127.0.0.1:4310/api/settings/remote", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema_version: 1,
          enabled: true,
          remote_port: 4311,
          public_url: "https://mac.tail99.ts.net",
        }),
      }),
    );

    // Unauthenticated /api/spaces/discover on :4311 -> 401
    const unauthDiscover = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/spaces/discover"),
    );
    expect(unauthDiscover.status).toBe(401);

    // Unauthenticated OR authenticated /api/spaces/pick-directory on :4311 -> 403 local_only_endpoint
    const unauthPick = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/spaces/pick-directory", {
        method: "POST",
      }),
    );
    expect(unauthPick.status).toBe(403);
    expect(((await unauthPick.json()) as { error: string }).error).toBe("local_only_endpoint");

    // Pair a remote device and verify authenticated /api/spaces/discover -> 200 while pick-directory -> 403
    const chRes = await server.app.request(
      new Request("http://127.0.0.1:4310/api/remote/pair", { method: "POST" }),
    );
    const ch = (await chRes.json()) as { token: string };
    const pairRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/auth/pair", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://mac.tail99.ts.net",
          "User-Agent": "MobileTest",
        },
        body: JSON.stringify({ token: ch.token, label: "Phone" }),
      }),
    );
    expect(pairRes.status).toBe(200);
    const cookie = pairRes.headers.get("set-cookie")!.split(";")[0]!;

    const authDiscover = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/spaces/discover", {
        headers: { Cookie: cookie, "User-Agent": "MobileTest" },
      }),
    );
    expect(authDiscover.status).toBe(200);

    const authPick = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/spaces/pick-directory", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://mac.tail99.ts.net",
          "User-Agent": "MobileTest",
        },
      }),
    );
    expect(authPick.status).toBe(403);
    expect(((await authPick.json()) as { error: string }).error).toBe("local_only_endpoint");
  });
});
