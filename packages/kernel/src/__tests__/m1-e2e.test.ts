import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HashMismatchErrorSchema,
  RoleForbiddenErrorSchema,
  SseEventSchema,
  serializeFrontmatterMarkdown,
  type LimitsConfig,
  type PricingConfig,
  type RolesConfig,
  type SseEvent,
  type TaskCard,
} from "@kiln/protocol";
import { FakeBackend } from "../backend/index.js";
import {
  applyApprovedHostScopedChanges,
  cleanupGitWorktree,
  computeFrozenSnapshot,
  prepareGitWorktree,
  runVerificationGate,
  stageHostScopedChanges,
} from "../gate/index.js";
import { KilnScheduler, type DispatchPlan } from "../scheduler/index.js";
import { KilndServer } from "../server/index.js";
import { evaluateWorkerStageOutcome } from "../state/index.js";
import { deriveTaskStatus, isWindowsNamedPipe, realpathCanonical, writeFileAtomic } from "../store/index.js";

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

function makeContract(overrides: Partial<TaskCard["contract"]> = {}): TaskCard["contract"] {
  return {
    goal: "Deliver verified slice",
    end: "Gate and review pass cleanly",
    accept_cmd: "node -e \"process.exit(0)\"",
    accept_files_hash: "sha256:baseline-v1",
    scope: ["src/**"],
    deliver: { mode: "merge_main", cmd: null },
    human_accept: false,
    external_actions: "ask",
    ...overrides,
  };
}

function makeCard(id: string, overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    schema_version: 1,
    id,
    title: `Task ${id}`,
    space: "kiln",
    priority: "P2",
    track: "L2",
    workspace_mode: "git_worktree",
    parent: null,
    depends_on: [],
    contract_version: 1,
    contract: makeContract(),
    limits: {
      retries_per_stage: 2,
      review_rounds: 2,
      advisor_calls: 1,
      max_tokens: 250_000,
    },
    created_at: "2026-11-19T12:00:00.000Z",
    updated_at: "2026-11-19T12:00:00.000Z",
    ...overrides,
  };
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

function parseSseFrames(text: string): Array<{ id: number; event: string; data: SseEvent }> {
  const frames: Array<{ id: number; event: string; data: SseEvent }> = [];
  for (const block of text.split("\n\n").filter((b) => b.trim().length > 0)) {
    let id = -1;
    let event = "";
    let dataRaw = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) id = Number(line.slice(4));
      else if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) dataRaw = line.slice(6);
    }
    frames.push({ id, event, data: SseEventSchema.parse(JSON.parse(dataRaw)) });
  }
  return frames;
}

describe("M1 zero-token full-stack headless kernel E2E", () => {
  const tempDirs: string[] = [];
  const servers: KilndServer[] = [];

  function makeTempDir(prefix = "kiln-m1-e2e-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()!.stop();
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("satisfies all 7 M1 exit criteria end-to-end with zero tokens and survives full index.sqlite rebuild", async () => {
    const kilnHome = makeTempDir("kiln-m1-home-");
    const repoRoot = makeTempDir("kiln-m1-repo-");
    const hostRoot = makeTempDir("kiln-m1-host-");
    const hostTargetLocked = path.join(hostRoot, "locked.conf");
    fs.writeFileSync(hostTargetLocked, "LOCK_BASE=1\n");
    const canonicalLocked = realpathCanonical(hostTargetLocked);

    // Initialize real Git repository + bare remote
    const bareRemote = path.join(repoRoot, "remote.git");
    const repoPath = path.join(repoRoot, "repo");
    git(["init", "--bare", bareRemote]);
    git(["init", "-b", "main", repoPath]);
    git(["config", "user.name", "Kiln E2E"], repoPath);
    git(["config", "user.email", "kiln-e2e@example.com"], repoPath);
    git(["config", "core.autocrlf", "false"], repoPath);
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.mkdirSync(path.join(repoPath, "tests"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, ".env.local"), "APP_MODE=test\n");
    fs.writeFileSync(path.join(repoPath, ".gitignore"), ".env.local\n");
    fs.writeFileSync(path.join(repoPath, "src", "feature.ts"), "export const v = 1;\n");
    fs.writeFileSync(path.join(repoPath, "tests", "frozen.test.ts"), "export const lock = 1;\n");
    git(["add", "."], repoPath);
    git(["commit", "-m", "init"], repoPath);
    git(["remote", "add", "origin", bareRemote], repoPath);
    git(["push", "-u", "origin", "main"], repoPath);
    const baseCommit = git(["rev-parse", "HEAD"], repoPath).trim();

    const server1 = new KilndServer({
      kilnHome,
      port: 0,
      tokenSecret: "m1-e2e-hmac-secret-key-0123456789",
    });
    servers.push(server1);

    const fakeBackend = new FakeBackend({
      turnScripts: [
        [
          { kind: "thinking" },
          { kind: "message", text: "Implemented delta ", delta: true },
          { kind: "message", text: "done.", delta: true },
          {
            kind: "usage",
            turnId: "turn-e2e-1",
            inputTokens: 1_000_000,
            cachedInputTokens: 200_000,
            outputTokens: 50_000,
          },
          { kind: "exit", reason: "completed" },
        ],
      ],
    });
    server1.backendRegistry.register(fakeBackend);

    // Seed space, roles (with colliding worker/reviewer triggering heterogeneous fallback), limits, pricing
    server1.store.writeSpace({
      schema_version: 1,
      id: "kiln",
      name: "Kiln",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [".env.local"],
      clone_deps: [],
      freeze_patterns: ["tests/*.test.ts"],
    });
    const rolesConfig: RolesConfig = {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        intake: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
        worker: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
        reviewer: {
          agent: "codex",
          model: "gpt-5.4",
          avoid_same_model_as: "worker",
          allow_full_access_fallback: false,
          fallback: { agent: "pi", model: "magpie/group/work" },
        },
      },
    };
    const limitsConfig: LimitsConfig = {
      schema_version: 1,
      max_concurrent_slots: 2,
      p0_extra_slot: true,
      max_waiting_wip: 2,
      retries_per_stage: 2,
      review_rounds: 2,
      advisor_calls: 1,
      max_card_tokens: 250_000,
    };
    const pricingConfig: PricingConfig = {
      schema_version: 1,
      models: {
        "gpt-5.4": { in: 1.25, cached: 0.125, out: 10 },
      },
    };
    server1.store.writeConfig("roles", rolesConfig);
    server1.store.writeConfig("limits", limitsConfig);
    server1.store.writeConfig("pricing", pricingConfig);

    const addr1 = await server1.start();
    // Criterion 6a: Unix socket permissions 0600 on POSIX
    if (!isWindowsNamedPipe(addr1.socketPath)) {
      expect(fs.statSync(addr1.socketPath).mode & 0o777).toBe(0o600);
    }

    // ── Criterion 3 + FakeBackend + pre-push hook + L1 -> L2 escalation + heterogeneous fallback ──
    const acceptCmd = "node -e \"process.exit(0)\"";
    const baselineSnap = computeFrozenSnapshot(repoPath, ["tests/*.test.ts"], acceptCmd);
    const cardL1 = makeCard("t-l1-freeze", {
      track: "L1",
      priority: "P1",
      contract: makeContract({
        accept_cmd: acceptCmd,
        accept_files_hash: baselineSnap.hash,
        scope: ["src/**"],
      }),
    });
    server1.stateMachine.createTask(cardL1, "# L1 Freeze Test");

    const dispatches: DispatchPlan[] = [];
    const agentCaps = new Map(
      (await fakeBackend.listAgents()).map((agent) => [agent.id, agent.capabilities] as const),
    );
    const scheduler = new KilnScheduler({
      store: server1.store,
      stateMachine: server1.stateMachine,
      agentCapabilitiesMap: agentCaps,
      onDispatch: async (plan) => {
        dispatches.push(plan);
      },
    });
    await scheduler.start();

    try {
      const tick1 = await scheduler.wake();
      expect(tick1.dispatched.map((d) => d.taskId)).toContain("t-l1-freeze");
      const firstPlan = tick1.dispatched.find((d) => d.taskId === "t-l1-freeze")!;
      expect(firstPlan.role).toBe("worker");
      expect(firstPlan.roleAssignment?.agent).toBe("codex");

      const wtDir = path.join(repoRoot, "wt-l1");
      const prep = await prepareGitWorktree({
        repoPath,
        worktreePath: wtDir,
        branchName: "kiln/t-l1-freeze",
        baseRef: baseCommit,
        copyUntracked: [".env.local"],
      });
      expect(fs.existsSync(path.join(prep.worktreePath, ".env.local"))).toBe(true);

      // pre-push hook blocks push from task worktree
      expect(() => git(["push", "origin", "HEAD"], prep.worktreePath)).toThrow();

      // Run FakeBackend turn & stream usage event into RUN.yaml events.ndjson
      const sessionRef = await fakeBackend.start({
        runId: "run-l1-1",
        taskId: cardL1.id,
        role: "worker",
        agent: "codex",
        model: "gpt-5.4",
        cwd: prep.worktreePath,
        prompt: "Implement feature",
        freshContext: false,
      });
      server1.persistRunForDispatch(
        {
          schema_version: 1,
          run_id: "run-l1-1",
          task_id: cardL1.id,
          stage: "implement",
          round: 1,
          role: "worker",
          contract_version: 1,
          backend_id: "fake",
          agent: "codex",
          model: "gpt-5.4",
          session_ref: sessionRef,
          input_ref: baseCommit,
          started_at: "2026-11-19T12:01:00.000Z",
        },
        "001-implement",
      );
      for await (const ev of fakeBackend.events(sessionRef)) {
        server1.store.recordRunEvent(cardL1.id, "001-implement", ev);
      }

      // Criterion 1 & 6b: Concurrent runner lease conflict + 403 role_forbidden + stale receipt archiving
      const secondAcquire = server1.store.persistRunBeforeDispatch(
        {
          schema_version: 1,
          run_id: "run-l1-competing",
          task_id: cardL1.id,
          stage: "implement",
          round: 1,
          role: "worker",
          contract_version: 1,
          backend_id: "fake",
          agent: "codex",
          model: "gpt-5.4",
          session_ref: { backendId: "fake", sessionId: "sess-loser" },
          input_ref: baseCommit,
          started_at: "2026-11-19T12:01:05.000Z",
        },
        "002-implement-loser",
      );
      expect(secondAcquire).toEqual({ acquired: false, activeRunId: "run-l1-1" });

      const workerToken = server1.issueRunToken({
        taskId: cardL1.id,
        runId: "run-l1-1",
        role: "worker",
        contractVersion: 1,
      });

      const forbiddenPlan = await server1.invokeMcpRpc({
        method: "POST",
        url: "/rpc/mcp/wb_plan",
        headers: { authorization: `Bearer ${workerToken}` },
        rawBody: JSON.stringify({ mode: "upsert_draft", draft_id: "d-bad" }),
      });
      expect(forbiddenPlan.status).toBe(403);
      expect(RoleForbiddenErrorSchema.parse(forbiddenPlan.body).code).toBe("role_forbidden");

      // wb_propose_ledger never pollutes ledger/<space>.yaml
      const proposeRes = await server1.invokeMcpRpc({
        method: "POST",
        url: "/rpc/mcp/wb_propose_ledger",
        headers: { authorization: `Bearer ${workerToken}` },
        rawBody: JSON.stringify({
          space: "kiln",
          rule: "Keep freeze tests immutable during L1",
          rationale: "Audit trail",
        }),
      });
      expect(proposeRes.status).toBe(200);
      expect(server1.store.readLedger("kiln")).toBeNull();

      // Edit BOTH src/feature.ts AND frozen tests/frozen.test.ts (dishonestly omit from changed_paths)
      fs.writeFileSync(path.join(prep.worktreePath, "src", "feature.ts"), "export const v = 2;\n");
      fs.writeFileSync(
        path.join(prep.worktreePath, "tests", "frozen.test.ts"),
        "export const lock = 999;\n",
      );
      const outputRef = git(["rev-parse", "HEAD"], prep.worktreePath).trim();
      const receiptMd = makeWorkerReceiptMarkdown({
        run_id: "run-l1-1",
        contract_version: 1,
        input_ref: baseCommit,
        output_ref: outputRef,
        changed_paths: ["src/feature.ts"],
        accept_result: "pass",
      });

      const submitWinner = await server1.invokeMcpRpc({
        method: "POST",
        url: "/rpc/mcp/wb_submit_receipt",
        headers: { authorization: `Bearer ${workerToken}` },
        rawBody: JSON.stringify({ markdown: receiptMd }),
      });
      expect(submitWinner.status).toBe(200);
      expect((submitWinner.body as { accepted: boolean }).accepted).toBe(true);

      // Competing/duplicate receipt -> archived to history/
      const submitLoser = await server1.invokeMcpRpc({
        method: "POST",
        url: "/rpc/mcp/wb_submit_receipt",
        headers: { authorization: `Bearer ${workerToken}` },
        rawBody: JSON.stringify({ markdown: `${receiptMd}\n\n# duplicate` }),
      });
      expect(submitLoser.status).toBe(200);
      expect((submitLoser.body as { accepted: boolean }).accepted).toBe(false);
      expect(
        fs.existsSync((submitLoser.body as { archivedPath: string }).archivedPath),
      ).toBe(true);

      // Gate detects tampered frozen test outside scope -> escalated_to_l2: true
      const gateResult = await runVerificationGate(server1.store, {
        taskId: cardL1.id,
        runDirName: "001-implement",
        worktreePath: prep.worktreePath,
        baselineSnapshot: baselineSnap,
      });
      expect(gateResult.passed).toBe(false);
      expect(gateResult.report.scope_ok).toBe(false);
      expect(gateResult.report.frozen_files_changed).toContain("tests/frozen.test.ts");
      expect(gateResult.report.escalated_to_l2).toBe(true);

      const stageEval = evaluateWorkerStageOutcome(
        cardL1,
        {
          run_id: "run-l1-1",
          contract_version: 1,
          outcome: "completed",
          input_ref: baseCommit,
          output_ref: outputRef,
          changed_paths: ["src/feature.ts"],
          accept_result: "pass",
          is_bugfix: false,
          complexity_escalate: false,
        },
        gateResult.report,
        { stageRetries: 0, reviewRounds: 0, advisorCalls: 0, totalTokens: 0 },
      );
      expect(stageEval.escalateToL2).toBe(true);
      expect(stageEval.effectiveTrack).toBe("L2");

      // Escalate L1 -> L2: completed worker lease cannot retroactively ask decision (409),
      // so kernel dispatches triage to escalate to human decide(resume, target_stage: "review") + bumpContractVersion
      server1.stateMachine.escalateTrackToL2(cardL1.id, "frozen_files_changed");
      const staleWorkerAsk = await server1.invokeMcpRpc({
        method: "POST",
        url: "/rpc/mcp/wb_ask_decision",
        headers: { authorization: `Bearer ${workerToken}` },
        rawBody: JSON.stringify({
          category: "frozen_test_escalation",
          reason: "Should reject completed lease",
          question: "Approve?",
          options: [
            {
              id: "opt-bump-review",
              label: "Approve",
              action: "resume",
              target_stage: "review",
              recommended: true,
            },
          ],
        }),
      });
      expect(staleWorkerAsk.status).toBe(409);

      const triageDispatch = server1.persistRunForDispatch(
        {
          schema_version: 1,
          run_id: "run-l1-triage-1",
          task_id: cardL1.id,
          stage: "triage",
          round: 1,
          role: "triage",
          contract_version: 1,
          backend_id: "fake",
          agent: "codex",
          model: "gpt-5.4",
          session_ref: { backendId: "fake", sessionId: "sess-triage-1" },
          input_ref: outputRef,
          started_at: "2026-11-19T12:02:00.000Z",
        },
        "002-triage",
      );
      expect(triageDispatch).toEqual({ acquired: true });
      const triageToken = server1.issueRunToken({
        taskId: cardL1.id,
        runId: "run-l1-triage-1",
        role: "triage",
        contractVersion: 1,
      });

      const askBump = await server1.invokeMcpRpc({
        method: "POST",
        url: "/rpc/mcp/wb_ask_decision",
        headers: { authorization: `Bearer ${triageToken}` },
        rawBody: JSON.stringify({
          category: "frozen_test_escalation",
          reason: "Scope & frozen test touched",
          question: "Approve new scope and move to review?",
          options: [
            {
              id: "opt-bump-review",
              label: "Approve updated scope & send to review",
              action: "resume",
              target_stage: "review",
              recommended: true,
            },
          ],
        }),
      });
      expect(askBump.status).toBe(200);
      const bumpDecId = (askBump.body as { decision: { id: string } }).decision.id;

      const decideRes = await server1.app.request(
        new Request(`http://127.0.0.1/api/tasks/${cardL1.id}/decide`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision_id: bumpDecId,
            option_id: "opt-bump-review",
            contractUpdate: {
              contractPatch: { scope: ["src/**", "tests/**"] },
              affectedStages: ["review"],
            },
          }),
        }),
      );
      expect(decideRes.status).toBe(200);
      expect(server1.store.readTaskCard(cardL1.id)).toMatchObject({
        contract_version: 2,
        track: "L2",
      });

      // Criterion 2: Old v1 receipt rejected after contract bump
      const staleV1Submit = server1.store.submitReceipt({
        taskId: cardL1.id,
        runId: "run-l1-1",
        contractVersion: 1,
        runDirName: "001-implement",
        markdown: "# Stale v1 after contract bump",
      });
      expect(staleV1Submit.accepted).toBe(false);

      // Scheduler now dispatches review stage -> heterogeneous fallback selects (pi, magpie/group/work) with freshContext=true!
      const reviewTick = await scheduler.wake();
      const reviewPlan = reviewTick.dispatched.find((d) => d.taskId === cardL1.id);
      expect(reviewPlan?.stage).toBe("review");
      expect(reviewPlan?.role).toBe("reviewer");
      expect(reviewPlan?.roleAssignment?.agent).toBe("pi");
      expect(reviewPlan?.roleAssignment?.model).toBe("magpie/group/work");
      expect(reviewPlan?.roleAssignment?.usedFallback).toBe(true);
      expect(reviewPlan?.roleAssignment?.freshContext).toBe(true);

      // Worktree still dirty -> cleanup refuses deletion
      const dirtyCleanup = await cleanupGitWorktree({
        repoPath,
        worktreePath: prep.worktreePath,
        taskStatus: "done",
        gatePassed: true,
        awaitingHumanReview: false,
      });
      expect(dirtyCleanup.deleted).toBe(false);
      expect(dirtyCleanup.retainedReason).toBe("dirty_worktree");

      // Leave t-l1-freeze actively running for rebuild test below
      server1.persistRunForDispatch(
        {
          schema_version: 1,
          run_id: "run-l1-review-v2",
          task_id: cardL1.id,
          stage: "review",
          round: 1,
          role: "reviewer",
          contract_version: 2,
          backend_id: "fake",
          agent: "pi",
          model: "magpie/group/work",
          session_ref: {
            backendId: "fake",
            sessionId: "sess-review-live",
            meta: { mode: "none" },
          },
          input_ref: outputRef,
          started_at: "2026-11-19T12:03:00.000Z",
        },
        "003-review",
      );

      // ── Criterion 4: paused isolation & upstream_cancelled cascade ──
      server1.stateMachine.createTask(makeCard("t-up", { priority: "P2" }), "# Up");
      server1.stateMachine.createTask(
        makeCard("t-down", { priority: "P2", depends_on: ["t-up"] }),
        "# Down",
      );
      server1.stateMachine.createTask(makeCard("t-paused", { priority: "P2" }), "# Paused");
      server1.stateMachine.pauseTask("t-paused", "user_paused");
      expect(server1.store.getTaskIndex("t-paused")?.status).toBe("paused");
      expect(fs.existsSync(server1.store.paths.decisionsMd("t-paused"))).toBe(false);
      expect(server1.store.readLedger("kiln")).toBeNull();

      const cancelUpRes = await server1.app.request(
        new Request("http://127.0.0.1/api/tasks/t-up/cancel", { method: "POST" }),
      );
      expect(cancelUpRes.status).toBe(200);
      expect(server1.store.getTaskIndex("t-down")?.status).toBe("waiting");
      expect(server1.store.readStateEvents("t-down").at(-1)).toMatchObject({
        type: "waiting",
        reason: "upstream_cancelled",
      });

      // ── Criterion 5: host_scoped verify rollback + HTTP 409 hash_mismatch + rebuild lock recovery ──
      const hostTargetApplied = path.join(hostRoot, "applied.conf");
      fs.writeFileSync(hostTargetApplied, "BASE=1\n");
      const canonicalApplied = realpathCanonical(hostTargetApplied);

      server1.stateMachine.createTask(
        makeCard("t-host-applied", {
          workspace_mode: "host_scoped",
          contract: makeContract({ scope: [canonicalApplied] }),
        }),
        "# Host applied",
      );
      writeFileAtomic(
        path.join(server1.store.paths.stagedDir("t-host-applied"), "applied.conf"),
        "APPLIED=2\n",
      );
      expect(
        stageHostScopedChanges(server1.store, {
          taskId: "t-host-applied",
          contractScope: [canonicalApplied],
          stagedFiles: [{ stagedRelativePath: "applied.conf", targetPath: hostTargetApplied }],
        }).ok,
      ).toBe(true);

      // Verify command fails -> automatic rollback
      const failedApply = await applyApprovedHostScopedChanges(server1.store, {
        taskId: "t-host-applied",
        approved: true,
        verifyCmd: "node -e \"process.exit(1)\"",
      });
      expect(failedApply.ok).toBe(false);
      if (failedApply.ok) throw new Error("Expected verify_failed_rolled_back");
      expect(failedApply.reason).toBe("verify_failed_rolled_back");
      expect(fs.readFileSync(canonicalApplied, "utf8")).toBe("BASE=1\n");

      // Re-stage & apply with passing verify -> succeeds -> external edit -> HTTP 409 hash_mismatch
      expect(
        stageHostScopedChanges(server1.store, {
          taskId: "t-host-applied",
          contractScope: [canonicalApplied],
          stagedFiles: [{ stagedRelativePath: "applied.conf", targetPath: hostTargetApplied }],
        }).ok,
      ).toBe(true);
      expect(
        (
          await applyApprovedHostScopedChanges(server1.store, {
            taskId: "t-host-applied",
            approved: true,
            verifyCmd: "node -e \"process.exit(0)\"",
          })
        ).ok,
      ).toBe(true);
      expect(fs.readFileSync(canonicalApplied, "utf8")).toBe("APPLIED=2\n");

      fs.writeFileSync(canonicalApplied, "MANUAL_HOTFIX=99\n");
      const mismatchHttp = await server1.app.request(
        new Request("http://127.0.0.1/api/tasks/t-host-applied/restore-backup", {
          method: "POST",
        }),
      );
      expect(mismatchHttp.status).toBe(409);
      const mismatchErr = HashMismatchErrorSchema.parse(await mismatchHttp.json());
      expect(mismatchErr.code).toBe("hash_mismatch");
      expect(fs.readFileSync(canonicalApplied, "utf8")).toBe("MANUAL_HOTFIX=99\n");

      // Second host_scoped task staged_awaiting_approval holding lock prior to crash + rebuild
      server1.stateMachine.createTask(
        makeCard("t-host-staged", {
          workspace_mode: "host_scoped",
          contract: makeContract({ scope: [canonicalLocked] }),
        }),
        "# Host staged lock",
      );
      server1.stateMachine.createTask(
        makeCard("t-host-rival", {
          workspace_mode: "host_scoped",
          contract: makeContract({ scope: [canonicalLocked] }),
        }),
        "# Host rival",
      );
      writeFileAtomic(
        path.join(server1.store.paths.stagedDir("t-host-staged"), "locked.conf"),
        "STAGED=1\n",
      );
      expect(
        stageHostScopedChanges(server1.store, {
          taskId: "t-host-staged",
          contractScope: [canonicalLocked],
          stagedFiles: [{ stagedRelativePath: "locked.conf", targetPath: hostTargetLocked }],
        }).ok,
      ).toBe(true);

      // Also verify SSE Last-Event-ID replay in-process before stopping
      const abort = new AbortController();
      const sseRes = await server1.app.request(
        new Request("http://127.0.0.1/api/events?lastEventId=0", { signal: abort.signal }),
      );
      expect(sseRes.status).toBe(200);
      const reader = sseRes.body!.getReader();
      const chunk = await reader.read();
      const sseFrames = parseSseFrames(new TextDecoder().decode(chunk.value));
      expect(sseFrames.length).toBeGreaterThanOrEqual(1);
      abort.abort();
      await reader.cancel().catch(() => {});
    } finally {
      scheduler.stop();
    }

    // ── Criterion 7: Delete index.sqlite & restart KilndServer -> 100% state, lease, usage, and lock recovery ──
    await server1.stop();
    servers.pop();

    fs.rmSync(path.join(kilnHome, "index.sqlite"), { force: true });
    fs.rmSync(path.join(kilnHome, "index.sqlite-wal"), { force: true });
    fs.rmSync(path.join(kilnHome, "index.sqlite-shm"), { force: true });

    const server2 = new KilndServer({
      kilnHome,
      port: 0,
      tokenSecret: "m1-e2e-hmac-secret-key-0123456789",
    });
    servers.push(server2);
    await server2.start();

    const bootRes = await server2.app.request(new Request("http://127.0.0.1/api/bootstrap"));
    expect(bootRes.status).toBe(200);
    const bootJson = (await bootRes.json()) as {
      tasks: Array<{ id: string; status: string; track: string; contract_version: number }>;
      pendingDecisions: Array<{ task_id: string; reason: string }>;
      usage: { costUsd: number };
    };

    expect(bootJson.pendingDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ task_id: "t-down", reason: "upstream_cancelled" }),
      ]),
    );

    const l1Task = bootJson.tasks.find((t) => t.id === "t-l1-freeze");
    expect(l1Task).toMatchObject({ status: "running", track: "L2", contract_version: 2 });
    // Cost check: ((1M - 200k) * 1.25 + 200k * 0.125 + 50k * 10) / 1e6 = 1.0 + 0.025 + 0.5 = 1.525
    expect(bootJson.usage.costUsd).toBeCloseTo(1.525, 8);

    const activeLeases = server2.store.listActiveStageLeases();
    expect(activeLeases).toHaveLength(1);
    expect(activeLeases[0]?.run_id).toBe("run-l1-review-v2");
    expect(JSON.parse(activeLeases[0]!.session_ref)).toMatchObject({
      backendId: "fake",
      sessionId: "sess-review-live",
    });

    // Host path lock survives SQLite deletion & blocks rival card
    writeFileAtomic(
      path.join(server2.store.paths.stagedDir("t-host-rival"), "locked.conf"),
      "RIVAL=1\n",
    );
    const rivalStage = stageHostScopedChanges(server2.store, {
      taskId: "t-host-rival",
      contractScope: [canonicalLocked],
      stagedFiles: [{ stagedRelativePath: "locked.conf", targetPath: hostTargetLocked }],
    });
    expect(rivalStage).toEqual({
      ok: false,
      reason: "lock_conflict",
      conflicts: [{ path: canonicalLocked, heldByTaskId: "t-host-staged" }],
    });

    // Disk derivation matches SQLite status for paused & upstream_cancelled
    const pausedDerived = deriveTaskStatus(
      server2.store.readTaskCard("t-paused"),
      server2.store.readStateEvents("t-paused"),
    );
    expect(pausedDerived.status).toBe("paused");
    expect(server2.store.getTaskIndex("t-down")?.status).toBe("waiting");
  });
});
