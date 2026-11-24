import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RosterConfigSchema,
  RunMetaSchema,
  buildWorkflowPreset,
  createDefaultBuiltinRosterMetadata,
  serializeFrontmatterMarkdown,
  type CardLimits,
  type LimitsConfig,
  type RosterConfig,
  type TaskCard,
} from "@kiln/protocol";
import { FakeBackend } from "../../backend/index.js";
import { computeFrozenSnapshot } from "../../gate/index.js";
import { readYamlOptional, writeFileAtomic } from "../../store/index.js";
import { KilndServer } from "../index.js";

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

function initTempGitRepo(baseDir: string, name: string): string {
  const repoDir = path.join(baseDir, name);
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.name", "Kiln Test"], repoDir);
  git(["config", "user.email", "kiln-test@example.com"], repoDir);
  fs.writeFileSync(path.join(repoDir, "src", "app.ts"), "export const status = 'init';\n", "utf8");
  fs.writeFileSync(
    path.join(repoDir, "src", "shared.ts"),
    "export const line1 = 'base';\nexport const line2 = 'base';\n",
    "utf8",
  );
  git(["add", "."], repoDir);
  git(["commit", "-m", "initial commit"], repoDir);
  return fs.realpathSync(repoDir);
}

function makeWorkerReceiptMarkdown(fields: {
  run_id: string;
  contract_version: number;
  input_ref: string;
  output_ref: string;
  changed_paths: string[];
  complexity_escalate?: boolean;
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
      complexity_escalate: fields.complexity_escalate ?? false,
    },
    [
      "## 改动说明\n完成实现\n",
      "## 验证命令与真实输出\nexit code 0\n",
      "## 未完成或待决问题\n无\n",
    ].join("\n"),
  );
}

function makeAdvisorReceiptMarkdown(fields: { run_id: string; contract_version: number }): string {
  return serializeFrontmatterMarkdown(
    {
      run_id: fields.run_id,
      contract_version: fields.contract_version,
      outcome: "resolved",
      chosen_approach: "按标准接口修改 src/shared.ts 并保留现有基线",
      decision_kind: "plan",
      requires_contract_change: false,
      requires_scope_expansion: false,
      requires_human_approval: false,
    },
    [
      "## 技术取舍\n按标准接口实现并保留现有基线即可。\n",
      "## 授权裁决\n- 不涉及契约或作用域扩张，直接推进实现与验证。\n",
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
    ["## 结论\n审查通过\n", "## 缺陷清单\n无\n", "## 测试真实性与复现核查\n真实核验通过\n"].join(
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

function makeMultiProviderFakeBackend(): FakeBackend {
  return new FakeBackend({
    backendId: "fake",
    agents: [
      {
        id: "pi",
        label: "Pi Economy",
        capabilities: {
          interactiveChat: true,
          approvals: true,
          mcpInjection: false,
          usageCacheBreakdown: true,
          interrupt: true,
          warmSessionReuse: true,
        },
        modes: [{ id: "auto", label: "Auto" }],
        defaultModeId: "auto",
      },
      {
        id: "claude",
        label: "Claude Flagship",
        capabilities: {
          interactiveChat: true,
          approvals: true,
          mcpInjection: false,
          usageCacheBreakdown: true,
          interrupt: true,
          warmSessionReuse: true,
        },
        modes: [{ id: "default", label: "Default" }],
        defaultModeId: "default",
      },
      {
        id: "codex",
        label: "Codex Main",
        capabilities: {
          interactiveChat: true,
          approvals: true,
          mcpInjection: false,
          usageCacheBreakdown: true,
          interrupt: true,
          warmSessionReuse: true,
        },
        modes: [{ id: "auto", label: "Auto" }],
        defaultModeId: "auto",
      },
      {
        id: "agy",
        label: "Agy Third",
        capabilities: {
          interactiveChat: true,
          approvals: true,
          mcpInjection: false,
          usageCacheBreakdown: true,
          interrupt: true,
          warmSessionReuse: true,
        },
        modes: [{ id: "auto", label: "Auto" }],
        defaultModeId: "auto",
      },
    ],
    models: {
      pi: [
        { id: "fast-scout", label: "fast-scout", thinkingOptions: [] },
        { id: "fast-exec", label: "fast-exec", thinkingOptions: [] },
      ],
      claude: [
        { id: "claude-opus-4-6", label: "claude-opus-4-6", thinkingOptions: [] },
        { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6", thinkingOptions: [] },
      ],
      codex: [{ id: "gpt-5.4", label: "gpt-5.4", thinkingOptions: [] }],
      agy: [{ id: "gemini-2.5-pro", label: "gemini-2.5-pro", thinkingOptions: [] }],
    },
  });
}

describe("Track 2: B4 intake recon, B5 PLAN-driven fast_fix & auto-escalation, B6 dual heterogeneity & on_conflict deliverer", () => {
  const cleanupDirs: string[] = [];
  const servers: KilndServer[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await s.stop().catch(() => {});
    }
    for (const dir of cleanupDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeLimits(overrides?: Partial<LimitsConfig>): LimitsConfig {
    return {
      schema_version: 1,
      max_concurrent_slots: 3,
      p0_extra_slot: true,
      max_waiting_wip: 5,
      retries_per_stage: 4,
      review_rounds: 2,
      advisor_calls: 1,
      max_card_tokens: 5_000_000,
      ...overrides,
    };
  }

  function makeCardLimits(overrides?: Partial<CardLimits>): CardLimits {
    return {
      retries_per_stage: 4,
      review_rounds: 2,
      advisor_calls: 1,
      max_tokens: 5_000_000,
      ...overrides,
    };
  }

  function makeRoster(overrides?: Partial<RosterConfig["roster"]>): RosterConfig {
    const seed = createDefaultBuiltinRosterMetadata();
    return RosterConfigSchema.parse({
      schema_version: 2,
      heterogeneous_review: true,
      pm_orchestration: {
        enabled: true,
        allow_auto_tester: false,
        prefer_unthrottled: true,
        require_review_for_core: true,
        intake_auto_recon: true,
        plan_prefers_fast_exec: true,
      },
      roster: {
        ...seed,
        pm: {
          ...seed.pm,
          enabled: true,
          primary: {
            provider: "claude",
            model: "claude-opus-4-6",
            effort: "high",
            backend_id: "fake",
          },
        },
        researcher: {
          ...seed.researcher,
          enabled: true,
          primary: { provider: "pi", model: "fast-scout", effort: "low", backend_id: "fake" },
        },
        advisor: {
          ...seed.advisor,
          enabled: true,
          primary: {
            provider: "claude",
            model: "claude-opus-4-6",
            effort: "high",
            backend_id: "fake",
          },
        },
        fast_fix: {
          ...seed.fast_fix,
          enabled: true,
          primary: { provider: "pi", model: "fast-exec", effort: "low", backend_id: "fake" },
        },
        main_dev: {
          ...seed.main_dev,
          enabled: true,
          primary: { provider: "codex", model: "gpt-5.4", effort: "high", backend_id: "fake" },
        },
        reviewer: {
          ...seed.reviewer,
          enabled: true,
          avoid_same_as: ["implement", "plan"],
          primary: { provider: "codex", model: "gpt-5.4", effort: "high", backend_id: "fake" },
          fallbacks: [
            { provider: "claude", model: "claude-opus-4-6", effort: "high", backend_id: "fake" },
            { provider: "agy", model: "gemini-2.5-pro", effort: "high", backend_id: "fake" },
          ],
        },
        deliverer: {
          ...seed.deliverer,
          enabled: true,
          mode: "on_conflict",
          primary: { provider: "codex", model: "gpt-5.4", effort: "medium", backend_id: "fake" },
        },
        ...overrides,
      },
    });
  }

  it("B4: runs user-configured researcher before PM intake, injects draft RESEARCH.md into PM prompt, inherits to committed cards, and skips disabled post-commit research", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kiln-t2-b4-"));
    cleanupDirs.push(tmp);
    const kilnHome = path.join(tmp, "home");
    const repoPath = initTempGitRepo(tmp, "repo");
    const acceptCmd = "node -e \"console.log('ok')\"";
    const snap = computeFrozenSnapshot(repoPath, [], acceptCmd);

    const fakeBackend = makeMultiProviderFakeBackend();
    fakeBackend.enqueueScript(
      [
        {
          kind: "message",
          delta: false,
          text: [
            "## 项目环境与运行基线\nNode/TS 仓库，默认分支 main",
            "## 相关文件与精确符号\n- `src/app.ts`: export const status",
            "## 现有调用链与约束\n- 严格单写者作用域 src/**",
            "## 可用验收命令与风险点\n- `node -e \"console.log('ok')\"`",
          ].join("\n\n"),
        },
        { kind: "exit", reason: "completed" },
      ],
      (ctx) => ctx.runSpec.runId.startsWith("recon-"),
    );
    fakeBackend.enqueueScript(
      [
        {
          kind: "message",
          delta: false,
          text: '已收到前置侦察，方案如下：\n```kiln-draft-patch\n{"title":"更新状态","open_questions":[]}\n```',
        },
        { kind: "exit", reason: "completed" },
      ],
      { role: "intake" },
    );

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "track2-b4-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        if (req.action === "skip_impl") {
          const wt = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
          fs.writeFileSync(path.join(wt, "src", "app.ts"), "export const status = 'skip-ok';\n");
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, "001-implement"),
            makeWorkerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: "HEAD",
              output_ref: "src/app.ts",
              changed_paths: ["src/app.ts"],
            }),
          );
          await ctx.backend.answer(req.id, true);
        }
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    server.store.writeSpace({
      schema_version: 1,
      id: "proj",
      name: "Proj",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    server.store.writeConfig("limits", makeLimits());
    server.store.writeConfig("roster", makeRoster());

    const createDraftRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Kiln-Client": "web" },
        body: JSON.stringify({
          id: "d-b4",
          space: "proj",
          title: "状态更新需求",
        }),
      }),
    );
    expect(createDraftRes.status).toBe(201);

    const chatRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-b4/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Kiln-Client": "web" },
        body: JSON.stringify({ message: "帮我看看怎么改 src/app.ts" }),
      }),
    );
    expect(chatRes.status).toBe(200);
    const chatJson = (await chatRes.json()) as {
      research_markdown?: string;
      draft: { title: string };
    };
    expect(chatJson.research_markdown).toContain("## 相关文件与精确符号");
    expect(server.store.readDraftResearch("d-b4")).toContain("src/app.ts");

    const specs = fakeBackend.getRecordedSpecs();
    expect(specs).toHaveLength(2);
    expect(specs[0]!.agent).toBe("pi");
    expect(specs[0]!.model).toBe("fast-scout");
    expect(specs[0]!.readOnly).toBe(true);
    expect(specs[1]!.role).toBe("intake");
    expect(specs[1]!.agent).toBe("claude");
    expect(specs[1]!.systemPrompt).toContain("前置侦察简报 (RESEARCH.md");
    expect(specs[1]!.systemPrompt).toContain("src/app.ts");

    // Commit draft -> task inherits RESEARCH.md cleanly
    const commitRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-b4/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Kiln-Client": "web" },
        body: JSON.stringify({
          id: "t-b4-single",
          title: "B4 单卡继承",
          space: "proj",
          priority: "P2",
          track: "L2",
          workspace_mode: "git_worktree",
          contract: {
            goal: "更新状态",
            end: "status 更新完成",
            accept_cmd: acceptCmd,
            accept_files_hash: snap.hash,
            scope: ["src/**"],
            deliver: { mode: "merge_main", cmd: null },
            human_accept: false,
            external_actions: "ask",
          },
          brief_markdown: "# B4 Brief",
        }),
      }),
    );
    expect(commitRes.status).toBe(201);
    const inheritedResearch = fs.readFileSync(server.store.paths.researchMd("t-b4-single"), "utf8");
    expect(inheritedResearch).toContain("src/app.ts");
    // Cancel single inherited task before testing disabled-research skip flow
    server.stateMachine.cancelTask("t-b4-single", "verified inheritance");

    // Disable researcher + reviewer and verify post-commit workflow `research -> implement` skips gracefully
    const baseRoster = makeRoster();
    baseRoster.roster.researcher = {
      ...baseRoster.roster.researcher!,
      enabled: false,
    };
    server.store.writeConfig("roster", baseRoster);

    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "skip_impl", detail: "skip" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-b4-skip", role: "worker" },
    );

    const wfWithResearch = buildWorkflowPreset("quick", {
      includeResearch: true,
      includePlan: false,
    });
    const now = new Date().toISOString();
    const skipCard: TaskCard = {
      schema_version: 1,
      id: "t-b4-skip",
      title: "Skip disabled research",
      space: "proj",
      priority: "P1",
      track: "L1",
      workspace_mode: "git_worktree",
      parent: null,
      depends_on: [],
      workflow: wfWithResearch,
      contract_version: 1,
      contract: {
        goal: "skip disabled research cleanly",
        end: "status updated",
        accept_cmd: acceptCmd,
        accept_files_hash: snap.hash,
        scope: ["src/**"],
        deliver: { mode: "merge_main", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: makeCardLimits(),
      created_at: now,
      updated_at: now,
    };
    server.stateMachine.createTask(skipCard, "# Skip research");
    await server.start();

    await waitUntil(
      () => server.store.getTaskIndex("t-b4-skip")?.status === "done",
      "t-b4-skip done",
    );
    const skipRuns = fs.readdirSync(server.store.paths.runsDir("t-b4-skip"));
    expect(skipRuns.some((d) => d.includes("research"))).toBe(false);
    expect(skipRuns.some((d) => d.includes("implement"))).toBe(true);
  });

  it("B5: starts on fast_fix when PLAN.md exists, deterministically cold-escalates to main_dev after 2 gate failures, and survives rebuildIndexFromDisk", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kiln-t2-b5-"));
    cleanupDirs.push(tmp);
    const kilnHome = path.join(tmp, "home");
    const repoPath = initTempGitRepo(tmp, "repo");
    const acceptCmd =
      "node -e \"const fs=require('fs'); if(!fs.readFileSync('src/app.ts','utf8').includes('fixed')) process.exit(1)\"";
    const snap = computeFrozenSnapshot(repoPath, [], acceptCmd);
    const fakeBackend = makeMultiProviderFakeBackend();

    let implDirSeq = 0;
    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "track2-b5-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        implDirSeq += 1;
        const dirName = `00${implDirSeq}-implement`;
        const wt = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
        if (req.action === "b5_fast_fail") {
          fs.writeFileSync(
            path.join(wt, "src", "app.ts"),
            `export const status = 'broken-${implDirSeq}';\n`,
          );
        } else if (req.action === "b5_main_fix") {
          const handoffText = fs.readFileSync(
            server.store.paths.handoffMd(ctx.taskId, dirName),
            "utf8",
          );
          expect(handoffText).toContain("模型升档接盘摘要 (由 fast_fix 升档至 main_dev)");
          fs.writeFileSync(path.join(wt, "src", "app.ts"), "export const status = 'fixed';\n");
        }
        writeFileAtomic(
          server.store.paths.receiptMd(ctx.taskId, dirName),
          makeWorkerReceiptMarkdown({
            run_id: ctx.runId,
            contract_version: ctx.card.contract_version,
            input_ref: "HEAD",
            output_ref: "src/app.ts",
            changed_paths: ["src/app.ts"],
          }),
        );
        await ctx.backend.answer(req.id, true);
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    server.store.writeSpace({
      schema_version: 1,
      id: "proj",
      name: "Proj",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    server.store.writeConfig("limits", makeLimits({ retries_per_stage: 4 }));
    server.store.writeConfig("roster", makeRoster());

    // Round 1 & 2 on fast_fix (pi/fast-exec): fail verify twice; Round 3 cold-escalated to main_dev (codex/gpt-5.4)
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "b5_fast_fail", detail: "r1" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-b5-esc", agent: "pi", turnNumber: 1 },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "b5_fast_fail", detail: "r2" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-b5-esc", agent: "pi", turnNumber: 2 },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "b5_main_fix", detail: "r3" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-b5-esc", agent: "codex" },
    );

    const now = new Date().toISOString();
    const card: TaskCard = {
      schema_version: 1,
      id: "t-b5-esc",
      title: "B5 Escalation",
      space: "proj",
      priority: "P1",
      track: "L1",
      workspace_mode: "git_worktree",
      parent: null,
      depends_on: [],
      workflow: buildWorkflowPreset("quick"),
      contract_version: 1,
      contract: {
        goal: "由 fast_fix 起始，连败两次自动升档 main_dev",
        end: "app.ts contains fixed",
        accept_cmd: acceptCmd,
        accept_files_hash: snap.hash,
        scope: ["src/**"],
        deliver: { mode: "merge_main", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: makeCardLimits({ retries_per_stage: 4 }),
      created_at: now,
      updated_at: now,
    };
    server.stateMachine.createTask(card, "# B5 Brief");
    writeFileAtomic(
      server.store.paths.planMd("t-b5-esc"),
      "# Plan\n1. Update src/app.ts to fixed\n",
    );
    await server.start();

    await waitUntil(
      () => server.store.getTaskIndex("t-b5-esc")?.status === "done",
      "t-b5-esc done",
    );

    const implSpecs = fakeBackend
      .getRecordedSpecs()
      .filter((s) => s.taskId === "t-b5-esc" && s.role === "worker");
    // Round 1 fast_fix start() + Round 2 warm send() + Round 3 escalated main_dev cold start()
    expect(implSpecs).toHaveLength(2);
    expect(implSpecs[0]!.agent).toBe("pi");
    expect(implSpecs[1]!.agent).toBe("codex");
    expect(implSpecs[1]!.freshContext).toBe(true);
    expect(fakeBackend.getRecordedSends()).toHaveLength(1);

    const run3Meta = readYamlOptional(
      server.store.paths.runYaml("t-b5-esc", "003-implement"),
      RunMetaSchema,
    );
    expect(run3Meta?.roster_role).toBe("main_dev");
    expect(run3Meta?.escalated_from).toBe("fast_fix");

    server.store.rebuildIndexFromDisk();
    expect(server.store.getTaskIndex("t-b5-esc")?.status).toBe("done");
  });

  it("B6: enforces dual heterogeneity when avoiding both implement & plan, and handles deliverer on_conflict with mandatory post-conflict verify gate", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kiln-t2-b6-"));
    cleanupDirs.push(tmp);
    const kilnHome = path.join(tmp, "home");
    const repoPath = initTempGitRepo(tmp, "repo");
    const acceptCmd =
      "node -e \"const fs=require('fs'); const s=fs.readFileSync('src/shared.ts','utf8'); if(!s.includes('from-task')) process.exit(1)\"";
    const snap = computeFrozenSnapshot(repoPath, [], acceptCmd);
    const fakeBackend = makeMultiProviderFakeBackend();

    let mainConflictInjected = false;
    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "track2-b6-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        const wt = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
        const runDirs = fs.readdirSync(server.store.paths.runsDir(ctx.taskId)).filter((d) => {
          const meta = readYamlOptional(server.store.paths.runYaml(ctx.taskId, d), RunMetaSchema);
          return meta?.run_id === ctx.runId;
        });
        const runDir = runDirs[0]!;

        if (req.action === "b6_plan") {
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeAdvisorReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
            }),
          );
        } else if (req.action === "b6_implement") {
          fs.writeFileSync(
            path.join(wt, "src", "shared.ts"),
            "export const line1 = 'from-task';\nexport const line2 = 'base';\n",
            "utf8",
          );
          if (!mainConflictInjected) {
            mainConflictInjected = true;
            fs.writeFileSync(
              path.join(repoPath, "src", "shared.ts"),
              "export const line1 = 'from-main';\nexport const line2 = 'base';\n",
              "utf8",
            );
            fs.writeFileSync(path.join(repoPath, "README.md"), "# main update\n", "utf8");
            git(["add", "."], repoPath);
            git(["commit", "-m", "conflicting main commit"], repoPath);
          }
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeWorkerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: "HEAD",
              output_ref: "src/shared.ts",
              changed_paths: ["src/shared.ts"],
            }),
          );
        } else if (req.action === "b6_review") {
          const revHead = git(["rev-parse", "HEAD"], wt).trim();
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeReviewerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              reviewed_ref: revHead,
              verdict: "pass",
            }),
          );
        } else if (req.action === "b6_deliver_conflict") {
          const handoffText = fs.readFileSync(
            server.store.paths.handoffMd(ctx.taskId, runDir),
            "utf8",
          );
          expect(handoffText).toContain("合并冲突按需处理指令");
          try {
            git(["merge", "--no-commit", "--no-ff", "main"], wt);
          } catch {
            // Expected merge conflict on src/shared.ts
          }
          fs.writeFileSync(
            path.join(wt, "src", "shared.ts"),
            "export const line1 = 'from-task + from-main';\nexport const line2 = 'base';\n",
            "utf8",
          );
          git(["add", "src/shared.ts"], wt);
          git(["commit", "--no-edit"], wt);
          const headAfter = git(["rev-parse", "HEAD"], wt).trim();
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeWorkerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: headAfter,
              output_ref: headAfter,
              changed_paths: ["src/shared.ts"],
            }),
          );
        }
        await ctx.backend.answer(req.id, true);
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    server.store.writeSpace({
      schema_version: 1,
      id: "proj",
      name: "Proj",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    server.store.writeConfig("limits", makeLimits());

    const b6Roster = makeRoster();
    b6Roster.roster.fast_fix = {
      ...b6Roster.roster.fast_fix!,
      enabled: false,
    };
    server.store.writeConfig("roster", b6Roster);

    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "b6_plan", detail: "plan" },
        { kind: "exit", reason: "completed" },
      ],
      (ctx) => ctx.runSpec.runId.includes("-plan-"),
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "b6_implement", detail: "impl" },
        { kind: "exit", reason: "completed" },
      ],
      (ctx) => ctx.runSpec.runId.includes("-implement-"),
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "b6_review", detail: "review" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-b6-conflict", role: "reviewer" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "b6_deliver_conflict", detail: "deliver" },
        { kind: "exit", reason: "completed" },
      ],
      (ctx) => ctx.runSpec.runId.includes("-deliver-"),
    );

    const now = new Date().toISOString();
    const card: TaskCard = {
      schema_version: 1,
      id: "t-b6-conflict",
      title: "B6 Dual Hetero & On-Conflict Deliver",
      space: "proj",
      priority: "P1",
      track: "L2",
      workspace_mode: "git_worktree",
      parent: null,
      depends_on: [],
      workflow: buildWorkflowPreset("standard_dev", { includePlan: true }),
      contract_version: 1,
      contract: {
        goal: "验证双重异构审查与冲突按需交付并强制重过 verify",
        end: "shared.ts 合并成功并通过验收",
        accept_cmd: acceptCmd,
        accept_files_hash: snap.hash,
        scope: ["src/**"],
        deliver: { mode: "merge_main", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: makeCardLimits(),
      created_at: now,
      updated_at: now,
    };
    server.stateMachine.createTask(card, "# B6 Brief");
    await server.start();

    await waitUntil(
      () => server.store.getTaskIndex("t-b6-conflict")?.status === "done",
      "t-b6-conflict done",
    );

    const reviewRun = fs
      .readdirSync(server.store.paths.runsDir("t-b6-conflict"))
      .find((d) => d.includes("-review"));
    expect(reviewRun).toBeDefined();
    const reviewMeta = readYamlOptional(
      server.store.paths.runYaml("t-b6-conflict", reviewRun!),
      RunMetaSchema,
    );
    expect(reviewMeta?.agent).toBe("agy");
    expect(reviewMeta?.model).toBe("gemini-2.5-pro");
    expect(reviewMeta?.heterogeneity_level).toBe("dual");

    // On-conflict deliverer ran ONCE and triggered mandatory post-conflict verify gate before merge_main succeeded
    const deliverAgentRuns = fs
      .readdirSync(server.store.paths.runsDir("t-b6-conflict"))
      .filter((d) => d.includes("-deliver"));
    expect(deliverAgentRuns).toHaveLength(1);
    expect(fs.existsSync(server.store.paths.gateYaml("t-b6-conflict", deliverAgentRuns[0]!))).toBe(
      true,
    );

    const mainShared = fs.readFileSync(path.join(repoPath, "src", "shared.ts"), "utf8");
    expect(mainShared).toContain("from-task");
    expect(mainShared).toContain("from-main");
  });
});
