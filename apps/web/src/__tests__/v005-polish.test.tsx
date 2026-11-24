// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../app";
import type { BootstrapResponse } from "../api/types";

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly url: string;
  private listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  onerror: ((ev: Event) => void) | null = null;
  onopen: ((ev: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (ev: MessageEvent) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(handler);
    this.listeners.set(type, arr);
  }

  removeEventListener(type: string, handler: (ev: MessageEvent) => void): void {
    const arr = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      arr.filter((fn) => fn !== handler),
    );
  }

  close(): void {}
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makePolishBootstrap(): BootstrapResponse {
  const now = new Date().toISOString();
  return {
    version: "0.0.5",
    tasks: [
      {
        id: "t-wait-1",
        space: "kiln",
        parent_id: null,
        title: "待决策任务 A：审批发布边界",
        priority: "P0",
        effective_priority: "P0",
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
        tokens: {
          input_tokens: 1000,
          cached_input_tokens: 0,
          output_tokens: 500,
          total_tokens: 1500,
        },
        cost_usd: 0.01,
        summary: "请确认是否合并发布分支",
      },
      {
        id: "t-wait-2",
        space: "blog",
        parent_id: null,
        title: "待决策任务 B：切换静态托管域名",
        priority: "P1",
        effective_priority: "P1",
        track: "L1",
        workspace_mode: "git_worktree",
        status: "waiting",
        stage: "accept",
        round: 1,
        active_run_id: null,
        contract_version: 1,
        depends_on: [],
        created_at: now,
        updated_at: now,
        tokens: {
          input_tokens: 800,
          cached_input_tokens: 0,
          output_tokens: 300,
          total_tokens: 1100,
        },
        cost_usd: 0.005,
        summary: "选择自定义域名配置策略",
      },
      {
        id: "t-run-1",
        space: "kiln",
        parent_id: null,
        title: "运行中任务：补充视觉对齐单测",
        priority: "P2",
        effective_priority: "P2",
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
          input_tokens: 2000,
          cached_input_tokens: 500,
          output_tokens: 600,
          total_tokens: 3100,
        },
        cost_usd: 0.02,
        agent: "codex",
        model: "gpt-5.4",
      },
    ],
    pendingDecisions: [
      {
        id: "dec-1",
        task_id: "t-wait-1",
        contract_version: 1,
        reason: "approval_required",
        category: "release_publish",
        question: "是否允许合并到 release 分支？",
        options: [{ id: "opt-a", label: "允许合并", action: "resume", recommended: true }],
        created_at: now,
      },
      {
        id: "dec-2",
        task_id: "t-wait-2",
        contract_version: 1,
        reason: "contract_clarification",
        category: "external_domain",
        question: "域名策略选择方案一还是方案二？",
        options: [{ id: "opt-b1", label: "采用方案一", action: "resume", recommended: true }],
        created_at: now,
      },
    ],
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
        default_accept_cmd: "pnpm test",
        freeze_patterns: [],
        pinned: true,
      },
      blog: {
        schema_version: 1,
        id: "blog",
        name: "个人博客",
        repo_path: "/repos/blog",
        default_branch: "main",
        copy_untracked: [],
        clone_deps: [],
        default_accept_cmd: "pnpm test",
        freeze_patterns: [],
      },
    },
    roles: { schema_version: 1, heterogeneous_review: true, roles: {} },
    limits: {
      schema_version: 1,
      max_concurrent_slots: 3,
      p0_extra_slot: true,
      max_waiting_wip: 5,
      retries_per_stage: 2,
      review_rounds: 2,
      advisor_calls: 1,
      max_card_tokens: 500_000,
    },
    pricing: { schema_version: 1, models: {} },
    usage: {
      inputTokens: 3800,
      cachedInputTokens: 500,
      outputTokens: 1400,
      totalTokens: 5700,
      costUsd: 0.035,
      byAgent: {},
      byModel: {},
    },
    ledgers: {
      kiln: {
        schema_version: 1,
        space: "kiln",
        entries: [
          {
            id: "led-1",
            space: "kiln",
            rule: "禁止修改 packages/protocol 已发布字段类型",
            source_task_id: "t-run-1",
            created_at: now,
          },
        ],
      },
    },
    runningCount: 1,
  };
}

describe("@kiln/web Slice 6c visual & interaction polish", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.clear();
    window.location.hash = "";
    window.history.replaceState(null, "", "/");
    document.body.className = "";
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("supports BoardView space scope clear capsule & running ProviderAvatar, InboxView master-detail switching, LedgerView task navigation, and ResolveView non_goals + MiniRail", async () => {
    const now = new Date().toISOString();
    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/bootstrap") return jsonResponse(makePolishBootstrap());
      if (url === "/api/tasks/t-wait-1" || url === "/api/tasks/t-run-1") {
        const id = url === "/api/tasks/t-wait-1" ? "t-wait-1" : "t-run-1";
        return jsonResponse({
          card: {
            schema_version: 1,
            id,
            space: "kiln",
            parent_id: null,
            title:
              id === "t-wait-1" ? "待决策任务 A：审批发布边界" : "运行中任务：补充视觉对齐单测",
            priority: "P0",
            effective_priority: "P0",
            track: "L2",
            workspace_mode: "git_worktree",
            depends_on: [],
            contract_version: 1,
            contract: {
              goal: "完成发布前契约对齐",
              end: "合入 main",
              accept_cmd: "pnpm test",
              accept_files_hash: "h",
              scope: ["apps/web/src/**"],
              non_goals: ["不修改后端调度器", "不引入额外 CSS 框架"],
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
            status: id === "t-wait-1" ? "waiting" : "running",
            stage: id === "t-wait-1" ? "deliver" : "implement",
            round: 1,
            activeRunId: null,
            priority: "P0",
            effectivePriority: "P0",
            track: "L2",
            contractVersion: 1,
            updatedAt: now,
          },
          brief: "# BRIEF",
          decisions: "",
          pendingDecision: id === "t-wait-1" ? makePolishBootstrap().pendingDecisions[0]! : null,
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
        });
      }
      if (typeof url === "string" && url.startsWith("/api/scripts")) {
        return jsonResponse({ ok: true, runs: [] });
      }
      return jsonResponse({});
    });

    const { container } = render(<App />);
    await waitFor(() => {
      expect(screen.getByText("运行中任务：补充视觉对齐单测")).toBeTruthy();
    });

    // Running card renders XS ProviderAvatar badge CX
    expect(container.querySelector(".card-exec .av-xs")?.textContent).toBe("CX");

    // Select sidebar space "个人博客" -> topbar shows removable scope capsule, click clears back to all
    fireEvent.click(screen.getByRole("button", { name: /个人博客/ }));
    const scopeBtn = await screen.findByRole("button", { name: "清除空间筛选" });
    expect(scopeBtn.textContent).toContain("个人博客");
    expect(screen.queryByText("运行中任务：补充视觉对齐单测")).toBeNull();
    fireEvent.click(scopeBtn);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "清除空间筛选" })).toBeNull();
      expect(screen.getByText("运行中任务：补充视觉对齐单测")).toBeTruthy();
    });

    // Navigate to InboxView -> master-detail shows both items, clicking 2nd switches right panel
    fireEvent.click(screen.getAllByRole("button", { name: /等你决定/ })[0]!);
    const inboxList = await screen.findByLabelText("待决定任务列表");
    expect(screen.getByText("是否允许合并到 release 分支？")).toBeTruthy();
    expect(container.querySelector(".decision .ico-chip.ask")).toBeTruthy();

    fireEvent.click(within(inboxList).getByText("待决策任务 B：切换静态托管域名"));
    await waitFor(() => {
      expect(screen.getByText("域名策略选择方案一还是方案二？")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "打开任务" })).toBeTruthy();

    // Switch back to 1st waiting item and open ResolveView -> checks non_goals + MiniRail
    fireEvent.click(within(inboxList).getByText("待决策任务 A：审批发布边界"));
    fireEvent.click(screen.getByRole("button", { name: "开对话讨论" }));
    await waitFor(() => {
      expect(screen.getByText("不修改后端调度器")).toBeTruthy();
      expect(screen.getByText("不引入额外 CSS 框架")).toBeTruthy();
    });
    expect(container.querySelector(".resolve-panel .rail")).toBeTruthy();

    // Navigate to LedgerView -> verifies count + clickable source task button
    fireEvent.click(screen.getByRole("button", { name: /决策账本/ }));
    await waitFor(() => {
      expect(screen.getByText("禁止修改 packages/protocol 已发布字段类型")).toBeTruthy();
    });
    expect(screen.getByText(/1 条长期约束/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /t-run-1/ }));
    await waitFor(() => {
      expect(window.location.hash).toBe("#task=t-run-1");
    });
  });
});
