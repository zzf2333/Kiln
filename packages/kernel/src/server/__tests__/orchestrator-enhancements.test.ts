import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GateReportSchema,
  RosterConfigSchema,
  RunMetaSchema,
  createDefaultWorkflowsConfig,
  serializeFrontmatterMarkdown,
  type LimitsConfig,
  type RosterConfig,
  type TaskCard,
} from "@kiln/protocol";
import { FakeBackend } from "../../backend/index.js";
import { computeFrozenSnapshot } from "../../gate/index.js";
import { KilnStore, deriveTaskStatus, readYamlOptional } from "../../store/index.js";
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
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
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
});
