import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RosterConfigSchema,
  RunMetaSchema,
  parseAndValidateReceipt,
  serializeFrontmatterMarkdown,
  type LimitsConfig,
  type RosterConfig,
  type TaskCard,
} from "@kiln/protocol";
import { FakeBackend } from "../../backend/index.js";
import { computeFrozenSnapshot } from "../../gate/index.js";
import { TaskStateMachine } from "../../state/index.js";
import { KilnStore, readYamlOptional } from "../../store/index.js";
import { KilndServer } from "../index.js";
import { buildHandoffPayload } from "../orchestrator-handoff.js";
import { WarmSessionPool } from "../orchestrator-warm-pool.js";
import { computeUsageSnapshot } from "../pending-decisions.js";

function git(args: readonly string[], cwd?: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function makeWorkerReceiptMarkdown(fields: {
  run_id: string;
  contract_version: number;
  input_ref: string;
  output_ref: string;
  changed_paths: string[];
}): string {
  return serializeFrontmatterMarkdown(
    {
      run_id: fields.run_id,
      contract_version: fields.contract_version,
      outcome: "completed",
      input_ref: fields.input_ref,
      output_ref: fields.output_ref,
      changed_paths: fields.changed_paths,
      accept_result: "pass",
      is_bugfix: false,
      complexity_escalate: false,
    },
    [
      "## 改动说明\n完成实现\n",
      "## 验证命令与真实输出\nexit code 0\n",
      "## 未完成或待决问题\n无\n",
    ].join("\n"),
  );
}

function makeReviewerReceiptMarkdown(fields: {
  run_id: string;
  contract_version: number;
  reviewed_ref: string;
  verdict: "pass" | "changes_requested";
}): string {
  return serializeFrontmatterMarkdown(
    {
      run_id: fields.run_id,
      contract_version: fields.contract_version,
      reviewed_ref: fields.reviewed_ref,
      verdict: fields.verdict,
      p0: 0,
      p1: 0,
      p2: 0,
    },
    ["## 结论\n审查通过\n", "## 缺陷清单\n无\n", "## 测试真实性与复现核查\n真实执行通过\n"].join(
      "\n",
    ),
  );
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

function makeWarmCapableBackend(): FakeBackend {
  return new FakeBackend({
    backendId: "fake",
    agents: [
      {
        id: "codex",
        label: "Codex",
        capabilities: {
          interactiveChat: true,
          approvals: true,
          mcpInjection: true,
          usageCacheBreakdown: true,
          interrupt: true,
          warmSessionReuse: true,
          contextWindowTelemetry: true,
        },
        modes: [
          { id: "auto", label: "Auto" },
          { id: "full-access", label: "Full", isFullAccess: true },
        ],
        defaultModeId: "auto",
      },
      {
        id: "claude",
        label: "Claude",
        capabilities: {
          interactiveChat: true,
          approvals: true,
          mcpInjection: true,
          usageCacheBreakdown: true,
          interrupt: true,
          warmSessionReuse: true,
          contextWindowTelemetry: true,
        },
        modes: [
          { id: "default", label: "Default" },
          { id: "full-access", label: "Full", isFullAccess: true },
        ],
        defaultModeId: "default",
      },
    ],
    models: {
      codex: [{ id: "gpt-5.4", label: "gpt-5.4", thinkingOptions: [] }],
      claude: [{ id: "claude-sonnet-4-6", label: "claude-sonnet-4-6", thinkingOptions: [] }],
    },
  });
}

function makeBaseRoster(): RosterConfig {
  return RosterConfigSchema.parse({
    schema_version: 2,
    heterogeneous_review: true,
    roster: {
      main_dev: {
        group: "core",
        enabled: true,
        name: "主力开发",
        stage: "implement",
        perm: "workspace_write",
        traits: "backend",
        mode: "agent",
        primary: { provider: "codex", model: "gpt-5.4", backend_id: "fake" },
      },
      reviewer: {
        group: "core",
        enabled: true,
        name: "异构审查",
        stage: "review",
        perm: "read_only",
        traits: "review",
        mode: "agent",
        avoid_same_as: "implement",
        primary: { provider: "claude", model: "claude-sonnet-4-6", backend_id: "fake" },
      },
      tester: {
        group: "kernel",
        enabled: true,
        name: "独立测试",
        stage: "verify",
        perm: "kernel_gate",
        traits: "verify",
        mode: "kernel",
      },
      deliverer: {
        group: "kernel",
        enabled: true,
        name: "合并交付",
        stage: "deliver",
        perm: "kernel_gate",
        traits: "deliver",
        mode: "kernel",
      },
    },
  });
}

function defaultLimits(): LimitsConfig {
  return {
    schema_version: 1,
    max_concurrent_slots: 4,
    p0_extra_slot: true,
    max_waiting_wip: 5,
    retries_per_stage: 2,
    review_rounds: 2,
    advisor_calls: 1,
    max_card_tokens: 5_000_000,
  };
}

describe("Track 1: B1 layered HANDOFF, B2 warm session reuse & sessionKey MCP auth, B3 usage observability", () => {
  const tempDirs: string[] = [];
  const servers: KilndServer[] = [];

  function makeTempDir(prefix = "kiln-track1-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function initGitRepo(name: string): { repoPath: string; baseCommit: string } {
    const repoPath = makeTempDir(`kiln-t1-repo-${name}-`);
    git(["init", "-b", "main"], repoPath);
    git(["config", "user.name", "Test User"], repoPath);
    git(["config", "user.email", "test@example.com"], repoPath);
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "src", "app.ts"), "export const v = 1;\n");
    git(["add", "."], repoPath);
    git(["commit", "-m", "chore: initial"], repoPath);
    const baseCommit = git(["rev-parse", "HEAD"], repoPath).trim();
    return { repoPath, baseCommit };
  }

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()!.stop();
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("B1: builds byte-identical stablePrefix across rounds, projects RESEARCH.md to pointer when PLAN.md exists, and applies track plan directives", () => {
    const kilnHome = makeTempDir("kiln-b1-home-");
    const store = new KilnStore({ kilnHome });
    const now = new Date().toISOString();
    const card: TaskCard = {
      schema_version: 1,
      id: "t-b1-prefix",
      title: "B1 前缀稳定测试",
      space: "kiln",
      priority: "P2",
      track: "L2",
      workspace_mode: "git_worktree",
      parent: null,
      depends_on: [],
      contract_version: 1,
      contract: {
        goal: "验证分层前缀稳定性",
        end: "prefix 字节完全一致",
        accept_cmd: "pnpm test",
        accept_files_hash: "sha256:test",
        scope: ["src/**"],
        deliver: { mode: "merge_main", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: {
        retries_per_stage: 2,
        review_rounds: 2,
        advisor_calls: 1,
        max_tokens: 100_000,
      },
      created_at: now,
      updated_at: now,
    };

    store.writeSpace({
      schema_version: 1,
      id: "kiln",
      name: "Kiln",
      repo_path: kilnHome,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    store.writeLedger({
      schema_version: 1,
      space: "kiln",
      entries: [
        {
          id: "l-1",
          rule: "禁止修改冻结测试",
          space: "kiln",
          source_task_id: "t-0",
          created_at: now,
        },
      ],
    });
    const sm = new TaskStateMachine(store);
    sm.createTask(card, "# B1 产品需求");
    fs.writeFileSync(
      store.paths.researchMd(card.id),
      "SECRET_RAW_RESEARCH_BODY_DO_NOT_INLINE_WHEN_PLAN_EXISTS\n",
    );
    fs.writeFileSync(store.paths.planMd(card.id), "1. 改 src/app.ts\n");

    const r1 = buildHandoffPayload({
      store,
      card,
      runId: "run-1-aaa",
      runDirName: "001-implement",
      stage: "implement",
      round: 1,
      role: "worker",
      cwd: "/tmp/wt-b1",
      inputRef: "abc111",
      mcpEnabled: true,
    });

    store.appendStateEvent(card.id, {
      type: "steered",
      at: now,
      steer_id: "steer-1",
      message: "请额外保留注释",
      interrupt: false,
      contract_version: 1,
      stage: "implement",
    });

    const r2 = buildHandoffPayload({
      store,
      card,
      runId: "run-2-bbb",
      runDirName: "002-implement",
      stage: "implement",
      round: 2,
      role: "worker",
      cwd: "/tmp/wt-b1",
      inputRef: "def222",
      mcpEnabled: true,
      previousFailureSummary: "accept_exit_code=1",
    });

    // Layer 0+1+2 prefix is byte-for-byte identical despite changing runId, round, inputRef, failure delta, and steer!
    expect(r1.stablePrefix).toBe(r2.stablePrefix);
    expect(r1.dynamicTail).toContain("run-1-aaa");
    expect(r2.dynamicTail).toContain("run-2-bbb");
    expect(r2.dynamicTail).toContain("accept_exit_code=1");
    expect(r2.dynamicTail).toContain("请额外保留注释");

    // Progressive disclosure: RESEARCH.md is projected as path pointer when PLAN.md exists
    expect(r1.stablePrefix).not.toContain(
      "SECRET_RAW_RESEARCH_BODY_DO_NOT_INLINE_WHEN_PLAN_EXISTS",
    );
    expect(r1.stablePrefix).toContain(store.paths.researchMd(card.id));
    expect(r1.stablePrefix).toContain("1. 改 src/app.ts");

    // Plan directive differentiates L2 multi-option exploration vs L1 single-plan
    const planL2 = buildHandoffPayload({
      store,
      card,
      runId: "run-plan-l2",
      runDirName: "000-plan",
      stage: "plan",
      round: 1,
      role: "advisor",
      cwd: "/tmp/wt-b1",
      mcpEnabled: true,
    });
    expect(planL2.dynamicTail).toContain("2–3 条可行实现路线");

    const planL1 = buildHandoffPayload({
      store,
      card: { ...card, track: "L1" },
      runId: "run-plan-l1",
      runDirName: "000-plan",
      stage: "plan",
      round: 1,
      role: "advisor",
      cwd: "/tmp/wt-b1",
      mcpEnabled: true,
    });
    expect(planL1.dynamicTail).toContain("L1 轻量任务：直接收敛给出唯一清晰");

    // Receipt template inside Layer 0 remains schema-valid
    const tplMatch = /```markdown\n([\s\S]*?)\n```/.exec(r1.stablePrefix);
    expect(tplMatch).not.toBeNull();
    expect(parseAndValidateReceipt("worker", tplMatch![1]!).ok).toBe(true);
    store.close();
  });

  it("B2 & B3: reuses warm implement session via send() with sessionKey token, forces cold restart on >=60% context or >=2 same failures, and survives rebuild()", async () => {
    const kilnHome = makeTempDir("kiln-b2-home-");
    const { repoPath, baseCommit } = initGitRepo("b2");
    const acceptCmd =
      "node -e \"const fs=require('fs'); process.exit(fs.readFileSync('src/app.ts','utf8').includes('42')?0:1)\"";
    const snap = computeFrozenSnapshot(repoPath, [], acceptCmd);
    const fakeBackend = makeWarmCapableBackend();

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "track1-warm-session-secret-0123456789",
      approvalHandler: async (req, ctx) => {
        const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
        // Notice: when warm session is reused, round 2 has the SAME MCP token from round 1 (which carries sessionKey),
        // and wb_get_context dynamically resolves the new active runId!
        const firstSpec = fakeBackend
          .getRecordedSpecs()
          .find((s) => s.taskId === ctx.taskId && s.role === ctx.role);
        const token = firstSpec?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";

        if (req.action === "warm_r1_fail") {
          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), "export const v = 2;\n");
          const res = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: baseCommit,
                output_ref: "HEAD",
                changed_paths: ["src/app.ts"],
              }),
            }),
          });
          expect(res.status).toBe(200);
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "warm_r2_send_pass") {
          // Verify wb_get_context resolves NEW active run_id through the original session-scoped token!
          const ctxRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_get_context",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({}),
          });
          expect(ctxRes.status).toBe(200);
          const resolvedRunId = (ctxRes.body as { runId: string }).runId;
          expect(resolvedRunId).toBe(ctx.runId);

          // Submitting with STALE run_id on the same sessionKey token MUST be rejected with 400!
          const staleSub = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: firstSpec!.runId,
                contract_version: ctx.card.contract_version,
                input_ref: baseCommit,
                output_ref: "HEAD",
                changed_paths: ["src/app.ts"],
              }),
            }),
          });
          expect(staleSub.status).toBe(400);

          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), "export const v = 42;\n");
          const okSub = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: resolvedRunId,
                contract_version: ctx.card.contract_version,
                input_ref: baseCommit,
                output_ref: "HEAD",
                changed_paths: ["src/app.ts"],
              }),
            }),
          });
          expect(okSub.status).toBe(200);
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "warm_reviewer") {
          const revRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeReviewerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                reviewed_ref: "HEAD",
                verdict: "pass",
              }),
            }),
          });
          expect(revRes.status).toBe(200);
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "wm_high_ctx_fail") {
          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), "export const v = 3;\n");
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: baseCommit,
                output_ref: "HEAD",
                changed_paths: ["src/app.ts"],
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "wm_cold_after_ctx_pass") {
          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), "export const v = 42;\n");
          const specLatest = fakeBackend
            .getRecordedSpecs()
            .filter((s) => s.taskId === ctx.taskId)
            .at(-1)!;
          const freshToken = specLatest.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${freshToken}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: baseCommit,
                output_ref: "HEAD",
                changed_paths: ["src/app.ts"],
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
        }
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    server.store.writeSpace({
      schema_version: 1,
      id: "kiln",
      name: "Kiln",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    server.store.writeConfig("roster", makeBaseRoster());
    server.store.writeConfig("limits", defaultLimits());

    // Task 1: t-warm-ok (r1 fails gate with 30% context -> r2 uses send() -> review cold -> done)
    fakeBackend.enqueueScript(
      [
        {
          kind: "context_window",
          usedTokens: 30_000,
          contextWindowTokens: 100_000,
          percent: 30,
        },
        {
          kind: "usage",
          turnId: "turn-w-1",
          inputTokens: 10_000,
          cachedInputTokens: 2_000,
          outputTokens: 500,
        },
        { kind: "approval", action: "warm_r1_fail", detail: "r1" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-warm-ok", turnNumber: 1 },
    );
    fakeBackend.enqueueScript(
      [
        {
          kind: "usage",
          turnId: "turn-w-2",
          inputTokens: 10_000,
          cachedInputTokens: 9_000,
          outputTokens: 400,
        },
        { kind: "approval", action: "warm_r2_send_pass", detail: "r2" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-warm-ok", turnNumber: 2 },
    );
    fakeBackend.enqueueScript(
      [
        {
          kind: "usage",
          turnId: "turn-rev-1",
          inputTokens: 8_000,
          cachedInputTokens: 0,
          outputTokens: 300,
        },
        { kind: "approval", action: "warm_reviewer", detail: "rev" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-warm-ok", role: "reviewer" },
    );

    const now = new Date().toISOString();
    const card1: TaskCard = {
      schema_version: 1,
      id: "t-warm-ok",
      title: "热会话续跑验证",
      space: "kiln",
      priority: "P1",
      track: "L2",
      workspace_mode: "git_worktree",
      parent: null,
      depends_on: [],
      contract_version: 1,
      contract: {
        goal: "热会话重试并审过",
        end: "合并 main",
        accept_cmd: acceptCmd,
        accept_files_hash: snap.hash,
        scope: ["src/**"],
        deliver: { mode: "merge_main", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: {
        retries_per_stage: 2,
        review_rounds: 2,
        advisor_calls: 1,
        max_tokens: 5_000_000,
      },
      created_at: now,
      updated_at: now,
    };

    server.stateMachine.createTask(card1, "# Warm reuse");
    await server.start();

    await waitUntil(
      () => server.store.getTaskIndex("t-warm-ok")?.status === "done",
      "t-warm-ok done",
    );

    // Worker ran start() ONCE and send() ONCE (delta dynamicTail only); reviewer ALWAYS ran start() (freshContext: true)
    const warmWorkerSpecs = fakeBackend
      .getRecordedSpecs()
      .filter((s) => s.taskId === "t-warm-ok" && s.role === "worker");
    const warmReviewerSpecs = fakeBackend
      .getRecordedSpecs()
      .filter((s) => s.taskId === "t-warm-ok" && s.role === "reviewer");
    expect(warmWorkerSpecs).toHaveLength(1);
    expect(warmReviewerSpecs).toHaveLength(1);
    expect(warmReviewerSpecs[0]!.freshContext).toBe(true);

    const recordedSends = fakeBackend.getRecordedSends();
    expect(recordedSends).toHaveLength(1);
    expect(recordedSends[0]!.message).toContain("热会话续跑 · 继承自");
    expect(recordedSends[0]!.message).toContain("上轮门禁失败摘要");

    const run1Meta = readYamlOptional(
      server.store.paths.runYaml("t-warm-ok", "001-implement"),
      RunMetaSchema,
    );
    const run2Meta = readYamlOptional(
      server.store.paths.runYaml("t-warm-ok", "002-implement"),
      RunMetaSchema,
    );
    expect(run1Meta?.session_reused).toBeUndefined();
    expect(run2Meta?.session_reused).toBe(true);
    expect(run2Meta?.parent_run_id).toBe(run1Meta?.run_id);

    // Task 2: t-cold-ctx (65% context watermark forces cold start on round 2!)
    fakeBackend.enqueueScript(
      [
        {
          kind: "context_window",
          usedTokens: 65_000,
          contextWindowTokens: 100_000,
          percent: 65,
        },
        { kind: "approval", action: "wm_high_ctx_fail", detail: "ctx-r1" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-cold-ctx" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "wm_cold_after_ctx_pass", detail: "ctx-r2" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-cold-ctx" },
    );
    server.stateMachine.createTask(
      {
        ...card1,
        id: "t-cold-ctx",
        title: "高水位强制冷启验证",
        track: "L1",
      },
      "# Context watermark cold fallback",
    );
    await server.orchestrator.wake();
    await waitUntil(
      () => server.store.getTaskIndex("t-cold-ctx")?.status === "done",
      "t-cold-ctx done",
    );
    const coldCtxWorkerSpecs = fakeBackend
      .getRecordedSpecs()
      .filter((s) => s.taskId === "t-cold-ctx" && s.role === "worker");
    expect(coldCtxWorkerSpecs).toHaveLength(2);
    // Still only 1 send() overall!
    expect(fakeBackend.getRecordedSends()).toHaveLength(1);

    // Verify usage_turns + computeUsageSnapshot stage/warm observability AND survival across rebuildIndexFromDisk()
    await server.stop();
    const sqliteFile = path.join(kilnHome, "index.sqlite");
    fs.rmSync(sqliteFile, { force: true });
    fs.rmSync(`${sqliteFile}-wal`, { force: true });
    fs.rmSync(`${sqliteFile}-shm`, { force: true });

    const rebuiltStore = new KilnStore({ kilnHome });
    rebuiltStore.rebuildIndexFromDisk();
    try {
      const rebuiltUsage = computeUsageSnapshot(rebuiltStore.listUsageTurns(), null);
      expect(rebuiltUsage.byStage?.implement).toMatchObject({
        runCount: 2,
        reusedRunCount: 1,
      });
      expect(rebuiltUsage.byStage?.review).toMatchObject({
        runCount: 1,
        reusedRunCount: 0,
      });
      expect(rebuiltUsage.byRosterRole?.main_dev?.reusedRunCount).toBe(1);
      expect(rebuiltUsage.warmSessionStats).toEqual({
        totalImplementRuns: 2,
        reusedImplementRuns: 1,
        warmCacheHitRate: 90,
        coldCacheHitRate: 20,
      });
    } finally {
      rebuiltStore.close();
    }
  });

  it("matches WarmSessionPool by stepIndex, stepLabel, and customInstructions and reuses labeled workflow implement steps", async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "kiln-warm-step-"));
    tempDirs.push(repoDir);
    const pool = new WarmSessionPool();
    const dummyBackend = new FakeBackend({ defaultTurnScript: [] });

    pool.park(
      {
        taskId: "t-step-pool",
        sessionRef: { backendId: "fake", sessionId: "s-step-1" },
        sessionKey: "sk-1",
        backend: dummyBackend,
        backendId: "fake",
        agent: "codex",
        model: "gpt-5.4",
        cwd: repoDir,
        rosterRoleId: "ops_sec",
        contractVersion: 1,
        stepIndex: 0,
        stepLabel: "扫描残留并暂存",
        customInstructions: "仅写入 staged/",
        lastRunId: "r-1",
        reuseCount: 0,
        lastContextPercent: 10,
        lastUsedAtMs: Date.now(),
      },
      300_000,
    );

    const mismatched = pool.takeMatching({
      taskId: "t-step-pool",
      backendId: "fake",
      agent: "codex",
      model: "gpt-5.4",
      cwd: repoDir,
      rosterRoleId: "ops_sec",
      contractVersion: 1,
      stepIndex: 0,
      stepLabel: "另一个步骤名称",
      customInstructions: "仅写入 staged/",
    });
    expect(mismatched).toBeNull();

    pool.park(
      {
        taskId: "t-step-pool",
        sessionRef: { backendId: "fake", sessionId: "s-step-2" },
        sessionKey: "sk-2",
        backend: dummyBackend,
        backendId: "fake",
        agent: "codex",
        model: "gpt-5.4",
        cwd: repoDir,
        rosterRoleId: "ops_sec",
        contractVersion: 1,
        stepIndex: 0,
        stepLabel: "扫描残留并暂存",
        customInstructions: "仅写入 staged/",
        lastRunId: "r-2",
        reuseCount: 0,
        lastContextPercent: 10,
        lastUsedAtMs: Date.now(),
      },
      300_000,
    );

    const matched = pool.takeMatching({
      taskId: "t-step-pool",
      backendId: "fake",
      agent: "codex",
      model: "gpt-5.4",
      cwd: repoDir,
      rosterRoleId: "ops_sec",
      contractVersion: 1,
      stepIndex: 0,
      stepLabel: "扫描残留并暂存",
      customInstructions: "仅写入 staged/",
    });
    expect(matched?.sessionRef.sessionId).toBe("s-step-2");

    // End-to-end: host_scoped workflow implement step with label & instructions reuses warm session on round 2 rework
    const kilnHome = fs.mkdtempSync(path.join(os.tmpdir(), "kiln-warm-labeled-e2e-"));
    tempDirs.push(kilnHome);
    const targetFile = path.join(repoDir, "cleanup-note.txt");

    let implTurn = 0;
    const fakeBackend = makeWarmCapableBackend();

    const server = new KilndServer({
      kilnHome,
      host: "127.0.0.1",
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "track1-labeled-warm-secret-0123456789",
      approvalHandler: async (req, ctx) => {
        const specs = fakeBackend.getRecordedSpecs().filter((s) => s.taskId === ctx.taskId);
        const tokenSpec =
          ctx.role === "worker"
            ? specs.find((s) => s.role === "worker")
            : specs.filter((s) => s.role === ctx.role).at(-1);
        const token = tokenSpec?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";
        const stagedDir = server.store.paths.stagedDir(ctx.taskId);
        fs.mkdirSync(stagedDir, { recursive: true });

        if (req.action === "impl_r1_fail_rev") {
          implTurn += 1;
          fs.writeFileSync(path.join(stagedDir, "cleanup-note.txt"), "draft v1\n");
          const res = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: serializeFrontmatterMarkdown(
                {
                  run_id: ctx.runId,
                  contract_version: ctx.card.contract_version,
                  outcome: "completed",
                  input_ref: "host_scoped",
                  output_ref: stagedDir,
                  changed_paths: [targetFile],
                  accept_result: "skipped",
                  is_bugfix: false,
                  complexity_escalate: false,
                },
                "## 改动说明\n初版暂存\n\n## 验证命令与真实输出\nok\n\n## 未完成或待决问题\n无\n",
              ),
            }),
          });
          expect(res.status).toBe(200);
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "rev_r1_reject") {
          const res = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: serializeFrontmatterMarkdown(
                {
                  run_id: ctx.runId,
                  contract_version: ctx.card.contract_version,
                  reviewed_ref: stagedDir,
                  verdict: "changes_requested",
                  p0: 0,
                  p1: 1,
                  p2: 0,
                },
                "## 结论\n退回修复\n\n## 缺陷清单\n1. P1 · 修复字段\n\n## 测试真实性与复现核查\nok\n",
              ),
            }),
          });
          expect(res.status).toBe(200);
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "impl_r2_warm_fix") {
          implTurn += 1;
          fs.writeFileSync(path.join(stagedDir, "cleanup-note.txt"), "fixed v2\n");
          const res = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: serializeFrontmatterMarkdown(
                {
                  run_id: ctx.runId,
                  contract_version: ctx.card.contract_version,
                  outcome: "completed",
                  input_ref: "host_scoped",
                  output_ref: stagedDir,
                  changed_paths: [targetFile],
                  accept_result: "skipped",
                  is_bugfix: false,
                  complexity_escalate: false,
                },
                "## 改动说明\n热会话修复\n\n## 验证命令与真实输出\nok\n\n## 未完成或待决问题\n无\n",
              ),
            }),
          });
          expect(res.status).toBe(200);
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "rev_r2_pass") {
          const res = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeReviewerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                reviewed_ref: stagedDir,
                verdict: "pass",
              }),
            }),
          });
          expect(res.status).toBe(200);
          await ctx.backend.answer(req.id, true);
        }
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    server.store.writeConfig("roles", {
      schema_version: 1,
      heterogeneous_review: false,
      roles: {
        worker: {
          backend_id: "fake",
          agent: "codex",
          model: "gpt-5.4",
          allow_full_access_fallback: false,
        },
        reviewer: {
          backend_id: "fake",
          agent: "codex",
          model: "gpt-5.4",
          allow_full_access_fallback: false,
        },
      },
    });

    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "impl_r1_fail_rev", detail: "r1" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-labeled-warm", turnNumber: 1 },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "impl_r2_warm_fix", detail: "r2" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-labeled-warm", turnNumber: 2 },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "rev_r1_reject", detail: "rev1" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-labeled-warm", role: "reviewer" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "rev_r2_pass", detail: "rev2" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-labeled-warm", role: "reviewer" },
    );

    const now = new Date().toISOString();
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-labeled-warm",
        title: "带步骤标签的热会话复用",
        space: "local",
        priority: "P2",
        track: "L2",
        workspace_mode: "host_scoped",
        parent: null,
        depends_on: [],
        workflow: {
          schema_version: 1,
          preset: "host_op",
          steps: [
            {
              kind: "loop",
              max_rounds: 2,
              stuck_threshold: 2,
              steps: [
                {
                  kind: "agent",
                  label: "只读扫描并暂存",
                  stage: "implement",
                  role: "worker",
                  fresh_context: false,
                  mode: "dry_run_only",
                  instructions: "仅写入 staged/",
                },
                { kind: "gate", stage: "verify", check: "staged_only" },
                {
                  kind: "agent",
                  label: "独立复核",
                  stage: "review",
                  role: "reviewer",
                  fresh_context: true,
                },
              ],
            },
            {
              kind: "approval",
              stage: "deliver",
              show: ["staged_diff", "sha256"],
            },
            {
              kind: "command",
              stage: "deliver",
              apply_staged: true,
              run_deliver_cmd: false,
              verify_sha256: true,
              final_accept_gate: true,
            },
          ],
        },
        contract_version: 1,
        contract: {
          goal: "生成暂存备注",
          end: "审批落盘",
          accept_cmd: `grep -q fixed ${targetFile}`,
          accept_files_hash: "sha256:init",
          scope: [targetFile],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: {
          retries_per_stage: 2,
          review_rounds: 2,
          advisor_calls: 0,
          max_tokens: 5_000_000,
        },
        created_at: now,
        updated_at: now,
      },
      "# Labeled warm reuse",
    );

    await server.start();
    await waitUntil(
      () => server.store.getTaskIndex("t-labeled-warm")?.status === "waiting",
      "t-labeled-warm waiting for deliver approval",
    );
    expect(implTurn).toBe(2);
    expect(
      fakeBackend
        .getRecordedSpecs()
        .filter((s) => s.taskId === "t-labeled-warm" && s.role === "worker"),
    ).toHaveLength(1);
    expect(fakeBackend.getRecordedSends()).toHaveLength(1);
    const impl2Meta = readYamlOptional(
      server.store.paths.runYaml("t-labeled-warm", "003-implement"),
      RunMetaSchema,
    );
    expect(impl2Meta?.session_reused).toBe(true);
  });
});
