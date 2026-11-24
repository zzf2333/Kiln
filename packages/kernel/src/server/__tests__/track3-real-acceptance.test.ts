import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AcceptVerificationReportSchema,
  RosterConfigSchema,
  SpaceConfigSchema,
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
import { writeFileAtomic, readYamlOptional } from "../../store/index.js";
import { KilndServer, type AcceptEnvStarterFn } from "../index.js";

const VALID_PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

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
  fs.writeFileSync(
    path.join(repoDir, "src", "app.ts"),
    "export const status = 'init';\n",
    "utf8",
  );
  git(["add", "."], repoDir);
  git(["commit", "-m", "initial commit"], repoDir);
  return fs.realpathSync(repoDir);
}

function makeWorkerReceipt(fields: {
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
    [
      "## 结论\n审查通过。\n",
      "## 缺陷清单\n无\n",
      "## 测试真实性与复现核查\n真实执行通过\n",
    ].join("\n"),
  );
}

function makeAdvisorPlanReceipt(fields: {
  run_id: string;
  contract_version: number;
}): string {
  return serializeFrontmatterMarkdown(
    {
      run_id: fields.run_id,
      contract_version: fields.contract_version,
      outcome: "resolved",
      chosen_approach: "直接更新 src/app.ts 并通过验证",
      decision_kind: "plan",
      requires_contract_change: false,
      requires_scope_expansion: false,
      requires_human_approval: false,
    },
    [
      "## 技术取舍\n最小改动实现即可。\n",
      "## 授权裁决\n- 不扩 scope，直接实现并送审。\n",
    ].join("\n"),
  );
}

function makeFakeBackend(): FakeBackend {
  return new FakeBackend({
    backendId: "fake",
    agents: [
      {
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
      },
      {
        id: "claude",
        label: "Claude",
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
      },
    ],
    models: {
      codex: [{ id: "gpt-5.4", label: "gpt-5.4", thinkingOptions: [] }],
      claude: [
        { id: "claude-opus-4-6", label: "claude-opus-4-6", thinkingOptions: [] },
        { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6", thinkingOptions: [] },
      ],
    },
  });
}

function makeRoster(input?: {
  verifierCapabilities?: Array<"cli" | "browser" | "desktop_gui">;
}): RosterConfig {
  const seed = createDefaultBuiltinRosterMetadata();
  return RosterConfigSchema.parse({
    schema_version: 2,
    heterogeneous_review: true,
    roster: {
      ...seed,
      pm: {
        ...seed.pm,
        enabled: true,
        primary: { provider: "codex", model: "gpt-5.4", backend_id: "fake" },
      },
      advisor: {
        ...seed.advisor,
        enabled: true,
        primary: { provider: "claude", model: "claude-opus-4-6", backend_id: "fake" },
      },
      main_dev: {
        ...seed.main_dev,
        enabled: true,
        primary: { provider: "codex", model: "gpt-5.4", backend_id: "fake" },
      },
      reviewer: {
        ...seed.reviewer,
        enabled: true,
        primary: { provider: "claude", model: "claude-opus-4-6", backend_id: "fake" },
        avoid_same_as: ["implement"],
      },
      verifier: {
        ...seed.verifier,
        enabled: true,
        primary: { provider: "claude", model: "claude-sonnet-4-6", backend_id: "fake" },
        verifier_capabilities: input?.verifierCapabilities ?? ["cli", "browser"],
      },
      deliverer: {
        ...seed.deliverer,
        enabled: true,
        mode: "kernel",
      },
    },
  });
}

function findRunDirByRunId(server: KilndServer, taskId: string, runId: string): string {
  const dirs = fs.readdirSync(server.store.paths.runsDir(taskId)).sort();
  const matched = dirs.find((d) =>
    fs.readFileSync(server.store.paths.runYaml(taskId, d), "utf8").includes(runId),
  );
  if (!matched) {
    throw new Error(`Unable to locate runDir for ${taskId} runId=${runId}`);
  }
  return matched;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

const DEFAULT_LIMITS: CardLimits = {
  retries_per_stage: 3,
  review_rounds: 3,
  advisor_calls: 2,
  max_tokens: 5_000_000,
};

const GLOBAL_LIMITS: LimitsConfig = {
  schema_version: 1,
  max_concurrent_slots: 2,
  p0_extra_slot: true,
  max_waiting_wip: 8,
  retries_per_stage: 3,
  review_rounds: 3,
  advisor_calls: 2,
  max_card_tokens: 5_000_000,
  warm_cache_ttl_sec: 300,
};

describe("Track 3: Slim B8 + B9 Anti-Fake Evidence Gate & Multimodal Rework", () => {
  const tempDirs: string[] = [];
  const servers: KilndServer[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await s.stop().catch(() => {});
    }
    for (const d of tempDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  function setupTestEnv(input: {
    fakeBackend: FakeBackend;
    roster: RosterConfig;
    acceptEnvStarter?: AcceptEnvStarterFn;
    approvalHandler: NonNullable<ConstructorParameters<typeof KilndServer>[0]>["approvalHandler"];
  }): {
    repoPath: string;
    server: KilndServer;
  } {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kiln-track3-"));
    tempDirs.push(tempRoot);
    const kilnHome = path.join(tempRoot, "kiln-home");
    const repoPath = initTempGitRepo(tempRoot, "repo");
    const server = new KilndServer({
      kilnHome,
      host: "127.0.0.1",
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      tokenSecret: "track3-test-secret-0123456789abcdef",
      approvalHandler: input.approvalHandler,
      ...(input.acceptEnvStarter !== undefined ? { acceptEnvStarter: input.acceptEnvStarter } : {}),
    });
    server.backendRegistry.register(input.fakeBackend);
    server.store.writeConfig("roster", input.roster);
    server.store.writeConfig("limits", GLOBAL_LIMITS);
    server.store.writeSpace(
      SpaceConfigSchema.parse({
        schema_version: 1,
        id: "proj",
        name: "Track3 Proj",
        repo_path: repoPath,
        default_branch: "main",
        accept_entry: {
          kind: "http_server",
          services: [
            {
              name: "web",
              cmd: "node server.js --port {{port}}",
              needs_port: true,
              primary: true,
              depends_on: [],
              ready: { kind: "http", path: "/" },
            },
          ],
          observe_http: true,
          required_capability: "browser",
        },
      }),
    );
    servers.push(server);
    return { repoPath, server };
  }

  function seedCard(server: KilndServer, repoPath: string, taskId: string): void {
    const acceptCmd = "node -e \"console.log('ok')\"";
    const snap = computeFrozenSnapshot(repoPath, ["src/*.ts"], acceptCmd);
    const now = new Date().toISOString();
    const card: TaskCard = {
      schema_version: 1,
      id: taskId,
      title: `Track3 ${taskId}`,
      space: "proj",
      priority: "P1",
      track: "L2",
      workspace_mode: "git_worktree",
      parent: null,
      depends_on: [],
      workflow: buildWorkflowPreset("full_delivery", { deliverApproval: false }),
      contract_version: 1,
      contract: {
        goal: "Verify anti-fake real acceptance",
        end: "Real acceptance passes cleanly",
        accept_cmd: acceptCmd,
        accept_files_hash: snap.hash,
        scope: ["src/**"],
        deliver: { mode: "merge_main", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: DEFAULT_LIMITS,
      created_at: now,
      updated_at: now,
    };
    server.stateMachine.createTask(card, "# Brief\n请从真实浏览器验证。\n");
  }

  it("B8: fails closed when verifier lacks browser capability required by space accept_entry", async () => {
    const fakeBackend = makeFakeBackend();
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "t_b8_cap_plan", detail: "plan" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "advisor" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "t_b8_cap_worker", detail: "impl" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "t_b8_cap_reviewer", detail: "review" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "reviewer" },
    );

    const { repoPath, server } = setupTestEnv({
      fakeBackend,
      roster: makeRoster({ verifierCapabilities: ["cli"] }),
      approvalHandler: async (req, ctx) => {
        const runDir = findRunDirByRunId(server, ctx.taskId, ctx.runId);
        if (req.action === "t_b8_cap_plan") {
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeAdvisorPlanReceipt({ run_id: ctx.runId, contract_version: 1 }),
          );
        } else if (req.action === "t_b8_cap_worker") {
          const wt = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
          fs.writeFileSync(path.join(wt, "src", "app.ts"), "export const status = 'done';\n");
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeWorkerReceipt({
              run_id: ctx.runId,
              contract_version: 1,
              input_ref: "HEAD",
              output_ref: "src/app.ts",
              changed_paths: ["src/app.ts"],
            }),
          );
        } else if (req.action === "t_b8_cap_reviewer") {
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeReviewerReceipt({ run_id: ctx.runId, contract_version: 1, reviewed_ref: "HEAD" }),
          );
        }
        await ctx.backend.answer(req.id, true);
      },
    });
    seedCard(server, repoPath, "t-b8-cap");
    await server.start();

    await waitUntil(
      () => server.store.getTaskIndex("t-b8-cap")?.status === "waiting",
      "t-b8-cap waiting on verifier_capability_missing",
    );

    const pending = server.pendingDecisions.get("t-b8-cap");
    expect(pending?.reason).toBe("verifier_capability_missing");
    expect(fakeBackend.getRecordedSpecs().some((s) => s.role === "verifier")).toBe(false);
  });

  it("B9: blocks fake zero-traffic / invalid-PNG / path-escape passes, attaches failed PNG to multimodal implement rework, then passes", async () => {
    const fakeBackend = makeFakeBackend();
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "b9_plan", detail: "plan" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "advisor" },
    );
    // worker #1 & #2 (after genuine fail #2 routes back to implement)
    for (let i = 0; i < 2; i += 1) {
      fakeBackend.enqueueScript(
        [
          { kind: "approval", action: "b9_worker", detail: "impl" },
          { kind: "exit", reason: "completed" },
        ],
        { role: "worker" },
      );
      fakeBackend.enqueueScript(
        [
          { kind: "approval", action: "b9_reviewer", detail: "review" },
          { kind: "exit", reason: "completed" },
        ],
        { role: "reviewer" },
      );
    }
    // verifier #1 (fake pass -> blocked retry in accept), #2 (genuine fail -> back to implement), #3 (real pass)
    for (let i = 0; i < 3; i += 1) {
      fakeBackend.enqueueScript(
        [
          { kind: "approval", action: "b9_verifier", detail: `verify-${i + 1}` },
          { kind: "exit", reason: "completed" },
        ],
        { role: "verifier" },
      );
    }

    let acceptLaunchNum = 0;
    let stopCount = 0;
    const fakeEnvStarter: AcceptEnvStarterFn = async ({ entry, acceptEnvDir }) => {
      acceptLaunchNum += 1;
      const attempt = acceptLaunchNum;
      fs.mkdirSync(acceptEnvDir, { recursive: true });
      const logFile = path.join(acceptEnvDir, "web.log");
      fs.writeFileSync(logFile, `boot attempt ${attempt}\nBackend crash hint: ECONNREFUSED\n`, "utf8");
      const totalReqs = attempt === 1 ? 0 : attempt === 2 ? 3 : 5;
      const errResps =
        attempt === 2 ? [{ method: "POST", path: "/api/save", status: 500, service: "web" }] : [];
      return {
        ok: true,
        entryKind: entry.kind,
        primaryUrl: "http://127.0.0.1:45999",
        services: [
          {
            name: "web",
            status: "ready",
            port: 45998,
            proxy_port: 45999,
            url: "http://127.0.0.1:45999",
            log_file: logFile,
          },
        ],
        traffic: {
          observed: true,
          total_requests: totalReqs,
          unique_paths: totalReqs > 0 ? ["/", "/api/save"] : [],
          error_responses: errResps,
        },
        session: {
          entryKind: entry.kind,
          primaryUrl: "http://127.0.0.1:45999",
          getLiveSnapshot() {
            return {
              entryKind: entry.kind,
              primaryUrl: "http://127.0.0.1:45999",
              services: [
                {
                  name: "web",
                  status: attempt === 2 ? "crashed" : "ready",
                  port: 45998,
                  proxy_port: 45999,
                  url: "http://127.0.0.1:45999",
                  ...(attempt === 2
                    ? { exit_code: 1, tail_log: "Backend crash hint: ECONNREFUSED" }
                    : {}),
                  log_file: logFile,
                },
              ],
              traffic: {
                observed: true,
                total_requests: totalReqs,
                unique_paths: totalReqs > 0 ? ["/", "/api/save"] : [],
                error_responses: errResps,
              },
            };
          },
          async stop() {
            stopCount += 1;
          },
        },
      };
    };

    let implementCalls = 0;
    let verifierCalls = 0;
    const { repoPath, server } = setupTestEnv({
      fakeBackend,
      roster: makeRoster({ verifierCapabilities: ["cli", "browser"] }),
      acceptEnvStarter: fakeEnvStarter,
      approvalHandler: async (req, ctx) => {
        const runDir = findRunDirByRunId(server, ctx.taskId, ctx.runId);
        if (req.action === "b9_plan") {
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeAdvisorPlanReceipt({ run_id: ctx.runId, contract_version: 1 }),
          );
        } else if (req.action === "b9_worker") {
          implementCalls += 1;
          const wt = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
          fs.writeFileSync(
            path.join(wt, "src", "app.ts"),
            `export const status = 'impl-${implementCalls}';\n`,
          );
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeWorkerReceipt({
              run_id: ctx.runId,
              contract_version: 1,
              input_ref: "HEAD",
              output_ref: "src/app.ts",
              changed_paths: ["src/app.ts"],
            }),
          );
        } else if (req.action === "b9_reviewer") {
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeReviewerReceipt({ run_id: ctx.runId, contract_version: 1, reviewed_ref: "HEAD" }),
          );
        } else if (req.action === "b9_verifier") {
          verifierCalls += 1;
          const evDir = server.store.paths.runEvidenceDir(ctx.taskId, runDir);
          fs.mkdirSync(evDir, { recursive: true });
          if (verifierCalls === 1) {
            // Fake pass #1: zero real traffic + fake PNG + path traversal
            fs.writeFileSync(path.join(evDir, "fake.png"), "not-a-real-png", "utf8");
            writeFileAtomic(
              server.store.paths.receiptMd(ctx.taskId, runDir),
              serializeFrontmatterMarkdown(
                {
                  run_id: ctx.runId,
                  contract_version: 1,
                  verified_ref: "HEAD",
                  verdict: "pass",
                  entry_mode: "browser",
                  passed_scenarios: 1,
                  failed_scenarios: 0,
                  evidence_files: ["evidence/fake.png", "../outside.png"],
                  scenarios: [{ name: "fake-flow", status: "pass" }],
                },
                "## 验收场景明细\n- 我测过了\n",
              ),
            );
          } else if (verifierCalls === 2) {
            // Genuine fail #2 with real PNG screenshot
            fs.writeFileSync(path.join(evDir, "fail-shot.png"), VALID_PNG_HEADER);
            writeFileAtomic(
              server.store.paths.receiptMd(ctx.taskId, runDir),
              serializeFrontmatterMarkdown(
                {
                  run_id: ctx.runId,
                  contract_version: 1,
                  verified_ref: "HEAD",
                  verdict: "fail",
                  entry_mode: "browser",
                  passed_scenarios: 0,
                  failed_scenarios: 1,
                  console_errors_count: 1,
                  evidence_files: ["evidence/fail-shot.png"],
                  scenarios: [
                    {
                      name: "保存表单",
                      status: "fail",
                      note: "点击保存返回 500",
                      evidence_files: ["evidence/fail-shot.png"],
                    },
                  ],
                },
                "## 验收场景明细\n- 保存表单：点击保存后返回 500 错误\n",
              ),
            );
          } else {
            // Genuine pass #3
            fs.writeFileSync(path.join(evDir, "pass-shot.png"), VALID_PNG_HEADER);
            writeFileAtomic(
              server.store.paths.receiptMd(ctx.taskId, runDir),
              serializeFrontmatterMarkdown(
                {
                  run_id: ctx.runId,
                  contract_version: 1,
                  verified_ref: "HEAD",
                  verdict: "pass",
                  entry_mode: "browser",
                  passed_scenarios: 1,
                  failed_scenarios: 0,
                  console_errors_count: 0,
                  evidence_files: ["evidence/pass-shot.png"],
                  scenarios: [
                    {
                      name: "保存表单",
                      status: "pass",
                      note: "真实请求通过且页面提示成功",
                      evidence_files: ["evidence/pass-shot.png"],
                    },
                  ],
                },
                "## 验收场景明细\n- 保存表单通过\n",
              ),
            );
          }
        }
        await ctx.backend.answer(req.id, true);
      },
    });
    seedCard(server, repoPath, "t-b9-e2e");
    await server.start();

    await waitUntil(
      () => server.store.getTaskIndex("t-b9-e2e")?.status === "done",
      "t-b9-e2e done after blocking fake pass and fixing from screenshot",
    );

    expect(verifierCalls).toBe(3);
    expect(stopCount).toBe(3);

    const runDirs = fs.readdirSync(server.store.paths.runsDir("t-b9-e2e")).sort();
    const acceptDirs = runDirs.filter((d) => d.endsWith("-accept"));
    expect(acceptDirs).toHaveLength(3);

    const blockedReport = readYamlOptional(
      server.store.paths.runAcceptReportYaml("t-b9-e2e", acceptDirs[0]!),
      AcceptVerificationReportSchema,
    )!;
    expect(blockedReport.verdict).toBe("blocked");
    expect(blockedReport.gate_ok).toBe(false);
    expect(blockedReport.rejection_reasons).toEqual(
      expect.arrayContaining([
        "no_real_traffic_observed",
        "evidence_invalid_image",
        "evidence_path_escape",
        "missing_visual_evidence",
      ]),
    );

    // 2nd implement spec received previousAcceptSummary + PNG attachment + crashed log
    const workerSpecs = fakeBackend.getRecordedSpecs().filter((s) => s.role === "worker");
    expect(workerSpecs).toHaveLength(2);
    const reworkSpec = workerSpecs[1]!;
    expect(reworkSpec.prompt).toContain("上轮真实验收失败现场");
    expect(reworkSpec.prompt).toContain("Backend crash hint: ECONNREFUSED");
    expect(reworkSpec.attachments?.some((a) => a.filename === "fail-shot.png")).toBe(true);

    // HTTP detail + evidence + log endpoints
    const detailRes = await server.app.request("/api/tasks/t-b9-e2e");
    expect(detailRes.status).toBe(200);
    const detailJson = (await detailRes.json()) as {
      runs: Array<{ dirName: string; acceptReport?: { verdict: string; gate_ok: boolean } }>;
    };
    const finalAccept = detailJson.runs.find((r) => r.dirName === acceptDirs[2]);
    expect(finalAccept?.acceptReport?.verdict).toBe("pass");
    expect(finalAccept?.acceptReport?.gate_ok).toBe(true);

    const evRes = await server.app.request(
      `/api/tasks/t-b9-e2e/runs/${acceptDirs[2]}/evidence?path=evidence/pass-shot.png`,
    );
    expect(evRes.status).toBe(200);
    expect(evRes.headers.get("content-type")).toBe("image/png");

    const badEvRes = await server.app.request(
      `/api/tasks/t-b9-e2e/runs/${acceptDirs[2]}/evidence?path=../card.yaml`,
    );
    expect(badEvRes.status).toBe(400);

    const logRes = await server.app.request(
      `/api/tasks/t-b9-e2e/runs/${acceptDirs[2]}/accept-logs/web`,
    );
    expect(logRes.status).toBe(200);
    expect(await logRes.text()).toContain("boot attempt 3");
  });

  it("B8: intercepts verifier workspace source mutation fail-closed", async () => {
    const fakeBackend = makeFakeBackend();
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "b8mut_plan", detail: "plan" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "advisor" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "b8mut_worker", detail: "impl" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "worker" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "b8mut_reviewer", detail: "review" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "reviewer" },
    );
    fakeBackend.enqueueScript(
      [
        { kind: "approval", action: "b8mut_verifier", detail: "accept" },
        { kind: "exit", reason: "completed" },
      ],
      { role: "verifier" },
    );

    const { repoPath, server } = setupTestEnv({
      fakeBackend,
      roster: makeRoster({ verifierCapabilities: ["cli", "browser"] }),
      acceptEnvStarter: async ({ entry, acceptEnvDir }) => {
        fs.mkdirSync(acceptEnvDir, { recursive: true });
        return {
          ok: true,
          entryKind: entry.kind,
          primaryUrl: "http://127.0.0.1:45997",
          services: [{ name: "web", status: "ready", port: 45996, proxy_port: 45997 }],
          traffic: { observed: true, total_requests: 2, unique_paths: ["/"], error_responses: [] },
          session: {
            entryKind: entry.kind,
            getLiveSnapshot: () => ({
              entryKind: entry.kind,
              services: [{ name: "web", status: "ready", port: 45996, proxy_port: 45997 }],
              traffic: { observed: true, total_requests: 2, unique_paths: ["/"], error_responses: [] },
            }),
            stop: async () => {},
          },
        };
      },
      approvalHandler: async (req, ctx) => {
        const runDir = findRunDirByRunId(server, ctx.taskId, ctx.runId);
        const wt = path.join(server.store.paths.workspaceDir(ctx.taskId), "worktree");
        if (req.action === "b8mut_plan") {
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeAdvisorPlanReceipt({ run_id: ctx.runId, contract_version: 1 }),
          );
        } else if (req.action === "b8mut_worker") {
          fs.writeFileSync(path.join(wt, "src", "app.ts"), "export const status = 'worker';\n");
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeWorkerReceipt({
              run_id: ctx.runId,
              contract_version: 1,
              input_ref: "HEAD",
              output_ref: "src/app.ts",
              changed_paths: ["src/app.ts"],
            }),
          );
        } else if (req.action === "b8mut_reviewer") {
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            makeReviewerReceipt({ run_id: ctx.runId, contract_version: 1, reviewed_ref: "HEAD" }),
          );
        } else if (req.action === "b8mut_verifier") {
          fs.writeFileSync(path.join(wt, "src", "app.ts"), "export const status = 'cheated';\n");
          const evDir = server.store.paths.runEvidenceDir(ctx.taskId, runDir);
          fs.mkdirSync(evDir, { recursive: true });
          fs.writeFileSync(path.join(evDir, "ok.png"), VALID_PNG_HEADER);
          writeFileAtomic(
            server.store.paths.receiptMd(ctx.taskId, runDir),
            serializeFrontmatterMarkdown(
              {
                run_id: ctx.runId,
                contract_version: 1,
                verified_ref: "HEAD",
                verdict: "pass",
                entry_mode: "browser",
                passed_scenarios: 1,
                failed_scenarios: 0,
                evidence_files: ["evidence/ok.png"],
              },
              "## 验收场景明细\n- cheated\n",
            ),
          );
        }
        await ctx.backend.answer(req.id, true);
      },
    });
    seedCard(server, repoPath, "t-b8-mut");
    await server.start();

    await waitUntil(
      () => server.store.getTaskIndex("t-b8-mut")?.status === "waiting",
      "t-b8-mut waiting on verifier_workspace_mutation",
    );
    expect(server.pendingDecisions.get("t-b8-mut")?.reason).toBe("read_only_workspace_mutation");
  });
});
