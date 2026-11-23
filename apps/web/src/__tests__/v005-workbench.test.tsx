// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapResponse, ProvidersConfig, RosterConfig } from "../api/types";
import { App } from "../app";

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

class MockEventSource {
  static instances: MockEventSource[] = [];
  private listeners = new Map<string, Set<(e: Event) => void>>();
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;

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

  emit(type: string, payload: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(payload) });
    this.listeners.get(type)?.forEach((cb) => cb(event));
  }

  close(): void {
    this.listeners.clear();
  }
}

function makeSampleProviders(): ProvidersConfig {
  return {
    schema_version: 1,
    providers: [
      {
        id: "codex",
        label: "Codex CLI",
        adapter: "codex_app_server",
        enabled: true,
        command: "codex",
        args: ["app-server"],
        env: {},
        custom_models: [],
        quota: { soft_daily_usd: 20 },
      },
      {
        id: "claude",
        label: "Claude Code",
        adapter: "claude_direct",
        enabled: true,
        command: "claude",
        args: ["-p", "--output-format", "stream-json"],
        env: {},
        custom_models: ["claude-sonnet-4-6"],
      },
      {
        id: "agy",
        label: "Antigravity CLI",
        adapter: "acp",
        enabled: true,
        command: "agy",
        args: ["acp", "--stdio"],
        env: {},
        custom_models: [],
      },
    ],
  };
}

function makeSampleRoster(): RosterConfig {
  return {
    schema_version: 2,
    heterogeneous_review: true,
    pm_orchestration: {
      enabled: true,
      allow_auto_tester: true,
      prefer_unthrottled: true,
      require_review_for_core: true,
    },
    roster: {
      pm: {
        group: "core",
        enabled: true,
        name: "立项 PM",
        stage: "intake",
        secondary_stages: [],
        perm: "read_only_draft",
        traits: "需求收敛与按特性点将",
        mode: "agent",
        primary: { provider: "codex", model: "gpt-5.4", effort: "medium" },
        fallbacks: [],
        allow_full_access_fallback: false,
        builtin: true,
      },
      main_dev: {
        group: "core",
        enabled: true,
        name: "主力开发",
        stage: "implement",
        secondary_stages: [],
        perm: "workspace_write",
        traits: "复杂跨文件实现与状态机",
        mode: "agent",
        primary: { provider: "codex", model: "gpt-5.4", effort: "high" },
        fallbacks: [{ provider: "claude", model: "claude-sonnet-4-6", effort: "medium" }],
        allow_full_access_fallback: false,
        builtin: true,
      },
      reviewer: {
        group: "core",
        enabled: true,
        name: "异构审查",
        stage: "review",
        secondary_stages: [],
        perm: "read_only",
        traits: "只读固定版本，强制避开实施模型",
        mode: "agent",
        primary: { provider: "codex", model: "gpt-5.4", effort: "high" },
        fallbacks: [],
        avoid_same_as: "implement",
        allow_full_access_fallback: false,
        builtin: true,
      },
      tester: {
        group: "kernel",
        enabled: true,
        name: "独立测试",
        stage: "verify",
        secondary_stages: [],
        perm: "kernel_gate",
        traits: "0 Token 确定性门禁",
        mode: "kernel",
        fallbacks: [],
        allow_full_access_fallback: false,
        builtin: true,
      },
    },
  };
}

function makeV3Bootstrap(
  overrides: Partial<BootstrapResponse> = {},
): BootstrapResponse {
  const providersCfg = makeSampleProviders();
  const rosterCfg = makeSampleRoster();
  return {
    version: "0.0.5",
    tasks: [],
    pendingDecisions: [],
    drafts: [],
    spaces: {
      alpha: {
        schema_version: 1,
        id: "alpha",
        name: "Alpha 项目",
        repo_path: "/repos/alpha",
        default_branch: "main",
        copy_untracked: [],
        clone_deps: [],
        freeze_patterns: [],
        pinned: false,
        scripts: { setup: "pnpm install", test: "pnpm test" },
      },
      zeta: {
        schema_version: 1,
        id: "zeta",
        name: "Zeta Core",
        repo_path: "/repos/zeta",
        default_branch: "main",
        copy_untracked: [],
        clone_deps: [],
        freeze_patterns: [],
        pinned: false,
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
    roster: rosterCfg,
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
      models: {
        "gpt-5.4": { in: 1.25, cached: 0.125, out: 10 },
        "claude-sonnet-4-6": { in: 3, cached: 0.3, out: 15 },
      },
    },
    providers: [
      {
        provider_id: "codex",
        label: "Codex CLI",
        adapter: "codex_app_server",
        status: "ready",
        version: "0.42.0",
        native_quota: {
          source: "codex_rate_limit",
          used_percent: 42,
          window_duration_mins: 300,
          resets_at: "19:30",
        },
        local_window_cost_usd: 2.5,
      },
      {
        provider_id: "claude",
        label: "Claude Code",
        adapter: "claude_direct",
        status: "cooldown",
        version: "2.1.0",
        cooldown_until: "18:45",
        native_quota: null,
        local_window_cost_usd: 3.15,
      },
      {
        provider_id: "agy",
        label: "Antigravity CLI",
        adapter: "acp",
        status: "ready",
        version: "1.0.2",
        native_quota: null,
        local_window_cost_usd: 0.8,
      },
    ],
    settings: {
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
        models: {
          "gpt-5.4": { in: 1.25, cached: 0.125, out: 10 },
          "claude-sonnet-4-6": { in: 3, cached: 0.3, out: 15 },
        },
      },
      roster: rosterCfg,
      providers: providersCfg,
    },
    usage: {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      cacheWriteTokens: 200_000,
      outputTokens: 100_000,
      totalTokens: 1_300_000,
      costUsd: 0,
      byAgent: {
        claude: {
          inputTokens: 1_000_000,
          cachedInputTokens: 500_000,
          cacheWriteTokens: 200_000,
          outputTokens: 100_000,
          totalTokens: 1_300_000,
          costUsd: 0,
        },
      },
      byModel: {
        "claude-sonnet-4-6": {
          inputTokens: 1_000_000,
          cachedInputTokens: 500_000,
          cacheWriteTokens: 200_000,
          outputTokens: 100_000,
          totalTokens: 1_300_000,
          costUsd: 0,
        },
      },
      byAgentModel: {
        claude: {
          "claude-sonnet-4-6": {
            inputTokens: 1_000_000,
            cachedInputTokens: 500_000,
            cacheWriteTokens: 200_000,
            outputTokens: 100_000,
            totalTokens: 1_300_000,
            costUsd: 0,
          },
        },
      },
    },
    runningCount: 0,
    agents: [
      {
        id: "codex",
        label: "Codex CLI",
        capabilities: {
          interactiveChat: true,
          approvals: false,
          mcpInjection: true,
          usageCacheBreakdown: true,
          interrupt: true,
          nativeQuotaWindow: true,
        },
        models: [
          { id: "gpt-5.4", thinkingOptions: ["medium", "high"] },
          { id: "gpt-5.4-mini", thinkingOptions: ["low", "medium"] },
        ],
      },
      {
        id: "claude",
        label: "Claude Code",
        capabilities: {
          interactiveChat: true,
          approvals: false,
          mcpInjection: true,
          usageCacheBreakdown: true,
          interrupt: true,
          cacheWriteTelemetry: true,
          imageInput: true,
          contextWindowTelemetry: true,
        },
        models: [{ id: "claude-sonnet-4-6", thinkingOptions: ["medium", "high"] }],
      },
      {
        id: "agy",
        label: "Antigravity CLI",
        capabilities: {
          interactiveChat: true,
          approvals: false,
          mcpInjection: true,
          usageCacheBreakdown: false,
          interrupt: true,
          readOnlySandbox: true,
        },
        models: [{ id: "gemini-3-pro", thinkingOptions: ["low", "high"] }],
      },
    ],
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn<MockFetchHandler>>;

beforeEach(() => {
  MockEventSource.instances = [];
  window.localStorage.clear();
  window.location.hash = "";
  window.history.replaceState(null, "", "/");
  document.body.className = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-pref");
  (window as unknown as { EventSource?: unknown }).EventSource = MockEventSource;
  fetchMock = vi.fn<MockFetchHandler>(async () => jsonResponse(makeV3Bootstrap()));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Slice 6a: LineupView, Providers, Space Pin/Scripts, Usage V2, Statusbar", () => {
  it("LineupView displays honest pool quotas, detects hetero collision, resolves via fallback, creates locked-perm custom role, and saves RosterConfig", async () => {
    let savedRoster: RosterConfig | null = null;
    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/auth/status") {
        return jsonResponse({ ok: true, mode: "local", authenticated: true, device: null });
      }
      if (url === "/api/bootstrap") {
        return jsonResponse(makeV3Bootstrap());
      }
      if (url === "/api/settings/roster" && (init?.method ?? "GET") === "PUT") {
        savedRoster = JSON.parse(String(init?.body)) as RosterConfig;
        return jsonResponse({ ok: true, section: "roster", data: savedRoster });
      }
      return jsonResponse({ ok: true });
    });

    window.location.hash = "#view=lineup";
    const { container } = render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "编排与阵容" })).toBeTruthy();
    });

    // Pool tiles: Codex native_quota (42%), Claude cooldown (.limited), Agy no official quota
    const codexTile = container.querySelector('[data-provider-tile="codex"]')!;
    const claudeTile = container.querySelector('[data-provider-tile="claude"]')!;
    const agyTile = container.querySelector('[data-provider-tile="agy"]')!;
    expect(codexTile.textContent).toContain("官方窗口 42%");
    expect(claudeTile.className).toContain("limited");
    expect(claudeTile.textContent).toContain("429 冷却至 18:45");
    expect(agyTile.textContent).toContain("无官方余额接口");

    // Hetero review collides initially (main_dev & reviewer both codex/gpt-5.4 with no fallback on reviewer)
    expect(screen.getByText("审查与实施撞模型")).toBeTruthy();

    // Verify enable checkbox is NOT nested inside row select button (accessibility)
    const reviewerRowBtn = container.querySelector('[data-roster-row="reviewer"]')!;
    expect(reviewerRowBtn.querySelector('input[type="checkbox"]')).toBeNull();
    expect(screen.getByLabelText("启用 异构审查")).toBeTruthy();

    // Select reviewer and add Agy fallback -> resolves collision
    fireEvent.click(reviewerRowBtn);
    fireEvent.change(screen.getByLabelText("备选 Provider"), { target: { value: "agy" } });
    fireEvent.click(screen.getByRole("button", { name: "添加备选" }));

    await waitFor(() => {
      expect(screen.getByText(/主力 gpt-5\.4 ≠ 审查 gemini-3-pro/)).toBeTruthy();
    });

    // Background SSE bootstrap refresh must NOT clobber unsaved dirty roster edits
    const sse = MockEventSource.instances[0]!;
    sse.emit("task.updated", {
      seq: 1,
      type: "task.updated",
      taskId: "unknown-new-task",
      patch: { status: "running" },
    });
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([u]) => u === "/api/bootstrap").length,
      ).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByText(/主力 gpt-5\.4 ≠ 审查 gemini-3-pro/)).toBeTruthy();

    // Create custom specialist role (research stage locks perm = read_only)
    fireEvent.click(screen.getByRole("button", { name: "自定义角色" }));
    const dialog = await screen.findByRole("dialog", { name: "新增自定义专长角色" });
    fireEvent.change(within(dialog).getByLabelText("自定义角色 ID"), {
      target: { value: "perf_scout" },
    });
    fireEvent.change(within(dialog).getByLabelText("自定义角色名称"), {
      target: { value: "性能侦察" },
    });
    fireEvent.change(within(dialog).getByLabelText("自定义角色阶段"), {
      target: { value: "research" },
    });
    fireEvent.change(within(dialog).getByLabelText("自定义角色能力特性"), {
      target: { value: "只读性能分析与火焰图排查" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "添加角色" }));

    await waitFor(() => {
      expect(
        container.querySelector('[data-role-perm="read_only"]')?.textContent,
      ).toBe("只读");
    });

    // Save roster
    fireEvent.click(screen.getByRole("button", { name: /保存阵容/ }));
    await waitFor(() => {
      expect(savedRoster).not.toBeNull();
    });
    expect(savedRoster!.schema_version).toBe(2);
    expect(savedRoster!.roster.reviewer?.fallbacks[0]).toMatchObject({
      provider: "agy",
      model: "gemini-3-pro",
    });
    expect(savedRoster!.roster.perf_scout).toMatchObject({
      group: "specialist",
      stage: "research",
      perm: "read_only",
      builtin: false,
    });
  });

  it("SettingsView Providers tab works locally (test + custom ACP + save) and fails closed in :4311 remote mode", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    fetchMock.mockImplementation(async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({
        url,
        method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url === "/api/auth/status") {
        return jsonResponse({ ok: true, mode: "local", authenticated: true, device: null });
      }
      if (url === "/api/bootstrap") {
        return jsonResponse(makeV3Bootstrap());
      }
      if (url === "/api/providers/codex/test" && method === "POST") {
        return jsonResponse({
          ok: true,
          status: {
            provider_id: "codex",
            label: "Codex CLI",
            adapter: "codex_app_server",
            status: "ready",
            version: "0.43.0",
            detail: "Probe ok",
          },
          modelsCount: 2,
        });
      }
      if (url === "/api/settings/providers" && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as ProvidersConfig;
        return jsonResponse({ ok: true, section: "providers", data: body });
      }
      return jsonResponse({ ok: true });
    });

    window.location.hash = "#view=settings&tab=providers";
    const localRender = render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText("Codex CLI 命令")).toBeTruthy();
    });

    // Test Codex connectivity
    const codexCard = localRender.container.querySelector('[data-provider-card="codex"]') as HTMLElement;
    fireEvent.click(within(codexCard).getByRole("button", { name: "测试连通" }));
    await waitFor(() => {
      expect(calls.some((c) => c.url === "/api/providers/codex/test" && c.method === "POST")).toBe(true);
      expect(codexCard.textContent).toContain("Probe ok");
    });

    // Incremental args typing preserves trailing space & multi-line env typing preserves incomplete KEY without '='
    const argsInput = screen.getByLabelText("Codex CLI 参数") as HTMLInputElement;
    // Focus+blur without editing must NOT mark Providers dirty
    fireEvent.focus(argsInput);
    fireEvent.blur(argsInput);
    expect(screen.getByRole("button", { name: "保存 Providers" }).textContent).toBe("保存 Providers");

    fireEvent.change(argsInput, { target: { value: "app-server " } });
    expect(argsInput.value).toBe("app-server ");
    fireEvent.change(argsInput, { target: { value: "app-server --listen" } });

    const envTextarea = screen.getByLabelText("Codex CLI 环境变量") as HTMLTextAreaElement;
    fireEvent.change(envTextarea, { target: { value: "OPENAI_BASE" } });
    expect(envTextarea.value).toBe("OPENAI_BASE");
    fireEvent.change(envTextarea, {
      target: { value: "OPENAI_BASE=https://proxy.example\nFOO=bar" },
    });

    // Clear soft_daily_usd on Codex & verify background SSE bootstrap doesn't clobber dirty Providers draft
    const budgetInput = screen.getByLabelText("Codex CLI 日软预算") as HTMLInputElement;
    fireEvent.change(budgetInput, { target: { value: "" } });
    const sseLocal = MockEventSource.instances[0]!;
    sseLocal.emit("task.updated", {
      seq: 2,
      type: "task.updated",
      taskId: "t-bg-refresh",
      patch: { status: "running" },
    });
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([u]) => u === "/api/bootstrap").length,
      ).toBeGreaterThanOrEqual(2);
    });
    expect(argsInput.value).toBe("app-server --listen");
    expect(envTextarea.value).toBe("OPENAI_BASE=https://proxy.example\nFOO=bar");

    // Add custom model & register custom ACP, then save
    fireEvent.change(screen.getByLabelText("Codex CLI 新增自定义模型"), {
      target: { value: "gpt-5.5-preview" },
    });
    fireEvent.click(within(codexCard).getByRole("button", { name: "添加" }));

    fireEvent.click(screen.getByRole("button", { name: "注册自定义 ACP" }));
    const acpDialog = await screen.findByRole("dialog", { name: "注册自定义 ACP Agent" });
    fireEvent.change(within(acpDialog).getByLabelText("自定义 ACP ID"), {
      target: { value: "cursor" },
    });
    fireEvent.change(within(acpDialog).getByLabelText("自定义 ACP 名称"), {
      target: { value: "Cursor CLI" },
    });
    fireEvent.change(within(acpDialog).getByLabelText("自定义 ACP 命令"), {
      target: { value: "cursor-agent" },
    });
    fireEvent.click(within(acpDialog).getByRole("button", { name: "确认添加" }));

    fireEvent.click(screen.getByRole("button", { name: /保存 Providers/ }));
    await waitFor(() => {
      const put = calls.find((c) => c.url === "/api/settings/providers" && c.method === "PUT");
      expect(put).toBeTruthy();
      const saved = put!.body as ProvidersConfig;
      const savedCodex = saved.providers.find((p) => p.id === "codex");
      expect(savedCodex?.args).toEqual(["app-server", "--listen"]);
      expect(savedCodex?.env).toEqual({
        OPENAI_BASE: "https://proxy.example",
        FOO: "bar",
      });
      expect(savedCodex?.quota).toBeUndefined();
      expect(savedCodex?.custom_models).toContain("gpt-5.5-preview");
      expect(saved.providers.find((p) => p.id === "cursor")?.adapter).toBe("acp");
    });
    localRender.unmount();

    // Remote mode (:4311) fail-closed isolation
    calls.length = 0;
    const now = new Date().toISOString();
    fetchMock.mockImplementation(async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method });
      if (url === "/api/auth/status") {
        return jsonResponse({
          ok: true,
          mode: "remote",
          authenticated: true,
          device: { id: "dev-1", label: "iPhone", created_at: now, last_seen_at: now },
        });
      }
      if (url === "/api/bootstrap") {
        const remoteBoot = makeV3Bootstrap();
        delete remoteBoot.settings?.providers;
        return jsonResponse(remoteBoot);
      }
      return jsonResponse({ ok: true });
    });

    window.location.hash = "#view=settings&tab=providers";
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("仅限本机桌面端管理 Providers 订阅底座")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "测试连通" })).toBeNull();
    expect(calls.some((c) => c.url.startsWith("/api/settings/providers"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/test"))).toBe(false);
  });

  it("Sidebar Space pin preserves scripts & sorts pinned first (never on local), and SpaceModal saves scripts", async () => {
    const putBodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    let currentSpaces = makeV3Bootstrap().spaces;

    fetchMock.mockImplementation(async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/status") {
        return jsonResponse({ ok: true, mode: "local", authenticated: true, device: null });
      }
      if (url === "/api/bootstrap") {
        return jsonResponse(makeV3Bootstrap({ spaces: currentSpaces }));
      }
      if (url.startsWith("/api/spaces/") && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        putBodies.push({ url, body });
        const id = url.split("/").pop()!;
        currentSpaces = {
          ...currentSpaces,
          [id]: {
            schema_version: 1,
            id,
            name: String(body.name),
            repo_path: String(body.repo_path),
            default_branch: String(body.default_branch ?? "main"),
            copy_untracked: [],
            clone_deps: [],
            freeze_patterns: [],
            pinned: Boolean(body.pinned),
            ...(body.scripts ? { scripts: body.scripts as Record<string, string> } : {}),
          },
        };
        return jsonResponse({ ok: true, space: currentSpaces[id] });
      }
      return jsonResponse({ ok: true });
    });

    const { container } = render(<App />);
    await waitFor(() => {
      expect(container.querySelector('[data-space-pin="zeta"]')).toBeTruthy();
    });
    expect(container.querySelector('[data-space-pin="local"]')).toBeNull();

    // Pin Zeta Core -> moves above Alpha in #spaceNav and preserves existing scripts when pinning Alpha
    fireEvent.click(container.querySelector('[data-space-pin="zeta"]')!);
    await waitFor(() => {
      const spaceNames = Array.from(
        document.querySelectorAll("#spaceNav .space-main span:last-child"),
      ).map((el) => el.textContent);
      expect(spaceNames[0]).toBe("Zeta Core");
    });

    fireEvent.click(container.querySelector('[data-space-pin="alpha"]')!);
    await waitFor(() => {
      const alphaPut = putBodies.find((p) => p.url === "/api/spaces/alpha");
      expect(alphaPut?.body.pinned).toBe(true);
      expect(alphaPut?.body.scripts).toEqual({
        setup: "pnpm install",
        test: "pnpm test",
      });
    });

    // Open SpaceModal for Alpha in Settings and edit lint script
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(await screen.findByRole("tab", { name: "项目空间" }));
    const settingsInner = document.querySelector(".page-inner") as HTMLElement;
    const alphaRow = within(settingsInner).getByText("Alpha 项目").closest("tr")!;
    fireEvent.click(within(alphaRow).getByRole("button", { name: "编辑" }));
    const modal = await screen.findByRole("dialog", { name: "编辑项目空间 · alpha" });
    fireEvent.change(within(modal).getByLabelText("lint 脚本"), {
      target: { value: "pnpm typecheck" },
    });
    fireEvent.click(within(modal).getByRole("button", { name: "保存空间" }));

    await waitFor(() => {
      const latestAlphaPut = putBodies.filter((p) => p.url === "/api/spaces/alpha").at(-1);
      expect(latestAlphaPut?.body.scripts).toMatchObject({
        setup: "pnpm install",
        test: "pnpm test",
        lint: "pnpm typecheck",
      });
      expect(latestAlphaPut?.body.pinned).toBe(true);
    });
  });

  it("UsageView computes V2 5-field costs (including Claude 1.25x cache_write premium & net savings) and Statusbar reacts to SSE events + ⌘\\", async () => {
    window.location.hash = "#view=usage";
    const { container } = render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "用量与费用" })).toBeTruthy();
    });

    // Claude sonnet-4-6: in=$3, cached=$0.3, default cache_write=$3.75 (1.25x), out=$15
    // uncachedIn=500k ($1.50) + cacheRead=500k ($0.15) + cacheWrite=200k ($0.75) + output=100k ($1.50) = $3.90
    // netSaved = 500k*(3 - 0.3)/1e6 - 200k*(3.75 - 3)/1e6 = $1.35 - $0.15 = $1.20
    expect(container.querySelector(".stats dd")?.textContent).toBe("$3.90");
    expect(screen.getByText(/缓存省下约 \$1\.20/)).toBeTruthy();
    expect(screen.getByText(/429 冷却中/)).toBeTruthy();

    // Statusbar shows initial Claude 429 cooldown
    const statusbar = container.querySelector("footer.statusbar")!;
    expect(statusbar.textContent).toContain("Claude Code 429 冷却");

    // SSE provider.status clears cooldown and moves Codex into cooldown live
    const sse = MockEventSource.instances[0]!;
    sse.emit("provider.status", {
      seq: 10,
      type: "provider.status",
      providerId: "claude",
      status: "ready",
      at: new Date().toISOString(),
    });
    sse.emit("provider.status", {
      seq: 11,
      type: "provider.status",
      providerId: "codex",
      status: "cooldown",
      cooldownUntil: "20:00",
      at: new Date().toISOString(),
    });

    await waitFor(() => {
      expect(statusbar.textContent).toContain("Codex CLI 429 冷却");
      expect(statusbar.textContent).not.toContain("Claude Code 429 冷却");
    });

    // ⌘\ toggles sidebar collapse (.side-hidden on body)
    expect(document.body.classList.contains("side-hidden")).toBe(false);
    fireEvent.keyDown(document, { key: "\\", metaKey: true });
    expect(document.body.classList.contains("side-hidden")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "展开导航栏" }));
    expect(document.body.classList.contains("side-hidden")).toBe(false);
  });
});
