// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultWorkflowTemplates } from "@kiln/protocol/web";
import type { BootstrapResponse, WorkflowsConfig } from "../api/types";
import { App } from "../app";

type MockFetchHandler = (url: string, init?: RequestInit) => Promise<Response> | Response;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeWorkflowBootstrap(overrides: Partial<BootstrapResponse> = {}): BootstrapResponse {
  const workflows: WorkflowsConfig = {
    schema_version: 1,
    default_template_id: "standard_dev",
    heterogeneous_review: false,
    stage_bindings: {
      intake: { provider: "codex", model: "gpt-5.4", effort: "medium" },
      implement: { provider: "codex", model: "gpt-5.4", effort: "medium" },
      review: { provider: "codex", model: "gpt-5.4", effort: "medium" },
      accept: { provider: "codex", model: "gpt-5.4", effort: "medium" },
      advisor: { provider: "codex", model: "gpt-5.4", effort: "high" },
    },
    stage_fallbacks: {},
    allow_full_access_fallback: {},
    verifier_capabilities: ["cli"],
    deliver_mode: "kernel",
    templates: createDefaultWorkflowTemplates(),
  };

  return {
    version: "0.0.5",
    tasks: [],
    pendingDecisions: [],
    drafts: [],
    spaces: {
      kiln: {
        schema_version: 1,
        id: "kiln",
        name: "Kiln",
        repo_path: "/tmp/kiln",
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
    roles: { schema_version: 1, heterogeneous_review: false, roles: {} },
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
    pricing: { schema_version: 1, models: {} },
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
    providers: [
      {
        provider_id: "codex",
        label: "Codex CLI",
        adapter: "codex_app_server",
        status: "ready",
        native_quota: null,
        local_window_cost_usd: 0,
      },
      {
        provider_id: "claude",
        label: "Claude Code",
        adapter: "claude_direct",
        status: "ready",
        native_quota: null,
        local_window_cost_usd: 0,
      },
    ],
    agents: [
      {
        id: "codex",
        label: "Codex CLI",
        capabilities: {
          interactiveChat: true,
          approvals: true,
          mcpInjection: true,
          usageCacheBreakdown: true,
          interrupt: true,
        },
        modes: [],
        models: [{ id: "gpt-5.4", thinkingOptions: ["low", "medium", "high"] }],
      },
      {
        id: "claude",
        label: "Claude Code",
        capabilities: {
          interactiveChat: true,
          approvals: true,
          mcpInjection: true,
          usageCacheBreakdown: true,
          interrupt: true,
        },
        modes: [],
        models: [{ id: "claude-opus-4-6", thinkingOptions: ["medium", "high"] }],
      },
    ],
    settings: {
      roles: { schema_version: 1, heterogeneous_review: false, roles: {} },
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
      pricing: { schema_version: 1, models: {} },
      workflows,
    },
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn<MockFetchHandler>>;

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "";
  window.history.replaceState(null, "", "/");
  fetchMock = vi.fn<MockFetchHandler>(async () => jsonResponse(makeWorkflowBootstrap()));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorkflowView animated flowchart, custom slots, same-model reuse & Intake template", () => {
  it("renders single-line animated flowchart + SVG loop/advisor rails, allows all steps to reuse same model cleanly, inserts post-loop write node with verify guard, and wires Intake template selector", async () => {
    let savedWorkflows: WorkflowsConfig | null = null;
    const boot = makeWorkflowBootstrap();

    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/auth/status") {
        return jsonResponse({ ok: true, mode: "local", authenticated: true, device: null });
      }
      if (url === "/api/bootstrap") {
        return jsonResponse(
          savedWorkflows
            ? makeWorkflowBootstrap({ settings: { ...boot.settings!, workflows: savedWorkflows } })
            : boot,
        );
      }
      if (url === "/api/settings/workflows" && (init?.method ?? "GET") === "PUT") {
        savedWorkflows = JSON.parse(String(init?.body)) as WorkflowsConfig;
        return jsonResponse({ ok: true, section: "workflows", data: savedWorkflows });
      }
      return jsonResponse({ ok: true });
    });

    window.location.hash = "#view=workflow";
    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: "工作流" })).toBeTruthy();

    // Animated SVG rails: connector stream, 3-part loop return SVG, and advisor bridge SVG
    expect(container.querySelectorAll(".wf-conn-stream").length).toBeGreaterThanOrEqual(3);
    expect(container.querySelector(".wf-loop-return-mid")).not.toBeNull();
    expect(container.querySelectorAll(".wf-loop-return-cap").length).toBe(2);
    expect(container.querySelector(".wf-advisor-bridge-svg")).not.toBeNull();

    // Mandatory accept stage renders cleanly with continuous sequential numbering (01..05)
    expect(container.querySelector('[data-wf-node="accept"]')).not.toBeNull();
    expect(
      Array.from(container.querySelectorAll("[data-step-num]")).map((el) =>
        el.getAttribute("data-step-num"),
      ),
    ).toEqual(["01", "02", "03", "04", "05"]);

    // Inside loop box, no dangling connector sits below the last inner node (review)
    const loopStepsEl = container.querySelector(".wf-loop-steps")!;
    expect(loopStepsEl.lastElementChild?.querySelector(".wf-conn")).toBeNull();
    expect(container.querySelector('[data-wf-slot="loop_after_review"]')).not.toBeNull();

    // Turning off optional 独立审查循环 keeps mandatory 真实验收 & shifts numbers sequentially (01..04)
    fireEvent.click(screen.getByRole("button", { name: "独立审查循环" }));
    expect(container.querySelector('[data-wf-node="accept"]')).not.toBeNull();
    expect(
      Array.from(container.querySelectorAll("[data-step-num]")).map((el) =>
        el.getAttribute("data-step-num"),
      ),
    ).toEqual(["01", "02", "03", "04"]);
    fireEvent.click(screen.getByRole("button", { name: "独立审查循环" }));

    // All steps reuse codex/gpt-5.4 with heterogeneous_review disabled -> zero clash warning
    expect(screen.queryByText(/撞模型/)).toBeNull();

    // Create a custom template and switch to it
    fireEvent.click(screen.getByRole("button", { name: "新建模板" }));
    const tplDialog = await screen.findByRole("dialog", { name: "新建工作流模板" });
    fireEvent.change(within(tplDialog).getByLabelText("新模板名称"), {
      target: { value: "安全发布流" },
    });
    fireEvent.click(within(tplDialog).getByRole("button", { name: "创建模板" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "新建工作流模板" })).toBeNull();
    });

    // Click post-loop connector slot, choose workspace_write, confirm auto-verify gate added cleanly
    fireEvent.click(container.querySelector('[data-wf-slot="after_loop"]')!);
    fireEvent.change(screen.getByLabelText("自定义步骤名称"), {
      target: { value: "文档同步" },
    });
    fireEvent.click(
      within(screen.getByRole("group", { name: "步骤权限类型" })).getByRole("button", {
        name: /工作区可写/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认插入步骤" }));

    await waitFor(() => {
      expect(container.textContent).toContain("文档同步");
      // normalizeWorkflowBlueprintSafety ensures an extra verify gate accompanies post-loop write node
      expect(container.querySelectorAll('[data-wf-node="verify"]').length).toBeGreaterThanOrEqual(
        2,
      );
    });

    // Save workflows
    fireEvent.click(screen.getByRole("button", { name: /保存工作流/ }));
    await waitFor(() => {
      expect(savedWorkflows).not.toBeNull();
    });

    const customTpl = savedWorkflows!.templates.find((t) => t.name === "安全发布流");
    expect(customTpl).toBeDefined();
    expect(
      customTpl!.blueprint.steps.some((s) => s.kind === "agent" && s.label === "文档同步"),
    ).toBe(true);

    // Navigate to IntakeView and select the newly saved custom template
    fireEvent.click(container.querySelector(".new-btn")!);
    fireEvent.click(await screen.findByRole("tab", { name: /立项设置/ }));
    const tplSelect = await screen.findByLabelText("流程模板");
    fireEvent.click(tplSelect);
    const tplList = await screen.findByRole("listbox", { name: "流程模板" });
    const targetOption = within(tplList)
      .getAllByRole("option")
      .find((o) => o.textContent?.includes("安全发布流"));
    expect(targetOption).toBeTruthy();
    fireEvent.click(targetOption!);

    await waitFor(() => {
      const preview = screen.getByLabelText("流程预览");
      expect(preview.textContent).toContain("文档同步");
    });
  });
});
