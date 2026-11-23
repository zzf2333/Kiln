// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BootstrapResponse,
  PublicPairedDevice,
  RemoteConfig,
  TailscaleStatusResponse,
} from "../api/types";
import { App } from "../app";
import { buildQrSvgGeometry, encodeQrMatrix, type QrMatrix } from "../lib/qr";

type MockFetchHandler = (
  url: string,
  init?: RequestInit,
) => Promise<Response> | Response;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeBaseBootstrap(
  overrides: Partial<BootstrapResponse> = {},
): BootstrapResponse {
  const now = new Date().toISOString();
  return {
    tasks: [
      {
        id: "t-remote-1",
        space: "kiln",
        parent_id: null,
        title: "远程看板测试任务",
        priority: "P1",
        effective_priority: "P1",
        track: "L2",
        workspace_mode: "git_worktree",
        status: "paused",
        stage: "implement",
        round: 1,
        active_run_id: null,
        contract_version: 1,
        depends_on: [],
        created_at: now,
        updated_at: now,
        tokens: {
          input_tokens: 1000,
          cached_input_tokens: 0,
          output_tokens: 200,
          total_tokens: 1200,
        },
        cost_usd: 0.01,
      },
    ],
    pendingDecisions: [],
    drafts: [],
    spaces: {
      kiln: {
        schema_version: 1,
        id: "kiln",
        name: "Kiln 本体",
        repo_path: "/repos/kiln",
        default_branch: "main",
        copy_untracked: [],
        clone_deps: [],
        freeze_patterns: [],
      },
      local: {
        schema_version: 1,
        id: "local",
        name: "本机与临时",
        default_branch: "main",
        copy_untracked: [],
        clone_deps: [],
        freeze_patterns: [],
      },
    },
    roles: {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {},
    },
    limits: {
      schema_version: 1,
      max_concurrent_slots: 5,
      p0_extra_slot: true,
      max_waiting_wip: 5,
      retries_per_stage: 2,
      review_rounds: 2,
      advisor_calls: 1,
      max_card_tokens: 250_000,
    },
    pricing: {
      schema_version: 1,
      models: {},
    },
    usage: {
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 200,
      totalTokens: 1200,
      costUsd: 0.01,
      byAgent: {},
      byModel: {},
    },
    runningCount: 0,
    agents: [],
    backends: [],
    ...overrides,
  };
}

class MockEventSource {
  static instances: MockEventSource[] = [];
  private listeners = new Map<string, Set<(e: Event) => void>>();
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (e: Event) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: (e: Event) => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  triggerOpen(): void {
    this.onopen?.(new Event("open"));
  }

  triggerError(): void {
    this.onerror?.(new Event("error"));
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
}

// Helper: independent ISO/IEC 18004 verification & byte-mode round-trip decoder for QR tests
function decodeBytePayloadFromQr(matrix: QrMatrix): {
  format1: number;
  format2: number;
  decodedText: string;
  syndromeErrors: number;
} {
  const { version, size, modules } = matrix;
  const get = (x: number, y: number): number => modules[y * size + x]!;

  // Read Format Info Copy 1
  let fmt1 = 0;
  for (let i = 0; i <= 5; i++) fmt1 |= get(8, i) << i;
  fmt1 |= get(8, 7) << 6;
  fmt1 |= get(8, 8) << 7;
  fmt1 |= get(7, 8) << 8;
  for (let i = 9; i < 15; i++) fmt1 |= get(14 - i, 8) << i;

  // Read Format Info Copy 2
  let fmt2 = 0;
  for (let i = 0; i < 8; i++) fmt2 |= get(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) fmt2 |= get(8, size - 15 + i) << i;

  const unmaskedFmt = fmt1 ^ 0x5412;
  const mask = (unmaskedFmt >>> 10) & 0b111;

  // Rebuild function mask
  const isFn = new Uint8Array(size * size);
  const markFn = (x: number, y: number) => {
    if (x >= 0 && x < size && y >= 0 && y < size) isFn[y * size + x] = 1;
  };
  for (let i = 0; i < size; i++) {
    markFn(6, i);
    markFn(i, 6);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) markFn(cx + dx, cy + dy);
    }
  }
  const alignTable: readonly (readonly number[])[] = [
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
    [6, 30, 54],
    [6, 32, 58],
  ];
  const centers = alignTable[version - 1]!;
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === centers.length - 1) ||
        (i === centers.length - 1 && j === 0)
      ) {
        continue;
      }
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) markFn(centers[i]! + dx, centers[j]! + dy);
      }
    }
  }
  for (let i = 0; i <= 8; i++) {
    markFn(8, i);
    markFn(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    markFn(size - 1 - i, 8);
    markFn(8, size - 1 - i);
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      markFn(a, b);
      markFn(b, a);
    }
  }

  const maskFn = (m: number, x: number, y: number): boolean => {
    switch (m) {
      case 0:
        return (x + y) % 2 === 0;
      case 1:
        return y % 2 === 0;
      case 2:
        return x % 3 === 0;
      case 3:
        return (x + y) % 3 === 0;
      case 4:
        return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5:
        return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6:
        return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default:
        return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  };

  // Extract raw bits in zigzag order
  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (let colOff = 0; colOff < 2; colOff++) {
        const x = right - colOff;
        if (isFn[y * size + x] === 1) continue;
        const bit = get(x, y) ^ (maskFn(mask, x, y) ? 1 : 0);
        bits.push(bit);
      }
    }
    upward = !upward;
  }

  const totalCodewords = Math.floor(bits.length / 8);
  const codewords = new Uint8Array(totalCodewords);
  for (let i = 0; i < totalCodewords; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j]!;
    codewords[i] = b;
  }

  // De-interleave ECC-M blocks
  const eccTable: ReadonlyArray<readonly [number, number, number]> = [
    [10, 1, 16],
    [16, 1, 28],
    [26, 1, 44],
    [18, 2, 64],
    [24, 2, 86],
    [16, 4, 108],
    [18, 4, 124],
    [22, 4, 154],
    [22, 5, 182],
    [26, 5, 216],
    [30, 5, 254],
    [22, 8, 290],
  ];
  const [ecPerBlock, numBlocks, totalDataCw] = eccTable[version - 1]!;
  const numShort = numBlocks - (totalCodewords % numBlocks);
  const shortBlockLen = Math.floor(totalCodewords / numBlocks);
  const shortDataLen = shortBlockLen - ecPerBlock;
  const maxDataLen = numShort === numBlocks ? shortDataLen : shortDataLen + 1;

  const dataBlocks: number[][] = Array.from({ length: numBlocks }, () => []);
  const eccBlocks: number[][] = Array.from({ length: numBlocks }, () => []);

  let cwIdx = 0;
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      const targetLen = b < numShort ? shortDataLen : shortDataLen + 1;
      if (i < targetLen) dataBlocks[b]!.push(codewords[cwIdx++]!);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < numBlocks; b++) {
      eccBlocks[b]!.push(codewords[cwIdx++]!);
    }
  }

  // Verify Reed-Solomon syndromes in GF(256) at roots alpha^0 .. alpha^(ecPerBlock-1)
  const gfMul = (a: number, b: number): number => {
    let x = a;
    let y = b;
    let r = 0;
    for (let i = 0; i < 8; i++) {
      if (y & 1) r ^= x;
      const hi = x & 0x80;
      x = (x << 1) & 0xff;
      if (hi) x ^= 0x1d;
      y >>>= 1;
    }
    return r;
  };
  let syndromeErrors = 0;
  for (let b = 0; b < numBlocks; b++) {
    const fullBlock = [...dataBlocks[b]!, ...eccBlocks[b]!];
    let root = 1;
    for (let s = 0; s < ecPerBlock; s++) {
      let acc = 0;
      for (const byte of fullBlock) {
        acc = gfMul(acc, root) ^ byte;
      }
      if (acc !== 0) syndromeErrors += 1;
      root = gfMul(root, 2);
    }
  }

  // Reassemble data stream & parse Byte mode header
  const flatData = new Uint8Array(totalDataCw);
  let pos = 0;
  for (const blk of dataBlocks) {
    for (const byte of blk) flatData[pos++] = byte;
  }
  const dataBits: number[] = [];
  for (const byte of flatData) {
    for (let k = 7; k >= 0; k--) dataBits.push((byte >>> k) & 1);
  }
  const readBits = (offset: number, len: number): number => {
    let v = 0;
    for (let i = 0; i < len; i++) v = (v << 1) | dataBits[offset + i]!;
    return v;
  };
  const mode = readBits(0, 4);
  expect(mode).toBe(0b0100);
  const countBits = version >= 10 ? 16 : 8;
  const byteLen = readBits(4, countBits);
  const outBytes = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i++) {
    outBytes[i] = readBits(4 + countBits + i * 8, 8);
  }

  return {
    format1: fmt1,
    format2: fmt2,
    decodedText: new TextDecoder().decode(outBytes),
    syndromeErrors,
  };
}

let fetchMock: ReturnType<typeof vi.fn<MockFetchHandler>>;

beforeEach(() => {
  MockEventSource.instances = [];
  window.location.hash = "";
  window.history.replaceState(null, "", "/");
  document.body.className = "";
  (window as unknown as { EventSource?: unknown }).EventSource = MockEventSource;
  fetchMock = vi.fn<MockFetchHandler>(async () =>
    jsonResponse(makeBaseBootstrap()),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("@kiln/web Slice 4: QR Generator, PWA, Remote Auth Gate, Offline Banner & Remote Settings", () => {
  it("generates ISO/IEC 18004 valid QR matrices & SVG paths with 0 RS syndrome errors across short, Tailscale URL, and 200-char v10+ payloads", () => {
    const payloads = [
      "kiln",
      "https://my-mac.tail12345.ts.net/#pair=abcDEF0123456789-_XYZ9876543210abcdef",
      `https://kiln-remote.example.com/workbench/#pair=${"aB3dE6gH9jK2mN5pQ8rS".repeat(8)}`,
    ];

    for (const payload of payloads) {
      const matrix = encodeQrMatrix(payload);
      expect(matrix.size).toBe(matrix.version * 4 + 17);
      expect(matrix.modules).toHaveLength(matrix.size * matrix.size);

      // Verify finder patterns (7x7 corners) & fixed dark module (8, size - 8)
      expect(matrix.modules[0]).toBe(1);
      expect(matrix.modules[3 * matrix.size + 3]).toBe(1);
      expect(matrix.modules[3 * matrix.size + (matrix.size - 4)]).toBe(1);
      expect(matrix.modules[(matrix.size - 4) * matrix.size + 3]).toBe(1);
      expect(matrix.modules[(matrix.size - 8) * matrix.size + 8]).toBe(1);

      // Verify timing pattern alternating along row 6
      for (let x = 8; x < matrix.size - 8; x++) {
        expect(matrix.modules[6 * matrix.size + x]).toBe(x % 2 === 0 ? 1 : 0);
      }

      // Independent round-trip decode + Reed-Solomon syndrome verification
      const decoded = decodeBytePayloadFromQr(matrix);
      expect(decoded.format1).toBe(decoded.format2);
      expect(decoded.syndromeErrors).toBe(0);
      expect(decoded.decodedText).toBe(payload);

      // Verify SVG path geometry has valid quiet zone & zero external URLs
      const geom = buildQrSvgGeometry(payload, 4);
      expect(geom.viewBoxSize).toBe(matrix.size + 8);
      expect(geom.pathData.length).toBeGreaterThan(20);
      expect(geom.pathData).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
    }

    // Confirm long ~200-char URL exercises Version >= 10 (16-bit byte length indicator)
    expect(encodeQrMatrix(payloads[2]!).version).toBeGreaterThanOrEqual(10);
  });

  it("ships valid local PWA manifest.webmanifest and apple-mobile-web-app index.html metadata", () => {
    // @ts-expect-error Vite compile-time glob macro
    const manifestGlob = import.meta.glob("../../public/manifest.webmanifest", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    // @ts-expect-error Vite compile-time glob macro
    const indexGlob = import.meta.glob("../../index.html", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;

    const manifest = JSON.parse(Object.values(manifestGlob)[0]!) as {
      name: string;
      short_name: string;
      display: string;
      start_url: string;
      background_color: string;
      theme_color: string;
      icons: Array<{ src: string; type: string }>;
    };
    expect(manifest.name).toBe("Kiln");
    expect(manifest.short_name).toBe("Kiln");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.background_color).toBe("#121110");
    expect(manifest.theme_color).toBe("#121110");
    expect(manifest.icons.some((i) => i.src === "/favicon.svg")).toBe(true);
    expect(manifest.icons.some((i) => i.src === "/icon-192.png")).toBe(true);
    expect(manifest.icons.every((i) => i.src.startsWith("/"))).toBe(true);

    const html = Object.values(indexGlob)[0]!;
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain(
      '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
    );
  });

  it("extracts #pair=<token>, immediately strips hash via history.replaceState, pairs into workbench with credentials + X-Kiln-Client: web, and logs out cleanly", async () => {
    const now = new Date().toISOString();
    let authenticated = false;
    const pairedDevice: PublicPairedDevice = {
      id: "dev-iphone-1",
      label: "我的主力 iPhone",
      created_at: now,
      last_seen_at: now,
    };

    const recordedCalls: Array<{
      url: string;
      method: string;
      credentials?: RequestCredentials;
      headers?: Record<string, string>;
      body?: Record<string, unknown>;
    }> = [];

    fetchMock.mockImplementation(async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      recordedCalls.push({
        url,
        method,
        ...(init?.credentials ? { credentials: init.credentials } : {}),
        ...(init?.headers ? { headers: init.headers as Record<string, string> } : {}),
        ...(body ? { body } : {}),
      });

      if (url === "/api/auth/status") {
        return jsonResponse({
          ok: true,
          mode: "remote",
          authenticated,
          device: authenticated ? pairedDevice : null,
        });
      }
      if (url === "/api/auth/pair" && method === "POST") {
        authenticated = true;
        return jsonResponse({
          ok: true,
          device: {
            ...pairedDevice,
            label: String(body?.label ?? pairedDevice.label),
          },
        });
      }
      if (url === "/api/auth/logout" && method === "POST") {
        authenticated = false;
        return jsonResponse({
          ok: true,
          loggedOut: true,
          revokedDeviceId: pairedDevice.id,
        });
      }
      if (url === "/api/bootstrap") {
        return jsonResponse(makeBaseBootstrap());
      }
      return jsonResponse({ ok: true });
    });

    window.location.hash = "#pair=one-time-secret-token-999";
    render(<App />);

    // Hash must be immediately stripped on mount so token never remains in browser history
    expect(window.location.hash).toBe("");

    await waitFor(() => {
      expect(screen.getByText("已读取一次性扫码配对凭证")).toBeTruthy();
    });

    // Unauthenticated remote gate must NOT fetch /api/bootstrap or connect SSE
    expect(recordedCalls.some((c) => c.url === "/api/bootstrap")).toBe(false);
    expect(MockEventSource.instances).toHaveLength(0);

    // Edit device label and one-tap pair
    const labelInput = screen.getByLabelText("设备名称") as HTMLInputElement;
    fireEvent.change(labelInput, { target: { value: "我的主力 iPhone" } });
    fireEvent.click(screen.getByRole("button", { name: "一键完成配对" }));

    // Transitions cleanly into full workbench + remote indicator bar + SSE
    await waitFor(() => {
      expect(screen.getByText("远程看板测试任务")).toBeTruthy();
    });
    expect(screen.getByText("远程 · 我的主力 iPhone")).toBeTruthy();
    expect(MockEventSource.instances).toHaveLength(1);

    // Verify credentials: "same-origin" and X-Kiln-Client: web on POST /api/auth/pair
    const pairCall = recordedCalls.find((c) => c.url === "/api/auth/pair")!;
    expect(pairCall.credentials).toBe("same-origin");
    expect(pairCall.headers?.["X-Kiln-Client"]).toBe("web");
    expect(pairCall.body).toEqual({
      token: "one-time-secret-token-999",
      label: "我的主力 iPhone",
    });

    const bootstrapCall = recordedCalls.find((c) => c.url === "/api/bootstrap")!;
    expect(bootstrapCall.credentials).toBe("same-origin");

    // Logout action revokes session, closes SSE, and returns to RemoteAuthView
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => {
      expect(screen.getByLabelText("6 位配对码")).toBeTruthy();
    });
    expect(MockEventSource.instances[0]!.closed).toBe(true);
    const logoutCall = recordedCalls.find((c) => c.url === "/api/auth/logout")!;
    expect(logoutCall.credentials).toBe("same-origin");
    expect(logoutCall.headers?.["X-Kiln-Client"]).toBe("web");
  });

  it("handles manual 6-digit pairing errors (with attemptsRemaining) and mid-session 401 revocation kickout", async () => {
    const now = new Date().toISOString();
    let authenticated = false;
    let revokedOnServer = false;
    const dev: PublicPairedDevice = {
      id: "dev-pad-2",
      label: "工作 iPad",
      created_at: now,
      last_seen_at: now,
    };

    fetchMock.mockImplementation(async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/status") {
        return jsonResponse({
          ok: true,
          mode: "remote",
          authenticated: authenticated && !revokedOnServer,
          device: authenticated && !revokedOnServer ? dev : null,
        });
      }
      if (url === "/api/auth/pair" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { code?: string };
        if (body.code !== "482910") {
          return jsonResponse(
            {
              error: "invalid_pairing_credentials",
              attemptsRemaining: 4,
              message: "Invalid pairing token or code",
            },
            401,
          );
        }
        authenticated = true;
        return jsonResponse({ ok: true, device: dev });
      }
      if (url === "/api/bootstrap") {
        if (revokedOnServer) {
          return jsonResponse({ error: "unauthorized", message: "Revoked" }, 401);
        }
        return jsonResponse(makeBaseBootstrap());
      }
      if (url === "/api/tasks/t-remote-1/resume" && method === "POST") {
        revokedOnServer = true;
        return jsonResponse(
          { error: "unauthorized", message: "Device revoked" },
          401,
        );
      }
      return jsonResponse({ ok: true });
    });

    render(<App />);
    const codeInput = (await screen.findByLabelText("6 位配对码")) as HTMLInputElement;

    // 1. Wrong code shows clear error + remaining attempts
    fireEvent.change(codeInput, { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "配对并进入工作台" }));
    await waitFor(() => {
      expect(screen.getByText(/剩余 4 次尝试/)).toBeTruthy();
    });

    // 2. Correct code (with spaces) succeeds
    fireEvent.change(codeInput, { target: { value: "482 910" } });
    fireEvent.click(screen.getByRole("button", { name: "配对并进入工作台" }));
    await waitFor(() => {
      expect(screen.getByText("远程看板测试任务")).toBeTruthy();
    });
    expect(MockEventSource.instances).toHaveLength(1);

    // 3. Mid-session API call returns 401 -> immediately disconnects SSE & kicks back to RemoteAuthView
    fireEvent.click(screen.getByRole("button", { name: "继续推进" }));
    await waitFor(() => {
      expect(screen.getByText(/会话已失效或已被桌面端吊销/)).toBeTruthy();
    });
    expect(MockEventSource.instances[0]!.closed).toBe(true);
    expect(screen.queryByText("远程看板测试任务")).toBeNull();
  });

  it("kicks passive remote client back to RemoteAuthView when desktop revokes device and closes SSE stream", async () => {
    const now = new Date().toISOString();
    let revoked = false;
    const dev: PublicPairedDevice = {
      id: "dev-passive",
      label: "被动在线手机",
      created_at: now,
      last_seen_at: now,
    };

    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/auth/status") {
        return jsonResponse({
          ok: true,
          mode: "remote",
          authenticated: !revoked,
          device: revoked ? null : dev,
        });
      }
      if (url === "/api/bootstrap") return jsonResponse(makeBaseBootstrap());
      return jsonResponse({ ok: true });
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("远程 · 被动在线手机")).toBeTruthy();
    });

    const sse = MockEventSource.instances[0]!;
    sse.triggerOpen();

    // Desktop revokes device -> server closes SSE -> EventSource fires onerror -> client probes /api/auth/status
    revoked = true;
    sse.triggerError();

    await waitFor(() => {
      expect(screen.getByText(/会话已失效或已被桌面端吊销/)).toBeTruthy();
    });
    expect(sse.closed).toBe(true);
    expect(screen.queryByText("远程看板测试任务")).toBeNull();
  });

  it("blocks remote-admin endpoints and displays read-only isolation notice in Settings 远程访问 when authMode is remote", async () => {
    const now = new Date().toISOString();
    const calls: string[] = [];

    fetchMock.mockImplementation(async (url) => {
      calls.push(url);
      if (url === "/api/auth/status") {
        return jsonResponse({
          ok: true,
          mode: "remote",
          authenticated: true,
          device: {
            id: "dev-phone",
            label: "随身手机",
            created_at: now,
            last_seen_at: now,
          },
        });
      }
      if (url === "/api/bootstrap") return jsonResponse(makeBaseBootstrap());
      return jsonResponse({ ok: true });
    });

    window.location.hash = "#view=settings&tab=remote";
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("仅限本机桌面端管理远程访问")).toBeTruthy();
    });
    expect(screen.getByText(/127\.0\.0\.1:4310/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "生成配对二维码" })).toBeNull();
    expect(screen.queryByRole("button", { name: "保存远程设置" })).toBeNull();

    // Must never hit local-only admin APIs from remote mode
    expect(calls.some((u) => u.startsWith("/api/settings/remote"))).toBe(false);
    expect(calls.some((u) => u.startsWith("/api/remote/"))).toBe(false);
  });

  it("displays non-blocking Host Offline Banner on SSE disconnect and clears on reconnect retry", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/auth/status") {
        return jsonResponse({
          ok: true,
          mode: "local",
          authenticated: true,
          device: null,
        });
      }
      if (url === "/api/bootstrap") return jsonResponse(makeBaseBootstrap());
      return jsonResponse({ ok: true });
    });

    const { container } = render(<App />);
    await waitFor(() => {
      expect(screen.getByText("远程看板测试任务")).toBeTruthy();
    });

    // Initially no offline banner
    expect(container.querySelector("[data-offline-banner]")).toBeNull();

    // SSE opens then drops -> shows non-blocking banner while keeping board readable
    const sse1 = MockEventSource.instances[0]!;
    sse1.triggerOpen();
    sse1.triggerError();

    await waitFor(() => {
      const banner = container.querySelector("[data-offline-banner]");
      expect(banner).toBeTruthy();
      expect(banner?.textContent).toContain("主机离线或连接已断开");
      expect(banner?.textContent).toContain("正在自动重连");
    });
    expect(screen.getByText("远程看板测试任务")).toBeTruthy();

    // Clicking 立即重试 reconnects SSE and reloads bootstrap; banner disappears on open
    fireEvent.click(screen.getByRole("button", { name: "立即重试" }));
    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2);
    });
    const sse2 = MockEventSource.instances.at(-1)!;
    sse2.triggerOpen();
    await waitFor(() => {
      expect(container.querySelector("[data-offline-banner]")).toBeNull();
    });
  });

  it("Local Settings 远程访问 panel supports Tailscale fill, saving config + keep_awake_on_ac + notifications, local QR SVG pairing, test push, and device revocation", async () => {
    const now = new Date().toISOString();
    let remoteState: RemoteConfig = {
      schema_version: 1,
      enabled: false,
      remote_port: 4311,
      keep_awake_on_ac: false,
      notifications: {
        enabled: false,
        channel: "webhook",
        url: "",
        priorities: ["P0", "P1"],
      },
    };
    let runtimeState = {
      listening: false,
      port: null as number | null,
      baseUrl: null as string | null,
    };
    let devicesState: PublicPairedDevice[] = [
      {
        id: "dev-a1",
        label: "iPhone 16 Pro",
        created_at: now,
        last_seen_at: now,
      },
      {
        id: "dev-b2",
        label: "iPad mini",
        created_at: now,
        last_seen_at: now,
      },
    ];
    const tailscaleState: TailscaleStatusResponse = {
      ok: true,
      installed: true,
      running: true,
      backendState: "Running",
      dnsName: "my-mac.tail12345.ts.net",
      magicDnsUrl: "https://my-mac.tail12345.ts.net",
      serveActive: true,
      serveConfiguredForPort: true,
      serveTargets: ["http://127.0.0.1:4311"],
      remotePort: 4311,
      recommendedCommand: "tailscale serve --bg http://127.0.0.1:4311",
    };

    const recordedMutations: Array<{
      url: string;
      method: string;
      clientHeader?: string;
      body?: Record<string, unknown>;
    }> = [];

    const writeTextMock = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
    });

    fetchMock.mockImplementation(async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      if (method !== "GET") {
        recordedMutations.push({
          url,
          method,
          clientHeader: (init?.headers as Record<string, string> | undefined)?.[
            "X-Kiln-Client"
          ],
          ...(body ? { body } : {}),
        });
      }

      if (url === "/api/auth/status") {
        return jsonResponse({
          ok: true,
          mode: "local",
          authenticated: true,
          device: null,
        });
      }
      if (url === "/api/bootstrap") return jsonResponse(makeBaseBootstrap());
      if (url === "/api/settings/remote" && method === "GET") {
        return jsonResponse({
          ok: true,
          remote: remoteState,
          runtime: runtimeState,
          activeDeviceCount: devicesState.filter((d) => !d.revoked_at).length,
        });
      }
      if (url === "/api/settings/remote" && method === "PUT") {
        remoteState = body as unknown as RemoteConfig;
        runtimeState = remoteState.enabled
          ? {
              listening: true,
              port: remoteState.remote_port,
              baseUrl: `http://127.0.0.1:${remoteState.remote_port}`,
            }
          : { listening: false, port: null, baseUrl: null };
        return jsonResponse({
          ok: true,
          section: "remote",
          data: remoteState,
          runtime: runtimeState,
        });
      }
      if (url === "/api/remote/tailscale") {
        return jsonResponse(tailscaleState);
      }
      if (url === "/api/remote/devices" && method === "GET") {
        return jsonResponse({ ok: true, devices: devicesState });
      }
      if (url === "/api/remote/pair" && method === "POST") {
        const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
        return jsonResponse(
          {
            ok: true,
            challengeId: "pair-chal-1",
            code: "482910",
            token: "tok-qr-local-svg-test-0123456789abcdef",
            expiresAt,
            pairUrl: `${remoteState.public_url ?? "https://my-mac.tail12345.ts.net"}/#pair=tok-qr-local-svg-test-0123456789abcdef`,
          },
          201,
        );
      }
      if (url === "/api/remote/notifications/test" && method === "POST") {
        return jsonResponse({
          ok: true,
          delivered: true,
          channel: body?.channel ?? "bark",
          status: 200,
        });
      }
      if (url === "/api/remote/devices/dev-a1" && method === "DELETE") {
        devicesState = devicesState.map((d) =>
          d.id === "dev-a1" ? { ...d, revoked_at: now } : d,
        );
        return jsonResponse({
          ok: true,
          revoked: true,
          device: devicesState[0],
          closedStreams: 1,
        });
      }
      if (url === "/api/remote/devices/revoke-all" && method === "POST") {
        devicesState = devicesState.map((d) =>
          d.revoked_at ? d : { ...d, revoked_at: now },
        );
        return jsonResponse({
          ok: true,
          revokedCount: 1,
          closedStreams: 1,
        });
      }
      return jsonResponse({ ok: true });
    });

    window.location.hash = "#view=settings&tab=remote";
    const { container } = render(<App />);

    // 1. Wait for panel to load with runtime badge & Tailscale probe
    await waitFor(() => {
      expect(screen.getByText("Serve 已转发 :4311")).toBeTruthy();
    });
    expect(container.querySelector('[data-remote-runtime="stopped"]')).toBeTruthy();
    expect(screen.getByText(/仅插电时生效/)).toBeTruthy();
    expect(screen.getByText(/笔记本合盖默认仍会休眠/)).toBeTruthy();

    // 2. Copy Tailscale command & one-click fill MagicDNS HTTPS URL
    fireEvent.click(screen.getByRole("button", { name: "复制命令" }));
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(
        "tailscale serve --bg http://127.0.0.1:4311",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "填入公网地址" }));
    expect((screen.getByLabelText("公网 HTTPS 地址") as HTMLInputElement).value).toBe(
      "https://my-mac.tail12345.ts.net",
    );

    // 3. Enable remote listener, AC keep-awake, Bark notifications (P0/P1 checked by default)
    expect((screen.getByLabelText("推送优先级 P0") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("推送优先级 P1") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("推送优先级 P2") as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByLabelText("启用远程访问"));
    fireEvent.click(screen.getByLabelText("远程待命防休眠（仅插电时生效）"));
    fireEvent.click(screen.getByLabelText("启用待决推送通知"));
    fireEvent.change(screen.getByLabelText("推送通道"), {
      target: { value: "bark" },
    });
    fireEvent.change(screen.getByLabelText("推送地址"), {
      target: { value: "https://api.day.app/demoKey" },
    });
    fireEvent.change(screen.getByLabelText("推送密钥"), {
      target: { value: "my-secret" },
    });

    fireEvent.click(screen.getAllByRole("button", { name: "保存远程设置" })[0]!);
    await waitFor(() => {
      expect(screen.getByText("已监听 :4311")).toBeTruthy();
    });

    const putCall = recordedMutations.find(
      (m) => m.url === "/api/settings/remote" && m.method === "PUT",
    )!;
    expect(putCall.clientHeader).toBe("web");
    expect(putCall.body).toEqual({
      schema_version: 1,
      enabled: true,
      remote_port: 4311,
      public_url: "https://my-mac.tail12345.ts.net",
      keep_awake_on_ac: true,
      notifications: {
        enabled: true,
        channel: "bark",
        url: "https://api.day.app/demoKey",
        secret: "my-secret",
        priorities: ["P0", "P1"],
      },
    });

    // 4. Test push notification
    fireEvent.click(screen.getByRole("button", { name: "发送测试推送" }));
    await waitFor(() => {
      const panel = container.querySelector(".remote-panel") as HTMLElement;
      expect(within(panel).getByText(/测试推送已送达（bark · HTTP 200）/)).toBeTruthy();
    });

    // 5. Generate local QR SVG + 6-char code + countdown (zero <img> or external requests!)
    fireEvent.click(screen.getByRole("button", { name: "生成配对二维码" }));
    await waitFor(() => {
      expect(container.querySelector("svg.qr-svg")).toBeTruthy();
    });
    expect(container.querySelectorAll("img")).toHaveLength(0);
    const qrSvg = container.querySelector("svg.qr-svg")!;
    expect(qrSvg.querySelector("path")?.getAttribute("d")).toMatch(/^M\d+/);
    expect(container.querySelector('[data-pairing-code="482910"]')).toBeTruthy();
    expect(container.querySelector("[data-pairing-countdown]")?.textContent).toMatch(
      /^剩余 0\d:\d\d$/,
    );

    // 6. Revoke single device with confirmation
    expect(screen.getByText("iPhone 16 Pro")).toBeTruthy();
    const revokeBtns = screen.getAllByRole("button", { name: "吊销" });
    fireEvent.click(revokeBtns[0]!);
    const confirmOne = await screen.findByRole("alertdialog", {
      name: "确认吊销设备",
    });
    fireEvent.click(within(confirmOne).getByRole("button", { name: "确认吊销" }));
    await waitFor(() => {
      expect(
        recordedMutations.some(
          (m) => m.url === "/api/remote/devices/dev-a1" && m.method === "DELETE",
        ),
      ).toBe(true);
      expect(screen.getByText("已配对设备（有效 1 台）")).toBeTruthy();
    });

    // 7. Revoke all remaining devices with confirmation
    const revokeAllBtn = screen.getByRole("button", {
      name: "踢出全部设备",
    }) as HTMLButtonElement;
    await waitFor(() => {
      expect(revokeAllBtn.disabled).toBe(false);
    });
    fireEvent.click(revokeAllBtn);
    const confirmAll = await screen.findByRole("alertdialog", {
      name: "确认踢出全部设备",
    });
    fireEvent.click(within(confirmAll).getByRole("button", { name: "确认踢出全部" }));
    await waitFor(() => {
      expect(
        recordedMutations.some(
          (m) =>
            m.url === "/api/remote/devices/revoke-all" && m.method === "POST",
        ),
      ).toBe(true);
      expect(screen.getByText("已配对设备（有效 0 台）")).toBeTruthy();
    });
    expect(
      recordedMutations.every((m) => m.clientHeader === "web"),
    ).toBe(true);
  });

  it("hides host-only 从文件目录选择 action in remote mode while keeping discovered Git repos accessible in SpaceModal", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/auth/status") {
        return jsonResponse({
          ok: true,
          mode: "remote",
          authenticated: true,
          device: {
            id: "dev-r1",
            label: "Phone",
            created_at: new Date().toISOString(),
            last_seen_at: new Date().toISOString(),
          },
        });
      }
      if (url === "/api/bootstrap") {
        return jsonResponse(makeBaseBootstrap({ spaces: {} }));
      }
      if (url === "/api/spaces/discover") {
        return jsonResponse({
          ok: true,
          scanned_roots: ["~/AI"],
          truncated: false,
          repos: [
            {
              repo_path: "/Users/me/AI/Kiln",
              display_path: "~/AI/Kiln",
              name: "Kiln",
              suggested_id: "kiln",
              default_branch: "main",
              modified_at: new Date().toISOString(),
              already_added: false,
            },
          ],
        });
      }
      return jsonResponse({});
    });

    window.location.hash = "#view=intake";
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("还没有登记项目空间")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "从文件目录选择" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "+ 添加本地 Git 项目" }));
    const modal = await screen.findByRole("dialog", { name: "添加项目空间" });
    await waitFor(() => {
      expect(within(modal).getByText("~/AI/Kiln")).toBeTruthy();
    });
    expect(within(modal).queryByRole("button", { name: "从文件目录选择" })).toBeNull();
  });
});
