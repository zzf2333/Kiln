import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AcceptVerificationReportSchema,
  DraftCardSchema,
  GateReportSchema,
  ImprovementProposalSchema,
  ImprovementProposalsFileSchema,
  LedgerEntrySchema,
  LedgerFileSchema,
  RolesConfigSchema,
  RunEventSchema,
  RunMetaSchema,
  SpaceConfigSchema,
  StateEventSchema,
  TaskCardSchema,
  TaskRetroReportSchema,
  buildWorkflowPreset,
  type TaskCard,
} from "@kiln/protocol";
import { BackendRegistry, FakeBackend, type BackendAgentDescriptor } from "../../backend/index.js";
import { TaskStateMachine } from "../../state/index.js";
import {
  KilnStore,
  readYamlOptional,
  writeFileAtomic,
  writeYamlAtomic,
} from "../../store/index.js";
import { KilnChatEngine } from "../chat.js";
import { createHttpApiApp } from "../http-api.js";
import { buildHandoffMarkdown } from "../orchestrator-handoff.js";
import { PendingDecisionStore } from "../pending-decisions.js";
import {
  approveImprovementProposal,
  assertProposalNotCheating,
  computeOrchestrationAnalytics,
  extractDeterministicTaskRetro,
  listPolicyHistoryWithEvaluation,
  readImprovementProposals,
  rollbackPolicyChange,
  runAiTaskRetro,
  selectActiveLedgerEntriesForHandoff,
  upsertImprovementProposals,
} from "../index.js";
import { SseHub } from "../sse.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const CODEX_DESCRIPTOR: BackendAgentDescriptor = {
  id: "codex",
  label: "Codex",
  capabilities: {
    interactiveChat: true,
    approvals: true,
    mcpInjection: false,
    usageCacheBreakdown: true,
    interrupt: true,
    imageInput: true,
    warmSessionReuse: false,
  },
  modes: [{ id: "auto", label: "Auto" }],
  defaultModeId: "auto",
};

function makeSpace(
  id = "proj-a",
  overrides: Partial<ReturnType<typeof SpaceConfigSchema.parse>> = {},
) {
  return SpaceConfigSchema.parse({
    schema_version: 1,
    id,
    name: `Space ${id}`,
    repo_path: createTempDir(`kiln-repo-${id}-`),
    default_branch: "main",
    copy_untracked: [],
    clone_deps: [],
    freeze_patterns: [],
    ...overrides,
  });
}

function makeTaskCard(id: string, space = "proj-a", overrides: Partial<TaskCard> = {}): TaskCard {
  return TaskCardSchema.parse({
    schema_version: 1,
    id,
    space,
    title: `Task ${id}`,
    track: "L2",
    priority: "P1",
    workspace_mode: "git_worktree",
    created_at: "2026-11-24T00:00:00Z",
    updated_at: "2026-11-24T00:00:00Z",
    limits: {
      max_tokens: 150000,
      retries_per_stage: 2,
      review_rounds: 2,
      advisor_calls: 2,
    },
    contract: {
      goal: `Complete ${id}`,
      end: `Verify ${id}`,
      accept_cmd: "pnpm test",
      accept_files_hash: `sha256:${"a".repeat(64)}`,
      scope: ["src/**"],
      non_goals: [],
      deliver: { mode: "merge_main", cmd: null },
      human_accept: false,
      external_actions: "ask",
    },
    contract_version: 1,
    depends_on: [],
    ...overrides,
  });
}

function seedFinishedTask(
  store: KilnStore,
  opts: {
    id: string;
    space?: string;
    preset?: "quick" | "standard_dev" | "full_delivery";
    finishedAt?: string;
    rework?: boolean;
    escalatedFrom?: string;
    outOfScope?: string[];
    acceptFailed?: boolean;
    steeredMessage?: string;
    costUsd?: number;
  },
): void {
  const space = opts.space ?? "proj-a";
  const card = makeTaskCard(
    opts.id,
    space,
    opts.preset ? { workflow: buildWorkflowPreset(opts.preset) } : {},
  );
  store.createTask(card, `# ${opts.id}\nBrief body`);

  // Run 1: implement
  const run1Meta = RunMetaSchema.parse({
    schema_version: 1,
    run_id: `run-${opts.id}-impl-1`,
    task_id: opts.id,
    stage: "implement",
    round: 1,
    contract_version: 1,
    role: "worker",
    roster_role: opts.escalatedFrom ? "main_dev" : "fast_fix",
    agent: "codex",
    model: opts.escalatedFrom ? "gpt-5.4" : "gpt-5.4-mini",
    backend_id: "fake",
    session_ref: { backendId: "fake", sessionId: `s-${opts.id}-1` },
    started_at: "2026-11-24T00:01:00Z",
    ...(opts.escalatedFrom ? { escalated_from: opts.escalatedFrom } : {}),
  });
  writeYamlAtomic(store.paths.runYaml(opts.id, "implement-1"), run1Meta, RunMetaSchema);
  writeYamlAtomic(
    store.paths.gateYaml(opts.id, "implement-1"),
    GateReportSchema.parse({
      schema_version: 1,
      run_id: run1Meta.run_id,
      contract_version: 1,
      schema_ok: true,
      scope_ok: !opts.outOfScope?.length,
      artifacts_ok: true,
      frozen_files_changed: [],
      accept_exit_code: opts.outOfScope?.length ? 1 : 0,
      accept_duration_ms: 120,
      escalated_to_l2: false,
      out_of_scope_paths: opts.outOfScope ?? [],
      checked_at: "2026-11-24T00:02:00Z",
    }),
    GateReportSchema,
  );

  if (opts.rework) {
    const revMeta = RunMetaSchema.parse({
      ...run1Meta,
      run_id: `run-${opts.id}-rev-1`,
      stage: "review",
      role: "reviewer",
      roster_role: "reviewer",
      started_at: "2026-11-24T00:03:00Z",
    });
    writeYamlAtomic(store.paths.runYaml(opts.id, "review-1"), revMeta, RunMetaSchema);
    writeFileAtomic(
      store.paths.receiptMd(opts.id, "review-1"),
      [
        "---",
        `run_id: ${revMeta.run_id}`,
        "contract_version: 1",
        `reviewed_ref: "HEAD"`,
        "verdict: changes_requested",
        "p0: 0",
        "p1: 1",
        "p2: 0",
        "---",
        "## 结论",
        "需要补充边界校验。",
        "",
        "## 缺陷清单",
        "- P1: 缺少异常分支校验",
        "",
        "## 测试真实性与复现核查",
        "- 已复核",
      ].join("\n"),
    );

    const run2Meta = RunMetaSchema.parse({
      ...run1Meta,
      run_id: `run-${opts.id}-impl-2`,
      round: 2,
      started_at: "2026-11-24T00:04:00Z",
    });
    writeYamlAtomic(store.paths.runYaml(opts.id, "implement-2"), run2Meta, RunMetaSchema);
    writeYamlAtomic(
      store.paths.gateYaml(opts.id, "implement-2"),
      GateReportSchema.parse({
        schema_version: 1,
        run_id: run2Meta.run_id,
        contract_version: 1,
        schema_ok: true,
        scope_ok: true,
        artifacts_ok: true,
        frozen_files_changed: [],
        accept_exit_code: 0,
        accept_duration_ms: 95,
        escalated_to_l2: false,
        out_of_scope_paths: [],
        checked_at: "2026-11-24T00:05:00Z",
      }),
      GateReportSchema,
    );
  }

  if (opts.acceptFailed) {
    const accMeta = RunMetaSchema.parse({
      ...run1Meta,
      run_id: `run-${opts.id}-acc-1`,
      stage: "accept",
      role: "verifier",
      roster_role: "verifier",
      started_at: "2026-11-24T00:06:00Z",
    });
    writeYamlAtomic(store.paths.runYaml(opts.id, "accept-1"), accMeta, RunMetaSchema);
    writeYamlAtomic(
      store.paths.runAcceptReportYaml(opts.id, "accept-1"),
      AcceptVerificationReportSchema.parse({
        schema_version: 1,
        run_id: accMeta.run_id,
        contract_version: 1,
        checked_at: "2026-11-24T00:07:00Z",
        entry_kind: "http_server",
        entry_mode: "browser",
        verdict: "fail",
        gate_ok: false,
        scenarios: [{ name: "登录后刷新不丢会话", status: "fail", note: "401 Unauthorized" }],
        rejection_reasons: ["登录后刷新返回 401"],
      }),
      AcceptVerificationReportSchema,
    );
  }

  if (opts.steeredMessage) {
    store.appendStateEvent(
      opts.id,
      StateEventSchema.parse({
        type: "steered",
        steer_id: `steer-${opts.id}`,
        contract_version: 1,
        at: "2026-11-24T00:02:30Z",
        message: opts.steeredMessage,
        interrupt: false,
      }),
    );
  }

  if (opts.costUsd !== undefined && opts.costUsd > 0) {
    store.recordRunEvent(
      opts.id,
      "implement-1",
      RunEventSchema.parse({
        kind: "usage",
        turnId: `ut-${opts.id}-1`,
        agent: run1Meta.agent,
        model: run1Meta.model,
        inputTokens: 1000,
        cachedInputTokens: 700,
        outputTokens: 300,
        providerCostUsd: opts.costUsd,
        costSource: "provider_reported",
        at: "2026-11-24T00:02:00Z",
      }),
    );
  }

  store.appendStateEvent(
    opts.id,
    StateEventSchema.parse({
      type: "done",
      at: opts.finishedAt ?? "2026-11-24T00:10:00Z",
      deliver_ref: `merge:${opts.id}`,
    }),
  );
}

describe("Track 4 compounding flywheel (B13 + B14 + B15)", () => {
  const stores: KilnStore[] = [];

  afterEach(() => {
    for (const st of stores.splice(0)) {
      st.close();
    }
    for (const d of tempDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("extracts 0-Token deterministic RETRO, detects high-signal & 5 attributions, and enriches via cold read-only AI retro", async () => {
    const home = createTempDir("kiln-t4-retro-");
    const store = new KilnStore({ kilnHome: home });
    stores.push(store);
    store.writeSpace(makeSpace("proj-a"));

    seedFinishedTask(store, {
      id: "t-high",
      space: "proj-a",
      rework: true,
      escalatedFrom: "fast_fix",
      outOfScope: ["unrelated/foo.ts"],
      acceptFailed: true,
      steeredMessage: "必须兼容 Safari 窄屏弹窗",
      costUsd: 0.25,
    });

    const report = extractDeterministicTaskRetro(store, "t-high");
    expect(report.mode).toBe("deterministic");
    expect(report.high_signal).toBe(true);
    expect(report.signals).toContain("accept_failures=1");
    expect(report.signals).toContain("review_rejections=1");
    expect(report.attributions.map((a) => a.category)).toEqual(
      expect.arrayContaining(["intake_contract", "model_fit", "space_rule", "recon_plan"]),
    );

    const diskReport = readYamlOptional(store.paths.retroYaml("t-high"), TaskRetroReportSchema);
    expect(diskReport?.task_id).toBe("t-high");
    expect(fs.existsSync(store.paths.retroMd("t-high"))).toBe(true);

    // Enqueued proposals without duplicating when rerun
    const propsBefore = readImprovementProposals(store);
    expect(propsBefore.length).toBeGreaterThanOrEqual(2);
    extractDeterministicTaskRetro(store, "t-high");
    expect(readImprovementProposals(store).length).toBe(propsBefore.length);

    // Cold read-only AI retro using FakeBackend
    const fakeBackend = new FakeBackend({
      backendId: "fake",
      agents: [CODEX_DESCRIPTOR],
    });
    fakeBackend.enqueueScript([
      {
        kind: "message",
        text: [
          "根因在于立项阶段未采集窄屏 Safari 约束，且实施改动越过 scope。",
          "```kiln-retro-json",
          JSON.stringify({
            summary: "AI 深度复盘：建议把窄屏校验固化到立项清单与验收场景",
            attributions: [
              {
                category: "intake_contract",
                earliest_preventable_stage: "intake",
                summary: "立项漏问浏览器与视口边界",
                evidence: "steered: 必须兼容 Safari 窄屏弹窗",
              },
            ],
            proposals: [
              {
                source: "retro",
                target_kind: "space_accept_scenario",
                space: "proj-a",
                title: "补充 Safari 390px 弹窗验收场景",
                rationale: "t-high 曾在此分支发生人工纠偏",
                expected_impact: "交付前自动覆盖移动端弹窗",
                evidence_task_ids: ["t-high"],
                payload: { scenario: "390px 宽度打开并关闭弹窗无水平滚动" },
              },
            ],
          }),
          "```",
        ].join("\n"),
      },
      { kind: "exit", reason: "completed" },
    ]);
    const registry = new BackendRegistry();
    registry.register(fakeBackend);
    store.writeConfig(
      "roles",
      RolesConfigSchema.parse({
        schema_version: 1,
        roles: {
          advisor: {
            agent: "codex",
            model: "gpt-5.4",
            backend_id: "fake",
          },
        },
      }),
    );

    const aiReport = await runAiTaskRetro({
      store,
      backendRegistry: registry,
      taskId: "t-high",
    });
    expect(aiReport.mode).toBe("ai_enriched");
    expect(aiReport.summary).toContain("AI 深度复盘");
    const recordedSpecs = fakeBackend.getRecordedSpecs();
    expect(recordedSpecs[0]?.readOnly).toBe(true);
    expect(recordedSpecs[0]?.freshContext).toBe(true);
    expect(
      readImprovementProposals(store).some((p) => p.title === "补充 Safari 390px 弹窗验收场景"),
    ).toBe(true);
  });

  it("blocks cheating proposals, enforces 20-entry bounded ledger & human approval before injecting HANDOFF/intake", async () => {
    const home = createTempDir("kiln-t4-guard-");
    const store = new KilnStore({ kilnHome: home });
    stores.push(store);
    store.writeSpace(makeSpace("proj-a"));

    // Anti-cheating checks
    expect(() =>
      assertProposalNotCheating(
        ImprovementProposalSchema.parse({
          id: "bad-1",
          source: "retro",
          target_kind: "space_ledger",
          title: "跳过验证",
          rationale: "提高速度",
          expected_impact: "更快完成",
          evidence_task_ids: [],
          payload: { rule: "skip_verify when urgent" },
          created_at: "2026-11-24T00:00:00Z",
        }),
      ),
    ).toThrow(/Rejected unsafe optimization proposal/i);

    expect(() =>
      assertProposalNotCheating(
        ImprovementProposalSchema.parse({
          id: "bad-2",
          source: "retro",
          target_kind: "roster_policy",
          title: "关闭异构审查",
          rationale: "省 token",
          expected_impact: "快一点",
          evidence_task_ids: [],
          payload: { pm_orchestration_patch: { heterogeneous_review: false } },
          created_at: "2026-11-24T00:00:00Z",
        }),
      ),
    ).toThrow(/heterogeneous_review/i);

    // Bounded active ledger selection (24 entries -> max 20 active, excludes archived)
    const manyEntries = Array.from({ length: 24 }, (_, idx) =>
      LedgerEntrySchema.parse({
        id: `led-${idx}`,
        space: "proj-a",
        rule: `规则-${idx}`,
        source_task_id: "t-seed",
        created_at: `2026-11-${String((idx % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        hit_count: idx,
        status: idx === 23 ? "archived" : "active",
      }),
    );
    const selected = selectActiveLedgerEntriesForHandoff(manyEntries);
    expect(selected).toHaveLength(20);
    expect(selected.some((e) => e.id === "led-23")).toBe(false);
    expect(selected[0]?.id).toBe("led-22");

    // Pending proposals MUST NOT mutate space/ledger/HANDOFF until approved
    const [pendingChecklist, pendingScenario] = upsertImprovementProposals(store, [
      {
        source: "retro",
        target_kind: "space_intake_checklist",
        space: "proj-a",
        title: "立项检查：核对迁移兼容",
        rationale: "避免字段不兼容",
        expected_impact: "立项一次准确",
        evidence_task_ids: ["t-1"],
        payload: { items: ["立项确认向后兼容策略"] },
      },
      {
        source: "retro",
        target_kind: "space_accept_scenario",
        space: "proj-a",
        title: "验收场景：核对真实数据持久化",
        rationale: "确保刷新不丢失",
        expected_impact: "拦截假持久化",
        evidence_task_ids: ["t-1"],
        payload: { scenarios: ["保存配置并重开进程仍保留"] },
      },
    ]);

    store.writeLedger(
      LedgerFileSchema.parse({
        schema_version: 1,
        space: "proj-a",
        entries: manyEntries,
      }),
    );

    const card = makeTaskCard("t-check", "proj-a");
    store.createTask(card, "# Brief");

    const acceptBefore = buildHandoffMarkdown({
      store,
      card,
      runId: "r-acc-before",
      runDirName: "accept-1",
      stage: "accept",
      round: 1,
      role: "verifier",
      cwd: card.space,
      mcpEnabled: false,
    });
    expect(acceptBefore).not.toContain("保存配置并重开进程仍保留");

    // Approve both proposals
    approveImprovementProposal(store, pendingChecklist!.id);
    approveImprovementProposal(store, pendingScenario!.id);

    const acceptAfter = buildHandoffMarkdown({
      store,
      card,
      runId: "r-acc-after",
      runDirName: "accept-2",
      stage: "accept",
      round: 1,
      role: "verifier",
      cwd: card.space,
      mcpEnabled: false,
    });
    expect(acceptAfter).toContain("保存配置并重开进程仍保留");

    // Verify KilnChatEngine injects intake_checklist + active ledger into intake systemPrompt
    const fakeBackend = new FakeBackend({
      backendId: "fake",
      agents: [CODEX_DESCRIPTOR],
    });
    fakeBackend.enqueueScript([
      { kind: "message", text: "好的，先核对向后兼容策略。" },
      { kind: "exit", reason: "completed" },
    ]);
    const registry = new BackendRegistry();
    registry.register(fakeBackend);
    const chat = new KilnChatEngine({
      store,
      backendRegistry: registry,
      pendingDecisions: new PendingDecisionStore(store),
      socketPath: store.paths.kilndSock,
      issueRunToken: () => "tok-test",
      sseHub: new SseHub(),
    });
    const draft = DraftCardSchema.parse({
      schema_version: 1,
      id: "dr-1",
      title: "新增配置字段",
      space: "proj-a",
      priority: "P2",
      track: "L2",
      workspace_mode: "git_worktree",
      depends_on: [],
      created_at: "2026-11-24T00:00:00Z",
      updated_at: "2026-11-24T00:00:00Z",
    });
    store.writeDraft(draft);
    await chat.sendDraftChat(draft.id, "开始立项分析");
    const intakePrompt = fakeBackend.getRecordedSpecs()[0]?.systemPrompt ?? "";
    expect(intakePrompt).toContain("立项确认向后兼容策略");
    expect(intakePrompt).toContain("规则-22");
    expect(intakePrompt).not.toContain("规则-23");
  });

  it("computes cross-task analytics, records policy history, flags regressions, and executes one-click rollback", () => {
    const home = createTempDir("kiln-t4-analytics-");
    const store = new KilnStore({ kilnHome: home });
    stores.push(store);
    store.writeSpace(makeSpace("proj-a"));

    // Seed 3 clean baseline tasks BEFORE policy change
    seedFinishedTask(store, {
      id: "t-base-1",
      preset: "quick",
      finishedAt: "2026-11-24T01:00:00Z",
      costUsd: 0.05,
    });
    seedFinishedTask(store, {
      id: "t-base-2",
      preset: "quick",
      finishedAt: "2026-11-24T01:10:00Z",
      costUsd: 0.06,
    });
    seedFinishedTask(store, {
      id: "t-base-3",
      preset: "quick",
      finishedAt: "2026-11-24T01:20:00Z",
      costUsd: 0.05,
    });

    // Approve roster_policy change
    const [policyProp] = upsertImprovementProposals(store, [
      {
        source: "analytics",
        target_kind: "roster_policy",
        space: "proj-a",
        title: "关闭 fast_fix 默认优先策略",
        rationale: "复杂项目直接上 main_dev",
        expected_impact: "减少升档损耗",
        evidence_task_ids: ["t-base-1"],
        payload: {
          pm_orchestration_patch: { plan_prefers_fast_exec: false },
        },
      },
    ]);

    const originalFastExec =
      store.readEffectiveRosterConfig().pm_orchestration.plan_prefers_fast_exec;
    const approved = approveImprovementProposal(store, policyProp!.id);
    expect(approved.updatedRoster).toBe(true);
    expect(store.readEffectiveRosterConfig().pm_orchestration.plan_prefers_fast_exec).toBe(false);

    // Seed 3 post-change regressed tasks AFTER policy change timestamp
    const afterBase = Date.parse(approved.change.applied_at);
    seedFinishedTask(store, {
      id: "t-after-1",
      preset: "standard_dev",
      finishedAt: new Date(afterBase + 10_000).toISOString(),
      rework: true,
      costUsd: 0.3,
    });
    seedFinishedTask(store, {
      id: "t-after-2",
      preset: "standard_dev",
      finishedAt: new Date(afterBase + 20_000).toISOString(),
      rework: true,
      costUsd: 0.35,
    });
    seedFinishedTask(store, {
      id: "t-after-3",
      preset: "standard_dev",
      finishedAt: new Date(afterBase + 30_000).toISOString(),
      rework: true,
      costUsd: 0.4,
    });

    const analytics = computeOrchestrationAnalytics(store);
    expect(analytics.overall.task_count).toBe(6);
    expect(analytics.by_workflow_preset.map((w) => w.preset)).toEqual(
      expect.arrayContaining(["quick", "standard_dev"]),
    );

    const history = listPolicyHistoryWithEvaluation(store);
    expect(history).toHaveLength(1);
    expect(history[0]!.regression_alert).toBe(true);
    expect(history[0]!.regression_reasons.length).toBeGreaterThanOrEqual(2);

    // One-click rollback restores exact prior RosterConfig
    const rolled = rollbackPolicyChange(store, history[0]!.id);
    expect(rolled.updatedRoster).toBe(true);
    expect(rolled.change.rolled_back_at).toBeTruthy();
    expect(store.readEffectiveRosterConfig().pm_orchestration.plan_prefers_fast_exec).toBe(
      originalFastExec,
    );
  });

  it("exposes end-to-end Track 4 HTTP APIs (space checklist/scenarios, task retro, improvements approve/dismiss/rollback)", async () => {
    const home = createTempDir("kiln-t4-http-");
    const store = new KilnStore({ kilnHome: home });
    stores.push(store);
    const repoPath = createTempDir("kiln-t4-http-repo-");
    execFileSync("git", ["init", "-q"], { cwd: repoPath });

    store.writeSpace(
      SpaceConfigSchema.parse({
        schema_version: 1,
        id: "proj-http",
        name: "HTTP Repo",
        repo_path: repoPath,
        default_branch: "main",
        copy_untracked: [],
        clone_deps: [],
        freeze_patterns: [],
      }),
    );

    seedFinishedTask(store, {
      id: "t-http-1",
      space: "proj-http",
      rework: true,
      costUsd: 0.2,
    });

    const sseHub = new SseHub();
    const stateMachine = new TaskStateMachine(store);
    const app = createHttpApiApp({
      store,
      stateMachine,
      sseHub,
      caffeinate: { syncRunningCount: () => {}, dispose: () => {} } as never,
      pendingDecisions: new PendingDecisionStore(store),
    });

    // 1. PUT /api/spaces/:id persists intake_checklist & accept_scenarios
    const putSpaceRes = await app.request("/api/spaces/proj-http", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "HTTP Repo",
        repo_path: repoPath,
        default_branch: "main",
        intake_checklist: ["必须先确认迁移脚本"],
        accept_scenarios: ["真实服务启动后可访问 /health"],
        default_workflow_preset: "standard_dev",
      }),
    });
    expect(putSpaceRes.status).toBe(200);
    const savedSpace = store.readSpace("proj-http");
    expect(savedSpace?.intake_checklist).toEqual(["必须先确认迁移脚本"]);
    expect(savedSpace?.accept_scenarios).toEqual(["真实服务启动后可访问 /health"]);
    expect(savedSpace?.default_workflow_preset).toBe("standard_dev");

    // 2. POST /api/tasks/:id/retro & GET /api/tasks/:id includes retro
    const retroRes = await app.request("/api/tasks/t-http-1/retro", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ use_ai: false }),
    });
    expect(retroRes.status).toBe(200);

    const detailRes = await app.request("/api/tasks/t-http-1");
    expect(detailRes.status).toBe(200);
    const detailJson = (await detailRes.json()) as {
      retro: { report: { task_id: string }; markdown: string } | null;
    };
    expect(detailJson.retro?.report.task_id).toBe("t-http-1");
    expect(detailJson.retro?.markdown).toContain("任务复盘报告");

    // 3. Seed multiple tasks for POST /api/improvements/analyze + approve + rollback + dismiss
    seedFinishedTask(store, {
      id: "t-http-2",
      space: "proj-http",
      escalatedFrom: "fast_fix",
      rework: true,
    });
    seedFinishedTask(store, {
      id: "t-http-3",
      space: "proj-http",
      escalatedFrom: "fast_fix",
      rework: true,
    });

    const analyzeRes = await app.request("/api/improvements/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(analyzeRes.status).toBe(200);
    const analyzeJson = (await analyzeRes.json()) as {
      ok: true;
      proposals: Array<{ id: string; target_kind: string; status: string }>;
    };
    expect(analyzeJson.proposals.some((p) => p.status === "pending")).toBe(true);

    const firstPending = analyzeJson.proposals.find((p) => p.status === "pending")!;
    const approveRes = await app.request(`/api/improvements/proposals/${firstPending.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(approveRes.status).toBe(200);
    const approveJson = (await approveRes.json()) as {
      ok: true;
      change: { id: string };
    };

    const rollbackRes = await app.request(
      `/api/improvements/policy-history/${approveJson.change.id}/rollback`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    expect(rollbackRes.status).toBe(200);

    const sumRes = await app.request("/api/improvements/summary");
    expect(sumRes.status).toBe(200);
    const sumJson = (await sumRes.json()) as {
      ok: true;
      policyHistory: Array<{ id: string; rolled_back_at?: string }>;
    };
    expect(sumJson.policyHistory[0]?.rolled_back_at).toBeTruthy();

    // Anti-cheating HTTP 400 test (simulate tampered disk file bypassing upsert) + dismiss HTTP 200 test
    const existingProps = readImprovementProposals(store);
    const cheatProp = ImprovementProposalSchema.parse({
      id: "prop-cheat-disk",
      source: "retro",
      target_kind: "space_ledger",
      space: "proj-http",
      title: "禁止跳过验证",
      rationale: "test anti-cheating http 400",
      expected_impact: "should fail",
      evidence_task_ids: [],
      payload: { rule: "bypass_gate on all PRs" },
      created_at: "2026-11-24T02:00:00Z",
    });
    writeYamlAtomic(
      store.paths.improvementProposalsYaml,
      ImprovementProposalsFileSchema.parse({
        schema_version: 1,
        proposals: [...existingProps, cheatProp],
      }),
      ImprovementProposalsFileSchema,
    );
    const cheatApprove = await app.request(`/api/improvements/proposals/${cheatProp.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(cheatApprove.status).toBe(400);

    const [validProp] = upsertImprovementProposals(store, [
      {
        source: "retro",
        target_kind: "space_ledger",
        space: "proj-http",
        title: "保持端到端构建验证",
        rationale: "test dismiss flow",
        expected_impact: "clean ledger",
        evidence_task_ids: ["t-http-1"],
        payload: { rule: "改动完成后运行全量 pnpm build && pnpm test" },
      },
    ]);
    const dismissRes = await app.request(`/api/improvements/proposals/${validProp!.id}/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(dismissRes.status).toBe(200);
    const dismissJson = (await dismissRes.json()) as {
      ok: true;
      proposal: { status: string };
    };
    expect(dismissJson.proposal.status).toBe("dismissed");
  });
});
