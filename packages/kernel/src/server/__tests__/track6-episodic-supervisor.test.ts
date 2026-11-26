import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GateReportSchema,
  RosterConfigSchema,
  TaskCardSchema,
  serializeFrontmatterMarkdown,
  type LimitsConfig,
  type RosterConfig,
  type TaskCard,
} from "@kiln/protocol";
import { FakeBackend } from "../../backend/index.js";
import { computeFrozenSnapshot } from "../../gate/index.js";
import { readYamlOptional } from "../../store/index.js";
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

function makeTrack6Backend(): FakeBackend {
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

function makeTrack6Roster(): RosterConfig {
  return RosterConfigSchema.parse({
    schema_version: 2,
    heterogeneous_review: true,
    roster: {
      pm: {
        group: "core",
        enabled: true,
        name: "立项 PM",
        stage: "intake",
        perm: "read_only_draft",
        traits: "pm",
        mode: "agent",
        primary: { provider: "codex", model: "gpt-5.4", backend_id: "fake" },
      },
      researcher: {
        group: "core",
        enabled: true,
        name: "研究员",
        stage: "research",
        perm: "read_only",
        traits: "research",
        mode: "agent",
        primary: { provider: "codex", model: "gpt-5.4", backend_id: "fake" },
      },
      architect: {
        group: "core",
        enabled: true,
        name: "架构师",
        stage: "plan",
        perm: "read_only",
        traits: "architecture",
        mode: "agent",
        primary: { provider: "codex", model: "gpt-5.4", backend_id: "fake" },
      },
      advisor: {
        group: "core",
        enabled: true,
        name: "技术顾问",
        stage: "advise",
        perm: "read_only",
        traits: "advisor",
        mode: "agent",
        primary: { provider: "claude", model: "claude-sonnet-4-6", backend_id: "fake" },
      },
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
      debugger: {
        group: "specialist",
        enabled: true,
        name: "疑难排查",
        stage: "implement",
        perm: "workspace_write",
        traits: "debug",
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
        fallbacks: [{ provider: "codex", model: "gpt-5.4", backend_id: "fake" }],
      },
      verifier: {
        group: "core",
        enabled: true,
        name: "独立黑盒验收",
        stage: "accept",
        perm: "read_only",
        traits: "accept",
        mode: "agent",
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

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 20_000,
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

function makeWorkerReceipt(fields: {
  run_id: string;
  contract_version: number;
  outcome?: "completed" | "need_decision";
  input_ref: string;
  output_ref: string;
  changed_paths: string[];
  accept_result?: "pass" | "fail" | "skipped";
  category?: string;
  question?: string;
}): string {
  return serializeFrontmatterMarkdown(
    {
      run_id: fields.run_id,
      contract_version: fields.contract_version,
      outcome: fields.outcome ?? "completed",
      input_ref: fields.input_ref,
      output_ref: fields.output_ref,
      changed_paths: fields.changed_paths,
      accept_result: fields.accept_result ?? "pass",
      is_bugfix: false,
      complexity_escalate: false,
      ...(fields.category ? { category: fields.category } : {}),
      ...(fields.question ? { question: fields.question } : {}),
    },
    [
      "## 改动说明\n执行阶段输出\n",
      "## 验证命令与真实输出\nexit code 0\n",
      `## 未完成或待决问题\n${fields.question ?? "无"}\n`,
    ].join("\n"),
  );
}

function makeReviewerReceipt(fields: {
  run_id: string;
  contract_version: number;
  reviewed_ref: string;
}): string {
  return serializeFrontmatterMarkdown(
    {
      run_id: fields.run_id,
      contract_version: fields.contract_version,
      reviewed_ref: fields.reviewed_ref,
      verdict: "pass",
      p0: 0,
      p1: 0,
      p2: 0,
    },
    ["## 结论\n审查通过\n", "## 缺陷清单\n无\n", "## 测试真实性与复现核查\n真实执行通过\n"].join(
      "\n",
    ),
  );
}

function makeVerifierReceipt(fields: {
  run_id: string;
  contract_version: number;
  verified_ref: string;
}): string {
  return serializeFrontmatterMarkdown(
    {
      run_id: fields.run_id,
      contract_version: fields.contract_version,
      verified_ref: fields.verified_ref,
      verdict: "pass",
      passed_scenarios: 1,
      failed_scenarios: 0,
    },
    "## 验收场景明细\n- [pass] 端到端入口验收通过\n",
  );
}

function makeAdvisorReceipt(
  frontmatter: Record<string, unknown>,
  body = "## 技术取舍\n按最优路径收敛\n\n## 授权裁决\n未改目标与 scope\n",
): string {
  return serializeFrontmatterMarkdown(frontmatter, body);
}

describe("Track 6 Episodic Supervisor (B16 workflow_patch, B17 subtask split, B18 fast-forward)", () => {
  const tempDirs: string[] = [];
  const servers: KilndServer[] = [];

  function makeTempDir(prefix = "kiln-track6-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function initGitRepo(name: string): { repoPath: string; baseCommit: string } {
    const repoPath = makeTempDir(`kiln-t6-repo-${name}-`);
    git(["init", "-b", "main"], repoPath);
    git(["config", "user.name", "Test User"], repoPath);
    git(["config", "user.email", "test@example.com"], repoPath);
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.mkdirSync(path.join(repoPath, "docs"), { recursive: true });
    fs.mkdirSync(path.join(repoPath, "packages", "protocol", "src"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "src", "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(repoPath, "src", "b.ts"), "export const b = 1;\n");
    fs.writeFileSync(path.join(repoPath, "docs", "guide.md"), "# Guide v1\n");
    fs.writeFileSync(
      path.join(repoPath, "packages", "protocol", "src", "card.ts"),
      "export const protoVersion = 1;\n",
    );
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

  it("B16: wakes advisor on worker workflow_replan need_decision, patches workflow dynamically, and preserves advisorCalls budget across workflow_patched", async () => {
    const kilnHome = makeTempDir("kiln-b16-home-");
    const { repoPath, baseCommit } = initGitRepo("b16");
    const acceptCmd =
      "node -e \"const fs=require('fs'); process.exit(fs.readFileSync('src/a.ts','utf8').includes('42') ? 0 : 1)\"";
    const snap = computeFrozenSnapshot(repoPath, [], acceptCmd);
    const fakeBackend = makeTrack6Backend();
    const observedActions: string[] = [];

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "b16-secret-0123456789abcdef012345",
      approvalHandler: async (req, ctx) => {
        observedActions.push(req.action);
        const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
        const token =
          fakeBackend.getRecordedSpecs().find((s) => s.runId === ctx.runId)?.mcpServers?.[0]?.env
            ?.KILN_RUN_TOKEN ?? "";

        const submit = async (markdown: string): Promise<void> => {
          const res = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({ markdown }),
          });
          expect(res.status).toBe(200);
        };

        if (req.action === "impl_request_replan") {
          await submit(
            makeWorkerReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              outcome: "need_decision",
              input_ref: baseCommit,
              output_ref: baseCommit,
              changed_paths: [],
              accept_result: "skipped",
              category: "workflow_replan",
              question: "需要先补规划再切换 debugger 修复 src/a.ts",
            }),
          );
        } else if (req.action === "advise_patch") {
          await submit(
            makeAdvisorReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              outcome: "resolved",
              chosen_approach: "插入 plan 并由 debugger 收敛实施",
              decision_kind: "workflow_replan",
              workflow_patch: {
                rationale: "Worker requested structured plan + debugger specialist",
                replace_remaining_steps: [
                  { kind: "agent", stage: "plan", role: "advisor", fresh_context: true },
                  {
                    kind: "agent",
                    stage: "implement",
                    role: "worker",
                    fresh_context: false,
                    roster_role: "debugger",
                  },
                  { kind: "gate", stage: "verify", check: "full" },
                ],
              },
            }),
          );
        } else if (req.action === "patched_plan") {
          await submit(
            makeAdvisorReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              outcome: "resolved",
              chosen_approach: "将 src/a.ts 更新为 42",
              decision_kind: "plan",
            }),
          );
        } else if (req.action === "patched_debugger_fix") {
          fs.writeFileSync(path.join(wtPath, "src", "a.ts"), "export const a = 42;\n");
          await submit(
            makeWorkerReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              outcome: "completed",
              input_ref: baseCommit,
              output_ref: "HEAD",
              changed_paths: ["src/a.ts"],
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
      id: "kiln",
      name: "Kiln",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    server.store.writeConfig("roster", makeTrack6Roster());
    server.store.writeConfig("limits", defaultLimits());

    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "impl_request_replan", detail: "ask replan" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "advise_patch", detail: "advisor workflow_patch" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "advisor" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "patched_plan", detail: "plan step" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "advisor" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "patched_debugger_fix", detail: "debugger step" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );

    const now = new Date().toISOString();
    const card: TaskCard = TaskCardSchema.parse({
      schema_version: 1,
      id: "t-b16-replan",
      title: "B16 动态重排验证",
      space: "kiln",
      priority: "P1",
      track: "L1",
      workspace_mode: "git_worktree",
      workflow: {
        schema_version: 1,
        preset: "custom",
        steps: [
          { kind: "agent", stage: "implement", role: "worker", fresh_context: false },
          { kind: "gate", stage: "verify", check: "full" },
          {
            kind: "command",
            stage: "deliver",
            apply_staged: false,
            run_deliver_cmd: false,
            verify_sha256: false,
            final_accept_gate: false,
          },
        ],
      },
      contract_version: 1,
      contract: {
        goal: "修改 src/a.ts 为 42",
        end: "验收通过并合入 main",
        accept_cmd: acceptCmd,
        accept_files_hash: snap.hash,
        scope: ["src/a.ts"],
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
    });

    server.stateMachine.createTask(card, "# B16 Test\n");
    await server.start();

    await waitUntil(
      () => server.store.getTaskIndex(card.id)?.status === "done",
      "B16 task done after workflow_patch",
    );

    expect(observedActions).toEqual([
      "impl_request_replan",
      "advise_patch",
      "patched_plan",
      "patched_debugger_fix",
    ]);
    const events = server.store.readStateEvents(card.id);
    expect(events.some((e) => e.type === "workflow_patched")).toBe(true);
    expect(fs.readFileSync(path.join(repoPath, "src", "a.ts"), "utf8")).toContain("42");

    // Verify advisorCalls did not reset across workflow_patched
    const latestCard = server.store.readTaskCard(card.id);
    const counters = (
      server.orchestrator as unknown as {
        computeStageCounters: (
          id: string,
          c: TaskCard,
          s: string,
          runId: string,
        ) => { counters: { advisorCalls: number } };
      }
    ).computeStageCounters(card.id, latestCard, "implement", "dummy-run");
    expect(counters.counters.advisorCalls).toBe(1);
  });

  it("B17: splits mid-flight subtasks from plan, merges into parent branch kiln/<parentId> cleanly, passes parent integration barrier verify + accept, and escalates out-of-scope split for human approval", async () => {
    const kilnHome = makeTempDir("kiln-b17-home-");
    const { repoPath, baseCommit } = initGitRepo("b17");
    const acceptCmd =
      "node -e \"const fs=require('fs'); const a=fs.readFileSync('src/a.ts','utf8'); const b=fs.readFileSync('src/b.ts','utf8'); process.exit(a.includes('2') && b.includes('2') ? 0 : 1)\"";
    const snap = computeFrozenSnapshot(repoPath, [], acceptCmd);
    const fakeBackend = makeTrack6Backend();
    let mainDirtyCheckDuringChildRun = "";

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "b17-secret-0123456789abcdef012345",
      approvalHandler: async (req, ctx) => {
        const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
        const token =
          fakeBackend.getRecordedSpecs().find((s) => s.runId === ctx.runId)?.mcpServers?.[0]?.env
            ?.KILN_RUN_TOKEN ?? "";

        const submit = async (markdown: string): Promise<void> => {
          const res = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({ markdown }),
          });
          expect(res.status).toBe(200);
        };

        if (req.action === "plan_split_two") {
          await submit(
            makeAdvisorReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              outcome: "resolved",
              chosen_approach: "拆分为 src/a.ts 与 src/b.ts 两个并行子卡",
              decision_kind: "subtask_split",
              spawn_subtasks: [
                {
                  temp_id: "sub-a",
                  title: "子卡 A",
                  track: "L1",
                  include_review: false,
                  contract: {
                    goal: "更新 src/a.ts = 2",
                    end: "src/a.ts 包含 2",
                    accept_cmd:
                      "node -e \"process.exit(require('fs').readFileSync('src/a.ts','utf8').includes('2') ? 0 : 1)\"",
                    scope: ["src/a.ts"],
                  },
                  brief_markdown: "# 子卡 A\n更新 src/a.ts\n",
                },
                {
                  temp_id: "sub-b",
                  title: "子卡 B",
                  track: "L1",
                  include_review: false,
                  contract: {
                    goal: "更新 src/b.ts = 2",
                    end: "src/b.ts 包含 2",
                    accept_cmd:
                      "node -e \"process.exit(require('fs').readFileSync('src/b.ts','utf8').includes('2') ? 0 : 1)\"",
                    scope: ["src/b.ts"],
                  },
                  brief_markdown: "# 子卡 B\n更新 src/b.ts\n",
                },
              ],
            }),
          );
        } else if (req.action === "child_impl") {
          const isChildA = ctx.card.contract.scope.includes("src/a.ts");
          if (isChildA) {
            fs.writeFileSync(path.join(wtPath, "src", "a.ts"), "export const a = 2;\n");
          } else {
            fs.writeFileSync(path.join(wtPath, "src", "b.ts"), "export const b = 2;\n");
          }
          // Verify main repo stays untouched on initial commit while children execute!
          mainDirtyCheckDuringChildRun = git(["rev-parse", "HEAD"], repoPath).trim();
          const inputRef = git(["rev-parse", `kiln/${ctx.card.parent}`], wtPath).trim();
          await submit(
            makeWorkerReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              outcome: "completed",
              input_ref: inputRef,
              output_ref: "HEAD",
              changed_paths: [isChildA ? "src/a.ts" : "src/b.ts"],
            }),
          );
        } else if (req.action === "parent_accept") {
          const revRef = git(["rev-parse", "HEAD"], wtPath).trim();
          await submit(
            makeVerifierReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              verified_ref: revRef,
            }),
          );
        } else if (req.action === "plan_split_out_of_scope") {
          await submit(
            makeAdvisorReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              outcome: "resolved",
              chosen_approach: "尝试扩 scope 拆分",
              decision_kind: "subtask_split",
              spawn_subtasks: [
                {
                  temp_id: "s1",
                  title: "子卡 1",
                  track: "L1",
                  include_review: false,
                  contract: { goal: "g1", end: "e1", scope: ["src/a.ts"] },
                  brief_markdown: "# 1\n",
                },
                {
                  temp_id: "s2",
                  title: "子卡 越界",
                  track: "L1",
                  include_review: false,
                  contract: { goal: "g2", end: "e2", scope: ["outside/file.ts"] },
                  brief_markdown: "# 2\n",
                },
              ],
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
      id: "kiln",
      name: "Kiln",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    server.store.writeConfig("roster", makeTrack6Roster());
    server.store.writeConfig("limits", defaultLimits());

    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "plan_split_two", detail: "spawn 2 subtasks" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "advisor" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "child_impl", detail: "child 1" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "child_impl", detail: "child 2" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "parent_accept", detail: "parent accept" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "verifier" },
    );

    const now = new Date().toISOString();
    const parentCard: TaskCard = TaskCardSchema.parse({
      schema_version: 1,
      id: "t-b17-parent",
      title: "B17 父卡并行裂变与合流",
      space: "kiln",
      priority: "P1",
      track: "L2",
      workspace_mode: "git_worktree",
      workflow: {
        schema_version: 1,
        preset: "custom",
        steps: [
          { kind: "agent", stage: "plan", role: "advisor", fresh_context: true },
          { kind: "agent", stage: "implement", role: "worker", fresh_context: false },
          { kind: "gate", stage: "verify", check: "full" },
          { kind: "agent", stage: "accept", role: "verifier", fresh_context: true },
          {
            kind: "command",
            stage: "deliver",
            apply_staged: false,
            run_deliver_cmd: false,
            verify_sha256: false,
            final_accept_gate: false,
          },
        ],
      },
      contract_version: 1,
      contract: {
        goal: "更新 a.ts 和 b.ts",
        end: "主分支含两者更新",
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
        max_tokens: 1_000_000,
      },
      created_at: now,
      updated_at: now,
    });

    server.stateMachine.createTask(parentCard, "# Parent Brief\n");
    await server.start();

    await waitUntil(
      () => server.store.getTaskIndex(parentCard.id)?.status === "done",
      "B17 parent task done after child merge and integration verify+accept",
    );

    expect(mainDirtyCheckDuringChildRun).toBe(baseCommit);
    const parentEvents = server.store.readStateEvents(parentCard.id);
    const spawnedEv = parentEvents.find((e) => e.type === "subtasks_spawned");
    expect(spawnedEv?.type).toBe("subtasks_spawned");
    if (spawnedEv?.type === "subtasks_spawned") {
      expect(spawnedEv.child_task_ids).toHaveLength(2);
      for (const cid of spawnedEv.child_task_ids) {
        expect(server.store.getTaskIndex(cid)?.status).toBe("done");
        expect(server.store.readTaskCard(cid).parent).toBe(parentCard.id);
      }
    }
    // Check deterministic integration GATE.yaml on parent verify run
    const verifyRun = fs
      .readdirSync(server.store.paths.runsDir(parentCard.id))
      .find((d) => d.endsWith("-verify"));
    expect(verifyRun).toBeDefined();
    const barrierGate = readYamlOptional(
      server.store.paths.gateYaml(parentCard.id, verifyRun!),
      GateReportSchema,
    );
    expect(barrierGate?.accept_exit_code).toBe(0);
    expect(barrierGate?.scope_ok).toBe(true);
    expect(fs.readFileSync(path.join(repoPath, "src", "a.ts"), "utf8")).toContain("2");
    expect(fs.readFileSync(path.join(repoPath, "src", "b.ts"), "utf8")).toContain("2");

    // Verify out-of-scope proposal escalates to subtask_split_approval and can be approved via /decide
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "plan_split_out_of_scope", detail: "oos split" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "advisor" },
    );
    const oosParent: TaskCard = TaskCardSchema.parse({
      ...parentCard,
      id: "t-b17-oos",
      title: "越界裂变审批测试",
      depends_on: [],
    });
    server.stateMachine.createTask(oosParent, "# OOS Split\n");
    void server.orchestrator.wake();

    await waitUntil(
      () => server.pendingDecisions.get(oosParent.id)?.reason === "subtask_split_approval",
      "oosParent waits for subtask_split_approval",
    );
    const pendingOos = server.pendingDecisions.get(oosParent.id)!;
    const approveRes = await server.app.request(
      new Request(`http://127.0.0.1/api/tasks/${oosParent.id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision_id: pendingOos.id,
          option_id: "opt-approve-subtask-split",
          action: "resume",
        }),
      }),
    );
    expect(approveRes.status).toBe(200);
    expect(fs.existsSync(server.store.paths.pendingSubtaskSplitYaml(oosParent.id))).toBe(false);
    const oosEvents = server.store.readStateEvents(oosParent.id);
    expect(oosEvents.some((e) => e.type === "subtasks_spawned")).toBe(true);
  });

  it("B18: fast-forwards docs_only past review+accept, keeps review for tests_only while skipping accept, and never skips accept for packages/protocol runtime source", async () => {
    const kilnHome = makeTempDir("kiln-b18-home-");
    const { repoPath, baseCommit } = initGitRepo("b18");
    const passCmd = 'node -e "process.exit(0)"';
    const snap = computeFrozenSnapshot(repoPath, [], passCmd);
    const fakeBackend = makeTrack6Backend();

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "b18-secret-0123456789abcdef012345",
      approvalHandler: async (req, ctx) => {
        const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
        const token =
          fakeBackend.getRecordedSpecs().find((s) => s.runId === ctx.runId)?.mcpServers?.[0]?.env
            ?.KILN_RUN_TOKEN ?? "";

        const submit = async (markdown: string): Promise<void> => {
          const res = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({ markdown }),
          });
          expect(res.status).toBe(200);
        };

        if (req.action === "worker_docs") {
          fs.writeFileSync(path.join(wtPath, "docs", "guide.md"), "# Guide v2\n");
          await submit(
            makeWorkerReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: baseCommit,
              output_ref: "HEAD",
              changed_paths: ["docs/guide.md"],
            }),
          );
        } else if (req.action === "worker_tests") {
          fs.mkdirSync(path.join(wtPath, "src", "__tests__"), { recursive: true });
          fs.writeFileSync(
            path.join(wtPath, "src", "__tests__", "sample.test.ts"),
            "export const ok = true;\n",
          );
          await submit(
            makeWorkerReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: baseCommit,
              output_ref: "HEAD",
              changed_paths: ["src/__tests__/sample.test.ts"],
            }),
          );
        } else if (req.action === "worker_proto") {
          fs.writeFileSync(
            path.join(wtPath, "packages", "protocol", "src", "card.ts"),
            "export const protoVersion = 2;\n",
          );
          await submit(
            makeWorkerReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: baseCommit,
              output_ref: "HEAD",
              changed_paths: ["packages/protocol/src/card.ts"],
            }),
          );
        } else if (req.action === "review_pass") {
          const revRef = git(["rev-parse", "HEAD"], wtPath).trim();
          await submit(
            makeReviewerReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              reviewed_ref: revRef,
            }),
          );
        } else if (req.action === "accept_pass") {
          const verRef = git(["rev-parse", "HEAD"], wtPath).trim();
          await submit(
            makeVerifierReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              verified_ref: verRef,
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
      id: "kiln",
      name: "Kiln",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    server.store.writeConfig("roster", makeTrack6Roster());
    server.store.writeConfig("limits", defaultLimits());

    const makeFullDeliveryCard = (id: string, scope: string[]): TaskCard => {
      const now = new Date().toISOString();
      return TaskCardSchema.parse({
        schema_version: 1,
        id,
        title: `B18 ${id}`,
        space: "kiln",
        priority: "P1",
        track: "L2",
        workspace_mode: "git_worktree",
        workflow: {
          schema_version: 1,
          preset: "full_delivery",
          steps: [
            { kind: "agent", stage: "implement", role: "worker", fresh_context: false },
            { kind: "gate", stage: "verify", check: "full" },
            { kind: "agent", stage: "review", role: "reviewer", fresh_context: true },
            { kind: "agent", stage: "accept", role: "verifier", fresh_context: true },
            {
              kind: "command",
              stage: "deliver",
              apply_staged: false,
              run_deliver_cmd: false,
              verify_sha256: false,
              final_accept_gate: false,
            },
          ],
        },
        contract_version: 1,
        contract: {
          goal: `Modify ${scope.join(", ")}`,
          end: "Delivered",
          accept_cmd: passCmd,
          accept_files_hash: snap.hash,
          scope,
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
      });
    };

    // Enqueue in order per role/task execution:
    // 1) docs_only: only worker_docs runs
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "worker_docs", detail: "docs" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    await server.start();

    const docsCard = makeFullDeliveryCard("t-b18-docs", ["docs/**"]);
    server.stateMachine.createTask(docsCard, "# Docs\n");
    void server.orchestrator.wake();
    await waitUntil(
      () => server.store.getTaskIndex(docsCard.id)?.status === "done",
      "docs_only task done",
    );
    const docsRuns = fs.readdirSync(server.store.paths.runsDir(docsCard.id));
    expect(docsRuns.some((r) => r.includes("review"))).toBe(false);
    expect(docsRuns.some((r) => r.includes("accept"))).toBe(false);
    const docsFf = server.store
      .readStateEvents(docsCard.id)
      .find((e) => e.type === "stage_fast_forwarded");
    expect(docsFf?.type === "stage_fast_forwarded" ? docsFf.reason : null).toBe("docs_only");

    // 2) tests_only: worker_tests + review_pass run, accept is skipped
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "worker_tests", detail: "tests" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "review_pass", detail: "review tests" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "reviewer" },
    );
    const testsCard = makeFullDeliveryCard("t-b18-tests", ["src/**"]);
    server.stateMachine.createTask(testsCard, "# Tests\n");
    void server.orchestrator.wake();
    await waitUntil(
      () => server.store.getTaskIndex(testsCard.id)?.status === "done",
      "tests_only task done",
    );
    const testsRuns = fs.readdirSync(server.store.paths.runsDir(testsCard.id));
    expect(testsRuns.some((r) => r.includes("review"))).toBe(true);
    expect(testsRuns.some((r) => r.includes("accept"))).toBe(false);
    const testsFf = server.store
      .readStateEvents(testsCard.id)
      .find((e) => e.type === "stage_fast_forwarded");
    expect(testsFf?.type === "stage_fast_forwarded" ? testsFf.reason : null).toBe("tests_only");

    // 3) protocol runtime source: worker_proto + review_pass + accept_pass ALL run
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "worker_proto", detail: "proto" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "review_pass", detail: "review proto" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "reviewer" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "accept_pass", detail: "accept proto" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "verifier" },
    );
    const protoCard = makeFullDeliveryCard("t-b18-proto", ["packages/protocol/**"]);
    server.stateMachine.createTask(protoCard, "# Proto\n");
    void server.orchestrator.wake();
    await waitUntil(
      () => server.store.getTaskIndex(protoCard.id)?.status === "done",
      "proto runtime task done",
    );
    const protoRuns = fs.readdirSync(server.store.paths.runsDir(protoCard.id));
    expect(protoRuns.some((r) => r.includes("review"))).toBe(true);
    expect(protoRuns.some((r) => r.includes("accept"))).toBe(true);
    expect(
      server.store.readStateEvents(protoCard.id).some((e) => e.type === "stage_fast_forwarded"),
    ).toBe(false);
  });
});
