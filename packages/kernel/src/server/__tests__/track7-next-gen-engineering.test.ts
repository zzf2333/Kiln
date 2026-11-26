import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GateReportSchema,
  RosterConfigSchema,
  TaskCardSchema,
  buildWorkflowPreset,
  serializeFrontmatterMarkdown,
  type LimitsConfig,
  type RosterConfig,
  type TaskCard,
} from "@kiln/protocol";
import { FakeBackend } from "../../backend/index.js";
import { computeFrozenSnapshot } from "../../gate/index.js";
import { KilnStore, readYamlOptional } from "../../store/index.js";
import { generateAndWriteContextMap, parseContextMapHeader } from "../context-map.js";
import { KilndServer } from "../index.js";
import { buildHandoffPayload } from "../orchestrator-handoff.js";

const tempDirs: string[] = [];
const servers: KilndServer[] = [];

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

function makeTrack7Backend(): FakeBackend {
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

function makeTrack7Roster(): RosterConfig {
  return RosterConfigSchema.parse({
    schema_version: 2,
    heterogeneous_review: true,
    roster: {
      pm: {
        group: "core",
        enabled: true,
        name: "PM",
        stage: "intake",
        perm: "read_only_draft",
        traits: "pm",
        mode: "agent",
        primary: { provider: "codex", model: "gpt-5.4", backend_id: "fake" },
      },
      architect: {
        group: "core",
        enabled: true,
        name: "Architect",
        stage: "plan",
        perm: "read_only",
        traits: "plan",
        mode: "agent",
        primary: { provider: "codex", model: "gpt-5.4", backend_id: "fake" },
        fallbacks: [{ provider: "claude", model: "claude-sonnet-4-6", backend_id: "fake" }],
      },
      advisor: {
        group: "core",
        enabled: true,
        name: "Advisor",
        stage: "advise",
        perm: "read_only",
        traits: "advisor",
        mode: "agent",
        primary: { provider: "codex", model: "gpt-5.4", backend_id: "fake" },
        fallbacks: [{ provider: "claude", model: "claude-sonnet-4-6", backend_id: "fake" }],
      },
      tester: {
        group: "kernel",
        enabled: true,
        name: "Tester",
        stage: "verify",
        secondary_stages: ["implement"],
        perm: "kernel_gate",
        traits: "red-test author",
        mode: "kernel",
        primary: { provider: "claude", model: "claude-sonnet-4-6", backend_id: "fake" },
        fallbacks: [{ provider: "codex", model: "gpt-5.4", backend_id: "fake" }],
      },
      main_dev: {
        group: "core",
        enabled: true,
        name: "Main Dev",
        stage: "implement",
        perm: "workspace_write",
        traits: "impl",
        mode: "agent",
        primary: { provider: "codex", model: "gpt-5.4", backend_id: "fake" },
      },
      reviewer: {
        group: "core",
        enabled: true,
        name: "Reviewer",
        stage: "review",
        perm: "read_only",
        traits: "review",
        mode: "agent",
        primary: { provider: "claude", model: "claude-sonnet-4-6", backend_id: "fake" },
      },
      verifier: {
        group: "core",
        enabled: true,
        name: "Verifier",
        stage: "accept",
        perm: "read_only",
        traits: "accept",
        mode: "agent",
        primary: { provider: "claude", model: "claude-sonnet-4-6", backend_id: "fake" },
      },
    },
  });
}

function makeDefaultLimits(retries = 3): LimitsConfig {
  return {
    schema_version: 1,
    max_concurrent_slots: 4,
    p0_extra_slot: true,
    max_waiting_wip: 5,
    retries_per_stage: retries,
    review_rounds: 3,
    advisor_calls: 2,
    max_card_tokens: 5_000_000,
  };
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
      "## 改动说明\n完成阶段处理\n",
      "## 验证命令与真实输出\nexit code 0\n",
      `## 未完成或待决问题\n${fields.question ?? "无"}\n`,
    ].join("\n"),
  );
}

function makeReviewerReceipt(fields: {
  run_id: string;
  contract_version: number;
  reviewed_ref: string;
  verdict?: "pass" | "changes_requested";
}): string {
  const verdict = fields.verdict ?? "pass";
  return serializeFrontmatterMarkdown(
    {
      run_id: fields.run_id,
      contract_version: fields.contract_version,
      reviewed_ref: fields.reviewed_ref,
      verdict,
      p0: 0,
      p1: verdict === "pass" ? 0 : 1,
      p2: 0,
    },
    verdict === "pass"
      ? "## 结论\n审查通过\n\n## 缺陷清单\n无\n\n## 测试真实性与复现核查\n真实执行通过\n"
      : "## 结论\n退回\n\n## 缺陷清单\n- [P1] 需要返工修复\n\n## 测试真实性与复现核查\n复现通过\n",
  );
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initSampleGitRepo(repoDir: string): string {
  fs.mkdirSync(path.join(repoDir, "src", "core"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "src", "web"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "src", "core", "__tests__"), { recursive: true });

  fs.writeFileSync(
    path.join(repoDir, "src", "core", "calc.ts"),
    [
      "export function addValues(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "export const DEFAULT_RATIO = 2;",
      "export interface CalcOptions { strict: boolean }",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(repoDir, "src", "core", "__tests__", "calc.test.ts"),
    ['import { addValues } from "../calc.js";', "export const ok = addValues(1, 2) === 3;"].join(
      "\n",
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(repoDir, "src", "web", "widget.ts"),
    [
      'import { addValues } from "../core/calc.js";',
      "export function renderTotal(): number {",
      "  return addValues(4, 5);",
      "}",
    ].join("\n"),
    "utf8",
  );

  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@kiln.local"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Kiln Test"], { cwd: repoDir });
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
}

function makeSampleCard(spaceId = "sp-track7"): TaskCard {
  const now = "2026-11-26T00:00:00.000Z";
  return {
    schema_version: 1,
    id: "t-track7-ctx",
    space: spaceId,
    parent: null,
    title: "Track 7 context map task",
    priority: "P1",
    track: "L2",
    workspace_mode: "git_worktree",
    created_at: now,
    updated_at: now,
    contract_version: 1,
    depends_on: [],
    contract: {
      goal: "Add calculator feature",
      end: "Add calculator feature with tests",
      scope: ["src/core/**"],
      accept_cmd: "echo ok",
      accept_files_hash: "sha256:empty",
      human_accept: false,
      external_actions: "ask",
      deliver: { mode: "merge_main", cmd: null },
    },
    limits: {
      retries_per_stage: 2,
      review_rounds: 2,
      advisor_calls: 1,
      max_tokens: 250_000,
    },
  };
}

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.stop();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Track 7 E3: on-demand CONTEXT_MAP.md & progressive disclosure pointer", () => {
  it("generates bounded 0-token CONTEXT_MAP.md with delta, exports, out-of-scope importers, and tests under 140ms & 24KB", async () => {
    const kilnHome = makeTempDir("kiln-e3-home-");
    const repoDir = makeTempDir("kiln-e3-repo-");
    const baseSha = initSampleGitRepo(repoDir);

    // Mutate an in-scope file so Active Delta shows changes
    fs.appendFileSync(
      path.join(repoDir, "src", "core", "calc.ts"),
      "\nexport function multiplyValues(a: number, b: number): number { return a * b; }\n",
      "utf8",
    );

    const store = new KilnStore({ kilnHome });
    const card = makeSampleCard();
    try {
      store.createTask(card, "# Goal\nAdd calculator feature");
      const outputPath = store.paths.contextMapMd(card.id);

      const res = await generateAndWriteContextMap({
        card,
        worktreePath: repoDir,
        outputPath,
        inputRef: baseSha,
      });

      expect(res.ok).toBe(true);
      expect(res.bytes).toBeLessThanOrEqual(24 * 1024);
      expect(res.elapsedMs).toBeLessThan(140);
      expect(res.scopeFiles).toBeGreaterThanOrEqual(2);
      expect(res.testFiles).toBeGreaterThanOrEqual(1);
      expect(res.outOfScopeImporters).toBeGreaterThanOrEqual(1);

      const md = fs.readFileSync(outputPath, "utf8");
      const parsedHeader = parseContextMapHeader(md);
      expect(parsedHeader).toEqual({
        scope: res.scopeFiles,
        tests: res.testFiles,
        importers: res.importerCount,
        oos: res.outOfScopeImporters,
      });
      expect(md).toContain("## 本轮已改符号与变更摘要 (Active Delta)");
      expect(md).toContain("multiplyValues");
      expect(md).toContain("## Scope 内导出骨架 (Export Skeleton)");
      expect(md).toContain("addValues");
      expect(md).toContain("## 反向引用与爆炸半径 (Reverse Importers)");
      expect(md).toContain("⚠️ [Scope 外引用方] `src/web/widget.ts`");
      expect(md).toContain("## 关联单测文件 (Co-located Tests)");
      expect(md).toContain("src/core/__tests__/calc.test.ts");

      // Verify HANDOFF.md injects only the concise 3-line pointer on non-accept stages,
      // and hides it on accept (black-box) stage.
      const implHandoff = buildHandoffPayload({
        store,
        card,
        stage: "implement",
        role: "worker",
        runId: "run-impl-e3",
        runDirName: "0001-implement-r1",
        round: 1,
        cwd: repoDir,
        mcpEnabled: true,
      });
      expect(implHandoff.fullMarkdown).toContain("## 代码地图索引 (CONTEXT_MAP.md 指针)");
      expect(implHandoff.fullMarkdown).toContain(outputPath);
      expect(implHandoff.fullMarkdown).not.toContain("⚠️ [Scope 外引用方]");

      const acceptHandoff = buildHandoffPayload({
        store,
        card,
        stage: "accept",
        role: "verifier",
        runId: "run-accept-e3",
        runDirName: "0002-accept-r1",
        round: 1,
        cwd: repoDir,
        mcpEnabled: true,
      });
      expect(acceptHandoff.fullMarkdown).not.toContain("CONTEXT_MAP.md 指针");
    } finally {
      store.close();
    }
  });
});

describe("Track 7 E1: test_first_lock physical red-green test isolation", () => {
  it("runs red-test lock (Check 1+2+3), blocks tampering during normal implement, skips locked test_first_lock on review rework, and unlocks on advisor workflow_patch", async () => {
    const kilnHome = makeTempDir("kiln-e1-home-");
    const repoDir = makeTempDir("kiln-e1-repo-");
    const baseSha = initSampleGitRepo(repoDir);

    // Accept command dynamically runs all JS/TS assertions in src/core/__tests__/*.test.ts against src/core/calc.ts via simple node evaluation
    const acceptCmd = [
      'node -e "',
      "const fs=require('fs'), path=require('path');",
      "const testDir=path.join(process.cwd(),'src/core/__tests__');",
      "const calcSrc=fs.readFileSync(path.join(process.cwd(),'src/core/calc.ts'),'utf8');",
      "for (const f of fs.readdirSync(testDir)) {",
      "  const t=fs.readFileSync(path.join(testDir,f),'utf8');",
      "  if (t.includes('REQUIRE_MULTIPLY') && !calcSrc.includes('multiplyValues')) process.exit(1);",
      "  if (t.includes('REQUIRE_SUBTRACT') && !calcSrc.includes('subtractValues')) process.exit(1);",
      "}",
      'process.exit(0);"',
    ].join(" ");

    const snap = computeFrozenSnapshot(repoDir, [], acceptCmd);
    const fakeBackend = makeTrack7Backend();
    const observedActions: string[] = [];

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "e1-secret-0123456789abcdef012345",
      approvalHandler: async (req, ctx) => {
        observedActions.push(req.action);
        const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
        const matchedSpec =
          fakeBackend.getRecordedSpecs().find((s) => s.runId === ctx.runId) ??
          [...fakeBackend.getRecordedSpecs()]
            .reverse()
            .find((s) => s.taskId === ctx.taskId && s.role === ctx.role);
        const token = matchedSpec?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";

        const submit = async (markdown: string): Promise<void> => {
          const res = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({ markdown }),
          });
          if (res.status !== 200) {
            throw new Error(`submit failed (${res.status}): ${JSON.stringify(res.body)}`);
          }
          expect(res.status).toBe(200);
        };

        if (req.action === "red_bad_prod") {
          // Check 1 violation: touches production source
          fs.appendFileSync(path.join(wtPath, "src", "core", "calc.ts"), "\n// illegal edit\n");
          fs.writeFileSync(
            path.join(wtPath, "src", "core", "__tests__", "mul.test.ts"),
            "// REQUIRE_MULTIPLY\nexport const x = 1;\n",
          );
          await submit(
            makeWorkerReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: baseSha,
              output_ref: baseSha,
              changed_paths: ["src/core/calc.ts", "src/core/__tests__/mul.test.ts"],
            }),
          );
        } else if (req.action === "red_fake_green") {
          // Check 2 violation: only test file touched, but accept_cmd exits 0 (not red!)
          fs.writeFileSync(
            path.join(wtPath, "src", "core", "__tests__", "mul.test.ts"),
            "// empty shell test passing immediately\nexport const x = 1;\n",
          );
          await submit(
            makeWorkerReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: baseSha,
              output_ref: baseSha,
              changed_paths: ["src/core/__tests__/mul.test.ts"],
            }),
          );
        } else if (req.action === "red_valid") {
          // Check 1 + Check 2 + Check 3 pass!
          fs.writeFileSync(
            path.join(wtPath, "src", "core", "__tests__", "mul.test.ts"),
            "// REQUIRE_MULTIPLY\nexport const ok = true;\n",
          );
          await submit(
            makeWorkerReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: baseSha,
              output_ref: baseSha,
              changed_paths: ["src/core/__tests__/mul.test.ts"],
            }),
          );
        } else if (req.action === "impl_tamper_locked") {
          // Answerer tries modifying locked test file -> caught as frozen_files_changed
          fs.appendFileSync(
            path.join(wtPath, "src", "core", "__tests__", "mul.test.ts"),
            "\n// weakened\n",
          );
          fs.appendFileSync(
            path.join(wtPath, "src", "core", "calc.ts"),
            "\nexport function multiplyValues(a: number, b: number) { return a * b; }\n",
          );
          await submit(
            makeWorkerReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: baseSha,
              output_ref: baseSha,
              changed_paths: ["src/core/__tests__/mul.test.ts", "src/core/calc.ts"],
            }),
          );
        } else if (req.action === "impl_clean_fix") {
          // Restore locked test cleanly before writing prod code
          git(["checkout", "--", "src/core/__tests__/mul.test.ts"], wtPath);
          fs.appendFileSync(
            path.join(wtPath, "src", "core", "calc.ts"),
            "\nexport function multiplyValues(a: number, b: number) { return a * b; }\n",
          );
          await submit(
            makeWorkerReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: baseSha,
              output_ref: "HEAD",
              changed_paths: ["src/core/calc.ts"],
            }),
          );
        } else if (req.action === "review_rework") {
          const headSha = git(["rev-parse", "HEAD"], wtPath).trim();
          await submit(
            makeReviewerReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              reviewed_ref: headSha,
              verdict: "changes_requested",
            }),
          );
        } else if (req.action === "impl_appeal_test_bug") {
          // Rework after review landed directly on normal implement (skipping locked test_first_lock)!
          // Appeal to advisor via technical_ambiguity
          await submit(
            makeWorkerReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              outcome: "need_decision",
              input_ref: baseSha,
              output_ref: baseSha,
              changed_paths: [],
              accept_result: "skipped",
              category: "technical_ambiguity",
              question: "锁定测试遗漏 subtractValues 边界，请 advisor 解锁重出红灯测试",
            }),
          );
        } else if (req.action === "advise_unlock_tfl") {
          await submit(
            serializeFrontmatterMarkdown(
              {
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                outcome: "resolved",
                chosen_approach: "重插 test_first_lock 解锁并重出减法测试",
                decision_kind: "workflow_replan",
                workflow_patch: {
                  rationale: "Unlock locked test_first_lock per worker appeal",
                  replace_remaining_steps: [
                    {
                      kind: "agent",
                      stage: "implement",
                      role: "worker",
                      fresh_context: true,
                      mode: "test_first_lock",
                    },
                    {
                      kind: "agent",
                      stage: "implement",
                      role: "worker",
                      fresh_context: false,
                    },
                    { kind: "gate", stage: "verify", check: "full" },
                    { kind: "agent", stage: "review", role: "reviewer", fresh_context: true },
                  ],
                },
              },
              "## 技术取舍\n允许解锁重出考卷\n\n## 授权裁决\n重跑 test_first_lock\n",
            ),
          );
        } else if (req.action === "red_unlocked_v2") {
          fs.writeFileSync(
            path.join(wtPath, "src", "core", "__tests__", "sub.test.ts"),
            "// REQUIRE_SUBTRACT\nexport const ok = true;\n",
          );
          await submit(
            makeWorkerReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: baseSha,
              output_ref: baseSha,
              changed_paths: ["src/core/__tests__/sub.test.ts"],
            }),
          );
        } else if (req.action === "impl_final_green") {
          const calcPath = path.join(wtPath, "src", "core", "calc.ts");
          if (!fs.readFileSync(calcPath, "utf8").includes("subtractValues")) {
            fs.appendFileSync(
              calcPath,
              "\nexport function subtractValues(a: number, b: number) { return a - b; }\n",
            );
          }
          await submit(
            makeWorkerReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: baseSha,
              output_ref: "HEAD",
              changed_paths: ["src/core/calc.ts"],
            }),
          );
        } else if (req.action === "review_pass") {
          const headSha = git(["rev-parse", "HEAD"], wtPath).trim();
          await submit(
            makeReviewerReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              reviewed_ref: headSha,
              verdict: "pass",
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
      id: "sp-e1",
      name: "E1 Space",
      repo_path: repoDir,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    server.store.writeConfig("roster", makeTrack7Roster());
    server.store.writeConfig("limits", makeDefaultLimits(4));

    // Put test_first_lock inside loop to explicitly verify resolveImplementReworkStepIndex skips locked test_first_lock on review rework!
    const e1Blueprint = buildWorkflowPreset("standard_dev", {
      testFirstLock: true,
      hasDeliverCmd: false,
    });
    // Move test_first_lock inside loop for rework skip assertion
    const loopWorkflow = TaskCardSchema.shape.workflow.parse({
      schema_version: 1,
      preset: "custom",
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
              fresh_context: true,
              mode: "test_first_lock",
            },
            { kind: "agent", stage: "implement", role: "worker", fresh_context: false },
            { kind: "gate", stage: "verify", check: "full" },
            { kind: "agent", stage: "review", role: "reviewer", fresh_context: true },
          ],
        },
        ...e1Blueprint.steps.filter((s) => s.kind === "command"),
      ],
    });

    // Enqueue deterministic turn scripts in exact expected execution sequence
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "red_bad_prod", detail: "attempt 1 bad prod edit" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "red_fake_green", detail: "attempt 2 unexpected exit 0" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "red_valid", detail: "attempt 3 valid red test" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "impl_tamper_locked", detail: "tamper locked test" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "impl_clean_fix", detail: "implement multiplyValues cleanly" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        {
          kind: "approval",
          action: "review_rework",
          detail: "request changes to verify rework skips locked tfl",
        },
        { kind: "exit", reason: "completed" },
      ],
      { role: "reviewer" },
    );
    fakeBackend.enqueueScript(
      [
        {
          kind: "approval",
          action: "impl_appeal_test_bug",
          detail: "answerer appeals to unlock test",
        },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        {
          kind: "approval",
          action: "advise_unlock_tfl",
          detail: "advisor unlocks via workflow_patch",
        },
        { kind: "exit", reason: "completed" },
      ],
      { role: "advisor" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "red_unlocked_v2", detail: "unlocked test_first_lock v2" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "impl_final_green", detail: "final green implementation" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "review_pass", detail: "final review pass" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "reviewer" },
    );

    const now = new Date().toISOString();
    const card = TaskCardSchema.parse({
      schema_version: 1,
      id: "t-e1-lock",
      title: "E1 red-green test lock test",
      space: "sp-e1",
      priority: "P1",
      track: "L2",
      workspace_mode: "git_worktree",
      parent: null,
      depends_on: [],
      contract_version: 1,
      workflow: loopWorkflow,
      contract: {
        goal: "Implement multiplyValues and subtractValues via test_first_lock",
        end: "accept_cmd passes after red tests are locked",
        accept_cmd: acceptCmd,
        accept_files_hash: snap.hash,
        scope: ["src/core/**"],
        deliver: { mode: "merge_main", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: {
        retries_per_stage: 4,
        review_rounds: 3,
        advisor_calls: 2,
        max_tokens: 5_000_000,
      },
      created_at: now,
      updated_at: now,
    });
    server.stateMachine.createTask(card, "# E1 test-first lock\n");
    await server.start();

    await waitUntil(
      () => {
        const status = server.store.getTaskIndex("t-e1-lock")?.status;
        return status === "done" || status === "waiting";
      },
      "E1 task settled",
      15_000,
    ).catch((err) => {
      const idx = server.store.getTaskIndex("t-e1-lock");
      const evs = server.store.readStateEvents("t-e1-lock").slice(-4);
      throw new Error(
        `${err instanceof Error ? err.message : String(err)} | status=${idx?.status} actions=${JSON.stringify(observedActions)} tailEvents=${JSON.stringify(evs)}`,
      );
    });

    const finalIndex = server.store.getTaskIndex("t-e1-lock");
    if (finalIndex?.status !== "done") {
      const dec = server.pendingDecisions.get("t-e1-lock");
      const runDirs = fs.readdirSync(server.store.paths.runsDir("t-e1-lock")).sort();
      const tailRunInfo = runDirs.slice(-6).map((d) => ({
        d,
        hasReceipt: fs.existsSync(server.store.paths.receiptMd("t-e1-lock", d)),
        gate: readYamlOptional(server.store.paths.gateYaml("t-e1-lock", d), GateReportSchema),
      }));
      throw new Error(
        `Unexpected status ${finalIndex?.status}: actions=${JSON.stringify(observedActions)}, runs=${JSON.stringify(tailRunInfo)}, decision=${JSON.stringify(dec)}`,
      );
    }
    expect(finalIndex?.status).toBe("done");
    expect(observedActions).toEqual([
      "red_bad_prod",
      "red_fake_green",
      "red_valid",
      "impl_tamper_locked",
      "impl_clean_fix",
      "review_rework",
      "impl_appeal_test_bug",
      "advise_unlock_tfl",
      "red_unlocked_v2",
      "impl_final_green",
      "review_pass",
    ]);

    // Verify locked events and frozen tampering detection
    const events = server.store.readStateEvents("t-e1-lock");
    const lockedEvents = events.filter((e) => e.type === "contract_tests_locked");
    expect(lockedEvents).toHaveLength(2);
    expect(lockedEvents[0]?.test_files).toContain("src/core/__tests__/mul.test.ts");
    expect(lockedEvents[1]?.test_files).toContain("src/core/__tests__/sub.test.ts");

    // Verify tamper attempt produced GATE.yaml with frozen_files_changed
    const runs = fs.readdirSync(server.store.paths.runsDir("t-e1-lock")).sort();
    const gates = runs
      .map((r) => readYamlOptional(server.store.paths.gateYaml("t-e1-lock", r), GateReportSchema))
      .filter((g): g is NonNullable<typeof g> => g !== null);
    expect(
      gates.some((g) => g.frozen_files_changed.includes("src/core/__tests__/mul.test.ts")),
    ).toBe(true);

    // Verify test_first_lock ran with claude (heterogeneous from main_dev codex), fresh_context=true, and workspace_write!
    const tflSpecs = fakeBackend
      .getRecordedSpecs()
      .filter((s) => s.prompt.includes("红绿建测物理隔离 · 红灯出卷阶段"));
    expect(tflSpecs.length).toBeGreaterThanOrEqual(2);
    expect(tflSpecs[0]?.agent).toBe("claude");
    const ansSpecs = fakeBackend
      .getRecordedSpecs()
      .filter((s) => s.prompt.includes("红绿建测锁定考卷生效中"));
    expect(ansSpecs.length).toBeGreaterThanOrEqual(1);
    expect(ansSpecs[0]?.agent).toBe("codex");
  }, 30_000);
});
