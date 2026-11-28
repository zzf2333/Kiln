// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapResponse, TaskDetailResponse } from "../api/types";
import { App } from "../app";

type MockFetchHandler = (url: string, init?: RequestInit) => Promise<Response> | Response;

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

function makeRosterBootstrap(overrides: Partial<BootstrapResponse> = {}): BootstrapResponse {
  return {
    version: "0.0.5",
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
        default_accept_cmd: "pnpm test",
        freeze_patterns: [],
        scripts: {
          setup: "pnpm install",
          test: "pnpm test",
          lint: "pnpm typecheck",
        },
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
    roster: {
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
          traits: "摸底并点将",
          mode: "agent",
          primary: { provider: "claude", model: "claude-sonnet-4-6" },
          fallbacks: [],
          allow_full_access_fallback: false,
          builtin: true,
        },
        architect: {
          group: "core",
          enabled: true,
          name: "架构方案",
          stage: "plan",
          secondary_stages: [],
          perm: "read_only",
          traits: "只读输出 PLAN.md",
          mode: "agent",
          primary: { provider: "claude", model: "claude-opus-4-6" },
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
          traits: "核心功能实现",
          mode: "agent",
          primary: { provider: "codex", model: "gpt-5.4" },
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
          traits: "小修低成本直出",
          mode: "agent",
          primary: { provider: "codex", model: "gpt-5.4-mini" },
          fallbacks: [],
          allow_full_access_fallback: false,
          builtin: true,
        },
        ops_sec: {
          group: "specialist",
          enabled: true,
          name: "本机运维安全",
          stage: "implement",
          secondary_stages: [],
          perm: "host_staged",
          traits: "仅写 host_scoped staged/",
          mode: "agent",
          primary: { provider: "pi", model: "claude-sonnet-4-6" },
          fallbacks: [],
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
          traits: "只读独立审查",
          mode: "agent",
          primary: { provider: "gemini", model: "gemini-3-pro" },
          fallbacks: [],
          allow_full_access_fallback: false,
          builtin: true,
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
        "claude-sonnet-4-6": {
          in: 3,
          cached: 0.3,
          cache_write: 3.75,
          out: 15,
        },
      },
    },
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      byAgent: {},
      byModel: {},
    },
    runningCount: 0,
    agents: [],
    backends: [],
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
  (window as unknown as { EventSource?: unknown }).EventSource = MockEventSource;
  fetchMock = vi.fn<MockFetchHandler>(async () => jsonResponse(makeRosterBootstrap()));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("@kiln/web Slice 6b DetailView & IntakeView", () => {
  it("renders DetailView 4-gate header, RESEARCH/PLAN docs, antiDriftSummary, live context_window, attachments lightbox, and two-step checkpoint rollback", async () => {
    const now = "2026-11-23T12:00:00.000Z";
    let taskStatus: "running" | "paused" = "running";
    const rollbackPayloads: Array<Record<string, unknown>> = [];

    const makeDetail = (): TaskDetailResponse => ({
      card: {
        schema_version: 1,
        id: "t-s6b-1",
        title: "反漂移闭环详情页验证",
        space: "kiln",
        priority: "P1",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        workflow: {
          schema_version: 1,
          preset: "standard_dev",
          pm_rationale: "核心模块，指派主力开发并开启异构审查",
          steps: [
            {
              kind: "loop",
              max_rounds: 3,
              stuck_threshold: 2,
              steps: [
                {
                  kind: "agent",
                  stage: "implement",
                  role: "worker",
                  fresh_context: false,
                  roster_role: "main_dev",
                },
                { kind: "gate", stage: "verify", check: "full" },
                {
                  kind: "agent",
                  stage: "review",
                  role: "reviewer",
                  fresh_context: true,
                  roster_role: "reviewer",
                },
              ],
            },
          ],
        },
        attachments: [
          {
            id: "att-1",
            filename: "repro.png",
            mime_type: "image/png",
            size_bytes: 2048,
            sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
            rel_path: "tasks/t-s6b-1/attachments/att-1.png",
            added_at: now,
          },
        ],
        contract_version: 1,
        contract: {
          goal: "确保 DetailView 展示四项门禁与快照",
          end: "合入 main，门禁通过",
          accept_cmd: "pnpm test",
          accept_files_hash: "sha256:frozen123",
          scope: ["apps/web/src/**"],
          non_goals: ["不修改内核协议"],
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
        status: taskStatus,
        stage: "review",
        round: 1,
        activeRunId: taskStatus === "running" ? "run-rev-1" : null,
        priority: "P1",
        effectivePriority: "P1",
        track: "L2",
        contractVersion: 1,
        updatedAt: now,
      },
      brief: "# BRIEF\n\n目标：验证防跑偏",
      research: "# 调研结论\n\n- 已定位旧视图缺少快照回滚入口",
      plan: "# 技术方案\n\n- 使用 Radix Popover 做二次确认回滚",
      attachments: [
        {
          id: "att-1",
          filename: "repro.png",
          mime_type: "image/png",
          size_bytes: 2048,
          sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          rel_path: "tasks/t-s6b-1/attachments/att-1.png",
          added_at: now,
        },
      ],
      checkpoints: [
        {
          schema_version: 1,
          run_id: "run-impl-1",
          task_id: "t-s6b-1",
          stage: "implement",
          round: 1,
          ref: "refs/kiln/checkpoints/t-s6b-1/r1-impl",
          commit_sha: "1234567890abcdef",
          created_at: now,
        },
      ],
      decisions: "",
      pendingDecision: null,
      ledgerProposals: [],
      runs: [
        {
          dirName: "001-implement",
          meta: {
            schema_version: 1,
            run_id: "run-impl-1",
            task_id: "t-s6b-1",
            stage: "implement",
            round: 1,
            role: "worker",
            roster_role: "main_dev",
            contract_version: 1,
            backend_id: "acp",
            agent: "codex",
            model: "gpt-5.4",
            checkpoint_ref: "refs/kiln/checkpoints/t-s6b-1/r1-impl",
            session_ref: { backendId: "acp", sessionId: "s-impl" },
            started_at: now,
          },
          handoff: null,
          receipt: "## 改动说明\n完成前端视图",
          gate: {
            schema_version: 1,
            run_id: "run-impl-1",
            contract_version: 1,
            schema_ok: true,
            scope_ok: true,
            artifacts_ok: true,
            out_of_scope_paths: [],
            frozen_files_changed: [],
            accept_exit_code: 0,
            accept_duration_ms: 420,
            escalated_to_l2: false,
            checked_at: now,
          },
          events: [
            {
              kind: "context_window",
              at: now,
              usedTokens: 30_000,
              contextWindowTokens: 200_000,
              percent: 15,
            },
          ],
          eventsCount: 1,
          antiDriftSummary: {
            input: "[implement] 确保 DetailView 展示四项门禁与快照",
            alignment_points: ["严格限定修改 apps/web/src/**", "非目标护栏: 不修改内核协议"],
            output: "通过 · 完成前端视图",
            gate_proof: {
              schema_ok: true,
              scope_ok: true,
              frozen_ok: true,
              accept_ok: true,
            },
          },
        },
        {
          dirName: "002-review",
          meta: {
            schema_version: 1,
            run_id: "run-rev-1",
            task_id: "t-s6b-1",
            stage: "review",
            round: 1,
            role: "reviewer",
            roster_role: "reviewer",
            contract_version: 1,
            backend_id: "acp",
            agent: "gemini",
            model: "gemini-3-pro",
            session_ref: { backendId: "acp", sessionId: "s-rev" },
            started_at: now,
          },
          handoff: null,
          receipt: null,
          gate: null,
          events: [],
          eventsCount: 0,
        },
      ],
      usageTurns: [],
      usage: {
        inputTokens: 1_200_000,
        cachedInputTokens: 1_000_000,
        cacheWriteTokens: 100_000,
        outputTokens: 50_000,
        totalTokens: 1_350_000,
        costUsd: 1.5,
        byAgent: {},
        byModel: {
          "claude-sonnet-4-6": {
            inputTokens: 1_200_000,
            cachedInputTokens: 1_000_000,
            cacheWriteTokens: 100_000,
            outputTokens: 50_000,
            totalTokens: 1_350_000,
            costUsd: 1.5,
          },
        },
      },
    });

    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/bootstrap") {
        return jsonResponse(
          makeRosterBootstrap({
            tasks: [
              {
                id: "t-s6b-1",
                space: "kiln",
                parent_id: null,
                title: "反漂移闭环详情页验证",
                priority: "P1",
                effective_priority: "P1",
                track: "L2",
                workspace_mode: "git_worktree",
                status: taskStatus,
                stage: "review",
                round: 1,
                active_run_id: taskStatus === "running" ? "run-rev-1" : null,
                contract_version: 1,
                depends_on: [],
                created_at: now,
                updated_at: now,
                tokens: {
                  input_tokens: 1_200_000,
                  cached_input_tokens: 1_000_000,
                  output_tokens: 50_000,
                  total_tokens: 1_350_000,
                },
                cost_usd: 1.5,
              },
            ],
          }),
        );
      }
      if (url === "/api/tasks/t-s6b-1") {
        return jsonResponse(makeDetail());
      }
      if (url === "/api/tasks/t-s6b-1/checkpoints") {
        return jsonResponse({
          ok: true,
          taskId: "t-s6b-1",
          checkpoints: makeDetail().checkpoints,
        });
      }
      if (url === "/api/tasks/t-s6b-1/checkpoints/rollback" && init?.method === "POST") {
        rollbackPayloads.push(JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>);
        return jsonResponse({
          ok: true,
          taskId: "t-s6b-1",
          checkpoint_ref: "refs/kiln/checkpoints/t-s6b-1/r1-impl",
          commit_sha: "1234567890abcdef",
        });
      }
      if (typeof url === "string" && (url === "/api/scripts" || url.startsWith("/api/scripts?"))) {
        return jsonResponse({ ok: true, runs: [] });
      }
      return jsonResponse({});
    });

    window.location.hash = "#task=t-s6b-1";
    const { container } = render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText("防跑偏门禁状态")).toBeTruthy();
    });

    // 4-gate header
    const alignPanel = screen.getByLabelText("防跑偏门禁状态");
    expect(within(alignPanel).getByText("0 越界")).toBeTruthy();
    expect(within(alignPanel).getByText("SHA256 一致")).toBeTruthy();
    expect(within(alignPanel).getByText("codex ≠ gemini")).toBeTruthy();
    expect(within(alignPanel).getByText("exit 0")).toBeTruthy();

    // Open BRIEF.md modal and Escape must NOT exit detail view
    fireEvent.click(within(alignPanel).getByRole("button", { name: /BRIEF\.md/ }));
    await waitFor(() => {
      expect(screen.getByText("立项方案原文（BRIEF.md）")).toBeTruthy();
    });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByText("立项方案原文（BRIEF.md）")).toBeNull();
    });
    expect(screen.getByLabelText("防跑偏门禁状态")).toBeTruthy();

    // RESEARCH.md + PLAN.md + non_goals + pm_rationale
    expect(screen.getByText("技术调研报告（RESEARCH.md）")).toBeTruthy();
    expect(screen.getByText("技术实施方案（PLAN.md）")).toBeTruthy();
    expect(screen.getByText("不修改内核协议")).toBeTruthy();
    expect(within(alignPanel).getByText("核心模块，指派主力开发并开启异构审查")).toBeTruthy();
    expect(
      screen.getAllByText("核心模块，指派主力开发并开启异构审查").length,
    ).toBeGreaterThanOrEqual(2);

    // Per-run antiDriftSummary & roster_role
    const overview = screen.getByLabelText("Agent Session 总览");
    expect(within(overview).getByText("主力开发")).toBeTruthy();
    expect(within(overview).getByText("严格限定修改 apps/web/src/**")).toBeTruthy();
    expect(within(overview).getByText("快照:r1-impl")).toBeTruthy();

    // Context window initial + live SSE update + net savings ($2.625 -> $2.63)
    const ctxMeter = screen.getByLabelText("上下文窗口水位");
    expect(within(ctxMeter).getByText("30.0k / 200.0k（15%）")).toBeTruthy();
    expect(within(ctxMeter).getByText(/净省 \$2\.63/)).toBeTruthy();

    MockEventSource.instances[0]!.emit("run.event", {
      seq: 10,
      type: "run.event",
      taskId: "t-s6b-1",
      runId: "run-rev-1",
      event: {
        kind: "context_window",
        at: now,
        usedTokens: 160_000,
        contextWindowTokens: 200_000,
        percent: 80,
      },
    });
    await waitFor(() => {
      expect(within(ctxMeter).getByText("160.0k / 200.0k（80%）")).toBeTruthy();
    });

    // Attachment thumbnail & lightbox
    const attSection = screen.getByLabelText("任务附件截图");
    fireEvent.click(within(attSection).getByRole("button", { name: /repro\.png/ }));
    await waitFor(() => {
      expect(screen.getByText(/sha256: abcdef012345/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "关闭图片预览" }));

    // Snapshot Popover disabled while running
    fireEvent.click(screen.getByRole("button", { name: /^快照/ }));
    await waitFor(() => {
      expect(screen.getByText("任务运行中，请先暂停再回滚快照")).toBeTruthy();
    });
    const disabledRollbackBtn = screen.getByRole("button", {
      name: "回滚到此快照",
    }) as HTMLButtonElement;
    expect(disabledRollbackBtn.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^快照/ }));

    // Pause task via state update & perform two-step confirmed rollback
    taskStatus = "paused";
    MockEventSource.instances[0]!.emit("task.updated", {
      seq: 11,
      type: "task.updated",
      taskId: "t-s6b-1",
      patch: { status: "paused" },
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "继续推进" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /^快照/ }));
    await waitFor(() => {
      const btn = screen.getByRole("button", {
        name: "回滚到此快照",
      }) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "回滚到此快照" }));
    expect(rollbackPayloads).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "确认回滚" }));
    await waitFor(() => {
      expect(rollbackPayloads).toEqual([
        {
          checkpoint_ref: "refs/kiln/checkpoints/t-s6b-1/r1-impl",
          confirm: true,
        },
      ]);
    });

    // Guardrail: zero <input> inside .reader
    expect(container.querySelectorAll(".reader input")).toHaveLength(0);
  });

  it("supports ScriptDrawer (J shortcut, SSE script.output, stop) and 3-step DeliverPrModal without <input> inside .reader", async () => {
    const now = "2026-11-23T12:10:00.000Z";
    const gitActions: Array<Record<string, unknown>> = [];
    const stoppedIds: string[] = [];

    const detail: TaskDetailResponse = {
      card: {
        schema_version: 1,
        id: "t-s6b-2",
        title: "脚本抽屉与三步开 PR 验证",
        space: "kiln",
        priority: "P2",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "跑通 ScriptDrawer 与 DeliverPrModal",
          end: "打开 PR",
          accept_cmd: "pnpm test",
          accept_files_hash: "sha256:abc",
          scope: ["apps/**"],
          deliver: { mode: "open_pr", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: {
          retries_per_stage: 2,
          review_rounds: 2,
          advisor_calls: 1,
          max_tokens: 200_000,
        },
        created_at: now,
        updated_at: now,
      },
      state: {
        status: "paused",
        stage: "deliver",
        round: 1,
        activeRunId: null,
        priority: "P2",
        effectivePriority: "P2",
        track: "L2",
        contractVersion: 1,
        updatedAt: now,
      },
      brief: "# BRIEF",
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

    let scriptSeq = 0;
    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/bootstrap") {
        return jsonResponse(
          makeRosterBootstrap({
            tasks: [
              {
                id: "t-s6b-2",
                space: "kiln",
                parent_id: null,
                title: "脚本抽屉与三步开 PR 验证",
                priority: "P2",
                effective_priority: "P2",
                track: "L2",
                workspace_mode: "git_worktree",
                status: "paused",
                stage: "deliver",
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
          }),
        );
      }
      if (url === "/api/tasks/t-s6b-2") return jsonResponse(detail);
      if (typeof url === "string" && (url === "/api/scripts" || url.startsWith("/api/scripts?"))) {
        return jsonResponse({ ok: true, runs: [] });
      }
      if (url === "/api/spaces/kiln/scripts/run" && init?.method === "POST") {
        scriptSeq += 1;
        const reqBody = JSON.parse(String(init.body ?? "{}")) as { script?: string };
        const scriptName = reqBody.script || "test";
        return jsonResponse(
          {
            ok: true,
            scriptRunId: `scr-${scriptSeq}`,
            spaceId: "kiln",
            script: scriptName,
            command: scriptName === "test" ? "pnpm test" : `pnpm ${scriptName}`,
            cwd: "/repos/kiln",
          },
          202,
        );
      }
      if (
        typeof url === "string" &&
        url.startsWith("/api/scripts/") &&
        url.endsWith("/stop") &&
        init?.method === "POST"
      ) {
        const id = url.split("/")[3]!;
        stoppedIds.push(id);
        return jsonResponse({ ok: true, scriptRunId: id, stopped: true });
      }
      if (url === "/api/tasks/t-s6b-2/deliver/pr-draft") {
        return jsonResponse({
          ok: true,
          draft: {
            taskId: "t-s6b-2",
            branch: "kiln/t-s6b-2",
            baseBranch: "main",
            title: "[t-s6b-2] 脚本抽屉与三步开 PR 验证",
            body: "## 门禁证据\n- exit 0",
          },
        });
      }
      if (url === "/api/tasks/t-s6b-2/deliver/git" && init?.method === "POST") {
        const payload = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        gitActions.push(payload);
        if (payload.action === "commit") {
          return jsonResponse({
            ok: true,
            action: "commit",
            alreadyClean: false,
            branch: "kiln/t-s6b-2",
            commitSha: "aaa111222333",
          });
        }
        if (payload.action === "push") {
          return jsonResponse({
            ok: true,
            action: "push",
            alreadyUpToDate: false,
            branch: "kiln/t-s6b-2",
            commitSha: "aaa111222333",
          });
        }
        return jsonResponse({
          ok: true,
          action: "open_pr",
          alreadyExists: false,
          prUrl: "https://github.com/org/repo/pull/42",
          prNumber: 42,
          prTitle: String(payload.pr_title ?? ""),
          branch: "kiln/t-s6b-2",
          baseBranch: "main",
        });
      }
      return jsonResponse({});
    });

    window.location.hash = "#task=t-s6b-2";
    const { container } = render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /提交 \/ PR/ })).toBeTruthy();
    });

    // J shortcut opens ScriptDrawer
    fireEvent.keyDown(document.body, { key: "j" });
    await waitFor(() => {
      expect(screen.getByLabelText("项目脚本输出")).toBeTruthy();
    });
    expect(container.querySelectorAll(".reader input")).toHaveLength(0);

    // Start script & stream SSE chunk
    const drawer = screen.getByLabelText("项目脚本输出");
    fireEvent.click(within(drawer).getByRole("button", { name: "运行" }));
    await waitFor(() => {
      expect(within(drawer).getByRole("button", { name: "停止" })).toBeTruthy();
    });
    MockEventSource.instances[0]!.emit("script.output", {
      seq: 20,
      type: "script.output",
      spaceId: "kiln",
      taskId: "t-s6b-2",
      scriptRunId: "scr-1",
      scriptKey: "test",
      stream: "stdout",
      chunk: "PASS test-a\n",
      at: now,
    });
    await waitFor(() => {
      expect(within(drawer).getByText(/PASS test-a/)).toBeTruthy();
    });

    // Stop running script
    fireEvent.click(within(drawer).getByRole("button", { name: "停止" }));
    await waitFor(() => {
      expect(stoppedIds).toEqual(["scr-1"]);
    });

    // DeliverPrModal 3-step explicit human actions
    fireEvent.click(screen.getByRole("button", { name: /提交 \/ PR/ }));
    await waitFor(() => {
      expect(screen.getByText("Commit → Push → Open PR")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "确认 Commit" }));
    await waitFor(() => {
      expect(screen.getByText(/已提交 aaa1112 到 kiln\/t-s6b-2/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "确认 Push" }));
    await waitFor(() => {
      expect(screen.getByText(/已推送 aaa1112 至 origin\/kiln\/t-s6b-2/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "确认 Open PR" }));
    await waitFor(() => {
      const link = screen.getByRole("link", {
        name: "https://github.com/org/repo/pull/42",
      }) as HTMLAnchorElement;
      expect(link.target).toBe("_blank");
      expect(link.rel).toContain("noopener");
    });

    expect(gitActions.map((a) => [a.action, a.confirm])).toEqual([
      ["commit", true],
      ["push", true],
      ["open_pr", true],
    ]);
    expect(container.querySelectorAll(".reader input")).toHaveLength(0);
  });

  it("supports IntakeView zero-<select>, image attachment upload/validation/preview/delete, non_goals, and RosterRolePicker safety filtering", async () => {
    const now = "2026-11-23T12:20:00.000Z";
    const uploadedAttachments: Array<Record<string, unknown>> = [];
    const deletedAttachmentIds: string[] = [];
    let commitPayload: Record<string, unknown> | null = null;

    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/bootstrap") {
        return jsonResponse(makeRosterBootstrap());
      }
      if (url === "/api/drafts" && init?.method === "POST") {
        return jsonResponse(
          {
            ok: true,
            draft: {
              schema_version: 1,
              id: "d-mm-1",
              title: "",
              space: "kiln",
              priority: "P2",
              track: "L2",
              workspace_mode: "git_worktree",
              depends_on: [],
              contract: {},
              created_at: now,
              updated_at: now,
            },
          },
          201,
        );
      }
      if (url === "/api/drafts/d-mm-1/attachments" && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        uploadedAttachments.push(body);
        const att = {
          id: "att-u1",
          filename: String(body.filename ?? "shot.png"),
          mime_type: "image/png",
          size_bytes: 16,
          sha256: "0".repeat(64),
          rel_path: "drafts/d-mm-1/attachments/att-u1.png",
          added_at: now,
        };
        return jsonResponse(
          {
            ok: true,
            attachment: att,
            draft: {
              schema_version: 1,
              id: "d-mm-1",
              title: "",
              space: "kiln",
              priority: "P2",
              track: "L2",
              workspace_mode: "git_worktree",
              depends_on: [],
              attachments: [att],
              contract: {},
              created_at: now,
              updated_at: now,
            },
          },
          201,
        );
      }
      if (url === "/api/drafts/d-mm-1/attachments/att-u1" && init?.method === "DELETE") {
        deletedAttachmentIds.push("att-u1");
        return jsonResponse({
          ok: true,
          deleted: true,
          draft: {
            schema_version: 1,
            id: "d-mm-1",
            title: "",
            space: "kiln",
            priority: "P2",
            track: "L2",
            workspace_mode: "git_worktree",
            depends_on: [],
            attachments: [],
            contract: {},
            created_at: now,
            updated_at: now,
          },
        });
      }
      if (url === "/api/drafts/d-mm-1/commit" && init?.method === "POST") {
        commitPayload = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        return jsonResponse({ ok: true, card: { id: "t-101", ...commitPayload }, state: {} }, 201);
      }
      return jsonResponse({});
    });

    window.location.hash = "#view=intake";
    const { container } = render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /立项设置/ })).toBeTruthy();
    });
    expect(container.querySelectorAll("select")).toHaveLength(0);

    // Invalid file type rejected client-side without calling API
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    const badFile = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(fileInput, { target: { files: [badFile] } });
    await waitFor(() => {
      expect(screen.getByText(/仅支持 PNG \/ JPEG \/ WebP \/ GIF/)).toBeTruthy();
    });
    expect(uploadedAttachments).toHaveLength(0);

    // Valid PNG upload via file input
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const pngFile = new File([pngBytes], "ui-bug.png", { type: "image/png" });
    fireEvent.change(fileInput, { target: { files: [pngFile] } });

    await waitFor(() => {
      expect(uploadedAttachments).toHaveLength(1);
    });
    expect(screen.getByLabelText("已附图片")).toBeTruthy();
    expect(screen.getByText("ui-bug.png")).toBeTruthy();

    // Preview lightbox & delete attachment
    fireEvent.click(screen.getByTitle("预览 ui-bug.png"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "关闭图片预览" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "关闭图片预览" }));

    fireEvent.click(screen.getByRole("button", { name: "删除附件 ui-bug.png" }));
    await waitFor(() => {
      expect(deletedAttachmentIds).toEqual(["att-u1"]);
    });

    // Switch to 立项设置 & check PM 排兵点将 safety filtering
    fireEvent.click(screen.getByRole("tab", { name: /立项设置/ }));
    expect(document.body.querySelectorAll("select")).toHaveLength(0);

    // Implement stage picker MUST exclude read_only (异构审查, 架构方案) & host_staged (本机运维安全)
    fireEvent.click(screen.getByRole("button", { name: "选择 implement 阶段执行角色" }));
    const implList = screen.getByRole("listbox", { name: "安全过滤后的角色" });
    expect(within(implList).queryByText("异构审查")).toBeNull();
    expect(within(implList).queryByText("本机运维安全")).toBeNull();
    expect(within(implList).getByText("主力开发")).toBeTruthy();
    fireEvent.click(within(implList).getByText("快修开发"));

    // Review stage picker MUST exclude workspace_write (主力开发, 快修开发)
    fireEvent.click(screen.getByRole("button", { name: "选择 review 阶段执行角色" }));
    const revList = screen.getByRole("listbox", { name: "安全过滤后的角色" });
    expect(within(revList).queryByText("主力开发")).toBeNull();
    expect(within(revList).getByText("异构审查")).toBeTruthy();
    fireEvent.click(within(revList).getByText("异构审查"));

    // non_goals editor
    fireEvent.change(screen.getByLabelText("新增明确不做项"), {
      target: { value: "不引入外部 UI 库" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加排除项" }));
    fireEvent.change(screen.getByLabelText("新增明确不做项"), {
      target: { value: "不改后端" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加排除项" }));
    fireEvent.click(screen.getByRole("button", { name: "移除排除项 不改后端" }));

    // Fill contract & commit -> verify roster_role + non_goals preserved
    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "立项点将与非目标透传" },
    });
    fireEvent.click(screen.getByRole("button", { name: "手动编辑" }));
    fireEvent.change(screen.getByLabelText("交付终点"), {
      target: { value: "合入主分支" },
    });
    fireEvent.change(screen.getByLabelText("验收命令"), {
      target: { value: "pnpm test" },
    });
    fireEvent.change(screen.getByLabelText("可改范围"), {
      target: { value: "apps/web/src/**" },
    });
    expect(document.body.querySelectorAll("select")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "＋ 创建新任务" }));

    await waitFor(() => {
      expect(commitPayload).not.toBeNull();
    });
    const wfSteps = (
      commitPayload!.workflow as {
        steps: Array<{
          kind: string;
          stage?: string;
          roster_role?: string;
          steps?: Array<{ kind: string; stage?: string; roster_role?: string }>;
        }>;
      }
    ).steps.flatMap((s) => (s.kind === "loop" ? (s.steps ?? []) : [s]));
    expect(wfSteps.find((s) => s.kind === "agent" && s.stage === "implement")?.roster_role).toBe(
      "fast_fix",
    );
    expect((commitPayload!.contract as { non_goals?: string[] }).non_goals).toEqual([
      "不引入外部 UI 库",
    ]);
  });

  it("validates Split-Cards DAG cycles and submits atomic batch via commit-split", async () => {
    const now = "2026-11-23T12:30:00.000Z";
    let splitCommitBody: Record<string, unknown> | null = null;

    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/bootstrap") {
        return jsonResponse(makeRosterBootstrap());
      }
      if (url === "/api/drafts" && init?.method === "POST") {
        return jsonResponse(
          {
            ok: true,
            draft: {
              schema_version: 1,
              id: "d-split-1",
              title: "拆卡测试",
              space: "kiln",
              priority: "P2",
              track: "L2",
              workspace_mode: "git_worktree",
              depends_on: [],
              contract: {},
              created_at: now,
              updated_at: now,
            },
          },
          201,
        );
      }
      if (url === "/api/drafts/d-split-1/commit-split" && init?.method === "POST") {
        splitCommitBody = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        return jsonResponse(
          {
            ok: true,
            mode: "commit_split_cards",
            tempIdToTaskId: { s1: "t-201", s2: "t-202" },
            cards: [{ id: "t-201" }, { id: "t-202" }],
            states: [],
          },
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
    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "拆卡闭环需求" },
    });

    fireEvent.click(screen.getByRole("button", { name: /拆分为多卡 DAG/ }));
    const dagPanel = screen.getByLabelText("多卡拆片 DAG 预览");
    expect(document.body.querySelectorAll("select")).toHaveLength(0);
    expect(within(dagPanel).getByLabelText("拓扑执行顺序")).toBeTruthy();

    // Introduce cycle: s1 depends on s2 while s2 already depends on s1
    const s1Deps = within(dagPanel).getByRole("group", { name: "切片 s1 前置依赖" });
    fireEvent.click(within(s1Deps).getByRole("button", { name: "s2" }));

    expect(within(dagPanel).getByText(/DAG 依赖校验失败/)).toBeTruthy();
    const batchBtn = within(dagPanel).getByRole("button", {
      name: "批量立项（2 张卡）",
    }) as HTMLButtonElement;
    expect(batchBtn.disabled).toBe(true);

    // Break cycle
    fireEvent.click(within(s1Deps).getByRole("button", { name: "s2" }));
    expect(batchBtn.disabled).toBe(false);

    fireEvent.click(batchBtn);
    await waitFor(() => {
      expect(splitCommitBody).not.toBeNull();
    });
    const sentCards = splitCommitBody!.cards as Array<{
      temp_id: string;
      depends_on_temp_ids: string[];
    }>;
    expect(sentCards).toHaveLength(2);
    expect(sentCards[1]!.depends_on_temp_ids).toEqual(["s1"]);
  });

  it("normalizes partial kiln-split-cards from PM reply, preserves partial attachment upload success, blocks oversized files, hides blank PLAN.md, and guards DeliverPrModal", async () => {
    const now = new Date().toISOString();
    let guardStatus: "running" | "paused" = "running";
    let splitBody: Record<string, unknown> | null = null;
    let uploadSeq = 0;

    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/bootstrap") {
        return jsonResponse(
          makeRosterBootstrap({
            tasks: [
              {
                id: "t-s6b-guard",
                space: "kiln",
                parent_id: null,
                title: "安全与空白边界验证",
                priority: "P2",
                effective_priority: "P2",
                track: "L2",
                workspace_mode: "git_worktree",
                status: guardStatus,
                stage: "deliver",
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
          }),
        );
      }
      if (url === "/api/tasks/t-s6b-guard") {
        return jsonResponse({
          card: {
            schema_version: 1,
            id: "t-s6b-guard",
            space: "kiln",
            parent_id: null,
            title: "安全与空白边界验证",
            priority: "P2",
            effective_priority: "P2",
            track: "L2",
            workspace_mode: "git_worktree",
            status: guardStatus,
            stage: "deliver",
            round: 1,
            active_run_id: null,
            contract_version: 1,
            contract: {
              goal: "验证空白 PLAN 不渲染及 running/XSS 防护",
              end: "合入 main",
              accept_cmd: "pnpm test",
              accept_files_hash: "h",
              scope: ["apps/web/src/**"],
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
            depends_on: [],
            created_at: now,
            updated_at: now,
          },
          state: {
            status: guardStatus,
            stage: "deliver",
            round: 1,
            activeRunId: null,
            priority: "P2",
            effectivePriority: "P2",
            track: "L2",
            contractVersion: 1,
            updatedAt: now,
          },
          brief: "# BRIEF",
          plan: "   \n  ",
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
        });
      }
      if (url === "/api/tasks/t-s6b-guard/deliver/pr-draft") {
        return jsonResponse({
          ok: true,
          draft: {
            taskId: "t-s6b-guard",
            branch: "kiln/t-s6b-guard",
            baseBranch: "main",
            title: "[t-s6b-guard] test",
            body: "body",
          },
        });
      }
      if (url === "/api/drafts" && init?.method === "POST") {
        return jsonResponse({
          ok: true,
          draft: {
            schema_version: 1,
            id: "d-partial-1",
            space: "kiln",
            priority: "P2",
            track: "L2",
            workspace_mode: "git_worktree",
            depends_on: [],
            attachments: [],
            created_at: now,
            updated_at: now,
          },
        });
      }
      if (url === "/api/drafts/d-partial-1/attachments" && init?.method === "POST") {
        uploadSeq += 1;
        if (uploadSeq === 2) {
          return jsonResponse({ error: "invalid_image_magic_bytes" }, 400);
        }
        return jsonResponse(
          {
            ok: true,
            attachment: {
              id: "att-keep",
              filename: "keep.png",
              mime_type: "image/png",
              size_bytes: 12,
              sha256: "keep123",
              rel_path: "drafts/d-partial-1/attachments/att-keep.png",
              added_at: now,
            },
            draft: {
              schema_version: 1,
              id: "d-partial-1",
              space: "kiln",
              priority: "P2",
              track: "L2",
              workspace_mode: "git_worktree",
              depends_on: [],
              attachments: [
                {
                  id: "att-keep",
                  filename: "keep.png",
                  mime_type: "image/png",
                  size_bytes: 12,
                  sha256: "keep123",
                  rel_path: "drafts/d-partial-1/attachments/att-keep.png",
                  added_at: now,
                },
              ],
              created_at: now,
              updated_at: now,
            },
          },
          201,
        );
      }
      if (url === "/api/drafts/d-partial-1/chat" && init?.method === "POST") {
        return jsonResponse({
          ok: true,
          reply: {
            text:
              "已为您拆分两张卡：\n```kiln-split-cards\n" +
              JSON.stringify([
                {
                  temp_id: "a1",
                  title: "契约卡片",
                  workflow: { schema_version: 1, preset: "custom", steps: [] },
                },
                {
                  temp_id: "a2",
                  title: "实现卡片",
                  depends_on_temp_ids: ["a1"],
                  contract: { end: "接口联调完成" },
                },
              ]) +
              "\n```",
          },
          messages: [
            { role: "user", text: "拆一下", at: now },
            { role: "agent", text: "ok", at: now },
          ],
          draft: {
            schema_version: 1,
            id: "d-partial-1",
            title: "PM 拆卡需求",
            space: "kiln",
            priority: "P2",
            track: "L2",
            workspace_mode: "git_worktree",
            depends_on: [],
            contract: {
              goal: "PM 拆卡需求",
              end: "全部合并",
              accept_cmd: "pnpm test",
              scope: ["apps/web/src/**"],
            },
            created_at: now,
            updated_at: now,
          },
        });
      }
      if (url === "/api/tasks/t-s6b-guard/deliver/git" && init?.method === "POST") {
        return jsonResponse({
          ok: true,
          action: "open_pr",
          alreadyExists: false,
          prUrl: "javascript:alert(1)",
          prNumber: 99,
          prTitle: "test",
          branch: "kiln/t-s6b-guard",
          baseBranch: "main",
        });
      }
      if (url === "/api/drafts/d-partial-1/commit-split" && init?.method === "POST") {
        splitBody = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        return jsonResponse({ ok: true, cards: [{ id: "t-a1" }, { id: "t-a2" }], states: [] }, 201);
      }
      return jsonResponse({});
    });

    // 1. DetailView: whitespace-only plan must NOT render PLAN.md, and running task disables DeliverPrModal
    window.location.hash = "#task=t-s6b-guard";
    const { container } = render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /提交 \/ PR/ })).toBeTruthy();
    });
    expect(screen.queryByText("技术实施方案（PLAN.md）")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /提交 \/ PR/ }));
    await waitFor(() => {
      expect(screen.getByText(/任务正在执行中/)).toBeTruthy();
    });
    expect(
      (screen.getByRole("button", { name: "确认 Commit" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    guardStatus = "paused";
    MockEventSource.instances[0]!.emit("task.updated", {
      seq: 1,
      type: "task.updated",
      taskId: "t-s6b-guard",
      patch: { status: "paused" },
    });
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "确认 Open PR" }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "确认 Open PR" }));
    await waitFor(() => {
      expect(
        screen.getByText(
          (_, el) => el?.tagName === "P" && Boolean(el.textContent?.includes("已创建 PR #99")),
        ),
      ).toBeTruthy();
    });
    expect(document.body.querySelectorAll('a[href^="javascript:"]')).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "关闭交付弹窗" }));

    // 2. Navigate to IntakeView: partial multi-upload preserves 1st image & blocks >10MiB
    fireEvent.click(screen.getByRole("button", { name: "新需求 N" }));
    await waitFor(() => {
      expect(document.getElementById("chatIn")).toBeTruthy();
    });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const big = new File([new Uint8Array(10)], "big.png", { type: "image/png" });
    Object.defineProperty(big, "size", { value: 11 * 1024 * 1024 });
    const f1 = new File([new Uint8Array([1, 2, 3])], "keep.png", { type: "image/png" });
    const f2 = new File([new Uint8Array([4, 5, 6])], "bad2.png", { type: "image/png" });
    fireEvent.change(fileInput, { target: { files: [big, f1, f2] } });

    await waitFor(() => {
      expect(screen.getByAltText("keep.png")).toBeTruthy();
    });
    expect(uploadSeq).toBe(2);

    // 3. PM reply with minimal kiln-split-cards fields normalizes cleanly & commits valid split cards
    fireEvent.change(document.getElementById("chatIn")!, {
      target: { value: "帮我拆成两张卡" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /查看拆卡 DAG/ })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /查看拆卡 DAG/ }));
    const dagPanel = screen.getByLabelText("多卡拆片 DAG 预览");
    fireEvent.click(within(dagPanel).getByRole("button", { name: "批量立项（2 张卡）" }));
    await waitFor(() => {
      expect(splitBody).not.toBeNull();
    });
    const normalized = splitBody!.cards as Array<{
      temp_id: string;
      space: string;
      workspace_mode: string;
      depends_on_temp_ids: string[];
      workflow?: { steps: unknown[] };
      contract: { end: string; accept_files_hash: string; scope: string[] };
      brief_markdown: string;
    }>;
    expect(normalized).toHaveLength(2);
    expect(normalized[0]!.space).toBe("kiln");
    expect(normalized[0]!.workspace_mode).toBe("git_worktree");
    expect(normalized[0]!.depends_on_temp_ids).toEqual([]);
    expect((normalized[0]!.workflow?.steps ?? []).length).toBeGreaterThan(0);
    expect(normalized[0]!.contract.accept_files_hash).toBe("pending");
    expect(normalized[1]!.depends_on_temp_ids).toEqual(["a1"]);
    expect(normalized[1]!.contract.end).toBe("接口联调完成");
  });

  it("blocks chat Enter/send, /new, and commit actions while attachment upload is in flight", async () => {
    const now = new Date().toISOString();
    let draftCreates = 0;
    let chatCalls = 0;
    let resolveUpload!: (res: Response) => void;

    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/bootstrap") {
        return jsonResponse(makeRosterBootstrap());
      }
      if (url === "/api/drafts" && init?.method === "POST") {
        draftCreates += 1;
        return jsonResponse({
          ok: true,
          draft: {
            schema_version: 1,
            id: "d-race-1",
            space: "kiln",
            priority: "P2",
            track: "L2",
            workspace_mode: "git_worktree",
            depends_on: [],
            attachments: [],
            created_at: now,
            updated_at: now,
          },
        });
      }
      if (url === "/api/drafts/d-race-1/attachments" && init?.method === "POST") {
        return await new Promise<Response>((resolve) => {
          resolveUpload = resolve;
        });
      }
      if (url === "/api/drafts/d-race-1/chat" && init?.method === "POST") {
        chatCalls += 1;
        return jsonResponse({
          ok: true,
          reply: { text: "收到截图" },
          messages: [
            { role: "user", text: "带截图需求", at: now },
            { role: "agent", text: "收到截图", at: now },
          ],
          draft: {
            schema_version: 1,
            id: "d-race-1",
            space: "kiln",
            priority: "P2",
            track: "L2",
            workspace_mode: "git_worktree",
            depends_on: [],
            created_at: now,
            updated_at: now,
          },
        });
      }
      return jsonResponse({});
    });

    window.location.hash = "#view=intake";
    const { container } = render(<App />);
    await waitFor(() => {
      expect(document.getElementById("chatIn")).toBeTruthy();
    });

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const f1 = new File([new Uint8Array([1, 2, 3])], "race.png", { type: "image/png" });
    fireEvent.change(fileInput, { target: { files: [f1] } });

    await waitFor(() => {
      expect(draftCreates).toBe(1);
    });

    // While upload is in flight, /new, close/save draft, and Enter send are blocked
    const chatEl = document.getElementById("chatIn") as HTMLTextAreaElement;
    expect((screen.getByRole("button", { name: "关闭对话" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "先存为草稿" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(chatEl, { target: { value: "/new" } });
    fireEvent.keyDown(chatEl, { key: "Enter", shiftKey: false });
    expect(draftCreates).toBe(1);

    fireEvent.change(chatEl, { target: { value: "带截图需求" } });
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(chatEl, { key: "Enter", shiftKey: false });
    expect(chatCalls).toBe(0);
    expect(draftCreates).toBe(1);

    resolveUpload(
      jsonResponse(
        {
          ok: true,
          attachment: {
            id: "att-race",
            filename: "race.png",
            mime_type: "image/png",
            size_bytes: 3,
            sha256: "race123",
            rel_path: "drafts/d-race-1/attachments/att-race.png",
            added_at: now,
          },
          draft: {
            schema_version: 1,
            id: "d-race-1",
            space: "kiln",
            priority: "P2",
            track: "L2",
            workspace_mode: "git_worktree",
            depends_on: [],
            attachments: [
              {
                id: "att-race",
                filename: "race.png",
                mime_type: "image/png",
                size_bytes: 3,
                sha256: "race123",
                rel_path: "drafts/d-race-1/attachments/att-race.png",
                added_at: now,
              },
            ],
            created_at: now,
            updated_at: now,
          },
        },
        201,
      ),
    );

    await waitFor(() => {
      expect(screen.getByAltText("race.png")).toBeTruthy();
      expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });

    fireEvent.keyDown(chatEl, { key: "Enter", shiftKey: false });
    await waitFor(() => {
      expect(chatCalls).toBe(1);
    });
  });
});
