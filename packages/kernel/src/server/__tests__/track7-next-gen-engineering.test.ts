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
import { resolveDualSynthesisPeerAssignment } from "../../scheduler/role-resolver.js";
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
          // Verify previously locked test file can also be updated after workflow_patched unlock
          fs.writeFileSync(
            path.join(wtPath, "src", "core", "__tests__", "mul.test.ts"),
            "// REQUIRE_MULTIPLY\n// updated after unlock\nexport const ok = true;\n",
          );
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
              changed_paths: ["src/core/__tests__/mul.test.ts", "src/core/__tests__/sub.test.ts"],
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

describe("Track 7 E2: plan-level dual_synthesis & 2nd-advise auto-upgrade", () => {
  it("runs concurrent Brain A + B, reuses Brain A via backend.send(), writes candidates & exposes detail API", async () => {
    const kilnHome = makeTempDir("kiln-e2-synth-home-");
    const repoDir = makeTempDir("kiln-e2-synth-repo-");
    const baseSha = initSampleGitRepo(repoDir);
    const acceptCmd = "echo ok";
    const snap = computeFrozenSnapshot(repoDir, [], acceptCmd);
    const fakeBackend = makeTrack7Backend();
    const observedActions: string[] = [];

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "e2-secret-0123456789abcdef012345",
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
        };

        if (req.action === "plan_cand_a") {
          await submit(
            serializeFrontmatterMarkdown(
              {
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                outcome: "resolved",
                chosen_approach: "方案 A：保持轻量模块结构",
              },
              "## 技术取舍\nBrain A 草案详情\n\n## 授权裁决\n按 A 实施\n",
            ),
          );
        } else if (req.action === "plan_cand_b") {
          await submit(
            serializeFrontmatterMarkdown(
              {
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                outcome: "resolved",
                chosen_approach: "方案 B：补充边界容错校验",
              },
              "## 技术取舍\nBrain B 草案详情\n\n## 授权裁决\n补充空值防守\n",
            ),
          );
        } else if (req.action === "plan_synth") {
          await submit(
            serializeFrontmatterMarkdown(
              {
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                outcome: "resolved",
                chosen_approach: "融合方案：轻量模块 + 边界容错",
              },
              [
                "> **双脑博弈合成摘要**：采纳 Brain A 的轻量结构与 Brain B 的空值容错护栏。",
                "> - 架构骨架：沿用既有模块拆分",
                "> - 边界兜底：增加空输入保护",
                "",
                "## 技术取舍\n取长补短收敛终版\n\n## 授权裁决\n按终版执行\n",
              ].join("\n"),
            ),
          );
        } else if (req.action === "impl_after_synth") {
          fs.appendFileSync(path.join(wtPath, "src", "core", "calc.ts"), "\n// e2 impl\n");
          await submit(
            makeWorkerReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: baseSha,
              output_ref: "HEAD",
              changed_paths: ["src/core/calc.ts"],
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
      id: "sp-e2",
      name: "E2 Space",
      repo_path: repoDir,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    server.store.writeConfig("roster", makeTrack7Roster());
    server.store.writeConfig("limits", makeDefaultLimits(2));

    // Brain A (codex, turn 1 + warm send turn 2) & Brain B (claude)
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "plan_cand_a", detail: "Brain A draft" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "advisor", agent: "codex", turnNumber: 1 },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "plan_synth", detail: "Brain A warm synthesis" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "advisor", agent: "codex", turnNumber: 2 },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "plan_cand_b", detail: "Brain B draft" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "advisor", agent: "claude", turnNumber: 1 },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "impl_after_synth", detail: "worker implement" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );

    const now = new Date().toISOString();
    const card = TaskCardSchema.parse({
      schema_version: 1,
      id: "t-e2-synth",
      title: "E2 dual synthesis test",
      space: "sp-e2",
      priority: "P1",
      track: "L1",
      workspace_mode: "git_worktree",
      parent: null,
      depends_on: [],
      contract_version: 1,
      workflow: buildWorkflowPreset("quick", {
        includePlan: true,
        dualSynthesis: true,
      }),
      contract: {
        goal: "Plan with dual synthesis and implement cleanly",
        end: "done",
        accept_cmd: acceptCmd,
        accept_files_hash: snap.hash,
        scope: ["src/core/**"],
        deliver: { mode: "merge_main", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: {
        retries_per_stage: 2,
        review_rounds: 2,
        advisor_calls: 2,
        max_tokens: 5_000_000,
      },
      created_at: now,
      updated_at: now,
    });
    server.stateMachine.createTask(card, "# E2 Dual Synthesis\n");
    await server.start();

    await waitUntil(() => {
      const status = server.store.getTaskIndex("t-e2-synth")?.status;
      return status === "done" || status === "waiting";
    }, "E2 synthesized task done");

    expect(server.store.getTaskIndex("t-e2-synth")?.status).toBe("done");
    expect(fakeBackend.getRecordedSends()).toHaveLength(1);
    expect(fs.existsSync(server.store.paths.planCandidateAMd("t-e2-synth"))).toBe(true);
    expect(fs.existsSync(server.store.paths.planCandidateBMd("t-e2-synth"))).toBe(true);
    const planDoc = fs.readFileSync(server.store.paths.planMd("t-e2-synth"), "utf8");
    expect(planDoc).toContain("双脑博弈合成摘要");

    const detailRes = await server.app.request("/api/tasks/t-e2-synth");
    expect(detailRes.status).toBe(200);
    const detailJson = (await detailRes.json()) as {
      dualSynthesis: {
        status: string;
        reused_brain_a_session: boolean;
        candidates: unknown[];
      } | null;
      planCandidateA: string | null;
      planCandidateB: string | null;
    };
    expect(detailJson.dualSynthesis?.status).toBe("synthesized");
    expect(detailJson.dualSynthesis?.reused_brain_a_session).toBe(true);
    expect(detailJson.dualSynthesis?.candidates).toHaveLength(2);
    expect(detailJson.planCandidateA).toContain("Brain A 草案详情");
    expect(detailJson.planCandidateB).toContain("Brain B 草案详情");
  }, 20_000);

  it("handles need_decision A/B adoption via /decide and single-provider fallback_single gracefully", async () => {
    const kilnHome = makeTempDir("kiln-e2-dec-home-");
    const repoDir = makeTempDir("kiln-e2-dec-repo-");
    const baseSha = initSampleGitRepo(repoDir);
    const acceptCmd = "echo ok";
    const snap = computeFrozenSnapshot(repoDir, [], acceptCmd);
    const fakeBackend = makeTrack7Backend();

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "e2-dec-secret-0123456789abcdef01",
      approvalHandler: async (req, ctx) => {
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
        };

        if (req.action === "cand_a_need_dec") {
          await submit(
            serializeFrontmatterMarkdown(
              {
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                outcome: "need_decision",
                chosen_approach: "A 认为存在接口兼容争议",
              },
              "## 技术取舍\n方案 A 待决策内容\n\n## 授权裁决\n请拍板\n",
            ),
          );
        } else if (req.action === "cand_b_ok") {
          await submit(
            serializeFrontmatterMarkdown(
              {
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                outcome: "resolved",
                chosen_approach: "B 给出无破坏兼容方案",
              },
              "## 技术取舍\n方案 B 可直接执行详情\n\n## 授权裁决\n采用方案 B\n",
            ),
          );
        } else if (req.action === "single_fb_plan") {
          await submit(
            serializeFrontmatterMarkdown(
              {
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                outcome: "resolved",
                chosen_approach: "单脑降级直出方案",
              },
              "## 技术取舍\n单脑细节\n\n## 授权裁决\n按单脑执行\n",
            ),
          );
        } else if (req.action === "impl_done") {
          fs.appendFileSync(path.join(wtPath, "src", "core", "calc.ts"), "\n// dec impl\n");
          await submit(
            makeWorkerReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: baseSha,
              output_ref: "HEAD",
              changed_paths: ["src/core/calc.ts"],
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
      id: "sp-e2-dec",
      name: "E2 Decide Space",
      repo_path: repoDir,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    server.store.writeConfig("roster", makeTrack7Roster());
    server.store.writeConfig("limits", makeDefaultLimits(2));

    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "cand_a_need_dec", detail: "A need_decision" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-e2-dec", role: "advisor", agent: "codex" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "cand_b_ok", detail: "B ok" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-e2-dec", role: "advisor", agent: "claude" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "impl_done", detail: "implement after adopt B" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-e2-dec", role: "worker" },
    );

    const now = new Date().toISOString();
    const cardDec = TaskCardSchema.parse({
      schema_version: 1,
      id: "t-e2-dec",
      title: "E2 need decision A/B",
      space: "sp-e2-dec",
      priority: "P1",
      track: "L1",
      workspace_mode: "git_worktree",
      parent: null,
      depends_on: [],
      contract_version: 1,
      workflow: buildWorkflowPreset("quick", {
        includePlan: true,
        dualSynthesis: true,
      }),
      contract: {
        goal: "Test A/B adoption",
        end: "done",
        accept_cmd: acceptCmd,
        accept_files_hash: snap.hash,
        scope: ["src/core/**"],
        deliver: { mode: "merge_main", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: {
        retries_per_stage: 2,
        review_rounds: 2,
        advisor_calls: 2,
        max_tokens: 5_000_000,
      },
      created_at: now,
      updated_at: now,
    });
    server.stateMachine.createTask(cardDec, "# E2 Decide\n");
    await server.start();

    await waitUntil(
      () => server.store.getTaskIndex("t-e2-dec")?.status === "waiting",
      "E2 task waiting on dual_synthesis_need_decision",
    );
    const pendingDec = server.pendingDecisions.get("t-e2-dec");
    expect(pendingDec?.reason).toBe("dual_synthesis_need_decision");
    expect(pendingDec?.options.map((o) => o.id)).toContain("opt-adopt-brain-a");
    expect(pendingDec?.options.map((o) => o.id)).toContain("opt-adopt-brain-b");

    const decideRes = await server.app.request("/api/tasks/t-e2-dec/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision_id: pendingDec!.id,
        option_id: "opt-adopt-brain-b",
        action: "resume",
      }),
    });
    expect(decideRes.status).toBe(200);
    expect(fs.readFileSync(server.store.paths.planMd("t-e2-dec"), "utf8")).toContain(
      "方案 B 可直接执行详情",
    );

    await waitUntil(
      () => server.store.getTaskIndex("t-e2-dec")?.status === "done",
      "E2 task done after adopting B",
    );

    // Part B: single-provider graceful fallback_single
    const singleRoster = makeTrack7Roster();
    singleRoster.roster.architect!.primary = {
      provider: "codex",
      model: "gpt-5.4",
      backend_id: "fake",
    };
    singleRoster.roster.architect!.fallbacks = [];
    singleRoster.roster.advisor!.primary = {
      provider: "codex",
      model: "gpt-5.4",
      backend_id: "fake",
    };
    singleRoster.roster.advisor!.fallbacks = [];
    server.store.writeConfig("roster", singleRoster);

    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "single_fb_plan", detail: "single fallback plan" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-e2-fb", role: "advisor" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "impl_done", detail: "single fallback impl" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-e2-fb", role: "worker" },
    );

    const cardFb = TaskCardSchema.parse({
      ...cardDec,
      id: "t-e2-fb",
      title: "E2 single-provider fallback",
    });
    server.stateMachine.createTask(cardFb, "# E2 Fallback\n");
    await server.orchestrator.wake();
    await waitUntil(
      () => server.store.getTaskIndex("t-e2-fb")?.status === "done",
      "E2 single-provider fallback task done",
    );
    const fbRes = await server.app.request("/api/tasks/t-e2-fb");
    const fbJson = (await fbRes.json()) as {
      dualSynthesis: { status: string } | null;
    };
    expect(fbJson.dualSynthesis?.status).toBe("fallback_single");
  }, 20_000);

  it("auto-upgrades the 2nd advise run in the same contract window to dual_synthesis", async () => {
    const kilnHome = makeTempDir("kiln-e2-adv-home-");
    const repoDir = makeTempDir("kiln-e2-adv-repo-");
    const baseSha = initSampleGitRepo(repoDir);
    const acceptCmd = "echo ok";
    const snap = computeFrozenSnapshot(repoDir, [], acceptCmd);
    const fakeBackend = makeTrack7Backend();

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "e2-adv-secret-0123456789abcdef01",
      approvalHandler: async (req, ctx) => {
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
        };

        if (req.action === "worker_ask_1" || req.action === "worker_ask_2") {
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
              question: `第 ${req.action} 次求助 advisor`,
            }),
          );
        } else if (req.action === "advise_1_single") {
          await submit(
            serializeFrontmatterMarkdown(
              {
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                outcome: "resolved",
                chosen_approach: "第 1 次单脑裁决",
                decision_kind: "technical_ambiguity",
                target_stage: "implement",
              },
              "## 技术取舍\n单脑第1次\n\n## 授权裁决\n继续实施\n",
            ),
          );
        } else if (req.action === "advise_2_cand_a") {
          await submit(
            serializeFrontmatterMarkdown(
              {
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                outcome: "resolved",
                chosen_approach: "第 2 次顾问 Brain A 思路",
                decision_kind: "technical_ambiguity",
                target_stage: "implement",
              },
              "## 技术取舍\nA 建议\n\n## 授权裁决\n回实施\n",
            ),
          );
        } else if (req.action === "advise_2_cand_b") {
          await submit(
            serializeFrontmatterMarkdown(
              {
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                outcome: "resolved",
                chosen_approach: "第 2 次顾问 Brain B 思路",
                decision_kind: "technical_ambiguity",
                target_stage: "implement",
              },
              "## 技术取舍\nB 建议\n\n## 授权裁决\n回实施\n",
            ),
          );
        } else if (req.action === "advise_2_synth") {
          await submit(
            serializeFrontmatterMarkdown(
              {
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                outcome: "resolved",
                chosen_approach: "第 2 次顾问双脑合成裁决",
                decision_kind: "technical_ambiguity",
                target_stage: "implement",
              },
              "> **双脑博弈合成摘要**：第 2 次顾问已自动升级双脑合成。\n\n## 技术取舍\n合并 A+B\n\n## 授权裁决\n最终落地\n",
            ),
          );
        } else if (req.action === "worker_done") {
          fs.appendFileSync(path.join(wtPath, "src", "core", "calc.ts"), "\n// adv2 done\n");
          await submit(
            makeWorkerReceipt({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: baseSha,
              output_ref: "HEAD",
              changed_paths: ["src/core/calc.ts"],
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
      id: "sp-e2-adv",
      name: "E2 Advise Space",
      repo_path: repoDir,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    server.store.writeConfig("roster", makeTrack7Roster());
    server.store.writeConfig("limits", makeDefaultLimits(4));

    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "worker_ask_1", detail: "ask 1" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "advise_1_single", detail: "1st advise single" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "advisor", agent: "codex" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "worker_ask_2", detail: "ask 2" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "advise_2_cand_a", detail: "2nd advise Brain A" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "advisor", agent: "codex", turnNumber: 1 },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "advise_2_synth", detail: "2nd advise synth" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "advisor", agent: "codex", turnNumber: 2 },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "advise_2_cand_b", detail: "2nd advise Brain B" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "advisor", agent: "claude", turnNumber: 1 },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "worker_done", detail: "worker finish" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );

    const now = new Date().toISOString();
    const card = TaskCardSchema.parse({
      schema_version: 1,
      id: "t-e2-adv",
      title: "E2 2nd advise auto-upgrade",
      space: "sp-e2-adv",
      priority: "P1",
      track: "L1",
      workspace_mode: "git_worktree",
      parent: null,
      depends_on: [],
      contract_version: 1,
      workflow: buildWorkflowPreset("quick"),
      contract: {
        goal: "Test 2nd advise upgrade",
        end: "done",
        accept_cmd: acceptCmd,
        accept_files_hash: snap.hash,
        scope: ["src/core/**"],
        deliver: { mode: "merge_main", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: {
        retries_per_stage: 4,
        review_rounds: 2,
        advisor_calls: 3,
        max_tokens: 5_000_000,
      },
      created_at: now,
      updated_at: now,
    });
    server.stateMachine.createTask(card, "# E2 2nd Advise\n");
    await server.start();

    await waitUntil(
      () => server.store.getTaskIndex("t-e2-adv")?.status === "done",
      "E2 2nd advise task done",
    );

    const res = await server.app.request("/api/tasks/t-e2-adv");
    const json = (await res.json()) as {
      dualSynthesis: { stage: string; status: string; reused_brain_a_session: boolean } | null;
    };
    expect(json.dualSynthesis?.stage).toBe("advise");
    expect(json.dualSynthesis?.status).toBe("synthesized");
    expect(json.dualSynthesis?.reused_brain_a_session).toBe(true);
    expect(fakeBackend.getRecordedSends()).toHaveLength(1);
  }, 20_000);

  it("respects cooldown for non-MCP peers, supports file-protocol RECEIPT_CAND_B.md, and aborts active dual runs without deadlocking", async () => {
    const rosterWithNonMcp = makeTrack7Roster();
    rosterWithNonMcp.roster.architect = {
      ...rosterWithNonMcp.roster.architect!,
      primary: { provider: "codex", model: "gpt-5.4", backend_id: "fake" },
      fallbacks: [
        { provider: "pi", model: "zai/glm-5", backend_id: "fake" },
        { provider: "claude", model: "claude-sonnet-4-6", backend_id: "fake" },
      ],
    };
    const peerRespectsCooldown = resolveDualSynthesisPeerAssignment(
      rosterWithNonMcp,
      "plan",
      { agent: "codex", model: "gpt-5.4" },
      {
        agentCapabilitiesMap: new Map([
          [
            "pi",
            {
              interactiveChat: true,
              approvals: true,
              mcpInjection: false,
              usageCacheBreakdown: true,
              interrupt: true,
              readOnlySandbox: true,
              warmSessionReuse: false,
              imageInput: false,
            },
          ],
          [
            "claude",
            {
              interactiveChat: true,
              approvals: true,
              mcpInjection: true,
              usageCacheBreakdown: true,
              interrupt: true,
              readOnlySandbox: true,
              warmSessionReuse: false,
              imageInput: false,
            },
          ],
        ]),
        isCoolingDown: (key) => key.agent === "pi",
      },
    );
    expect(peerRespectsCooldown?.agent).toBe("claude");

    const kilnHome = makeTempDir("kiln-e2-file-home-");
    const repoDir = makeTempDir("kiln-e2-file-repo-");
    const baseSha = initSampleGitRepo(repoDir);
    const acceptCmd = "echo ok";
    const snap = computeFrozenSnapshot(repoDir, [], acceptCmd);
    const fakeBackend = new FakeBackend({
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
            readOnlySandbox: true,
            warmSessionReuse: true,
            imageInput: false,
          },
          modes: [{ id: "auto", label: "Auto" }],
          defaultModeId: "auto",
        },
        {
          id: "pi",
          label: "Pi",
          capabilities: {
            interactiveChat: false,
            approvals: true,
            mcpInjection: false,
            usageCacheBreakdown: true,
            interrupt: true,
            readOnlySandbox: true,
            warmSessionReuse: false,
            imageInput: false,
          },
          modes: [],
          defaultModeId: null,
        },
      ],
      models: {
        codex: [{ id: "gpt-5.4", label: "GPT-5.4", thinkingOptions: [] }],
        pi: [{ id: "zai/glm-5", label: "GLM-5", thinkingOptions: [] }],
      },
    });

    const server = new KilndServer({
      kilnHome,
      host: "127.0.0.1",
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "e2-file-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
        const matchedSpec = fakeBackend.getRecordedSpecs().find((s) => s.runId === ctx.runId);
        const token = matchedSpec?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";

        if (req.action === "file_cand_a" || req.action === "file_synth") {
          const res = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: serializeFrontmatterMarkdown(
                {
                  run_id: ctx.runId,
                  contract_version: ctx.card.contract_version,
                  outcome: "resolved",
                  chosen_approach:
                    req.action === "file_cand_a" ? "Brain A MCP 草案" : "融合 MCP+文件双脑终版",
                },
                req.action === "file_cand_a"
                  ? "## 技术取舍\nA MCP\n\n## 授权裁决\nA\n"
                  : "> **双脑博弈合成摘要**：MCP Brain A 与文件协议 Brain B 成功合成。\n\n## 技术取舍\n合成\n\n## 授权裁决\n执行\n",
              ),
            }),
          });
          expect(res.status).toBe(200);
        } else if (req.action === "file_cand_b") {
          const prompt = matchedSpec?.prompt ?? "";
          const pathMatch = /RECEIPT_CAND_B\.md/.exec(prompt);
          expect(pathMatch).not.toBeNull();
          const lineMatch = /`([^`\n]*RECEIPT_CAND_B\.md)`/.exec(prompt);
          expect(lineMatch?.[1]).toBeTruthy();
          fs.writeFileSync(
            lineMatch![1]!,
            serializeFrontmatterMarkdown(
              {
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                outcome: "resolved",
                chosen_approach: "Brain B 文件协议草案",
              },
              "## 技术取舍\nPi file protocol 草案\n\n## 授权裁决\n补充测试\n",
            ),
            "utf8",
          );
        } else if (req.action === "file_impl") {
          fs.appendFileSync(path.join(wtPath, "src", "core", "calc.ts"), "\n// file e2 done\n");
          const res = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceipt({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: baseSha,
                output_ref: "HEAD",
                changed_paths: ["src/core/calc.ts"],
              }),
            }),
          });
          expect(res.status).toBe(200);
        } else if (req.action === "hang_to_abort") {
          // Intentionally pause task mid-flight while candidate turn awaits approval
          void server.app.request(`/api/tasks/${ctx.taskId}/pause`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          return;
        }
        await ctx.backend.answer(req.id, true);
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    server.store.writeSpace({
      schema_version: 1,
      id: "sp-e2-file",
      name: "E2 File Protocol Space",
      repo_path: repoDir,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    const fileRoster = makeTrack7Roster();
    fileRoster.roster.architect!.fallbacks = [
      { provider: "pi", model: "zai/glm-5", backend_id: "fake" },
    ];
    fileRoster.roster.advisor!.fallbacks = [
      { provider: "pi", model: "zai/glm-5", backend_id: "fake" },
    ];
    server.store.writeConfig("roster", fileRoster);
    server.store.writeConfig("limits", makeDefaultLimits(4));

    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "file_cand_a", detail: "A" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-e2-file", role: "advisor", agent: "codex", turnNumber: 1 },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "file_synth", detail: "Synth" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-e2-file", role: "advisor", agent: "codex", turnNumber: 2 },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "file_cand_b", detail: "B file" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-e2-file", role: "advisor", agent: "pi", turnNumber: 1 },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "file_impl", detail: "impl" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-e2-file", role: "worker" },
    );

    const now = new Date().toISOString();
    const cardFile = TaskCardSchema.parse({
      schema_version: 1,
      id: "t-e2-file",
      title: "E2 file protocol B",
      space: "sp-e2-file",
      priority: "P1",
      track: "L1",
      workspace_mode: "git_worktree",
      parent: null,
      depends_on: [],
      contract_version: 1,
      workflow: buildWorkflowPreset("quick", {
        includePlan: true,
        dualSynthesis: true,
      }),
      contract: {
        goal: "Test file-protocol Brain B",
        end: "done",
        accept_cmd: acceptCmd,
        accept_files_hash: snap.hash,
        scope: ["src/core/**"],
        deliver: { mode: "merge_main", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: {
        retries_per_stage: 2,
        review_rounds: 2,
        advisor_calls: 2,
        max_tokens: 5_000_000,
      },
      created_at: now,
      updated_at: now,
    });
    server.stateMachine.createTask(cardFile, "# E2 File\n");
    await server.start();

    await waitUntil(
      () => server.store.getTaskIndex("t-e2-file")?.status === "done",
      "E2 file-protocol task done",
    );
    const resFile = await server.app.request("/api/tasks/t-e2-file");
    const jsonFile = (await resFile.json()) as {
      dualSynthesis: { status: string; reused_brain_a_session: boolean } | null;
      planCandidateB: string | null;
    };
    expect(jsonFile.dualSynthesis?.status).toBe("synthesized");
    expect(jsonFile.dualSynthesis?.reused_brain_a_session).toBe(true);
    expect(jsonFile.planCandidateB).toContain("Brain B 文件协议草案");

    // Verify aborting an in-flight dual_synthesis run completes immediately without deadlocking
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "hang_to_abort", detail: "pause triggers abort" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-e2-abort", role: "advisor", agent: "codex" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "hang_to_abort", detail: "B waits" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-e2-abort", role: "advisor", agent: "pi" },
    );
    const cardAbort = TaskCardSchema.parse({
      ...cardFile,
      id: "t-e2-abort",
      title: "E2 non-deadlock pause",
    });
    server.stateMachine.createTask(cardAbort, "# E2 Abort\n");
    await server.orchestrator.wake();
    await waitUntil(
      () => server.store.getTaskIndex("t-e2-abort")?.status === "paused",
      "E2 task paused cleanly via abortActiveRun without deadlock",
    );
  }, 20_000);
});
