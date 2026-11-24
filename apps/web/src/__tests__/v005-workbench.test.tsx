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
      advisor: {
        group: "core",
        enabled: true,
        name: "技术顾问",
        stage: "advise",
        secondary_stages: [],
        perm: "read_only",
        traits: "全新上下文裁决技术分歧与停滞破局（严格只读）",
        mode: "agent",
        primary: { provider: "claude", model: "claude-opus-4-6", effort: "high" },
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
  it("LineupView displays honest pool quotas, hides disabled/unavailable providers, detects hetero collision, resolves via fallback, creates locked-perm custom role, and saves RosterConfig", async () => {
    let savedRoster: RosterConfig | null = null;
    const bootWithMissingProviders = (): BootstrapResponse => {
      const base = makeV3Bootstrap();
      return {
        ...base,
        providers: [
          ...(base.providers ?? []),
          {
            provider_id: "gemini",
            label: "Gemini CLI",
            adapter: "acp",
            status: "unavailable",
            detail: 'Command "gemini" not found',
            native_quota: null,
            local_window_cost_usd: 0,
          },
          {
            provider_id: "paseo",
            label: "Paseo (Legacy Bridge)",
            adapter: "paseo",
            status: "unavailable",
            detail: "Paseo 历史兼容桥接已关闭",
            native_quota: null,
            local_window_cost_usd: 0,
          },
        ],
        settings: base.settings
          ? {
              ...base.settings,
              providers: base.settings.providers
                ? {
                    ...base.settings.providers,
                    providers: [
                      ...base.settings.providers.providers,
                      {
                        id: "gemini",
                        label: "Gemini CLI",
                        adapter: "acp",
                        enabled: false,
                        command: "gemini",
                        args: ["--experimental-acp"],
                        env: {},
                        custom_models: [],
                      },
                      {
                        id: "paseo",
                        label: "Paseo (Legacy Bridge)",
                        adapter: "paseo",
                        enabled: false,
                        args: [],
                        env: {},
                        custom_models: [],
                      },
                    ],
                  }
                : undefined,
            }
          : undefined,
      };
    };

    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/auth/status") {
        return jsonResponse({ ok: true, mode: "local", authenticated: true, device: null });
      }
      if (url === "/api/bootstrap") {
        return jsonResponse(bootWithMissingProviders());
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

    // Pool tiles: Codex native_quota (42%), Claude cooldown (.limited), Agy no official quota;
    // disabled/unavailable gemini & paseo are hidden from pool & provider selects.
    const codexTile = container.querySelector('[data-provider-tile="codex"]')!;
    const claudeTile = container.querySelector('[data-provider-tile="claude"]')!;
    const agyTile = container.querySelector('[data-provider-tile="agy"]')!;
    expect(codexTile.textContent).toContain("官方窗口 42%");
    expect(claudeTile.className).toContain("limited");
    expect(claudeTile.textContent).toContain("429 冷却至 18:45");
    expect(agyTile.textContent).toContain("无官方余额接口");
    expect(container.querySelector('[data-provider-tile="gemini"]')).toBeNull();
    expect(container.querySelector('[data-provider-tile="paseo"]')).toBeNull();

    const primarySelect = screen.getByLabelText("主订阅 Provider") as HTMLSelectElement;
    const fbSelect = screen.getByLabelText("备选 Provider") as HTMLSelectElement;
    const primaryVals = Array.from(primarySelect.options).map((o) => o.value);
    const fbVals = Array.from(fbSelect.options).map((o) => o.value);
    expect(primaryVals).not.toContain("gemini");
    expect(primaryVals).not.toContain("paseo");
    expect(fbVals).not.toContain("gemini");
    expect(fbVals).not.toContain("paseo");

    // Hetero review collides initially (main_dev & reviewer both codex/gpt-5.4 with no fallback on reviewer)
    expect(screen.getByText("审查与实施撞模型")).toBeTruthy();

    // Advisor row renders under 核心推进 with 顾问 & 只读 perm and can be selected for editing
    const advisorRowBtn = container.querySelector('[data-roster-row="advisor"]')!;
    expect(advisorRowBtn).toBeTruthy();
    expect(advisorRowBtn.textContent).toContain("技术顾问");
    expect(advisorRowBtn.textContent).toContain("顾问");
    expect(advisorRowBtn.textContent).toContain("只读");
    fireEvent.click(advisorRowBtn);
    await waitFor(() => {
      expect(screen.getByDisplayValue("claude-opus-4-6")).toBeTruthy();
    });

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
      if (url === "/api/providers/detect" && method === "POST") {
        const syncedCfg: ProvidersConfig = {
          schema_version: 1,
          providers: makeSampleProviders().providers.map((p) =>
            p.id === "claude" ? { ...p, enabled: false } : p,
          ),
        };
        return jsonResponse({
          ok: true,
          data: syncedCfg,
          providers: [
            {
              provider_id: "codex",
              label: "Codex CLI",
              adapter: "codex_app_server",
              status: "ready",
              version: "0.43.0",
              detail: "Probe ok",
            },
            {
              provider_id: "claude",
              label: "Claude Code",
              adapter: "claude_direct",
              status: "unavailable",
              detail: "Command \"claude\" not found",
            },
          ],
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

    // Accordion defaults to only first enabled provider (codex) expanded; claude body is collapsed
    const codexCard = localRender.container.querySelector('[data-provider-card="codex"]') as HTMLElement;
    const claudeCard = localRender.container.querySelector('[data-provider-card="claude"]') as HTMLElement;
    expect(codexCard.getAttribute("data-state")).toBe("open");
    expect(claudeCard.getAttribute("data-state")).toBe("closed");

    // Clicking claude trigger switches accordion open item to claude and collapses codex
    fireEvent.click(within(claudeCard).getByRole("button", { name: /Claude Code/ }));
    await waitFor(() => {
      expect(claudeCard.getAttribute("data-state")).toBe("open");
      expect(codexCard.getAttribute("data-state")).toBe("closed");
      expect(screen.getByLabelText("Claude Code 命令")).toBeTruthy();
    });

    // Toggling claude off collapses it; switching back to codex keeps form testable
    fireEvent.click(within(claudeCard).getByLabelText("启用 Claude Code"));
    expect(claudeCard.getAttribute("data-state")).toBe("closed");

    // Click 重新探测 -> POST /api/providers/detect syncs host availability and clears dirty state
    fireEvent.click(screen.getByRole("button", { name: "重新探测" }));
    await waitFor(() => {
      expect(calls.some((c) => c.url === "/api/providers/detect" && c.method === "POST")).toBe(true);
      expect(codexCard.getAttribute("data-state")).toBe("open");
      expect((within(claudeCard).getByLabelText("启用 Claude Code") as HTMLInputElement).checked).toBe(false);
    });

    // Test Codex connectivity
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

  it("DetailView supports mid-flight steering (POST /api/tasks/:id/steer) and displays steer history", async () => {
    const steerBodies: Array<Record<string, unknown>> = [];
    const steers: Array<{
      id: string;
      at: string;
      message: string;
      interrupt: boolean;
      contract_version: number;
      stage?: string;
    }> = [];

    const sampleTaskCard = {
      schema_version: 1 as const,
      id: "t-steer-ui",
      title: "DetailView Steer 联调任务",
      space: "alpha",
      priority: "P1" as const,
      track: "L2" as const,
      workspace_mode: "git_worktree" as const,
      parent: null,
      depends_on: [],
      contract_version: 1,
      contract: {
        goal: "实现流式日志过滤",
        end: "单测通过",
        accept_cmd: "pnpm test",
        accept_files_hash: "sha256:abc",
        scope: ["apps/web/**"],
        deliver: { mode: "merge_main" as const, cmd: null },
        human_accept: false,
        external_actions: "ask" as const,
      },
      limits: {
        retries_per_stage: 2,
        review_rounds: 2,
        advisor_calls: 1,
        max_tokens: 250_000,
      },
      created_at: "2026-11-23T08:00:00.000Z",
      updated_at: "2026-11-23T08:05:00.000Z",
    };

    const makeDetailPayload = () => ({
      card: sampleTaskCard,
      state: {
        status: "running" as const,
        stage: "implement" as const,
        round: 1,
        activeRunId: "run-steer-1",
        priority: "P1" as const,
        effectivePriority: "P1" as const,
        track: "L2" as const,
        contractVersion: 1,
        updatedAt: "2026-11-23T08:05:00.000Z",
      },
      brief: "## 1. 目标\n实现流式日志过滤",
      decisions: "",
      pendingDecision: null,
      ledgerProposals: [],
      runs: [],
      usageTurns: [],
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        byAgent: {},
        byModel: {},
      },
      steers: [...steers],
    });

    fetchMock.mockImplementation(async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/status") {
        return jsonResponse({ ok: true, mode: "local", authenticated: true, device: null });
      }
      if (url === "/api/bootstrap") {
        return jsonResponse(
          makeV3Bootstrap({
            tasks: [
              {
                id: sampleTaskCard.id,
                space: sampleTaskCard.space,
                parent_id: null,
                title: sampleTaskCard.title,
                priority: sampleTaskCard.priority,
                effective_priority: sampleTaskCard.priority,
                track: sampleTaskCard.track,
                workspace_mode: sampleTaskCard.workspace_mode,
                status: "running",
                stage: "implement",
                round: 1,
                active_run_id: "run-steer-1",
                contract_version: 1,
                depends_on: [],
                created_at: sampleTaskCard.created_at,
                updated_at: sampleTaskCard.updated_at,
                tokens: {
                  input_tokens: 0,
                  cached_input_tokens: 0,
                  output_tokens: 0,
                  total_tokens: 0,
                },
                cost_usd: 0,
              },
            ],
            runningCount: 1,
          }),
        );
      }
      if (url === `/api/tasks/${sampleTaskCard.id}` && method === "GET") {
        return jsonResponse(makeDetailPayload());
      }
      if (url === `/api/tasks/${sampleTaskCard.id}/steer` && method === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          message: string;
          interrupt?: boolean;
        };
        steerBodies.push(body);
        const created = {
          id: "steer-ui-1",
          at: "2026-11-23T08:06:00.000Z",
          message: body.message,
          interrupt: Boolean(body.interrupt),
          contract_version: 1,
          stage: "implement",
        };
        steers.push(created);
        return jsonResponse({
          ok: true,
          taskId: sampleTaskCard.id,
          interrupted: Boolean(body.interrupt),
          steer: created,
        });
      }
      return jsonResponse({ ok: true });
    });

    window.location.hash = `#view=detail&task=${sampleTaskCard.id}`;
    render(<App />);

    const steerToggleBtn = await screen.findByRole("button", { name: "补充纠偏" });
    fireEvent.click(steerToggleBtn);

    const textarea = await screen.findByLabelText("补充纠偏指令");
    fireEvent.change(textarea, {
      target: { value: "优先复用现有 filterLogs 工具函数" },
    });
    fireEvent.click(screen.getByRole("button", { name: "下一棒生效" }));

    await waitFor(() => {
      expect(steerBodies).toEqual([
        { message: "优先复用现有 filterLogs 工具函数", interrupt: false },
      ]);
      expect(screen.getByText("优先复用现有 filterLogs 工具函数")).toBeTruthy();
    });
  });

  it("renders B3 stage cache hit rates and warm session reuse telemetry on UsageView", async () => {
    const boot = makeV3Bootstrap();
    boot.usage = {
      ...boot.usage,
      inputTokens: 30_000,
      cachedInputTokens: 20_000,
      outputTokens: 3_000,
      totalTokens: 33_000,
      costUsd: 0.12,
      cacheNetSavedUsd: 0.04,
      byStage: {
        implement: {
          inputTokens: 20_000,
          cachedInputTokens: 18_000,
          cacheWriteTokens: 0,
          outputTokens: 2_000,
          reasoningTokens: 0,
          totalTokens: 22_000,
          costUsd: 0.08,
          cacheNetSavedUsd: 0.04,
          runCount: 2,
          reusedRunCount: 1,
        },
        review: {
          inputTokens: 10_000,
          cachedInputTokens: 2_000,
          cacheWriteTokens: 0,
          outputTokens: 1_000,
          reasoningTokens: 0,
          totalTokens: 11_000,
          costUsd: 0.04,
          cacheNetSavedUsd: 0,
          runCount: 1,
          reusedRunCount: 0,
        },
      },
      warmSessionStats: {
        totalImplementRuns: 2,
        reusedImplementRuns: 1,
        warmCacheHitRate: 90,
        coldCacheHitRate: 20,
      },
    };

    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/auth/status") {
        return jsonResponse({ ok: true, mode: "local", authenticated: true, device: null });
      }
      if (url === "/api/bootstrap") {
        return jsonResponse(boot);
      }
      return jsonResponse({ ok: true });
    });

    window.location.hash = "#view=usage";
    render(<App />);

    expect(await screen.findByText("阶段缓存与热复用效率")).toBeTruthy();
    expect(
      screen.getByText(/implement 热复用 1\/2 次 · 热命中 90% vs 冷命中 20%/),
    ).toBeTruthy();
    expect(screen.getByText("90%")).toBeTruthy();
  });

  it("LineupView supports Track 2 derived inheritance hints, tier_hint, escalation_target, and deliverer on_conflict mode", async () => {
    let savedRoster: RosterConfig | null = null;
    const boot = makeV3Bootstrap();
    const curRoster = boot.roster!;
    const nextRoster: RosterConfig = {
      ...curRoster,
      roster: {
        ...curRoster.roster,
        architect: {
          group: "core",
          enabled: false,
          name: "架构方案",
          stage: "plan",
          secondary_stages: [],
          perm: "read_only",
          traits: "出 PLAN.md",
          mode: "agent",
          fallbacks: [],
          allow_full_access_fallback: false,
          builtin: true,
        },
        fast_fix: {
          group: "core",
          enabled: true,
          name: "快修开发",
          stage: "implement",
          secondary_stages: [],
          perm: "workspace_write",
          traits: "有 PLAN.md 时首选便宜执行",
          mode: "agent",
          tier_hint: "economy",
          escalation_target: "main_dev",
          primary: { provider: "codex", model: "gpt-5.4", effort: "low" },
          fallbacks: [],
          allow_full_access_fallback: false,
          builtin: true,
        },
        deliverer: {
          group: "kernel",
          enabled: true,
          name: "合并交付",
          stage: "deliver",
          secondary_stages: [],
          perm: "kernel_gate",
          traits: "默认内核合并，冲突按需切模型",
          mode: "kernel",
          fallbacks: [],
          allow_full_access_fallback: false,
          builtin: true,
        },
      },
    };
    boot.roster = nextRoster;
    if (boot.settings) {
      boot.settings.roster = nextRoster;
    }

    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/auth/status") {
        return jsonResponse({ ok: true, mode: "local", authenticated: true, device: null });
      }
      if (url === "/api/bootstrap") {
        return jsonResponse(boot);
      }
      if (url === "/api/settings/roster" && (init?.method ?? "GET") === "PUT") {
        savedRoster = JSON.parse(String(init?.body ?? "{}")) as RosterConfig;
        return jsonResponse({ ok: true, section: "roster", data: savedRoster });
      }
      return jsonResponse({ ok: true });
    });

    window.location.hash = "#view=lineup";
    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: "编排与阵容" })).toBeTruthy();

    // Disabled architect surfaces automatic inheritance from advisor
    await waitFor(() => {
      expect(container.querySelector('[data-roster-row="architect"]')).not.toBeNull();
    });
    const architectRow = container.querySelector('[data-roster-row="architect"]')!;
    expect(architectRow.textContent).toContain("自动继承 技术顾问");

    // Inspect fast_fix tier_hint & escalation_target
    const fastFixRow = container.querySelector('[data-roster-row="fast_fix"]')!;
    fireEvent.click(fastFixRow);
    const tierSelect = screen.getByLabelText("模型档位定位") as HTMLSelectElement;
    const escSelect = screen.getByLabelText("失败自动升档目标") as HTMLSelectElement;
    expect(tierSelect.value).toBe("economy");
    expect(escSelect.value).toBe("main_dev");

    // Switch deliverer to 3-way on_conflict mode and save
    const delivererRow = container.querySelector('[data-roster-row="deliverer"]')!;
    fireEvent.click(delivererRow);
    fireEvent.click(screen.getByRole("button", { name: "冲突按需" }));
    fireEvent.click(screen.getByRole("button", { name: /保存阵容/ }));

    await waitFor(() => {
      expect(savedRoster).not.toBeNull();
    });
    expect(savedRoster!.roster.deliverer?.mode).toBe("on_conflict");
    expect(savedRoster!.roster.fast_fix?.tier_hint).toBe("economy");
    expect(savedRoster!.roster.fast_fix?.escalation_target).toBe("main_dev");
  });

  it("supports Track 3 verifier_capabilities, SpaceModal accept_entry builder, and DetailView real acceptance evidence & service logs", async () => {
    const boot = makeV3Bootstrap();
    const verifierRoster = {
      ...boot.roster!.roster,
      verifier: {
        group: "core" as const,
        enabled: true,
        name: "真实验收",
        stage: "accept" as const,
        secondary_stages: [],
        perm: "accept_entry" as const,
        traits: "真机/浏览器端到端验收",
        mode: "agent" as const,
        verifier_capabilities: ["cli" as const],
        primary: { provider: "claude", model: "claude-sonnet-4-6", effort: "medium" as const },
        fallbacks: [],
        allow_full_access_fallback: false,
        builtin: true,
      },
    };
    boot.roster = { ...boot.roster!, roster: verifierRoster };
    if (boot.settings) {
      boot.settings.roster = boot.roster;
    }
    let savedRoster: RosterConfig | null = null;
    let savedSpaceBody: Record<string, unknown> | null = null;

    boot.tasks.push({
      id: "t-track3-ui",
      space: "alpha",
      parent_id: null,
      title: "Track3 真实验收 UI 展示",
      priority: "P1",
      effective_priority: "P1",
      track: "L2",
      workspace_mode: "git_worktree",
      status: "running",
      stage: "accept",
      round: 1,
      active_run_id: "run-t3-accept",
      contract_version: 1,
      depends_on: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:05:00.000Z",
      tokens: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50, total_tokens: 150 },
      cost_usd: 0.01,
    });

    fetchMock.mockImplementation(async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/status") {
        return jsonResponse({ ok: true, mode: "local", authenticated: true, device: null });
      }
      if (url === "/api/bootstrap") {
        return jsonResponse(boot);
      }
      if (url === "/api/settings/roster" && method === "PUT") {
        savedRoster = JSON.parse(String(init?.body ?? "{}")) as RosterConfig;
        return jsonResponse({ ok: true, section: "roster", data: savedRoster });
      }
      if (url === "/api/spaces/inspect" && method === "POST") {
        return jsonResponse({
          ok: true,
          repo_path: "/tmp/demo-web",
          suggested_id: "demo-web",
          suggested_name: "Demo Web",
          default_branch: "main",
          default_accept_cmd: "pnpm test",
          suggested_accept_entry: {
            kind: "http_server",
            services: [
              {
                name: "web",
                cmd: "pnpm run dev -- --port {{port}}",
                needs_port: true,
                primary: true,
                depends_on: [],
                ready: { kind: "http", path: "/" },
                ready_timeout_ms: 30_000,
              },
            ],
            observe_http: true,
            required_capability: "browser",
          },
          copy_untracked: [],
          clone_deps: [],
        });
      }
      if (url === "/api/spaces/demo-web" && method === "PUT") {
        savedSpaceBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return jsonResponse({ ok: true, space: { schema_version: 1, id: "demo-web", ...savedSpaceBody } }, 201);
      }
      if (url === "/api/tasks/t-track3-ui") {
        return jsonResponse({
          card: {
            schema_version: 1,
            id: "t-track3-ui",
            title: "Track3 真实验收 UI 展示",
            space: "alpha",
            priority: "P1",
            track: "L2",
            workspace_mode: "git_worktree",
            parent: null,
            depends_on: [],
            contract_version: 1,
            contract: {
              goal: "Real UI accept",
              end: "Verified",
              accept_cmd: "pnpm test",
              accept_files_hash: "h",
              scope: ["src/**"],
              deliver: { mode: "merge_main" },
              human_accept: false,
              external_actions: "ask",
            },
            limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 2, max_tokens: 100000 },
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:05:00.000Z",
          },
          state: {
            status: "running",
            stage: "accept",
            round: 1,
            activeRunId: "run-t3-accept",
            priority: "P1",
            effectivePriority: "P1",
            track: "L2",
            contractVersion: 1,
            updatedAt: "2026-01-01T00:05:00.000Z",
          },
          brief: "# Brief",
          decisions: "",
          pendingDecision: null,
          ledgerProposals: [],
          activeAcceptEnv: {
            entryKind: "http_server",
            primaryUrl: "http://127.0.0.1:45123",
            services: [
              {
                name: "web",
                status: "ready",
                port: 45122,
                proxy_port: 45123,
                url: "http://127.0.0.1:45123",
              },
            ],
            traffic: { observed: true, total_requests: 2, unique_paths: ["/"], error_responses: [] },
          },
          runs: [
            {
              dirName: "002-accept",
              meta: {
                schema_version: 1,
                run_id: "run-t3-accept",
                task_id: "t-track3-ui",
                stage: "accept",
                round: 1,
                role: "verifier",
                contract_version: 1,
                backend_id: "composite",
                agent: "claude",
                model: "claude-sonnet-4-6",
                session_ref: { backendId: "composite", sessionId: "s-1" },
                started_at: "2026-01-01T00:02:00.000Z",
              },
              handoff: "# Handoff",
              receipt: null,
              gate: null,
              acceptReport: {
                schema_version: 1,
                run_id: "run-t3-accept",
                contract_version: 1,
                checked_at: "2026-01-01T00:04:00.000Z",
                entry_kind: "http_server",
                entry_mode: "browser",
                verdict: "blocked",
                gate_ok: false,
                rejection_reasons: ["no_real_traffic_observed"],
                services: [
                  {
                    name: "web",
                    status: "ready",
                    port: 45122,
                    proxy_port: 45123,
                    url: "http://127.0.0.1:45123",
                  },
                ],
                traffic: { observed: true, total_requests: 0, unique_paths: [], error_responses: [] },
                evidence_files: [
                  {
                    rel_path: "evidence/shot.png",
                    kind: "image",
                    size_bytes: 2048,
                    mime_type: "image/png",
                    valid: true,
                  },
                ],
                scenarios: [{ name: "首页打开", status: "pass" }],
              },
              events: [],
              eventsCount: 0,
            },
          ],
          usageTurns: [],
          usage: boot.usage,
        });
      }
      if (url === "/api/tasks/t-track3-ui/runs/002-accept/accept-logs/web") {
        return new Response("server listening on 45122\n", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      return jsonResponse({ ok: true });
    });

    // 1. LineupView verifier_capabilities toggle
    window.location.hash = "#view=lineup";
    const { container } = render(<App />);
    expect(await screen.findByRole("heading", { name: "编排与阵容" })).toBeTruthy();

    await waitFor(() => {
      expect(container.querySelector('[data-roster-row="verifier"]')).not.toBeNull();
    });
    fireEvent.click(container.querySelector('[data-roster-row="verifier"]')!);
    fireEvent.click(screen.getByRole("button", { name: "真实浏览器操作" }));
    fireEvent.click(screen.getByRole("button", { name: /保存阵容/ }));
    await waitFor(() => {
      expect(savedRoster?.roster.verifier?.verifier_capabilities).toContain("browser");
    });

    // 2. SpaceModal suggested_accept_entry apply & save
    fireEvent.click(screen.getByRole("button", { name: "添加项目空间" }));
    const spaceModal = await screen.findByRole("dialog", { name: "添加项目空间" });
    fireEvent.change(within(spaceModal).getByLabelText("仓库路径"), {
      target: { value: "/tmp/demo-web" },
    });
    fireEvent.click(within(spaceModal).getByRole("button", { name: "识别仓库" }));
    const applyBtn = await within(spaceModal).findByRole("button", { name: "应用推荐配置" });
    fireEvent.click(applyBtn);
    fireEvent.click(within(spaceModal).getByRole("button", { name: "保存空间" }));
    await waitFor(() => {
      expect(savedSpaceBody?.accept_entry).toBeTruthy();
      expect((savedSpaceBody!.accept_entry as { kind: string }).kind).toBe("http_server");
    });

    // 3. DetailView live service pill, log fetch, anti-fake gate badge & screenshot thumbnail
    window.location.hash = "#view=detail&task=t-track3-ui";
    expect(await screen.findByText("防假验收拦截")).toBeTruthy();
    expect(screen.getByText("no_real_traffic_observed")).toBeTruthy();
    expect(screen.getByText("被测环境运行中")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "日志" }));
    expect(await screen.findByText(/server listening on 45122/)).toBeTruthy();
  });

  it("Track 4: DetailView RETRO card, LedgerView 3-tab inbox & analytics rollback, and SettingsView auto_retro_high_signal", async () => {
    const kilnSpace = {
      schema_version: 1 as const,
      id: "kiln",
      name: "Kiln",
      repo_path: "/tmp/kiln",
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
      intake_checklist: ["必须先确认移动端断点 >= 390px"],
      accept_scenarios: ["真实重启后数据不丢失"],
      default_workflow_preset: "standard_dev" as const,
    };
    let ledgersData: Record<
      string,
      {
        schema_version: 1;
        space: string;
        entries: Array<{
          id: string;
          space: string;
          rule: string;
          source_task_id: string;
          created_at: string;
          hit_count?: number;
          status?: "active" | "archived";
        }>;
      }
    > = {
      kiln: {
        schema_version: 1,
        space: "kiln",
        entries: [
          {
            id: "led-t4-1",
            space: "kiln",
            rule: "禁止擅自跳过真实验收测试",
            source_task_id: "t-track4-1",
            created_at: "2026-11-24T00:00:00Z",
            hit_count: 2,
            status: "active",
          },
        ],
      },
    };
    let retroTriggered = false;
    let proposalStatus: "pending" | "approved" | "dismissed" = "pending";
    let rolledBackAt: string | undefined;
    const makeTrack4Boot = () =>
      makeV3Bootstrap({
        spaces: { kiln: kilnSpace },
        ledgers: ledgersData,
        tasks: [
          {
            id: "t-track4-1",
            space: "kiln",
            parent_id: null,
            title: "Track 4 复盘与策略自优化演示任务",
            priority: "P1",
            effective_priority: "P1",
            track: "L2",
            workspace_mode: "git_worktree",
            status: "done",
            stage: null,
            round: null,
            active_run_id: null,
            contract_version: 1,
            depends_on: [],
            created_at: "2026-11-24T00:00:00Z",
            updated_at: "2026-11-24T01:00:00Z",
            cost_usd: 0.18,
            tokens: {
              input_tokens: 2000,
              cached_input_tokens: 1000,
              output_tokens: 200,
              total_tokens: 3200,
            },
          },
        ],
      });

    fetchMock.mockImplementation(async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();

      if (url === "/api/auth/status") {
        return jsonResponse({ ok: true, mode: "local", authenticated: true, device: null });
      }
      if (url === "/api/bootstrap") {
        return jsonResponse(makeTrack4Boot());
      }
      if (url === "/api/tasks/t-track4-1" && method === "GET") {
        return jsonResponse({
          card: {
            schema_version: 1,
            id: "t-track4-1",
            space: "kiln",
            title: "Track 4 复盘与策略自优化演示任务",
            track: "L2",
            priority: "P1",
            workspace_mode: "git_worktree",
            parent: null,
            depends_on: [],
            contract_version: 1,
            contract: {
              goal: "完成 Track 4 UI 闭环",
              end: "复盘、收件箱与效能回滚可用",
              accept_cmd: "pnpm test",
              accept_files_hash: `sha256:${"a".repeat(64)}`,
              scope: ["apps/web/**"],
              non_goals: [],
              deliver: { mode: "merge_main", cmd: null },
              human_accept: false,
              external_actions: "ask",
            },
            limits: {
              retries_per_stage: 2,
              review_rounds: 2,
              advisor_calls: 2,
              max_tokens: 150000,
            },
            created_at: "2026-11-24T00:00:00Z",
            updated_at: "2026-11-24T01:00:00Z",
          },
            state: {
              status: "done",
              stage: null,
              round: null,
              activeRunId: null,
              priority: "P1",
              effectivePriority: "P1",
              track: "L2",
              contractVersion: 1,
              updatedAt: "2026-11-24T01:00:00Z",
            },
            brief: "Track 4 演示说明",
            decisions: "",
            pendingDecision: null,
            ledgerProposals: [],
            runs: [],
            usageTurns: [],
            usage: makeTrack4Boot().usage,
            retro: {
              report: {
                schema_version: 1,
                task_id: "t-track4-1",
                space: "kiln",
                terminal_status: "done",
                mode: retroTriggered ? "ai_enriched" : "deterministic",
                high_signal: true,
                signals: ["review_rejections:1"],
                metrics: {
                  total_runs: 3,
                  rework_rounds: 1,
                  retries_count: 0,
                  review_rejections: 1,
                  accept_failures: 0,
                  escalations_count: 1,
                  track_escalated_to_l2: false,
                  steer_count: 0,
                  contract_updates: 0,
                  first_pass: false,
                  cache_hit_rate: 0.65,
                  total_cost_usd: 0.18,
                },
                attributions: [
                  {
                    category: "space_rule",
                    summary: "审查阶段暴露空间长期规则缺失",
                    earliest_preventable_stage: "review",
                    evidence: "review-1/RECEIPT.md",
                  },
                ],
                summary: retroTriggered ? "AI 深度复盘结论" : "0-Token 初筛归因结论",
                proposal_ids: ["prop-t4-1"],
                generated_at: "2026-11-24T01:00:00Z",
              },
              markdown: "# 复盘正文\n- 已归因",
            },
          });
        }
        if (url === "/api/tasks/t-track4-1/retro" && method === "POST") {
          retroTriggered = true;
          return jsonResponse({ ok: true, retro: { mode: "ai_enriched" }, markdown: "# 复盘正文" });
        }
        if (url === "/api/improvements/summary" && method === "GET") {
          return jsonResponse({
            ok: true,
            proposals: [
              {
                id: "prop-t4-1",
                status: proposalStatus,
                source: "retro",
                target_kind: "space_ledger",
                space: "kiln",
                title: "补充 UI 改版必测回滚用例",
                rationale: "t-track4-1 返工发现缺失回归提示",
                expected_impact: "降低后续同类返工",
                evidence_task_ids: ["t-track4-1"],
                payload: { rule: "UI 改版前核对现有测试选择器" },
                created_at: "2026-11-24T01:05:00Z",
              },
            ],
            analytics: {
              generated_at: "2026-11-24T01:05:00Z",
              overall: {
                task_count: 4,
                first_pass_rate: 0.75,
                avg_rework_rounds: 0.5,
                cache_hit_rate: 0.78,
                median_cost_usd: 0.15,
                p90_cost_usd: 0.32,
                accept_defect_catch_rate: 0.25,
              },
              by_space: [],
              by_role_model: [
                {
                  roster_role: "main_dev",
                  agent: "codex",
                  model: "gpt-5.4",
                  run_count: 4,
                  pass_rate: 0.75,
                  escalation_rate: 0.25,
                  cache_hit_rate: 0.78,
                  avg_cost_usd: 0.15,
                },
              ],
              by_workflow_preset: [
                {
                  preset: "standard_dev",
                  metrics: {
                    task_count: 4,
                    first_pass_rate: 0.75,
                    avg_rework_rounds: 0.5,
                    cache_hit_rate: 0.78,
                    median_cost_usd: 0.15,
                    p90_cost_usd: 0.32,
                    accept_defect_catch_rate: 0.25,
                  },
                },
              ],
            },
            policyHistory: [
              {
                schema_version: 1,
                id: "chg-t4-1",
                proposal_id: "prop-old",
                target_kind: "roster_policy",
                target_ref: "pm_orchestration",
                space: "kiln",
                summary: "降低 L1 升档阈值试点",
                applied_at: "2026-11-24T00:30:00Z",
                before_snapshot: {},
                after_snapshot: {},
                before_metrics: {
                  task_count: 3,
                  first_pass_rate: 0.9,
                  avg_rework_rounds: 0.1,
                  cache_hit_rate: 0.8,
                  median_cost_usd: 0.1,
                  p90_cost_usd: 0.2,
                  accept_defect_catch_rate: 0,
                },
                after_metrics: {
                  task_count: 3,
                  first_pass_rate: 0.5,
                  avg_rework_rounds: 1.4,
                  cache_hit_rate: 0.6,
                  median_cost_usd: 0.2,
                  p90_cost_usd: 0.3,
                  accept_defect_catch_rate: 0.2,
                },
                regression_alert: !rolledBackAt,
                regression_reasons: rolledBackAt ? [] : ["一次通过率从 90% 降至 50%"],
                ...(rolledBackAt ? { rolled_back_at: rolledBackAt } : {}),
              },
            ],
          });
        }
        if (url === "/api/improvements/proposals/prop-t4-1/approve" && method === "POST") {
          proposalStatus = "approved";
          ledgersData = {
            kiln: {
              schema_version: 1,
              space: "kiln",
              entries: [
                ...ledgersData.kiln!.entries,
                {
                  id: "led-t4-2",
                  space: "kiln",
                  rule: "UI 改版前核对现有测试选择器",
                  source_task_id: "t-track4-1",
                  created_at: "2026-11-24T01:10:00Z",
                  hit_count: 0,
                  status: "active",
                },
              ],
            },
          };
          return jsonResponse({ ok: true, proposal: { id: "prop-t4-1", status: "approved" }, change: { id: "chg-new" } });
        }
        if (url === "/api/improvements/policy-history/chg-t4-1/rollback" && method === "POST") {
          rolledBackAt = "2026-11-24T01:15:00Z";
          return jsonResponse({ ok: true, change: { id: "chg-t4-1", rolled_back_at: rolledBackAt } });
        }
        return jsonResponse({ ok: true });
      });

    // 1. DetailView RETRO card + trigger AI retro
    window.location.hash = "#view=detail&task=t-track4-1";
    render(<App />);
    expect(await screen.findByText("任务复盘（RETRO）")).toBeTruthy();
    expect(screen.getByText("0-Token 初筛归因结论")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "运行 AI 深度归因" }));
    expect(await screen.findByText("AI 深度复盘结论")).toBeTruthy();

    // 2. LedgerView default tab preserves old selectors + intake_checklist/accept_scenarios
    fireEvent.click(screen.getByRole("button", { name: /决策账本/ }));
    expect(await screen.findByText("禁止擅自跳过真实验收测试")).toBeTruthy();
    expect(screen.getByText(/必须先确认移动端断点 >= 390px/)).toBeTruthy();
    expect(screen.getByText(/真实重启后数据不丢失/)).toBeTruthy();

    // 3. Switch to 改进提案收件箱 and approve proposal
    fireEvent.click(screen.getByRole("tab", { name: /改进提案收件箱/ }));
    expect(await screen.findByText("补充 UI 改版必测回滚用例")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "批准生效" }));
    await waitFor(() => {
      expect(proposalStatus).toBe("approved");
    });

    // 4. Switch to 编排效能与回滚, verify regression alert & trigger rollback
    fireEvent.click(screen.getByRole("tab", { name: /编排效能与回滚/ }));
    expect(await screen.findByText(/一次通过率从 90% 降至 50%/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "一键回滚" }));
    await waitFor(() => {
      expect(rolledBackAt).toBeTruthy();
    });

    // 5. SettingsView Limits tab shows auto_retro_high_signal switch
    window.location.hash = "#view=settings&tab=limits";
    expect(await screen.findByLabelText("高信号终态自动 AI 归因复盘")).toBeTruthy();
  });

  it("Track 5 [B10]: renders UsageView USD budget meters, SettingsView budget & billing_mode controls, and DetailView max_cost_usd editor", async () => {
    let savedLimits: Record<string, unknown> | null = null;
    let savedProviders: ProvidersConfig | null = null;
    let patchLimitBody: Record<string, unknown> | null = null;
    let cardMaxCostUsd: number | undefined = 1.5;

    const boot = makeV3Bootstrap({
      budget: {
        daily: {
          scope: "daily",
          spent_usd: 8.4,
          limit_usd: 10,
          ratio: 0.84,
          level: "warning",
        },
        monthly: {
          scope: "monthly",
          spent_usd: 42,
          limit_usd: 100,
          ratio: 0.42,
          level: "ok",
        },
        soft_warning_ratio: 0.8,
        exclude_subscription_providers: true,
        computed_at: "2026-11-24T03:00:00Z",
      },
      tasks: [
        {
          id: "t-b10-ui",
          space: "alpha",
          parent_id: null,
          title: "Track 5 B10 预算测试卡",
          priority: "P1",
          effective_priority: "P1",
          track: "L1",
          workspace_mode: "git_worktree",
          status: "done",
          stage: null,
          round: null,
          active_run_id: null,
          contract_version: 1,
          depends_on: [],
          created_at: "2026-11-24T00:00:00Z",
          updated_at: "2026-11-24T02:00:00Z",
          cost_usd: 0.9,
          tokens: {
            input_tokens: 1000,
            cached_input_tokens: 0,
            output_tokens: 500,
            total_tokens: 1500,
          },
        },
      ],
    });

    fetchMock.mockImplementation(async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/status") {
        return jsonResponse({ ok: true, mode: "local", authenticated: true, device: null });
      }
      if (url === "/api/bootstrap") {
        return jsonResponse(boot);
      }
      if (url === "/api/settings/limits" && method === "PUT") {
        savedLimits = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return jsonResponse({ ok: true, section: "limits", data: savedLimits });
      }
      if (url === "/api/settings/providers" && method === "GET") {
        return jsonResponse({ ok: true, data: makeSampleProviders() });
      }
      if (url === "/api/settings/providers" && method === "PUT") {
        savedProviders = JSON.parse(String(init?.body ?? "{}")) as ProvidersConfig;
        return jsonResponse({ ok: true, section: "providers", data: savedProviders });
      }
      if (url === "/api/tasks/t-b10-ui" && method === "GET") {
        return jsonResponse({
          card: {
            schema_version: 1,
            id: "t-b10-ui",
            space: "alpha",
            title: "Track 5 B10 预算测试卡",
            track: "L1",
            priority: "P1",
            workspace_mode: "git_worktree",
            parent: null,
            depends_on: [],
            contract_version: 1,
            contract: {
              goal: "Test B10 UI",
              end: "Verified",
              accept_cmd: "pnpm test",
              accept_files_hash: `sha256:${"a".repeat(64)}`,
              scope: ["src/**"],
              non_goals: [],
              deliver: { mode: "merge_main", cmd: null },
              human_accept: false,
              external_actions: "ask",
            },
            limits: {
              retries_per_stage: 2,
              review_rounds: 2,
              advisor_calls: 1,
              max_tokens: 150_000,
              ...(cardMaxCostUsd !== undefined ? { max_cost_usd: cardMaxCostUsd } : {}),
            },
            created_at: "2026-11-24T00:00:00Z",
            updated_at: "2026-11-24T02:00:00Z",
          },
          state: {
            status: "done",
            stage: null,
            round: null,
            activeRunId: null,
            priority: "P1",
            effectivePriority: "P1",
            track: "L1",
            contractVersion: 1,
            updatedAt: "2026-11-24T02:00:00Z",
          },
          brief: "# B10 Brief",
          decisions: "",
          pendingDecision: null,
          ledgerProposals: [],
          runs: [],
          usageTurns: [],
          usage: boot.usage,
          budget: {
            scope: "card",
            spent_usd: 0.9,
            limit_usd: cardMaxCostUsd ?? null,
            ratio: cardMaxCostUsd ? 0.9 / cardMaxCostUsd : null,
            level: "ok",
          },
        });
      }
      if (url === "/api/tasks/t-b10-ui/limits" && method === "PATCH") {
        patchLimitBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        cardMaxCostUsd =
          typeof patchLimitBody.max_cost_usd === "number"
            ? patchLimitBody.max_cost_usd
            : undefined;
        return jsonResponse({
          ok: true,
          card: { id: "t-b10-ui" },
          budget: {
            scope: "card",
            spent_usd: 0.9,
            limit_usd: cardMaxCostUsd ?? null,
            ratio: cardMaxCostUsd ? 0.9 / cardMaxCostUsd : null,
            level: "ok",
          },
        });
      }
      return jsonResponse({ ok: true });
    });

    // 1. UsageView renders daily warning + monthly ok meters
    window.location.hash = "#view=usage";
    render(<App />);
    expect(await screen.findByLabelText("USD 预算水位")).toBeTruthy();
    expect(screen.getByText("预警")).toBeTruthy();
    expect(screen.getByText(/已排除包月订阅 Provider/)).toBeTruthy();

    // 2. DetailView edits card max_cost_usd via PATCH /api/tasks/:id/limits
    window.location.hash = "#view=detail&task=t-b10-ui";
    const cardLimitInput = (await screen.findByLabelText("单卡 USD 预算上限")) as HTMLInputElement;
    fireEvent.change(cardLimitInput, { target: { value: "3.25" } });
    fireEvent.click(screen.getByRole("button", { name: "更新上限" }));
    await waitFor(() => {
      expect(patchLimitBody).toEqual({ max_cost_usd: 3.25 });
    });

    // 3. SettingsView Limits tab saves USD budget settings & Providers tab toggles billing_mode
    window.location.hash = "#view=settings&tab=limits";
    const dailyInput = (await screen.findByLabelText("全局每日 USD 预算上限")) as HTMLInputElement;
    fireEvent.change(dailyInput, { target: { value: "25" } });
    fireEvent.click(screen.getByLabelText("包月订阅 Provider 不计入 USD 硬熔断"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(savedLimits?.daily_budget_usd).toBe(25);
      expect(savedLimits?.budget_exclude_subscription_providers).toBe(true);
    });

    window.location.hash = "#view=settings&tab=providers";
    const billingGroup = await screen.findByRole("group", { name: "Codex CLI 计费口径" });
    fireEvent.click(within(billingGroup).getByRole("button", { name: "包月订阅" }));
    fireEvent.click(screen.getByRole("button", { name: /保存 Providers/ }));
    await waitFor(() => {
      expect(
        savedProviders?.providers.find((p) => p.id === "codex")?.billing_mode,
      ).toBe("subscription");
    });
  });

  it("Track 5 [B11]: imports a GitHub Issue into IntakeView and queries PR feedback & triggers rework in DetailView", async () => {
    let importReqBody: Record<string, unknown> | null = null;
    let reworkReqBody: Record<string, unknown> | null = null;

    const importedDraft = {
      schema_version: 1,
      id: "dr-gh42",
      title: "[GH #42] Fix pipeline edge case",
      space: "alpha",
      priority: "P2",
      track: "L2",
      workspace_mode: "git_worktree",
      depends_on: [],
      external_ref: {
        provider: "github",
        repo: "zzf2333/Kiln",
        issue_number: 42,
        issue_url: "https://github.com/zzf2333/Kiln/issues/42",
      },
      contract: {
        goal: "解决 GitHub Issue zzf2333/Kiln#42：Fix pipeline edge case",
      },
      created_at: "2026-11-24T04:00:00Z",
      updated_at: "2026-11-24T04:00:00Z",
    };

    const boot = makeV3Bootstrap({
      tasks: [
        {
          id: "t-b11-ui",
          space: "alpha",
          parent_id: null,
          title: "Track 5 B11 GitHub Bridge",
          priority: "P1",
          effective_priority: "P1",
          track: "L2",
          workspace_mode: "git_worktree",
          status: "external",
          stage: "deliver",
          round: 1,
          active_run_id: null,
          contract_version: 1,
          depends_on: [],
          created_at: "2026-11-24T04:00:00Z",
          updated_at: "2026-11-24T04:05:00Z",
          cost_usd: 0,
          tokens: {
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
          },
        },
      ],
    });

    fetchMock.mockImplementation(async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/status") {
        return jsonResponse({ ok: true, mode: "local", authenticated: true, device: null });
      }
      if (url === "/api/bootstrap") {
        return jsonResponse(boot);
      }
      if (url === "/api/github/import-issue" && method === "POST") {
        importReqBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return jsonResponse({
          ok: true,
          draft: { ...importedDraft, brief_markdown: "# GitHub Issue 导入 · zzf2333/Kiln#42" },
          issue: {
            repo: "zzf2333/Kiln",
            number: 42,
            title: "Fix pipeline edge case",
            body: "Issue body",
            url: "https://github.com/zzf2333/Kiln/issues/42",
            labels: ["bug"],
            author: "alice",
          },
          brief_markdown: "# GitHub Issue 导入 · zzf2333/Kiln#42",
        });
      }
      if (url === "/api/drafts/dr-gh42" && method === "GET") {
        return jsonResponse({
          ok: true,
          draft: importedDraft,
          brief: "# GitHub Issue 导入 · zzf2333/Kiln#42",
          messages: [],
        });
      }
      if (url === "/api/tasks/t-b11-ui" && method === "GET") {
        return jsonResponse({
          card: {
            schema_version: 1,
            id: "t-b11-ui",
            space: "alpha",
            title: "Track 5 B11 GitHub Bridge",
            track: "L2",
            priority: "P1",
            workspace_mode: "git_worktree",
            parent: null,
            depends_on: [],
            external_ref: {
              provider: "github",
              repo: "zzf2333/Kiln",
              issue_number: 42,
              issue_url: "https://github.com/zzf2333/Kiln/issues/42",
              pr_number: 88,
              pr_url: "https://github.com/zzf2333/Kiln/pull/88",
              pr_branch: "kiln/t-b11-ui",
            },
            contract_version: 1,
            contract: {
              goal: "Deliver PR",
              end: "PR delivered",
              accept_cmd: "pnpm test",
              accept_files_hash: `sha256:${"a".repeat(64)}`,
              scope: ["src/bridge.ts"],
              non_goals: [],
              deliver: { mode: "merge_main", cmd: null },
              human_accept: false,
              external_actions: "ask",
            },
            limits: {
              retries_per_stage: 2,
              review_rounds: 2,
              advisor_calls: 1,
              max_tokens: 120000,
            },
            created_at: "2026-11-24T04:00:00Z",
            updated_at: "2026-11-24T04:05:00Z",
          },
          state: {
            status: "external",
            stage: "deliver",
            round: 1,
            activeRunId: null,
            priority: "P1",
            effectivePriority: "P1",
            track: "L2",
            contractVersion: 1,
            updatedAt: "2026-11-24T04:05:00Z",
          },
          brief: "# Brief",
          decisions: "",
          pendingDecision: null,
          ledgerProposals: [],
          runs: [],
          usageTurns: [],
          usage: boot.usage,
        });
      }
      if (url === "/api/tasks/t-b11-ui/pr-feedback" && method === "GET") {
        return jsonResponse({
          ok: true,
          feedback: {
            repo: "zzf2333/Kiln",
            number: 88,
            url: "https://github.com/zzf2333/Kiln/pull/88",
            title: "fix: edge case",
            state: "OPEN",
            head_branch: "kiln/t-b11-ui",
            base_branch: "main",
            mergeable: "MERGEABLE",
            fetched_at: "2026-11-24T04:10:00Z",
            checks: [
              {
                name: "ci / unit-test",
                status: "COMPLETED",
                conclusion: "FAILURE",
              },
              {
                name: "ci / lint",
                status: "COMPLETED",
                conclusion: "SUCCESS",
              },
            ],
            comments: [
              {
                id: "ic-1",
                kind: "comment",
                author: "reviewer1",
                body: "Please handle empty array edge case",
              },
            ],
          },
        });
      }
      if (url === "/api/tasks/t-b11-ui/pr-feedback/rework" && method === "POST") {
        reworkReqBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return jsonResponse({
          ok: true,
          mode: "resumed",
          taskId: "t-b11-ui",
          status: "queued",
          message: "ok",
        });
      }
      return jsonResponse({ ok: true });
    });

    // 1. IntakeView GitHub Issue import
    window.location.hash = "#view=intake";
    render(<App />);
    const ghToggleBtn = await screen.findByRole("button", { name: "从 GitHub Issue 导入" });
    fireEvent.click(ghToggleBtn);
    const issueInput = await screen.findByLabelText("GitHub Issue 编号或链接");
    fireEvent.change(issueInput, { target: { value: "#42" } });
    fireEvent.click(screen.getByRole("button", { name: "导入" }));
    await waitFor(() => {
      expect(importReqBody).toEqual({ space: "alpha", issue: "#42" });
    });

    // 2. DetailView GitHub external_ref links + PR feedback query & rework
    window.location.hash = "#view=detail&task=t-b11-ui";
    expect(await screen.findByText("Issue #42")).toBeTruthy();
    expect(screen.getByText("PR #88")).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "检查 PR 状态与评论" }));
    expect(await screen.findByText("ci / unit-test")).toBeTruthy();
    expect(screen.getByText("Please handle empty array edge case")).toBeTruthy();

    const commentCheckbox = screen
      .getByText("Please handle empty array edge case")
      .closest("label")!
      .querySelector("input[type='checkbox']") as HTMLInputElement;
    fireEvent.click(commentCheckbox);

    const extraNoteInput = screen.getByLabelText("补充 PR 返工说明");
    fireEvent.change(extraNoteInput, { target: { value: "Fix unit check" } });

    fireEvent.click(screen.getByRole("button", { name: "转入返工" }));
    await waitFor(() => {
      expect(reworkReqBody).toEqual({
        pr_ref: "88",
        failed_check_names: ["ci / unit-test"],
        comment_ids: ["ic-1"],
        extra_note: "Fix unit check",
        interrupt: false,
      });
    });
  });

  it("Track 5 [B12.1]: configures LimitsView stall_timeout_sec and renders DetailView stall_warning badge & timeline event", async () => {
    const savedLimitsPayloads: Array<Record<string, unknown>> = [];

    const boot = makeV3Bootstrap({
      tasks: [
        {
          id: "t-b12-stall",
          space: "alpha",
          parent_id: null,
          title: "Track 5 B12.1 Witness",
          priority: "P1",
          effective_priority: "P1",
          track: "L2",
          workspace_mode: "git_worktree",
          status: "running",
          stage: "implement",
          round: 1,
          active_run_id: "r-stall-1",
          contract_version: 1,
          depends_on: [],
          created_at: "2026-11-24T04:00:00Z",
          updated_at: "2026-11-24T04:10:00Z",
          cost_usd: 0,
          tokens: {
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
          },
        },
      ],
    });

    fetchMock.mockImplementation(async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/status") {
        return jsonResponse({ ok: true, mode: "local", authenticated: true, device: null });
      }
      if (url === "/api/bootstrap") {
        return jsonResponse(boot);
      }
      if (url === "/api/settings/limits" && method === "PUT") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        savedLimitsPayloads.push(body);
        return jsonResponse({ ok: true, section: "limits", data: body });
      }
      if (url === "/api/tasks/t-b12-stall" && method === "GET") {
        return jsonResponse({
          card: {
            schema_version: 1,
            id: "t-b12-stall",
            space: "alpha",
            title: "Track 5 B12.1 Witness",
            track: "L2",
            priority: "P1",
            workspace_mode: "git_worktree",
            parent: null,
            depends_on: [],
            contract_version: 1,
            contract: {
              goal: "Test Witness UI",
              end: "Done",
              accept_cmd: "pnpm test",
              accept_files_hash: `sha256:${"a".repeat(64)}`,
              scope: ["src/index.ts"],
              non_goals: [],
              deliver: { mode: "merge_main", cmd: null },
              human_accept: false,
              external_actions: "ask",
            },
            limits: {
              retries_per_stage: 2,
              review_rounds: 2,
              advisor_calls: 1,
              max_tokens: 150_000,
            },
            created_at: "2026-11-24T04:00:00Z",
            updated_at: "2026-11-24T04:10:00Z",
          },
          state: {
            status: "running",
            stage: "implement",
            round: 1,
            activeRunId: "r-stall-1",
            priority: "P1",
            effectivePriority: "P1",
            track: "L2",
            contractVersion: 1,
            updatedAt: "2026-11-24T04:10:00Z",
          },
          brief: "# Brief",
          decisions: "",
          pendingDecision: null,
          ledgerProposals: [],
          runs: [
            {
              dirName: "001-implement",
              status: "active",
              meta: {
                schema_version: 1,
                run_id: "r-stall-1",
                task_id: "t-b12-stall",
                stage: "implement",
                round: 1,
                contract_version: 1,
                role: "worker",
                agent: "codex",
                model: "gpt-5.4",
                backend_id: "codex-acp",
                session_ref: { backendId: "codex-acp", sessionId: "s-1" },
                started_at: "2026-11-24T04:00:00Z",
              },
              gate: null,
              receipt: null,
              handoff: null,
              events: [
                { kind: "thinking", at: "2026-11-24T04:00:05Z" },
                {
                  kind: "stall_warning",
                  at: "2026-11-24T04:10:10Z",
                  phase: "soft_warning",
                  silentSec: 605,
                  probeAlive: true,
                  probeStatus: "running",
                  action: "warn",
                  detail: "No run events for 605s while session status is running",
                },
              ],
              eventsCount: 2,
              hasReceipt: false,
            },
          ],
          usageTurns: [],
          usage: boot.usage,
        });
      }
      return jsonResponse({ ok: true });
    });

    // 1. SettingsView saves stall_timeout_sec = 0 and 300
    window.location.hash = "#view=settings&tab=limits";
    render(<App />);
    const stallInput = (await screen.findByLabelText(
      "Run 心跳停滞静默阈值（秒）",
    )) as HTMLInputElement;
    expect(stallInput.value).toBe("600");

    fireEvent.change(stallInput, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(savedLimitsPayloads[0]?.stall_timeout_sec).toBe(0);
    });
    expect(await screen.findByText("已保存 config/limits.yaml")).toBeTruthy();

    fireEvent.change(stallInput, { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(savedLimitsPayloads[1]?.stall_timeout_sec).toBe(300);
    });

    // 2. DetailView shows soft stall badge and renders stall_warning in expanded raw events
    window.location.hash = "#view=detail&task=t-b12-stall";
    expect(await screen.findByText("停滞告警 · 静默 605s")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /展开原始执行事件/ }));
    expect(
      await screen.findByText(/\[stall_warning · 软告警\] silent=605s probe=alive/),
    ).toBeTruthy();
  });

  it("Track 5 [B12.2]: renders BoardView serial merge queue bar and DetailView merge queue position badge", async () => {
    const boot = makeV3Bootstrap({
      tasks: [
        {
          id: "t-mq-1",
          space: "alpha",
          parent_id: null,
          title: "Slice A Merge",
          priority: "P1",
          effective_priority: "P1",
          track: "L1",
          workspace_mode: "git_worktree",
          status: "running",
          stage: "deliver",
          round: 1,
          active_run_id: "run-t-mq-1-deliver",
          contract_version: 1,
          depends_on: [],
          created_at: "2026-11-24T04:00:00Z",
          updated_at: "2026-11-24T04:01:00Z",
          cost_usd: 0,
          tokens: {
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
          },
        },
        {
          id: "t-mq-2",
          space: "alpha",
          parent_id: null,
          title: "Slice B Queue",
          priority: "P2",
          effective_priority: "P2",
          track: "L1",
          workspace_mode: "git_worktree",
          status: "queued",
          stage: "deliver",
          round: 1,
          active_run_id: null,
          contract_version: 1,
          depends_on: [],
          created_at: "2026-11-24T04:00:00Z",
          updated_at: "2026-11-24T04:02:00Z",
          cost_usd: 0,
          tokens: {
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
          },
        },
      ],
      mergeQueue: [
        {
          task_id: "t-mq-1",
          space: "alpha",
          title: "Slice A Merge",
          state: "merging",
          position: 1,
          priority: "P1",
        },
        {
          task_id: "t-mq-2",
          space: "alpha",
          title: "Slice B Queue",
          state: "queued",
          position: 2,
          priority: "P2",
        },
      ],
    });

    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/auth/status") {
        return jsonResponse({ ok: true, mode: "local", authenticated: true, device: null });
      }
      if (url === "/api/bootstrap") {
        return jsonResponse(boot);
      }
      if (url === "/api/tasks/t-mq-2") {
        return jsonResponse({
          card: {
            schema_version: 1,
            id: "t-mq-2",
            space: "alpha",
            title: "Slice B Queue",
            track: "L1",
            priority: "P2",
            workspace_mode: "git_worktree",
            parent: null,
            depends_on: [],
            contract_version: 1,
            contract: {
              goal: "Test merge queue detail",
              end: "Done",
              accept_cmd: "echo ok",
              accept_files_hash: `sha256:${"a".repeat(64)}`,
              scope: ["src/b.ts"],
              non_goals: [],
              deliver: { mode: "merge_main", cmd: null },
              human_accept: false,
              external_actions: "ask",
            },
            limits: {
              retries_per_stage: 2,
              review_rounds: 2,
              advisor_calls: 1,
              max_tokens: 150_000,
            },
            created_at: "2026-11-24T04:00:00Z",
            updated_at: "2026-11-24T04:02:00Z",
          },
          state: {
            status: "queued",
            stage: "deliver",
            round: 1,
            activeRunId: null,
            priority: "P2",
            effectivePriority: "P2",
            track: "L1",
            contractVersion: 1,
            updatedAt: "2026-11-24T04:02:00Z",
          },
          brief: "# Brief",
          decisions: "",
          pendingDecision: null,
          ledgerProposals: [],
          runs: [],
          usageTurns: [],
          usage: boot.usage,
          mergeQueueEntry: {
            task_id: "t-mq-2",
            space: "alpha",
            title: "Slice B Queue",
            state: "queued",
            position: 2,
            priority: "P2",
          },
        });
      }
      return jsonResponse({ ok: true });
    });

    window.location.hash = "#view=board";
    render(<App />);
    const mqBar = await screen.findByLabelText("串行合并队列");
    expect(within(mqBar).getByText("正在合入")).toBeTruthy();
    expect(within(mqBar).getByText("排队 #2")).toBeTruthy();

    fireEvent.click(within(mqBar).getByText("Slice B Queue"));
    expect(await screen.findByText("合并队列 #2")).toBeTruthy();
  });

  it("Track 5 [B12.3]: renders ScriptDrawer detected local preview URLs and BoardView attention signals", async () => {
    const overdueIso = new Date(Date.now() - 45 * 60_000).toISOString();
    const freshIso = new Date(Date.now() - 60_000).toISOString();

    const boot = makeV3Bootstrap({
      spaces: {
        alpha: {
          schema_version: 1,
          id: "alpha",
          name: "Alpha",
          repo_path: "/tmp/alpha",
          default_branch: "main",
          copy_untracked: [],
          clone_deps: [],
          freeze_patterns: [],
          scripts: {
            dev: "pnpm dev",
          },
        },
      },
      limits: {
        schema_version: 1,
        max_concurrent_slots: 5,
        p0_extra_slot: true,
        max_waiting_wip: 1,
        retries_per_stage: 2,
        review_rounds: 2,
        advisor_calls: 1,
        max_card_tokens: 250_000,
      },
      pendingDecisions: [
        {
          id: "dec-overdue",
          task_id: "t-wait-1",
          contract_version: 1,
          reason: "budget_exceeded",
          category: "budget_exceeded",
          question: "Budget exceeded",
          options: [
            {
              id: "opt-ok",
              label: "Raise limit",
              action: "resume",
              recommended: true,
            },
          ],
          created_at: overdueIso,
        },
      ],
      tasks: [
        {
          id: "t-wait-1",
          space: "alpha",
          parent_id: null,
          title: "Waiting Overdue Task",
          priority: "P1",
          effective_priority: "P1",
          track: "L1",
          workspace_mode: "git_worktree",
          status: "waiting",
          stage: "implement",
          round: 1,
          active_run_id: null,
          contract_version: 1,
          depends_on: [],
          created_at: overdueIso,
          updated_at: overdueIso,
          cost_usd: 0,
          tokens: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
        {
          id: "t-run-stall",
          space: "alpha",
          parent_id: null,
          title: "Running Stall Signal",
          priority: "P1",
          effective_priority: "P1",
          track: "L1",
          workspace_mode: "git_worktree",
          status: "running",
          stage: "implement",
          round: 1,
          active_run_id: "r-st1",
          contract_version: 1,
          depends_on: [],
          stall_silent_sec: 630,
          created_at: freshIso,
          updated_at: freshIso,
          cost_usd: 0,
          tokens: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
        {
          id: "t-q-dep",
          space: "alpha",
          parent_id: null,
          title: "Queued On Dep",
          priority: "P1",
          effective_priority: "P1",
          track: "L1",
          workspace_mode: "git_worktree",
          status: "queued",
          stage: "implement",
          round: 1,
          active_run_id: null,
          contract_version: 1,
          depends_on: ["t-wait-1"],
          created_at: freshIso,
          updated_at: freshIso,
          cost_usd: 0,
          tokens: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
        {
          id: "t-q-wip",
          space: "alpha",
          parent_id: null,
          title: "Queued On Attention Gate",
          priority: "P2",
          effective_priority: "P2",
          track: "L1",
          workspace_mode: "git_worktree",
          status: "queued",
          stage: "implement",
          round: 1,
          active_run_id: null,
          contract_version: 1,
          depends_on: [],
          created_at: freshIso,
          updated_at: freshIso,
          cost_usd: 0,
          tokens: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      ],
    });
    boot.settings!.limits!.max_waiting_wip = 1;

    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/auth/status") {
        return jsonResponse({ ok: true, mode: "local", authenticated: true, device: null });
      }
      if (url === "/api/bootstrap") {
        return jsonResponse(boot);
      }
      if (String(url).startsWith("/api/scripts")) {
        return jsonResponse({
          ok: true,
          runs: [
            {
              scriptRunId: "sr-dev-1",
              spaceId: "alpha",
              taskId: "t-run-stall",
              script: "dev",
              command: "pnpm dev",
              cwd: "/tmp/alpha",
              running: true,
              exitCode: null,
              startedAt: freshIso,
              endedAt: null,
              outputTail: "Local: http://localhost:5173/app",
              detectedUrls: ["http://localhost:5173/app"],
            },
          ],
        });
      }
      if (url === "/api/tasks/t-run-stall") {
        return jsonResponse({
          card: {
            schema_version: 1,
            id: "t-run-stall",
            space: "alpha",
            title: "Running Stall Signal",
            track: "L1",
            priority: "P1",
            workspace_mode: "git_worktree",
            parent: null,
            depends_on: [],
            contract_version: 1,
            contract: {
              goal: "Test B12.3",
              end: "Done",
              accept_cmd: "echo ok",
              accept_files_hash: `sha256:${"a".repeat(64)}`,
              scope: ["src/**"],
              non_goals: [],
              deliver: { mode: "manual", cmd: null },
              human_accept: false,
              external_actions: "ask",
            },
            limits: {
              retries_per_stage: 2,
              review_rounds: 2,
              advisor_calls: 1,
              max_tokens: 150_000,
            },
            created_at: freshIso,
            updated_at: freshIso,
          },
          state: {
            status: "running",
            stage: "implement",
            round: 1,
            activeRunId: "r-st1",
            priority: "P1",
            effectivePriority: "P1",
            track: "L1",
            contractVersion: 1,
            updatedAt: freshIso,
          },
          brief: "# Brief",
          decisions: "",
          pendingDecision: null,
          ledgerProposals: [],
          runs: [],
          usageTurns: [],
          usage: boot.usage,
        });
      }
      return jsonResponse({ ok: true });
    });

    // 1. BoardView renders waiting category + overdue class, stall chip, and queued block reasons
    window.location.hash = "#view=board";
    render(<App />);
    expect(await screen.findByText("预算熔断")).toBeTruthy();
    const waitBadge = screen.getByText(/等了 /);
    expect(waitBadge.className).toContain("is-overdue");
    expect(screen.getByText("停滞告警 · 630s")).toBeTruthy();
    expect(screen.getByText("阻塞于前置依赖：t-wait-1")).toBeTruthy();
    expect(screen.getByText("注意力闸门限流（待决 1/1）")).toBeTruthy();

    // 2. DetailView + ScriptDrawer shows detected loopback preview URL link
    window.location.hash = "#view=detail&task=t-run-stall";
    fireEvent.click(await screen.findByRole("button", { name: /脚本/ }));
    const previewBar = await screen.findByLabelText("探测到的本机预览地址");
    const link = within(previewBar).getByRole("link", {
      name: /http:\/\/localhost:5173\/app/,
    }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("http://localhost:5173/app");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("Track 5 [B12.4]: DetailView renders ReviewChecklistPanel, requires rationale for waive, and submits rework+waive resolution", async () => {
    const boot = makeV3Bootstrap();
    boot.tasks = [
      {
        id: "t-b12-4",
        space: "alpha",
        parent_id: null,
        title: "Checklist Task",
        priority: "P1",
        effective_priority: "P1",
        track: "L2",
        workspace_mode: "git_worktree",
        status: "waiting",
        stage: "review",
        round: 1,
        active_run_id: null,
        contract_version: 1,
        depends_on: [],
        created_at: "2026-11-24T04:00:00Z",
        updated_at: "2026-11-24T04:05:00Z",
        tokens: {
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
        },
        cost_usd: 0,
        tokens_by_model: {},
        summary: "Test B12.4",
      },
    ];

    let postedResolveBody: unknown = null;
    let resolveCalled = false;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/status") {
        return jsonResponse({ ok: true, mode: "local", authenticated: true, device: null });
      }
      if (url === "/api/bootstrap") {
        return jsonResponse(boot);
      }
      if (url === "/api/tasks/t-b12-4" && method === "GET") {
        return jsonResponse({
          card: {
            schema_version: 1,
            id: "t-b12-4",
            space: "alpha",
            title: "Checklist Task",
            track: "L2",
            priority: "P1",
            workspace_mode: "git_worktree",
            parent: null,
            depends_on: [],
            contract_version: 1,
            contract: {
              goal: "Test B12.4",
              end: "Done",
              accept_cmd: "echo ok",
              accept_files_hash: `sha256:${"a".repeat(64)}`,
              scope: ["src/**"],
              non_goals: [],
              deliver: { mode: "merge_main", cmd: null },
              human_accept: true,
              external_actions: "ask",
            },
            limits: {
              retries_per_stage: 2,
              review_rounds: 2,
              advisor_calls: 1,
              max_tokens: 150_000,
            },
            created_at: "2026-11-24T04:00:00Z",
            updated_at: "2026-11-24T04:05:00Z",
          },
          state: {
            status: "waiting",
            stage: "review",
            round: 1,
            activeRunId: null,
            priority: "P1",
            effectivePriority: "P1",
            track: "L2",
            contractVersion: 1,
            updatedAt: "2026-11-24T04:05:00Z",
          },
          brief: "# Brief",
          decisions: "",
          pendingDecision: {
            id: "dec-chk-1",
            task_id: "t-b12-4",
            contract_version: 1,
            reason: "review_rounds_exhausted",
            category: "review_escalation",
            question: "Review needs action",
            options: [
              { id: "opt-1", label: "Rework", action: "resume", target_stage: "implement", recommended: true },
            ],
            created_at: "2026-11-24T04:05:00Z",
          },
          ledgerProposals: [],
          reviewChecklist: [
            {
              id: "002-review:rf-1",
              run_dir: "002-review",
              source: "review",
              severity: "P0",
              title: "Missing CSRF guard",
              location: "src/server.ts",
              detail: "State-changing POST allows missing Origin",
            },
            {
              id: "003-accept:sc-1",
              run_dir: "003-accept",
              source: "accept",
              severity: "fail",
              title: "Submit button click",
              detail: "Timed out waiting for modal",
            },
          ],
          runs: [],
          usageTurns: [],
          usage: boot.usage,
        });
      }
      if (url === "/api/tasks/t-b12-4/checklist/resolve" && method === "POST") {
        resolveCalled = true;
        postedResolveBody = JSON.parse(String(init?.body ?? "{}"));
        return jsonResponse({
          ok: true,
          mode: "rework_queued",
          taskId: "t-b12-4",
          status: "queued",
          stage: "implement",
          reviewChecklist: [],
          message: "ok",
        });
      }
      return jsonResponse({ ok: true });
    });

    window.location.hash = "#view=detail&task=t-b12-4";
    render(<App />);

    const panel = await screen.findByLabelText("审查与验收缺陷交互清单");
    expect(within(panel).getByText("Missing CSRF guard")).toBeTruthy();
    expect(within(panel).getByText("src/server.ts")).toBeTruthy();
    expect(within(panel).getByText("Submit button click")).toBeTruthy();

    // Mark second item as waive WITHOUT rationale -> client validation blocks submit
    const scGroup = within(panel).getByRole("group", { name: "处理条目 Submit button click" });
    fireEvent.click(within(scGroup).getByRole("button", { name: "确认豁免" }));
    fireEvent.click(within(panel).getByRole("button", { name: /保存豁免记录/ }));
    expect(await within(panel).findByRole("alert")).toBeTruthy();
    expect(resolveCalled).toBe(false);

    // Fill waive rationale + mark first item as rework -> submits cleanly
    const waiveInput = within(panel).getByLabelText("豁免理由：Submit button click");
    fireEvent.change(waiveInput, { target: { value: "Flaky fixture timing" } });
    const revGroup = within(panel).getByRole("group", { name: "处理条目 Missing CSRF guard" });
    fireEvent.click(within(revGroup).getByRole("button", { name: "打回修复" }));

    fireEvent.click(within(panel).getByRole("button", { name: /提交并打回修复/ }));
    await waitFor(() => {
      expect(resolveCalled).toBe(true);
    });
    expect(postedResolveBody).toEqual({
      items: [
        { item_id: "002-review:rf-1", disposition: "rework" },
        {
          item_id: "003-accept:sc-1",
          disposition: "waive",
          rationale: "Flaky fixture timing",
        },
      ],
      interrupt: false,
      advance_after_waive: false,
    });
  });
});
