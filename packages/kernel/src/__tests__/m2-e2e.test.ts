import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HashMismatchErrorSchema,
  RunMetaSchema,
  SseEventSchema,
  buildWorkflowPreset,
  parseAndValidateReceipt,
  serializeFrontmatterMarkdown,
  type LimitsConfig,
  type PricingConfig,
  type RolesConfig,
  type SseEvent,
  type TaskCard,
} from "@kiln/protocol";
import { FakeBackend } from "../backend/index.js";
import { computeFrozenSnapshot } from "../gate/index.js";
import { KilndServer } from "../server/index.js";
import {
  readYamlOptional,
  realpathCanonical,
  resolveDefaultIpcPath,
  writeFileAtomic,
  writeYamlAtomic,
} from "../store/index.js";

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
  is_bugfix?: boolean;
  extraFrontmatter?: Record<string, unknown>;
  extraBody?: string;
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
      is_bugfix: fields.is_bugfix ?? false,
      complexity_escalate: false,
      ...(fields.extraFrontmatter ?? {}),
    },
    [
      ...(fields.is_bugfix ? ["## 修前复现证据\n修复前运行报错 exit 1\n"] : []),
      "## 改动说明\n完成代码修改\n",
      "## 验证命令与真实输出\nexit code 0\n",
      `## 未完成或待决问题\n${fields.extraBody ?? "无"}\n`,
    ].join("\n"),
  );
}

function makeReviewerReceiptMarkdown(fields: {
  run_id: string;
  contract_version: number;
  reviewed_ref: string;
  verdict: "pass" | "changes_requested";
  p0?: number;
  p1?: number;
  p2?: number;
  summary?: string;
}): string {
  return serializeFrontmatterMarkdown(
    {
      run_id: fields.run_id,
      contract_version: fields.contract_version,
      reviewed_ref: fields.reviewed_ref,
      verdict: fields.verdict,
      p0: fields.p0 ?? 0,
      p1: fields.p1 ?? 0,
      p2: fields.p2 ?? 0,
    },
    [
      `## 结论\n${fields.summary ?? (fields.verdict === "pass" ? "审查通过" : "存在待修缺陷")}\n`,
      "## 缺陷清单\n无\n",
      "## 测试真实性与复现核查\n已核验真实执行命令\n",
    ].join("\n"),
  );
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15_000,
  describeState?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  const extra = describeState ? ` [state: ${describeState()}]` : "";
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}${extra}`);
}

function parseSseChunks(text: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const block of text.split("\n\n").filter((b) => b.trim().length > 0)) {
    let dataLine = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("data: ")) {
        dataLine = line.slice(6);
      }
    }
    if (dataLine) {
      out.push(SseEventSchema.parse(JSON.parse(dataLine)));
    }
  }
  return out;
}

describe("M2 full-stack MVP E2E scenarios (8+1 mandatory acceptance paths)", () => {
  const tempDirs: string[] = [];
  const servers: KilndServer[] = [];

  function makeTempDir(prefix = "kiln-m2-e2e-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function initGitRepo(baseName = "repo"): {
    repoPath: string;
    baseCommit: string;
  } {
    const root = makeTempDir(`kiln-m2-git-${baseName}-`);
    const bareRemote = path.join(root, "remote.git");
    const repoPath = path.join(root, "repo");
    git(["init", "--bare", bareRemote]);
    git(["init", "-b", "main", repoPath]);
    git(["config", "user.name", "Kiln M2 E2E"], repoPath);
    git(["config", "user.email", "kiln-m2@example.com"], repoPath);
    git(["config", "core.autocrlf", "false"], repoPath);
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.mkdirSync(path.join(repoPath, "tests"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "src", "app.ts"), "export const v = 1;\n");
    fs.writeFileSync(path.join(repoPath, "tests", "frozen.test.ts"), "export const ok = true;\n");
    git(["add", "."], repoPath);
    git(["commit", "-m", "init"], repoPath);
    git(["remote", "add", "origin", bareRemote], repoPath);
    git(["push", "-u", "origin", "main"], repoPath);
    const baseCommit = git(["rev-parse", "HEAD"], repoPath).trim();
    return { repoPath, baseCommit };
  }

  function defaultLimits(overrides: Partial<LimitsConfig> = {}): LimitsConfig {
    return {
      schema_version: 1,
      max_concurrent_slots: 3,
      p0_extra_slot: true,
      max_waiting_wip: 5,
      retries_per_stage: 2,
      review_rounds: 2,
      advisor_calls: 1,
      max_card_tokens: 250_000,
      ...overrides,
    };
  }

  function defaultPricing(): PricingConfig {
    return {
      schema_version: 1,
      models: {
        "gpt-5.4": { in: 1.25, cached: 0.125, out: 10 },
        "magpie/group/work": { in: 2, cached: 0.2, out: 8 },
        "gpt-6-luna": { in: 5, cached: 0.5, out: 20 },
      },
    };
  }

  function defaultRoles(): RolesConfig {
    return {
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
        resolver: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
      },
    };
  }

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()!.stop();
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("Scenario 1 & 9b/c/d: L2 full auto-delivery from intake chat -> implement -> gate -> review -> merge_main -> done with rate.tick & static UI", async () => {
    const kilnHome = makeTempDir("kiln-m2-s1-");
    const publicDir = makeTempDir("kiln-m2-pub-");
    fs.writeFileSync(path.join(publicDir, "index.html"), "<!doctype html><html><body>Kiln Live</body></html>");

    const { repoPath, baseCommit } = initGitRepo("s1");
    const acceptCmd = "node -e \"process.exit(0)\"";
    const snap = computeFrozenSnapshot(repoPath, ["tests/*.test.ts"], acceptCmd);

    const fakeBackend = new FakeBackend({
      liveViewBaseUrl: "paseo://h/local/agent",
    });

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir,
      enableOrchestrator: true,
      rateTickIntervalMs: 20,
      tokenSecret: "m2-e2e-s1-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        const token =
          fakeBackend
            .getRecordedSpecs()
            .find((s) => s.runId === ctx.runId)
            ?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";

        if (req.action === "s1_worker") {
          const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), "export const v = 2;\n");
          git(["add", "src/app.ts"], wtPath);
          git(["commit", "-m", "feat: deliver v2"], wtPath);
          const outRef = git(["rev-parse", "HEAD"], wtPath).trim();

          const mcpRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: baseCommit,
                output_ref: outRef,
                changed_paths: ["src/app.ts"],
              }),
            }),
          });
          expect(mcpRes.status).toBe(200);
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "s1_reviewer") {
          const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
          const revRef = git(["rev-parse", "HEAD"], wtPath).trim();
          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-review"))
            .sort()
            .at(-1)!;
          // Reviewer may be Pi (fallback), so write RECEIPT.md via file protocol
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeReviewerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              reviewed_ref: revRef,
              verdict: "pass",
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
      id: "kiln",
      name: "Kiln",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: ["tests/*.test.ts"],
    });
    server.store.writeConfig("roles", defaultRoles());
    server.store.writeConfig("limits", defaultLimits({ max_card_tokens: 5_000_000 }));
    server.store.writeConfig("pricing", defaultPricing());

    // Script for intake chat, worker, and reviewer
    fakeBackend.enqueueScript(
      [
        { kind: "tool", name: "wb_read_ledger", target: "kiln" },
        { kind: "message", text: "已明确目标与验收标准，可以提交立项。", delta: false },
        { kind: "exit", reason: "completed" },
      ],
      { role: "intake" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "s1_worker", detail: "implement" },
        { kind: "message", text: "Streaming delta chunk 1 ", delta: true, delayMs: 5 },
        { kind: "message", text: "Streaming delta chunk 2", delta: true, delayMs: 5 },
        {
          kind: "usage",
          turnId: "t-s1-w",
          inputTokens: 1_000_000,
          cachedInputTokens: 200_000,
          outputTokens: 50_000,
        },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "s1_reviewer", detail: "review" },
        {
          kind: "usage",
          turnId: "t-s1-r",
          inputTokens: 500_000,
          cachedInputTokens: 0,
          outputTokens: 10_000,
        },
        { kind: "exit", reason: "completed" },
      ],
      { role: "reviewer" },
    );

    await server.start();

    // Verify static hosting + /api/* 404 isolation
    const indexRes = await server.app.request(new Request("http://127.0.0.1/index.html"));
    expect(indexRes.status).toBe(200);
    expect(await indexRes.text()).toContain("Kiln Live");
    const api404 = await server.app.request(new Request("http://127.0.0.1/api/unknown-endpoint"));
    expect(api404.status).toBe(404);
    expect(api404.headers.get("content-type")).toContain("application/json");

    // Subscribe SSE before intake + execution
    const sseAbort = new AbortController();
    const sseRes = await server.app.request(
      new Request("http://127.0.0.1/api/events", { signal: sseAbort.signal }),
    );
    const reader = sseRes.body!.getReader();
    const sseEvents: SseEvent[] = [];
    const ssePump = (async () => {
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseEvents.push(...parseSseChunks(decoder.decode(value)));
      }
    })();

    // Intake draft -> chat -> commit
    await server.app.request(
      new Request("http://127.0.0.1/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "d-s1",
          title: "L2 Auto Delivery",
          space: "kiln",
          priority: "P1",
          track: "L2",
          workspace_mode: "git_worktree",
          contract: {
            goal: "Update app.ts to v2",
            end: "Merged to main",
            accept_cmd: acceptCmd,
            accept_files_hash: snap.hash,
            scope: ["src/**"],
            deliver: { mode: "merge_main", cmd: null },
          },
        }),
      }),
    );

    const chatRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-s1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "请确认是否可以立项" }),
      }),
    );
    expect(chatRes.status).toBe(200);

    const commitRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-s1/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "t-s1",
          brief_markdown: "# L2 Auto Delivery\n",
        }),
      }),
    );
    expect(commitRes.status).toBe(201);

    await waitUntil(
      () => server.store.getTaskIndex("t-s1")?.status === "done",
      "t-s1 done",
      15_000,
      () =>
        JSON.stringify({
          idx: server.store.getTaskIndex("t-s1"),
          events: server.store.readStateEvents("t-s1"),
          pending: server.pendingDecisions.get("t-s1"),
        }),
    );

    sseAbort.abort();
    await reader.cancel().catch(() => {});
    await ssePump.catch(() => {});

    // Main branch actually received the merge commit
    expect(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf8")).toBe(
      "export const v = 2;\n",
    );

    // Heterogeneous review selected Pi fallback (different from worker codex/gpt-5.4) with freshContext: true
    const specs = fakeBackend.getRecordedSpecs();
    const reviewerSpec = specs.find((s) => s.role === "reviewer");
    expect(reviewerSpec?.agent).toBe("pi");
    expect(reviewerSpec?.freshContext).toBe(true);
    expect(reviewerSpec?.mcpServers).toBeUndefined();

    // Verify exact API-equivalent cost:
    // worker (gpt-5.4): ((1M - 200k)*1.25 + 200k*0.125 + 50k*10)/1e6 = 1.525
    // reviewer (magpie/group/work): (500k*2 + 10k*8)/1e6 = 1.08
    // total = 2.605
    const detailRes = await server.app.request(new Request("http://127.0.0.1/api/tasks/t-s1"));
    const detail = (await detailRes.json()) as {
      usage: { costUsd: number };
      runs: Array<{ meta: { stage: string }; gate: unknown; receipt: string | null }>;
    };
    expect(detail.usage.costUsd).toBeCloseTo(2.605, 8);
    expect(detail.runs.map((r) => r.meta.stage)).toEqual(["implement", "review"]);
    expect(detail.runs[0]?.gate).not.toBeNull();
    expect(detail.runs[1]?.receipt).toContain("verdict: pass");
    expect(sseEvents.some((e) => e.type === "rate.tick")).toBe(true);
  });

  it("Scenario 2: Independent reviewer detects defect -> automatic rework implement round 2 -> review(approve) -> done", async () => {
    const kilnHome = makeTempDir("kiln-m2-s2-");
    const { repoPath, baseCommit } = initGitRepo("s2");
    const acceptCmd = "node -e \"process.exit(0)\"";
    const snap = computeFrozenSnapshot(repoPath, [], acceptCmd);
    const fakeBackend = new FakeBackend();

    let implRounds = 0;
    let reviewRounds = 0;

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-e2e-s2-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
        if (req.action === "s2_worker") {
          implRounds += 1;
          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-implement"))
            .sort()
            .at(-1)!;
          fs.writeFileSync(
            path.join(wtPath, "src", "app.ts"),
            `export const v = ${implRounds === 1 ? "100" : "200"};\n`,
          );
          git(["add", "src/app.ts"], wtPath);
          git(["commit", "-m", `impl round ${implRounds}`], wtPath);
          const outRef = git(["rev-parse", "HEAD"], wtPath).trim();
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeWorkerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: baseCommit,
              output_ref: outRef,
              changed_paths: ["src/app.ts"],
              is_bugfix: implRounds > 1,
            }),
          );
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "s2_reviewer") {
          reviewRounds += 1;
          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-review"))
            .sort()
            .at(-1)!;
          const revRef = git(["rev-parse", "HEAD"], wtPath).trim();
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeReviewerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              reviewed_ref: revRef,
              verdict: reviewRounds === 1 ? "changes_requested" : "pass",
              p1: reviewRounds === 1 ? 1 : 0,
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
      id: "kiln",
      name: "Kiln",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    server.store.writeConfig("roles", defaultRoles());
    server.store.writeConfig("limits", defaultLimits({ max_card_tokens: 5_000_000 }));
    server.store.writeConfig("pricing", defaultPricing());

    // Queue 2 worker scripts & 2 reviewer scripts
    for (let i = 0; i < 2; i++) {
      fakeBackend.enqueueScript(
        [{ kind: "approval", action: "s2_worker", detail: "impl" }, { kind: "exit", reason: "completed" }],
        { role: "worker" },
      );
      fakeBackend.enqueueScript(
        [{ kind: "approval", action: "s2_reviewer", detail: "rev" }, { kind: "exit", reason: "completed" }],
        { role: "reviewer" },
      );
    }

    await server.start();

    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-s2",
        title: "Auto rework loop",
        space: "kiln",
        priority: "P2",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Fix concurrency bug",
          end: "Clean review pass",
          accept_cmd: acceptCmd,
          accept_files_hash: snap.hash,
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 250_000 },
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# Rework test",
    );
    await server.orchestrator.wake();

    await waitUntil(() => server.store.getTaskIndex("t-s2")?.status === "done", "t-s2 done");
    expect(implRounds).toBe(2);
    expect(reviewRounds).toBe(2);
    expect(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf8")).toBe(
      "export const v = 200;\n",
    );
  });

  it("Scenario 3: wb_ask_decision suspends -> resolver chat -> /decide contractUpdate bumps version, archives old receipt, reruns affected stage", async () => {
    const kilnHome = makeTempDir("kiln-m2-s3-");
    const fakeBackend = new FakeBackend();
    let implAttempt = 0;

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-e2e-s3-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        const token =
          fakeBackend
            .getRecordedSpecs()
            .find((s) => s.runId === ctx.runId)
            ?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";

        if (req.action === "s3_worker") {
          implAttempt += 1;
          if (implAttempt === 1) {
            const askRes = await server.invokeMcpRpc({
              method: "POST",
              url: "/rpc/mcp/wb_ask_decision",
              headers: { Authorization: `Bearer ${token}` },
              rawBody: JSON.stringify({
                category: "scope_clarification",
                reason: "Need expanded output scope",
                question: "是否允许同时更新 docs/ 说明文件？",
                options: [
                  {
                    id: "opt-expand",
                    label: "扩大 scope 并重跑 implement",
                    action: "resume",
                    target_stage: "implement",
                    recommended: true,
                  },
                ],
              }),
            });
            expect(askRes.status).toBe(200);
            // Do not call backend.answer after wb_ask_decision aborted the active turn cleanly
            return;
          }
          const ws = server.store.paths.workspaceDir(ctx.taskId);
          writeFileAtomic(path.join(ws, "out.txt"), "v2 result\n");
          const subRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: "scratch",
                output_ref: "out.txt",
                changed_paths: ["out.txt"],
              }),
            }),
          });
          expect(subRes.status).toBe(200);
          await ctx.backend.answer(req.id, true).catch(() => {});
          return;
        }

        if (req.action === "s3_review_worker") {
          const ws = server.store.paths.workspaceDir(ctx.taskId);
          writeFileAtomic(path.join(ws, "out.txt"), "review flow result\n");
          const subRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: "scratch",
                output_ref: "out.txt",
                changed_paths: ["out.txt"],
              }),
            }),
          });
          expect(subRes.status).toBe(200);
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "s3_review_ask") {
          const askRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_ask_decision",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              category: "review_scope_clarification",
              reason: "Confirm clarified contract goal at review stage",
              question: "是否按修订后目标直接重审？",
              options: [
                {
                  id: "opt-rerereview",
                  label: "修订目标并仅重跑 review",
                  action: "resume",
                  target_stage: "review",
                  recommended: true,
                },
              ],
            }),
          });
          expect(askRes.status).toBe(200);
          return;
        }

        if (req.action === "s3_review_pass") {
          const subRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeReviewerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                reviewed_ref: "out.txt",
                verdict: "pass",
              }),
            }),
          });
          expect(subRes.status).toBe(200);
          await ctx.backend.answer(req.id, true);
        }
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    server.store.writeConfig("roles", {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        worker: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
        reviewer: { agent: "codex", model: "gpt-6-luna", allow_full_access_fallback: false },
        resolver: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
      },
    });
    server.store.writeConfig("limits", defaultLimits());

    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "s3_worker", detail: "ask" }, { kind: "exit", reason: "completed" }],
      { role: "worker", taskId: "t-s3" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "message", text: "建议将 scope 放宽到 docs/** 并升版契约。", delta: false }, { kind: "exit", reason: "completed" }],
      { role: "resolver", taskId: "t-s3" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "s3_worker", detail: "v2" }, { kind: "exit", reason: "completed" }],
      { role: "worker", taskId: "t-s3" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "s3_review_worker", detail: "impl" }, { kind: "exit", reason: "completed" }],
      { role: "worker", taskId: "t-s3-review" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "s3_review_ask", detail: "ask" }, { kind: "exit", reason: "completed" }],
      { role: "reviewer", taskId: "t-s3-review" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "s3_review_pass", detail: "pass" }, { kind: "exit", reason: "completed" }],
      { role: "reviewer", taskId: "t-s3-review" },
    );

    await server.start();

    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-s3",
        title: "Ambiguity & contract bump",
        space: "local",
        priority: "P2",
        track: "L1",
        workspace_mode: "scratch_dir",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Produce output",
          end: "Output verified",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:s3-v1",
          scope: ["out.txt"],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# S3",
    );
    await server.orchestrator.wake();

    await waitUntil(() => server.store.getTaskIndex("t-s3")?.status === "waiting", "t-s3 waiting");
    const pending = server.pendingDecisions.get("t-s3")!;
    expect(pending.question).toContain("docs/");

    // Write a legacy v1 receipt file to verify contract bump archives it to history/
    writeFileAtomic(
      server.store.paths.receiptMd("t-s3", "001-implement"),
      makeWorkerReceiptMarkdown({
        run_id: pending.run_id!,
        contract_version: 1,
        input_ref: "scratch",
        output_ref: "out.txt",
        changed_paths: ["out.txt"],
      }),
    );

    // Resolver chat works and persists
    const resolveChatRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-s3/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "如果放宽 scope 会重跑哪些阶段？" }),
      }),
    );
    expect(resolveChatRes.status).toBe(200);

    // Decide with contractUpdate -> bumps contract_version to 2, archives old receipt, reruns implement -> done
    const decideRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-s3/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision_id: pending.id,
          option_id: "opt-expand",
          action: "resume",
          apply_ledger_rule: false,
          contract_update: {
            contract_patch: { scope: ["out.txt", "docs/**"] },
            affected_stages: ["implement"],
          },
        }),
      }),
    );
    expect(decideRes.status).toBe(200);

    await waitUntil(() => server.store.getTaskIndex("t-s3")?.status === "done", "t-s3 done");
    expect(server.store.readTaskCard("t-s3").contract_version).toBe(2);
    const historyDir = server.store.paths.runHistoryDir("t-s3", "001-implement");
    expect(fs.readdirSync(historyDir).some((f) => f.includes("superseded-v1"))).toBe(true);

    // Part B: implement completes -> review suspends -> affected_stages: ["review"] reruns ONLY review (not implement)
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-s3-review",
        title: "Review-stage contract update",
        space: "local",
        priority: "P2",
        track: "L2",
        workspace_mode: "scratch_dir",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Initial review goal",
          end: "Done",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:s3-rev",
          scope: ["out.txt"],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# S3 Review",
    );
    await server.orchestrator.wake();
    await waitUntil(
      () => server.store.getTaskIndex("t-s3-review")?.status === "waiting",
      "t-s3-review waiting",
    );
    const revPending = server.pendingDecisions.get("t-s3-review")!;
    const revDecideRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-s3-review/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision_id: revPending.id,
          option_id: "opt-rerereview",
          action: "resume",
          apply_ledger_rule: false,
          contract_update: {
            contract_patch: { goal: "Clarified review goal" },
            affected_stages: ["review"],
          },
        }),
      }),
    );
    expect(revDecideRes.status).toBe(200);
    await waitUntil(() => server.store.getTaskIndex("t-s3-review")?.status === "done", "t-s3-review done");
    expect(
      fakeBackend
        .getRecordedSpecs()
        .filter((s) => s.taskId === "t-s3-review" && s.role === "worker"),
    ).toHaveLength(1);
    expect(
      fakeBackend
        .getRecordedSpecs()
        .filter((s) => s.taskId === "t-s3-review" && s.role === "reviewer"),
    ).toHaveLength(2);
  });

  it("Scenario 4: Manual pause isolates task from max_waiting_wip & decisions/ledger, cancels active turn, and resumes cleanly", async () => {
    const kilnHome = makeTempDir("kiln-m2-s4-");
    const fakeBackend = new FakeBackend();

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-e2e-s4-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        if (req.action === "s4_finish") {
          const ws = server.store.paths.workspaceDir(ctx.taskId);
          writeFileAtomic(path.join(ws, "result.txt"), "ok\n");
          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-implement"))
            .sort()
            .at(-1)!;
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeWorkerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: "scratch",
              output_ref: "result.txt",
              changed_paths: ["result.txt"],
            }),
          );
          await ctx.backend.answer(req.id, true);
        }
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    server.store.writeConfig("roles", {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        worker: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
      },
    });
    server.store.writeConfig("limits", defaultLimits({ max_waiting_wip: 1 }));

    // Turn 1 waits for cancel; turn 2 & companion task finish cleanly
    fakeBackend.enqueueScript(
      [{ kind: "message", text: "Working...", delta: true }, { kind: "wait_for_cancel" }],
      { taskId: "t-s4-pause", turnNumber: 1 },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "s4_finish", detail: "finish" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-s4-other" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "s4_finish", detail: "finish" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-s4-pause" },
    );

    await server.start();

    const makeScratchCard = (id: string): TaskCard => ({
      schema_version: 1,
      id,
      title: `Task ${id}`,
      space: "local",
      priority: "P2",
      track: "L1",
      workspace_mode: "scratch_dir",
      parent: null,
      depends_on: [],
      contract_version: 1,
      contract: {
        goal: "Write result",
        end: "Done",
        accept_cmd: "node -e \"process.exit(0)\"",
        accept_files_hash: "sha256:s4",
        scope: ["result.txt"],
        deliver: { mode: "manual", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 100_000 },
      created_at: "2026-11-19T12:00:00.000Z",
      updated_at: "2026-11-19T12:00:00.000Z",
    });

    server.stateMachine.createTask(makeScratchCard("t-s4-pause"), "# Pause");
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-s4-pause")?.status === "running", "t-s4-pause running");

    // Pause -> backend session cancelled, status = paused, NO decisions.md or ledger polluted
    const pauseRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-s4-pause/pause", { method: "POST" }),
    );
    expect(pauseRes.status).toBe(200);
    expect(server.store.getTaskIndex("t-s4-pause")?.status).toBe("paused");
    expect(server.pendingDecisions.listAll()).toHaveLength(0);
    expect(fs.existsSync(server.store.paths.decisionsMd("t-s4-pause"))).toBe(false);
    expect(server.store.readLedger("local")).toBeNull();

    // Even with max_waiting_wip = 1, a P2 task dispatches normally (paused did NOT consume waiting WIP)
    server.stateMachine.createTask(makeScratchCard("t-s4-other"), "# Other");
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-s4-other")?.status === "done", "t-s4-other done");

    // Resume t-s4-pause -> proceeds to done without polluting ledger
    const resumeRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-s4-pause/resume", { method: "POST" }),
    );
    expect(resumeRes.status).toBe(200);
    await waitUntil(() => server.store.getTaskIndex("t-s4-pause")?.status === "done", "t-s4-pause done");
    expect(server.store.readLedger("local")).toBeNull();
  });

  it("Scenario 5: host_scoped two-stage staging, approval apply, and 409 hash_mismatch with diff on external tamper", async () => {
    const kilnHome = makeTempDir("kiln-m2-s5-");
    const hostDir = makeTempDir("kiln-m2-s5-host-");
    const targetFile = path.join(hostDir, "app.conf");
    fs.writeFileSync(targetFile, "PORT=3000\n");
    const canonicalTarget = realpathCanonical(targetFile);

    const fakeBackend = new FakeBackend();
    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-e2e-s5-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        if (req.action === "s5_host") {
          writeFileAtomic(
            path.join(server.store.paths.stagedDir(ctx.taskId), "app.conf"),
            "PORT=4310\n",
          );
          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-implement"))
            .sort()
            .at(-1)!;
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeWorkerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: "host",
              output_ref: "staged/app.conf",
              changed_paths: [canonicalTarget],
            }),
          );
          await ctx.backend.answer(req.id, true);
        }
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    server.store.writeConfig("roles", {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        worker: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
      },
    });
    server.store.writeConfig("limits", defaultLimits());

    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "s5_host", detail: "stage" }, { kind: "exit", reason: "completed" }],
      { role: "worker" },
    );

    await server.start();

    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-s5",
        title: "Host config update",
        space: "local",
        priority: "P1",
        track: "L1",
        workspace_mode: "host_scoped",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Update host app.conf",
          end: "Verified host config",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:s5",
          scope: [canonicalTarget],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# Host task",
    );
    await server.orchestrator.wake();

    // Phase 1 staged -> waiting for host_scoped approval, host target STILL untouched!
    await waitUntil(() => server.store.getTaskIndex("t-s5")?.status === "waiting", "t-s5 waiting approval");
    expect(fs.readFileSync(canonicalTarget, "utf8")).toBe("PORT=3000\n");

    const pending = server.pendingDecisions.get("t-s5")!;
    const decideRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-s5/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision_id: pending.id,
          option_id: "opt-apply-host",
          action: "resume",
          apply_ledger_rule: false,
        }),
      }),
    );
    expect(decideRes.status).toBe(200);

    await waitUntil(() => server.store.getTaskIndex("t-s5")?.status === "done", "t-s5 done");
    expect(fs.readFileSync(canonicalTarget, "utf8")).toBe("PORT=4310\n");

    // External modification -> restore-backup MUST reject with 409 hash_mismatch + diff
    fs.writeFileSync(canonicalTarget, "PORT=9999\n");
    const restoreRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-s5/restore-backup", { method: "POST" }),
    );
    expect(restoreRes.status).toBe(409);
    const errJson = HashMismatchErrorSchema.parse(await restoreRes.json());
    expect(errJson.code).toBe("hash_mismatch");
    expect(errJson.diff).toContain("-PORT=4310");
    expect(errJson.diff).toContain("+PORT=9999");
    expect(fs.readFileSync(canonicalTarget, "utf8")).toBe("PORT=9999\n");
  });

  it("Scenario 6: L1 task tampering with frozen test file is caught by GATE.yaml and automatically escalated to L2 independent review", async () => {
    const kilnHome = makeTempDir("kiln-m2-s6-");
    const { repoPath, baseCommit } = initGitRepo("s6");
    const acceptCmd = "node -e \"process.exit(0)\"";
    const snap = computeFrozenSnapshot(repoPath, ["tests/*.test.ts"], acceptCmd);
    const fakeBackend = new FakeBackend();

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-e2e-s6-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
        if (req.action === "s6_tamper") {
          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), "export const v = 9;\n");
          fs.writeFileSync(path.join(wtPath, "tests", "frozen.test.ts"), "export const ok = false;\n");
          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-implement"))
            .sort()
            .at(-1)!;
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeWorkerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: baseCommit,
              output_ref: baseCommit,
              changed_paths: ["src/app.ts"],
            }),
          );
          await ctx.backend.answer(req.id, true);
          return;
        }
        if (req.action === "s6_review") {
          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-review"))
            .sort()
            .at(-1)!;
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeReviewerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              reviewed_ref: baseCommit,
              verdict: "pass",
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
      id: "kiln",
      name: "Kiln",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: ["tests/*.test.ts"],
    });
    server.store.writeConfig("roles", defaultRoles());
    server.store.writeConfig("limits", defaultLimits());

    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "s6_tamper", detail: "tamper" }, { kind: "exit", reason: "completed" }],
      { role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "s6_review", detail: "review" }, { kind: "exit", reason: "completed" }],
      { role: "reviewer" },
    );

    await server.start();

    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-s6",
        title: "L1 Freeze Guard",
        space: "kiln",
        priority: "P1",
        track: "L1",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Modify src only",
          end: "Done",
          accept_cmd: acceptCmd,
          accept_files_hash: snap.hash,
          scope: ["src/**"],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# L1 Freeze",
    );
    await server.orchestrator.wake();

    await waitUntil(() => server.store.getTaskIndex("t-s6")?.status === "done", "t-s6 escalated & reviewed");

    const cardAfter = server.store.readTaskCard("t-s6");
    expect(cardAfter.track).toBe("L2");
    const detail = (await (
      await server.app.request(new Request("http://127.0.0.1/api/tasks/t-s6"))
    ).json()) as {
      runs: Array<{ meta: { stage: string }; gate: { escalated_to_l2: boolean; frozen_files_changed: string[] } | null }>;
    };
    expect(detail.runs[0]?.gate?.escalated_to_l2).toBe(true);
    expect(detail.runs[0]?.gate?.frozen_files_changed).toContain("tests/frozen.test.ts");
    expect(detail.runs.some((r) => r.meta.stage === "review")).toBe(true);
  });

  it("Scenario 7: Concurrent lease race archives stale receipt to history/ and restart after index.sqlite deletion reconciles orphaned running & preserves paused", async () => {
    const kilnHome = makeTempDir("kiln-m2-s7-");
    const fakeBackend1 = new FakeBackend();

    const server1 = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-e2e-s7-secret-0123456789abcdef",
    });
    servers.push(server1);
    server1.backendRegistry.register(fakeBackend1);
    server1.store.writeConfig("roles", {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        worker: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
      },
    });
    server1.store.writeConfig("limits", defaultLimits());

    fakeBackend1.enqueueScript([{ kind: "wait_for_cancel" }], { taskId: "t-s7-orphan" });

    await server1.start();

    const makeCard = (id: string): TaskCard => ({
      schema_version: 1,
      id,
      title: `Task ${id}`,
      space: "local",
      priority: "P2",
      track: "L1",
      workspace_mode: "scratch_dir",
      parent: null,
      depends_on: [],
      contract_version: 1,
      contract: {
        goal: "Recover after crash",
        end: "Done",
        accept_cmd: "node -e \"process.exit(0)\"",
        accept_files_hash: "sha256:s7",
        scope: ["out.txt"],
        deliver: { mode: "manual", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 100_000 },
      created_at: "2026-11-19T12:00:00.000Z",
      updated_at: "2026-11-19T12:00:00.000Z",
    });

    server1.stateMachine.createTask(makeCard("t-s7-paused"), "# Paused");
    server1.stateMachine.pauseTask("t-s7-paused", "keep_paused");
    server1.stateMachine.createTask(makeCard("t-s7-orphan"), "# Orphan");

    // Task that wrote valid RECEIPT.md before crash while state_events still says running
    server1.stateMachine.createTask(makeCard("t-s7-receipt-ready"), "# Disk Receipt");
    writeFileAtomic(
      path.join(server1.store.paths.workspaceDir("t-s7-receipt-ready"), "out.txt"),
      "already implemented\n",
    );
    server1.store.persistRunBeforeDispatch(
      {
        schema_version: 1,
        run_id: "run-s7-disk-receipt",
        task_id: "t-s7-receipt-ready",
        stage: "implement",
        round: 1,
        role: "worker",
        contract_version: 1,
        backend_id: "fake",
        agent: "codex",
        model: "gpt-5.4",
        session_ref: { backendId: "fake", sessionId: "sess-disk-receipt" },
        started_at: "2026-11-19T12:00:05.000Z",
      },
      "001-implement",
      "# Handoff",
    );
    server1.store.appendStateEvent("t-s7-receipt-ready", {
      type: "running",
      at: "2026-11-19T12:00:05.000Z",
      stage: "implement",
      round: 1,
      run_id: "run-s7-disk-receipt",
    });
    server1.store.submitReceipt({
      taskId: "t-s7-receipt-ready",
      runId: "run-s7-disk-receipt",
      contractVersion: 1,
      runDirName: "001-implement",
      markdown: makeWorkerReceiptMarkdown({
        run_id: "run-s7-disk-receipt",
        contract_version: 1,
        input_ref: "scratch",
        output_ref: "out.txt",
        changed_paths: ["out.txt"],
      }),
    });

    // Task that crashed mid-deliver (no deliver RUN.yaml)
    server1.stateMachine.createTask(makeCard("t-s7-deliver-crash"), "# Deliver Crash");
    server1.store.appendStateEvent("t-s7-deliver-crash", {
      type: "running",
      at: "2026-11-19T12:00:06.000Z",
      stage: "deliver",
      round: 1,
      run_id: "run-t-s7-deliver-crash-deliver-r1-v1",
    });

    await server1.orchestrator.wake();

    await waitUntil(() => server1.store.getTaskIndex("t-s7-orphan")?.status === "running", "t-s7-orphan running");

    // Stale competing run_id submission via real MCP RPC fails lease check & archives to history/
    const lease = server1.store.getStageLease("t-s7-orphan")!;
    writeYamlAtomic(server1.store.paths.runYaml("t-s7-orphan", "000-implement"), {
      schema_version: 1,
      run_id: "run-stale-loser",
      task_id: "t-s7-orphan",
      stage: "implement",
      round: 1,
      role: "worker",
      contract_version: 1,
      backend_id: "fake",
      agent: "codex",
      model: "gpt-5.4",
      session_ref: { backendId: "fake", sessionId: "sess-stale-loser" },
      started_at: "2026-11-19T12:00:01.000Z",
    });
    const staleToken = server1.issueRunToken({
      taskId: "t-s7-orphan",
      runId: "run-stale-loser",
      role: "worker",
      contractVersion: 1,
    });
    const staleRpcRes = await server1.invokeMcpRpc({
      method: "POST",
      url: "/rpc/mcp/wb_submit_receipt",
      headers: { Authorization: `Bearer ${staleToken}` },
      rawBody: JSON.stringify({
        markdown: makeWorkerReceiptMarkdown({
          run_id: "run-stale-loser",
          contract_version: 1,
          input_ref: "scratch",
          output_ref: "out.txt",
          changed_paths: ["out.txt"],
        }),
      }),
    });
    expect(staleRpcRes.status).toBe(200);
    const staleBody = staleRpcRes.body as {
      accepted: boolean;
      reason: string;
      archivedPath: string;
    };
    expect(staleBody.accepted).toBe(false);
    expect(staleBody.reason).toBe("lease_mismatch_or_expired");
    expect(fs.existsSync(staleBody.archivedPath)).toBe(true);
    expect(lease.run_id).not.toBe("run-stale-loser");

    // Stop server1 & delete index.sqlite completely
    await server1.stop();
    servers.pop();
    fs.rmSync(path.join(kilnHome, "index.sqlite"), { force: true });
    fs.rmSync(path.join(kilnHome, "index.sqlite-wal"), { force: true });
    fs.rmSync(path.join(kilnHome, "index.sqlite-shm"), { force: true });

    // Start fresh server2 with enableOrchestrator: true ->
    // 1) t-s7-receipt-ready restores lease & finishes gate -> done without archiving valid receipt
    // 2) t-s7-deliver-crash recovers from deliver without RUN.yaml -> done
    // 3) t-s7-orphan re-queues & completes -> done
    // 4) t-s7-paused stays paused
    const fakeBackend2 = new FakeBackend();
    const server2 = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-e2e-s7-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        if (req.action === "s7_recover") {
          writeFileAtomic(path.join(server2.store.paths.workspaceDir(ctx.taskId), "out.txt"), "recovered\n");
          const runDir = fs
            .readdirSync(server2.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-implement"))
            .sort()
            .at(-1)!;
          writeFileAtomic(
            server2.store.paths.receiptMd(ctx.taskId, runDir),
            makeWorkerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: "scratch",
              output_ref: "out.txt",
              changed_paths: ["out.txt"],
            }),
          );
          await ctx.backend.answer(req.id, true);
        }
      },
    });
    servers.push(server2);
    server2.backendRegistry.register(fakeBackend2);
    fakeBackend2.enqueueScript(
      [{ kind: "approval", action: "s7_recover", detail: "recover" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-s7-orphan" },
    );

    await server2.start();
    await waitUntil(() => server2.store.getTaskIndex("t-s7-orphan")?.status === "done", "t-s7-orphan recovered to done");
    await waitUntil(() => server2.store.getTaskIndex("t-s7-receipt-ready")?.status === "done", "t-s7-receipt-ready reconciled to done");
    await waitUntil(() => server2.store.getTaskIndex("t-s7-deliver-crash")?.status === "done", "t-s7-deliver-crash recovered to done");
    expect(server2.store.getTaskIndex("t-s7-paused")?.status).toBe("paused");
    expect(fs.existsSync(server2.store.paths.receiptMd("t-s7-receipt-ready", "001-implement"))).toBe(true);
  });

  it("Scenario 8 & 9a: Hot-swap reviewer model & pricing via PUT /api/settings/* and Pi file-protocol need_decision convergence", async () => {
    const kilnHome = makeTempDir("kiln-m2-s8-");
    const fakeBackend = new FakeBackend();

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-e2e-s8-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        const ws = server.store.paths.workspaceDir(ctx.taskId);
        if (req.action === "pi_need_decision") {
          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-implement"))
            .sort()
            .at(-1)!;
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeWorkerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              outcome: "need_decision",
              input_ref: "scratch",
              output_ref: "pending",
              changed_paths: [],
              extraFrontmatter: {
                question: "Pi 文件协议提问：是否采用精简输出格式？",
                options: [
                  {
                    id: "opt-compact",
                    label: "采用精简格式并继续实施",
                    action: "resume",
                    target_stage: "implement",
                    recommended: true,
                  },
                ],
              },
            }),
          );
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "pi_impl_done") {
          writeFileAtomic(path.join(ws, "pi.txt"), "compact\n");
          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-implement"))
            .sort()
            .at(-1)!;
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeWorkerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              outcome: "completed",
              input_ref: "scratch",
              output_ref: "pi.txt",
              changed_paths: ["pi.txt"],
            }),
          );
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "hot_review") {
          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-review"))
            .sort()
            .at(-1)!;
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeReviewerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              reviewed_ref: "pi.txt",
              verdict: "pass",
            }),
          );
          await ctx.backend.answer(req.id, true);
        }
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);

    // Initial config: worker = pi (no MCP!), reviewer = codex/gpt-5.4
    server.store.writeConfig("roles", {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        worker: { agent: "pi", model: "magpie/group/work", allow_full_access_fallback: false },
        reviewer: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
      },
    });
    server.store.writeConfig("limits", defaultLimits());
    server.store.writeConfig("pricing", defaultPricing());

    // Turn 1: Pi worker has NO mcpServers and emits RECEIPT.md(outcome: need_decision)
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "pi_need_decision", detail: "pi-ask" },
        { kind: "usage", turnId: "t-pi-1", inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker", turnNumber: 1 },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "pi_impl_done", detail: "pi-done" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "hot_review", detail: "rev" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "reviewer" },
    );

    await server.start();

    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-s8",
        title: "Pi file protocol & hot swap",
        space: "local",
        priority: "P2",
        track: "L2",
        workspace_mode: "scratch_dir",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Write pi.txt",
          end: "Done",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:s8",
          scope: ["pi.txt"],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# S8",
    );
    await server.orchestrator.wake();

    // Pi file protocol converted RECEIPT.md(need_decision) into PendingDecision + waiting
    await waitUntil(
      () => server.store.getTaskIndex("t-s8")?.status === "waiting",
      "t-s8 waiting from Pi file protocol",
      15_000,
      () =>
        JSON.stringify({
          idx: server.store.getTaskIndex("t-s8"),
          events: server.store.readStateEvents("t-s8"),
          pending: server.pendingDecisions.get("t-s8"),
          runs: fs.existsSync(server.store.paths.runsDir("t-s8"))
            ? fs.readdirSync(server.store.paths.runsDir("t-s8"))
            : [],
        }),
    );
    const workerSpec = fakeBackend.getRecordedSpecs().find((s) => s.role === "worker")!;
    expect(workerSpec.agent).toBe("pi");
    expect(workerSpec.mcpServers).toBeUndefined();

    const pending = server.pendingDecisions.get("t-s8")!;
    expect(pending.question).toContain("Pi 文件协议提问");

    // Verify cost before pricing update: 1M input * $2/1M = $2.0
    const bootBefore = (await (
      await server.app.request(new Request("http://127.0.0.1/api/bootstrap"))
    ).json()) as { usage: { costUsd: number } };
    expect(bootBefore.usage.costUsd).toBeCloseTo(2.0, 8);

    // Hot-swap reviewer model to gpt-6-luna AND double magpie/group/work pricing BEFORE resuming
    await server.app.request(
      new Request("http://127.0.0.1/api/settings/roles", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema_version: 1,
          heterogeneous_review: true,
          roles: {
            worker: { agent: "pi", model: "magpie/group/work", allow_full_access_fallback: false },
            reviewer: { agent: "codex", model: "gpt-6-luna", allow_full_access_fallback: false },
          },
        }),
      }),
    );
    await server.app.request(
      new Request("http://127.0.0.1/api/settings/pricing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema_version: 1,
          models: {
            ...defaultPricing().models,
            "magpie/group/work": { in: 4, cached: 0.4, out: 16 },
          },
        }),
      }),
    );

    // Bootstrap immediately reflects updated pricing ($4.0)
    const bootAfter = (await (
      await server.app.request(new Request("http://127.0.0.1/api/bootstrap"))
    ).json()) as { usage: { costUsd: number } };
    expect(bootAfter.usage.costUsd).toBeCloseTo(4.0, 8);

    // Resume via /decide -> completes implement round 2 and dispatches reviewer with hot-swapped gpt-6-luna!
    await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-s8/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision_id: pending.id,
          option_id: "opt-compact",
          action: "resume",
          apply_ledger_rule: false,
        }),
      }),
    );

    await waitUntil(() => server.store.getTaskIndex("t-s8")?.status === "done", "t-s8 done");
    const reviewerSpec = fakeBackend.getRecordedSpecs().find((s) => s.role === "reviewer");
    expect(reviewerSpec?.agent).toBe("codex");
    expect(reviewerSpec?.model).toBe("gpt-6-luna");
  });

  it("Round 1 closure A: host_scoped rework refreshes manifest/locks, blocks stray staged files, and initializes pending baseline without false L1->L2 escalation", async () => {
    const kilnHome = makeTempDir("kiln-m2-r1a-");
    const hostDir = makeTempDir("kiln-m2-r1a-host-");
    const appConf = path.join(hostDir, "app.conf");
    const otherConf = path.join(hostDir, "other.conf");
    const okConf = path.join(hostDir, "ok.conf");
    fs.writeFileSync(appConf, "PORT=1000\n");
    fs.writeFileSync(otherConf, "MODE=old\n");
    fs.writeFileSync(okConf, "OK=0\n");
    const canonicalApp = realpathCanonical(appConf);
    const canonicalOther = realpathCanonical(otherConf);
    const canonicalOk = realpathCanonical(okConf);

    const fakeBackend = new FakeBackend();
    let reworkStep = 0;

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-e2e-r1a-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        const staged = server.store.paths.stagedDir(ctx.taskId);
        const runDir = fs
          .readdirSync(server.store.paths.runsDir(ctx.taskId))
          .filter((d) => d.endsWith(ctx.role === "reviewer" ? "-review" : "-implement"))
          .sort()
          .at(-1)!;

        if (req.action === "r1a_l1_worker") {
          writeFileAtomic(path.join(staged, "ok.conf"), "OK=1\n");
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeWorkerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: "host",
              output_ref: "staged/ok.conf",
              changed_paths: [canonicalOk],
            }),
          );
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "r1a_rework_worker") {
          reworkStep += 1;
          if (reworkStep === 1) {
            writeFileAtomic(path.join(staged, "app.conf"), "PORT=2000\n");
            writeFileAtomic(
              server.store.paths.receiptMd(ctx.taskId, runDir),
              makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: "host",
                output_ref: "staged/app.conf",
                changed_paths: [canonicalApp],
              }),
            );
          } else if (reworkStep === 2) {
            // Replace staged file and sneak an unmapped stray file in staged/
            fs.rmSync(path.join(staged, "app.conf"), { force: true });
            writeFileAtomic(path.join(staged, "other.conf"), "MODE=new\n");
            writeFileAtomic(path.join(staged, "stray.txt"), "unmapped\n");
            writeFileAtomic(
              server.store.paths.receiptMd(ctx.taskId, runDir),
              makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: "host",
                output_ref: "staged/other.conf",
                changed_paths: [canonicalOther],
              }),
            );
          } else {
            // Remove stray file cleanly and resubmit only other.conf
            fs.rmSync(path.join(staged, "stray.txt"), { force: true });
            writeFileAtomic(path.join(staged, "other.conf"), "MODE=final\n");
            writeFileAtomic(
              server.store.paths.receiptMd(ctx.taskId, runDir),
              makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: "host",
                output_ref: "staged/other.conf",
                changed_paths: [canonicalOther],
              }),
            );
          }
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "r1a_rev_reject") {
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeReviewerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              reviewed_ref: "staged/app.conf",
              verdict: "changes_requested",
              p1: 1,
            }),
          );
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "r1a_rev_pass") {
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeReviewerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              reviewed_ref: "staged/other.conf",
              verdict: "pass",
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
      id: "hostspace",
      name: "Host Space",
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: ["frozen/**"],
    });
    server.store.writeConfig("roles", defaultRoles());
    server.store.writeConfig("limits", defaultLimits());

    await server.start();

    // Part 1: L1 host_scoped with accept_files_hash="pending" & non-empty freeze_patterns initializes hash cleanly (stays L1)
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r1a_l1_worker", detail: "l1" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r1a-l1", role: "worker" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-r1a-l1",
        title: "Host L1 pending baseline",
        space: "hostspace",
        priority: "P2",
        track: "L1",
        workspace_mode: "host_scoped",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Write ok.conf",
          end: "Applied",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "pending",
          scope: [canonicalOk],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: defaultLimitsForCard(),
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# L1 host",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-r1a-l1")?.status === "waiting", "t-r1a-l1 waiting");
    const l1Card = server.store.readTaskCard("t-r1a-l1");
    expect(l1Card.track).toBe("L1");
    expect(l1Card.contract.accept_files_hash).toMatch(/^sha256:/);
    const l1Dec = server.pendingDecisions.get("t-r1a-l1")!;
    expect(l1Dec.reason).toBe("host_scoped_approval");

    // Part 2: L2 rework changes staged target app.conf -> (stray rejected) -> other.conf, refreshing manifest & locks
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r1a_rework_worker", detail: "w1" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r1a-rework", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r1a_rev_reject", detail: "r1" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r1a-rework", role: "reviewer" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r1a_rework_worker", detail: "w2-stray" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r1a-rework", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r1a_rework_worker", detail: "w3-clean" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r1a-rework", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r1a_rev_pass", detail: "r2" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r1a-rework", role: "reviewer" },
    );

    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-r1a-rework",
        title: "Host rework staging",
        space: "hostspace",
        priority: "P2",
        track: "L2",
        workspace_mode: "host_scoped",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Update host conf cleanly across rework",
          end: "Refreshed manifest applied",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "pending",
          scope: [canonicalApp, canonicalOther],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: defaultLimitsForCard(),
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# Rework host",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-r1a-rework")?.status === "waiting", "t-r1a-rework waiting");

    // Round 2 gate rejected stray.txt; Round 3 refreshed manifest & locks to canonicalOther only
    const locks = server.store.listHostPathLocks("t-r1a-rework").map((l) => l.canonical_path);
    expect(locks).toEqual([canonicalOther]);

    const reworkDec = server.pendingDecisions.get("t-r1a-rework")!;
    await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-r1a-rework/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision_id: reworkDec.id,
          option_id: "opt-apply-host",
          action: "resume",
          apply_ledger_rule: false,
        }),
      }),
    );
    await waitUntil(() => server.store.getTaskIndex("t-r1a-rework")?.status === "done", "t-r1a-rework done");
    expect(fs.readFileSync(otherConf, "utf8")).toBe("MODE=final\n");
    expect(fs.readFileSync(appConf, "utf8")).toBe("PORT=1000\n");

    function defaultLimitsForCard() {
      return { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 };
    }
  });

  it("Round 1 closure B: git_worktree merge_main enters waiting and preserves worktree on dirty worktree, dirty main repo, or non-default main branch", async () => {
    const kilnHome = makeTempDir("kiln-m2-r1b-");
    const { repoPath, baseCommit } = initGitRepo("r1b");
    const fakeBackend = new FakeBackend();

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-e2e-r1b-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
        if (req.action === "r1b_worker") {
          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), "export const v = 77;\n");
          git(["add", "src/app.ts"], wtPath);
          git(["commit", "-m", "r1b commit"], wtPath);
          const outRef = git(["rev-parse", "HEAD"], wtPath).trim();

          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-implement"))
            .sort()
            .at(-1)!;
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeWorkerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              input_ref: baseCommit,
              output_ref: outRef,
              changed_paths: ["src/app.ts"],
            }),
          );
          await ctx.backend.answer(req.id, true);
          return;
        }
        if (req.action === "r1b_reviewer") {
          const revRef = git(["rev-parse", "HEAD"], wtPath).trim();
          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-review"))
            .sort()
            .at(-1)!;
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeReviewerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              reviewed_ref: revRef,
              verdict: "pass",
            }),
          );
          // Leave an uncommitted dirty file right before deliver runs
          fs.writeFileSync(path.join(wtPath, "dirty.tmp"), "uncommitted\n");
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
    server.store.writeConfig("roles", defaultRoles());
    server.store.writeConfig("limits", defaultLimits());

    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r1b_worker", detail: "clean impl" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r1b", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r1b_reviewer", detail: "review+dirty" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r1b", role: "reviewer" },
    );

    await server.start();
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-r1b",
        title: "Blocked merge_main",
        space: "kiln",
        priority: "P2",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Commit app.ts",
          end: "Merged cleanly",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "pending",
          scope: ["src/app.ts"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# Merge block test",
    );
    await server.orchestrator.wake();

    // 1. Dirty worktree blocks merge_main -> waiting & preserves worktree
    await waitUntil(() => server.store.getTaskIndex("t-r1b")?.status === "waiting", "t-r1b dirty wt");
    expect(server.pendingDecisions.get("t-r1b")?.reason).toBe("worktree_dirty_before_merge");
    const wtPath = path.join(server.store.paths.workspaceDir("t-r1b"), "worktree");
    expect(fs.existsSync(wtPath)).toBe(true);

    // 2. Clean worktree, dirty main repo -> waiting (main_repo_not_ready_for_merge) & preserves worktree
    fs.rmSync(path.join(wtPath, "dirty.tmp"));
    fs.writeFileSync(path.join(repoPath, "host-dirty.txt"), "dirty main\n");
    let dec = server.pendingDecisions.get("t-r1b")!;
    await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-r1b/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision_id: dec.id,
          option_id: "opt-retry-deliver",
          action: "resume",
          apply_ledger_rule: false,
        }),
      }),
    );
    await waitUntil(
      () =>
        server.store.getTaskIndex("t-r1b")?.status === "waiting" &&
        server.pendingDecisions.get("t-r1b")?.reason === "main_repo_not_ready_for_merge",
      "t-r1b dirty main",
    );
    expect(fs.existsSync(wtPath)).toBe(true);

    // 3. Clean main repo on non-default branch -> waiting (main_repo_not_ready_for_merge)
    fs.rmSync(path.join(repoPath, "host-dirty.txt"));
    git(["checkout", "-b", "feature-side"], repoPath);
    dec = server.pendingDecisions.get("t-r1b")!;
    await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-r1b/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision_id: dec.id,
          option_id: "opt-retry-deliver",
          action: "resume",
          apply_ledger_rule: false,
        }),
      }),
    );
    await waitUntil(
      () =>
        server.store.getTaskIndex("t-r1b")?.status === "waiting" &&
        server.pendingDecisions.get("t-r1b")?.id !== dec.id,
      "t-r1b non-default branch",
    );
    expect(server.pendingDecisions.get("t-r1b")?.reason).toBe("main_repo_not_ready_for_merge");
    expect(fs.existsSync(wtPath)).toBe(true);

    // 4. Switch main repo back to main -> merge_main succeeds and finishes done
    git(["checkout", "main"], repoPath);
    dec = server.pendingDecisions.get("t-r1b")!;
    await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-r1b/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision_id: dec.id,
          option_id: "opt-retry-deliver",
          action: "resume",
          apply_ledger_rule: false,
        }),
      }),
    );
    await waitUntil(() => server.store.getTaskIndex("t-r1b")?.status === "done", "t-r1b done");
    expect(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf8")).toBe("export const v = 77;\n");
  });

  it("Round 1 closure C: rate-limit cooldown runs are excluded from stageRetries, and triage -> advise -> implement skips redundant second triage", async () => {
    const kilnHome = makeTempDir("kiln-m2-r1c-");
    const fakeBackend = new FakeBackend();

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      rateLimitCooldownMs: 10,
      tokenSecret: "m2-e2e-r1c-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        const stageDir =
          ctx.role === "triage" ? "-triage" : ctx.role === "advisor" ? "-advise" : "-implement";
        const runDir = fs
          .readdirSync(server.store.paths.runsDir(ctx.taskId))
          .filter((d) => d.endsWith(stageDir))
          .sort()
          .at(-1)!;
        if (req.action === "r1c_triage") {
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            serializeFrontmatterMarkdown(
              {
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                recommendation: "escalate_advisor",
                summary: "Escalate once to advisor",
              },
              "## 异常事实\n编译报错\n\n## 研判结论\n建议升级技术顾问\n",
            ),
          );
        } else if (req.action === "r1c_advisor") {
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            serializeFrontmatterMarkdown(
              {
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                outcome: "resolved",
                chosen_approach: "Retry implement after advisor guidance",
              },
              "## 技术取舍\n采用最小修补方案\n\n## 授权裁决\n继续实施修复\n",
            ),
          );
        }
        await ctx.backend.answer(req.id, true);
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    server.store.writeConfig("roles", {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        worker: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
        triage: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
        advisor: { agent: "codex", model: "gpt-6-luna", allow_full_access_fallback: false },
      },
    });
    server.store.writeConfig("limits", defaultLimits({ retries_per_stage: 1, advisor_calls: 1 }));

    // Worker 1 & 2 hit 429/quota rate limit (must NOT burn retries_per_stage=1)
    fakeBackend.enqueueScript(
      [{ kind: "exit", reason: "failed", detail: "429 Rate limit exceeded" }],
      { taskId: "t-r1c", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "exit", reason: "failed", detail: "quota exceeded" }],
      { taskId: "t-r1c", role: "worker" },
    );
    // Worker 3: 1st real failure -> L0 self-retry -> Worker 4: 2nd real failure -> escalates to triage (stageRetries=1)
    fakeBackend.enqueueScript(
      [{ kind: "exit", reason: "failed", detail: "real failure 1" }],
      { taskId: "t-r1c", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "exit", reason: "failed", detail: "real failure 2" }],
      { taskId: "t-r1c", role: "worker" },
    );
    // Triage -> Advisor -> Worker 5 fails -> post-advise fresh L0 retry (Worker 6) fails ->
    // triageAttempted=true skips redundant 2nd triage and goes directly to waiting
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r1c_triage", detail: "triage" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r1c", role: "triage" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r1c_advisor", detail: "advise" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r1c", role: "advisor" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "exit", reason: "failed", detail: "real failure post-advise 1" }],
      { taskId: "t-r1c", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "exit", reason: "failed", detail: "real failure post-advise 2" }],
      { taskId: "t-r1c", role: "worker" },
    );

    await server.start();
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-r1c",
        title: "Rate limit + triage-advise non-repeat",
        space: "local",
        priority: "P2",
        track: "L1",
        workspace_mode: "scratch_dir",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Test retry accounting",
          end: "Done",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:r1c",
          scope: ["out.txt"],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 1, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# Rate limit",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-r1c")?.status === "waiting", "t-r1c waiting");

    const rolesRun = fakeBackend.getRecordedSpecs().map((s) => s.role);
    expect(rolesRun).toEqual([
      "worker",
      "worker",
      "worker",
      "worker",
      "triage",
      "advisor",
      "worker",
      "worker",
    ]);
    expect(rolesRun.filter((r) => r === "triage")).toHaveLength(1);
    const runDirs = fs.readdirSync(server.store.paths.runsDir("t-r1c")).sort();
    expect(
      fs.existsSync(path.join(server.store.paths.runDir("t-r1c", runDirs[0]!), "RATE_LIMITED")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(server.store.paths.runDir("t-r1c", runDirs[1]!), "RATE_LIMITED")),
    ).toBe(true);
  });

  it("Round 1 closure D: empty scratch_dir fails artifacts_ok, pending scratch baseline avoids L1 escalation, and immediate /decide waits for active run abort cleanly", async () => {
    const kilnHome = makeTempDir("kiln-m2-r1d-");
    const fakeBackend = new FakeBackend();
    let activeWorkers = 0;
    let maxConcurrentWorkers = 0;

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-e2e-r1d-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        activeWorkers += 1;
        maxConcurrentWorkers = Math.max(maxConcurrentWorkers, activeWorkers);
        try {
          const token =
            fakeBackend
              .getRecordedSpecs()
              .find((s) => s.runId === ctx.runId)
              ?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";
          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-implement"))
            .sort()
            .at(-1)!;
          const wsDir = server.store.paths.workspaceDir(ctx.taskId);

          if (req.action === "r1d_empty_scratch") {
            // Submit receipt with wildcard scope WITHOUT writing any artifact into scratch_dir
            await server.invokeMcpRpc({
              method: "POST",
              url: "/rpc/mcp/wb_submit_receipt",
              headers: { Authorization: `Bearer ${token}` },
              rawBody: JSON.stringify({
                markdown: makeWorkerReceiptMarkdown({
                  run_id: ctx.runId,
                  contract_version: ctx.card.contract_version,
                  input_ref: "scratch",
                  output_ref: "none",
                  changed_paths: [],
                }),
              }),
            });
            await ctx.backend.answer(req.id, true);
            return;
          }

          if (req.action === "r1d_valid_scratch") {
            writeFileAtomic(path.join(wsDir, "out.txt"), "non-empty scratch output\n");
            await server.invokeMcpRpc({
              method: "POST",
              url: "/rpc/mcp/wb_submit_receipt",
              headers: { Authorization: `Bearer ${token}` },
              rawBody: JSON.stringify({
                markdown: makeWorkerReceiptMarkdown({
                  run_id: ctx.runId,
                  contract_version: ctx.card.contract_version,
                  input_ref: "scratch",
                  output_ref: "out.txt",
                  changed_paths: ["out.txt"],
                }),
              }),
            });
            await ctx.backend.answer(req.id, true);
            return;
          }

          if (req.action === "r1d_ask") {
            const askRes = await server.invokeMcpRpc({
              method: "POST",
              url: "/rpc/mcp/wb_ask_decision",
              headers: { Authorization: `Bearer ${token}` },
              rawBody: JSON.stringify({
                category: "confirm",
                reason: "Confirm before writing",
                question: "是否继续实施？",
                options: [
                  {
                    id: "opt-go",
                    label: "继续实施",
                    action: "resume",
                    target_stage: "implement",
                    recommended: true,
                  },
                ],
              }),
            });
            expect(askRes.status).toBe(200);
          }
        } finally {
          activeWorkers -= 1;
        }
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    server.store.writeSpace({
      schema_version: 1,
      id: "scratchspace",
      name: "Scratch Space",
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: ["frozen.txt"],
    });
    server.store.writeConfig("roles", defaultRoles());
    server.store.writeConfig("limits", defaultLimits({ retries_per_stage: 1 }));
    server.store.writeConfig("pricing", defaultPricing());

    await server.start();

    // 1. Empty scratch_dir (0 artifacts, wildcard scope) fails gate artifacts_ok=false even if accept_cmd=0,
    //    then writing out.txt passes cleanly; pending accept_files_hash with freeze_patterns stays L1!
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r1d_empty_scratch", detail: "empty" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r1d-scratch", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r1d_valid_scratch", detail: "filled" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r1d-scratch", role: "worker" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-r1d-scratch",
        title: "Empty scratch check",
        space: "scratchspace",
        priority: "P2",
        track: "L1",
        workspace_mode: "scratch_dir",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Write non-empty artifact",
          end: "Verified",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "pending",
          scope: ["**/*"],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 1, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# Empty scratch test",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-r1d-scratch")?.status === "done", "t-r1d-scratch done");
    const gate1 = await (await server.app.request(new Request("http://127.0.0.1/api/tasks/t-r1d-scratch"))).json() as {
      card: TaskCard;
      runs: Array<{ gate: { artifacts_ok: boolean } | null }>;
    };
    expect(gate1.runs[0]?.gate?.artifacts_ok).toBe(false);
    expect(gate1.runs[1]?.gate?.artifacts_ok).toBe(true);
    expect(gate1.card.track).toBe("L1");
    expect(gate1.card.contract.accept_files_hash).toMatch(/^sha256:/);

    // 2. wb_ask_decision while turn is active + immediate /decide aborts old run cleanly without overlap or wiping rateTracker
    fakeBackend.enqueueScript(
      [
        { kind: "message", text: "stream before ask", delta: true },
        { kind: "approval", action: "r1d_ask", detail: "ask" },
        { kind: "wait_for_cancel" },
      ],
      { taskId: "t-r1d-decide", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "message", text: "stream after resume ", delta: true },
        { kind: "approval", action: "r1d_valid_scratch", detail: "finish" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-r1d-decide", role: "worker" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-r1d-decide",
        title: "Immediate decide race",
        space: "scratchspace",
        priority: "P2",
        track: "L1",
        workspace_mode: "scratch_dir",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Finish after resume",
          end: "Done",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "pending",
          scope: ["out.txt"],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# Immediate decide",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-r1d-decide")?.status === "waiting", "t-r1d-decide waiting");
    const dec = server.pendingDecisions.get("t-r1d-decide")!;
    const decRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-r1d-decide/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision_id: dec.id,
          option_id: "opt-go",
          action: "resume",
          apply_ledger_rule: false,
        }),
      }),
    );
    expect(decRes.status).toBe(200);
    await waitUntil(() => server.store.getTaskIndex("t-r1d-decide")?.status === "done", "t-r1d-decide done");
    expect(maxConcurrentWorkers).toBe(1);
    expect(
      fakeBackend
        .getRecordedSpecs()
        .filter((s) => s.taskId === "t-r1d-decide" && s.role === "worker"),
    ).toHaveLength(2);
  });

  it("Round 2 closure A: auto-wake on done/paused/waiting/cancelled unblocks dependencies & slots without manual wake(), and injects KILN_SOCK_PATH", async () => {
    const kilnHome = makeTempDir("kiln-m2-r2a-");
    const fakeBackend = new FakeBackend();
    const customSocketPath =
      process.platform === "win32"
        ? resolveDefaultIpcPath(path.join(kilnHome, "custom-dir"), "win32")
        : path.join(kilnHome, "custom-dir", "custom-kilnd.sock");

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      socketPath: customSocketPath,
      tokenSecret: "m2-e2e-r2a-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        const token =
          fakeBackend
            .getRecordedSpecs()
            .find((s) => s.runId === ctx.runId)
            ?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";

        if (req.action === "r2a_complete") {
          writeFileAtomic(
            path.join(server.store.paths.workspaceDir(ctx.taskId), "out.txt"),
            `done:${ctx.taskId}\n`,
          );
          const sub = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: "scratch",
                output_ref: "out.txt",
                changed_paths: ["out.txt"],
              }),
            }),
          });
          expect(sub.status).toBe(200);
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "r2a_ask") {
          const askRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_ask_decision",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              category: "scope_ambiguity",
              reason: "Slot handoff ask",
              question: "Waiting to free slot",
              options: [
                { id: "opt-ok", label: "Continue", action: "resume", recommended: true },
              ],
            }),
          });
          expect(askRes.status).toBe(200);
          return;
        }

        await ctx.backend.answer(req.id, true);
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    server.store.writeSpace({
      schema_version: 1,
      id: "local",
      name: "Local",
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    server.store.writeConfig("roles", defaultRoles());
    server.store.writeConfig("limits", defaultLimits({ max_concurrent_slots: 1, retries_per_stage: 0 }));
    server.store.writeConfig("pricing", defaultPricing());

    await server.start();

    const scratchCard = (id: string, priority: "P1" | "P2", dependsOn: string[]) => ({
      schema_version: 1 as const,
      id,
      title: `Task ${id}`,
      space: "local",
      priority,
      track: "L1" as const,
      workspace_mode: "scratch_dir" as const,
      parent: null,
      depends_on: dependsOn,
      contract_version: 1,
      contract: {
        goal: "Complete scratch task",
        end: "out.txt written",
        accept_cmd: "node -e \"process.exit(0)\"",
        accept_files_hash: "sha256:r2a",
        scope: ["out.txt"],
        deliver: { mode: "manual" as const, cmd: null },
        human_accept: false,
        external_actions: "ask" as const,
      },
      limits: { retries_per_stage: 0, review_rounds: 1, advisor_calls: 0, max_tokens: 5_000_000 },
      created_at: "2026-11-19T12:00:00.000Z",
      updated_at: "2026-11-19T12:00:00.000Z",
    });

    // 1. Downstream task depends_on upstream task -> auto-wakes after upstream becomes done
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r2a_complete", detail: "up" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r2a-up", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r2a_complete", detail: "down" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r2a-down", role: "worker" },
    );
    server.stateMachine.createTask(scratchCard("t-r2a-up", "P1", []), "# Up");
    server.stateMachine.createTask(scratchCard("t-r2a-down", "P2", ["t-r2a-up"]), "# Down");

    await server.orchestrator.wake();
    // No second manual wake(): t-r2a-down must auto-wake cleanly when t-r2a-up completes delivery
    await waitUntil(() => server.store.getTaskIndex("t-r2a-down")?.status === "done", "t-r2a-down auto-woke to done");
    expect(server.store.getTaskIndex("t-r2a-up")?.status).toBe("done");

    const upWorkerEnv = fakeBackend
      .getRecordedSpecs()
      .find((s) => s.taskId === "t-r2a-up" && s.role === "worker")
      ?.mcpServers?.[0]?.env;
    expect(upWorkerEnv?.KILN_SOCK_PATH).toBe(customSocketPath);
    expect(upWorkerEnv?.KILN_SOCK).toBeUndefined();

    // 2. Intake chat also injects KILN_SOCK_PATH (not legacy KILN_SOCK)
    fakeBackend.enqueueScript(
      [{ kind: "message", text: "intake ok" }, { kind: "exit", reason: "completed" }],
      { taskId: "d-r2a-sock", role: "intake" },
    );
    const createDraftRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "d-r2a-sock", space: "local", title: "Sock draft" }),
      }),
    );
    expect(createDraftRes.status).toBe(201);
    const intakeChatRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-r2a-sock/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      }),
    );
    expect(intakeChatRes.status).toBe(200);
    const intakeEnv = fakeBackend
      .getRecordedSpecs()
      .find((s) => s.taskId === "d-r2a-sock" && s.role === "intake")
      ?.mcpServers?.[0]?.env;
    expect(intakeEnv?.KILN_SOCK_PATH).toBe(customSocketPath);
    expect(intakeEnv?.KILN_SOCK).toBeUndefined();

    // 3. Single slot freed by /pause auto-wakes queued task without manual wake()
    fakeBackend.enqueueScript(
      [{ kind: "message", text: "pause hold" }, { kind: "wait_for_cancel" }],
      { taskId: "t-r2a-pause1", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r2a_complete", detail: "after pause" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r2a-pause2", role: "worker" },
    );
    server.stateMachine.createTask(scratchCard("t-r2a-pause1", "P1", []), "# P1");
    server.stateMachine.createTask(scratchCard("t-r2a-pause2", "P2", []), "# P2");
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-r2a-pause1")?.status === "running", "pause1 running");
    expect(server.store.getTaskIndex("t-r2a-pause2")?.status).toBe("queued");
    const pauseRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-r2a-pause1/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "release slot" }),
      }),
    );
    expect(pauseRes.status).toBe(200);
    await waitUntil(() => server.store.getTaskIndex("t-r2a-pause2")?.status === "done", "pause2 auto-woke to done");

    // 4. Single slot freed by wb_ask_decision (waiting) auto-wakes queued task without manual wake()
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r2a_ask", detail: "ask hold" }, { kind: "wait_for_cancel" }],
      { taskId: "t-r2a-wait1", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r2a_complete", detail: "after ask" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r2a-wait2", role: "worker" },
    );
    server.stateMachine.createTask(scratchCard("t-r2a-wait1", "P1", []), "# W1");
    server.stateMachine.createTask(scratchCard("t-r2a-wait2", "P2", []), "# W2");
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-r2a-wait2")?.status === "done", "wait2 auto-woke to done");
    expect(server.store.getTaskIndex("t-r2a-wait1")?.status).toBe("waiting");

    // 5. Single slot freed by /cancel auto-wakes queued task without manual wake()
    fakeBackend.enqueueScript(
      [{ kind: "message", text: "cancel hold" }, { kind: "wait_for_cancel" }],
      { taskId: "t-r2a-cancel1", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r2a_complete", detail: "after cancel" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r2a-cancel2", role: "worker" },
    );
    server.stateMachine.createTask(scratchCard("t-r2a-cancel1", "P1", []), "# C1");
    server.stateMachine.createTask(scratchCard("t-r2a-cancel2", "P2", []), "# C2");
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-r2a-cancel1")?.status === "running", "cancel1 running");
    const cancelRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-r2a-cancel1/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "abort hold" }),
      }),
    );
    expect(cancelRes.status).toBe(200);
    await waitUntil(() => server.store.getTaskIndex("t-r2a-cancel2")?.status === "done", "cancel2 auto-woke to done");
  });

  it("Round 2 closure B: fail-closed scratch traversal/duplicate host targets, finalizeActiveRun error guard, in-flight start cancel, and stale verifier/advisor receipts", async () => {
    const kilnHome = makeTempDir("kiln-m2-r2b-");
    const hostRoot = makeTempDir("kiln-m2-r2b-host-");
    const appConfPath = path.join(hostRoot, "app.conf");
    writeFileAtomic(appConfPath, "initial=1\n");
    const hostSubdir = path.join(hostRoot, "existing-dir");
    fs.mkdirSync(hostSubdir, { recursive: true });

    const fakeBackend = new FakeBackend();
    const origStart = fakeBackend.start.bind(fakeBackend);
    const origCancel = fakeBackend.cancel.bind(fakeBackend);
    const cancelledSessionIds: string[] = [];
    fakeBackend.cancel = async (ref) => {
      cancelledSessionIds.push(ref.sessionId);
      return origCancel(ref);
    };
    let inflightStartEnteredResolve!: () => void;
    const inflightStartEntered = new Promise<void>((r) => {
      inflightStartEnteredResolve = r;
    });
    let releaseInflightStart!: () => void;
    const inflightStartGate = new Promise<void>((r) => {
      releaseInflightStart = r;
    });
    let inflightSessionRef: Awaited<ReturnType<typeof origStart>> | null = null;

    fakeBackend.start = async (spec) => {
      if (spec.taskId === "t-r2b-inflight") {
        inflightSessionRef = await origStart(spec);
        inflightStartEnteredResolve();
        await inflightStartGate;
        return inflightSessionRef;
      }
      return origStart(spec);
    };

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-e2e-r2b-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        const token =
          fakeBackend
            .getRecordedSpecs()
            .find((s) => s.runId === ctx.runId)
            ?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";

        if (req.action === "r2b_escape_scratch") {
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: "scratch",
                output_ref: "../escape.md",
                changed_paths: ["../escape.md"],
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "r2b_dup_host") {
          const stagedDir = server.store.paths.stagedDir(ctx.taskId);
          writeFileAtomic(path.join(stagedDir, "app.conf"), "first=1\n");
          writeFileAtomic(path.join(stagedDir, "sub", "app.conf"), "second=2\n");
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: "host",
                output_ref: appConfPath,
                changed_paths: [appConfPath],
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "r2b_dir_collision") {
          const stagedDir = server.store.paths.stagedDir(ctx.taskId);
          writeFileAtomic(path.join(stagedDir, "existing-dir"), "overwrite-dir?\n");
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: "host",
                output_ref: hostSubdir,
                changed_paths: [hostSubdir],
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "r2b_ok_scratch") {
          writeFileAtomic(
            path.join(server.store.paths.workspaceDir(ctx.taskId), "ok.txt"),
            "valid artifact\n",
          );
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: "scratch",
                output_ref: "ok.txt",
                changed_paths: ["ok.txt"],
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "r2b_ok_review") {
          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-review"))
            .sort()
            .at(-1)!;
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeReviewerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              reviewed_ref: "ok.txt",
              verdict: "pass",
            }),
          );
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "r2b_stale_verifier") {
          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-accept"))
            .sort()
            .at(-1)!;
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            serializeFrontmatterMarkdown(
              {
                run_id: "run-stale-verifier-mismatch",
                contract_version: ctx.card.contract_version,
                verdict: "pass",
              },
              "## 验收场景明细\n- stale run_id\n",
            ),
          );
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "r2b_triage_escalate") {
          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-triage"))
            .sort()
            .at(-1)!;
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            serializeFrontmatterMarkdown(
              {
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                recommendation: "escalate_advisor",
                summary: "Need advisor",
              },
              "## 异常事实\n失败\n\n## 研判结论\n转顾问\n",
            ),
          );
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "r2b_stale_advisor") {
          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-advise"))
            .sort()
            .at(-1)!;
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            serializeFrontmatterMarkdown(
              {
                run_id: ctx.runId,
                contract_version: 999,
                outcome: "resolved",
                chosen_approach: "Wrong version decision",
              },
              "## 技术取舍\n旧版本\n\n## 授权裁决\n不应写入\n",
            ),
          );
          await ctx.backend.answer(req.id, true);
          return;
        }

        await ctx.backend.answer(req.id, true);
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    server.store.writeSpace({
      schema_version: 1,
      id: "local",
      name: "Local",
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    const baseRoles = defaultRoles();
    server.store.writeConfig("roles", {
      ...baseRoles,
      roles: {
        worker: baseRoles.roles.worker,
        reviewer: baseRoles.roles.reviewer,
        verifier: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
      },
    });
    server.store.writeConfig(
      "limits",
      defaultLimits({
        max_concurrent_slots: 3,
        max_waiting_wip: 10,
        retries_per_stage: 0,
        advisor_calls: 1,
      }),
    );
    server.store.writeConfig("pricing", defaultPricing());

    await server.start();

    // 1. scratch_dir ../escape.md fails scope_ok cleanly in GATE.yaml without throwing
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r2b_escape_scratch", detail: "escape" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r2b-escape", role: "worker" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-r2b-escape",
        title: "Escape path gate test",
        space: "local",
        priority: "P2",
        track: "L1",
        workspace_mode: "scratch_dir",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Reject traversal path",
          end: "Done",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:r2b1",
          scope: ["**"],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 0, review_rounds: 1, advisor_calls: 0, max_tokens: 5_000_000 },
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# Escape",
    );

    // 2. Duplicate staged basename mapping to same literal host target fails scope_ok without throwing
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r2b_dup_host", detail: "dup host" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r2b-duphost", role: "worker" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-r2b-duphost",
        title: "Duplicate host target test",
        space: "local",
        priority: "P2",
        track: "L1",
        workspace_mode: "host_scoped",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Reject duplicate canonical target",
          end: "Done",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:r2b2",
          scope: [appConfPath],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 0, review_rounds: 1, advisor_calls: 0, max_tokens: 5_000_000 },
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# Dup host",
    );

    // 3. finalizeActiveRun unexpected staging error (pre-existing host directory) converges via try/catch -> waiting
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r2b_dir_collision", detail: "dir collision" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r2b-direrr", role: "worker" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-r2b-direrr",
        title: "finalizeActiveRun error guard",
        space: "local",
        priority: "P2",
        track: "L1",
        workspace_mode: "host_scoped",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Survive unexpected staging error",
          end: "Done",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:r2b3",
          scope: [`${hostRoot}/**`],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 0, review_rounds: 1, advisor_calls: 0, max_tokens: 5_000_000 },
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# Dir err",
    );

    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-r2b-escape")?.status === "waiting", "escape waiting");
    await waitUntil(() => server.store.getTaskIndex("t-r2b-duphost")?.status === "waiting", "duphost waiting");
    await waitUntil(() => server.store.getTaskIndex("t-r2b-direrr")?.status === "waiting", "direrr waiting");

    const escapeDetail = (await (
      await server.app.request(new Request("http://127.0.0.1/api/tasks/t-r2b-escape"))
    ).json()) as { runs: Array<{ gate?: { scope_ok: boolean; out_of_scope_paths: string[] } | null }> };
    const escapeGate = escapeDetail.runs[0]?.gate;
    expect(escapeGate?.scope_ok).toBe(false);
    expect(escapeGate?.out_of_scope_paths).toContain("../escape.md");

    const dupDetail = (await (
      await server.app.request(new Request("http://127.0.0.1/api/tasks/t-r2b-duphost"))
    ).json()) as { runs: Array<{ gate?: { scope_ok: boolean; out_of_scope_paths: string[] } | null }> };
    const dupGate = dupDetail.runs[0]?.gate;
    expect(dupGate?.scope_ok).toBe(false);
    expect(server.store.listHostPathLocks("t-r2b-duphost")).toHaveLength(0);
    expect(server.store.getStageLease("t-r2b-direrr")?.state).not.toBe("active");

    // 4. Stale run_id verifier receipt (file-protocol) is rejected instead of advancing to deliver
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r2b_ok_scratch", detail: "impl" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r2b-verifier", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r2b_ok_review", detail: "review" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r2b-verifier", role: "reviewer" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r2b_stale_verifier", detail: "stale verifier" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r2b-verifier", role: "verifier" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-r2b-verifier",
        title: "Stale verifier receipt",
        space: "local",
        priority: "P2",
        track: "L2",
        workspace_mode: "scratch_dir",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Reject wrong run_id verifier receipt",
          end: "Done",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:r2b4",
          scope: ["ok.txt"],
          deliver: { mode: "manual", cmd: null },
          human_accept: true,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 0, review_rounds: 1, advisor_calls: 0, max_tokens: 5_000_000 },
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# Verifier",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-r2b-verifier")?.status === "waiting", "verifier waiting");
    expect(
      fakeBackend
        .getRecordedSpecs()
        .some((s) => s.taskId === "t-r2b-verifier" && s.role === "verifier"),
    ).toBe(true);
    expect(server.pendingDecisions.get("t-r2b-verifier")?.category).toBe("stage_failure_escalation");

    // 5. Stale contract_version advisor receipt does NOT write decisions.md or loop back to implement
    server.store.writeConfig("roles", {
      ...baseRoles,
      roles: {
        ...baseRoles.roles,
        verifier: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
        triage: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
        advisor: { agent: "codex", model: "gpt-6-luna", allow_full_access_fallback: false },
      },
    });
    fakeBackend.enqueueScript(
      [{ kind: "exit", reason: "failed", detail: "trigger triage" }],
      { taskId: "t-r2b-advisor", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r2b_triage_escalate", detail: "triage" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r2b-advisor", role: "triage" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r2b_stale_advisor", detail: "advisor" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r2b-advisor", role: "advisor" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-r2b-advisor",
        title: "Stale advisor receipt",
        space: "local",
        priority: "P2",
        track: "L1",
        workspace_mode: "scratch_dir",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Reject wrong contract_version advisor receipt",
          end: "Done",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:r2b5",
          scope: ["ok.txt"],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 0, review_rounds: 1, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# Advisor",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-r2b-advisor")?.status === "waiting", "advisor waiting");
    expect(
      fakeBackend
        .getRecordedSpecs()
        .some((s) => s.taskId === "t-r2b-advisor" && s.role === "advisor"),
    ).toBe(true);
    expect(server.pendingDecisions.get("t-r2b-advisor")?.reason).toBe("advisor_need_decision");
    expect(fs.existsSync(server.store.paths.decisionsMd("t-r2b-advisor"))).toBe(false);

    // 6. Task paused while backend.start() is in flight cancels returned sessionRef immediately
    fakeBackend.enqueueScript(
      [{ kind: "wait_for_cancel" }],
      { taskId: "t-r2b-inflight", role: "worker" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-r2b-inflight",
        title: "Inflight start cancel",
        space: "local",
        priority: "P2",
        track: "L1",
        workspace_mode: "scratch_dir",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Cancel orphan session started during pause",
          end: "Paused cleanly",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:r2b6",
          scope: ["ok.txt"],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 0, review_rounds: 1, advisor_calls: 0, max_tokens: 5_000_000 },
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# Inflight",
    );
    void server.orchestrator.wake();
    await inflightStartEntered;

    const pauseInflightRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-r2b-inflight/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "pause during start" }),
      }),
    );
    expect(pauseInflightRes.status).toBe(200);
    releaseInflightStart();

    await waitUntil(async () => {
      if (!inflightSessionRef) return false;
      if (!cancelledSessionIds.includes(inflightSessionRef.sessionId)) return false;
      const probe = await fakeBackend.probe(inflightSessionRef);
      return probe.status === "idle" && probe.activeTurnId === null;
    }, "inflight session cancelled");
    expect(server.store.getTaskIndex("t-r2b-inflight")?.status).toBe("paused");
    expect(server.store.getStageLease("t-r2b-inflight")?.state).toBe("expired");
  });

  it("Round 3 closure: guards start errors & async gate/deliver races on pause, runs scratch_dir deliver.mode=run_cmd, and maps directory host_scoped without trailing slash", async () => {
    const kilnHome = makeTempDir("kiln-m2-r3-");
    const hostDir = makeTempDir("kiln-m2-r3-hostdir-");
    const targetIni = path.join(hostDir, "config.ini");
    writeFileAtomic(targetIni, "old=1\n");

    const fakeBackend = new FakeBackend();
    const origStart = fakeBackend.start.bind(fakeBackend);

    let reject429EnteredResolve!: () => void;
    const reject429Entered = new Promise<void>((r) => {
      reject429EnteredResolve = r;
    });
    let releaseReject429!: () => void;
    const reject429Gate = new Promise<void>((r) => {
      releaseReject429 = r;
    });

    let rejectErrEnteredResolve!: () => void;
    const rejectErrEntered = new Promise<void>((r) => {
      rejectErrEnteredResolve = r;
    });
    let releaseRejectErr!: () => void;
    const rejectErrGate = new Promise<void>((r) => {
      releaseRejectErr = r;
    });

    fakeBackend.start = async (spec) => {
      if (spec.taskId === "t-r3-start-429") {
        reject429EnteredResolve();
        await reject429Gate;
        throw new Error("429 Too Many Requests");
      }
      if (spec.taskId === "t-r3-start-err") {
        rejectErrEnteredResolve();
        await rejectErrGate;
        throw new Error("simulated backend crash on start");
      }
      return origStart(spec);
    };

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      rateLimitCooldownMs: 10,
      tokenSecret: "m2-e2e-r3-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        const token =
          fakeBackend
            .getRecordedSpecs()
            .find((s) => s.runId === ctx.runId)
            ?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";

        if (req.action === "r3_scratch_runcmd" || req.action === "r3_gate_slow") {
          writeFileAtomic(
            path.join(server.store.paths.workspaceDir(ctx.taskId), "out.txt"),
            `ready:${ctx.taskId}\n`,
          );
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: "scratch",
                output_ref: "out.txt",
                changed_paths: ["out.txt"],
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "r3_host_dir") {
          writeFileAtomic(
            path.join(server.store.paths.stagedDir(ctx.taskId), "config.ini"),
            "new=2\n",
          );
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: "host",
                output_ref: "config.ini",
                changed_paths: ["config.ini"],
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        await ctx.backend.answer(req.id, true);
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    server.store.writeSpace({
      schema_version: 1,
      id: "local",
      name: "Local",
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    server.store.writeConfig("roles", defaultRoles());
    server.store.writeConfig(
      "limits",
      defaultLimits({ max_concurrent_slots: 4, max_waiting_wip: 10, retries_per_stage: 0 }),
    );
    server.store.writeConfig("pricing", defaultPricing());

    await server.start();

    // 1. P1 #1a: backend.start() rejection (429 & runtime error) after /pause never re-queues or waits
    const makeScratchCard = (
      id: string,
      acceptCmd: string,
      deliver: { mode: "manual"; cmd: null } | { mode: "run_cmd"; cmd: string },
    ) => ({
      schema_version: 1 as const,
      id,
      title: `Task ${id}`,
      space: "local",
      priority: "P2" as const,
      track: "L1" as const,
      workspace_mode: "scratch_dir" as const,
      parent: null,
      depends_on: [],
      contract_version: 1,
      contract: {
        goal: "Round 3 check",
        end: "Done",
        accept_cmd: acceptCmd,
        accept_files_hash: "sha256:r3",
        scope: ["out.txt"],
        deliver,
        human_accept: false,
        external_actions: "ask" as const,
      },
      limits: { retries_per_stage: 0, review_rounds: 1, advisor_calls: 0, max_tokens: 5_000_000 },
      created_at: "2026-11-19T12:00:00.000Z",
      updated_at: "2026-11-19T12:00:00.000Z",
    });

    server.stateMachine.createTask(
      makeScratchCard("t-r3-start-429", "node -e \"process.exit(0)\"", { mode: "manual", cmd: null }),
      "# 429 race",
    );
    server.stateMachine.createTask(
      makeScratchCard("t-r3-start-err", "node -e \"process.exit(0)\"", { mode: "manual", cmd: null }),
      "# err race",
    );
    void server.orchestrator.wake();
    await Promise.all([reject429Entered, rejectErrEntered]);

    expect(
      (
        await server.app.request(
          new Request("http://127.0.0.1/api/tasks/t-r3-start-429/pause", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "pause before 429" }),
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await server.app.request(
          new Request("http://127.0.0.1/api/tasks/t-r3-start-err/pause", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "pause before start err" }),
          }),
        )
      ).status,
    ).toBe(200);

    releaseReject429();
    releaseRejectErr();
    await new Promise((r) => setTimeout(r, 60));

    expect(server.store.getTaskIndex("t-r3-start-429")?.status).toBe("paused");
    expect(server.store.getStageLease("t-r3-start-429")?.state).toBe("expired");
    expect(server.store.getTaskIndex("t-r3-start-err")?.status).toBe("paused");
    expect(server.store.getStageLease("t-r3-start-err")?.state).toBe("expired");
    expect(server.pendingDecisions.get("t-r3-start-err")).toBeNull();

    // 2. P1 #1b: /pause while finalizeWorkerRun awaits slow runVerificationGate aborts child tree & preserves paused
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r3_gate_slow", detail: "slow gate" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r3-gate-race", role: "worker" },
    );
    server.stateMachine.createTask(
      makeScratchCard(
        "t-r3-gate-race",
        "node -e \"require('fs').writeFileSync('gate-started.tmp','1'); setTimeout(() => process.exit(0), 10000);\"",
        { mode: "manual", cmd: null },
      ),
      "# Slow gate",
    );
    await server.orchestrator.wake();
    const slowGateMarker = path.join(server.store.paths.workspaceDir("t-r3-gate-race"), "gate-started.tmp");
    await waitUntil(() => fs.existsSync(slowGateMarker), "slow verification gate started");

    const pauseGateStartMs = Date.now();
    const pauseGateRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-r3-gate-race/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "abort slow gate" }),
      }),
    );
    expect(pauseGateRes.status).toBe(200);
    expect(Date.now() - pauseGateStartMs).toBeLessThan(3_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(server.store.getTaskIndex("t-r3-gate-race")?.status).toBe("paused");

    // 3. P1 #2: scratch_dir with deliver.mode=run_cmd & external_actions=ask requires approval then executes cmd
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r3_scratch_runcmd", detail: "scratch runcmd" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r3-scratch-cmd", role: "worker" },
    );
    server.stateMachine.createTask(
      makeScratchCard(
        "t-r3-scratch-cmd",
        "node -e \"process.exit(0)\"",
        {
          mode: "run_cmd",
          cmd: "node -e \"require('fs').writeFileSync('delivered.marker','executed')\"",
        },
      ),
      "# Scratch run_cmd",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-r3-scratch-cmd")?.status === "waiting", "scratch run_cmd waiting");
    const cmdDec = server.pendingDecisions.get("t-r3-scratch-cmd")!;
    expect(cmdDec.reason).toBe("external_action_approval");

    const approveCmdRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-r3-scratch-cmd/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision_id: cmdDec.id,
          option_id: "opt-run-deliver-cmd",
          action: "resume",
          apply_ledger_rule: false,
        }),
      }),
    );
    expect(approveCmdRes.status).toBe(200);
    await waitUntil(() => server.store.getTaskIndex("t-r3-scratch-cmd")?.status === "done", "scratch run_cmd done");
    const deliveredMarkerPath = path.join(
      server.store.paths.workspaceDir("t-r3-scratch-cmd"),
      "delivered.marker",
    );
    expect(fs.readFileSync(deliveredMarkerPath, "utf8")).toBe("executed");

    // 4. P2 #4: host_scoped existing directory in contract.scope without trailing slash maps file into directory
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r3_host_dir", detail: "host dir" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r3-hostdir", role: "worker" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-r3-hostdir",
        title: "Host dir without trailing slash",
        space: "local",
        priority: "P2",
        track: "L1",
        workspace_mode: "host_scoped",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Map staged/config.ini into hostDir without trailing slash",
          end: "Updated config.ini",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:r3host",
          scope: [hostDir],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 0, review_rounds: 1, advisor_calls: 0, max_tokens: 5_000_000 },
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# Host dir",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-r3-hostdir")?.status === "waiting", "hostdir approval");
    const hostDec = server.pendingDecisions.get("t-r3-hostdir")!;
    expect(hostDec.reason).toBe("host_scoped_approval");
    expect(
      (
        await server.app.request(
          new Request("http://127.0.0.1/api/tasks/t-r3-hostdir/decide", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              decision_id: hostDec.id,
              option_id: "opt-apply-host",
              action: "resume",
              apply_ledger_rule: false,
            }),
          }),
        )
      ).status,
    ).toBe(200);
    await waitUntil(() => server.store.getTaskIndex("t-r3-hostdir")?.status === "done", "hostdir done");
    expect(fs.readFileSync(targetIni, "utf8")).toBe("new=2\n");

    // 5. P1 #1c: /pause while dispatchDeliverStage awaits async deliverHandler waits and keeps paused (separate server)
    const deliverKilnHome = makeTempDir("kiln-m2-r3-deliv-");
    const deliverFakeBackend = new FakeBackend();
    let deliverEnteredResolve!: () => void;
    const deliverEntered = new Promise<void>((r) => {
      deliverEnteredResolve = r;
    });
    let releaseDeliver!: () => void;
    const deliverGate = new Promise<void>((r) => {
      releaseDeliver = r;
    });
    const deliverServer = new KilndServer({
      kilnHome: deliverKilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-e2e-r3-deliv-secret-0123456789abcdef",
      deliverHandler: async () => {
        deliverEnteredResolve();
        await deliverGate;
        return { status: "done", deliverRef: "should-not-write" };
      },
      approvalHandler: async (req, ctx) => {
        const token =
          deliverFakeBackend
            .getRecordedSpecs()
            .find((s) => s.runId === ctx.runId)
            ?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";
        if (req.action === "r3_deliv_impl") {
          writeFileAtomic(
            path.join(deliverServer.store.paths.workspaceDir(ctx.taskId), "out.txt"),
            "ready\n",
          );
          await deliverServer.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: "scratch",
                output_ref: "out.txt",
                changed_paths: ["out.txt"],
              }),
            }),
          });
        }
        await ctx.backend.answer(req.id, true);
      },
    });
    servers.push(deliverServer);
    deliverServer.backendRegistry.register(deliverFakeBackend);
    deliverServer.store.writeSpace({
      schema_version: 1,
      id: "local",
      name: "Local",
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    deliverServer.store.writeConfig("roles", defaultRoles());
    deliverServer.store.writeConfig("limits", defaultLimits({ retries_per_stage: 0 }));
    deliverServer.store.writeConfig("pricing", defaultPricing());
    await deliverServer.start();

    deliverFakeBackend.enqueueScript(
      [{ kind: "approval", action: "r3_deliv_impl", detail: "impl" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r3-deliver-race", role: "worker" },
    );
    deliverServer.stateMachine.createTask(
      makeScratchCard("t-r3-deliver-race", "node -e \"process.exit(0)\"", { mode: "manual", cmd: null }),
      "# Deliver race",
    );
    await deliverServer.orchestrator.wake();
    await deliverEntered;

    const pauseDeliverPromise = deliverServer.app.request(
      new Request("http://127.0.0.1/api/tasks/t-r3-deliver-race/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "pause during deliver" }),
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    releaseDeliver();
    expect((await pauseDeliverPromise).status).toBe(200);
    expect(deliverServer.store.getTaskIndex("t-r3-deliver-race")?.status).toBe("paused");
  }, 20_000);

  it("P0 #2: early wb_submit_receipt during delayed or failing backend.start() never stalls in running and preserves single-commit lease semantics", async () => {
    const kilnHome = makeTempDir("kiln-m2-p0-2-");
    const fakeBackend = new FakeBackend();
    const origStart = fakeBackend.start.bind(fakeBackend);

    let slowEnteredResolve!: () => void;
    const slowEntered = new Promise<void>((r) => {
      slowEnteredResolve = r;
    });
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => {
      releaseSlow = r;
    });

    let errEnteredResolve!: () => void;
    const errEntered = new Promise<void>((r) => {
      errEnteredResolve = r;
    });
    let releaseErr!: () => void;
    const errGate = new Promise<void>((r) => {
      releaseErr = r;
    });

    fakeBackend.start = async (spec) => {
      if (spec.taskId === "t-p0-2-slow" && spec.role === "worker") {
        const sessionRef = await origStart(spec);
        slowEnteredResolve();
        await slowGate;
        return sessionRef;
      }
      if (spec.taskId === "t-p0-2-err" && spec.role === "worker") {
        await origStart(spec);
        errEnteredResolve();
        await errGate;
        throw new Error("simulated backend.start() timeout after receipt");
      }
      return origStart(spec);
    };

    const lateThirdReceiptRef: { body: Record<string, unknown> | null } = { body: null };
    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-e2e-p0-2-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        const token =
          fakeBackend
            .getRecordedSpecs()
            .find((s) => s.runId === ctx.runId)
            ?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";

        if (req.action === "p0_2_after_start") {
          // 3rd late submission AFTER backend.start() resolved MUST still be rejected
          const lateRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: "scratch_dir",
                output_ref: "out.txt",
                changed_paths: ["out.txt"],
              }),
            }),
          });
          expect(lateRes.status).toBe(200);
          lateThirdReceiptRef.body = lateRes.body as Record<string, unknown>;
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "p0_2_review") {
          const revRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeReviewerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                reviewed_ref: "out.txt",
                verdict: "pass",
              }),
            }),
          });
          expect(revRes.status).toBe(200);
          expect((revRes.body as { accepted: boolean }).accepted).toBe(true);
          await ctx.backend.answer(req.id, true);
          return;
        }

        await ctx.backend.answer(req.id, true);
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    server.store.writeSpace({
      schema_version: 1,
      id: "local",
      name: "Local",
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    const baseRolesP02 = defaultRoles();
    server.store.writeConfig("roles", {
      ...baseRolesP02,
      roles: {
        ...baseRolesP02.roles,
        reviewer: { agent: "codex", model: "gpt-6-luna", allow_full_access_fallback: false },
      },
    });
    server.store.writeConfig(
      "limits",
      defaultLimits({ max_concurrent_slots: 4, retries_per_stage: 0 }),
    );
    server.store.writeConfig("pricing", defaultPricing());

    await server.start();

    const makeL2ScratchCard = (id: string) => ({
      schema_version: 1 as const,
      id,
      title: `P0-2 ${id}`,
      space: "local",
      priority: "P2" as const,
      track: "L2" as const,
      workspace_mode: "scratch_dir" as const,
      parent: null,
      depends_on: [],
      contract_version: 1,
      contract: {
        goal: "Converge receipt submitted before backend.start() returns",
        end: "Done",
        accept_cmd: "node -e \"process.exit(0)\"",
        accept_files_hash: "sha256:p02",
        scope: ["out.txt"],
        deliver: { mode: "manual" as const, cmd: null },
        human_accept: false,
        external_actions: "ask" as const,
      },
      limits: { retries_per_stage: 0, review_rounds: 2, advisor_calls: 0, max_tokens: 5_000_000 },
      created_at: "2026-11-19T12:00:00.000Z",
      updated_at: "2026-11-19T12:00:00.000Z",
    });

    // Scenario A: delayed backend.start() returns after 2 concurrent early wb_submit_receipt calls
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "p0_2_after_start", detail: "late receipt check" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-p0-2-slow", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "p0_2_review", detail: "review slow" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-p0-2-slow", role: "reviewer" },
    );
    server.stateMachine.createTask(makeL2ScratchCard("t-p0-2-slow"), "# Slow start race");

    // Scenario B: backend.start() throws after early wb_submit_receipt committed RECEIPT.md
    fakeBackend.enqueueScript(
      [{ kind: "exit", reason: "completed" }],
      { taskId: "t-p0-2-err", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "p0_2_review", detail: "review err" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-p0-2-err", role: "reviewer" },
    );
    server.stateMachine.createTask(makeL2ScratchCard("t-p0-2-err"), "# Start error after receipt");

    void server.orchestrator.wake();
    await Promise.all([slowEntered, errEntered]);

    // Write artifact & submit 2 concurrent receipts for t-p0-2-slow while start() is still pending
    writeFileAtomic(
      path.join(server.store.paths.workspaceDir("t-p0-2-slow"), "out.txt"),
      "early slow output\n",
    );
    const slowToken =
      fakeBackend
        .getRecordedSpecs()
        .find((s) => s.taskId === "t-p0-2-slow" && s.role === "worker")
        ?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";
    const slowSpec = fakeBackend
      .getRecordedSpecs()
      .find((s) => s.taskId === "t-p0-2-slow" && s.role === "worker")!;

    const [slowSub1, slowSub2] = await Promise.all([
      server.invokeMcpRpc({
        method: "POST",
        url: "/rpc/mcp/wb_submit_receipt",
        headers: { Authorization: `Bearer ${slowToken}` },
        rawBody: JSON.stringify({
          markdown: makeWorkerReceiptMarkdown({
            run_id: slowSpec.runId,
            contract_version: 1,
            input_ref: "scratch_dir",
            output_ref: "out.txt",
            changed_paths: ["out.txt"],
            extraBody: "Submission A",
          }),
        }),
      }),
      server.invokeMcpRpc({
        method: "POST",
        url: "/rpc/mcp/wb_submit_receipt",
        headers: { Authorization: `Bearer ${slowToken}` },
        rawBody: JSON.stringify({
          markdown: makeWorkerReceiptMarkdown({
            run_id: slowSpec.runId,
            contract_version: 1,
            input_ref: "scratch_dir",
            output_ref: "out.txt",
            changed_paths: ["out.txt"],
            extraBody: "Submission B",
          }),
        }),
      }),
    ]);
    expect(slowSub1.status).toBe(200);
    expect(slowSub2.status).toBe(200);
    const slowFlags = [
      Boolean((slowSub1.body as { accepted: boolean }).accepted),
      Boolean((slowSub2.body as { accepted: boolean }).accepted),
    ].sort();
    expect(slowFlags).toEqual([false, true]);
    const slowRejectedBody = (slowSub1.body as { accepted: boolean }).accepted
      ? (slowSub2.body as { reason: string; archivedPath: string })
      : (slowSub1.body as { reason: string; archivedPath: string });
    expect(slowRejectedBody.reason).toBe("lease_mismatch_or_expired");
    expect(fs.existsSync(slowRejectedBody.archivedPath)).toBe(true);
    expect(slowRejectedBody.archivedPath).toContain(`${path.sep}history${path.sep}`);
    expect(server.store.getStageLease("t-p0-2-slow")?.state).toBe("completed");

    // Write artifact & submit receipt for t-p0-2-err while start() is pending, then reject start()
    writeFileAtomic(
      path.join(server.store.paths.workspaceDir("t-p0-2-err"), "out.txt"),
      "early err output\n",
    );
    const errToken =
      fakeBackend
        .getRecordedSpecs()
        .find((s) => s.taskId === "t-p0-2-err" && s.role === "worker")
        ?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";
    const errSpec = fakeBackend
      .getRecordedSpecs()
      .find((s) => s.taskId === "t-p0-2-err" && s.role === "worker")!;

    const errSub = await server.invokeMcpRpc({
      method: "POST",
      url: "/rpc/mcp/wb_submit_receipt",
      headers: { Authorization: `Bearer ${errToken}` },
      rawBody: JSON.stringify({
        markdown: makeWorkerReceiptMarkdown({
          run_id: errSpec.runId,
          contract_version: 1,
          input_ref: "scratch_dir",
          output_ref: "out.txt",
          changed_paths: ["out.txt"],
        }),
      }),
    });
    expect(errSub.status).toBe(200);
    expect((errSub.body as { accepted: boolean }).accepted).toBe(true);

    // Release both delayed starts: slow returns sessionRef, err throws Error
    releaseSlow();
    releaseErr();

    await waitUntil(() => server.store.getTaskIndex("t-p0-2-slow")?.status === "done", "t-p0-2-slow done");
    await waitUntil(() => server.store.getTaskIndex("t-p0-2-err")?.status === "done", "t-p0-2-err done");

    expect(lateThirdReceiptRef.body).not.toBeNull();
    expect(lateThirdReceiptRef.body?.accepted).toBe(false);
    expect(lateThirdReceiptRef.body?.reason).toBe("lease_mismatch_or_expired");
    expect(fs.existsSync(lateThirdReceiptRef.body?.archivedPath as string)).toBe(true);
    expect(server.pendingDecisions.get("t-p0-2-err")).toBeNull();
  }, 20_000);

  it("P1 #3 & P1 #6: kilnd auto-commits clean git_worktree changes after gate pass, blocks out-of-scope auto-commit, and emits parseable role receipt templates in HANDOFF.md", async () => {
    const kilnHome = makeTempDir("kiln-m2-p1-3-");
    const { repoPath, baseCommit } = initGitRepo("p1-3");
    const fakeBackend = new FakeBackend();

    const extractTemplateFromHandoff = (handoff: string): string => {
      const m = /```markdown\n([\s\S]*?)\n```/.exec(handoff);
      if (!m) {
        throw new Error("Missing markdown template fence in HANDOFF.md");
      }
      return m[1]!;
    };

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-e2e-p1-3-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        const token =
          fakeBackend
            .getRecordedSpecs()
            .find((s) => s.runId === ctx.runId)
            ?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";
        const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");

        if (req.action === "p1_3_worker_no_git") {
          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-implement"))
            .sort()
            .at(-1)!;
          const handoff = fs.readFileSync(
            server.store.paths.handoffMd(ctx.taskId, runDir),
            "utf8",
          );
          expect(handoff).toContain("严禁在受限沙箱里执行 git commit、git merge 或 git push");
          expect(handoff).toContain("## 阶段回执格式要求");
          const workerTpl = extractTemplateFromHandoff(handoff);
          const validatedTpl = parseAndValidateReceipt("worker", workerTpl);
          expect(validatedTpl.ok).toBe(true);

          // Edit file WITHOUT running git add or git commit
          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), "export const v = 303;\n");
          const subRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: baseCommit,
                output_ref: "src/app.ts",
                changed_paths: ["src/app.ts"],
              }),
            }),
          });
          expect(subRes.status).toBe(200);
          expect((subRes.body as { accepted: boolean }).accepted).toBe(true);
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "p1_3_reviewer") {
          // Worktree must already be cleanly committed by kilnd before reviewer runs
          expect(git(["status", "--porcelain"], wtPath).trim()).toBe("");
          const headCommit = git(["rev-parse", "HEAD"], wtPath).trim();
          expect(headCommit).not.toBe(baseCommit);
          expect(git(["log", "-1", "--pretty=%s"], wtPath).trim()).toBe(
            "kiln(t-p1-3-auto): Auto commit worktree (round 1)",
          );

          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-review"))
            .sort()
            .at(-1)!;
          const handoff = fs.readFileSync(
            server.store.paths.handoffMd(ctx.taskId, runDir),
            "utf8",
          );
          expect(handoff).toContain("绝不能写成数组 `[]`");
          const reviewerTpl = extractTemplateFromHandoff(handoff);
          const validatedTpl = parseAndValidateReceipt("reviewer", reviewerTpl);
          expect(validatedTpl.ok).toBe(true);

          const revRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeReviewerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                reviewed_ref: headCommit,
                verdict: "pass",
              }),
            }),
          });
          expect(revRes.status).toBe(200);
          expect((revRes.body as { accepted: boolean }).accepted).toBe(true);
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "p1_3_oob_dirty") {
          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), "export const v = 404;\n");
          const subRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: baseCommit,
                output_ref: "src/app.ts",
                changed_paths: ["src/app.ts"],
              }),
            }),
          });
          expect(subRes.status).toBe(200);
          await ctx.backend.answer(req.id, true);
          return;
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
    const baseRolesP13 = defaultRoles();
    server.store.writeConfig("roles", {
      ...baseRolesP13,
      roles: {
        ...baseRolesP13.roles,
        reviewer: { agent: "codex", model: "gpt-6-luna", allow_full_access_fallback: false },
      },
    });
    server.store.writeConfig("limits", defaultLimits());
    server.store.writeConfig("pricing", defaultPricing());

    await server.start();

    // 1. L2 git_worktree + merge_main with zero git commands from worker -> done
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "p1_3_worker_no_git", detail: "edit without git commit" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-p1-3-auto", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "p1_3_reviewer", detail: "verify auto-committed HEAD" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-p1-3-auto", role: "reviewer" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-p1-3-auto",
        title: "Auto commit worktree",
        space: "kiln",
        priority: "P2",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Modify src/app.ts without running git commit in worker sandbox",
          end: "Merged into main",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "pending",
          scope: ["src/app.ts"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# Auto commit test",
    );

    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-p1-3-auto")?.status === "done", "t-p1-3-auto done");
    expect(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf8")).toBe("export const v = 303;\n");
    expect(git(["log", "-1", "--pretty=%s"], repoPath).trim()).toContain(
      "kiln(t-p1-3-auto): Auto commit worktree (round 1)",
    );

    // 2. If accept_cmd leaves an out-of-scope file dirty, kilnd refuses to auto-commit and blocks at deliver
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "p1_3_oob_dirty", detail: "edit app.ts" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-p1-3-oob", role: "worker" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-p1-3-oob",
        title: "Refuse OOB auto commit",
        space: "kiln",
        priority: "P2",
        track: "L1",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Do not auto-commit out-of-scope files produced during accept_cmd",
          end: "Blocked safely before merge_main",
          accept_cmd: "node -e \"require('fs').writeFileSync('stray-outside-scope.tmp','oob')\"",
          accept_files_hash: "pending",
          scope: ["src/app.ts"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 0, review_rounds: 1, advisor_calls: 0, max_tokens: 5_000_000 },
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# OOB dirty test",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-p1-3-oob")?.status === "waiting", "t-p1-3-oob waiting");
    expect(server.pendingDecisions.get("t-p1-3-oob")?.reason).toBe("worktree_dirty_before_merge");
    expect(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf8")).toBe("export const v = 303;\n");
  }, 20_000);

  it("P1 #6: HANDOFF.md embeds valid parseable receipt templates for verifier, triage, and advisor stages", async () => {
    const kilnHome = makeTempDir("kiln-m2-p1-6-roles-");
    const fakeBackend = new FakeBackend();

    const extractTemplateFromHandoff = (handoff: string): string => {
      const m = /```markdown\n([\s\S]*?)\n```/.exec(handoff);
      if (!m) {
        throw new Error("Missing markdown template fence in HANDOFF.md");
      }
      return m[1]!;
    };

    const validatedRoles: string[] = [];

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-e2e-p1-6-roles-secret-0123456789abcdef",
      approvalHandler: async (req, ctx) => {
        const token =
          fakeBackend
            .getRecordedSpecs()
            .find((s) => s.runId === ctx.runId)
            ?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";

        const runDir = fs
          .readdirSync(server.store.paths.runsDir(ctx.taskId))
          .filter((d) => {
            if (ctx.role === "triage") return d.endsWith("-triage");
            if (ctx.role === "advisor") return d.endsWith("-advise");
            if (ctx.role === "verifier") return d.endsWith("-accept");
            if (ctx.role === "reviewer") return d.endsWith("-review");
            return d.endsWith("-implement");
          })
          .sort()
          .at(-1)!;
        const handoff = fs.readFileSync(
          server.store.paths.handoffMd(ctx.taskId, runDir),
          "utf8",
        );
        const tpl = extractTemplateFromHandoff(handoff);

        if (req.action === "p1_6_triage") {
          expect(parseAndValidateReceipt("triage", tpl).ok).toBe(true);
          validatedRoles.push("triage");
          const res = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: serializeFrontmatterMarkdown(
                {
                  run_id: ctx.runId,
                  contract_version: ctx.card.contract_version,
                  recommendation: "escalate_advisor",
                  summary: "Consult advisor",
                },
                "## 异常事实\n首次失败\n\n## 研判结论\n转顾问\n",
              ),
            }),
          });
          expect(res.status).toBe(200);
        } else if (req.action === "p1_6_advisor") {
          expect(parseAndValidateReceipt("advisor", tpl).ok).toBe(true);
          validatedRoles.push("advisor");
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
                  chosen_approach: "Write out.txt",
                },
                "## 技术取舍\n最小修改\n\n## 授权裁决\n继续实施\n",
              ),
            }),
          });
          expect(res.status).toBe(200);
        } else if (req.action === "p1_6_worker_ok") {
          writeFileAtomic(
            path.join(server.store.paths.workspaceDir(ctx.taskId), "out.txt"),
            "ok\n",
          );
          const res = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: "scratch_dir",
                output_ref: "out.txt",
                changed_paths: ["out.txt"],
              }),
            }),
          });
          expect(res.status).toBe(200);
        } else if (req.action === "p1_6_reviewer_ok") {
          const res = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeReviewerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                reviewed_ref: "out.txt",
                verdict: "pass",
              }),
            }),
          });
          expect(res.status).toBe(200);
        } else if (req.action === "p1_6_verifier") {
          expect(parseAndValidateReceipt("verifier", tpl).ok).toBe(true);
          validatedRoles.push("verifier");
          const res = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: serializeFrontmatterMarkdown(
                {
                  run_id: ctx.runId,
                  contract_version: ctx.card.contract_version,
                  verified_ref: "out.txt",
                  verdict: "pass",
                  passed_scenarios: 1,
                  failed_scenarios: 0,
                },
                "## 验收场景明细\n- 场景 1：验证通过\n",
              ),
            }),
          });
          expect(res.status).toBe(200);
        }

        await ctx.backend.answer(req.id, true);
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    server.store.writeSpace({
      schema_version: 1,
      id: "local",
      name: "Local",
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    const baseRoles = defaultRoles();
    server.store.writeConfig("roles", {
      ...baseRoles,
      roles: {
        ...baseRoles.roles,
        reviewer: { agent: "codex", model: "gpt-6-luna", allow_full_access_fallback: false },
        verifier: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
        triage: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
        advisor: { agent: "codex", model: "gpt-6-luna", allow_full_access_fallback: false },
      },
    });
    server.store.writeConfig("limits", defaultLimits({ retries_per_stage: 0, advisor_calls: 1 }));
    server.store.writeConfig("pricing", defaultPricing());

    await server.start();

    fakeBackend.enqueueScript(
      [{ kind: "exit", reason: "failed", detail: "trigger triage" }],
      { taskId: "t-p1-6-roles", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "p1_6_triage", detail: "triage" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-p1-6-roles", role: "triage" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "p1_6_advisor", detail: "advisor" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-p1-6-roles", role: "advisor" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "p1_6_worker_ok", detail: "worker ok" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-p1-6-roles", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "p1_6_reviewer_ok", detail: "reviewer ok" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-p1-6-roles", role: "reviewer" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "p1_6_verifier", detail: "verifier" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-p1-6-roles", role: "verifier" },
    );

    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-p1-6-roles",
        title: "Verify role receipt templates",
        space: "local",
        priority: "P2",
        track: "L2",
        workspace_mode: "scratch_dir",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Verify triage, advisor, verifier HANDOFF receipt templates",
          end: "Done",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:p16roles",
          scope: ["out.txt"],
          deliver: { mode: "manual", cmd: null },
          human_accept: true,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 0, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-19T12:00:00.000Z",
        updated_at: "2026-11-19T12:00:00.000Z",
      },
      "# Role templates test",
    );

    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-p1-6-roles")?.status === "done", "t-p1-6-roles done");
    expect(validatedRoles).toEqual(["triage", "advisor", "verifier"]);
  }, 20_000);

  it("strips return_external options from non-MCP need_decision receipts and injects host_scoped guidance into HANDOFF", async () => {
    const kilnHome = makeTempDir("kiln-m2-strip-ext-");
    const hostTargetDir = makeTempDir("kiln-host-target-");
    const fakeBackend = new FakeBackend();
    const capturedHandoffs: string[] = [];

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-e2e-strip-ext-secret-0123456789",
      approvalHandler: async (req, ctx) => {
        if (req.action === "pi_bad_external") {
          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-implement"))
            .sort()
            .at(-1)!;
          capturedHandoffs.push(
            fs.readFileSync(server.store.paths.handoffMd(ctx.taskId, runDir), "utf8"),
          );
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeWorkerReceiptMarkdown({
              run_id: ctx.runId,
              contract_version: ctx.card.contract_version,
              outcome: "need_decision",
              input_ref: "host_scoped",
              output_ref: "staged",
              changed_paths: [],
              extraFrontmatter: {
                question: "是否转交外部执行？",
                options: [
                  {
                    id: "host-execute",
                    label: "交由宿主机执行方落盘",
                    action: "return_external",
                    recommended: true,
                  },
                ],
              },
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
      id: "local",
      name: "Local",
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    const baseRoles = defaultRoles();
    server.store.writeConfig("roles", {
      ...baseRoles,
      roles: {
        ...baseRoles.roles,
        worker: { agent: "pi", model: "magpie/group/work", allow_full_access_fallback: false },
      },
    });
    server.store.writeConfig("limits", defaultLimits());
    server.store.writeConfig("pricing", defaultPricing());

    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "pi_bad_external", detail: "ask" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-strip-ext", role: "worker" },
    );

    await server.start();
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-strip-ext",
        title: "Strip return_external from Pi receipt",
        space: "local",
        priority: "P2",
        track: "L1",
        workspace_mode: "host_scoped",
        parent: null,
        depends_on: [],
        contract_version: 1,
        contract: {
          goal: "Write host file",
          end: "Applied",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:stripext",
          scope: [hostTargetDir],
          deliver: { mode: "manual", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 1, review_rounds: 1, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-22T02:00:00.000Z",
        updated_at: "2026-11-22T02:00:00.000Z",
      },
      "# Host task",
    );

    await server.orchestrator.wake();
    await waitUntil(
      () => server.store.getTaskIndex("t-strip-ext")?.status === "waiting",
      "t-strip-ext waiting",
      15_000,
    );

    const pending = server.pendingDecisions.get("t-strip-ext")!;
    expect(pending.options.some((o) => o.action === "return_external")).toBe(false);
    expect(pending.options.some((o) => o.action === "resume")).toBe(true);
    expect(pending.options.some((o) => o.action === "cancel")).toBe(true);
    expect(pending.question).toContain("已由内核移除不合法的 return_external 选项");
    expect(capturedHandoffs[0]).toContain("严禁使用或提出 action: return_external");
  }, 15_000);

  it("executes composable workflow presets end-to-end: quick, host_op two-phase single-approval (#7), and full_delivery with plan/PLAN.md (#9)", async () => {
    const kilnHome = makeTempDir("kiln-m2-wf-");
    const hostRoot = makeTempDir("kiln-m2-wf-host-");
    const { repoPath, baseCommit } = initGitRepo("wf");
    const fakeBackend = new FakeBackend();

    const targetHostScript = path.join(hostRoot, "clean-cache.cjs");
    const targetCleanedFlag = path.join(hostRoot, "cache.cleaned");
    fs.writeFileSync(targetHostScript, "// old placeholder\n");
    const canonicalHostScript = realpathCanonical(targetHostScript);
    const canonicalCleanedFlag = path.join(realpathCanonical(hostRoot), "cache.cleaned");

    const capturedWorkerHandoffs = new Map<string, string>();

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-e2e-wf-blueprints-secret-012345",
      approvalHandler: async (req, ctx) => {
        const token =
          fakeBackend
            .getRecordedSpecs()
            .find((s) => s.runId === ctx.runId)
            ?.mcpServers?.[0]?.env?.KILN_RUN_TOKEN ?? "";

        if (req.action === "wf_quick_worker") {
          const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), "export const v = 777;\n");
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: baseCommit,
                output_ref: "src/app.ts",
                changed_paths: ["src/app.ts"],
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "wf_hostop_worker") {
          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-implement"))
            .sort()
            .at(-1)!;
          capturedWorkerHandoffs.set(
            ctx.taskId,
            fs.readFileSync(server.store.paths.handoffMd(ctx.taskId, runDir), "utf8"),
          );

          const stagedFile = path.join(server.store.paths.stagedDir(ctx.taskId), "clean-cache.cjs");
          writeFileAtomic(
            stagedFile,
            `require("node:fs").writeFileSync(${JSON.stringify(canonicalCleanedFlag)}, "cleaned-ok\\n");\n`,
          );

          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: "host_scoped",
                output_ref: "staged/clean-cache.cjs",
                changed_paths: [canonicalHostScript],
                accept_result: "skipped",
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "wf_full_advisor") {
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: serializeFrontmatterMarkdown(
                {
                  run_id: ctx.runId,
                  contract_version: ctx.card.contract_version,
                  outcome: "resolved",
                  chosen_approach: "Plan A: update src/app.ts constant to 999",
                },
                [
                  "## 技术取舍",
                  "直接修改 src/app.ts，保持兼容导出。",
                  "",
                  "## 授权裁决",
                  "允许修改 src/app.ts 并运行验收。",
                  "",
                ].join("\n"),
              ),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "wf_full_worker") {
          const runDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-implement"))
            .sort()
            .at(-1)!;
          capturedWorkerHandoffs.set(
            ctx.taskId,
            fs.readFileSync(server.store.paths.handoffMd(ctx.taskId, runDir), "utf8"),
          );

          const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), "export const v = 999;\n");
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: baseCommit,
                output_ref: "src/app.ts",
                changed_paths: ["src/app.ts"],
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "wf_full_reviewer") {
          const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
          const headCommit = git(["rev-parse", "HEAD"], wtPath).trim();
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeReviewerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                reviewed_ref: headCommit,
                verdict: "pass",
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "wf_full_verifier") {
          const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
          const headCommit = git(["rev-parse", "HEAD"], wtPath).trim();
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: serializeFrontmatterMarkdown(
                {
                  run_id: ctx.runId,
                  contract_version: ctx.card.contract_version,
                  verified_ref: headCommit,
                  verdict: "pass",
                  passed_scenarios: 1,
                  failed_scenarios: 0,
                },
                "## 验收场景明细\n- 场景 1：export const v = 999 已生效\n",
              ),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        await ctx.backend.answer(req.id, true);
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    server.store.writeSpace({
      schema_version: 1,
      id: "wfproj",
      name: "Workflow Proj",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    server.store.writeSpace({
      schema_version: 1,
      id: "local",
      name: "Local",
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });

    const baseRoles = defaultRoles();
    server.store.writeConfig("roles", {
      ...baseRoles,
      roles: {
        ...baseRoles.roles,
        reviewer: { agent: "codex", model: "gpt-6-luna", allow_full_access_fallback: false },
        advisor: { agent: "codex", model: "gpt-6-luna", allow_full_access_fallback: false },
        verifier: { agent: "codex", model: "gpt-6-luna", allow_full_access_fallback: false },
      },
    });
    server.store.writeConfig("limits", defaultLimits({ max_concurrent_slots: 1 }));
    server.store.writeConfig("pricing", defaultPricing());
    await server.start();

    // Case 1: quick preset (implement -> verify -> deliver) completes with zero reviewer runs
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "wf_quick_worker", detail: "quick implement" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-wf-quick", role: "worker" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-wf-quick",
        title: "Quick preset task",
        space: "wfproj",
        priority: "P1",
        track: "L1",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        workflow: buildWorkflowPreset("quick"),
        contract_version: 1,
        contract: {
          goal: "Quick update",
          end: "Merged without review",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:quick",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-22T03:00:00.000Z",
        updated_at: "2026-11-22T03:00:00.000Z",
      },
      "# Quick Task",
    );
    await server.orchestrator.wake();
    await waitUntil(
      () => server.store.getTaskIndex("t-wf-quick")?.status === "done",
      "t-wf-quick done",
    );
    expect(
      fakeBackend
        .getRecordedSpecs()
        .some((s) => s.taskId === "t-wf-quick" && s.role === "reviewer"),
    ).toBe(false);
    expect(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf8")).toBe(
      "export const v = 777;\n",
    );

    // Case 2: host_op two-phase deterministic execution (#7 permanent fix)
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "wf_hostop_worker", detail: "stage host cleanup script" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-wf-hostop", role: "worker" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-wf-hostop",
        title: "Host op cleanup caches",
        space: "local",
        priority: "P0",
        track: "L1",
        workspace_mode: "host_scoped",
        parent: null,
        depends_on: [],
        workflow: buildWorkflowPreset("host_op", { hasDeliverCmd: true }),
        contract_version: 1,
        contract: {
          goal: "Clean caches safely",
          end: "Host flag written via two-phase script execution",
          accept_cmd: `node -e "const fs=require('fs');if(fs.readFileSync(process.argv[1],'utf8').trim()!=='cleaned-ok')process.exit(5)" ${JSON.stringify(canonicalCleanedFlag)}`,
          accept_files_hash: "sha256:hostop",
          scope: [`${hostRoot}/**`],
          deliver: {
            mode: "run_cmd",
            cmd: `node ${JSON.stringify(canonicalHostScript)}`,
          },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-22T03:05:00.000Z",
        updated_at: "2026-11-22T03:05:00.000Z",
      },
      "# Host Op Task",
    );
    await server.orchestrator.wake();
    await waitUntil(
      () => server.store.getTaskIndex("t-wf-hostop")?.status === "waiting",
      "t-wf-hostop waiting approval",
    );
    expect(capturedWorkerHandoffs.get("t-wf-hostop")).toContain("host_op 两阶段确定性执行");
    expect(fs.existsSync(targetCleanedFlag)).toBe(false);
    const hostOpDec = server.pendingDecisions.get("t-wf-hostop")!;
    expect(hostOpDec.reason).toBe("host_scoped_approval");
    expect(hostOpDec.question).toContain("sha256:");
    expect(hostOpDec.question).toContain(canonicalHostScript);

    const approveHostRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-wf-hostop/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision_id: hostOpDec.id,
          option_id: "opt-apply-host",
          action: "resume",
          apply_ledger_rule: false,
        }),
      }),
    );
    expect(approveHostRes.status).toBe(200);
    await waitUntil(
      () => server.store.getTaskIndex("t-wf-hostop")?.status === "done",
      "t-wf-hostop done in single approval",
    );
    expect(fs.readFileSync(canonicalCleanedFlag, "utf8").trim()).toBe("cleaned-ok");
    expect(server.pendingDecisions.get("t-wf-hostop")).toBeNull();

    // Case 3: full_delivery preset runs plan(advisor) -> PLAN.md -> implement -> review -> accept(verifier) -> deliver_approval -> merge_main
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "wf_full_advisor", detail: "advisor plan" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-wf-full", role: "advisor" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "wf_full_worker", detail: "full implement" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-wf-full", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "wf_full_reviewer", detail: "full review" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-wf-full", role: "reviewer" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "wf_full_verifier", detail: "full verify" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-wf-full", role: "verifier" },
    );

    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-wf-full",
        title: "Full delivery preset task",
        space: "wfproj",
        priority: "P1",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        workflow: buildWorkflowPreset("full_delivery"),
        contract_version: 1,
        contract: {
          goal: "Deliver with plan + review + verifier + approval",
          end: "v = 999 merged after full pipeline",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:full",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-22T03:10:00.000Z",
        updated_at: "2026-11-22T03:10:00.000Z",
      },
      "# Full Delivery Task",
    );
    await server.orchestrator.wake();
    await waitUntil(
      () => server.store.getTaskIndex("t-wf-full")?.status === "waiting",
      "t-wf-full waiting deliver_approval",
    );

    expect(fs.readFileSync(server.store.paths.planMd("t-wf-full"), "utf8")).toContain(
      "Plan A: update src/app.ts constant to 999",
    );
    expect(capturedWorkerHandoffs.get("t-wf-full")).toContain("技术实施方案 (PLAN.md)");
    const fullRolesExecuted = fakeBackend
      .getRecordedSpecs()
      .filter((s) => s.taskId === "t-wf-full")
      .map((s) => s.role);
    expect(fullRolesExecuted).toEqual(["advisor", "worker", "reviewer", "verifier"]);

    const fullDeliverDec = server.pendingDecisions.get("t-wf-full")!;
    expect(fullDeliverDec.reason).toBe("deliver_approval");
    await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-wf-full/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision_id: fullDeliverDec.id,
          option_id: "opt-approve-deliver",
          action: "resume",
          apply_ledger_rule: false,
        }),
      }),
    );
    await waitUntil(
      () => server.store.getTaskIndex("t-wf-full")?.status === "done",
      "t-wf-full done",
    );
    expect(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf8")).toBe(
      "export const v = 999;\n",
    );
  }, 20_000);

  it("Slice 3 (#10): routes technical ambiguity and stuck_threshold loops to fresh advisor with authority guardrails and exposes PLAN.md", async () => {
    const kilnHome = makeTempDir("kiln-m2-advisor-v3-");
    const { repoPath, baseCommit } = initGitRepo("adv3");
    const fakeBackend = new FakeBackend();

    let stuckAttempt = 0;
    const capturedWorkerHandoffs = new Map<string, string[]>();
    const capturedAdvisorHandoffs = new Map<string, string[]>();

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-e2e-advisor-v3-secret-0123456789",
      approvalHandler: async (req, ctx) => {
        const token = server.issueRunToken({
          taskId: ctx.taskId,
          runId: ctx.runId,
          role: ctx.role,
          contractVersion: ctx.card.contract_version,
        });
        const runDir = fs
          .readdirSync(server.store.paths.runsDir(ctx.taskId))
          .filter((d) => d.includes(ctx.runId) || fs.existsSync(server.store.paths.handoffMd(ctx.taskId, d)))
          .filter((d) => {
            const rawYaml = server.store.paths.runYaml(ctx.taskId, d);
            return fs.existsSync(rawYaml) && fs.readFileSync(rawYaml, "utf8").includes(ctx.runId);
          })[0]!;
        const handoff = fs.readFileSync(server.store.paths.handoffMd(ctx.taskId, runDir), "utf8");

        if (ctx.role === "worker") {
          const list = capturedWorkerHandoffs.get(ctx.taskId) ?? [];
          list.push(handoff);
          capturedWorkerHandoffs.set(ctx.taskId, list);
        }
        if (ctx.role === "advisor") {
          const list = capturedAdvisorHandoffs.get(ctx.taskId) ?? [];
          list.push(handoff);
          capturedAdvisorHandoffs.set(ctx.taskId, list);
        }

        const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");

        // Scenario A: MCP technical_ambiguity routed to advisor -> full body persisted -> worker completes
        if (req.action === "adv_a_worker_ask") {
          const askRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_ask_decision",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              category: "technical_ambiguity",
              reason: "adapter_choice",
              question: "Should config cache use Map or WeakMap?",
              options: [
                { id: "opt-map", label: "Use Map", action: "resume", recommended: true },
                { id: "opt-weak", label: "Use WeakMap", action: "resume", recommended: false },
              ],
            }),
          });
          expect(askRes.status).toBe(200);
          expect((askRes.body as { routedToAdvisor?: boolean }).routedToAdvisor).toBe(true);
          return;
        }

        if (req.action === "adv_a_advisor_resolve") {
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: serializeFrontmatterMarkdown(
                {
                  run_id: ctx.runId,
                  contract_version: ctx.card.contract_version,
                  outcome: "resolved",
                  chosen_approach: "Use explicit Map with deterministic invalidation",
                  decision_kind: "technical_ambiguity",
                  target_stage: "implement",
                },
                [
                  "## 技术取舍",
                  "Map 支持按 key 精准淘汰且可枚举，避免 WeakMap 键约束。",
                  "",
                  "## 授权裁决",
                  "worker 严格在 src/app.ts 内实现 Map 方案。",
                  "",
                ].join("\n"),
              ),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "adv_a_worker_done") {
          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), "export const v = 801;\n");
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: baseCommit,
                output_ref: "src/app.ts",
                changed_paths: ["src/app.ts"],
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "adv_a_reviewer_pass") {
          const headCommit = git(["rev-parse", "HEAD"], wtPath).trim();
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeReviewerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                reviewed_ref: headCommit,
                verdict: "pass",
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        // Scenario B: stuck_threshold=2 consecutive same accept failure short-circuits retries -> advisor
        if (req.action === "adv_b_worker_fail_1" || req.action === "adv_b_worker_fail_2") {
          stuckAttempt += 1;
          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), `export const v = ${stuckAttempt};\n`);
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: baseCommit,
                output_ref: "src/app.ts",
                changed_paths: ["src/app.ts"],
                accept_result: "fail",
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "adv_b_advisor_break") {
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: serializeFrontmatterMarkdown(
                {
                  run_id: ctx.runId,
                  contract_version: ctx.card.contract_version,
                  outcome: "resolved",
                  chosen_approach: "Set export const v = 802 to satisfy accept_cmd",
                  decision_kind: "stuck_recovery",
                },
                "## 技术取舍\n两次返回 exit 2 均因常量值不匹配。\n\n## 授权裁决\n将 src/app.ts 更新为 802。\n",
              ),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "adv_b_worker_fix") {
          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), "export const v = 802;\n");
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: baseCommit,
                output_ref: "src/app.ts",
                changed_paths: ["src/app.ts"],
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "adv_b_reviewer_pass") {
          const headCommit = git(["rev-parse", "HEAD"], wtPath).trim();
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeReviewerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                reviewed_ref: headCommit,
                verdict: "pass",
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        // Scenario C1: requires_scope_expansion=true guardrail blocks auto-resolution
        if (req.action === "adv_c1_worker_ask") {
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_ask_decision",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              category: "architecture_choice",
              reason: "shared_types",
              question: "Need decision on modifying packages/shared vs local file",
              options: [{ id: "opt-1", label: "Check shared", action: "resume", recommended: true }],
            }),
          });
          return;
        }

        if (req.action === "adv_c1_advisor_overreach") {
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: serializeFrontmatterMarkdown(
                {
                  run_id: ctx.runId,
                  contract_version: ctx.card.contract_version,
                  outcome: "resolved",
                  chosen_approach: "Expand scope into tests/**",
                  requires_scope_expansion: true,
                },
                "## 技术取舍\n需要修改 tests 目录。\n\n## 授权裁决\n建议扩 scope。\n",
              ),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        // Scenario C2: plan stage advisor mutates git_worktree -> advisor_workspace_mutation
        if (req.action === "adv_c2_plan_mutate") {
          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), "export const v = 999999;\n");
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: serializeFrontmatterMarkdown(
                {
                  run_id: ctx.runId,
                  contract_version: ctx.card.contract_version,
                  outcome: "resolved",
                  chosen_approach: "Direct code edit during plan",
                  decision_kind: "plan",
                },
                "## 技术取舍\n试图越权直接改文件。\n\n## 授权裁决\n被内核拦下。\n",
              ),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        // Scenario D: human boundary category scope_clarification bypasses advisor straight to waiting
        if (req.action === "adv_d_worker_scope_human") {
          const askRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_ask_decision",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              category: "scope_clarification",
              reason: "need_new_file",
              question: "Can we modify files outside scope?",
              options: [{ id: "opt-ok", label: "Allow", action: "resume", recommended: true }],
            }),
          });
          expect(askRes.status).toBe(200);
          expect((askRes.body as { routedToAdvisor?: boolean }).routedToAdvisor).toBeUndefined();
          return;
        }

        // Scenario E: clean plan -> PLAN.md exposed via GET /api/tasks/:id
        if (req.action === "adv_e_plan_ok") {
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: serializeFrontmatterMarkdown(
                {
                  run_id: ctx.runId,
                  contract_version: ctx.card.contract_version,
                  outcome: "resolved",
                  chosen_approach: "Read-only architecture plan E",
                  decision_kind: "plan",
                },
                "## 技术取舍\n保持单一数据源。\n\n## 授权裁决\n先写实现再跑验收。\n",
              ),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "adv_e_worker_ask_halt") {
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_ask_decision",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              category: "external_action",
              reason: "hold_for_detail",
              question: "Hold here to verify GET /api/tasks/:id plan",
              options: [{ id: "opt-c", label: "Cancel", action: "cancel", recommended: true }],
            }),
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
      id: "advproj",
      name: "Advisor Proj",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });

    const baseRoles = defaultRoles();
    server.store.writeConfig("roles", {
      ...baseRoles,
      roles: {
        ...baseRoles.roles,
        reviewer: { agent: "codex", model: "gpt-6-luna", allow_full_access_fallback: false },
        advisor: { agent: "codex", model: "gpt-6-luna", allow_full_access_fallback: false },
      },
    });
    server.store.writeConfig("limits", defaultLimits({ max_concurrent_slots: 1, retries_per_stage: 3 }));
    server.store.writeConfig("pricing", defaultPricing());
    await server.start();

    // Run Scenario A
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "adv_a_worker_ask", detail: "ask technical ambiguity" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-adv-a", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "adv_a_advisor_resolve", detail: "advisor decide" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-adv-a", role: "advisor" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "adv_a_worker_done", detail: "worker finish" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-adv-a", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "adv_a_reviewer_pass", detail: "review pass" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-adv-a", role: "reviewer" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-adv-a",
        title: "Scenario A technical ambiguity",
        space: "advproj",
        priority: "P0",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        workflow: buildWorkflowPreset("standard_dev"),
        contract_version: 1,
        contract: {
          goal: "Resolve technical ambiguity cleanly",
          end: "Merged Map implementation",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:adva",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-22T08:00:00.000Z",
        updated_at: "2026-11-22T08:00:00.000Z",
      },
      "# Scenario A",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-adv-a")?.status === "done", "t-adv-a done");
    const decisionsA = fs.readFileSync(server.store.paths.decisionsMd("t-adv-a"), "utf8");
    expect(decisionsA).toContain("Use explicit Map with deterministic invalidation");
    expect(decisionsA).toContain("## 技术取舍");
    expect(decisionsA).toContain("Map 支持按 key 精准淘汰");
    expect(capturedAdvisorHandoffs.get("t-adv-a")?.[0]).toContain("Should config cache use Map or WeakMap?");
    expect(capturedWorkerHandoffs.get("t-adv-a")?.[1]).toContain("## 历史裁决 (decisions)");
    expect(fs.existsSync(server.store.paths.advisorRequestYaml("t-adv-a"))).toBe(false);
    expect(server.pendingDecisions.get("t-adv-a")).toBeNull();

    // Run Scenario B (stuck_threshold=2 short-circuits retries_per_stage=3)
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "adv_b_worker_fail_1", detail: "fail 1" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-adv-b", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "adv_b_worker_fail_2", detail: "fail 2" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-adv-b", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "adv_b_advisor_break", detail: "advisor break stuck" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-adv-b", role: "advisor" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "adv_b_worker_fix", detail: "worker fix" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-adv-b", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "adv_b_reviewer_pass", detail: "review pass" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-adv-b", role: "reviewer" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-adv-b",
        title: "Scenario B stuck threshold",
        space: "advproj",
        priority: "P0",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        workflow: buildWorkflowPreset("standard_dev", { maxRounds: 3, stuckThreshold: 2 }),
        contract_version: 1,
        contract: {
          goal: "Unstick repeated exit=2",
          end: "v=802 merged",
          accept_cmd: `node -e "const fs=require('fs');if(!fs.readFileSync('src/app.ts','utf8').includes('802'))process.exit(2)"`,
          accept_files_hash: "sha256:advb",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 4, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-22T08:05:00.000Z",
        updated_at: "2026-11-22T08:05:00.000Z",
      },
      "# Scenario B",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-adv-b")?.status === "done", "t-adv-b done");
    const specsB = fakeBackend.getRecordedSpecs().filter((s) => s.taskId === "t-adv-b").map((s) => s.role);
    expect(specsB).toEqual(["worker", "worker", "advisor", "worker", "reviewer"]);
    expect(capturedAdvisorHandoffs.get("t-adv-b")?.[0]).toContain("gate:accept:exit=2");
    expect(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf8")).toBe("export const v = 802;\n");

    // Run Scenario C1 (advisor requires_scope_expansion blocked -> waiting human)
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "adv_c1_worker_ask", detail: "ask arch choice" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-adv-c1", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "adv_c1_advisor_overreach", detail: "overreach scope" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-adv-c1", role: "advisor" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-adv-c1",
        title: "Scenario C1 scope expansion blocked",
        space: "advproj",
        priority: "P1",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        workflow: buildWorkflowPreset("standard_dev"),
        contract_version: 1,
        contract: {
          goal: "Test scope guard",
          end: "Done",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:advc1",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-22T08:10:00.000Z",
        updated_at: "2026-11-22T08:10:00.000Z",
      },
      "# Scenario C1",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-adv-c1")?.status === "waiting", "t-adv-c1 waiting");
    expect(server.pendingDecisions.get("t-adv-c1")?.reason).toBe("advisor_requires_scope_expansion");
    server.stateMachine.cancelTask("t-adv-c1", "cleanup", "2026-11-22T08:10:30.000Z");

    // Run Scenario C2 (plan advisor mutates worktree -> advisor_workspace_mutation)
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "adv_c2_plan_mutate", detail: "mutate repo during plan" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-adv-c2", role: "advisor" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-adv-c2",
        title: "Scenario C2 mutation blocked",
        space: "advproj",
        priority: "P1",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        workflow: buildWorkflowPreset("full_delivery"),
        contract_version: 1,
        contract: {
          goal: "Test workspace read-only guard",
          end: "Done",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:advc2",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-22T08:11:00.000Z",
        updated_at: "2026-11-22T08:11:00.000Z",
      },
      "# Scenario C2",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-adv-c2")?.status === "waiting", "t-adv-c2 waiting");
    expect(server.pendingDecisions.get("t-adv-c2")?.reason).toBe("advisor_workspace_mutation");
    expect(fs.existsSync(server.store.paths.planMd("t-adv-c2"))).toBe(false);
    server.stateMachine.cancelTask("t-adv-c2", "cleanup", "2026-11-22T08:11:30.000Z");

    // Run Scenario D (scope_clarification goes straight to human waiting without waking advisor)
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "adv_d_worker_scope_human", detail: "ask scope" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-adv-d", role: "worker" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-adv-d",
        title: "Scenario D human boundary bypass",
        space: "advproj",
        priority: "P1",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        workflow: buildWorkflowPreset("standard_dev"),
        contract_version: 1,
        contract: {
          goal: "Bypass advisor for scope clarification",
          end: "Done",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:advd",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-22T08:12:00.000Z",
        updated_at: "2026-11-22T08:12:00.000Z",
      },
      "# Scenario D",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-adv-d")?.status === "waiting", "t-adv-d waiting");
    expect(server.pendingDecisions.get("t-adv-d")?.category).toBe("scope_clarification");
    expect(fakeBackend.getRecordedSpecs().some((s) => s.taskId === "t-adv-d" && s.role === "advisor")).toBe(false);
    server.stateMachine.cancelTask("t-adv-d", "cleanup", "2026-11-22T08:12:30.000Z");

    // Run Scenario E (clean plan stage persists PLAN.md and GET /api/tasks/:id returns plan)
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "adv_e_plan_ok", detail: "clean plan" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-adv-e", role: "advisor" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "adv_e_worker_ask_halt", detail: "hold for detail" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-adv-e", role: "worker" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-adv-e",
        title: "Scenario E plan endpoint",
        space: "advproj",
        priority: "P1",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        workflow: buildWorkflowPreset("full_delivery"),
        contract_version: 1,
        contract: {
          goal: "Expose plan in detail API",
          end: "Done",
          accept_cmd: "node -e \"process.exit(0)\"",
          accept_files_hash: "sha256:adve",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-22T08:13:00.000Z",
        updated_at: "2026-11-22T08:13:00.000Z",
      },
      "# Scenario E",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-adv-e")?.status === "waiting", "t-adv-e waiting");
    const detailRes = await server.app.request(new Request("http://127.0.0.1/api/tasks/t-adv-e"));
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as { plan?: string };
    expect(detailBody.plan).toContain("Read-only architecture plan E");
    expect(detailBody.plan).toContain("## 技术取舍");
  }, 25_000);

  it("Slice 4: session_bound binds RUN.yaml, exposes session & ioSummary, and invokes local open-tui", async () => {
    const { repoPath, baseCommit } = initGitRepo("slice4");
    const kilnHome = makeTempDir("kiln-home-slice4-");

    const openSpy = vi.fn(async ({ taskId, runDir }) => ({
      ok: true as const,
      taskId,
      runDir,
      agent: "codex",
      providerSessionId: "codex-e2e-9876543210",
      cwd: repoPath,
      cwdFallback: false,
      commandPreview: "codex resume codex-e2e-9876543210",
    }));

    const fakeBackend = new FakeBackend();
    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "slice4-e2e-secret-0123456789abcd",
      openRunTui: openSpy,
      approvalHandler: async (req, ctx) => {
        if (req.action === "slice4_worker_done") {
          const token = server.issueRunToken({
            taskId: ctx.taskId,
            runId: ctx.runId,
            role: ctx.role,
            contractVersion: ctx.card.contract_version,
          });
          const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), "export const v = 904;\n");
          fs.writeFileSync(path.join(wtPath, "src", "extra-1.ts"), "export const e1 = 1;\n");
          fs.writeFileSync(path.join(wtPath, "src", "extra-2.ts"), "export const e2 = 2;\n");
          fs.writeFileSync(path.join(wtPath, "src", "extra-3.ts"), "export const e3 = 3;\n");
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: baseCommit,
                output_ref: "src/app.ts",
                changed_paths: ["src/app.ts", "src/extra-1.ts", "src/extra-2.ts", "src/extra-3.ts"],
                extraFrontmatter: {
                  summary: "完成 session 总览与 TUI 联动",
                },
              }),
            }),
          });
        }
        await ctx.backend.answer(req.id, true);
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);

    server.store.writeSpace({
      schema_version: 1,
      id: "s4proj",
      name: "Slice4 Proj",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });

    const roles = defaultRoles();
    server.store.writeConfig("roles", {
      ...roles,
      roles: {
        ...roles.roles,
        worker: { agent: "codex", model: "gpt-6-luna", allow_full_access_fallback: false },
      },
    });
    server.store.writeConfig("limits", defaultLimits());
    server.store.writeConfig("pricing", defaultPricing());
    await server.start();

    fakeBackend.enqueueScript(
      [
        {
          kind: "session_bound",
          providerSessionId: "codex-e2e-9876543210",
          providerSessionPath: "/tmp/codex-e2e.jsonl",
        },
        { kind: "tool", name: "shell", target: "pnpm test" },
        { kind: "approval", action: "slice4_worker_done", detail: "submit s4 receipt" },
        { kind: "exit", reason: "completed" },
      ],
      { taskId: "t-slice4-tui", role: "worker" },
    );

    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-slice4-tui",
        title: "Slice 4 native session binding E2E",
        space: "s4proj",
        priority: "P1",
        track: "L1",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        workflow: buildWorkflowPreset("quick"),
        contract_version: 1,
        contract: {
          goal: "绑定原生 Session 并支持本地直达 TUI",
          end: "v=904 merged",
          accept_cmd: `node -e "const fs=require('fs');if(!fs.readFileSync('src/app.ts','utf8').includes('904'))process.exit(2)"`,
          accept_files_hash: "sha256:s4",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 5_000_000 },
        created_at: "2026-11-22T09:20:00.000Z",
        updated_at: "2026-11-22T09:20:00.000Z",
      },
      "# Slice 4 Brief",
    );

    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-slice4-tui")?.status === "done", "t-slice4-tui done");

    const meta = readYamlOptional(
      server.store.paths.runYaml("t-slice4-tui", "001-implement"),
      RunMetaSchema,
    );
    expect(meta?.cwd).toBeTruthy();
    expect(meta?.session_ref.meta?.providerSessionId).toBe("codex-e2e-9876543210");
    expect(meta?.session_ref.meta?.providerSessionPath).toBe("/tmp/codex-e2e.jsonl");

    const detailRes = await server.app.request(new Request("http://127.0.0.1/api/tasks/t-slice4-tui"));
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      runs: Array<{
        dirName: string;
        session?: {
          providerSessionId: string | null;
          displaySessionId: string | null;
          tuiSupported: boolean;
          tuiCommandPreview: string | null;
        };
        ioSummary?: {
          inputTitle: string;
          outputVerdict: string;
          outputSummary: string;
          changedPaths: string[];
          gatePassed: boolean | null;
        };
      }>;
    };
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]?.session).toMatchObject({
      providerSessionId: "codex-e2e-9876543210",
      displaySessionId: "codex-e2e-98",
      tuiSupported: true,
      tuiCommandPreview: "codex resume codex-e2e-9876543210",
    });
    expect(detail.runs[0]?.ioSummary).toMatchObject({
      inputTitle: "绑定原生 Session 并支持本地直达 TUI",
      outputVerdict: "通过",
      outputSummary: "完成 session 总览与 TUI 联动",
      gatePassed: true,
    });
    expect(detail.runs[0]?.ioSummary?.changedPaths).toEqual([
      "src/app.ts",
      "src/extra-1.ts",
      "src/extra-2.ts",
      "src/extra-3.ts",
    ]);

    const openRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-slice4-tui/runs/001-implement/open-tui", {
        method: "POST",
      }),
    );
    expect(openRes.status).toBe(200);
    expect(openSpy).toHaveBeenCalledWith({
      taskId: "t-slice4-tui",
      runDir: "001-implement",
    });
  }, 25_000);

  it("Round 1 Review Regressions: blocks concurrent advisor dispatch before abort completes, enforces lease_expired & pipeline target_stage, and detects advisor git commit", async () => {
    const kilnHome = makeTempDir("kiln-m2-r1-fixes-");
    const { repoPath, baseCommit } = initGitRepo("r1fix");
    const fakeBackend = new FakeBackend();

    let cancelGateResolve!: () => void;
    let cancelGateEnteredResolve!: () => void;
    const cancelGatePromise = new Promise<void>((r) => {
      cancelGateResolve = r;
    });
    const cancelGateEntered = new Promise<void>((r) => {
      cancelGateEnteredResolve = r;
    });

    let gateCancelForTask: string | null = null;
    let activeWorkers = 0;
    let maxConcurrentPerTask = 0;

    const origStart = fakeBackend.start.bind(fakeBackend);
    fakeBackend.start = async (spec) => {
      if (spec.taskId === gateCancelForTask && spec.role === "worker") {
        activeWorkers += 1;
        maxConcurrentPerTask = Math.max(maxConcurrentPerTask, activeWorkers);
      }
      if (spec.taskId === gateCancelForTask && spec.role === "advisor") {
        // When advisor starts, the old worker MUST already have exited cancel
        maxConcurrentPerTask = Math.max(maxConcurrentPerTask, activeWorkers + 1);
      }
      return origStart(spec);
    };

    const origCancel = fakeBackend.cancel.bind(fakeBackend);
    fakeBackend.cancel = async (ref) => {
      if (gateCancelForTask !== null) {
        cancelGateEnteredResolve();
        await cancelGatePromise;
        activeWorkers = Math.max(0, activeWorkers - 1);
      }
      return origCancel(ref);
    };

    let expireNextAdvisorLease = false;
    let advisorCommittedWt = "";

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-r1-review-fixes-secret-01234567",
      approvalHandler: async (req, ctx) => {
        const token = server.issueRunToken({
          taskId: ctx.taskId,
          runId: ctx.runId,
          role: ctx.role,
          contractVersion: ctx.card.contract_version,
        });
        const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");

        if (req.action === "r1_a_worker_ask") {
          const askRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_ask_decision",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              category: "technical_ambiguity",
              reason: "race_check",
              question: "Check concurrent wake while cancelling",
              options: [{ id: "opt-1", label: "Proceed", action: "resume", recommended: true }],
            }),
          });
          expect(askRes.status).toBe(200);
          return;
        }

        if (req.action === "r1_a_advisor_resolve") {
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: serializeFrontmatterMarkdown(
                {
                  run_id: ctx.runId,
                  contract_version: ctx.card.contract_version,
                  outcome: "resolved",
                  chosen_approach: "Proceed sequentially",
                  decision_kind: "technical_ambiguity",
                  target_stage: "implement",
                },
                "## 技术取舍\n等待旧会话完全中止。\n\n## 授权裁决\n改 src/app.ts 为 910。\n",
              ),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "r1_a_worker_done") {
          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), "export const v = 910;\n");
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: baseCommit,
                output_ref: "src/app.ts",
                changed_paths: ["src/app.ts"],
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "r1_b_expire_advisor") {
          const adviseDir = fs
            .readdirSync(server.store.paths.runsDir(ctx.taskId))
            .filter((d) => d.endsWith("-advise"))
            .sort()
            .at(-1);
          expect(adviseDir).toBeDefined();
          fs.writeFileSync(
            server.store.paths.receiptMd(ctx.taskId, adviseDir!),
            serializeFrontmatterMarkdown(
              {
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                outcome: "resolved",
                chosen_approach: "Should be ignored on expired lease",
              },
              "## 技术取舍\n已过期\n\n## 授权裁决\n不应推进\n",
            ),
          );
          if (expireNextAdvisorLease) {
            const expired = server.store.sqlite.expireActiveLeaseByTask(
              ctx.taskId,
              "2026-11-22T10:05:00.000Z",
              "expired",
            );
            expect(expired.updated).toBe(true);
          }
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "r1_c_invalid_stage") {
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: serializeFrontmatterMarkdown(
                {
                  run_id: ctx.runId,
                  contract_version: ctx.card.contract_version,
                  outcome: "resolved",
                  chosen_approach: "Suggest unconfigured review stage",
                  target_stage: "review",
                },
                "## 技术取舍\n建议审查\n\n## 授权裁决\n但当前流程为 quick\n",
              ),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "r1_d_advisor_git_commit") {
          advisorCommittedWt = wtPath;
          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), "export const v = 911;\n");
          git(["add", "src/app.ts"], wtPath);
          git(["commit", "-m", "advisor unauthorized commit"], wtPath);
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: serializeFrontmatterMarkdown(
                {
                  run_id: ctx.runId,
                  contract_version: ctx.card.contract_version,
                  outcome: "resolved",
                  chosen_approach: "Committed in plan stage cleanly",
                  decision_kind: "plan",
                },
                "## 技术取舍\n提交了 commit。\n\n## 授权裁决\n继续\n",
              ),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        await ctx.backend.answer(req.id, true);
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    server.store.writeSpace({
      schema_version: 1,
      id: "r1proj",
      name: "R1 Proj",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    const baseRoles = defaultRoles();
    server.store.writeConfig("roles", {
      ...baseRoles,
      roles: {
        ...baseRoles.roles,
        advisor: { agent: "codex", model: "gpt-6-luna", allow_full_access_fallback: false },
      },
    });
    server.store.writeConfig("limits", defaultLimits({ max_concurrent_slots: 2 }));
    server.store.writeConfig("pricing", defaultPricing());
    await server.start();

    // Case A (P0): Concurrent wake() during slow abortActiveRun must NOT launch advisor concurrently
    gateCancelForTask = "t-r1-race";
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r1_a_worker_ask", detail: "ask tech" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r1-race", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r1_a_advisor_resolve", detail: "adv" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r1-race", role: "advisor" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r1_a_worker_done", detail: "done" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r1-race", role: "worker" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-r1-race",
        title: "Case A abort/wake serialization",
        space: "r1proj",
        priority: "P1",
        track: "L1",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        workflow: buildWorkflowPreset("quick"),
        contract_version: 1,
        contract: {
          goal: "Serialize abort before advisor",
          end: "v=910",
          accept_cmd: `node -e "const fs=require('fs');if(!fs.readFileSync('src/app.ts','utf8').includes('910'))process.exit(2)"`,
          accept_files_hash: "sha256:r1a",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 1_000_000 },
        created_at: "2026-11-22T10:00:00.000Z",
        updated_at: "2026-11-22T10:00:00.000Z",
      },
      "# Case A",
    );
    await server.orchestrator.wake();
    await cancelGateEntered;
    // Trigger multiple concurrent wakes while cancel() is blocked
    await server.orchestrator.wake();
    await server.orchestrator.wake();
    expect(
      fakeBackend.getRecordedSpecs().some((s) => s.taskId === "t-r1-race" && s.role === "advisor"),
    ).toBe(false);
    cancelGateResolve();
    await waitUntil(() => server.store.getTaskIndex("t-r1-race")?.status === "done", "t-r1-race done");
    expect(maxConcurrentPerTask).toBe(1);
    gateCancelForTask = null;

    // Case B (P1): finalizeAdvisorRun ignores expired lease without deleting advisor-request.yaml or advancing state
    expireNextAdvisorLease = true;
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r1_a_worker_ask", detail: "ask b" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r1-lease", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r1_b_expire_advisor", detail: "adv b" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r1-lease", role: "advisor" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-r1-lease",
        title: "Case B advisor lease_expired",
        space: "r1proj",
        priority: "P1",
        track: "L1",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        workflow: buildWorkflowPreset("quick"),
        contract_version: 1,
        contract: {
          goal: "Honor lease_expired in finalizeAdvisorRun",
          end: "Done",
          accept_cmd: "echo ok",
          accept_files_hash: "sha256:r1b",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 1_000_000 },
        created_at: "2026-11-22T10:02:00.000Z",
        updated_at: "2026-11-22T10:02:00.000Z",
      },
      "# Case B",
    );
    await server.orchestrator.wake();
    await waitUntil(
      () => fakeBackend.getRecordedSpecs().some((s) => s.taskId === "t-r1-lease" && s.role === "advisor"),
      "t-r1-lease advisor started",
    );
    const leaseAdviseDir = fs
      .readdirSync(server.store.paths.runsDir("t-r1-lease"))
      .filter((d) => d.endsWith("-advise"))
      .sort()
      .at(-1);
    expect(leaseAdviseDir).toBeDefined();
    await waitUntil(() => {
      const historyDir = server.store.paths.runHistoryDir("t-r1-lease", leaseAdviseDir!);
      return (
        fs.existsSync(historyDir) &&
        fs.readdirSync(historyDir).some((name) => name.includes("-stale-"))
      );
    }, "t-r1-lease stale receipt archived");
    expect(server.store.getTaskIndex("t-r1-lease")?.status).toBe("running");
    expect(fs.existsSync(server.store.paths.advisorRequestYaml("t-r1-lease"))).toBe(true);
    expireNextAdvisorLease = false;
    server.stateMachine.cancelTask("t-r1-lease", "cleanup", "2026-11-22T10:03:00.000Z");

    // Case C (P1): target_stage outside quick workflow pipeline -> waiting(advisor_invalid_target_stage)
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r1_a_worker_ask", detail: "ask c" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r1-stage", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r1_c_invalid_stage", detail: "adv invalid target_stage" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r1-stage", role: "advisor" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-r1-stage",
        title: "Case C invalid advisor target_stage",
        space: "r1proj",
        priority: "P1",
        track: "L1",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        workflow: buildWorkflowPreset("quick"),
        contract_version: 1,
        contract: {
          goal: "Guard target_stage against pipeline",
          end: "Done",
          accept_cmd: "echo ok",
          accept_files_hash: "sha256:r1c",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 1_000_000 },
        created_at: "2026-11-22T10:04:00.000Z",
        updated_at: "2026-11-22T10:04:00.000Z",
      },
      "# Case C",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-r1-stage")?.status === "waiting", "t-r1-stage waiting");
    expect(server.pendingDecisions.get("t-r1-stage")?.reason).toBe("advisor_invalid_target_stage");
    server.stateMachine.cancelTask("t-r1-stage", "cleanup", "2026-11-22T10:05:00.000Z");

    // Case D (P2): advisor git commit inside plan stage detected via HEAD hash
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r1_d_advisor_git_commit", detail: "advisor commits" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r1-githead", role: "advisor" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-r1-githead",
        title: "Case D advisor git commit detection",
        space: "r1proj",
        priority: "P1",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        workflow: buildWorkflowPreset("full_delivery"),
        contract_version: 1,
        contract: {
          goal: "Detect git commit mutation in plan",
          end: "Done",
          accept_cmd: "echo ok",
          accept_files_hash: "sha256:r1d",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 1_000_000 },
        created_at: "2026-11-22T10:06:00.000Z",
        updated_at: "2026-11-22T10:06:00.000Z",
      },
      "# Case D",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-r1-githead")?.status === "waiting", "t-r1-githead waiting");
    expect(advisorCommittedWt).toBeTruthy();
    expect(server.pendingDecisions.get("t-r1-githead")?.reason).toBe("advisor_workspace_mutation");
  }, 25_000);

  it("Round 2 Review Regressions: detects advisor workspace mutation on review-triggered need_decision and missing receipt across advise/plan", async () => {
    const kilnHome = makeTempDir("kiln-m2-r2-fixes-");
    const { repoPath, baseCommit } = initGitRepo("r2fix");
    const fakeBackend = new FakeBackend();

    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "m2-r2-review-fixes-secret-01234567",
      approvalHandler: async (req, ctx) => {
        const token = server.issueRunToken({
          taskId: ctx.taskId,
          runId: ctx.runId,
          role: ctx.role,
          contractVersion: ctx.card.contract_version,
        });
        const wtPath = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");

        if (req.action === "r2_worker_implement_ok") {
          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), "export const v = 920;\n");
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: makeWorkerReceiptMarkdown({
                run_id: ctx.runId,
                contract_version: ctx.card.contract_version,
                input_ref: baseCommit,
                output_ref: "src/app.ts",
                changed_paths: ["src/app.ts"],
              }),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "r2_reviewer_ask_tech") {
          const askRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_ask_decision",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              category: "technical_ambiguity",
              reason: "review_tradeoff",
              question: "Check advisor mutation handling when triggered from review",
              options: [{ id: "opt-1", label: "Proceed", action: "resume", recommended: true }],
            }),
          });
          expect(askRes.status).toBe(200);
          return;
        }

        if (req.action === "r2_advisor_mutate_need_decision") {
          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), "export const v = 999;\n");
          await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_submit_receipt",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              markdown: serializeFrontmatterMarkdown(
                {
                  run_id: ctx.runId,
                  contract_version: ctx.card.contract_version,
                  outcome: "need_decision",
                  chosen_approach: "Mutated workspace while asking human",
                },
                "## 技术取舍\n尝试修改文件并请求确认\n\n## 授权裁决\n待确认\n",
              ),
            }),
          });
          await ctx.backend.answer(req.id, true);
          return;
        }

        if (req.action === "r2_worker_ask_tech") {
          const askRes = await server.invokeMcpRpc({
            method: "POST",
            url: "/rpc/mcp/wb_ask_decision",
            headers: { Authorization: `Bearer ${token}` },
            rawBody: JSON.stringify({
              category: "technical_ambiguity",
              reason: "worker_tradeoff",
              question: "Check advisor mutation with missing receipt",
              options: [{ id: "opt-1", label: "Proceed", action: "resume", recommended: true }],
            }),
          });
          expect(askRes.status).toBe(200);
          return;
        }

        if (req.action === "r2_advisor_mutate_no_receipt") {
          fs.writeFileSync(path.join(wtPath, "src", "app.ts"), "export const v = 998;\n");
          await ctx.backend.answer(req.id, true);
          return;
        }

        await ctx.backend.answer(req.id, true);
      },
    });
    servers.push(server);
    server.backendRegistry.register(fakeBackend);
    server.store.writeSpace({
      schema_version: 1,
      id: "r2proj",
      name: "R2 Proj",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    const baseRoles = defaultRoles();
    server.store.writeConfig("roles", {
      ...baseRoles,
      roles: {
        ...baseRoles.roles,
        advisor: { agent: "codex", model: "gpt-6-luna", allow_full_access_fallback: false },
      },
    });
    server.store.writeConfig("limits", defaultLimits({ max_concurrent_slots: 1 }));
    server.store.writeConfig("pricing", defaultPricing());
    await server.start();

    // Case A: review-triggered advisor mutates worktree AND submits need_decision -> advisor_workspace_mutation & safe return to implement (NOT review)
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r2_worker_implement_ok", detail: "impl ok" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r2-rev-mut", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r2_reviewer_ask_tech", detail: "rev ask" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r2-rev-mut", role: "reviewer" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r2_advisor_mutate_need_decision", detail: "adv mutate + need_decision" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r2-rev-mut", role: "advisor" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-r2-rev-mut",
        title: "Round 2 Case A review advisor need_decision mutation",
        space: "r2proj",
        priority: "P1",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        workflow: buildWorkflowPreset("standard_dev"),
        contract_version: 1,
        contract: {
          goal: "Detect workspace mutation even when advisor submits need_decision from review",
          end: "Done",
          accept_cmd: `node -e "process.exit(0)"`,
          accept_files_hash: "sha256:r2a",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 1_000_000 },
        created_at: "2026-11-22T11:00:00.000Z",
        updated_at: "2026-11-22T11:00:00.000Z",
      },
      "# Case A",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-r2-rev-mut")?.status === "waiting", "t-r2-rev-mut waiting");
    const pendingA = server.pendingDecisions.get("t-r2-rev-mut");
    expect(pendingA?.reason).toBe("advisor_workspace_mutation");
    expect(pendingA?.category).toBe("advisor_guardrail_escalation");
    expect(pendingA?.options.find((o) => o.recommended)?.target_stage).toBe("implement");
    server.stateMachine.cancelTask("t-r2-rev-mut", "cleanup", "2026-11-22T11:01:00.000Z");

    // Case B: advise advisor mutates worktree AND exits without RECEIPT.md -> advisor_workspace_mutation
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r2_worker_ask_tech", detail: "worker ask" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r2-adv-missing", role: "worker" },
    );
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r2_advisor_mutate_no_receipt", detail: "adv mutate missing receipt" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r2-adv-missing", role: "advisor" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-r2-adv-missing",
        title: "Round 2 Case B advise missing receipt mutation",
        space: "r2proj",
        priority: "P1",
        track: "L1",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        workflow: buildWorkflowPreset("quick"),
        contract_version: 1,
        contract: {
          goal: "Detect workspace mutation when advise exits without receipt",
          end: "Done",
          accept_cmd: `node -e "process.exit(0)"`,
          accept_files_hash: "sha256:r2b",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 1_000_000 },
        created_at: "2026-11-22T11:02:00.000Z",
        updated_at: "2026-11-22T11:02:00.000Z",
      },
      "# Case B",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-r2-adv-missing")?.status === "waiting", "t-r2-adv-missing waiting");
    expect(server.pendingDecisions.get("t-r2-adv-missing")?.reason).toBe("advisor_workspace_mutation");
    server.stateMachine.cancelTask("t-r2-adv-missing", "cleanup", "2026-11-22T11:03:00.000Z");

    // Case C: plan advisor mutates worktree AND exits without RECEIPT.md -> advisor_workspace_mutation (no retry bypass)
    fakeBackend.enqueueScript(
      [{ kind: "approval", action: "r2_advisor_mutate_no_receipt", detail: "plan mutate missing receipt" }, { kind: "exit", reason: "completed" }],
      { taskId: "t-r2-plan-missing", role: "advisor" },
    );
    server.stateMachine.createTask(
      {
        schema_version: 1,
        id: "t-r2-plan-missing",
        title: "Round 2 Case C plan missing receipt mutation",
        space: "r2proj",
        priority: "P1",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        workflow: buildWorkflowPreset("full_delivery"),
        contract_version: 1,
        contract: {
          goal: "Detect workspace mutation when plan exits without receipt",
          end: "Done",
          accept_cmd: `node -e "process.exit(0)"`,
          accept_files_hash: "sha256:r2c",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 1_000_000 },
        created_at: "2026-11-22T11:04:00.000Z",
        updated_at: "2026-11-22T11:04:00.000Z",
      },
      "# Case C",
    );
    await server.orchestrator.wake();
    await waitUntil(() => server.store.getTaskIndex("t-r2-plan-missing")?.status === "waiting", "t-r2-plan-missing waiting");
    expect(server.pendingDecisions.get("t-r2-plan-missing")?.reason).toBe("advisor_workspace_mutation");
  }, 25_000);
});
