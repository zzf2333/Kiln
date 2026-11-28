import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GateReportSchema,
  RosterConfigSchema,
  RunMetaSchema,
  TaskCardSchema,
  createDefaultWorkflowsConfig,
  serializeFrontmatterMarkdown,
  type LimitsConfig,
  type RosterConfig,
  type TaskCard,
} from "@kiln/protocol";
import { FakeBackend } from "../../backend/index.js";
import { computeFrozenSnapshot, toHostStagedRelativePath } from "../../gate/index.js";
import {
  KilnStore,
  deriveTaskStatus,
  readYamlOptional,
  realpathCanonical,
} from "../../store/index.js";
import { KilndServer } from "../index.js";
import { captureHostEnvironmentSnapshot } from "../host-snapshot.js";
import { formatDecisionsForHandoff } from "../orchestrator-handoff.js";
import { resolveCardLimits } from "../pending-decisions.js";

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
  outcome?: "completed" | "need_decision";
  input_ref: string;
  output_ref: string;
  changed_paths: string[];
  accept_result?: "pass" | "fail" | "skipped";
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
    },
    [
      "## 改动说明\n完成改动\n",
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

function makeEnhancementBackend(): FakeBackend {
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

function makeBaseRoster(overrides?: Record<string, unknown>): RosterConfig {
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
      frontend_ui: {
        group: "specialist",
        enabled: true,
        name: "前端视觉精修",
        stage: "implement",
        perm: "workspace_write",
        traits: "frontend",
        mode: "agent",
        primary: { provider: "claude", model: "claude-sonnet-4-6", backend_id: "fake" },
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
      ...(overrides ?? {}),
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

describe("Orchestrator enhancements: step_index, tester/deliverer agent modes, and steerTask", () => {
  const tempDirs: string[] = [];
  const servers: KilndServer[] = [];

  function makeTempDir(prefix = "kiln-orch-enh-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function initGitRepo(name: string): { repoPath: string; baseCommit: string } {
    const repoPath = makeTempDir(`kiln-repo-${name}-`);
    git(["init", "-b", "main"], repoPath);
    git(["config", "user.name", "Test User"], repoPath);
    git(["config", "user.email", "test@example.com"], repoPath);
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "src", "api.ts"), "export const api = 1;\n");
    fs.writeFileSync(path.join(repoPath, "src", "ui.ts"), "export const ui = 1;\n");
    fs.writeFileSync(path.join(repoPath, "src", "ready.txt"), "yes\n");
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
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("advances consecutive same-stage specialists via step_index (main_dev -> frontend_ui -> verify -> review -> merge_main) and rebuilds cleanly", async () => {
    const kilnHome = makeTempDir("kiln-stepidx-home-");
    const { repoPath, baseCommit } = initGitRepo("stepidx");
    const acceptCmd =
      "node -e \"const fs=require('fs'); const api=fs.readFileSync('src/api.ts','utf8'); const ui=fs.readFileSync('src/ui.ts','utf8'); process.exit(api.includes('2') && ui.includes('2') ? 0 : 1)\"";
    const snap = computeFrozenSnapshot(repoPath, [], acceptCmd);
    const fakeBackend = makeEnhancementBackend();

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "step-index-test-secret-0123456789ab",
      approvalHandler: async (req, ctx) => {
        const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
        const token =
          fakeBackend.getRecordedSpecs().find((s) => s.runId === ctx.runId)?.mcpServers?.[0]?.env
            ?.KILN_RUN_TOKEN ?? "";

        if (req.action === "step_main_dev") {
          // Only modify backend file; ui.ts is NOT updated yet so full accept_cmd would fail if run prematurely!
          fs.writeFileSync(path.join(wtPath, "src", "api.ts"), "export const api = 2;\n");
          const mcpRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: baseCommit,
                output_ref: "HEAD",
                changed_paths: ["src/api.ts"],
              }),
            }),
          });
          expect(mcpRes.status).toBe(200);
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "step_frontend_ui") {
          fs.writeFileSync(path.join(wtPath, "src", "ui.ts"), "export const ui = 2;\n");
          const mcpRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: baseCommit,
                output_ref: "HEAD",
                changed_paths: ["src/ui.ts"],
              }),
            }),
          });
          expect(mcpRes.status).toBe(200);
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "step_reviewer") {
          const revRef = git(["rev-parse", "HEAD"], wtPath).trim();
          const mcpRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeReviewerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                reviewed_ref: revRef,
                verdict: "pass",
              }),
            }),
          });
          expect(mcpRes.status).toBe(200);
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

    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "step_main_dev", detail: "main_dev" },
        { kind: "exit", reason: "completed" },
      ],
      { agent: "codex", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "step_frontend_ui", detail: "frontend_ui" },
        { kind: "exit", reason: "completed" },
      ],
      { agent: "claude", role: "worker" },
    );
    // Notice reviewer avoids frontend_ui (claude/claude-sonnet-4-6) and falls back to codex/gpt-5.4!
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "step_reviewer", detail: "reviewer" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "reviewer" },
    );

    const now = new Date().toISOString();
    const card: TaskCard = {
      schema_version: 1,
      id: "t-multi-spec",
      title: "前后端分段接力",
      space: "kiln",
      priority: "P1",
      track: "L2",
      workspace_mode: "git_worktree",
      parent: null,
      depends_on: [],
      workflow: {
        schema_version: 1,
        preset: "custom",
        pm_rationale: "先由主力开发改接口，再由前端精修接力",
        steps: [
          {
            kind: "agent",
            stage: "implement",
            role: "worker",
            fresh_context: false,
            roster_role: "main_dev",
          },
          {
            kind: "agent",
            stage: "implement",
            role: "worker",
            fresh_context: false,
            roster_role: "frontend_ui",
          },
          { kind: "gate", stage: "verify", check: "full" },
          {
            kind: "agent",
            stage: "review",
            role: "reviewer",
            fresh_context: true,
            roster_role: "reviewer",
          },
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
        goal: "完成 api + ui 联动",
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

    server.stateMachine.createTask(card, "# Multi specialist");
    await server.start();

    await waitUntil(
      () => server.store.getTaskIndex("t-multi-spec")?.status === "done",
      "t-multi-spec done",
    );

    const runDirs = fs.readdirSync(server.store.paths.runsDir("t-multi-spec")).sort();
    expect(runDirs).toEqual(["001-implement", "002-implement", "003-review"]);

    const meta1 = readYamlOptional(
      server.store.paths.runYaml("t-multi-spec", "001-implement"),
      RunMetaSchema,
    );
    const meta2 = readYamlOptional(
      server.store.paths.runYaml("t-multi-spec", "002-implement"),
      RunMetaSchema,
    );
    const meta3 = readYamlOptional(
      server.store.paths.runYaml("t-multi-spec", "003-review"),
      RunMetaSchema,
    );
    expect(meta1).toMatchObject({ roster_role: "main_dev", agent: "codex", step_index: 0 });
    expect(meta2).toMatchObject({ roster_role: "frontend_ui", agent: "claude", step_index: 1 });
    // Reviewer avoided frontend_ui (claude) and used fallback codex!
    expect(meta3).toMatchObject({ roster_role: "reviewer", agent: "codex", step_index: 3 });

    // Gate ran on 002-implement and passed
    expect(fs.existsSync(server.store.paths.gateYaml("t-multi-spec", "002-implement"))).toBe(true);
    expect(fs.readFileSync(path.join(repoPath, "src", "api.ts"), "utf8")).toContain("2");
    expect(fs.readFileSync(path.join(repoPath, "src", "ui.ts"), "utf8")).toContain("2");

    // Delete SQLite & rebuild -> state + stepIndex remain consistent
    await server.stop();
    const sqliteFile = path.join(kilnHome, "index.sqlite");
    fs.rmSync(sqliteFile, { force: true });
    fs.rmSync(`${sqliteFile}-wal`, { force: true });
    fs.rmSync(`${sqliteFile}-shm`, { force: true });
    const rebuiltStore = new KilnStore({ kilnHome });
    rebuiltStore.rebuildIndexFromDisk();
    try {
      const rebuiltDerived = deriveTaskStatus(
        rebuiltStore.readTaskCard("t-multi-spec"),
        rebuiltStore.readStateEvents("t-multi-spec"),
      );
      expect(rebuiltDerived.status).toBe("done");
      expect(rebuiltDerived.stepIndex).toBe(4);
    } finally {
      rebuiltStore.close();
    }
  });

  it("supports tester & deliverer agent modes while never skipping deterministic runVerificationGate", async () => {
    const kilnHome = makeTempDir("kiln-tester-deliverer-");
    const { repoPath, baseCommit } = initGitRepo("td");
    const acceptCmd =
      "node -e \"const fs=require('fs'); process.exit(fs.readFileSync('src/ready.txt','utf8').trim()==='yes'?0:1)\"";
    const snap = computeFrozenSnapshot(repoPath, [], acceptCmd);
    const fakeBackend = makeEnhancementBackend();
    let testerAttempts = 0;

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "tester-deliverer-secret-0123456789",
      approvalHandler: async (req, ctx) => {
        const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
        const token =
          fakeBackend.getRecordedSpecs().find((s) => s.runId === ctx.runId)?.mcpServers?.[0]?.env
            ?.KILN_RUN_TOKEN ?? "";

        if (req.action === "td_impl") {
          fs.writeFileSync(path.join(wtPath, "src", "api.ts"), "export const api = 9;\n");
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
                changed_paths: ["src/api.ts"],
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "td_tester") {
          testerAttempts += 1;
          // Attempt 1 intentionally breaks ready.txt while falsely self-reporting accept_result: pass!
          fs.writeFileSync(
            path.join(wtPath, "src", "ready.txt"),
            testerAttempts === 1 ? "no\n" : "yes\n",
          );
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
                changed_paths: ["src/ready.txt"],
                accept_result: "pass",
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "td_deliverer") {
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
                changed_paths: ["src/api.ts"],
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
    server.store.writeConfig(
      "roster",
      makeBaseRoster({
        tester: {
          group: "kernel",
          enabled: true,
          name: "独立测试",
          stage: "verify",
          perm: "kernel_gate",
          traits: "tester",
          mode: "agent",
          primary: { provider: "claude", model: "claude-sonnet-4-6", backend_id: "fake" },
        },
        deliverer: {
          group: "kernel",
          enabled: true,
          name: "合并交付",
          stage: "deliver",
          perm: "kernel_gate",
          traits: "deliverer",
          mode: "agent",
          primary: { provider: "claude", model: "claude-sonnet-4-6", backend_id: "fake" },
        },
      }),
    );
    server.store.writeConfig("limits", defaultLimits());

    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "td_impl", detail: "impl" },
        { kind: "exit", reason: "completed" },
      ],
      { agent: "codex", role: "worker" },
    );
    // Two verify scripts (attempt 1 blocked by deterministic gate, attempt 2 passes) + 1 deliverer script
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "td_tester", detail: "tester-1" },
        { kind: "exit", reason: "completed" },
      ],
      { agent: "claude", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "td_tester", detail: "tester-2" },
        { kind: "exit", reason: "completed" },
      ],
      { agent: "claude", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "td_deliverer", detail: "deliverer" },
        { kind: "exit", reason: "completed" },
      ],
      { agent: "claude", role: "worker" },
    );

    const now = new Date().toISOString();
    const card: TaskCard = {
      schema_version: 1,
      id: "t-td-agent",
      title: "tester/deliverer Agent 接入验证",
      space: "kiln",
      priority: "P1",
      track: "L1",
      workspace_mode: "git_worktree",
      parent: null,
      depends_on: [],
      contract_version: 1,
      contract: {
        goal: "测试 tester/deliverer",
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

    server.stateMachine.createTask(card, "# Tester and Deliverer");
    await server.start();

    await waitUntil(
      () => server.store.getTaskIndex("t-td-agent")?.status === "done",
      "t-td-agent done",
    );

    expect(testerAttempts).toBe(2);
    const runDirs = fs.readdirSync(server.store.paths.runsDir("t-td-agent")).sort();
    expect(runDirs).toEqual(["001-implement", "002-verify", "003-verify", "004-deliver"]);

    const gate1 = readYamlOptional(
      server.store.paths.gateYaml("t-td-agent", "002-verify"),
      GateReportSchema,
    );
    const gate2 = readYamlOptional(
      server.store.paths.gateYaml("t-td-agent", "003-verify"),
      GateReportSchema,
    );
    expect(gate1?.accept_exit_code).toBe(1);
    expect(gate2?.accept_exit_code).toBe(0);

    const deliverMeta = readYamlOptional(
      server.store.paths.runYaml("t-td-agent", "004-deliver"),
      RunMetaSchema,
    );
    expect(deliverMeta).toMatchObject({ roster_role: "deliverer", stage: "deliver" });
    expect(fs.readFileSync(path.join(repoPath, "src", "api.ts"), "utf8")).toContain("9");
  });

  it("supports mid-flight steerTask (interrupt=false/true), enforces 409 & :4311 auth, and survives rebuild()", async () => {
    const kilnHome = makeTempDir("kiln-steer-home-");
    const { repoPath, baseCommit } = initGitRepo("steer");
    const acceptCmd = 'node -e "process.exit(0)"';
    const snap = computeFrozenSnapshot(repoPath, [], acceptCmd);
    const fakeBackend = makeEnhancementBackend();

    let startedFirst = false;
    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "steer-test-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
        const token =
          fakeBackend.getRecordedSpecs().find((s) => s.runId === ctx.runId)?.mcpServers?.[0]?.env
            ?.KILN_RUN_TOKEN ?? "";
        if (req.action === "steer_run1_started") {
          startedFirst = true;
          await ctx.backend.answer(req.id, true);
          return;
        }
        if (req.action === "steer_run2_finish") {
          fs.writeFileSync(path.join(wtPath, "src", "api.ts"), "export const api = 42;\n");
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
                changed_paths: ["src/api.ts"],
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

    // First run stalls at wait_for_cancel until steer(interrupt: true) aborts it;
    // Second run completes after reading the injected HANDOFF.md steer section.
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "steer_run1_started", detail: "running" },
        { kind: "wait_for_cancel" },
        { kind: "exit", reason: "cancelled", detail: "steered_interrupt" },
      ],
      { agent: "codex", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "steer_run2_finish", detail: "finish" },
        { kind: "exit", reason: "completed" },
      ],
      { agent: "codex", role: "worker" },
    );

    const now = new Date().toISOString();
    const card: TaskCard = {
      schema_version: 1,
      id: "t-steer-e2e",
      title: "运行中纠偏测试",
      space: "kiln",
      priority: "P1",
      track: "L1",
      workspace_mode: "git_worktree",
      parent: null,
      depends_on: [],
      contract_version: 1,
      contract: {
        goal: "演示 Steer 中断与续跑",
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

    server.stateMachine.createTask(card, "# Steer test");
    await server.start();

    await waitUntil(() => startedFirst, "first run entered active wait_for_cancel");

    // 1. Remote :4311 unauthenticated steer must fail closed (401)
    const remoteUnauth = await server.remoteApp.request(
      new Request("https://remote.example/api/tasks/t-steer-e2e/steer", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "remote.example",
          Origin: "https://remote.example",
        },
        body: JSON.stringify({ message: "未登录不应通过", interrupt: false }),
      }),
    );
    expect(remoteUnauth.status).toBe(401);

    // 2. Pair a remote device and send steer(interrupt: false) over :4311
    const challenge = server.remoteAuth.createPairingChallenge();
    const pairRes = await server.remoteApp.request(
      new Request("https://remote.example/api/auth/pair", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "remote.example",
          Origin: "https://remote.example",
        },
        body: JSON.stringify({ token: challenge.token, label: "Phone" }),
      }),
    );
    expect(pairRes.status).toBe(200);
    const cookieHeader = pairRes.headers.get("set-cookie")!.split(";")[0]!;

    const remoteSteerRes = await server.remoteApp.request(
      new Request("https://remote.example/api/tasks/t-steer-e2e/steer", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "remote.example",
          Origin: "https://remote.example",
          Cookie: cookieHeader,
        },
        body: JSON.stringify({
          message: "下一棒保留向后兼容导出",
          interrupt: false,
        }),
      }),
    );
    expect(remoteSteerRes.status).toBe(200);
    const remoteSteerJson = (await remoteSteerRes.json()) as { interrupted: boolean };
    expect(remoteSteerJson.interrupted).toBe(false);

    // 3. Send steer(interrupt: true) locally -> aborts 001-implement and restarts 002-implement
    const interruptRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-steer-e2e/steer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "立即改用常量 api = 42",
          interrupt: true,
        }),
      }),
    );
    expect(interruptRes.status).toBe(200);
    const interruptJson = (await interruptRes.json()) as { interrupted: boolean };
    expect(interruptJson.interrupted).toBe(true);

    await waitUntil(
      () => server.store.getTaskIndex("t-steer-e2e")?.status === "done",
      "t-steer-e2e done after interrupt steer",
    );

    const runDirs = fs.readdirSync(server.store.paths.runsDir("t-steer-e2e")).sort();
    expect(runDirs).toEqual(["001-implement", "002-implement"]);

    const handoff2 = fs.readFileSync(
      server.store.paths.handoffMd("t-steer-e2e", "002-implement"),
      "utf8",
    );
    expect(handoff2).toContain("运行中补充纠偏指令（Steer，未变更契约）");
    expect(handoff2).toContain("下一棒保留向后兼容导出");
    expect(handoff2).toContain("立即改用常量 api = 42");
    expect(server.store.readTaskCard("t-steer-e2e").contract_version).toBe(1);

    // 4. Terminal state (done) rejects further steering with 409
    const doneSteerRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-steer-e2e/steer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "已完成不应允许", interrupt: false }),
      }),
    );
    expect(doneSteerRes.status).toBe(409);

    // 5. Delete index.sqlite & rebuild -> GET /api/tasks/:id still returns both steer notes
    await server.stop();
    const sqliteFile = path.join(kilnHome, "index.sqlite");
    fs.rmSync(sqliteFile, { force: true });
    fs.rmSync(`${sqliteFile}-wal`, { force: true });
    fs.rmSync(`${sqliteFile}-shm`, { force: true });

    const rebuiltServer = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      tokenSecret: "steer-test-secret-0123456789abcdef",
    });
    servers.push(rebuiltServer);
    rebuiltServer.store.rebuildIndexFromDisk();

    const detailRes = await rebuiltServer.app.request(
      new Request("http://127.0.0.1/api/tasks/t-steer-e2e"),
    );
    expect(detailRes.status).toBe(200);
    const detailJson = (await detailRes.json()) as {
      steers: Array<{ message: string; interrupt: boolean }>;
    };
    expect(detailJson.steers).toHaveLength(2);
    expect(detailJson.steers.map((s) => s.message)).toEqual([
      "下一棒保留向后兼容导出",
      "立即改用常量 api = 42",
    ]);
    expect(detailJson.steers.map((s) => s.interrupt)).toEqual([false, true]);
  });

  it("executes custom inserted workflow nodes with inline bindings, injected instructions, loop_back rework, and on_fail=continue", async () => {
    const kilnHome = makeTempDir("kiln-custom-wf-home-");
    const { repoPath, baseCommit } = initGitRepo("customwf");
    const acceptCmd = 'node -e "process.exit(0)"';
    const snap = computeFrozenSnapshot(repoPath, [], acceptCmd);
    const fakeBackend = makeEnhancementBackend();

    let implCount = 0;
    let reviewCount = 0;

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "custom-wf-test-secret-0123456789",
      approvalHandler: async (req, ctx) => {
        const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
        const token =
          fakeBackend.getRecordedSpecs().find((s) => s.runId === ctx.runId)?.mcpServers?.[0]?.env
            ?.KILN_RUN_TOKEN ?? "";

        if (req.action === "step_impl") {
          implCount += 1;
          fs.writeFileSync(
            path.join(wtPath, "src", "api.ts"),
            `export const api = ${implCount + 1};\n`,
          );
          const mcpRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: baseCommit,
                output_ref: "HEAD",
                changed_paths: ["src/api.ts"],
              }),
            }),
          });
          expect(mcpRes.status).toBe(200);
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "step_rev") {
          reviewCount += 1;
          const revRef = git(["rev-parse", "HEAD"], wtPath).trim();
          const verdict = reviewCount === 2 || reviewCount === 5 ? "changes_requested" : "pass";
          const mcpRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeReviewerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                reviewed_ref: revRef,
                verdict,
              }),
            }),
          });
          expect(mcpRes.status).toBe(200);
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
    server.store.writeConfig("limits", defaultLimits());
    await server.start();

    // Configure workflows via PUT /api/settings/workflows reusing same model across steps
    const wfConfig = createDefaultWorkflowsConfig(null);
    wfConfig.heterogeneous_review = false;
    wfConfig.stage_bindings.intake = { provider: "codex", model: "gpt-5.4", backend_id: "fake" };
    wfConfig.stage_bindings.implement = { provider: "codex", model: "gpt-5.4", backend_id: "fake" };
    wfConfig.stage_bindings.review = { provider: "codex", model: "gpt-5.4", backend_id: "fake" };
    const customTemplate = {
      id: "sec_loop",
      name: "标准开发+双步自定义审查",
      blueprint: {
        schema_version: 1 as const,
        preset: "custom" as const,
        steps: [
          {
            kind: "loop" as const,
            max_rounds: 3,
            stuck_threshold: 2,
            steps: [
              {
                kind: "agent" as const,
                stage: "implement" as const,
                role: "worker" as const,
                fresh_context: false,
              },
              { kind: "gate" as const, stage: "verify" as const, check: "full" as const },
              {
                kind: "agent" as const,
                stage: "review" as const,
                role: "reviewer" as const,
                fresh_context: true,
              },
              {
                kind: "agent" as const,
                id: "sec-gate",
                label: "安全审查",
                stage: "review" as const,
                role: "reviewer" as const,
                fresh_context: true,
                binding: {
                  provider: "claude",
                  model: "claude-sonnet-4-6",
                  backend_id: "fake",
                  effort: "high" as const,
                },
                instructions: "核查越权与凭据泄露风险",
                on_fail: "loop_back" as const,
              },
              {
                kind: "agent" as const,
                id: "style-note",
                label: "风格建议",
                stage: "review" as const,
                role: "reviewer" as const,
                fresh_context: true,
                binding: {
                  provider: "codex",
                  model: "gpt-5.4",
                  backend_id: "fake",
                  effort: "low" as const,
                },
                instructions: "仅记录风格优化建议，不阻塞合入",
                on_fail: "continue" as const,
              },
            ],
          },
          {
            kind: "command" as const,
            stage: "deliver" as const,
            apply_staged: false,
            run_deliver_cmd: false,
            verify_sha256: false,
            final_accept_gate: false,
          },
        ],
      },
    };
    wfConfig.templates.push(customTemplate);

    const putWfRes = await server.app.request(
      new Request("http://127.0.0.1/api/settings/workflows", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(wfConfig),
      }),
    );
    expect(putWfRes.status).toBe(200);
    expect(server.store.readEffectiveRosterConfig().roster.reviewer?.primary?.model).toBe(
      "gpt-5.4",
    );
    expect(server.store.readConfig("roles")?.heterogeneous_review).toBe(false);

    const bootRes = await server.app.request(new Request("http://127.0.0.1/api/bootstrap"));
    const bootJson = (await bootRes.json()) as {
      workflows: { templates: Array<{ id: string }> };
    };
    expect(bootJson.workflows.templates.some((t) => t.id === "sec_loop")).toBe(true);

    for (let i = 0; i < 2; i += 1) {
      fakeBackend.enqueueScript(
        [
          { kind: "approval", action: "step_impl", detail: "impl" },
          { kind: "exit", reason: "completed" },
        ],
        { role: "worker" },
      );
    }
    for (let i = 0; i < 5; i += 1) {
      fakeBackend.enqueueScript(
        [
          { kind: "approval", action: "step_rev", detail: "rev" },
          { kind: "exit", reason: "completed" },
        ],
        { role: "reviewer" },
      );
    }

    const draftRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "d-custom-wf",
          title: "自定义安全审查节点端到端",
          space: "kiln",
          priority: "P1",
          track: "L2",
          workspace_mode: "git_worktree",
          workflow: customTemplate.blueprint,
          contract: {
            goal: "验证循环内自定义步骤模型与指令及 on_fail 分流",
            end: "安全审查打回修复并通过后交付",
            accept_cmd: acceptCmd,
            accept_files_hash: snap.hash,
            scope: ["src/**"],
            non_goals: [],
            deliver: { mode: "merge_main", cmd: null },
            human_accept: false,
            external_actions: "ask",
          },
        }),
      }),
    );
    expect(draftRes.status).toBe(201);

    const commitRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-custom-wf/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "t-custom-wf",
          brief_markdown: "# Custom workflow E2E brief",
        }),
      }),
    );
    expect(commitRes.status).toBe(201);

    await waitUntil(() => {
      const st = server.store.getTaskIndex("t-custom-wf")?.status;
      return st === "done" || st === "waiting" || st === "cancelled";
    }, "t-custom-wf terminal or waiting");
    const curIdx = server.store.getTaskIndex("t-custom-wf");
    const pendings = server.pendingDecisions.listAll();
    if (curIdx?.status !== "done") {
      throw new Error(
        `Unexpected task state: ${JSON.stringify({ curIdx, pendings, implCount, reviewCount })}`,
      );
    }

    expect(implCount).toBe(2);
    expect(reviewCount).toBe(5);
    const runDirs = fs.readdirSync(server.store.paths.runsDir("t-custom-wf")).sort();
    expect(runDirs).toHaveLength(7);

    const secMeta = readYamlOptional(
      server.store.paths.runYaml("t-custom-wf", runDirs[2]!),
      RunMetaSchema,
    );
    expect(secMeta).toMatchObject({ agent: "claude", model: "claude-sonnet-4-6" });
    const secHandoff = fs.readFileSync(
      server.store.paths.handoffMd("t-custom-wf", runDirs[2]!),
      "utf8",
    );
    expect(secHandoff).toContain("槽位专属指令 (安全审查)");
    expect(secHandoff).toContain("核查越权与凭据泄露风险");

    const styleMeta = readYamlOptional(
      server.store.paths.runYaml("t-custom-wf", runDirs[6]!),
      RunMetaSchema,
    );
    expect(styleMeta).toMatchObject({ agent: "codex", model: "gpt-5.4" });
    const styleHandoff = fs.readFileSync(
      server.store.paths.handoffMd("t-custom-wf", runDirs[6]!),
      "utf8",
    );
    expect(styleHandoff).toContain("槽位专属指令 (风格建议)");
    expect(styleHandoff).toContain("仅记录风格优化建议，不阻塞合入");
  });

  it("deduplicates decisions.md in handoff, puts round>=2 review into convergence mode, and offers direct proceed option on review_escalation", async () => {
    const rawDecisions = serializeFrontmatterMarkdown(
      {
        schema_version: 1,
        id: "dec-dup-1",
        task_id: "t-dup",
        contract_version: 2,
        category: "gate_failure_escalation",
        decider: "human",
        action: "resume",
        affected_stages: ["implement"],
        rationale: "长段重复说明-ONLY-SHOULD-APPEAR-ONCE",
        decided_at: "2026-11-25T13:58:33.263Z",
      },
      [
        "## 待决问题 (dec-dup-1)",
        "",
        "### 最终决定与重跑范围",
        "",
        "- 说明: 长段重复说明-ONLY-SHOULD-APPEAR-ONCE",
      ].join("\n"),
    );
    const compacted = formatDecisionsForHandoff(rawDecisions);
    expect(compacted).toContain(
      "[裁决记录 · id=dec-dup-1 | decider=human | v2 | action=resume | at=2026-11-25T13:58:33.263Z]",
    );
    expect(compacted.match(/长段重复说明-ONLY-SHOULD-APPEAR-ONCE/g)).toHaveLength(1);

    const kilnHome = makeTempDir("kiln-rev-esc-proceed-");
    const targetDir = makeTempDir("kiln-rev-esc-host-");
    const targetFile = path.join(targetDir, "staged-target.txt");
    const fakeBackend = makeEnhancementBackend();
    let revTurn = 0;

    const server = new KilndServer({
      kilnHome,
      host: "127.0.0.1",
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "enhancements-rev-proceed-secret-0123456789",
      approvalHandler: async (req, ctx) => {
        const token =
          fakeBackend
            .getRecordedSpecs()
            .filter((s) => s.taskId === ctx.taskId)
            .at(-1)?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";
        const stagedDir = server.store.paths.stagedDir(ctx.taskId);
        fs.mkdirSync(stagedDir, { recursive: true });

        if (req.action === "host_impl") {
          fs.writeFileSync(path.join(stagedDir, "staged-target.txt"), "safe-staged-content\n");
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
                "## 改动说明\n完成暂存\n\n## 验证命令与真实输出\nok\n\n## 未完成或待决问题\n无\n",
              ),
            }),
          });
          expect(res.status).toBe(200);
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "host_rev_reject") {
          revTurn += 1;
          const defectText =
            revTurn === 1 ? "1. P1 · 理论边角竞争假想" : "1. P1 · 另一条新增低概率假想";
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
                [
                  "## 结论",
                  "仍有 P1 意见",
                  "",
                  "## 缺陷清单",
                  defectText,
                  "",
                  "## 测试真实性与复现核查",
                  "dry-run 通过",
                ].join("\n"),
              ),
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

    for (let i = 0; i < 2; i += 1) {
      fakeBackend.enqueueScript(
        [
          { kind: "approval", action: "host_impl", detail: `impl-${i + 1}` },
          { kind: "exit", reason: "completed" },
        ],
        { role: "worker" },
      );
      fakeBackend.enqueueScript(
        [
          { kind: "approval", action: "host_rev_reject", detail: `rev-${i + 1}` },
          { kind: "exit", reason: "completed" },
        ],
        { role: "reviewer" },
      );
    }

    const now = new Date().toISOString();
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-rev-proceed",
        title: "审查升级直接放行交付审批",
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
                  stage: "implement",
                  role: "worker",
                  fresh_context: false,
                  mode: "dry_run_only",
                },
                { kind: "gate", stage: "verify", check: "staged_only" },
                {
                  kind: "agent",
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
          goal: "安全暂存写入",
          end: "文件落盘通过验收",
          accept_cmd: `grep -q safe-staged-content ${targetFile}`,
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
      "# Brief",
    );

    await server.start();
    await waitUntil(
      () => server.pendingDecisions.get("t-rev-proceed")?.reason === "review_rounds_exceeded",
      "t-rev-proceed hits review_rounds_exceeded",
    );

    const rev2Handoff = fs.readFileSync(
      server.store.paths.handoffMd("t-rev-proceed", "004-review"),
      "utf8",
    );
    expect(rev2Handoff).toContain("P1 严格分级红线");
    expect(rev2Handoff).toContain("第 2 轮复核收敛模式");
    expect(rev2Handoff).toContain("上轮审查缺陷清单（本轮复核收敛基线）");
    expect(rev2Handoff).toContain("理论边角竞争假想");

    const pending = server.pendingDecisions.get("t-rev-proceed")!;
    const proceedOpt = pending.options.find((o) => o.id === "opt-accept-and-proceed");
    expect(proceedOpt).toMatchObject({
      label: "忽略剩余审查意见，直接进入交付审批",
      action: "resume",
      target_stage: "deliver",
    });

    // Choosing opt-accept-and-proceed enters the human deliver approval gate (does NOT bypass approval)
    const decideRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-rev-proceed/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision_id: pending.id,
          option_id: "opt-accept-and-proceed",
          action: "resume",
          rationale: "人工核查后忽略理论 P1，进入交付审批",
        }),
      }),
    );
    expect(decideRes.status).toBe(200);

    await waitUntil(
      () =>
        server.pendingDecisions.get("t-rev-proceed")?.category === "host_scoped_apply" ||
        server.pendingDecisions.get("t-rev-proceed")?.reason === "host_scoped_approval",
      "t-rev-proceed reaches deliver approval",
    );
    expect(fs.existsSync(targetFile)).toBe(false);
  });

  it("captures host snapshot, writes workspaces/<id>/host-snapshot.json, locks allowedWriteRoots to staged/, and enforces local intake speed rules", async () => {
    const snap = await captureHostEnvironmentSnapshot({ timeoutMs: 2500 });
    expect(snap.schema_version).toBe(1);
    expect(["ok", "unavailable"]).toContain(snap.running_processes.status);
    if (snap.running_processes.status === "ok") {
      expect(snap.running_processes.items.length).toBeGreaterThan(0);
      for (const proc of snap.running_processes.items) {
        expect(proc.name.length).toBeGreaterThan(0);
        expect(proc.name).not.toMatch(/[\r\n]/);
      }
    }

    const kilnHome = makeTempDir();
    tempDirs.push(kilnHome);
    const fakeHostTarget = path.join(kilnHome, "host-target", "report.md");

    const fakeBackend = new FakeBackend({ defaultTurnScript: [] });
    const server = new KilndServer({
      kilnHome,
      host: "127.0.0.1",
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "enhancements-host-snapshot-secret-01234567",
      approvalHandler: async (req, ctx) => {
        if (req.action === "host_impl_snap") {
          const token =
            fakeBackend
              .getRecordedSpecs()
              .filter((s) => s.taskId === ctx.taskId)
              .at(-1)?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";
          const stagedDir = server.store.paths.stagedDir(ctx.taskId);
          fs.mkdirSync(stagedDir, { recursive: true });
          fs.writeFileSync(path.join(stagedDir, "report.md"), "# Report\n", "utf8");
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
                  changed_paths: [fakeHostTarget],
                  accept_result: "skipped",
                  is_bugfix: false,
                  complexity_escalate: false,
                },
                "## 改动说明\n完成暂存\n\n## 验证命令与真实输出\nok\n\n## 未完成或待决问题\n无\n",
              ),
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
        intake: {
          backend_id: "fake",
          agent: "codex",
          model: "gpt-5.4",
          allow_full_access_fallback: false,
        },
        worker: {
          backend_id: "fake",
          agent: "codex",
          model: "gpt-5.4",
          allow_full_access_fallback: false,
        },
      },
    });
    await server.start();

    fakeBackend.enqueueScript(
      [
        { kind: "message", text: "请确认范围。" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "intake" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "host_impl_snap", detail: "impl" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );

    const draftRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "d-local-fast", space: "local" }),
      }),
    );
    expect(draftRes.status).toBe(201);
    const chatRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-local-fast/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "清理已卸载应用残留" }),
      }),
    );
    expect(chatRes.status).toBe(200);
    const intakeSpec = fakeBackend.getRecordedSpecs().find((s) => s.role === "intake");
    expect(intakeSpec?.systemPrompt).toContain("严禁在对话轮编写脚本全盘遍历");
    expect(intakeSpec?.systemPrompt).toContain("host-snapshot.json");

    server.stateMachine.createTask(
      TaskCardSchema.parse({
        schema_version: 1,
        id: "t-host-snap",
        title: "Host snapshot & staged root check",
        space: "local",
        priority: "P1",
        track: "L2",
        workspace_mode: "host_scoped",
        workflow: {
          schema_version: 1,
          preset: "host_op",
          steps: [
            {
              kind: "agent",
              stage: "implement",
              role: "worker",
              fresh_context: false,
              mode: "dry_run_only",
              roster_role: "ops_sec",
            },
            { kind: "gate", stage: "verify", check: "staged_only" },
            { kind: "approval", stage: "deliver", show: ["staged_diff", "commands"] },
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
          goal: "Stage host report safely",
          end: "Report staged",
          accept_cmd: "echo ok",
          accept_files_hash: "pending",
          scope: [fakeHostTarget],
          deliver: { mode: "manual", cmd: null },
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 200_000 },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      "# Brief\n",
    );
    await server.orchestrator.wake();

    await waitUntil(
      () => server.pendingDecisions.get("t-host-snap")?.reason === "host_scoped_approval",
      "t-host-snap reaches host_scoped_approval",
    );

    const wsSnapshotPath = path.join(kilnHome, "workspaces", "t-host-snap", "host-snapshot.json");
    expect(fs.existsSync(wsSnapshotPath)).toBe(true);
    const savedSnap = JSON.parse(fs.readFileSync(wsSnapshotPath, "utf8")) as {
      schema_version: number;
      running_processes: { status: string };
    };
    expect(savedSnap.schema_version).toBe(1);
    expect(["ok", "unavailable"]).toContain(savedSnap.running_processes.status);

    const workerSpec = fakeBackend.getRecordedSpecs().find((s) => s.taskId === "t-host-snap");
    const expectedStaged = realpathCanonical(
      path.join(kilnHome, "workspaces", "t-host-snap", "staged"),
    );
    expect(workerSpec?.allowedWriteRoots).toEqual([expectedStaged]);
    expect(workerSpec?.prompt).toContain("host-snapshot.json");
    expect(workerSpec?.prompt).toContain(
      "严禁把“0 项空动作计划”作为 outcome: completed 推入交付审批",
    );

    // Slice 3: check host_scoped_approval has opt-rework-staged & enhanced hostStagedDiffs
    const approvalDec = server.pendingDecisions.get("t-host-snap")!;
    expect(approvalDec.options.some((o) => o.id === "opt-rework-staged")).toBe(true);
    const localDetailRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-host-snap"),
    );
    const localDetail = (await localDetailRes.json()) as {
      hostStagedDiffs?: Array<{
        stagedBytes?: number;
        stagedLocalPath?: string;
        stagedPreviewText?: string;
      }>;
    };
    expect(localDetail.hostStagedDiffs?.[0]?.stagedBytes).toBeGreaterThan(0);
    expect(localDetail.hostStagedDiffs?.[0]?.stagedLocalPath).toBe(
      path.join(expectedStaged, "report.md"),
    );
    expect(localDetail.hostStagedDiffs?.[0]?.stagedPreviewText).toBe("# Report\n");

    // Rework via opt-rework-staged preserves staged/ and injects decision rationale into warm/cold implement
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "host_impl_snap", detail: "rework" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    const reworkRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-host-snap/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision_id: approvalDec.id,
          option_id: "opt-rework-staged",
          action: "resume",
          rationale: "请把 Adobe 纳入待隔离清单",
        }),
      }),
    );
    expect(reworkRes.status).toBe(200);
    await waitUntil(
      () =>
        server.pendingDecisions.get("t-host-snap")?.reason === "host_scoped_approval" &&
        server.pendingDecisions.get("t-host-snap")?.id !== approvalDec.id,
      "t-host-snap re-enters host_scoped_approval after opt-rework-staged",
    );
    const implRuns = fakeBackend.getRecordedSpecs().filter((s) => s.taskId === "t-host-snap");
    expect(implRuns.length).toBeGreaterThanOrEqual(1);
    const reworkHandoff = fs.readFileSync(
      path.join(kilnHome, "tasks", "t-host-snap", "runs", "002-implement", "HANDOFF.md"),
      "utf8",
    );
    expect(reworkHandoff).toContain("本轮退回修改裁决（必须响应）");
    expect(reworkHandoff).toContain("请把 Adobe 纳入待隔离清单");
  });

  it("allows host_scoped host_op with non-existent directory scope without trailing slash to pass staged_only gate in round 1", async () => {
    const kilnHome = makeTempDir();
    tempDirs.push(kilnHome);
    const nonExistentHostDir = path.join(realpathCanonical(kilnHome), "host-future-cleanup");
    const expectedCleanupTarget = path.join(nonExistentHostDir, "cleanup.sh");
    const expectedManifestTarget = path.join(nonExistentHostDir, "manifest.json");

    const fakeBackend = new FakeBackend({ defaultTurnScript: [] });
    const server = new KilndServer({
      kilnHome,
      host: "127.0.0.1",
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "nonexistent-host-dir-scope-secret-0123",
      approvalHandler: async (req, ctx) => {
        if (req.action === "host_impl_newdir") {
          const token =
            fakeBackend
              .getRecordedSpecs()
              .filter((s) => s.taskId === ctx.taskId)
              .at(-1)?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";
          const stagedDir = server.store.paths.stagedDir(ctx.taskId);
          const nestedDir = path.join(stagedDir, toHostStagedRelativePath(nonExistentHostDir));
          fs.mkdirSync(nestedDir, { recursive: true });
          fs.writeFileSync(path.join(nestedDir, "cleanup.sh"), "#!/bin/bash\necho dry-run\n");
          fs.writeFileSync(path.join(nestedDir, "manifest.json"), '{"targets":["a"]}\n');
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
                  changed_paths: [expectedCleanupTarget, expectedManifestTarget],
                  accept_result: "skipped",
                  is_bugfix: false,
                  complexity_escalate: false,
                },
                "## 改动说明\n暂存清理脚本与清单\n\n## 验证命令与真实输出\nbash -n ok\n\n## 未完成或待决问题\n无\n",
              ),
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
      },
    });
    await server.start();

    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "host_impl_newdir", detail: "stage files under future dir" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-host-newdir-e2e", role: "worker" },
    );

    server.stateMachine.createTask(
      TaskCardSchema.parse({
        schema_version: 1,
        id: "t-host-newdir-e2e",
        title: "Stage host cleanup scripts into uncreated dir",
        space: "local",
        priority: "P2",
        track: "L2",
        workspace_mode: "host_scoped",
        workflow: {
          schema_version: 1,
          preset: "host_op",
          steps: [
            {
              kind: "agent",
              stage: "implement",
              role: "worker",
              fresh_context: false,
              mode: "dry_run_only",
              roster_role: "ops_sec",
            },
            { kind: "gate", stage: "verify", check: "staged_only" },
            { kind: "approval", stage: "deliver", show: ["staged_diff", "commands"] },
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
          goal: "Stage multiple files inside uncreated host directory",
          end: "Files staged and awaiting approval",
          accept_cmd: "echo ok",
          accept_files_hash: "pending",
          scope: [nonExistentHostDir],
          deliver: { mode: "manual", cmd: null },
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 200_000 },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      "# Brief\n",
    );
    await server.orchestrator.wake();

    await waitUntil(
      () => server.pendingDecisions.get("t-host-newdir-e2e")?.reason === "host_scoped_approval",
      "t-host-newdir-e2e reaches host_scoped_approval in round 1",
    );

    const detailRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-host-newdir-e2e"),
    );
    const detail = (await detailRes.json()) as {
      runs: Array<{ gate?: { scope_ok: boolean; out_of_scope_paths: string[] } | null }>;
      pendingDecision?: { reason: string } | null;
      hostStagedDiffs?: Array<{ targetPath: string }>;
    };
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]?.gate?.scope_ok).toBe(true);
    expect(detail.runs[0]?.gate?.out_of_scope_paths).toEqual([]);
    expect(detail.pendingDecision?.reason).toBe("host_scoped_approval");
    expect(detail.hostStagedDiffs?.map((d) => d.targetPath).sort()).toEqual(
      [expectedCleanupTarget, expectedManifestTarget].sort(),
    );
    expect(fs.existsSync(nonExistentHostDir)).toBe(false);
  });

  it("uses 2_000_000 as default max_card_tokens and prioritizes forward progression when gatePassed hits max_tokens_exceeded", async () => {
    const kilnHome = makeTempDir("kiln-tokencap-gatepass-");
    const { repoPath, baseCommit } = initGitRepo("tokencap-gatepass");
    const acceptCmd =
      "node -e \"const fs=require('fs'); process.exit(fs.readFileSync('src/api.ts','utf8').includes('2') ? 0 : 1)\"";
    const snap = computeFrozenSnapshot(repoPath, [], acceptCmd);
    const fakeBackend = new FakeBackend();

    const server = new KilndServer({
      kilnHome,
      host: "127.0.0.1",
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "tokencap-gatepass-secret-0123456789abcd",
      approvalHandler: async (req, ctx) => {
        const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
        const token =
          fakeBackend.getRecordedSpecs().find((s) => s.runId === ctx.runId)?.mcpServers?.[0]?.env
            ?.KILN_RUN_TOKEN ?? "";

        if (req.action === "worker_over_cap") {
          fs.writeFileSync(path.join(wtPath, "src", "api.ts"), "export const api = 2;\n");
          server.store.recordChatUsage(
            { runId: ctx.runId, taskId: ctx.taskId, stage: "implement" },
            {
              kind: "usage",
              at: new Date().toISOString(),
              turnId: "turn-over-cap",
              agent: "codex",
              model: "gpt-5.4",
              inputTokens: 12_000,
              cachedInputTokens: 0,
              outputTokens: 1_000,
              reasoningTokens: 0,
            },
          );
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
                changed_paths: ["src/api.ts"],
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
    expect(resolveCardLimits(server.store).max_tokens).toBe(2_000_000);
    await server.start();

    fakeBackend.enqueueScript(
      [
        {
          kind: "approval",
          action: "worker_over_cap",
          detail: "write api.ts and exceed max_tokens",
        },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-worker-gate-pass-tokencap", role: "worker" },
    );

    server.stateMachine.createTask(
      TaskCardSchema.parse({
        schema_version: 1,
        id: "t-worker-gate-pass-tokencap",
        title: "Worker gate pass over token cap",
        space: "kiln",
        priority: "P2",
        track: "L2",
        workspace_mode: "git_worktree",
        contract_version: 1,
        contract: {
          goal: "Modify api.ts cleanly",
          end: "api.ts returns 2",
          accept_cmd: acceptCmd,
          accept_files_hash: snap.hash,
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 10_000 },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      "# Brief\n",
    );
    await server.orchestrator.wake();

    await waitUntil(
      () =>
        server.pendingDecisions.get("t-worker-gate-pass-tokencap")?.reason ===
        "max_tokens_exceeded",
      "t-worker-gate-pass-tokencap pauses at max_tokens_exceeded after passing gate",
    );

    const pending = server.pendingDecisions.get("t-worker-gate-pass-tokencap");
    expect(pending).toBeTruthy();
    expect(pending?.category).toBe("gate_failure_escalation");
    expect(pending?.question).toContain("实施与确定性门禁已通过");
    expect(pending?.options[0]).toMatchObject({
      id: "opt-send-review",
      action: "resume",
      target_stage: "review",
      recommended: true,
    });
    expect(pending?.options.find((o) => o.id === "opt-retry-implement")?.recommended).toBe(false);
  });

  it("includes failed deliver command stderr excerpt in host_apply_deliver_cmd_failed_rolled_back decision question", async () => {
    const kilnHome = makeTempDir();
    tempDirs.push(kilnHome);
    const hostTargetDir = makeTempDir();
    tempDirs.push(hostTargetDir);
    const targetFile = path.join(hostTargetDir, "apply.sh");
    fs.writeFileSync(targetFile, "echo original\n", "utf8");

    const fakeBackend = new FakeBackend({ defaultTurnScript: [] });
    let server: KilndServer;
    server = new KilndServer({
      kilnHome,
      host: "127.0.0.1",
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "enhancements-deliver-stderr-secret-0123",
      approvalHandler: async (req, ctx) => {
        if (req.action === "host_impl_fail_deliver") {
          const token =
            fakeBackend
              .getRecordedSpecs()
              .filter((s) => s.taskId === ctx.taskId)
              .at(-1)?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";
          const stagedDir = server.store.paths.stagedDir(ctx.taskId);
          fs.mkdirSync(stagedDir, { recursive: true });
          fs.writeFileSync(path.join(stagedDir, "apply.sh"), "echo updated\n", "utf8");
          const receiptRes = await server.invokeMcpRpc({
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
                "## 改动说明\nstaged apply.sh\n\n## 验证命令与真实输出\ndry run ok\n\n## 未完成或待决问题\n无\n",
              ),
            }),
          });
          expect(receiptRes.status).toBe(200);
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
      },
    });

    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "host_impl_fail_deliver", detail: "stage apply.sh" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-host-deliver-stderr", role: "worker" },
    );

    const now = new Date().toISOString();
    server.stateMachine.createTask(
      TaskCardSchema.parse({
        schema_version: 1,
        id: "t-host-deliver-stderr",
        title: "Host deliver stderr surface",
        space: "local",
        priority: "P2",
        track: "L1",
        workspace_mode: "host_scoped",
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
                  stage: "implement",
                  role: "worker",
                  fresh_context: false,
                  mode: "dry_run_only",
                },
                { kind: "gate", stage: "verify", check: "staged_only" },
              ],
            },
            { kind: "approval", stage: "deliver", show: ["staged_diff", "commands"] },
            {
              kind: "command",
              stage: "deliver",
              apply_staged: true,
              run_deliver_cmd: true,
              verify_sha256: true,
              final_accept_gate: true,
            },
          ],
        },
        contract_version: 1,
        contract: {
          goal: "Run post-apply script",
          end: "Delivered",
          accept_cmd: `test -f ${JSON.stringify(targetFile)}`,
          accept_files_hash: "pending",
          scope: [targetFile],
          deliver: {
            mode: "run_cmd",
            cmd: `node -e 'process.stderr.write("ENOENT: Spark Desktop missing\\n"); process.exit(1);'`,
          },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 0, max_tokens: 1_000_000 },
        created_at: now,
        updated_at: now,
      }),
      "# Brief",
    );

    await server.start();
    await waitUntil(
      () => server.pendingDecisions.get("t-host-deliver-stderr")?.reason === "host_scoped_approval",
      "t-host-deliver-stderr awaits host_scoped_approval",
    );

    const approval = server.pendingDecisions.get("t-host-deliver-stderr")!;
    const approveRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-host-deliver-stderr/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision_id: approval.id,
          option_id: "opt-apply-host",
          action: "resume",
          rationale: "approve",
        }),
      }),
    );
    expect(approveRes.status).toBe(200);

    await waitUntil(
      () =>
        server.pendingDecisions.get("t-host-deliver-stderr")?.reason ===
        "host_apply_deliver_cmd_failed_rolled_back",
      "t-host-deliver-stderr surfaces rolled-back error decision",
    );

    const rollbackDecision = server.pendingDecisions.get("t-host-deliver-stderr")!;
    expect(rollbackDecision.question).toContain("命令输出摘要");
    expect(rollbackDecision.question).toContain("ENOENT: Spark Desktop missing");
    expect(fs.readFileSync(targetFile, "utf8")).toBe("echo original\n");
  });
});
