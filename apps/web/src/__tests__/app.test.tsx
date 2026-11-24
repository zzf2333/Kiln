// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapResponse, TaskDetailResponse } from "../api/types";
import { App } from "../app";
import { detectComposerTrigger } from "../components/ChatComposer";
import { ChatTimeline } from "../components/ChatTimeline";
import { MarkdownContent } from "../components/MarkdownContent";
import { fmtTime } from "../state/format";

type MockFetchHandler = (url: string, init?: RequestInit) => Promise<Response> | Response;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeBaseBootstrap(overrides: Partial<BootstrapResponse> = {}): BootstrapResponse {
  return {
    tasks: [],
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
      roles: {
        intake: {
          agent: "codex",
          model: "gpt-5.4",
          reasoning_effort: "medium",
          allow_full_access_fallback: false,
        },
        worker: {
          agent: "pi",
          model: "claude-sonnet-4-6",
          reasoning_effort: "medium",
          fallback: { agent: "codex", model: "gpt-5.4-mini" },
          allow_full_access_fallback: false,
        },
        reviewer: {
          agent: "codex",
          model: "gpt-5.4",
          reasoning_effort: "high",
          fallback: { agent: "pi", model: "claude-opus-4-6" },
          allow_full_access_fallback: false,
        },
        verifier: {
          agent: "pi",
          model: "claude-sonnet-4-6",
          reasoning_effort: "medium",
          allow_full_access_fallback: false,
        },
        triage: {
          agent: "codex",
          model: "gpt-5.4-mini",
          reasoning_effort: "low",
          allow_full_access_fallback: false,
        },
        advisor: {
          agent: "codex",
          model: "gpt-5.4-pro",
          reasoning_effort: "xhigh",
          allow_full_access_fallback: false,
        },
        resolver: {
          agent: "codex",
          model: "gpt-5.4",
          reasoning_effort: "high",
          allow_full_access_fallback: false,
        },
      },
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
        "gpt-5.4-pro": { in: 15, cached: 1.5, out: 120 },
        "gpt-5.4-mini": { in: 0.25, cached: 0.025, out: 2 },
        "claude-sonnet-4-6": { in: 3, cached: 0.3, out: 15 },
        "claude-opus-4-6": { in: 15, cached: 1.5, out: 75 },
      },
    },
    usage: {
      inputTokens: 1_000_000,
      cachedInputTokens: 400_000,
      outputTokens: 100_000,
      totalTokens: 1_100_000,
      costUsd: 1.8,
      byAgent: {
        codex: {
          inputTokens: 1_000_000,
          cachedInputTokens: 400_000,
          outputTokens: 100_000,
          totalTokens: 1_100_000,
          costUsd: 1.8,
        },
      },
      byModel: {
        "gpt-5.4": {
          inputTokens: 1_000_000,
          cachedInputTokens: 400_000,
          outputTokens: 100_000,
          totalTokens: 1_100_000,
          costUsd: 1.8,
        },
      },
    },
    runningCount: 0,
    agents: [
      {
        id: "codex",
        label: "Codex",
        capabilities: {
          interactiveChat: true,
          approvals: false,
          mcpInjection: true,
          usageCacheBreakdown: true,
          interrupt: true,
        },
        modes: [
          { id: "auto", label: "Auto" },
          { id: "full-access", label: "Full Access", isFullAccess: true },
        ],
        models: [
          { id: "gpt-5.4", thinkingOptions: ["low", "medium", "high", "xhigh"] },
          { id: "gpt-5.4-mini", thinkingOptions: ["low", "medium"] },
          { id: "gpt-5.4-pro", thinkingOptions: ["high", "xhigh"] },
        ],
      },
      {
        id: "pi",
        label: "Pi",
        capabilities: {
          interactiveChat: true,
          approvals: false,
          mcpInjection: false,
          usageCacheBreakdown: true,
          interrupt: true,
        },
        modes: [],
        models: [
          { id: "claude-sonnet-4-6", thinkingOptions: ["low", "medium", "high"] },
          { id: "claude-opus-4-6", thinkingOptions: ["medium", "high"] },
        ],
      },
      {
        id: "antigravity",
        label: "Antigravity",
        capabilities: {
          interactiveChat: true,
          approvals: false,
          mcpInjection: false,
          usageCacheBreakdown: false,
          interrupt: true,
        },
        modes: [{ id: "full-access", label: "Full access", isFullAccess: true }],
        models: [{ id: "gemini-3-pro", thinkingOptions: ["low", "high"] }],
      },
    ],
    backends: [{ backendId: "paseo", connected: true, url: "ws://127.0.0.1:6767" }],
    ...overrides,
  };
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

let fetchMock: ReturnType<typeof vi.fn<MockFetchHandler>>;

beforeEach(() => {
  MockEventSource.instances = [];
  window.localStorage.clear();
  window.location.hash = "";
  window.history.replaceState(null, "", "/");
  document.body.className = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-pref");
  document.documentElement.style.colorScheme = "";
  (window as unknown as { EventSource?: unknown }).EventSource = MockEventSource;
  fetchMock = vi.fn<MockFetchHandler>(async () => jsonResponse(makeBaseBootstrap()));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("@kiln/web M2-S3 MVP Workbench", () => {
  it("renders 4 board columns, collapses non-waiting child slices under parent, floats waiting child slices, excludes paused from waiting count, and counts only running leaves", async () => {
    const now = new Date().toISOString();
    const bootstrap = makeBaseBootstrap({
      tasks: [
        {
          id: "t-parent",
          space: "kiln",
          parent_id: null,
          title: "大需求父卡",
          priority: "P1",
          effective_priority: "P1",
          track: "L2",
          workspace_mode: "git_worktree",
          status: "running",
          stage: "implement",
          round: 1,
          active_run_id: "r-parent",
          contract_version: 1,
          depends_on: [],
          created_at: now,
          updated_at: now,
          tokens: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          cost_usd: 0,
        },
        {
          id: "t-child-run",
          space: "kiln",
          parent_id: "t-parent",
          title: "子切片运行中（应被收拢）",
          priority: "P1",
          effective_priority: "P1",
          track: "L2",
          workspace_mode: "git_worktree",
          status: "running",
          stage: "implement",
          round: 1,
          active_run_id: "r-c1",
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
        {
          id: "t-child-wait",
          space: "kiln",
          parent_id: "t-parent",
          title: "子切片待决（强制浮出）",
          priority: "P0",
          effective_priority: "P0",
          track: "L2",
          workspace_mode: "git_worktree",
          status: "waiting",
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
        {
          id: "t-paused",
          space: "kiln",
          parent_id: null,
          title: "手动暂停任务",
          priority: "P2",
          effective_priority: "P2",
          track: "L1",
          workspace_mode: "scratch_dir",
          status: "paused",
          stage: "implement",
          round: 1,
          active_run_id: null,
          contract_version: 1,
          depends_on: [],
          created_at: now,
          updated_at: now,
          tokens: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          cost_usd: 0,
        },
        {
          id: "t-ext",
          space: "kiln",
          parent_id: null,
          title: "外部 PR 等待",
          priority: "P2",
          effective_priority: "P2",
          track: "L2",
          workspace_mode: "git_worktree",
          status: "external",
          stage: "deliver",
          round: 1,
          active_run_id: null,
          contract_version: 1,
          depends_on: [],
          created_at: now,
          updated_at: now,
          tokens: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          cost_usd: 0,
        },
        {
          id: "t-done",
          space: "local",
          parent_id: null,
          title: "已完成任务",
          priority: "P3",
          effective_priority: "P3",
          track: "L1",
          workspace_mode: "scratch_dir",
          status: "done",
          stage: "deliver",
          round: 1,
          active_run_id: null,
          contract_version: 1,
          depends_on: [],
          created_at: now,
          updated_at: now,
          tokens: {
            input_tokens: 500,
            cached_input_tokens: 0,
            output_tokens: 100,
            total_tokens: 600,
          },
          cost_usd: 0.005,
        },
        {
          id: "t-cancelled",
          space: "local",
          parent_id: null,
          title: "已取消不应展示",
          priority: "P3",
          effective_priority: "P3",
          track: "L1",
          workspace_mode: "scratch_dir",
          status: "cancelled",
          stage: null,
          round: null,
          active_run_id: null,
          contract_version: 1,
          depends_on: [],
          created_at: now,
          updated_at: now,
          tokens: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          cost_usd: 0,
        },
      ],
      pendingDecisions: [
        {
          id: "dec-child-1",
          task_id: "t-child-wait",
          contract_version: 1,
          reason: "scope_change",
          category: "product_commitment",
          question: "子切片需要你确认是否修改接口？",
          options: [
            {
              id: "opt-1",
              label: "确认继续",
              action: "resume",
              recommended: true,
            },
          ],
          created_at: now,
        },
      ],
    });

    fetchMock.mockImplementation(async () => jsonResponse(bootstrap));
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("大需求父卡")).toBeTruthy();
    });

    // Collapsed by default: running child slice hidden, waiting child slice forced visible
    expect(screen.queryByText("子切片运行中（应被收拢）")).toBeNull();
    expect(screen.getByText("子切片待决（强制浮出）")).toBeTruthy();

    // Paused stays in active column, not waiting; cancelled never displayed
    expect(screen.getByText("手动暂停任务")).toBeTruthy();
    expect(screen.getByText("外部 PR 等待")).toBeTruthy();
    expect(screen.getByText("已完成任务")).toBeTruthy();
    expect(screen.queryByText("已取消不应展示")).toBeNull();

    // Topbar running count only counts running leaf task (1), paused (1), waiting (1)
    expect(screen.getByText("1 个任务在跑，1 个已暂停，1 件事等你决定")).toBeTruthy();
    expect(document.getElementById("nInbox")?.textContent).toBe("1");

    // Expand slices -> running child becomes visible
    fireEvent.click(screen.getByRole("button", { name: "展开切片" }));
    expect(screen.getByText("子切片运行中（应被收拢）")).toBeTruthy();

    // M2+ entries in sidebar are disabled and do not navigate
    const consoleBtn = screen.getByRole("button", { name: /执行台/ });
    expect((consoleBtn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(consoleBtn);
    expect(screen.getByRole("heading", { name: "总览" })).toBeTruthy();
  });

  it("safely escapes angle-bracket XSS strings such as <input><script> in titles and code blocks", async () => {
    const xssTitle = `<input><script>window.__xss=1</script>修复输入校验`;
    const xssCode = `<script>alert("boom")</script>\nconst x = "<img onerror=alert(1)>";`;
    const now = new Date().toISOString();

    const detail: TaskDetailResponse = {
      card: {
        schema_version: 1,
        id: "t-xss",
        title: xssTitle,
        space: "kiln",
        priority: "P1",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: xssTitle,
          end: "合入 main",
          accept_cmd: "pnpm test",
          accept_files_hash: "sha256:abc",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: {
          retries_per_stage: 2,
          review_rounds: 2,
          advisor_calls: 1,
          max_tokens: 250_000,
        },
        created_at: now,
        updated_at: now,
      },
      state: {
        status: "running",
        stage: "implement",
        round: 1,
        activeRunId: "run-xss",
        priority: "P1",
        effectivePriority: "P1",
        track: "L2",
        contractVersion: 1,
        updatedAt: now,
      },
      brief: xssTitle,
      decisions: "",
      pendingDecision: null,
      ledgerProposals: [],
      runs: [
        {
          dirName: "001-implement",
          meta: {
            schema_version: 1,
            run_id: "run-xss",
            task_id: "t-xss",
            stage: "implement",
            round: 1,
            role: "worker",
            contract_version: 1,
            backend_id: "paseo",
            agent: "codex",
            model: "gpt-5.4",
            session_ref: { backendId: "paseo", sessionId: "s1" },
            started_at: now,
          },
          handoff: null,
          receipt: `---\nrun_id: run-xss\n---\n\`\`\`ts\n${xssCode}\n\`\`\``,
          gate: null,
          events: [],
          eventsCount: 0,
        },
      ],
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
    };

    const bootstrap = makeBaseBootstrap({
      tasks: [
        {
          id: "t-xss",
          space: "kiln",
          parent_id: null,
          title: xssTitle,
          priority: "P1",
          effective_priority: "P1",
          track: "L2",
          workspace_mode: "git_worktree",
          status: "running",
          stage: "implement",
          round: 1,
          active_run_id: "run-xss",
          contract_version: 1,
          depends_on: [],
          created_at: now,
          updated_at: now,
          tokens: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          cost_usd: 0,
        },
      ],
    });

    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/bootstrap") return jsonResponse(bootstrap);
      if (url === "/api/tasks/t-xss") return jsonResponse(detail);
      return jsonResponse({});
    });

    const { container } = render(<App />);
    await waitFor(() => {
      expect(screen.getByText(xssTitle)).toBeTruthy();
    });

    // No injected <script> or <input> inside the board card
    expect(container.querySelectorAll("script")).toHaveLength(0);
    expect(container.querySelectorAll(".card input")).toHaveLength(0);

    // Open detail view -> code block & title remain verbatim text
    fireEvent.click(screen.getByText(xssTitle));
    await waitFor(() => {
      const codeEls = Array.from(container.querySelectorAll(".code"));
      expect(codeEls.some((el) => el.textContent?.includes(xssCode))).toBe(true);
    });
    expect(container.querySelectorAll("script")).toHaveLength(0);
    expect(container.querySelectorAll(".reader input")).toHaveLength(0);
  });

  it("DecisionBox defaults apply_ledger_rule to false and submits true only when checked", async () => {
    const now = new Date().toISOString();
    const bootstrap = makeBaseBootstrap({
      tasks: [
        {
          id: "t-dec",
          space: "kiln",
          parent_id: null,
          title: "路由结构决策",
          priority: "P1",
          effective_priority: "P1",
          track: "L2",
          workspace_mode: "git_worktree",
          status: "waiting",
          stage: "implement",
          round: 1,
          active_run_id: null,
          contract_version: 1,
          depends_on: [],
          created_at: now,
          updated_at: now,
          tokens: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          cost_usd: 0,
        },
      ],
      pendingDecisions: [
        {
          id: "dec-101",
          task_id: "t-dec",
          contract_version: 1,
          reason: "product_commitment",
          category: "product",
          question: "是否保留 /posts/:id 路由？",
          options: [
            {
              id: "opt-keep",
              label: "保留 /posts/:id",
              action: "resume",
              recommended: true,
              ledger_rule: "博客文章统一保留 /posts/:id",
            },
            {
              id: "opt-cancel",
              label: "取消此任务",
              action: "cancel",
              recommended: false,
            },
          ],
          created_at: now,
        },
      ],
    });

    const decideBodies: Array<Record<string, unknown>> = [];
    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/bootstrap") return jsonResponse(bootstrap);
      if (url === "/api/tasks/t-dec/decide") {
        decideBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse({ ok: true });
      }
      return jsonResponse({});
    });

    window.location.hash = "#view=inbox";
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("是否保留 /posts/:id 路由？")).toBeTruthy();
    });

    // Action enum is visibly displayed
    expect(screen.getByText("resume")).toBeTruthy();
    expect(screen.getByText("cancel")).toBeTruthy();

    const ledgerCheckbox = screen.getByRole("checkbox", {
      name: /同时将长期规则「博客文章统一保留 \/posts\/:id」写入决策账本/,
    }) as HTMLInputElement;
    expect(ledgerCheckbox.checked).toBe(false);

    // 1. Submit without checking -> apply_ledger_rule: false
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() => {
      expect(decideBodies).toHaveLength(1);
    });
    expect(decideBodies[0]).toMatchObject({
      decision_id: "dec-101",
      option_id: "opt-keep",
      action: "resume",
      apply_ledger_rule: false,
    });

    // Wait for button to recover from submitting state after bootstrap refresh
    await screen.findByRole("button", { name: "确认执行" });

    // 2. Check ledger checkbox -> apply_ledger_rule: true
    fireEvent.click(ledgerCheckbox);
    expect(ledgerCheckbox.checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() => {
      expect(decideBodies).toHaveLength(2);
    });
    expect(decideBodies[1]).toMatchObject({
      decision_id: "dec-101",
      option_id: "opt-keep",
      action: "resume",
      apply_ledger_rule: true,
    });
  });

  it("DetailView displays conflict path and unified diff when restore-backup returns 409 hash_mismatch", async () => {
    const now = new Date().toISOString();
    const detail: TaskDetailResponse = {
      card: {
        schema_version: 1,
        id: "t-host",
        title: "修改 ~/.zshrc PATH",
        space: "local",
        priority: "P2",
        track: "L1",
        workspace_mode: "host_scoped",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "PATH 去重",
          end: "本机生效",
          accept_cmd: "echo ok",
          accept_files_hash: "sha256:host",
          scope: ["~/.zshrc"],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: {
          retries_per_stage: 2,
          review_rounds: 2,
          advisor_calls: 1,
          max_tokens: 250_000,
        },
        created_at: now,
        updated_at: now,
      },
      state: {
        status: "done",
        stage: "deliver",
        round: 1,
        activeRunId: null,
        priority: "P2",
        effectivePriority: "P2",
        track: "L1",
        contractVersion: 1,
        updatedAt: now,
      },
      brief: "# Host brief",
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
      hostBackup: {
        schema_version: 1,
        task_id: "t-host",
        status: "applied",
        files: [
          {
            target_canonical_path: "/Users/me/.zshrc",
            staged_relative_path: ".zshrc",
            backup_relative_path: "files/0000.bak",
            existed_before: true,
            pre_sha256: "aaa",
            post_sha256: "bbb",
            updated_at: now,
          },
        ],
        created_at: now,
        updated_at: now,
      },
    };

    const bootstrap = makeBaseBootstrap({
      tasks: [
        {
          id: "t-host",
          space: "local",
          parent_id: null,
          title: "修改 ~/.zshrc PATH",
          priority: "P2",
          effective_priority: "P2",
          track: "L1",
          workspace_mode: "host_scoped",
          status: "done",
          stage: "deliver",
          round: 1,
          active_run_id: null,
          contract_version: 1,
          depends_on: [],
          created_at: now,
          updated_at: now,
          tokens: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          cost_usd: 0,
          has_host_backup: true,
        },
      ],
    });

    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/bootstrap") return jsonResponse(bootstrap);
      if (url === "/api/tasks/t-host") return jsonResponse(detail);
      if (url === "/api/tasks/t-host/restore-backup") {
        return jsonResponse(
          {
            code: "hash_mismatch",
            path: "/Users/me/.zshrc",
            expectedSha256: "post-sha-111",
            actualSha256: "actual-sha-999",
            diff: "--- expected (post_sha256)\n+++ actual (current)\n-typeset -U path\n+export MANUAL_EDIT=1",
            conflicts: [
              {
                targetCanonicalPath: "/Users/me/.zshrc",
                expectedPostSha256: "post-sha-111",
                actualSha256: "actual-sha-999",
                diff: "--- expected (post_sha256)\n+++ actual (current)\n-typeset -U path\n+export MANUAL_EDIT=1",
              },
            ],
          },
          409,
        );
      }
      return jsonResponse({});
    });

    window.location.hash = "#task=t-host";
    render(<App />);

    const restoreBtn = await screen.findByRole("button", { name: "从备份恢复" });
    fireEvent.click(restoreBtn);

    const alertBox = await screen.findByRole("alert");
    expect(within(alertBox).getByText(/409 hash_mismatch/)).toBeTruthy();
    expect(within(alertBox).getByText(/\/Users\/me\/\.zshrc/)).toBeTruthy();
    expect(within(alertBox).getByText(/\+export MANUAL_EDIT=1/)).toBeTruthy();
  });

  it("WorkflowView redirects legacy #view=settings&tab=roles, filters interactiveChat, warns on non-MCP and full-access, refreshes via /api/agents?refresh=1, and removes roles tab from SettingsView", async () => {
    const bootstrap = makeBaseBootstrap();
    // Make implement and review use the exact same model and colliding fallback with hetero enabled
    bootstrap.roles!.roles.reviewer = {
      agent: "pi",
      model: "claude-sonnet-4-6",
      reasoning_effort: "high",
      fallback: { agent: "pi", model: "claude-sonnet-4-6" },
      allow_full_access_fallback: false,
    };

    const savedPayloads: Array<{ url: string; body: unknown }> = [];
    const refreshedAgents = [
      ...bootstrap.agents!,
      {
        id: "batch",
        label: "Batch Runner",
        capabilities: {
          interactiveChat: false,
          approvals: false,
          mcpInjection: false,
          usageCacheBreakdown: false,
          interrupt: true,
        },
        modes: [],
        models: [{ id: "batch-v1", thinkingOptions: [] }],
      },
    ];
    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/bootstrap") return jsonResponse(bootstrap);
      if (url === "/api/agents?refresh=1") {
        return jsonResponse({
          ok: true,
          agents: refreshedAgents,
          backends: [
            {
              backendId: "paseo",
              id: "paseo",
              connected: true,
              status: "connected",
              detail: "4 agent(s) available",
            },
          ],
        });
      }
      if (url.startsWith("/api/settings/")) {
        const body = JSON.parse(String(init?.body));
        savedPayloads.push({ url, body });
        return jsonResponse({ ok: true, section: url.split("/").pop(), data: body });
      }
      return jsonResponse({});
    });

    window.location.hash = "#view=settings&tab=roles";
    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: "工作流" })).toBeTruthy();

    const readComboboxValues = async (label: string): Promise<string[]> => {
      const trigger = screen.getByLabelText(label);
      fireEvent.click(trigger);
      const listbox = await screen.findByRole("listbox", { name: label });
      const vals = within(listbox)
        .getAllByRole("option")
        .map((opt) => opt.getAttribute("data-value") ?? "");
      fireEvent.keyDown(listbox, { key: "Escape" });
      return vals;
    };

    const selectComboboxValue = async (label: string, value: string): Promise<void> => {
      const trigger = screen.getByLabelText(label);
      fireEvent.click(trigger);
      const listbox = await screen.findByRole("listbox", { name: label });
      const option = within(listbox)
        .getAllByRole("option")
        .find((opt) => opt.getAttribute("data-value") === value);
      if (!option) {
        throw new Error(`Option ${value} not found in combobox ${label}`);
      }
      fireEvent.click(option);
    };

    // Select intake node: interactiveChat allows codex, pi, antigravity
    await waitFor(() => {
      expect(container.querySelector('[data-wf-node="intake"]')).not.toBeNull();
    });
    fireEvent.click(container.querySelector('[data-wf-node="intake"]')!);
    await waitFor(() => {
      expect(screen.getByLabelText("主订阅 Provider").textContent).toContain("Codex");
    });
    expect(await readComboboxValues("主订阅 Provider")).toEqual(["codex", "pi", "antigravity"]);

    // Select resolver in aux dock: interactiveChat allows codex, pi, antigravity
    fireEvent.click(container.querySelector('[data-wf-node="resolver"]')!);
    expect(await readComboboxValues("主订阅 Provider")).toEqual(["codex", "pi", "antigravity"]);

    // Switching intake to Pi displays non-MCP structured patch notice
    fireEvent.click(container.querySelector('[data-wf-node="intake"]')!);
    await selectComboboxValue("主订阅 Provider", "pi");
    await waitFor(() => {
      expect(screen.getByText(/无 MCP 模式：自动通过结构化补丁同步草稿\/契约/)).toBeTruthy();
    });

    // Switching intake to Antigravity triggers full-access-only warning until fallback opt-in is confirmed
    await selectComboboxValue("主订阅 Provider", "antigravity");
    await waitFor(() => {
      expect(
        screen.getByText(/仅暴露 full-access，默认拦截派发，需先开启下方「允许全权兜底」/),
      ).toBeTruthy();
    });

    const intakeFallbackToggle = screen.getByLabelText("允许全权兜底") as HTMLInputElement;
    expect(intakeFallbackToggle.checked).toBe(false);
    fireEvent.click(intakeFallbackToggle);
    const intakeConfirmDialog = await screen.findByRole("alertdialog", {
      name: "确认开启全权兜底",
    });
    fireEvent.click(within(intakeConfirmDialog).getByRole("button", { name: "确认开启" }));
    expect(intakeFallbackToggle.checked).toBe(true);

    // Click 重新读取 -> hits /api/agents?refresh=1, keeps interactiveChat=false batch out of intake while adding it to implement
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([u]) => u === "/api/agents?refresh=1")).toBe(true);
      expect(screen.getByRole("button", { name: "重新读取" })).toBeTruthy();
    });
    fireEvent.click(container.querySelector('[data-wf-node="implement"]')!);
    expect(await readComboboxValues("主订阅 Provider")).toEqual([
      "codex",
      "pi",
      "antigravity",
      "batch",
    ]);
    fireEvent.click(container.querySelector('[data-wf-node="intake"]')!);
    expect(await readComboboxValues("主订阅 Provider")).toEqual(["codex", "pi", "antigravity"]);

    // Verify heterogeneous_review collision warning on review node
    fireEvent.click(container.querySelector('[data-wf-node="review"]')!);
    expect(screen.getByText(/独立审查与实施同模型/)).toBeTruthy();

    // Implement allow_full_access_fallback requires explicit secondary confirmation
    fireEvent.click(container.querySelector('[data-wf-node="implement"]')!);
    const fallbackToggle = screen.getByLabelText("允许全权兜底") as HTMLInputElement;
    expect(fallbackToggle.checked).toBe(false);
    fireEvent.click(fallbackToggle);
    const confirmDialog = await screen.findByRole("alertdialog", {
      name: "确认开启全权兜底",
    });
    expect(fallbackToggle.checked).toBe(false);
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "确认开启" }));
    expect(fallbackToggle.checked).toBe(true);

    // Navigate to SettingsView: 角色与模型 tab is completely removed (no duplication)
    fireEvent.click(container.querySelector('[data-nav="settings"]')!);
    expect(await screen.findByRole("heading", { name: "设置" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "角色与模型" })).toBeNull();

    // Verify backends snapshot updated on 连接与底座 tab
    fireEvent.click(screen.getByRole("tab", { name: "连接与底座" }));
    expect(screen.getByText("4 agent(s) available")).toBeTruthy();

    // Switch to pricing tab and change gpt-5.4 input price from 1.25 -> 10
    expect(document.getElementById("upTotalCost")?.textContent).toBe("$1.80");

    fireEvent.click(screen.getByRole("tab", { name: "模型单价" }));
    const inPriceInput = screen.getByLabelText("gpt-5.4 输入单价") as HTMLInputElement;
    fireEvent.change(inPriceInput, { target: { value: "10" } });

    await waitFor(() => {
      expect(document.getElementById("upTotalCost")?.textContent).toBe("$7.05");
    });

    fireEvent.click(screen.getByRole("button", { name: "保存单价表" }));
    await waitFor(() => {
      expect(savedPayloads.some((p) => p.url === "/api/settings/pricing")).toBe(true);
    });
  });

  it("IntakeView and ResolveView have no L3/external_only options, resolve <新任务> on commit, toggle collapsible drawer, and set in-converse & kb-open classes", async () => {
    const now = new Date().toISOString();
    const bootstrap = makeBaseBootstrap({
      tasks: [
        {
          id: "t-wait",
          space: "local",
          parent_id: null,
          title: "待讨论任务",
          priority: "P2",
          effective_priority: "P2",
          track: "L2",
          workspace_mode: "git_worktree",
          status: "waiting",
          stage: "implement",
          round: 1,
          active_run_id: null,
          contract_version: 1,
          depends_on: [],
          created_at: now,
          updated_at: now,
          tokens: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          cost_usd: 0,
        },
      ],
      pendingDecisions: [
        {
          id: "dec-w1",
          task_id: "t-wait",
          contract_version: 1,
          reason: "ambiguous",
          category: "product",
          question: "如何处理空输入？",
          options: [{ id: "opt-a", label: "返回空数组", action: "resume", recommended: true }],
          created_at: now,
        },
      ],
    });

    let commitPayload: Record<string, unknown> | null = null;
    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/bootstrap") return jsonResponse(bootstrap);
      if (url === "/api/drafts") {
        return jsonResponse(
          {
            ok: true,
            draft: {
              schema_version: 1,
              id: "d-new-1",
              title: "测试沙盒任务",
              space: "local",
              priority: "P2",
              track: "L1",
              workspace_mode: "scratch_dir",
              depends_on: [],
              contract: {},
              created_at: now,
              updated_at: now,
            },
          },
          201,
        );
      }
      if (url === "/api/drafts/d-new-1/commit") {
        commitPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(
          {
            ok: true,
            card: { id: String(commitPayload.id ?? "t-101") },
            state: { status: "queued" },
          },
          201,
        );
      }
      return jsonResponse({});
    });

    window.location.hash = "#view=intake";
    render(<App />);

    await waitFor(() => {
      expect(document.body.classList.contains("in-converse")).toBe(true);
    });

    // Issue #5: Zero <select> dropdowns in IntakeView
    const { container } = { container: document.body.querySelector(".converse")! };
    expect(container.querySelectorAll("select")).toHaveLength(0);

    // Default right panel opens 产品方案 tab; switch to 立项设置 tab to verify track & workspace controls
    fireEvent.click(screen.getByRole("tab", { name: /立项设置/ }));
    const trackGroup = screen.getByRole("radiogroup", { name: "轨道" });
    const trackRadios = within(trackGroup).getAllByRole("radio");
    expect(trackRadios.map((el) => el.getAttribute("data-track"))).toEqual(["L1", "L2"]);
    expect(screen.getByLabelText("空间与工作区摘要").textContent).toContain("git_worktree");

    // Switch to 本机 / 临时任务 -> workspace tabs are only scratch_dir and host_scoped (no L3/external_only)
    fireEvent.click(screen.getByRole("button", { name: "本机 / 临时任务" }));
    const localWsGroup = screen.getByRole("radiogroup", { name: "本机工作区模式" });
    const localWsRadios = within(localWsGroup).getAllByRole("radio");
    expect(localWsRadios.map((el) => el.getAttribute("data-workspace-mode"))).toEqual([
      "scratch_dir",
      "host_scoped",
    ]);

    // Collapsible drawer toggle on IntakeView
    const toggleBtn = document.getElementById("btnDraftToggle")!;
    const draftAside = document.querySelector("aside.draft")!;
    expect(draftAside.classList.contains("open")).toBe(false);
    fireEvent.click(toggleBtn);
    expect(draftAside.classList.contains("open")).toBe(true);

    // focusin on textarea triggers kb-open
    const chatInput = document.getElementById("chatIn")!;
    fireEvent.focusIn(chatInput);
    expect(document.body.classList.contains("kb-open")).toBe(true);

    // Expand PM 执行契约摘要 to fill local scratch task containing <新任务> placeholder and commit
    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "临时沙盒统计脚本" },
    });
    fireEvent.click(screen.getByRole("button", { name: "手动编辑" }));
    fireEvent.change(screen.getByLabelText("交付终点"), {
      target: { value: "output.md 生成且非空" },
    });
    fireEvent.change(screen.getByLabelText("验收命令"), {
      target: { value: "test -s workspaces/<新任务>/output.md" },
    });
    fireEvent.change(screen.getByLabelText("可改范围"), {
      target: { value: "workspaces/<新任务>/**" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始推进" }));

    await waitFor(() => {
      expect(commitPayload).not.toBeNull();
    });
    const sentContract = commitPayload!.contract as {
      accept_cmd: string;
      scope: string[];
    };
    const committedId = String(commitPayload!.id);
    expect(committedId).toMatch(/^t-\d+$/);
    expect(sentContract.accept_cmd).toBe(`test -s workspaces/${committedId}/output.md`);
    expect(sentContract.scope).toEqual([`workspaces/${committedId}/**`]);
    expect(sentContract.accept_cmd).not.toContain("<新任务>");

    // Also verify ResolveView collapsible drawer + in-converse
    window.location.hash = "#resolve=t-wait";
    fireEvent(window, new HashChangeEvent("hashchange"));

    await waitFor(() => {
      expect(screen.getByText("拍板与契约")).toBeTruthy();
    });
    expect(document.body.classList.contains("in-converse")).toBe(true);
    const resolveToggle = document.getElementById("btnDraftToggle")!;
    fireEvent.click(resolveToggle);
    expect(document.querySelector("aside.draft")?.classList.contains("open")).toBe(true);
  });

  it("enforces URL Hash refresh guard: invalid #task=, #resolve=, and #view= fall back to board", async () => {
    const bootstrap = makeBaseBootstrap();
    fetchMock.mockImplementation(async () => jsonResponse(bootstrap));

    // 1. Invalid #task=
    window.location.hash = "#task=nonexistent-999";
    const r1 = render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "总览" })).toBeTruthy();
    });
    expect(window.location.hash).toBe("");
    r1.unmount();

    // 2. Invalid #resolve=
    window.location.hash = "#resolve=missing-task";
    const r2 = render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "总览" })).toBeTruthy();
    });
    expect(window.location.hash).toBe("");
    r2.unmount();

    // 3. Invalid/Post-MVP #view=console
    window.location.hash = "#view=console";
    const r3 = render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "总览" })).toBeTruthy();
    });
    expect(window.location.hash).toBe("");
    r3.unmount();
  });

  it("UsagePanel enforces M0 V9 quota bar hiding when providerUsage absent, shows bars when present, and preserves DOM node on SSE rate.tick", async () => {
    // Case 1: No providerUsage -> 0 quota bars
    fetchMock.mockImplementation(async () =>
      jsonResponse(makeBaseBootstrap({ providerUsage: undefined })),
    );
    const { container, unmount } = render(<App />);

    await waitFor(() => {
      expect(document.getElementById("upTotalCost")?.textContent).toBe("$1.80");
    });
    expect(container.querySelectorAll(".quota")).toHaveLength(0);

    // Rate tick keeps the exact clickable .usage-panel DOM node without recreating it
    const panelBefore = container.querySelector(".usage-panel");
    expect(panelBefore).toBeTruthy();
    const sse = MockEventSource.instances[0]!;
    sse.emit("rate.tick", {
      seq: 1,
      type: "rate.tick",
      rates: { "t-1": 240 },
      totals: { costUsd: 1.8, tokPerSec: 240 },
    });
    await waitFor(() => {
      expect(document.getElementById("upTotalRate")?.textContent).toBe("240");
    });
    expect(container.querySelector(".usage-panel")).toBe(panelBefore);
    unmount();

    // Case 2: With providerUsage -> renders quota bars with <60% gray, >=60% warn, >=85% bad
    fetchMock.mockImplementation(async () =>
      jsonResponse(
        makeBaseBootstrap({
          providerUsage: {
            codex: { quota: { label: "5 小时窗口", used: 0.65, reset: "19:40" } },
            pi: { quota: { label: "5 小时窗口", used: 0.9, reset: "20:00" } },
          },
        }),
      ),
    );
    const second = render(<App />);
    await waitFor(() => {
      expect(second.container.querySelectorAll(".quota")).toHaveLength(2);
    });
    expect(second.container.querySelector('[data-up-bar="codex"]')?.className).toBe("warn");
    expect(second.container.querySelector('[data-up-bar="pi"]')?.className).toBe("bad");
  });

  it("passes static dependency and security scan (no kernel, paseo, node builtins, UI libs, or dangerouslySetInnerHTML)", () => {
    const sources = import.meta.glob("../**/*.{ts,tsx}", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const pkgRaw = import.meta.glob("../../package.json", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;

    const sourceEntries = Object.entries(sources).filter(
      ([filePath]) => !filePath.includes("__tests__"),
    );
    expect(sourceEntries.length).toBeGreaterThan(10);

    for (const [filePath, code] of sourceEntries) {
      expect(code, `${filePath} must not use dangerouslySetInnerHTML`).not.toContain(
        "dangerouslySetInnerHTML",
      );
      expect(code, `${filePath} must not import @getpaseo/client`).not.toContain(
        "@getpaseo/client",
      );
      expect(code, `${filePath} must not import packages/kernel`).not.toMatch(
        /packages\/kernel|@kiln\/kernel/,
      );
      expect(code, `${filePath} must not import node: builtins`).not.toMatch(/from\s+["']node:/);
      // Must import from @kiln/protocol/web, never root @kiln/protocol
      expect(code, `${filePath} must not import @kiln/protocol root`).not.toMatch(
        /from\s+["']@kiln\/protocol["']/,
      );
    }

    const pkgJson = JSON.parse(Object.values(pkgRaw)[0]!) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkgJson.dependencies).sort()).toEqual([
      "@kiln/protocol",
      "radix-ui",
      "react",
      "react-dom",
    ]);
  });

  it("handles CommandPalette, Esc priority chain, Tabbar 5 MVP views, LedgerView, UsageView, Board inline actions, and SSE task.updated", async () => {
    const now = new Date().toISOString();
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const detail: TaskDetailResponse = {
      card: {
        schema_version: 1,
        id: "t-run",
        title: "流式执行任务",
        space: "kiln",
        priority: "P1",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "goal",
          end: "end",
          accept_cmd: "pnpm test",
          accept_files_hash: "sha256:x",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: {
          retries_per_stage: 2,
          review_rounds: 2,
          advisor_calls: 1,
          max_tokens: 250_000,
        },
        created_at: now,
        updated_at: now,
      },
      state: {
        status: "running",
        stage: "implement",
        round: 1,
        activeRunId: "run-1",
        priority: "P1",
        effectivePriority: "P1",
        track: "L2",
        contractVersion: 1,
        updatedAt: now,
      },
      brief: "# brief",
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
    };

    const bootstrap = makeBaseBootstrap({
      tasks: [
        {
          id: "t-run",
          space: "kiln",
          parent_id: null,
          title: "流式执行任务",
          priority: "P1",
          effective_priority: "P1",
          track: "L2",
          workspace_mode: "git_worktree",
          status: "running",
          stage: "implement",
          round: 1,
          active_run_id: "run-1",
          contract_version: 1,
          depends_on: [],
          created_at: now,
          updated_at: now,
          tokens: {
            input_tokens: 1000,
            cached_input_tokens: 0,
            output_tokens: 500,
            total_tokens: 1500,
          },
          cost_usd: 0.01,
        },
        {
          id: "t-p",
          space: "local",
          parent_id: null,
          title: "可恢复暂停任务",
          priority: "P2",
          effective_priority: "P2",
          track: "L1",
          workspace_mode: "scratch_dir",
          status: "paused",
          stage: "implement",
          round: 1,
          active_run_id: null,
          contract_version: 1,
          depends_on: [],
          created_at: now,
          updated_at: now,
          tokens: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          cost_usd: 0,
        },
      ],
      ledgers: {
        kiln: {
          schema_version: 1,
          space: "kiln",
          entries: [
            {
              id: "led-1",
              space: "kiln",
              rule: "回执写入与租约比对必须在同一 SQLite 事务内完成",
              source_task_id: "t-118",
              created_at: now,
            },
          ],
        },
      },
    });

    fetchMock.mockImplementation(async (url, init) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url === "/api/bootstrap") return jsonResponse(bootstrap);
      if (url === "/api/tasks/t-run") return jsonResponse(detail);
      return jsonResponse({ ok: true });
    });

    const { container } = render(<App />);
    await waitFor(() => {
      expect(screen.getByText("流式执行任务")).toBeTruthy();
    });

    // Resume button on paused card
    fireEvent.click(screen.getByRole("button", { name: "继续推进" }));
    await waitFor(() => {
      expect(calls.some((c) => c.url === "/api/tasks/t-p/resume")).toBe(true);
    });

    // Bottom Tabbar has 5 MVP buttons (all functional)
    const tabButtons = Array.from(
      container.querySelectorAll(".tabbar button"),
    ) as HTMLButtonElement[];
    expect(tabButtons.map((b) => b.dataset.tab)).toEqual([
      "board",
      "inbox",
      "intake",
      "ledger",
      "usage",
    ]);

    // Navigate to Ledger via tabbar
    fireEvent.click(tabButtons[3]!);
    await waitFor(() => {
      expect(screen.getByText("回执写入与租约比对必须在同一 SQLite 事务内完成")).toBeTruthy();
    });

    // Navigate to Usage via tabbar -> no quota bars because providerUsage absent
    fireEvent.click(tabButtons[4]!);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "用量与费用" })).toBeTruthy();
    });
    expect(container.querySelectorAll(".quota")).toHaveLength(0);

    // CommandPalette via ⌘K & Esc priority chain:
    // Open drawer first, then open palette -> Esc closes palette first, next Esc closes drawer
    fireEvent.click(screen.getByRole("button", { name: "打开导航" }));
    expect(document.body.classList.contains("nav-open")).toBe(true);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog", { name: "命令面板" })).toBeTruthy();

    // Typing 'n' inside palette input does NOT jump to intake
    const paletteInput = document.getElementById("paletteInput") as HTMLInputElement;
    paletteInput.focus();
    fireEvent.keyDown(document, { key: "n" });
    expect(screen.getByRole("dialog", { name: "命令面板" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "命令面板" })).toBeNull();
    expect(document.body.classList.contains("nav-open")).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.body.classList.contains("nav-open")).toBe(false);

    // Non-typing 'n' opens intake, Esc returns to board
    (document.activeElement as HTMLElement | null)?.blur?.();
    fireEvent.keyDown(document, { key: "n" });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "新需求" })).toBeTruthy();
    });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "总览" })).toBeTruthy();
    });

    // SSE task.updated patches status dynamically
    const sse = MockEventSource.instances[0]!;
    sse.emit("task.updated", {
      seq: 2,
      type: "task.updated",
      taskId: "t-run",
      patch: { status: "paused" },
    });
    await waitFor(() => {
      expect(screen.getAllByText("已暂停").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("FlameCanvas respects prefers-reduced-motion and cleans up rAF + canvas dimensions on unmount", async () => {
    const scheduledTimers = new Map<number, ReturnType<typeof setTimeout>>();
    let nextRafId = 100;
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id: number) => {
      const timer = scheduledTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        scheduledTimers.delete(id);
      }
    });
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        nextRafId += 1;
        const id = nextRafId;
        const timer = setTimeout(() => {
          scheduledTimers.delete(id);
          cb(performance.now());
        }, 0);
        scheduledTimers.set(id, timer);
        return id;
      });

    const originalGetContextDesc = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "getContext",
    );
    const originalGetContext =
      originalGetContextDesc?.value as typeof HTMLCanvasElement.prototype.getContext;
    let drawCount = 0;
    const mockCtx = {
      createRadialGradient: () => ({ addColorStop: () => {} }),
      fillRect: () => {},
      setTransform: () => {},
      clearRect: () => {
        drawCount += 1;
      },
      drawImage: () => {},
      fillStyle: "",
      globalCompositeOperation: "",
      globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;
    HTMLCanvasElement.prototype.getContext = (() =>
      mockCtx) as unknown as typeof originalGetContext;

    try {
      const now = new Date().toISOString();
      const bootstrap = makeBaseBootstrap({
        tasks: [
          {
            id: "t-fire",
            space: "kiln",
            parent_id: null,
            title: "火焰渲染任务",
            priority: "P1",
            effective_priority: "P1",
            track: "L1",
            workspace_mode: "scratch_dir",
            status: "running",
            stage: "implement",
            round: 1,
            active_run_id: "r-fire",
            contract_version: 1,
            depends_on: [],
            created_at: now,
            updated_at: now,
            tokens: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            cost_usd: 0,
          },
        ],
      });
      fetchMock.mockImplementation(async () => jsonResponse(bootstrap));

      const { container, unmount } = render(<App />);
      await waitFor(() => {
        expect(container.querySelector("canvas.fire-canvas")).toBeTruthy();
      });
      const canvasEl = container.querySelector("canvas.fire-canvas") as HTMLCanvasElement;
      const hostEl = canvasEl.parentElement!;
      Object.defineProperty(hostEl, "clientWidth", { value: 60, configurable: true });
      Object.defineProperty(hostEl, "clientHeight", { value: 4, configurable: true });

      // Wait for React's post-commit useEffect & at least one FlameCanvas frame to execute
      await waitFor(() => {
        expect(drawCount).toBeGreaterThanOrEqual(1);
      });

      unmount();
      expect(cancelSpy).toHaveBeenCalled();
      expect(canvasEl.width).toBe(0);
      expect(canvasEl.height).toBe(0);

      // Reduced motion prevents FlameCanvas from running any draw frame
      drawCount = 0;
      vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }));
      const reduced = render(<App />);
      await waitFor(() => {
        expect(reduced.container.querySelector("canvas.fire-canvas")).toBeTruthy();
      });
      await new Promise((r) => setTimeout(r, 25));
      expect(drawCount).toBe(0);
      reduced.unmount();
    } finally {
      for (const timer of scheduledTimers.values()) {
        clearTimeout(timer);
      }
      scheduledTimers.clear();
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
    }
  });

  it("DetailView derives verify and deliver station status when no separate verify/deliver runs exist without overriding independent runs", async () => {
    const createdAt = "2026-11-20T01:05:00.000Z";
    const doneAt = "2026-11-20T02:15:00.000Z";
    const updatedAt = "2026-11-20T03:45:00.000Z";

    const makeDetail = (
      id: string,
      opts: {
        status: TaskDetailResponse["state"]["status"];
        stage: TaskDetailResponse["state"]["stage"];
        gatePassed?: boolean;
        withSeparateVerifyRun?: boolean;
        includeDoneEvent?: boolean;
      },
    ): TaskDetailResponse => ({
      card: {
        schema_version: 1,
        id,
        title: `阶段条任务 ${id}`,
        space: "kiln",
        priority: "P1",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "goal",
          end: "end",
          accept_cmd: "pnpm test",
          accept_files_hash: "sha256:x",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: {
          retries_per_stage: 2,
          review_rounds: 2,
          advisor_calls: 1,
          max_tokens: 250_000,
        },
        created_at: createdAt,
        updated_at: updatedAt,
      },
      state: {
        status: opts.status,
        stage: opts.stage,
        round: 1,
        activeRunId: null,
        priority: "P1",
        effectivePriority: "P1",
        track: "L2",
        contractVersion: 1,
        updatedAt,
      },
      brief: "# brief",
      decisions: "",
      pendingDecision: null,
      ledgerProposals: [],
      runs: [
        {
          dirName: "001-implement",
          meta: {
            schema_version: 1,
            run_id: `run-${id}-impl`,
            task_id: id,
            stage: "implement",
            round: 1,
            role: "worker",
            contract_version: 1,
            backend_id: "paseo",
            agent: "codex",
            model: "gpt-5.4",
            session_ref: { backendId: "paseo", sessionId: "s1" },
            started_at: createdAt,
          },
          handoff: null,
          receipt: "---\nrun_id: r1\n---\n完成",
          gate:
            opts.gatePassed === undefined
              ? null
              : {
                  schema_version: 1,
                  run_id: `run-${id}-impl`,
                  contract_version: 1,
                  schema_ok: true,
                  scope_ok: true,
                  artifacts_ok: true,
                  out_of_scope_paths: [],
                  frozen_files_changed: [],
                  accept_exit_code: opts.gatePassed ? 0 : 1,
                  accept_duration_ms: 120,
                  escalated_to_l2: false,
                  checked_at: doneAt,
                },
          events: [],
          eventsCount: 0,
          startedAt: createdAt,
          endedAt: "2026-11-20T01:25:00.000Z",
        },
        ...(opts.withSeparateVerifyRun
          ? [
              {
                dirName: "002-verify",
                meta: {
                  schema_version: 1 as const,
                  run_id: `run-${id}-verify`,
                  task_id: id,
                  stage: "verify" as const,
                  round: 1,
                  role: "verifier" as const,
                  contract_version: 1,
                  backend_id: "paseo",
                  agent: "pi",
                  model: "claude-sonnet-4-6",
                  session_ref: { backendId: "paseo", sessionId: "s2" },
                  started_at: "2026-11-20T01:30:00.000Z",
                },
                handoff: null,
                receipt: "---\nverdict: fail\n---\n失败",
                gate: null,
                events: [],
                eventsCount: 0,
                startedAt: "2026-11-20T01:30:00.000Z",
                endedAt: "2026-11-20T01:40:00.000Z",
              },
            ]
          : []),
      ],
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
      stateEvents: opts.includeDoneEvent ? [{ type: "done", at: doneAt, deliver_ref: "main" }] : [],
    });

    const detailsById: Record<string, TaskDetailResponse> = {
      "t-done-gate": makeDetail("t-done-gate", {
        status: "done",
        stage: "deliver",
        gatePassed: true,
        includeDoneEvent: true,
      }),
      "t-fail-gate": makeDetail("t-fail-gate", {
        status: "waiting",
        stage: "deliver",
        gatePassed: false,
      }),
      "t-live-verify": makeDetail("t-live-verify", {
        status: "running",
        stage: "verify",
        gatePassed: false,
      }),
      "t-ext-deliver": makeDetail("t-ext-deliver", {
        status: "external",
        stage: "deliver",
        gatePassed: true,
        withSeparateVerifyRun: true,
      }),
      "t-paused-deliver": makeDetail("t-paused-deliver", {
        status: "paused",
        stage: "deliver",
        gatePassed: true,
      }),
      "t-done-fallback": makeDetail("t-done-fallback", {
        status: "done",
        stage: "deliver",
        gatePassed: true,
        includeDoneEvent: false,
      }),
    };

    const bootstrap = makeBaseBootstrap({
      tasks: Object.values(detailsById).map((d) => ({
        id: d.card.id,
        space: d.card.space,
        parent_id: null,
        title: d.card.title,
        priority: d.card.priority,
        effective_priority: d.card.priority,
        track: d.card.track,
        workspace_mode: d.card.workspace_mode,
        status: d.state.status,
        stage: d.state.stage,
        round: 1,
        active_run_id: null,
        contract_version: 1,
        depends_on: [],
        created_at: createdAt,
        updated_at: updatedAt,
        tokens: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        cost_usd: 0,
      })),
    });

    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/bootstrap") return jsonResponse(bootstrap);
      const match = url.match(/^\/api\/tasks\/([^/]+)$/);
      if (match && detailsById[match[1]!]) {
        return jsonResponse(detailsById[match[1]!]);
      }
      return jsonResponse({});
    });

    const readStations = (container: Element) =>
      Array.from(container.querySelectorAll(".stations .station")).map((li) => ({
        name: li.querySelector(".st-name")?.textContent ?? "",
        sub: li.querySelector(".st-sub")?.textContent ?? "",
        cls: li.className,
      }));

    // 1. Done without separate verify/deliver run dirs -> 门禁通过 + stateEvents done time
    window.location.hash = "#task=t-done-gate";
    const r1 = render(<App />);
    await waitFor(() => {
      expect(screen.getByText("门禁通过")).toBeTruthy();
    });
    const s1 = readStations(r1.container);
    expect(s1.find((s) => s.name === "验真")).toEqual({
      name: "验真",
      sub: "门禁通过",
      cls: "station done",
    });
    expect(s1.find((s) => s.name === "交付")).toEqual({
      name: "交付",
      sub: fmtTime(doneAt),
      cls: "station done",
    });
    r1.unmount();

    // 2. Failed implement gate + waiting at deliver -> 门禁未过 + 等你决定
    window.location.hash = "#task=t-fail-gate";
    const r2 = render(<App />);
    await waitFor(() => {
      expect(screen.getByText("门禁未过")).toBeTruthy();
    });
    const s2 = readStations(r2.container);
    expect(s2.find((s) => s.name === "验真")).toEqual({
      name: "验真",
      sub: "门禁未过",
      cls: "station returned",
    });
    expect(s2.find((s) => s.name === "交付")).toEqual({
      name: "交付",
      sub: "等你决定",
      cls: "station blocked",
    });
    r2.unmount();

    // 3. Running verify takes precedence over prior failed gate -> 进行中
    window.location.hash = "#task=t-live-verify";
    const r3 = render(<App />);
    await waitFor(() => {
      expect(screen.getByText("阶段条任务 t-live-verify")).toBeTruthy();
    });
    const s3 = readStations(r3.container);
    expect(s3.find((s) => s.name === "验真")).toEqual({
      name: "验真",
      sub: "进行中",
      cls: "station live",
    });
    r3.unmount();

    // 4. Separate verify run is NOT overridden, and external status maps deliver -> 等待外部
    window.location.hash = "#task=t-ext-deliver";
    const r4 = render(<App />);
    await waitFor(() => {
      expect(screen.getByText("等待外部")).toBeTruthy();
    });
    const s4 = readStations(r4.container);
    expect(s4.find((s) => s.name === "验真")).toEqual({
      name: "验真",
      sub: "已退回",
      cls: "station returned",
    });
    expect(s4.find((s) => s.name === "交付")).toEqual({
      name: "交付",
      sub: "等待外部",
      cls: "station live",
    });
    r4.unmount();

    // 5. Paused at deliver -> 已暂停
    window.location.hash = "#task=t-paused-deliver";
    const r5 = render(<App />);
    await waitFor(() => {
      expect(screen.getByText("阶段条任务 t-paused-deliver")).toBeTruthy();
    });
    const s5 = readStations(r5.container);
    expect(s5.find((s) => s.name === "交付")).toEqual({
      name: "交付",
      sub: "已暂停",
      cls: "station paused-manual",
    });
    r5.unmount();

    // 6. Done without stateEvents done event falls back to card.updated_at
    window.location.hash = "#task=t-done-fallback";
    const r6 = render(<App />);
    await waitFor(() => {
      expect(screen.getByText("阶段条任务 t-done-fallback")).toBeTruthy();
    });
    const s6 = readStations(r6.container);
    expect(s6.find((s) => s.name === "交付")).toEqual({
      name: "交付",
      sub: fmtTime(updatedAt),
      cls: "station done",
    });
    r6.unmount();
  });

  it("ResolveView and DetailView render hostStagedDiffs with plain-text XSS escaping when staged_awaiting_approval", async () => {
    const now = new Date().toISOString();
    const xssDiff =
      '--- a/.zshrc\n+++ b/.zshrc\n@@ -1,1 +1,2 @@\n-<script>window.__xss_diff=1</script>\n+<img src=x onerror="window.__xss_diff=2">';
    const newFileDiff = "+++ b/new.conf\n@@ -0,0 +1,2 @@\n+line1\n+line2";

    const detail: TaskDetailResponse = {
      card: {
        schema_version: 1,
        id: "t-host-diff",
        title: "修改本机配置等待审批",
        space: "local",
        priority: "P1",
        track: "L1",
        workspace_mode: "host_scoped",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "安全更新 ~/.zshrc",
          end: "审批后写入",
          accept_cmd: "echo ok",
          accept_files_hash: "sha256:hostdiff",
          scope: ["~/.zshrc", "~/.config/kiln/new.conf"],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: {
          retries_per_stage: 2,
          review_rounds: 2,
          advisor_calls: 1,
          max_tokens: 250_000,
        },
        created_at: now,
        updated_at: now,
      },
      state: {
        status: "waiting",
        stage: "deliver",
        round: 1,
        activeRunId: null,
        priority: "P1",
        effectivePriority: "P1",
        track: "L1",
        contractVersion: 1,
        updatedAt: now,
      },
      brief: "# Host diff",
      decisions: "",
      pendingDecision: {
        id: "dec-host-1",
        task_id: "t-host-diff",
        contract_version: 1,
        reason: "host_scoped_apply",
        category: "external_action",
        question: "是否批准将暂存修改写入本机文件？",
        options: [
          {
            id: "opt-apply",
            label: "批准写入",
            action: "resume",
            recommended: true,
          },
          {
            id: "opt-cancel",
            label: "取消写入",
            action: "cancel",
            recommended: false,
          },
        ],
        created_at: now,
      },
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
      hostBackup: {
        schema_version: 1,
        task_id: "t-host-diff",
        status: "staged_awaiting_approval",
        files: [
          {
            target_canonical_path: "/Users/me/.zshrc",
            staged_relative_path: ".zshrc",
            backup_relative_path: "files/0000.bak",
            existed_before: true,
            pre_sha256: "aaa",
            post_sha256: null,
            updated_at: now,
          },
        ],
        created_at: now,
        updated_at: now,
      },
      hostStagedDiffs: [
        {
          targetPath: "/Users/me/.zshrc",
          existedBefore: true,
          preSha256: "aaa",
          diff: xssDiff,
          truncated: false,
        },
        {
          targetPath: "/Users/me/.config/kiln/new.conf",
          existedBefore: false,
          preSha256: null,
          diff: newFileDiff,
          truncated: true,
        },
      ],
    };

    const bootstrap = makeBaseBootstrap({
      tasks: [
        {
          id: "t-host-diff",
          space: "local",
          parent_id: null,
          title: "修改本机配置等待审批",
          priority: "P1",
          effective_priority: "P1",
          track: "L1",
          workspace_mode: "host_scoped",
          status: "waiting",
          stage: "deliver",
          round: 1,
          active_run_id: null,
          contract_version: 1,
          depends_on: [],
          created_at: now,
          updated_at: now,
          tokens: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          cost_usd: 0,
          has_host_backup: true,
        },
      ],
      pendingDecisions: [detail.pendingDecision!],
    });

    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/bootstrap") return jsonResponse(bootstrap);
      if (url === "/api/tasks/t-host-diff") return jsonResponse(detail);
      if (url === "/api/tasks/t-host-diff/chat") return jsonResponse({ messages: [] });
      return jsonResponse({});
    });

    // 1. ResolveView displays staged diff panel with verbatim escaped text
    window.location.hash = "#resolve=t-host-diff";
    const rResolve = render(<App />);
    await waitFor(() => {
      expect(screen.getByText("待落盘暂存 Diff")).toBeTruthy();
    });
    expect(screen.getByText("/Users/me/.zshrc")).toBeTruthy();
    expect(screen.getByText("/Users/me/.config/kiln/new.conf")).toBeTruthy();
    expect(screen.getByText("修改")).toBeTruthy();
    expect(screen.getByText("新增")).toBeTruthy();
    expect(screen.getByText("内容已截断")).toBeTruthy();

    const preElsResolve = Array.from(rResolve.container.querySelectorAll("pre.staged-diff-pre"));
    expect(preElsResolve).toHaveLength(2);
    expect(preElsResolve[0]?.textContent).toBe(xssDiff);
    expect(preElsResolve[1]?.textContent).toBe(newFileDiff);
    expect(rResolve.container.querySelectorAll("script")).toHaveLength(0);
    expect(rResolve.container.querySelectorAll("img")).toHaveLength(0);
    expect((window as unknown as { __xss_diff?: unknown }).__xss_diff).toBeUndefined();
    rResolve.unmount();

    // 2. DetailView displays staged diff when staged_awaiting_approval
    window.location.hash = "#task=t-host-diff";
    const rDetail = render(<App />);
    await waitFor(() => {
      expect(screen.getByText("待落盘暂存 Diff")).toBeTruthy();
    });
    const preElsDetail = Array.from(rDetail.container.querySelectorAll("pre.staged-diff-pre"));
    expect(preElsDetail).toHaveLength(2);
    expect(preElsDetail[0]?.textContent).toBe(xssDiff);
    expect(rDetail.container.querySelectorAll("script")).toHaveLength(0);
    expect(rDetail.container.querySelectorAll("img")).toHaveLength(0);
    rDetail.unmount();

    // 3. DetailView hides staged diff once hostBackup is applied
    detail.hostBackup = { ...detail.hostBackup!, status: "applied" };
    window.location.hash = "#task=t-host-diff";
    const rApplied = render(<App />);
    await waitFor(() => {
      expect(screen.getByText("修改本机配置等待审批")).toBeTruthy();
    });
    expect(screen.queryByText("待落盘暂存 Diff")).toBeNull();
    rApplied.unmount();
  });

  it("supports space onboarding when no project spaces exist, SpaceModal inspect/save, dual-mode form sync before chat, draft deletion, sidebar space inheritance, and Settings spaces tab", async () => {
    const now = new Date().toISOString();
    let spacesState: BootstrapResponse["spaces"] = {};
    let draftsState: BootstrapResponse["drafts"] = [
      {
        schema_version: 1,
        id: "d-old",
        title: "旧草稿",
        space: "local",
        priority: "P2",
        track: "L1",
        workspace_mode: "scratch_dir",
        depends_on: [],
        contract: {},
        created_at: now,
        updated_at: now,
      },
    ];
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];

    fetchMock.mockImplementation(async (url, init) => {
      const method = init?.method ?? "GET";
      const parsedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      calls.push({ url, method, ...(parsedBody ? { body: parsedBody } : {}) });

      if (url === "/api/bootstrap") {
        return jsonResponse(makeBaseBootstrap({ spaces: spacesState, drafts: draftsState }));
      }
      if (url === "/api/spaces/inspect" && method === "POST") {
        return jsonResponse({
          ok: true,
          repo_path: "/Users/me/Projects/alpha",
          suggested_id: "alpha",
          suggested_name: "Alpha",
          default_branch: "main",
          default_accept_cmd: "pnpm test",
          copy_untracked: [],
          clone_deps: ["node_modules"],
        });
      }
      if (url === "/api/spaces/alpha" && method === "PUT") {
        const saved = {
          schema_version: 1 as const,
          id: "alpha",
          name: String(parsedBody?.name ?? "Alpha"),
          repo_path: String(parsedBody?.repo_path ?? "/Users/me/Projects/alpha"),
          default_branch: String(parsedBody?.default_branch ?? "main"),
          copy_untracked: [],
          clone_deps: ["node_modules"],
          default_accept_cmd: String(parsedBody?.default_accept_cmd ?? "pnpm test"),
          freeze_patterns: [],
        };
        spacesState = { ...spacesState, alpha: saved };
        return jsonResponse({ ok: true, space: saved }, 201);
      }
      if (url === "/api/spaces/beta" && method === "DELETE") {
        return jsonResponse(
          { error: "space_in_use", message: "空间 beta 仍有 1 个未完成任务" },
          409,
        );
      }
      if (url === "/api/spaces/alpha" && method === "DELETE") {
        const next = { ...spacesState };
        delete next.alpha;
        spacesState = next;
        return jsonResponse({ ok: true, deleted: true, id: "alpha" });
      }
      if (url === "/api/drafts/d-old" && method === "DELETE") {
        draftsState = [];
        return jsonResponse({ ok: true, deleted: true, id: "d-old" });
      }
      if (url === "/api/drafts" && method === "POST") {
        const draft = {
          schema_version: 1 as const,
          id: String(parsedBody?.id ?? "d-sync-1"),
          title: String(parsedBody?.title ?? "Alpha task"),
          space: String(parsedBody?.space ?? "alpha"),
          priority: "P2" as const,
          track: (parsedBody?.track ?? "L2") as "L1" | "L2",
          workspace_mode: (parsedBody?.workspace_mode ?? "git_worktree") as
            | "git_worktree"
            | "scratch_dir"
            | "host_scoped",
          depends_on: [],
          contract: (parsedBody?.contract ?? {}) as Record<string, unknown>,
          created_at: now,
          updated_at: now,
        };
        draftsState = [draft];
        return jsonResponse({ ok: true, draft }, 201);
      }
      if (url === "/api/drafts/d-sync-1/chat" && method === "POST") {
        return jsonResponse({
          ok: true,
          messages: [
            { who: "me", text: String(parsedBody?.message ?? "") },
            { who: "agent", name: "intake", text: "已在项目目录分析完成" },
          ],
          draft: draftsState[0],
        });
      }
      return jsonResponse({});
    });

    // 1. Empty spaces -> Intake defaults to 项目任务 with onboarding guide & disabled chat input
    window.location.hash = "#view=intake";
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("还没有登记项目空间")).toBeTruthy();
    });
    const chatArea = document.getElementById("chatIn") as HTMLTextAreaElement;
    expect(chatArea.disabled).toBe(true);

    // 2. Open SpaceModal via empty guide, inspect path, save -> auto-selected in Intake & chat unlocked
    fireEvent.click(screen.getByRole("button", { name: "+ 添加本地 Git 项目" }));
    const modal = await screen.findByRole("dialog", { name: "添加项目空间" });
    fireEvent.change(within(modal).getByLabelText("仓库路径"), {
      target: { value: "~/Projects/alpha" },
    });
    fireEvent.click(within(modal).getByRole("button", { name: "识别仓库" }));

    await waitFor(() => {
      expect((within(modal).getByLabelText("空间标识") as HTMLInputElement).value).toBe("alpha");
    });
    expect((within(modal).getByLabelText("默认验收命令") as HTMLInputElement).value).toBe(
      "pnpm test",
    );

    fireEvent.click(within(modal).getByRole("button", { name: "保存空间" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "添加项目空间" })).toBeNull();
    });

    await waitFor(() => {
      expect((document.getElementById("chatIn") as HTMLTextAreaElement).disabled).toBe(false);
    });
    const alphaRadio = within(screen.getByRole("radiogroup", { name: "目标项目空间" })).getByRole(
      "radio",
      { name: "Alpha" },
    );
    expect(alphaRadio.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: /立项设置/ }));
    fireEvent.click(screen.getByRole("button", { name: "手动编辑" }));
    expect((screen.getByLabelText("验收命令") as HTMLInputElement).value).toBe("pnpm test");

    // 3. Delete old draft via × button
    fireEvent.click(screen.getByRole("button", { name: "删除草稿 旧草稿" }));
    await waitFor(() => {
      expect(calls.some((c) => c.url === "/api/drafts/d-old" && c.method === "DELETE")).toBe(true);
    });

    // 4. Add second space beta, test switching space/mode syncs POST /api/drafts before POST /chat
    spacesState = {
      ...spacesState,
      beta: {
        schema_version: 1,
        id: "beta",
        name: "Beta",
        repo_path: "/Users/me/Projects/beta",
        default_branch: "main",
        copy_untracked: [],
        clone_deps: [],
        default_accept_cmd: "cargo test",
        freeze_patterns: [],
      },
    };
    // Trigger sidebar space click -> beta -> click 新需求 -> inherits beta
    fireEvent.click(screen.getByRole("button", { name: "返回看板" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "总览" })).toBeTruthy();
    });
    // Bootstrap reload via settings save or re-mount not needed if we inspect Settings & spaces
    fireEvent.click(screen.getByRole("button", { name: "新需求 N" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "新需求" })).toBeTruthy();
    });
    fireEvent.change(document.getElementById("chatIn")!, {
      target: { value: "帮我加个导出接口" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      const chatIdx = calls.findIndex((c) => c.url === "/api/drafts/d-sync-1/chat");
      expect(chatIdx).toBeGreaterThan(-1);
      const syncCall = calls
        .slice(0, chatIdx)
        .reverse()
        .find((c) => c.url === "/api/drafts" && c.method === "POST");
      expect(syncCall?.body).toMatchObject({
        space: "alpha",
        workspace_mode: "git_worktree",
      });
    });

    // Switch to 本机 / 临时任务 and send follow-up -> syncs local + scratch_dir before chat
    fireEvent.click(screen.getByRole("button", { name: "本机 / 临时任务" }));
    fireEvent.change(document.getElementById("chatIn")!, {
      target: { value: "改用沙盒先跑脚本" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      const syncCalls = calls.filter((c) => c.url === "/api/drafts" && c.method === "POST");
      expect(syncCalls.at(-1)?.body).toMatchObject({
        id: "d-sync-1",
        space: "local",
        workspace_mode: "scratch_dir",
      });
    });

    // 5. Settings -> 项目空间 tab lists spaces, handles 409 on busy delete and 200 on free delete
    fireEvent.click(screen.getByRole("button", { name: /设置/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "项目空间" }));
    expect(screen.getByText("/Users/me/Projects/alpha")).toBeTruthy();
    expect(screen.getByText("/Users/me/Projects/beta")).toBeTruthy();

    const delButtons = screen.getAllByRole("button", { name: "删除" });
    fireEvent.click(delButtons[1]!); // beta
    const confirmDelBeta = await screen.findByRole("alertdialog", { name: "确认删除项目空间" });
    fireEvent.click(within(confirmDelBeta).getByRole("button", { name: "确认删除" }));
    await waitFor(() => {
      expect(document.getElementById("toast")?.textContent).toContain("未完成任务");
    });

    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]!); // alpha
    const confirmDelAlpha = await screen.findByRole("alertdialog", { name: "确认删除项目空间" });
    fireEvent.click(within(confirmDelAlpha).getByRole("button", { name: "确认删除" }));
    await waitFor(() => {
      expect(calls.some((c) => c.url === "/api/spaces/alpha" && c.method === "DELETE")).toBe(true);
    });
  });

  it("inherits selected sidebar space when navigating to 新需求", async () => {
    const spaces: BootstrapResponse["spaces"] = {
      alpha: {
        schema_version: 1,
        id: "alpha",
        name: "Alpha",
        repo_path: "/repos/alpha",
        default_branch: "main",
        copy_untracked: [],
        clone_deps: [],
        default_accept_cmd: "pnpm alpha:test",
        freeze_patterns: [],
      },
      beta: {
        schema_version: 1,
        id: "beta",
        name: "Beta",
        repo_path: "/repos/beta",
        default_branch: "main",
        copy_untracked: [],
        clone_deps: [],
        default_accept_cmd: "cargo test",
        freeze_patterns: [],
      },
    };
    fetchMock.mockImplementation(async () => jsonResponse(makeBaseBootstrap({ spaces })));

    render(<App />);
    const betaNav = await screen.findByRole("button", { name: /Beta/ });
    fireEvent.click(betaNav);
    fireEvent.click(screen.getByRole("button", { name: "新需求 N" }));

    await waitFor(() => {
      const betaRadio = within(screen.getByRole("radiogroup", { name: "目标项目空间" })).getByRole(
        "radio",
        { name: "Beta" },
      );
      expect(betaRadio.getAttribute("aria-checked")).toBe("true");
    });
    fireEvent.click(screen.getByRole("tab", { name: /立项设置/ }));
    fireEvent.click(screen.getByRole("button", { name: "手动编辑" }));
    expect((screen.getByLabelText("验收命令") as HTMLInputElement).value).toBe("cargo test");
  });

  it("computes heterogeneous multi-model task cost per model bucket in UsageView and BoardView without latest-model distortion", async () => {
    const now = new Date().toISOString();
    const bootstrap = makeBaseBootstrap({
      pricing: {
        schema_version: 1,
        models: {
          "gpt-6-luna": { in: 0.1, cached: 0.01, out: 0.4 },
          "gpt-6.2-sol": { in: 0.3, cached: 0.03, out: 1.2 },
        },
      },
      tasks: [
        {
          id: "t-multi",
          space: "local",
          parent_id: null,
          title: "异构双模型交付任务",
          priority: "P1",
          effective_priority: "P1",
          track: "L2",
          workspace_mode: "git_worktree",
          status: "done",
          stage: "deliver",
          round: 1,
          active_run_id: null,
          contract_version: 1,
          depends_on: [],
          created_at: now,
          updated_at: now,
          agent: "codex",
          model: "gpt-6.2-sol",
          tokens: {
            input_tokens: 70_000,
            cached_input_tokens: 0,
            output_tokens: 4_000,
            total_tokens: 74_000,
          },
          cost_usd: 0.013,
          tokens_by_model: {
            "gpt-6-luna": {
              inputTokens: 60_000,
              cachedInputTokens: 0,
              outputTokens: 1_000,
              totalTokens: 61_000,
              costUsd: 0.0064,
            },
            "gpt-6.2-sol": {
              inputTokens: 10_000,
              cachedInputTokens: 0,
              outputTokens: 3_000,
              totalTokens: 13_000,
              costUsd: 0.0066,
            },
          },
        },
      ],
      usage: {
        inputTokens: 70_000,
        cachedInputTokens: 0,
        outputTokens: 4_000,
        totalTokens: 74_000,
        costUsd: 0.013,
        byAgent: {
          codex: {
            inputTokens: 70_000,
            cachedInputTokens: 0,
            outputTokens: 4_000,
            totalTokens: 74_000,
            costUsd: 0.013,
          },
        },
        byModel: {
          "gpt-6-luna": {
            inputTokens: 60_000,
            cachedInputTokens: 0,
            outputTokens: 1_000,
            totalTokens: 61_000,
            costUsd: 0.0064,
          },
          "gpt-6.2-sol": {
            inputTokens: 10_000,
            cachedInputTokens: 0,
            outputTokens: 3_000,
            totalTokens: 13_000,
            costUsd: 0.0066,
          },
        },
      },
    });

    fetchMock.mockImplementation(async () => jsonResponse(bootstrap));

    const { container } = render(<App />);
    await waitFor(() => {
      expect(screen.getByText("异构双模型交付任务")).toBeTruthy();
    });

    // Board done card must show $0.01 (true per-model sum $0.013), not $0.03 (all tokens * gpt-6.2-sol)
    expect(screen.getByText("74.0k · $0.01")).toBeTruthy();
    expect(screen.queryByText("74.0k · $0.03")).toBeNull();

    // UsageView ranked task row and grand total must both show $0.01
    fireEvent.click(container.querySelector('.tabbar button[data-tab="usage"]')!);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "用量与费用" })).toBeTruthy();
    });
    const rankRow = container.querySelector(".rank-row") as HTMLElement;
    expect(rankRow.textContent).toContain("$0.01");
    expect(rankRow.textContent).not.toContain("$0.03");

    // Live-editing gpt-6-luna input price (0.1 -> 1.0) recalculates the gpt-6-luna bucket accurately:
    // (60k*1.0 + 1k*0.4)/1e6 + $0.0066 = $0.067 -> $0.07
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(await screen.findByRole("tab", { name: "模型单价" }));
    const lunaInput = screen.getByLabelText("gpt-6-luna 输入单价") as HTMLInputElement;
    fireEvent.change(lunaInput, { target: { value: "1" } });

    fireEvent.click(container.querySelector('.tabbar button[data-tab="usage"]')!);
    await waitFor(() => {
      expect((container.querySelector(".rank-row") as HTMLElement).textContent).toContain("$0.07");
    });
    expect(container.querySelector(".stats dd")?.textContent).toBe("$0.07");
  });

  it("discovers local Git repos in SpaceModal with search & 1-click add (disambiguating IDs), picks local directory from IntakeView, and handles non-Git error", async () => {
    const spacesState: BootstrapResponse["spaces"] = {
      kiln: {
        schema_version: 1,
        id: "kiln",
        name: "Kiln Existing",
        repo_path: "/Users/me/AI/Kiln",
        default_branch: "main",
        copy_untracked: [],
        clone_deps: [],
        freeze_patterns: [],
      },
    };
    const putCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    let pickBehavior: "cancel" | "non_git" | "valid" = "cancel";

    fetchMock.mockImplementation(async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;

      if (url === "/api/bootstrap") {
        return jsonResponse(makeBaseBootstrap({ spaces: spacesState }));
      }
      if (url === "/api/spaces/discover") {
        return jsonResponse({
          ok: true,
          scanned_roots: ["~/AI", "~/Code"],
          truncated: false,
          repos: [
            {
              repo_path: "/Users/me/Code/kiln",
              display_path: "~/Code/kiln",
              name: "kiln",
              suggested_id: "kiln",
              default_branch: "develop",
              modified_at: "2026-11-21T10:00:00.000Z",
              already_added: false,
            },
            {
              repo_path: "/Users/me/AI/Kiln",
              display_path: "~/AI/Kiln",
              name: "Kiln",
              suggested_id: "kiln",
              default_branch: "main",
              modified_at: "2026-11-21T09:00:00.000Z",
              already_added: true,
              space_id: "kiln",
            },
          ],
        });
      }
      if (url === "/api/spaces/pick-directory" && method === "POST") {
        if (pickBehavior === "cancel") {
          return jsonResponse({ ok: true, cancelled: true, path: null });
        }
        if (pickBehavior === "non_git") {
          return jsonResponse({ ok: true, cancelled: false, path: "/tmp/plain-folder" });
        }
        return jsonResponse({ ok: true, cancelled: false, path: "/Users/me/Work/gamma" });
      }
      if (url === "/api/spaces/inspect" && method === "POST") {
        if (body?.path === "/tmp/plain-folder") {
          return jsonResponse(
            {
              error: "invalid_repo_path",
              message: '目录 "/tmp/plain-folder" 不是 Git 仓库',
            },
            400,
          );
        }
        if (body?.path === "/Users/me/Code/kiln") {
          return jsonResponse({
            ok: true,
            repo_path: "/Users/me/Code/kiln",
            suggested_id: "kiln",
            suggested_name: "kiln",
            default_branch: "develop",
            default_accept_cmd: "pnpm test",
            copy_untracked: [],
            clone_deps: ["node_modules"],
          });
        }
        return jsonResponse({
          ok: true,
          repo_path: "/Users/me/Work/gamma",
          suggested_id: "gamma",
          suggested_name: "gamma",
          default_branch: "main",
          default_accept_cmd: "cargo test",
          copy_untracked: [],
          clone_deps: [],
        });
      }
      if (url.startsWith("/api/spaces/") && method === "PUT") {
        const id = url.slice("/api/spaces/".length);
        putCalls.push({ url, body: body ?? {} });
        const saved = {
          schema_version: 1 as const,
          id,
          name: String(body?.name ?? id),
          repo_path: String(body?.repo_path ?? ""),
          default_branch: String(body?.default_branch ?? "main"),
          copy_untracked: [],
          clone_deps: (body?.clone_deps as string[]) ?? [],
          ...(body?.default_accept_cmd
            ? { default_accept_cmd: String(body.default_accept_cmd) }
            : {}),
          freeze_patterns: [],
        };
        spacesState[id] = saved;
        return jsonResponse({ ok: true, space: saved }, 201);
      }
      return jsonResponse({});
    });

    window.location.hash = "#view=intake";
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "从文件目录选择" })).toBeTruthy();
    });

    // 1. Cancel directory picker silently does nothing
    fireEvent.click(screen.getByRole("button", { name: "从文件目录选择" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "添加项目空间" })).toBeNull();
    });

    // 2. Non-Git directory shows clear error toast without opening modal
    pickBehavior = "non_git";
    fireEvent.click(await screen.findByRole("button", { name: "从文件目录选择" }));
    await waitFor(() => {
      expect(document.getElementById("toast")?.textContent).toContain("不是 Git 仓库");
    });

    // 3. Valid directory auto-opens SpaceModal pre-inspected and saves gamma
    pickBehavior = "valid";
    fireEvent.click(await screen.findByRole("button", { name: "从文件目录选择" }));
    const prefilledModal = await screen.findByRole("dialog", { name: "添加项目空间" });
    await waitFor(() => {
      expect((within(prefilledModal).getByLabelText("空间标识") as HTMLInputElement).value).toBe(
        "gamma",
      );
    });
    fireEvent.click(within(prefilledModal).getByRole("button", { name: "保存空间" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "添加项目空间" })).toBeNull();
    });
    expect(
      within(screen.getByRole("radiogroup", { name: "目标项目空间" }))
        .getByRole("radio", { name: "gamma" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    // 4. Open modal again: search discovered repos and 1-click add colliding id "kiln" -> "kiln-2"
    fireEvent.click(screen.getByRole("button", { name: "+ 添加项目" }));
    const listModal = await screen.findByRole("dialog", { name: "添加项目空间" });
    await waitFor(() => {
      expect(within(listModal).getByText("~/Code/kiln")).toBeTruthy();
    });
    fireEvent.change(within(listModal).getByLabelText("搜索本机 Git 项目"), {
      target: { value: "Code/kiln" },
    });
    expect(within(listModal).queryByText("~/AI/Kiln")).toBeNull();

    fireEvent.click(within(listModal).getByRole("button", { name: "一键添加" }));
    await waitFor(() => {
      expect(putCalls.some((c) => c.url === "/api/spaces/kiln-2")).toBe(true);
    });
    expect(
      screen
        .getByRole("radiogroup", { name: "目标项目空间" })
        .querySelector('[data-space-id="kiln-2"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("renders rich XSS-safe Markdown in IntakeView & ResolveView, persists active intake context across reload, and clears on close or commit", async () => {
    const now = new Date().toISOString();
    let activeDraft: Record<string, unknown> | null = null;
    const richMarkdown = [
      "## 架构确认",
      "",
      "保留 `git_worktree` 和 `<script>alert(1)</script>` 原样。",
      "",
      "- **加粗** *斜体* ~~删除线~~",
      "- [x] 已读 `packages/kernel`",
      "- [ ] 待确认 [官方文档](https://example.com/docs) 与 [拦截链接](javascript:alert(1))",
      "",
      "> 引用说明：支持 **Markdown** 与代码块",
      "",
      "| 模块 | 状态 |",
      "| :--- | ---: |",
      "| kernel | OK |",
      "",
      "```ts",
      "const x = '<input><script>bad()</script>';",
      "```",
    ].join("\n");

    let savedChatMessages: Array<{ who: string; name?: string; text: string }> = [];
    const draftPayloads: Array<Record<string, unknown>> = [];

    fetchMock.mockImplementation(async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;

      if (url === "/api/bootstrap") {
        return jsonResponse(
          makeBaseBootstrap({
            drafts: activeDraft ? [activeDraft as never] : [],
            tasks: [
              {
                id: "t-res-md",
                space: "kiln",
                parent_id: null,
                title: "Markdown 讨论任务",
                priority: "P1",
                effective_priority: "P1",
                track: "L2",
                workspace_mode: "git_worktree",
                status: "waiting",
                stage: "implement",
                round: 1,
                active_run_id: null,
                contract_version: 1,
                depends_on: [],
                created_at: now,
                updated_at: now,
                tokens: {
                  input_tokens: 0,
                  cached_input_tokens: 0,
                  output_tokens: 0,
                  total_tokens: 0,
                },
                cost_usd: 0,
              },
            ],
            pendingDecisions: [
              {
                id: "dec-md",
                task_id: "t-res-md",
                contract_version: 1,
                reason: "confirm",
                category: "arch",
                question: "请确认 **方案 A**（含 `<script>xss</script>`）",
                options: [{ id: "opt-1", label: "采纳", action: "resume", recommended: true }],
                created_at: now,
              },
            ],
          }),
        );
      }
      if (url === "/api/drafts" && method === "POST") {
        draftPayloads.push(body ?? {});
        activeDraft = {
          schema_version: 1,
          id: String(body?.id ?? "d-persist-1"),
          title: String(body?.title ?? activeDraft?.title ?? "持久化需求"),
          space: String(body?.space ?? activeDraft?.space ?? "kiln"),
          priority: String(body?.priority ?? activeDraft?.priority ?? "P2"),
          track: String(body?.track ?? activeDraft?.track ?? "L2"),
          workspace_mode: String(
            body?.workspace_mode ?? activeDraft?.workspace_mode ?? "git_worktree",
          ),
          depends_on: [],
          contract: (body?.contract ?? activeDraft?.contract ?? {}) as Record<string, unknown>,
          intake_open: body?.intake_open ?? activeDraft?.intake_open,
          created_at: now,
          updated_at: now,
        };
        return jsonResponse({ ok: true, draft: activeDraft }, 201);
      }
      if (url === "/api/drafts/d-persist-1/chat" && method === "POST") {
        savedChatMessages = [
          { who: "me", text: String(body?.message ?? "") },
          { who: "agent", name: "intake", text: richMarkdown },
        ];
        activeDraft = {
          ...activeDraft,
          title: "支持 Markdown 立项对话",
          contract: {
            goal: "支持 Markdown 立项对话",
            end: "完成格式化渲染",
            accept_cmd: "pnpm test",
            scope: ["apps/web/**"],
          },
          intake_open: true,
        };
        return jsonResponse({
          ok: true,
          messages: savedChatMessages,
          draft: activeDraft,
        });
      }
      if (url === "/api/drafts/d-persist-1/chat" && method === "GET") {
        return jsonResponse({ ok: true, draftId: "d-persist-1", messages: savedChatMessages });
      }
      if (url === "/api/drafts/d-persist-1/commit" && method === "POST") {
        activeDraft = null;
        return jsonResponse({ ok: true, card: { id: body?.id ?? "t-101" }, state: {} }, 201);
      }
      if (url === "/api/tasks/t-res-md") {
        return jsonResponse({
          card: {
            schema_version: 1,
            id: "t-res-md",
            title: "Markdown 讨论任务",
            space: "kiln",
            priority: "P1",
            track: "L2",
            workspace_mode: "git_worktree",
            parent: null,
            depends_on: [],
            contract_version: 1,
            contract: {
              goal: "g",
              end: "e",
              accept_cmd: "pnpm test",
              accept_files_hash: "h",
              scope: ["src/**"],
              deliver: { mode: "merge_main", cmd: null },
              human_accept: false,
              external_actions: "ask",
            },
            limits: {
              retries_per_stage: 2,
              review_rounds: 2,
              advisor_calls: 1,
              max_tokens: 250000,
            },
            created_at: now,
            updated_at: now,
          },
          state: {
            status: "waiting",
            stage: "implement",
            round: 1,
            activeRunId: null,
            priority: "P1",
            effectivePriority: "P1",
            track: "L2",
            contractVersion: 1,
            updatedAt: now,
          },
          brief: "",
          decisions: "",
          pendingDecision: {
            id: "dec-md",
            task_id: "t-res-md",
            contract_version: 1,
            reason: "confirm",
            category: "arch",
            question: "请确认 **方案 A**（含 `<script>xss</script>`）",
            options: [{ id: "opt-1", label: "采纳", action: "resume", recommended: true }],
            created_at: now,
          },
          ledgerProposals: [],
          runs: [],
          usageTurns: [],
          usage: makeBaseBootstrap().usage,
        });
      }
      if (url === "/api/tasks/t-res-md/chat" && method === "GET") {
        return jsonResponse({ ok: true, messages: [] });
      }
      if (url === "/api/tasks/t-res-md/chat" && method === "POST") {
        return jsonResponse({
          ok: true,
          messages: [
            { who: "me", text: String(body?.message ?? "") },
            { who: "agent", name: "resolver", text: "### 建议\n\n采用 **方案 A**" },
          ],
        });
      }
      return jsonResponse({});
    });

    // 1. Start chat in IntakeView -> renders rich Markdown safely
    window.location.hash = "#view=intake";
    const first = render(<App />);
    await waitFor(() => {
      expect(document.getElementById("chatIn")).toBeTruthy();
    });
    fireEvent.change(document.getElementById("chatIn")!, {
      target: { value: "我想优化立项对话体验" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "架构确认" })).toBeTruthy();
    });
    expect(draftPayloads[0]?.intake_open).toBe(true);

    const msgsEl = document.getElementById("msgs")!;
    expect(msgsEl.querySelector("strong")?.textContent).toBe("加粗");
    expect(msgsEl.querySelector("em")?.textContent).toBe("斜体");
    expect(msgsEl.querySelector("del")?.textContent).toBe("删除线");
    expect(msgsEl.querySelector("blockquote")).toBeTruthy();
    expect(msgsEl.querySelector("table.md-table")).toBeTruthy();
    expect(msgsEl.querySelector(".md-code-head")?.textContent).toContain("ts");
    // snake_case identifier must NOT be turned into italic
    expect(msgsEl.querySelectorAll("em")).toHaveLength(1);
    // Safe https link allowed; javascript: link blocked from <a>
    const links = Array.from(msgsEl.querySelectorAll("a"));
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://example.com/docs");
    expect(msgsEl.querySelectorAll("script")).toHaveLength(0);
    expect(msgsEl.querySelectorAll("input")).toHaveLength(0);

    // 2. Navigate to board -> IntakeDock stays visible
    fireEvent.click(screen.getByRole("button", { name: "返回看板" }));
    await waitFor(() => {
      expect(document.querySelector('[data-intake-dock="true"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-intake-dock="true"]')?.textContent).toContain(
      "支持 Markdown 立项对话",
    );

    // 3. Simulate page reload / Desktop window destroy & reopen (unmount & remount) -> Dock auto-restores
    first.unmount();
    window.location.hash = "";
    const second = render(<App />);
    await waitFor(() => {
      expect(document.querySelector('[data-intake-dock="true"]')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /继续对话/ }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "架构确认" })).toBeTruthy();
    });

    // 4. Verify ResolveView uses Markdown + textarea Shift+Enter / Enter
    window.location.hash = "#resolve=t-res-md";
    fireEvent(window, new HashChangeEvent("hashchange"));
    await waitFor(() => {
      expect(screen.getAllByText("方案 A").length).toBeGreaterThanOrEqual(1);
    });
    const resolveInput = document.getElementById("chatIn") as HTMLTextAreaElement;
    expect(resolveInput.tagName).toBe("TEXTAREA");
    fireEvent.change(resolveInput, { target: { value: "请细化方案 A" } });
    fireEvent.keyDown(resolveInput, { key: "Enter", shiftKey: false });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "建议" })).toBeTruthy();
    });

    // 5. Close active intake via dock × -> sends intake_open: false and hides dock
    fireEvent.click(screen.getAllByRole("button", { name: "总览" })[0]!);
    const closeDockBtn = await screen.findByRole("button", {
      name: "关闭未完成的新需求对话",
    });
    fireEvent.click(closeDockBtn);
    await waitFor(() => {
      expect(document.querySelector('[data-intake-dock="true"]')).toBeNull();
    });
    expect(draftPayloads.at(-1)).toMatchObject({ id: "d-persist-1", intake_open: false });

    // 6. Re-load draft and commit -> clears dock and persistence cleanly
    fireEvent.click(screen.getByRole("button", { name: "新需求 N" }));
    fireEvent.click(await screen.findByRole("button", { name: /^支持 Markdown 立项对话/ }));
    fireEvent.click(screen.getByRole("tab", { name: /立项设置/ }));
    await waitFor(() => {
      expect((screen.getByLabelText("标题") as HTMLInputElement).value).toBe(
        "支持 Markdown 立项对话",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "开始推进" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "总览" })).toBeTruthy();
    });
    expect(document.querySelector('[data-intake-dock="true"]')).toBeNull();
    expect(window.localStorage.getItem("kiln.activeIntakeDraftId")).toBeNull();
    second.unmount();
  });

  it("syncs model pricing from remote API, tags custom edits, preserves overrides, and restores synced prices", async () => {
    let pricingState: NonNullable<BootstrapResponse["pricing"]> = {
      schema_version: 1,
      models: {
        "gpt-5.4": { in: 1.25, cached: 0.125, out: 10 },
        "unused-old-model": { in: 9, cached: 1, out: 20 },
      },
    };
    const syncCalls: Array<Record<string, unknown>> = [];

    fetchMock.mockImplementation(async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;

      if (url === "/api/bootstrap") {
        return jsonResponse(
          makeBaseBootstrap({
            pricing: pricingState,
          }),
        );
      }
      if (url === "/api/settings/pricing/sync" && method === "POST") {
        syncCalls.push(body ?? {});
        if (body?.restore_model === "gpt-5.4") {
          pricingState = {
            schema_version: 1,
            models: {
              "gpt-5.4": { in: 2.5, cached: 0.25, out: 15 },
              "claude-sonnet-4-6": { in: 3, cached: 0.3, out: 15 },
            },
            sync: {
              source: "models.dev",
              synced_at: "2026-11-21T12:05:00.000Z",
            },
          };
          return jsonResponse({
            ok: true,
            pricing: pricingState,
            source: "models.dev",
            synced_at: "2026-11-21T12:05:00.000Z",
            from_cache: true,
            matched_models: ["gpt-5.4", "claude-sonnet-4-6"],
            unmatched_models: [],
            preserved_overrides: [],
          });
        }
        pricingState = {
          schema_version: 1,
          models: {
            "gpt-5.4": { in: 2.5, cached: 0.25, out: 15 },
            "claude-sonnet-4-6": { in: 3, cached: 0.3, out: 15 },
          },
          sync: {
            source: "models.dev",
            synced_at: "2026-11-21T12:00:00.000Z",
          },
        };
        return jsonResponse({
          ok: true,
          pricing: pricingState,
          source: "models.dev",
          synced_at: "2026-11-21T12:00:00.000Z",
          from_cache: false,
          matched_models: ["gpt-5.4", "claude-sonnet-4-6"],
          unmatched_models: [],
          preserved_overrides: [],
        });
      }
      if (url === "/api/settings/pricing" && method === "PUT") {
        pricingState = body as NonNullable<BootstrapResponse["pricing"]>;
        return jsonResponse({ ok: true, section: "pricing", data: pricingState });
      }
      return jsonResponse({});
    });

    window.location.hash = "#view=settings&tab=pricing";
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "立即同步单价" })).toBeTruthy();
    });

    // Baseline cost before sync: (600k*1.25 + 400k*0.125 + 100k*10)/1e6 = $1.80
    expect(document.getElementById("upTotalCost")?.textContent).toBe("$1.80");
    // Defaults to showing ONLY configured role models (with role tags & 未匹配 hints), hiding unconfigured entries
    expect(screen.queryByText("unused-old-model")).toBeNull();
    expect(screen.getAllByText("未匹配").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "显示其他已记录/历史模型 (1)" }));
    expect(screen.getByText("unused-old-model")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "收起未配置模型" }));
    expect(screen.queryByText("unused-old-model")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "立即同步单价" }));
    await waitFor(() => {
      expect(screen.getByText("models.dev")).toBeTruthy();
    });
    expect(syncCalls[0]).toEqual({ force: true });
    expect(screen.getByText("claude-sonnet-4-6")).toBeTruthy();
    // Updated cost: (600k*2.5 + 400k*0.25 + 100k*15)/1e6 = $3.10
    expect(document.getElementById("upTotalCost")?.textContent).toBe("$3.10");

    // Manual edit marks custom_models, shows 自定义 chip & 恢复同步价 button
    fireEvent.change(screen.getByLabelText("gpt-5.4 输入单价"), {
      target: { value: "10" },
    });
    await waitFor(() => {
      expect(screen.getByText("自定义")).toBeTruthy();
      expect(document.getElementById("upTotalCost")?.textContent).toBe("$7.60");
    });

    fireEvent.click(screen.getByRole("button", { name: "保存单价表" }));
    await waitFor(() => {
      expect(pricingState.custom_models).toEqual(["gpt-5.4"]);
    });

    // Clicking 恢复同步价 restores synced pricing and removes 自定义 tag
    fireEvent.click(screen.getByRole("button", { name: "恢复 gpt-5.4 同步单价" }));
    await waitFor(() => {
      expect(screen.queryByText("自定义")).toBeNull();
    });
    expect(syncCalls.at(-1)).toEqual({ force: false, restore_model: "gpt-5.4" });
    expect(document.getElementById("upTotalCost")?.textContent).toBe("$3.10");
  });

  it("supports zero-select Tab intake selectors, live SSE intake.progress, 产品方案 preview/raw edit & open_questions, 1-click PM autofill, and lossless BRIEF.md commit (#5 + #6)", async () => {
    const now = new Date().toISOString();
    let resolveChatDeferred: ((res: Response) => void) | null = null;
    let commitPayload: Record<string, unknown> | null = null;
    const chatMessagesSent: string[] = [];

    const fullBrief = [
      "## 1. 目标与用户场景",
      "通过结构化产品方案替代手工表单填充。",
      "",
      "## 2. 已确认规则与关键流程 / 边界",
      "- 右侧默认展示 Markdown 方案；待拍板清零后即可直接立项。",
      "",
      "## 3. 选定落地方案与关键取舍",
      "- 方案 A（推荐）：`drafts/<id>/BRIEF.md` 与 `card.yaml` 并行同步。",
    ].join("\n");

    fetchMock.mockImplementation(async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;

      if (url === "/api/bootstrap") {
        return jsonResponse(
          makeBaseBootstrap({
            spaces: {
              alpha: {
                schema_version: 1,
                id: "alpha",
                name: "Alpha",
                repo_path: "/repos/alpha",
                default_branch: "main",
                copy_untracked: [],
                clone_deps: [],
                default_accept_cmd: "pnpm alpha:test",
                freeze_patterns: [],
              },
              beta: {
                schema_version: 1,
                id: "beta",
                name: "Beta",
                repo_path: "/repos/beta",
                default_branch: "main",
                copy_untracked: [],
                clone_deps: [],
                default_accept_cmd: "cargo test",
                freeze_patterns: [],
              },
            },
          }),
        );
      }
      if (url === "/api/drafts" && method === "POST") {
        return jsonResponse(
          {
            ok: true,
            draft: {
              schema_version: 1,
              id: String(body?.id ?? "d-pm-ui-1"),
              title: String(body?.title ?? ""),
              space: String(body?.space ?? "alpha"),
              priority: String(body?.priority ?? "P2"),
              track: String(body?.track ?? "L2"),
              workspace_mode: String(body?.workspace_mode ?? "git_worktree"),
              depends_on: [],
              open_questions: (body?.open_questions as string[]) ?? [],
              contract: (body?.contract ?? {}) as Record<string, unknown>,
              created_at: now,
              updated_at: now,
            },
          },
          201,
        );
      }
      if (url === "/api/drafts/d-pm-ui-1/chat" && method === "POST") {
        chatMessagesSent.push(String(body?.message ?? ""));
        return await new Promise<Response>((resolve) => {
          resolveChatDeferred = resolve;
        });
      }
      if (url === "/api/drafts/d-pm-ui-1/commit" && method === "POST") {
        commitPayload = body ?? {};
        return jsonResponse({ ok: true, card: { id: body?.id ?? "t-101" }, state: {} }, 201);
      }
      return jsonResponse({});
    });

    window.location.hash = "#view=intake";
    const { container } = render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("radiogroup", { name: "目标项目空间" })).toBeTruthy();
    });

    // Zero <select> inside IntakeView
    expect(container.querySelectorAll(".converse select")).toHaveLength(0);

    // Click Beta project chip
    const betaRadio = within(screen.getByRole("radiogroup", { name: "目标项目空间" })).getByRole(
      "radio",
      { name: "Beta" },
    );
    fireEvent.click(betaRadio);
    expect(betaRadio.getAttribute("aria-checked")).toBe("true");

    // Switch to 立项设置 tab -> pick P1 priority chip & L1 track chip, then trigger 1-click 「让立项助手补全」
    fireEvent.click(screen.getByRole("tab", { name: /立项设置/ }));
    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "优先级" })).getByRole("radio", {
        name: "P1 重要",
      }),
    );
    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "轨道" })).getByRole("radio", {
        name: "L1 快车道",
      }),
    );
    expect(screen.getByText("PM 执行契约摘要")).toBeTruthy();
    expect(screen.queryByLabelText("交付终点")).toBeNull(); // Collapsed by default!

    fireEvent.click(screen.getByRole("button", { name: "让立项助手补全" }));
    await waitFor(() => {
      expect(chatMessagesSent).toHaveLength(1);
    });

    // Emit live SSE intake.progress events while turn is in-flight
    const sse = MockEventSource.instances[0]!;
    sse.emit("intake.progress", {
      seq: 10,
      type: "intake.progress",
      draftId: "d-pm-ui-1",
      kind: "tool",
      toolName: "read_file",
      text: "正在读取/调用 read_file · src/lib.rs",
      at: now,
    });
    sse.emit("intake.progress", {
      seq: 11,
      type: "intake.progress",
      draftId: "d-pm-ui-1",
      kind: "draft_updated",
      toolName: "wb_plan",
      text: "已同步《产品方案》与立项草稿",
      at: now,
    });

    const progressList = await screen.findByRole("list", { name: "立项探索进度" });
    expect(progressList.textContent).toContain("src/lib.rs");
    expect(progressList.textContent).toContain("已同步《产品方案》与立项草稿");

    // Finish PM turn with open_questions + brief_markdown + auto-filled contract
    resolveChatDeferred!(
      jsonResponse({
        ok: true,
        messages: [
          { who: "me", text: chatMessagesSent[0]! },
          { who: "agent", name: "intake", text: "已为你生成首版设计方案并补全契约。" },
        ],
        brief_markdown: fullBrief,
        draft: {
          schema_version: 1,
          id: "d-pm-ui-1",
          title: "升级 Beta 导出流程",
          space: "beta",
          priority: "P1",
          track: "L1",
          workspace_mode: "git_worktree",
          depends_on: [],
          open_questions: ["是否限制单次导出上限？"],
          contract: {
            goal: "升级 Beta 导出流程",
            end: "支持 CSV 与 JSON 双格式导出",
            accept_cmd: "cargo test",
            scope: ["src/export/**"],
          },
          brief_markdown: fullBrief,
          created_at: now,
          updated_at: now,
        },
      }),
    );

    // Thinking progress list disappears when turn completes
    await waitFor(() => {
      expect(screen.queryByRole("list", { name: "立项探索进度" })).toBeNull();
    });

    // Collapsed contract summary immediately reflects PM auto-filled values (8/8 ready)
    expect(screen.getByText("支持 CSV 与 JSON 双格式导出")).toBeTruthy();
    expect(document.getElementById("draftProg")?.textContent).toBe("8 / 8");

    // Switch back to 产品方案 tab -> verifies Markdown preview + open_questions + raw edit
    fireEvent.click(screen.getByRole("tab", { name: /产品方案/ }));
    expect(screen.getByLabelText("待拍板事项").textContent).toContain("是否限制单次导出上限？");
    const briefPreview = document.querySelector('[data-brief-preview="true"]')!;
    expect(briefPreview.querySelector("h2")?.textContent).toContain("1. 目标与用户场景");

    // Edit raw Markdown and verify commit passes the edited full brief verbatim (NOT the 4-line fallback!)
    fireEvent.click(screen.getByRole("button", { name: "编辑原文" }));
    const rawEditor = screen.getByLabelText("产品方案原文") as HTMLTextAreaElement;
    fireEvent.change(rawEditor, {
      target: { value: `${fullBrief}\n\n- 人工追加：单次上限 10000 条。` },
    });
    fireEvent.click(screen.getByRole("button", { name: "完成预览" }));
    expect(document.querySelector('[data-brief-preview="true"]')?.textContent).toContain(
      "人工追加：单次上限 10000 条。",
    );

    fireEvent.click(screen.getByRole("button", { name: "开始推进" }));
    await waitFor(() => {
      expect(commitPayload).not.toBeNull();
    });
    const sentCommit = commitPayload as Record<string, unknown> | null;
    expect(sentCommit?.priority).toBe("P1");
    expect(sentCommit?.track).toBe("L1");
    expect(sentCommit?.space).toBe("beta");
    expect(String(sentCommit?.brief_markdown)).toContain("## 3. 选定落地方案与关键取舍");
    expect(String(sentCommit?.brief_markdown)).toContain("人工追加：单次上限 10000 条。");
  });

  it("renders daemon version pill in sidebar brand and Settings connection tab", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/bootstrap") {
        return jsonResponse(makeBaseBootstrap({ version: "0.0.3" }));
      }
      return jsonResponse({});
    });
    render(<App />);

    const brandVer = await waitFor(() => {
      const el = document.querySelector(".brand-ver");
      expect(el?.textContent?.trim()).toBe("v0.0.3");
      return el!;
    });
    expect(brandVer.getAttribute("title")).toBe("Kiln v0.0.3");

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(await screen.findByRole("tab", { name: "连接与底座" }));

    expect(screen.getByText("Kiln 版本与运行模式")).toBeTruthy();
    expect(screen.getAllByText("v0.0.3").length).toBeGreaterThanOrEqual(2);
  });

  it("renders file:// path pills cleanly, prevents narrow-column table crushing, nests indented lists, and highlights long fenced code", () => {
    const richMarkdown = [
      "| 类别 | 估算体积 | 最近活跃 | 说明 |",
      "| :--- | :--- | :--- | :--- |",
      "| [`/private/tmp`](file:///private/tmp) | 约 750MB+ | Nov 19-20 | 含 [`t3dmg`](file:///private/tmp/t3dmg) (481M)、[`kiln-verify`](file:///private/tmp/kiln) (133M) 与 `pnpm-cache` 及一批临时构建产物 \\| 附注 |",
      "",
      "1. 一级要点",
      "   - 嵌套列表项 `npm_cache`",
      "   - 跨行链接 [~/.pnpm-store](file:///Users/saonian/.pnpm-store#L12)",
      "",
      "```sh",
      ...Array.from({ length: 30 }, (_, i) => `echo "line-${i + 1}" # comment ${i + 1}`),
      "```",
    ].join("\n");

    const { rerender } = render(<MarkdownContent text={richMarkdown} allowReveal={true} />);

    // No raw file:// link syntax leaks into visible text and no dangerous <a href="file://">
    expect(document.body.textContent).not.toContain("file:///");
    expect(document.querySelector('a[href^="file:"]')).toBeNull();

    // Renders file pills with copy + local reveal button
    const tmpPill = screen.getByRole("button", { name: "/private/tmp" });
    expect(tmpPill.getAttribute("title")).toBe("点击复制路径：/private/tmp");
    expect(screen.getByRole("button", { name: "在文件管理器中定位 /private/tmp" })).toBeTruthy();
    expect(screen.getByText("~/.pnpm-store:12")).toBeTruthy();

    // Compact vs wide table columns prevent single-character vertical wrapping
    const volumeCell = screen.getByText("约 750MB+").closest("td");
    const dateCell = screen.getByText("Nov 19-20").closest("td");
    const descCell = screen.getByText(/与/).closest("td");
    expect(volumeCell?.className).toContain("col-compact");
    expect(dateCell?.className).toContain("col-compact");
    expect(descCell?.className).toContain("col-wide");
    expect(descCell?.textContent).toContain("| 附注");

    // Nested indented list lives inside parent <li>
    const outerLi = screen.getByText("一级要点").closest("li");
    expect(outerLi?.querySelector("ul")?.textContent).toContain("嵌套列表项");

    // Syntax highlight tokens & long-code collapse toggle
    expect(document.querySelector(".tok-cmt")).toBeTruthy();
    expect(document.querySelector(".tok-str")).toBeTruthy();
    const expandCodeBtn = screen.getByRole("button", { name: "展开全部 30 行" });
    fireEvent.click(expandCodeBtn);
    expect(screen.getByRole("button", { name: "收起代码" })).toBeTruthy();

    // Remote mode hides local reveal buttons while preserving copy pills
    rerender(<MarkdownContent text={richMarkdown} allowReveal={false} />);
    expect(screen.queryByRole("button", { name: "在文件管理器中定位 /private/tmp" })).toBeNull();
    expect(screen.getByRole("button", { name: "/private/tmp" })).toBeTruthy();
  });

  it("groups tool steps into a collapsible Work Log timeline with coalesced repeats and agent copy button", () => {
    const messages = [
      { who: "me" as const, text: "帮我巡检临时目录", at: "2026-11-21T10:20:29.000Z" },
      {
        who: "tool" as const,
        toolName: "run_command",
        text: "run_command · ls -la /Users/saonian && df -h /",
      },
      { who: "tool" as const, toolName: "manage_task", text: "manage_task" },
      { who: "tool" as const, toolName: "manage_task", text: "manage_task" },
      { who: "tool" as const, toolName: "manage_task", text: "manage_task" },
      {
        who: "tool" as const,
        toolName: "draft_patch",
        text: "draft_patch · 自动回填格式校验失败，请核对",
      },
      {
        who: "agent" as const,
        name: "intake",
        text: "## 分析结论\n已完成扫描。",
        at: "2026-11-21T10:24:34.000Z",
      },
    ];

    render(
      <ChatTimeline
        messages={messages}
        busy={false}
        busyLabel="思考中…"
        roleLabel="立项助手"
        defaultAgentName="intake"
      />,
    );

    const toggle = screen.getByRole("button", { name: /探索与操作 · 5 步/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("含提示");
    // Tool step details hidden before expanding
    expect(screen.queryByText(/ls -la \/Users\/saonian/)).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/ls -la \/Users\/saonian/)).toBeTruthy();
    // Repeated arg-less manage_task calls coalesce with x3 badge
    expect(screen.getByText("×3")).toBeTruthy();

    // Agent message renders header metadata and copy button
    expect(screen.getByText("立项助手")).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制消息正文" })).toBeTruthy();
  });

  it("supports system/light/dark theme switching with matchMedia adaptation and localStorage persistence", async () => {
    let systemMatchesLight = true;
    const changeListeners = new Set<(e: MediaQueryListEvent) => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-color-scheme: light") ? systemMatchesLight : false,
      media: query,
      onchange: null,
      addEventListener: (_event: string, cb: (e: MediaQueryListEvent) => void) => {
        changeListeners.add(cb);
      },
      removeEventListener: (_event: string, cb: (e: MediaQueryListEvent) => void) => {
        changeListeners.delete(cb);
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    }));

    let meta = document.querySelector('meta[name="theme-color"]');
    let createdMeta = false;
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      meta.setAttribute("content", "#121110");
      document.head.appendChild(meta);
      createdMeta = true;
    }

    try {
      const r1 = render(<App />);
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "总览" })).toBeTruthy();
      });

      // Default "system" picks up OS light preference and updates dynamically on system change
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(document.documentElement.dataset.themePref).toBe("system");
      expect(document.documentElement.style.colorScheme).toBe("light");
      expect(meta.getAttribute("content")).toBe("#f7f5f0");

      const sidebarThemeGroup = screen.getByRole("radiogroup", { name: "外观主题" });
      expect(
        within(sidebarThemeGroup)
          .getByRole("radio", { name: "跟随系统" })
          .getAttribute("aria-checked"),
      ).toBe("true");

      systemMatchesLight = false;
      for (const cb of changeListeners) {
        cb({ matches: false } as MediaQueryListEvent);
      }
      await waitFor(() => {
        expect(document.documentElement.dataset.theme).toBe("dark");
      });
      expect(meta.getAttribute("content")).toBe("#121110");

      // Switch to explicit light via Sidebar quick switcher
      fireEvent.click(within(sidebarThemeGroup).getByRole("radio", { name: "浅色主题" }));
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(document.documentElement.dataset.themePref).toBe("light");
      expect(window.localStorage.getItem("kiln.theme")).toBe("light");
      expect(meta.getAttribute("content")).toBe("#f7f5f0");

      // Navigate to Settings -> 连接与底座 and verify synced segmented control
      window.location.hash = "#view=settings&tab=conn";
      fireEvent(window, new HashChangeEvent("hashchange"));
      const settingsThemeGroup = await screen.findByRole("radiogroup", {
        name: "外观主题设置",
      });
      expect(
        within(settingsThemeGroup)
          .getByRole("radio", { name: "浅色" })
          .getAttribute("aria-checked"),
      ).toBe("true");

      fireEvent.click(within(settingsThemeGroup).getByRole("radio", { name: "深色" }));
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(window.localStorage.getItem("kiln.theme")).toBe("dark");

      // Unmount and remount to verify localStorage persistence
      r1.unmount();
      render(<App />);
      await waitFor(() => {
        expect(screen.getByRole("radiogroup", { name: "外观主题" })).toBeTruthy();
      });
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(document.documentElement.dataset.themePref).toBe("dark");
      expect(
        within(screen.getByRole("radiogroup", { name: "外观主题" }))
          .getByRole("radio", { name: "深色主题" })
          .getAttribute("aria-checked"),
      ).toBe("true");

      // Switch back to system (currently OS dark)
      fireEvent.click(
        within(screen.getByRole("radiogroup", { name: "外观主题" })).getByRole("radio", {
          name: "跟随系统",
        }),
      );
      expect(window.localStorage.getItem("kiln.theme")).toBe("system");
      expect(document.documentElement.dataset.themePref).toBe("system");
      expect(document.documentElement.dataset.theme).toBe("dark");
    } finally {
      if (createdMeta) {
        meta.remove();
      }
      window.localStorage.removeItem("kiln.theme");
      document.documentElement.removeAttribute("data-theme");
      document.documentElement.removeAttribute("data-theme-pref");
      document.documentElement.style.colorScheme = "";
    }
  });

  it("allows collapsing and re-expanding the desktop right panel in IntakeView without affecting mobile toggle", async () => {
    window.location.hash = "#view=intake";
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "收起侧栏" })).toBeTruthy();
    });

    const converse = document.querySelector(".converse")!;
    const collapseBtn = screen.getByRole("button", { name: "收起侧栏" });
    expect(converse.classList.contains("is-panel-collapsed")).toBe(false);
    expect(collapseBtn.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(collapseBtn);
    expect(converse.classList.contains("is-panel-collapsed")).toBe(true);
    const expandBtn = screen.getByRole("button", { name: "展开方案栏" });
    expect(expandBtn.getAttribute("aria-pressed")).toBe("true");

    // Existing mobile drawer toggle remains intact and independent
    const mobileToggle = document.getElementById("btnDraftToggle")!;
    const aside = document.querySelector("aside.draft")!;
    expect(aside.classList.contains("open")).toBe(false);
    fireEvent.click(mobileToggle);
    expect(aside.classList.contains("open")).toBe(true);

    fireEvent.click(expandBtn);
    expect(converse.classList.contains("is-panel-collapsed")).toBe(false);
  });

  it("renders live thinking progress steps inside .worklog-row without vertical flex-basis regression or unconditional scrollbar-width", async () => {
    const now = new Date().toISOString();
    render(
      <ChatTimeline
        messages={[{ who: "me", text: "扫描大目录" }]}
        busy={true}
        busyLabel="正在思考并整理产品方案…"
        progressLogs={[
          {
            kind: "tool",
            toolName: "run_command",
            text: "正在读取/调用 run_command · ls -la /Users/saonian/.kiln/drafts/d-1e1321f0",
            at: now,
          },
          {
            kind: "tool",
            toolName: "read_file",
            text: "正在调用 read_file",
            at: now,
          },
        ]}
        roleLabel="立项助手"
        defaultAgentName="intake"
      />,
    );

    const liveCard = document.querySelector(".worklog.is-live");
    expect(liveCard).toBeTruthy();
    expect(liveCard?.querySelector(".worklog-live-head")?.textContent).toContain("2 步");

    const list = screen.getByRole("list", { name: "立项探索进度" });
    const rows = list.querySelectorAll(".worklog-item .worklog-row > .worklog-detail");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("title")).toContain("run_command");

    // Static CSS regression guards: prevent flex-basis: 200px in vertical container & global scrollbar-width disabling webkit styling
    const [{ existsSync, readFileSync }, pathMod] = await Promise.all([
      import("node:fs"),
      import("node:path"),
    ]);
    const stylesDir = existsSync(pathMod.resolve(process.cwd(), "apps/web/src/styles/tokens.css"))
      ? pathMod.resolve(process.cwd(), "apps/web/src/styles")
      : pathMod.resolve(process.cwd(), "src/styles");
    const tokensCss = readFileSync(pathMod.resolve(stylesDir, "tokens.css"), "utf8");
    const layoutCss = readFileSync(pathMod.resolve(stylesDir, "layout.css"), "utf8");
    expect(tokensCss.length).toBeGreaterThan(200);
    expect(layoutCss.length).toBeGreaterThan(2000);
    expect(tokensCss).not.toContain("scrollbar-width:");
    expect(layoutCss).not.toMatch(/\.worklog-detail\s*\{[^}]*flex:\s*1\s+1\s+200px/);
    expect(layoutCss).toContain(".worklog-row > .worklog-detail");
    expect(layoutCss).toContain("::-webkit-scrollbar-thumb");
    expect(layoutCss).not.toContain("*:hover::-webkit-scrollbar-thumb");
  });

  it("detects / and @ composer triggers strictly without false positives on paths or emails", () => {
    expect(detectComposerTrigger("/", 1)).toEqual({
      kind: "/",
      start: 0,
      end: 1,
      query: "",
    });
    expect(detectComposerTrigger("  /br", 5)).toEqual({
      kind: "/",
      start: 2,
      end: 5,
      query: "br",
    });
    // Path separators mid-message must NOT trigger / commands
    expect(detectComposerTrigger("请修改 apps/web/src", 19)).toBeNull();

    expect(detectComposerTrigger("@", 1)).toEqual({
      kind: "@",
      start: 0,
      end: 1,
      query: "",
    });
    expect(detectComposerTrigger("结合 @apps/web", 12)).toEqual({
      kind: "@",
      start: 3,
      end: 12,
      query: "apps/web",
    });
    // Emails must NOT trigger @ mentions
    expect(detectComposerTrigger("联系 foo@bar.com", 14)).toBeNull();
  });

  it("supports / command/skill completion, Esc dismissal without leaving intake, /new reset, and @ file/task/ledger mentions", async () => {
    const now = new Date().toISOString();
    const bootstrap = makeBaseBootstrap({
      tasks: [
        {
          id: "t-ref-9",
          space: "kiln",
          parent_id: null,
          title: "支持命令提示",
          priority: "P1",
          effective_priority: "P1",
          track: "L2",
          workspace_mode: "git_worktree",
          status: "running",
          stage: "implement",
          round: 1,
          active_run_id: "r-1",
          contract_version: 1,
          depends_on: [],
          created_at: now,
          updated_at: now,
          tokens: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          cost_usd: 0,
        },
      ],
      ledgers: {
        kiln: {
          schema_version: 1,
          space: "kiln",
          entries: [
            {
              id: "l-1",
              space: "kiln",
              rule: "禁用额外 UI 组件库",
              source_task_id: "t-1",
              created_at: now,
            },
          ],
        },
      },
    });

    const sentChats: string[] = [];
    fetchMock.mockImplementation(async (url, init) => {
      if (url.startsWith("/api/chat/commands")) {
        return jsonResponse({
          ok: true,
          role: "intake",
          agent: "antigravity",
          model: "gemini-pro-orchestrator-neon",
          commands: [
            {
              name: "brief",
              description: "生成或更新产品方案",
              argumentHint: "[说明]",
              kind: "command",
              source: "kiln",
              action: "generate_brief",
            },
            {
              name: "new",
              description: "开启新草稿",
              argumentHint: "",
              kind: "command",
              source: "kiln",
              action: "new_draft",
            },
            {
              name: "forge-dialogue",
              description: "梳理复杂产品模型",
              argumentHint: "",
              kind: "skill",
              source: "skill",
              scope: "project",
            },
          ],
          mcpServers: [
            {
              name: "context7",
              scope: "project",
              origin: ".mcp.json",
            },
          ],
        });
      }
      if (url.includes("/files")) {
        const u = new URL(url, "http://127.0.0.1");
        const q = u.searchParams.get("q") ?? "";
        if (q.startsWith("~/AI/")) {
          return jsonResponse({
            ok: true,
            spaceId: "local",
            query: q,
            rootLabel: "~/AI",
            files: [
              { path: "~/AI/Kiln/", kind: "dir" },
              { path: "~/AI/Kiln/README.md", kind: "file" },
            ],
            truncated: false,
          });
        }
        return jsonResponse({
          ok: true,
          spaceId: "local",
          query: q,
          rootLabel: "~",
          files: [
            { path: "~/AI/", kind: "dir" },
            { path: "~/Desktop/", kind: "dir" },
          ],
          truncated: false,
        });
      }
      if (url.includes("/chat") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as { message?: string };
        sentChats.push(body.message ?? "");
        return jsonResponse({
          ok: true,
          messages: [{ who: "me", text: body.message ?? "" }],
          reply: { who: "agent", name: "intake", text: "ok" },
          draft: {
            schema_version: 1,
            id: "d-comp-1",
            title: "新草稿",
            space: "local",
            priority: "P2",
            track: "L2",
            workspace_mode: "scratch_dir",
            depends_on: [],
            contract: {},
            created_at: now,
            updated_at: now,
          },
        });
      }
      return jsonResponse(bootstrap);
    });

    window.location.hash = "#view=intake";
    render(<App />);
    await waitFor(() => {
      expect(document.getElementById("chatIn")).toBeTruthy();
    });

    const inputEl = document.getElementById("chatIn") as HTMLTextAreaElement;
    const setTyped = (text: string) => {
      fireEvent.change(inputEl, {
        target: { value: text, selectionStart: text.length, selectionEnd: text.length },
      });
      inputEl.setSelectionRange(text.length, text.length);
    };

    // Wait for skills + MCP servers to hydrate under antigravity
    setTyped("/");
    const listbox = await screen.findByRole("listbox", { name: "指令与技能补全" });
    await waitFor(() => {
      expect(within(listbox).getByText("/forge-dialogue")).toBeTruthy();
      expect(within(listbox).getByText("项目技能")).toBeTruthy();
    });

    // Escape dismisses popup WITHOUT navigating back to board view
    fireEvent.keyDown(inputEl, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "指令与技能补全" })).toBeNull();
    expect(document.getElementById("chatIn")).toBeTruthy();

    // Filter "/fo" -> Enter completes "/forge-dialogue " without firing POST chat request
    setTyped("/fo");
    const filteredList = await screen.findByRole("listbox", { name: "指令与技能补全" });
    expect(within(filteredList).getByText("/forge-dialogue")).toBeTruthy();
    fireEvent.keyDown(inputEl, { key: "Enter" });
    expect(inputEl.value).toBe("/forge-dialogue ");
    expect(sentChats).toHaveLength(0);

    // Selecting /new executes local draft reset
    setTyped("/ne");
    await screen.findByRole("listbox", { name: "指令与技能补全" });
    fireEvent.keyDown(inputEl, { key: "Enter" });
    await waitFor(() => {
      expect(inputEl.value).toBe("");
    });
    expect(sentChats).toHaveLength(0);

    // Typing @ immediately shows current directory listing + @mcp + @task, and Tab drills into directory without closing
    setTyped("@");
    const mentionBox = await screen.findByRole("listbox", {
      name: "选择文件、MCP、任务或账本",
    });
    await waitFor(() => {
      expect(within(mentionBox).getByText("~/AI/")).toBeTruthy();
      expect(within(mentionBox).getByText("@mcp:context7")).toBeTruthy();
    });
    fireEvent.keyDown(inputEl, { key: "Tab" });
    expect(inputEl.value).toBe("@~/AI/");
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
    await waitFor(() => {
      expect(within(mentionBox).getByText("~/AI/Kiln/README.md")).toBeTruthy();
    });
    fireEvent.keyDown(inputEl, { key: "Enter" });
    expect(inputEl.value).toBe("@~/AI/Kiln/ ");

    // @mcp: mention selection
    setTyped("参考 @mc");
    const mcpBox = await screen.findByRole("listbox", {
      name: "选择文件、MCP、任务或账本",
    });
    expect(within(mcpBox).getByText("@mcp:context7")).toBeTruthy();
    fireEvent.keyDown(inputEl, { key: "Enter" });
    expect(inputEl.value).toBe("参考 @mcp:context7 ");

    // Also verify in-memory @task mentions without debounce wait
    setTyped("参考 @t-");
    const taskBox = await screen.findByRole("listbox", {
      name: "选择文件、MCP、任务或账本",
    });
    expect(within(taskBox).getByText("@task:t-ref-9")).toBeTruthy();
  });

  it("DecisionBox shows clear Chinese action consequence warnings and DetailView exposes resume/complete actions for external tasks", async () => {
    const now = new Date().toISOString();
    const bootstrap = makeBaseBootstrap({
      tasks: [
        {
          id: "t-ext-ui",
          space: "local",
          parent_id: null,
          title: "已停滞的外部等待任务",
          priority: "P2",
          effective_priority: "P2",
          track: "L2",
          workspace_mode: "host_scoped",
          status: "external",
          stage: "implement",
          round: 1,
          active_run_id: null,
          contract_version: 1,
          depends_on: [],
          created_at: now,
          updated_at: now,
          tokens: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          cost_usd: 0,
        },
        {
          id: "t-warn-dec",
          space: "kiln",
          parent_id: null,
          title: "外部警告决策测试",
          priority: "P2",
          effective_priority: "P2",
          track: "L2",
          workspace_mode: "git_worktree",
          status: "waiting",
          stage: "deliver",
          round: 1,
          active_run_id: null,
          contract_version: 1,
          depends_on: [],
          created_at: now,
          updated_at: now,
          tokens: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          cost_usd: 0,
        },
      ],
      pendingDecisions: [
        {
          id: "dec-warn",
          task_id: "t-warn-dec",
          contract_version: 1,
          reason: "external_action_approval",
          category: "external_deliver_pr",
          question: "是否转入外部等待？",
          options: [
            {
              id: "opt-ext",
              label: "已提交 PR 等上游回应",
              action: "return_external",
              recommended: true,
            },
            {
              id: "opt-fin",
              label: "直接完成",
              action: "finish",
              recommended: false,
            },
          ],
          created_at: now,
        },
      ],
    });

    const extDetail: TaskDetailResponse = {
      card: {
        schema_version: 1,
        id: "t-ext-ui",
        title: "已停滞的外部等待任务",
        space: "local",
        priority: "P2",
        track: "L2",
        workspace_mode: "host_scoped",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "清理缓存",
          end: "完成",
          accept_cmd: "echo ok",
          accept_files_hash: "sha256:extui",
          scope: ["~/tmp"],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 250000 },
        created_at: now,
        updated_at: now,
      },
      state: {
        status: "external",
        stage: "implement",
        round: 1,
        activeRunId: null,
        priority: "P2",
        effectivePriority: "P2",
        track: "L2",
        contractVersion: 1,
        updatedAt: now,
      },
      brief: "# 外部等待任务",
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
      stateEvents: [
        { type: "queued", at: now },
        {
          type: "decided",
          at: now,
          decision_id: "dec-old",
          action: "return_external",
        },
      ],
    };

    const calledUrls: string[] = [];
    fetchMock.mockImplementation(async (url) => {
      calledUrls.push(String(url));
      if (url === "/api/bootstrap") return jsonResponse(bootstrap);
      if (url === "/api/tasks/t-ext-ui") return jsonResponse(extDetail);
      if (url === "/api/tasks/t-ext-ui/resume") return jsonResponse({ ok: true });
      if (url === "/api/tasks/t-ext-ui/complete") return jsonResponse({ ok: true });
      return jsonResponse({});
    });

    // 1. Check DecisionBox displays Chinese consequence descriptions & warn styling
    window.location.hash = "#view=inbox";
    const rInbox = render(<App />);
    await waitFor(() => {
      expect(screen.getByText("是否转入外部等待？")).toBeTruthy();
    });
    expect(screen.getByText("return_external")).toBeTruthy();
    expect(screen.getByText("挂起等待外部（不会自动执行）")).toBeTruthy();
    expect(screen.getByText("直接标记完成")).toBeTruthy();
    expect(rInbox.container.querySelector(".opt-act.is-warn")).toBeTruthy();
    expect(rInbox.container.querySelector(".opt-act-desc.is-warn")).toBeTruthy();
    rInbox.unmount();

    // 2. Check DetailView external card and resume/complete buttons
    window.location.hash = "#task=t-ext-ui";
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("外部等待中（当前不会自动继续推进）")).toBeTruthy();
    });

    const resumeButtons = screen.getAllByRole("button", { name: "继续推进" });
    const completeButtons = screen.getAllByRole("button", { name: "标记已完成" });
    expect(resumeButtons.length).toBeGreaterThanOrEqual(2);
    expect(completeButtons.length).toBeGreaterThanOrEqual(2);

    fireEvent.click(resumeButtons[0]!);
    await waitFor(() => {
      expect(calledUrls).toContain("/api/tasks/t-ext-ui/resume");
    });

    fireEvent.click(completeButtons[0]!);
    await waitFor(() => {
      expect(calledUrls).toContain("/api/tasks/t-ext-ui/complete");
    });
  });

  it("supports composable workflow preset selection, step toggles, live preview, and deliver_cmd in IntakeView without introducing <select>", async () => {
    const now = "2026-11-22T04:00:00.000Z";
    const bootstrap = makeBaseBootstrap({
      spaces: {
        local: {
          schema_version: 1,
          id: "local",
          name: "本机与临时",
          default_branch: "main",
          copy_untracked: [],
          clone_deps: [],
          freeze_patterns: [],
        },
        proj: {
          schema_version: 1,
          id: "proj",
          name: "Proj",
          repo_path: "/repos/proj",
          default_branch: "main",
          copy_untracked: [],
          clone_deps: [],
          default_accept_cmd: "pnpm test",
          freeze_patterns: [],
        },
      },
    });

    let commitPayload: Record<string, unknown> | null = null;
    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/bootstrap") return jsonResponse(bootstrap);
      if (url === "/api/drafts" && init?.method === "POST") {
        return jsonResponse(
          {
            ok: true,
            draft: {
              schema_version: 1,
              id: "d-bp-1",
              title: "本机蓝图测试",
              space: "local",
              priority: "P2",
              track: "L1",
              workspace_mode: "host_scoped",
              depends_on: [],
              contract: {},
              created_at: now,
              updated_at: now,
            },
          },
          201,
        );
      }
      if (url === "/api/drafts/d-bp-1/commit" && init?.method === "POST") {
        commitPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ ok: true, card: { id: commitPayload.id }, state: {} }, 201);
      }
      return jsonResponse({});
    });

    window.location.hash = "#view=intake";
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /立项设置/ })).toBeTruthy();
    });

    expect(document.body.querySelectorAll(".converse select")).toHaveLength(0);
    fireEvent.click(screen.getByRole("tab", { name: /立项设置/ }));

    // 1. Pick full_delivery preset -> updates preview & track=L2
    const presetGroup = screen.getByRole("radiogroup", { name: "流程预设" });
    fireEvent.click(within(presetGroup).getByRole("radio", { name: "完整交付" }));
    expect(screen.getByLabelText("流程预览").textContent).toContain("方案(顾问)");
    expect(screen.getByLabelText("流程预览").textContent).toContain("独立验收");

    // 2. Toggle 独立审查 off via composable toggle -> preset becomes custom
    const togglesGroup = screen.getByRole("group", { name: "流程步骤开关" });
    fireEvent.click(within(togglesGroup).getByRole("button", { name: "独立审查" }));
    expect(screen.getByText(/自定义蓝图/)).toBeTruthy();
    expect(document.body.querySelectorAll(".converse select")).toHaveLength(0);

    // 3. Pick host_op preset -> automatically sets host_scoped + L1 + two-phase preview
    fireEvent.click(within(presetGroup).getByRole("radio", { name: "本机操作" }));
    expect(screen.getByLabelText("流程预览").textContent).toContain("验真(仅暂存)");
    expect(screen.getByLabelText("流程预览").textContent).toContain("交付(落盘+终验)");

    // 4. Fill fields + deliver_cmd & commit
    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "清理本机临时缓存" },
    });
    fireEvent.click(screen.getByRole("button", { name: "手动编辑" }));
    fireEvent.change(screen.getByLabelText("交付终点"), {
      target: { value: "清理完毕" },
    });
    fireEvent.change(screen.getByLabelText("验收命令"), {
      target: { value: "test -f ~/cache.flag" },
    });
    fireEvent.change(screen.getByLabelText("可改范围"), {
      target: { value: "~/clean.py" },
    });
    fireEvent.change(screen.getByLabelText("交付命令"), {
      target: { value: "python3 ~/clean.py" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始推进" }));

    await waitFor(() => {
      expect(commitPayload).not.toBeNull();
    });
    expect(commitPayload!.workspace_mode).toBe("host_scoped");
    expect((commitPayload!.workflow as { preset: string }).preset).toBe("host_op");
    expect((commitPayload!.contract as { deliver: unknown }).deliver).toEqual({
      mode: "run_cmd",
      cmd: "python3 ~/clean.py",
    });
  });

  it("keeps hostTwoPhase when toggling L2/steps on host_scoped and strips host_op when switching to a project space", async () => {
    let commitPayload: Record<string, unknown> | null = null;
    const bootstrap = makeBaseBootstrap();

    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/bootstrap") return jsonResponse(bootstrap);
      if (url === "/api/drafts" && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        return jsonResponse(
          {
            ok: true,
            draft: {
              schema_version: 1,
              id: body.id ?? "d-wf-switch",
              title: "",
              space: body.space ?? "local",
              priority: "P2",
              track: "L1",
              workspace_mode: body.workspace_mode ?? "host_scoped",
              depends_on: [],
              contract: {},
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            messages: [],
          },
          201,
        );
      }
      if (typeof url === "string" && url.endsWith("/commit") && init?.method === "POST") {
        commitPayload = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        return jsonResponse(
          { ok: true, card: { id: "t-wf-sw", ...commitPayload }, state: {} },
          201,
        );
      }
      return jsonResponse({});
    });

    window.location.hash = "#view=intake";
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /立项设置/ })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("tab", { name: /立项设置/ }));

    // 1. Switch to 本机操作 (host_scoped + host_op) then switch track to L2 -> MUST retain two-phase markers + review
    const presetGroup = screen.getByRole("radiogroup", { name: "流程预设" });
    fireEvent.click(within(presetGroup).getByRole("radio", { name: "本机操作" }));
    fireEvent.click(screen.getByRole("radio", { name: "L2 标准交付" }));
    const previewL2Host = screen.getByLabelText("流程预览").textContent ?? "";
    expect(previewL2Host).toContain("验真·仅暂存");
    expect(previewL2Host).toContain("交付(落盘+终验)");
    expect(previewL2Host).toContain("审查");

    // Toggle 顾问方案 while still in host_scoped -> must still keep two-phase staging
    const togglesGroup = screen.getByRole("group", { name: "流程步骤开关" });
    fireEvent.click(within(togglesGroup).getByRole("button", { name: "顾问方案" }));
    const previewToggled = screen.getByLabelText("流程预览").textContent ?? "";
    expect(previewToggled).toContain("方案(顾问)");
    expect(previewToggled).toContain("验真·仅暂存");
    expect(previewToggled).toContain("交付(落盘+终验)");

    // 2. Switch back to project mode (git_worktree) even when custom hostTwoPhase is set -> MUST clear host_op markers
    fireEvent.click(screen.getByRole("button", { name: "项目任务" }));
    const previewProj = screen.getByLabelText("流程预览").textContent ?? "";
    expect(previewProj).not.toContain("仅暂存");
    expect(previewProj).not.toContain("落盘+终验");

    // Clicking space chip explicitly preserves clean git_worktree workflow
    fireEvent.click(screen.getByRole("radio", { name: "Kiln 本体" }));
    const previewSpaceChip = screen.getByLabelText("流程预览").textContent ?? "";
    expect(previewSpaceChip).not.toContain("仅暂存");
    expect(previewSpaceChip).not.toContain("落盘+终验");

    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "项目仓库正常任务" },
    });
    fireEvent.click(screen.getByRole("button", { name: "手动编辑" }));
    fireEvent.change(screen.getByLabelText("交付终点"), {
      target: { value: "合入主分支" },
    });
    fireEvent.change(screen.getByLabelText("验收命令"), {
      target: { value: "pnpm test" },
    });
    fireEvent.change(screen.getByLabelText("可改范围"), {
      target: { value: "src/**" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始推进" }));

    await waitFor(() => {
      expect(commitPayload).not.toBeNull();
    });
    expect(commitPayload!.workspace_mode).toBe("git_worktree");
    const wf = commitPayload!.workflow as {
      preset: string;
      steps: Array<{ kind: string; check?: string; apply_staged?: boolean }>;
    };
    expect(wf.preset).not.toBe("host_op");
    expect(wf.steps.some((s) => s.check === "staged_only" || s.apply_staged === true)).toBe(false);
  });

  it("renders 技术实施方案（PLAN.md） in DetailView only when detail.plan is non-empty", async () => {
    const now = "2026-11-22T08:00:00.000Z";
    const card = {
      schema_version: 1 as const,
      id: "t-plan-ui",
      title: "展示技术实施方案",
      space: "kiln",
      priority: "P1" as const,
      track: "L2" as const,
      workspace_mode: "git_worktree" as const,
      parent: null,
      depends_on: [],
      contract_version: 1,
      contract: {
        goal: "在详情页展示 PLAN.md",
        end: "前端可渲染",
        accept_cmd: "pnpm test",
        accept_files_hash: "sha256:planui",
        scope: ["apps/web/**"],
        deliver: { mode: "merge_main" as const, cmd: null },
        human_accept: false,
        external_actions: "ask" as const,
      },
      limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 200000 },
      created_at: now,
      updated_at: now,
    };

    const bootstrap = makeBaseBootstrap({
      tasks: [
        {
          id: "t-plan-ui",
          space: "kiln",
          parent_id: null,
          title: "展示技术实施方案",
          priority: "P1",
          effective_priority: "P1",
          track: "L2",
          workspace_mode: "git_worktree",
          status: "running",
          stage: "implement",
          round: 1,
          active_run_id: null,
          contract_version: 1,
          depends_on: [],
          created_at: now,
          updated_at: now,
          tokens: {
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
          },
          cost_usd: 0,
        },
      ],
    });

    const baseDetail = {
      card,
      state: {
        status: "running" as const,
        stage: "implement" as const,
        round: 1,
        activeRunId: null,
        priority: "P1" as const,
        effectivePriority: "P1" as const,
        track: "L2" as const,
        contractVersion: 1,
        updatedAt: now,
      },
      brief: "# 产品方案",
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
    };

    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/bootstrap") return jsonResponse(bootstrap);
      if (url === "/api/tasks/t-plan-ui") {
        return jsonResponse({
          ...baseDetail,
          plan: "# 技术实施方案\n\n- 选定方案: 单向数据流\n- 验证点: 保持向后兼容",
        });
      }
      return jsonResponse({});
    });

    window.location.hash = "#task=t-plan-ui";
    const firstRender = render(<App />);
    await waitFor(() => {
      expect(screen.getByText("技术实施方案（PLAN.md）")).toBeTruthy();
    });
    expect(screen.getByText(/单向数据流/)).toBeTruthy();
    firstRender.unmount();

    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/bootstrap") return jsonResponse(bootstrap);
      if (url === "/api/tasks/t-plan-ui") {
        return jsonResponse({ ...baseDetail, plan: "   " });
      }
      return jsonResponse({});
    });

    window.location.hash = "#task=t-plan-ui";
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("展示技术实施方案")).toBeTruthy();
    });
    expect(screen.queryByText("技术实施方案（PLAN.md）")).toBeNull();
  });

  it("renders Agent + Session I/O overview cards, keeps raw events collapsed by default, triggers open-tui locally and disables it in remote mode", async () => {
    const now = "2026-11-22T10:00:00.000Z";
    const card: TaskDetailResponse["card"] = {
      schema_version: 1,
      id: "t-s4-ui",
      title: "Agent Session 总览与 TUI",
      space: "kiln",
      priority: "P1",
      track: "L2",
      workspace_mode: "git_worktree",
      parent: null,
      depends_on: [],
      contract_version: 1,
      contract: {
        goal: "核查 Session 总览并跳转原生 TUI",
        end: "验收全过",
        accept_cmd: "pnpm test",
        accept_files_hash: "sha256:s4ui",
        scope: ["apps/**"],
        deliver: { mode: "merge_main", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: {
        retries_per_stage: 2,
        review_rounds: 2,
        advisor_calls: 1,
        max_tokens: 1_000_000,
      },
      created_at: now,
      updated_at: now,
    };

    const bootstrap = makeBaseBootstrap({
      tasks: [
        {
          id: "t-s4-ui",
          space: "kiln",
          parent_id: null,
          title: "Agent Session 总览与 TUI",
          priority: "P1",
          effective_priority: "P1",
          track: "L2",
          workspace_mode: "git_worktree",
          status: "done",
          stage: "accept",
          round: 1,
          active_run_id: null,
          contract_version: 1,
          depends_on: [],
          created_at: now,
          updated_at: now,
          tokens: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 50,
            total_tokens: 150,
          },
          cost_usd: 0.012,
        },
      ],
    });

    const detailBody: TaskDetailResponse = {
      card,
      state: {
        status: "done",
        stage: "accept",
        round: 1,
        activeRunId: null,
        priority: "P1",
        effectivePriority: "P1",
        track: "L2",
        contractVersion: 1,
        updatedAt: now,
      },
      brief: "# 需求方案",
      decisions: "",
      pendingDecision: null,
      ledgerProposals: [],
      runs: [
        {
          dirName: "001-implement",
          meta: {
            schema_version: 1,
            run_id: "r-impl-1",
            task_id: "t-s4-ui",
            stage: "implement",
            round: 1,
            role: "worker",
            agent: "codex",
            model: "gpt-6-luna",
            backend_id: "paseo",
            cwd: "/repos/kiln/.worktrees/t-s4-ui",
            input_ref: "brief:v1",
            session_ref: {
              backendId: "paseo",
              sessionId: "paseo-uuid-1",
              meta: {
                agent: "codex",
                providerSessionId: "0195a3f1-native-sess",
              },
            },
            contract_version: 1,
            started_at: now,
          },
          handoff: "# 交接说明",
          receipt: "## 改动说明\n完成 Session 概览展示。\n",
          gate: null,
          events: [
            {
              kind: "session_bound",
              at: now,
              providerSessionId: "0195a3f1-native-sess",
            },
            {
              kind: "tool",
              at: now,
              name: "shell",
              target: "pnpm test",
            },
          ],
          eventsCount: 2,
          startedAt: now,
          endedAt: "2026-11-22T10:02:00.000Z",
          session: {
            backendId: "paseo",
            sessionId: "paseo-uuid-1",
            providerSessionId: "0195a3f1-native-sess",
            providerSessionPath: null,
            displaySessionId: "0195a3f1-nat",
            cwd: "/repos/kiln/.worktrees/t-s4-ui",
            tuiSupported: true,
            tuiCommandPreview: "codex resume 0195a3f1-native-sess",
            tuiUnavailableReason: null,
          },
          ioSummary: {
            inputTitle: "核查 Session 总览并跳转原生 TUI",
            inputRef: "brief:v1",
            outputVerdict: "通过",
            outputSummary: "完成 Session 概览展示。",
            changedPaths: ["apps/web/src/DetailView.tsx", "packages/kernel/src/tui.ts"],
            gatePassed: true,
            totalTokens: 150,
            costUsd: 0.012,
          },
        },
      ],
      usageTurns: [],
      usage: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 50,
        totalTokens: 150,
        costUsd: 0.012,
        byAgent: {},
        byModel: {},
      },
    };

    const openTuiCalls: string[] = [];
    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/bootstrap") return jsonResponse(bootstrap);
      if (url === "/api/tasks/t-s4-ui") return jsonResponse(detailBody);
      if (url === "/api/tasks/t-s4-ui/runs/001-implement/open-tui" && init?.method === "POST") {
        openTuiCalls.push(url);
        return jsonResponse({
          ok: true,
          taskId: "t-s4-ui",
          runDir: "001-implement",
          agent: "codex",
          providerSessionId: "0195a3f1-native-sess",
          cwd: "/repos/kiln/.worktrees/t-s4-ui",
          cwdFallback: false,
          commandPreview: "codex resume 0195a3f1-native-sess",
        });
      }
      return jsonResponse({});
    });

    window.location.hash = "#task=t-s4-ui";
    const first = render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Agent · Session 执行总览（1）")).toBeTruthy();
    });

    const overviewSection = screen.getByLabelText("Agent Session 总览");
    expect(within(overviewSection).getByText("完成 Session 概览展示。")).toBeTruthy();
    expect(within(overviewSection).getByText("apps/web/src/DetailView.tsx")).toBeTruthy();

    // Raw events collapsed by default
    expect(screen.queryByText(/\[tool\] shell/)).toBeNull();
    const toggleBtn = screen.getByRole("button", { name: /展开原始执行事件/ });
    fireEvent.click(toggleBtn);
    await waitFor(() => {
      expect(screen.getByText(/\[session\] 0195a3f1-native-sess/)).toBeTruthy();
    });

    // Clicking Agent + Session opens native TUI locally
    const tuiBtn = within(overviewSection).getByRole("button", {
      name: /codex.*#0195a3f1-nat/i,
    });
    expect((tuiBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(tuiBtn);
    await waitFor(() => {
      expect(openTuiCalls).toEqual(["/api/tasks/t-s4-ui/runs/001-implement/open-tui"]);
    });

    first.unmount();

    // Remote mode disables native TUI button
    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/auth/status") {
        return jsonResponse({
          ok: true,
          mode: "remote",
          authenticated: true,
          device: {
            id: "dev-test",
            label: "iPhone",
            created_at: now,
            last_used_at: now,
          },
        });
      }
      if (url === "/api/bootstrap") return jsonResponse(bootstrap);
      if (url === "/api/tasks/t-s4-ui") return jsonResponse(detailBody);
      return jsonResponse({});
    });
    window.location.hash = "#task=t-s4-ui";
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("Agent · Session 执行总览（1）")).toBeTruthy();
    });
    const remoteOverview = screen.getByLabelText("Agent Session 总览");
    const remoteTuiBtn = within(remoteOverview).getByRole("button", {
      name: /codex.*#0195a3f1-nat/i,
    });
    expect((remoteTuiBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("strips custom hostTwoPhase workflow flags when switching back to scratch_dir before commit", async () => {
    let commitPayload: Record<string, unknown> | null = null;
    const bootstrap = makeBaseBootstrap();

    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/bootstrap") return jsonResponse(bootstrap);
      if (url === "/api/drafts" && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        return jsonResponse(
          {
            ok: true,
            draft: {
              schema_version: 1,
              id: body.id ?? "d-wf-scratch",
              title: "",
              space: body.space ?? "local",
              priority: "P2",
              track: "L1",
              workspace_mode: body.workspace_mode ?? "host_scoped",
              depends_on: [],
              contract: {},
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            messages: [],
          },
          201,
        );
      }
      if (typeof url === "string" && url.endsWith("/commit") && init?.method === "POST") {
        commitPayload = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        return jsonResponse(
          { ok: true, card: { id: "t-wf-scratch", ...commitPayload }, state: {} },
          201,
        );
      }
      return jsonResponse({});
    });

    window.location.hash = "#view=intake";
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /立项设置/ })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("tab", { name: /立项设置/ }));

    // 1. Choose 本机操作 (host_scoped + host_op), customize via L2 + 顾问方案 (preset becomes "custom" with hostTwoPhase=true)
    const presetGroup = screen.getByRole("radiogroup", { name: "流程预设" });
    fireEvent.click(within(presetGroup).getByRole("radio", { name: "本机操作" }));
    fireEvent.click(screen.getByRole("radio", { name: "L2 标准交付" }));
    const togglesGroup = screen.getByRole("group", { name: "流程步骤开关" });
    fireEvent.click(within(togglesGroup).getByRole("button", { name: "顾问方案" }));
    expect(screen.getByLabelText("流程预览").textContent ?? "").toContain("验真·仅暂存");

    // 2. Switch workspace back to 临时沙盒 (scratch_dir) -> MUST strip two-phase flags while retaining plan & review
    const wsGroup = screen.getByRole("radiogroup", { name: "本机工作区模式" });
    fireEvent.click(within(wsGroup).getByRole("radio", { name: "临时沙盒" }));
    const previewScratch = screen.getByLabelText("流程预览").textContent ?? "";
    expect(previewScratch).not.toContain("仅暂存");
    expect(previewScratch).not.toContain("落盘+终验");
    expect(previewScratch).toContain("方案(顾问)");
    expect(previewScratch).toContain("审查");

    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "定制流程切回沙盒" },
    });
    fireEvent.click(screen.getByRole("button", { name: "手动编辑" }));
    fireEvent.change(screen.getByLabelText("交付终点"), {
      target: { value: "沙盒脚本完成" },
    });
    fireEvent.change(screen.getByLabelText("验收命令"), {
      target: { value: "echo ok" },
    });
    fireEvent.change(screen.getByLabelText("可改范围"), {
      target: { value: "scripts/**" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始推进" }));

    await waitFor(() => {
      expect(commitPayload).not.toBeNull();
    });
    expect(commitPayload!.workspace_mode).toBe("scratch_dir");
    const wf = commitPayload!.workflow as {
      preset: string;
      steps: Array<{
        kind: string;
        stage?: string;
        mode?: string;
        check?: string;
        apply_staged?: boolean;
        final_accept_gate?: boolean;
        steps?: Array<{
          kind: string;
          stage?: string;
          mode?: string;
          check?: string;
          apply_staged?: boolean;
          final_accept_gate?: boolean;
        }>;
      }>;
    };
    expect(wf.preset).toBe("custom");
    const flatSteps = wf.steps.flatMap((s) => (s.kind === "loop" ? (s.steps ?? []) : [s]));
    expect(
      flatSteps.some(
        (s) =>
          s.mode === "dry_run_only" ||
          s.check === "staged_only" ||
          s.apply_staged === true ||
          s.final_accept_gate === true,
      ),
    ).toBe(false);
    expect(flatSteps.some((s) => s.kind === "agent" && s.stage === "plan")).toBe(true);
    expect(flatSteps.some((s) => s.kind === "agent" && s.stage === "review")).toBe(true);
  });
});
