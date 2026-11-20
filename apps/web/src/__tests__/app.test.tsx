// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapResponse, TaskDetailResponse } from "../api/types";
import { App } from "../app";
import { fmtTime } from "../state/format";

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
          tokens: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 200, total_tokens: 1200 },
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
          tokens: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 200, total_tokens: 1200 },
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
          tokens: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 100, total_tokens: 600 },
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

  it("SettingsView allows Codex/Pi/Antigravity on intake/resolver with interactiveChat filtering, warns on non-MCP and full-access, refreshes via /api/agents?refresh=1, and recalculates cost immediately", async () => {
    const bootstrap = makeBaseBootstrap();
    // Make worker and reviewer use the exact same model and colliding fallback
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
    render(<App />);

    // Wait for bootstrap agents to populate the role selectors: intake/resolver allow codex, pi, antigravity
    await waitFor(() => {
      const intakeSelect = screen.getByLabelText("立项对话 Agent") as HTMLSelectElement;
      expect(Array.from(intakeSelect.options).map((o) => o.value)).toEqual([
        "codex",
        "pi",
        "antigravity",
      ]);
    });

    const resolverSelect = screen.getByLabelText("讨论对话 Agent") as HTMLSelectElement;
    const resolverOpts = Array.from(resolverSelect.options).map((o) => o.value);
    expect(resolverOpts).toEqual(["codex", "pi", "antigravity"]);

    // Switching intake to Pi displays non-MCP structured patch notice
    const intakeSelect = screen.getByLabelText("立项对话 Agent") as HTMLSelectElement;
    fireEvent.change(intakeSelect, { target: { value: "pi" } });
    await waitFor(() => {
      expect(
        screen.getByText(/无 MCP 模式：自动通过结构化补丁同步草稿\/契约/),
      ).toBeTruthy();
    });

    // Switching intake to Antigravity triggers full-access-only warning until fallback opt-in is confirmed
    fireEvent.change(intakeSelect, { target: { value: "antigravity" } });
    await waitFor(() => {
      expect(
        screen.getByText(/仅暴露 full-access，默认拦截派发，需先开启右侧「允许全权兜底」/),
      ).toBeTruthy();
    });

    const intakeFallbackToggle = screen.getByLabelText(
      "立项对话 允许全权兜底",
    ) as HTMLInputElement;
    expect(intakeFallbackToggle.checked).toBe(false);
    fireEvent.click(intakeFallbackToggle);
    const intakeConfirmDialog = await screen.findByRole("alertdialog", {
      name: "确认开启全权兜底",
    });
    fireEvent.click(within(intakeConfirmDialog).getByRole("button", { name: "确认开启" }));
    expect(intakeFallbackToggle.checked).toBe(true);

    // Click 重新读取 -> hits /api/agents?refresh=1, keeps interactiveChat=false batch out of intake while adding it to worker
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await waitFor(() => {
      const workerSelect = screen.getByLabelText("实施 Agent") as HTMLSelectElement;
      expect(Array.from(workerSelect.options).map((o) => o.value)).toEqual([
        "codex",
        "pi",
        "antigravity",
        "batch",
      ]);
    });
    expect(Array.from(intakeSelect.options).map((o) => o.value)).toEqual([
      "codex",
      "pi",
      "antigravity",
    ]);

    // Verify backends snapshot updated on 连接与底座 tab
    fireEvent.click(screen.getByRole("tab", { name: "连接与底座" }));
    expect(screen.getByText("4 agent(s) available")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "角色与模型" }));

    // heterogeneous_review collision warning
    expect(
      screen.getByText(/独立审查与实施主模型和备选均撞车/),
    ).toBeTruthy();

    // worker allow_full_access_fallback requires explicit secondary confirmation
    const fallbackToggle = screen.getByLabelText(
      "实施 允许全权兜底",
    ) as HTMLInputElement;
    expect(fallbackToggle.checked).toBe(false);
    fireEvent.click(fallbackToggle);
    const confirmDialog = await screen.findByRole("alertdialog", {
      name: "确认开启全权兜底",
    });
    expect(fallbackToggle.checked).toBe(false);
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "确认开启" }));
    expect(fallbackToggle.checked).toBe(true);

    // Switch to pricing tab and change gpt-5.4 input price from 1.25 -> 10
    // Baseline usage: 1M in, 400k cached, 100k out -> old cost: (600k*1.25 + 400k*0.125 + 100k*10)/1e6 = $1.80
    // New cost with in=10: (600k*10 + 400k*0.125 + 100k*10)/1e6 = 6 + 0.05 + 1 = $7.05
    expect(document.getElementById("upTotalCost")?.textContent).toBe("$1.80");

    fireEvent.click(screen.getByRole("tab", { name: "模型单价" }));
    const inPriceInput = screen.getByLabelText("gpt-5.4 输入单价") as HTMLInputElement;
    fireEvent.input(inPriceInput, { target: { value: "10" } });

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
          options: [
            { id: "opt-a", label: "返回空数组", action: "resume", recommended: true },
          ],
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

    // Default mode is 项目任务 with project space kiln -> workspace locked to git_worktree
    const trackSelect = screen.getByLabelText("轨道") as HTMLSelectElement;
    expect(Array.from(trackSelect.options).map((o) => o.value)).toEqual(["L1", "L2"]);

    const projectWsSelect = screen.getByLabelText("工作区") as HTMLSelectElement;
    expect(Array.from(projectWsSelect.options).map((o) => o.value)).toEqual([
      "git_worktree",
    ]);

    // Switch to 本机 / 临时任务 -> workspace options are only scratch_dir and host_scoped (no L3/external_only)
    fireEvent.click(screen.getByRole("button", { name: "本机 / 临时任务" }));
    const localWsSelect = screen.getByLabelText("工作区") as HTMLSelectElement;
    expect(Array.from(localWsSelect.options).map((o) => o.value)).toEqual([
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

    // Fill local scratch task containing <新任务> placeholder and commit
    fireEvent.input(screen.getByLabelText("标题"), {
      target: { value: "临时沙盒统计脚本" },
    });
    fireEvent.input(screen.getByLabelText("交付终点"), {
      target: { value: "output.md 生成且非空" },
    });
    fireEvent.input(screen.getByLabelText("验收命令"), {
      target: { value: "test -s workspaces/<新任务>/output.md" },
    });
    fireEvent.input(screen.getByLabelText("可改范围"), {
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
    expect(
      second.container.querySelector('[data-up-bar="codex"]')?.className,
    ).toBe("warn");
    expect(
      second.container.querySelector('[data-up-bar="pi"]')?.className,
    ).toBe("bad");
  });

  it("passes static dependency and security scan (no kernel, paseo, node builtins, UI libs, or dangerouslySetInnerHTML)", () => {
    // @ts-expect-error Vite compile-time glob macro (no vite/client ambient types in tsconfig)
    const sources = import.meta.glob("../**/*.{ts,tsx}", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    // @ts-expect-error Vite compile-time glob macro
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
      expect(code, `${filePath} must not import node: builtins`).not.toMatch(
        /from\s+["']node:/,
      );
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
      "preact",
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
          tokens: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 500, total_tokens: 1500 },
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
      expect(
        screen.getByText("回执写入与租约比对必须在同一 SQLite 事务内完成"),
      ).toBeTruthy();
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
    const cancelSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation((id: number) => {
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

    const originalGetContext = HTMLCanvasElement.prototype.getContext;
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
    HTMLCanvasElement.prototype.getContext = (() => mockCtx) as unknown as typeof originalGetContext;

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

      // Wait for Preact's afterPaint useEffect & at least one FlameCanvas frame to execute
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
      stateEvents: opts.includeDoneEvent
        ? [{ type: "done", at: doneAt, deliver_ref: "main" }]
        : [],
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
      "--- a/.zshrc\n+++ b/.zshrc\n@@ -1,1 +1,2 @@\n-<script>window.__xss_diff=1</script>\n+<img src=x onerror=\"window.__xss_diff=2\">";
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

    const preElsResolve = Array.from(
      rResolve.container.querySelectorAll("pre.staged-diff-pre"),
    );
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
    const preElsDetail = Array.from(
      rDetail.container.querySelectorAll("pre.staged-diff-pre"),
    );
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
        return jsonResponse(
          makeBaseBootstrap({ spaces: spacesState, drafts: draftsState }),
        );
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
    fireEvent.input(within(modal).getByLabelText("仓库路径"), {
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
    expect((screen.getByLabelText("目标项目空间") as HTMLSelectElement).value).toBe("alpha");
    expect((screen.getByLabelText("验收命令") as HTMLInputElement).value).toBe("pnpm test");

    // 3. Delete old draft via × button
    fireEvent.click(screen.getByRole("button", { name: "删除草稿 旧草稿" }));
    await waitFor(() => {
      expect(calls.some((c) => c.url === "/api/drafts/d-old" && c.method === "DELETE")).toBe(
        true,
      );
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
    fireEvent.input(document.getElementById("chatIn")!, {
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
    fireEvent.input(document.getElementById("chatIn")!, {
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
      expect(calls.some((c) => c.url === "/api/spaces/alpha" && c.method === "DELETE")).toBe(
        true,
      );
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
      expect((screen.getByLabelText("目标项目空间") as HTMLSelectElement).value).toBe("beta");
    });
    expect((screen.getByLabelText("验收命令") as HTMLInputElement).value).toBe("cargo test");
  });
});
