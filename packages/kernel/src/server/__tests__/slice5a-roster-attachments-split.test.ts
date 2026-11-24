import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENT_BYTES,
  RosterConfigSchema,
  TaskCardSchema,
  createDefaultBuiltinRosterMetadata,
  type BackendCapabilities,
  type RoleId,
  type RunEvent,
  type SessionRef,
  type WorkflowBlueprint,
} from "@kiln/protocol";
import {
  AcpBackend,
  BackendRegistry,
  ProviderHealthTracker,
  type BackendRunSpec,
  type ExecutionBackend,
} from "../../backend/index.js";
import { UnsupportedTrackError, getTrackStages } from "../../state/index.js";
import { KilnStore, writeFileAtomic } from "../../store/index.js";
import { KilndServer } from "../index.js";

// Valid 1x1 transparent PNG (68 bytes)
const VALID_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

function makeTempDir(prefix = "kiln-slice5a-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createFakeGitRepo(repoPath: string): void {
  fs.mkdirSync(repoPath, { recursive: true });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# repo\n", "utf8");
  execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Kiln Test"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoPath, "config", "user.email", "test@kiln.local"], {
    stdio: "pipe",
  });
  execFileSync("git", ["-C", repoPath, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", repoPath, "commit", "-m", "init"], { stdio: "pipe" });
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

class MultiAgentScriptedBackend implements ExecutionBackend {
  readonly backendId: string;
  readonly startedSpecs: BackendRunSpec[] = [];
  private seq = 0;

  constructor(
    backendId: string,
    private readonly agents: string[],
    private readonly onTurn: (spec: BackendRunSpec, sessionRef: SessionRef) => Promise<void> | void,
    private readonly capsOverride: Partial<BackendCapabilities> = {},
  ) {
    this.backendId = backendId;
  }

  async listAgents() {
    const caps = await this.capabilities(this.agents[0] ?? "codex");
    return this.agents.map((id) => ({
      id,
      label: id,
      capabilities: caps,
      modes: [{ id: "default", label: "Default", isFullAccess: false }],
      defaultModeId: "default",
    }));
  }

  async listModels() {
    return [{ id: "default", label: "default", thinkingOptions: [] }];
  }

  async capabilities(_agent: string): Promise<BackendCapabilities> {
    return {
      interactiveChat: true,
      approvals: false,
      mcpInjection: true,
      usageCacheBreakdown: false,
      interrupt: false,
      imageInput: true,
      readOnlySandbox: false,
      ...this.capsOverride,
    };
  }

  async start(runSpec: BackendRunSpec): Promise<SessionRef> {
    this.seq += 1;
    this.startedSpecs.push(runSpec);
    const ref: SessionRef = {
      backendId: this.backendId,
      sessionId: `${this.backendId}-sess-${this.seq}`,
      meta: {
        providerSessionId: `native-${this.backendId}-${this.seq}`,
      },
    };
    return ref;
  }

  async send(): Promise<void> {}

  async *events(sessionRef: SessionRef): AsyncIterable<RunEvent> {
    const idx = Number(sessionRef.sessionId.split("-").pop() ?? "1") - 1;
    const spec = this.startedSpecs[idx]!;
    await this.onTurn(spec, sessionRef);
    yield {
      kind: "message",
      at: new Date().toISOString(),
      text: `done ${spec.role}`,
    };
    yield {
      kind: "exit",
      at: new Date().toISOString(),
      reason: "completed",
    };
  }

  onApproval(): () => void {
    return () => {};
  }

  async answer(): Promise<void> {}
  async cancel(): Promise<void> {}
  async probe(sessionRef: SessionRef) {
    return {
      alive: true,
      status: "idle" as const,
      activeTurnId: null,
      detail: sessionRef.sessionId,
    };
  }
  async liveViewUrl(): Promise<string | null> {
    return null;
  }
  async dispose(): Promise<void> {}
}

function makeContract(scope: string[] = ["app.txt"]) {
  return {
    goal: "Slice 5a E2E",
    end: "artifact ready",
    accept_cmd: "test -f app.txt",
    accept_files_hash: "pending",
    scope,
    non_goals: ["不改其他模块"],
    deliver: { mode: "manual" as const },
  };
}

function writeRoleReceipt(
  store: KilnStore,
  spec: BackendRunSpec,
  verdictOrOutcome: Record<string, unknown>,
  body: string,
): void {
  const handoffDir = path.join(
    store.paths.runsDir(spec.taskId),
    findRunDirById(store, spec.taskId, spec.runId),
  );
  const lines = Object.entries(verdictOrOutcome).map(([k, v]) =>
    typeof v === "string" ? `${k}: "${v}"` : `${k}: ${JSON.stringify(v)}`,
  );
  const md = [
    "---",
    "schema_version: 1",
    `task_id: "${spec.taskId}"`,
    `run_id: "${spec.runId}"`,
    `contract_version: 1`,
    ...lines,
    "---",
    "",
    body,
    "",
  ].join("\n");
  writeFileAtomic(path.join(handoffDir, "RECEIPT.md"), md);
}

function findRunDirById(store: KilnStore, taskId: string, runId: string): string {
  const dir = store.paths.runsDir(taskId);
  for (const name of fs.readdirSync(dir)) {
    const runYaml = path.join(dir, name, "RUN.yaml");
    if (fs.existsSync(runYaml) && fs.readFileSync(runYaml, "utf8").includes(runId)) {
      return name;
    }
  }
  throw new Error(`Missing runDir for ${runId}`);
}

describe("Slice 5a: Roster PM point-assign, cooldown fallback, multimodal attachments & split cards DAG", () => {
  const tempDirs: string[] = [];
  const servers: KilndServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()!.stop();
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("enforces validateBlueprintAgainstRoster on commit, runs research -> frontend_ui -> cooldown-skipping reviewer E2E, and keeps L3 UnsupportedTrackError", async () => {
    const root = makeTempDir();
    tempDirs.push(root);
    const kilnHome = path.join(root, "kiln-home");
    const repoPath = path.join(root, "repo");
    createFakeGitRepo(repoPath);

    const health = new ProviderHealthTracker();
    // Put claude in cooldown so reviewer skips both colliding codex primary and cooling claude[1] onto pi[2]!
    health.recordRateLimit("claude", { retryAfterSec: 120, detail: "429 rate limited" });

    const registry = new BackendRegistry();
    let storeRef!: KilnStore;
    const backend = new MultiAgentScriptedBackend("multi", ["codex", "claude", "pi"], (spec) => {
      if (spec.role === "advisor" && spec.runId.includes("-research-")) {
        writeRoleReceipt(
          storeRef,
          spec,
          { outcome: "resolved", chosen_approach: "reuse existing cache" },
          "## 技术取舍\n\n确认缓存复用可行。\n\n## 授权裁决\n\n未越权，无需修改契约。",
        );
      } else if (spec.role === "worker") {
        fs.writeFileSync(path.join(spec.cwd, "app.txt"), "built\n", "utf8");
        writeRoleReceipt(
          storeRef,
          spec,
          {
            outcome: "completed",
            input_ref: "HEAD",
            output_ref: "HEAD",
            changed_paths: ["app.txt"],
            accept_result: "pass",
          },
          "## 改动说明\n\n已实现 app.txt。\n\n## 验证命令与真实输出\n\ntest -f app.txt -> ok\n\n## 未完成或待决问题\n\n无",
        );
      } else if (spec.role === "reviewer") {
        writeRoleReceipt(
          storeRef,
          spec,
          { reviewed_ref: "HEAD", verdict: "pass", p0: 0, p1: 0, p2: 0 },
          "## 结论\n\n通过，无阻塞问题。\n\n## 缺陷清单\n\n无\n\n## 测试真实性与复现核查\n\n已核查 app.txt。",
        );
      }
    });
    registry.register(backend);

    const server = new KilndServer({
      kilnHome,
      port: 0,
      enableOrchestrator: true,
      backendRegistry: registry,
      providerHealth: health,
      tokenSecret: "slice5a-roster-secret-0123456789ab",
    });
    storeRef = server.store;
    servers.push(server);

    server.store.writeSpace({
      schema_version: 1,
      id: "demo",
      name: "Demo",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });

    const baseRoster = createDefaultBuiltinRosterMetadata();
    server.store.writeConfig(
      "roster",
      RosterConfigSchema.parse({
        schema_version: 2,
        heterogeneous_review: true,
        pm_orchestration: {
          enabled: true,
          allow_auto_tester: true,
          prefer_unthrottled: true,
          require_review_for_core: true,
        },
        roster: {
          ...baseRoster,
          pm: {
            ...baseRoster.pm,
            enabled: true,
            primary: { provider: "codex", model: "gpt-5.4" },
          },
          researcher: {
            ...baseRoster.researcher,
            enabled: true,
            primary: { provider: "codex", model: "gpt-5.4" },
          },
          frontend_ui: {
            ...baseRoster.frontend_ui,
            enabled: true,
            primary: { provider: "codex", model: "gpt-5.4" },
          },
          reviewer: {
            ...baseRoster.reviewer,
            enabled: true,
            primary: { provider: "codex", model: "gpt-5.4" },
            fallbacks: [
              { provider: "claude", model: "claude-sonnet-4-6" },
              { provider: "pi", model: "gpt-5-mini" },
            ],
          },
        },
      }),
    );
    await server.start();

    // Verify L3 remains unsupported at state machine boundary
    expect(() => getTrackStages("L3", false)).toThrowError(UnsupportedTrackError);

    // 1. Draft commit with read-only roster_role routed to implement MUST fail 400 invalid_workflow_roster
    const createDraftRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "d-roster-bad",
          space: "demo",
          title: "Bad roster assignment",
        }),
      }),
    );
    expect(createDraftRes.status).toBe(201);

    const badBlueprint: WorkflowBlueprint = {
      schema_version: 1,
      preset: "custom",
      steps: [
        {
          kind: "agent",
          stage: "implement",
          role: "worker",
          fresh_context: false,
          roster_role: "researcher",
        },
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
    };

    const badCommitRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-roster-bad/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          space: "demo",
          track: "L1",
          workspace_mode: "git_worktree",
          workflow: badBlueprint,
          contract: makeContract(),
          brief_markdown: "# Brief\nTest",
        }),
      }),
    );
    expect(badCommitRes.status).toBe(400);
    const badJson = (await badCommitRes.json()) as { error: string };
    expect(badJson.error).toBe("invalid_workflow_roster");

    // 2. Valid PM point-assign blueprint: research(researcher) -> implement(frontend_ui) -> verify -> review(reviewer) -> deliver
    const goodBlueprint: WorkflowBlueprint = {
      schema_version: 1,
      preset: "custom",
      pm_rationale: "Need research spike, frontend_ui polish, and heterogeneous review",
      steps: [
        {
          kind: "agent",
          stage: "research",
          role: "advisor",
          fresh_context: true,
          roster_role: "researcher",
          rationale: "Inspect cache boundaries first",
        },
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
              roster_role: "frontend_ui",
              rationale: "UI polish specialist",
            },
            { kind: "gate", stage: "verify", check: "full" },
            {
              kind: "agent",
              stage: "review",
              role: "reviewer",
              fresh_context: true,
              roster_role: "reviewer",
              rationale: "Cross-family check",
            },
          ],
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
    };

    const goodCommitRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-roster-bad/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "t-roster-1",
          space: "demo",
          track: "L2",
          workspace_mode: "git_worktree",
          workflow: goodBlueprint,
          contract: makeContract(),
          brief_markdown: "# Brief\nRun PM point-assign E2E",
        }),
      }),
    );
    expect(goodCommitRes.status).toBe(201);

    await waitUntil(() => server.store.getTaskIndex("t-roster-1")?.status === "done");

    const detailRes = await server.app.request(
      new Request("http://127.0.0.1/api/tasks/t-roster-1"),
    );
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      research: string;
      runs: Array<{
        meta: { stage: string; roster_role?: string; agent: string; model: string } | null;
      }>;
    };
    expect(detail.research).toContain("确认缓存复用可行");

    const researchRun = detail.runs.find((r) => r.meta?.stage === "research");
    const implRun = detail.runs.find((r) => r.meta?.stage === "implement");
    const reviewRun = detail.runs.find((r) => r.meta?.stage === "review");
    expect(researchRun?.meta?.roster_role).toBe("researcher");
    expect(implRun?.meta?.roster_role).toBe("frontend_ui");
    expect(implRun?.meta?.agent).toBe("codex");
    // Reviewer skipped colliding codex primary + cooling claude[1], chose healthy pi[2]
    expect(reviewRun?.meta?.roster_role).toBe("reviewer");
    expect(reviewRun?.meta?.agent).toBe("pi");
    expect(reviewRun?.meta?.model).toBe("gpt-5-mini");

    // Verify readOnly passed cleanly to research & reviewer specs, RESEARCH.md injected downstream, and wb_get_context exposes research
    const startedResearch = backend.startedSpecs.find((s) => s.role === "advisor");
    const startedImpl = backend.startedSpecs.find((s) => s.role === "worker");
    const startedReview = backend.startedSpecs.find((s) => s.role === "reviewer");
    expect(startedResearch?.readOnly).toBe(true);
    expect(startedResearch?.prompt).toContain("前置调研阶段 (research · advisor)");
    expect(startedResearch?.prompt).not.toContain("你只需编辑工作区内 scope 允许的文件");
    expect(startedImpl?.prompt).toContain("## 调研结论 (RESEARCH.md)");
    expect(startedImpl?.prompt).toContain("确认缓存复用可行");
    expect(startedReview?.readOnly).toBe(true);

    const ctxTok = server.issueRunToken({
      taskId: "t-roster-1",
      runId: "r-ctx-check",
      role: "worker" satisfies RoleId,
      contractVersion: 1,
    });
    const ctxRes = await server.invokeMcpRpc({
      method: "POST",
      url: "/rpc/mcp/wb_get_context",
      headers: { authorization: `Bearer ${ctxTok}` },
      rawBody: JSON.stringify({}),
    });
    expect(ctxRes.status).toBe(200);
    expect((ctxRes.body as { research?: string }).research).toContain("确认缓存复用可行");
  });

  it("validates multimodal image attachments, moves them from drafts/ to tasks/ on commit, and forwards ACP image ContentBlock", async () => {
    const root = makeTempDir("kiln-att-e2e-");
    tempDirs.push(root);
    const kilnHome = path.join(root, "kiln-home");
    const server = new KilndServer({
      kilnHome,
      port: 0,
      enableOrchestrator: false,
      tokenSecret: "slice5a-att-secret-0123456789abcd",
    });
    servers.push(server);
    await server.start();

    await server.app.request(
      new Request("http://127.0.0.1/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "d-att", title: "Screenshot bug" }),
      }),
    );

    // 1. Spoofed HTML disguised as image/png -> 400 invalid_attachment_content
    const spoofRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-att/attachments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "evil.png",
          mime_type: "image/png",
          data_base64: Buffer.from("<html><script>alert(1)</script></html>").toString("base64"),
        }),
      }),
    );
    expect(spoofRes.status).toBe(400);

    // 2. Oversized image > 10 MiB -> 413
    const hugeHeader = Buffer.concat([VALID_PNG_BYTES, Buffer.alloc(MAX_ATTACHMENT_BYTES + 100)]);
    const hugeForm = new FormData();
    hugeForm.set("file", new File([hugeHeader], "huge.png", { type: "image/png" }));
    const hugeRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-att/attachments", {
        method: "POST",
        body: hugeForm,
      }),
    );
    expect(hugeRes.status).toBe(413);

    // 3. Valid PNG via JSON base64 + multipart/form-data
    const jsonUpload = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-att/attachments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "../nested/shot1.png",
          mime_type: "image/png",
          data_base64: VALID_PNG_BYTES.toString("base64"),
        }),
      }),
    );
    expect(jsonUpload.status).toBe(201);
    const jsonAtt = (await jsonUpload.json()) as {
      attachment: { id: string; filename: string; rel_path: string };
    };
    expect(jsonAtt.attachment.filename).toBe("shot1.png");
    expect(jsonAtt.attachment.rel_path).toMatch(/^drafts\/d-att\/attachments\//);

    const mpForm = new FormData();
    mpForm.set("file", new File([VALID_PNG_BYTES], "shot2.png", { type: "image/png" }));
    const mpUpload = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-att/attachments", {
        method: "POST",
        body: mpForm,
      }),
    );
    expect(mpUpload.status).toBe(201);
    const mpAtt = (await mpUpload.json()) as { attachment: { id: string } };

    // Delete second attachment cleanly
    const delRes = await server.app.request(
      new Request(`http://127.0.0.1/api/drafts/d-att/attachments/${mpAtt.attachment.id}`, {
        method: "DELETE",
      }),
    );
    expect(delRes.status).toBe(200);

    // Fetch draft attachment bytes
    const getDraftAtt = await server.app.request(
      new Request(`http://127.0.0.1/api/drafts/d-att/attachments/${jsonAtt.attachment.id}`),
    );
    expect(getDraftAtt.status).toBe(200);
    expect(getDraftAtt.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await getDraftAtt.arrayBuffer())).toEqual(VALID_PNG_BYTES);

    // P1 guard: wb_plan(upsert_draft) with attachments: [] MUST NOT wipe uploaded draft attachments
    const upsertTok = server.issueRunToken({
      taskId: "t-intake",
      runId: "r-upsert-att",
      role: "intake" satisfies RoleId,
      contractVersion: 1,
    });
    const upsertRes = await server.invokeMcpRpc({
      method: "POST",
      url: "/rpc/mcp/wb_plan",
      headers: { authorization: `Bearer ${upsertTok}` },
      rawBody: JSON.stringify({
        mode: "upsert_draft",
        draft_id: "d-att",
        title: "Screenshot bug updated",
        attachments: [],
      }),
    });
    expect(upsertRes.status).toBe(200);
    expect(server.store.readDraft("d-att")?.attachments).toHaveLength(1);

    // Commit draft -> attachment moves to tasks/<id>/attachments/
    const commitRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-att/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "t-att-1",
          space: "local",
          workspace_mode: "scratch_dir",
          contract: makeContract(["out.txt"]),
          brief_markdown: "# Brief\nImage attachment",
        }),
      }),
    );
    expect(commitRes.status).toBe(201);
    const committed = (await commitRes.json()) as {
      card: { attachments?: Array<{ id: string; rel_path: string }> };
    };
    expect(committed.card.attachments).toHaveLength(1);
    expect(committed.card.attachments![0]!.rel_path).toMatch(/^tasks\/t-att-1\/attachments\//);
    expect(fs.existsSync(server.store.paths.draftDir("d-att"))).toBe(false);

    // P0 guard: committing another draft with conflicting existing task id MUST 409 and NOT delete existing task
    await server.app.request(
      new Request("http://127.0.0.1/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "d-conflict", space: "local", title: "Conflict" }),
      }),
    );
    const conflictCommitRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-conflict/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "t-att-1",
          space: "local",
          workspace_mode: "scratch_dir",
          contract: makeContract(["out.txt"]),
          brief_markdown: "# Conflict",
        }),
      }),
    );
    expect(conflictCommitRes.status).toBe(409);
    expect(((await conflictCommitRes.json()) as { error: string }).error).toBe(
      "task_already_exists",
    );
    expect(server.store.getTaskIndex("t-att-1")?.id).toBe("t-att-1");
    expect(fs.existsSync(server.store.paths.cardYaml("t-att-1"))).toBe(true);

    const getTaskAtt = await server.app.request(
      new Request(`http://127.0.0.1/api/tasks/t-att-1/attachments/${jsonAtt.attachment.id}`),
    );
    expect(getTaskAtt.status).toBe(200);
    expect(Buffer.from(await getTaskAtt.arrayBuffer())).toEqual(VALID_PNG_BYTES);

    // Verify AcpBackend forwards ContentBlock type="image" when agent has promptCapabilities.image = true
    const acpStub = path.join(root, "acp-img-stub.mjs");
    const promptLog = path.join(root, "acp-prompts.jsonl");
    fs.writeFileSync(
      acpStub,
      `
import fs from "node:fs";
let buf = "";
function send(o) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\\n"); }
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  while (true) {
    const i = buf.indexOf("\\n");
    if (i === -1) break;
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") {
      send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: "fake-acp", version: "1.0.0" }, agentCapabilities: { promptCapabilities: { image: true } } } });
    } else if (m.method === "session/new") {
      send({ id: m.id, result: { sessionId: "acp-img-1", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] }, models: { currentModelId: "default", availableModels: [{ modelId: "default", name: "Default" }] } } });
    } else if (m.method === "session/set_mode" || m.method === "session/set_model") {
      send({ id: m.id, result: {} });
    } else if (m.method === "session/prompt") {
      fs.appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify(m.params.prompt) + "\\n");
      send({ id: m.id, result: { stopReason: "end_turn" } });
    }
  }
});
`,
      "utf8",
    );

    const acpBackend = new AcpBackend({
      provider: {
        id: "agy",
        label: "Agy Image",
        adapter: "acp",
        enabled: true,
        command: process.execPath,
        args: [acpStub],
        env: {},
        custom_models: [],
      },
    });
    try {
      const diskName = path.posix.basename(committed.card.attachments![0]!.rel_path);
      const ref = await acpBackend.start({
        runId: "r-img",
        taskId: "t-att-1",
        role: "worker",
        agent: "agy",
        model: "default",
        cwd: root,
        prompt: "inspect screenshot",
        freshContext: false,
        attachments: [
          {
            path: server.store.paths.taskAttachmentFile("t-att-1", diskName),
            mimeType: "image/png",
            filename: "shot1.png",
          },
        ],
      });
      for await (const _ev of acpBackend.events(ref)) {
        // drain
      }
      const recordedBlocks = JSON.parse(fs.readFileSync(promptLog, "utf8").trim()) as Array<{
        type: string;
        mimeType?: string;
        data?: string;
      }>;
      expect(recordedBlocks).toHaveLength(2);
      expect(recordedBlocks[1]).toMatchObject({
        type: "image",
        mimeType: "image/png",
        data: VALID_PNG_BYTES.toString("base64"),
      });
    } finally {
      await acpBackend.dispose();
    }
  });

  it("commits split cards DAG atomically via HTTP & MCP wb_plan and rolls back all cards on failure", async () => {
    const root = makeTempDir("kiln-split-");
    tempDirs.push(root);
    const kilnHome = path.join(root, "kiln-home");
    const server = new KilndServer({
      kilnHome,
      port: 0,
      enableOrchestrator: false,
      tokenSecret: "slice5a-split-secret-0123456789ab",
    });
    servers.push(server);
    await server.start();

    // Seed draft with an image attachment
    await server.app.request(
      new Request("http://127.0.0.1/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "d-split", space: "local", title: "Split epic" }),
      }),
    );
    await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-split/attachments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "spec.png",
          mime_type: "image/png",
          data_base64: VALID_PNG_BYTES.toString("base64"),
        }),
      }),
    );

    // 1. Partial failure rollback: card 2 uses git_worktree in unconfigured "local" space -> MUST roll back cleanly
    const failSplit = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-split/commit-split", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cards: [
            {
              temp_id: "s1",
              title: "Valid Card 1",
              space: "local",
              workspace_mode: "scratch_dir",
              depends_on_temp_ids: [],
              contract: makeContract(["a.txt"]),
              brief_markdown: "Slice 1",
            },
            {
              temp_id: "s2",
              title: "Invalid Card 2",
              space: "local",
              workspace_mode: "git_worktree",
              depends_on_temp_ids: ["s1"],
              contract: makeContract(["b.txt"]),
              brief_markdown: "Slice 2",
            },
          ],
        }),
      }),
    );
    expect(failSplit.status).toBe(400);
    expect(server.store.listTasks()).toHaveLength(0);
    expect(server.store.readDraft("d-split")).not.toBeNull();

    // 2. Valid 3-card DAG commit via HTTP POST /api/drafts/:id/commit-split (out-of-order input to test topo sort)
    const okSplit = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-split/commit-split", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cards: [
            {
              temp_id: "c3",
              title: "Slice 3",
              space: "local",
              workspace_mode: "scratch_dir",
              depends_on_temp_ids: [" c2 "],
              attachments: [],
              contract: makeContract(["c3.txt"]),
              brief_markdown: "Slice 3",
            },
            {
              temp_id: "c1",
              title: "Slice 1",
              space: "local",
              workspace_mode: "scratch_dir",
              depends_on_temp_ids: [],
              contract: makeContract(["c1.txt"]),
              brief_markdown: "Slice 1",
            },
            {
              temp_id: " c2 ",
              title: "Slice 2",
              space: "local",
              workspace_mode: "scratch_dir",
              depends_on_temp_ids: ["c1"],
              contract: makeContract(["c2.txt"]),
              brief_markdown: "Slice 2",
            },
          ],
        }),
      }),
    );
    expect(okSplit.status).toBe(201);
    const splitJson = (await okSplit.json()) as {
      ok: boolean;
      tempIdToTaskId: Record<string, string>;
      cards: Array<{ id: string; depends_on: string[]; attachments?: Array<{ rel_path: string }> }>;
    };
    expect(splitJson.ok).toBe(true);
    expect(splitJson.cards.map((c) => c.id)).toEqual([
      splitJson.tempIdToTaskId.c1,
      splitJson.tempIdToTaskId.c2,
      splitJson.tempIdToTaskId.c3,
    ]);
    expect(splitJson.cards[1]!.depends_on).toEqual([splitJson.tempIdToTaskId.c1]);
    expect(splitJson.cards[2]!.depends_on).toEqual([splitJson.tempIdToTaskId.c2]);
    // Attachment copied to cards without explicit attachments: [], omitted when attachments: []
    expect(splitJson.cards[0]!.attachments?.[0]?.rel_path).toMatch(
      new RegExp(`^tasks/${splitJson.tempIdToTaskId.c1}/attachments/`),
    );
    expect(splitJson.cards[2]!.attachments).toBeUndefined();
    expect(server.store.readDraft("d-split")).toBeNull();

    // 3. Also verify MCP wb_plan(mode: "commit_split_cards") creates split cards via McpRpcServer
    const token = server.issueRunToken({
      taskId: "t-intake",
      runId: "r-intake",
      role: "intake" satisfies RoleId,
      contractVersion: 1,
    });
    const mcpRes = await server.invokeMcpRpc({
      method: "POST",
      url: "/rpc/mcp/wb_plan",
      headers: { authorization: `Bearer ${token}` },
      rawBody: JSON.stringify({
        mode: "commit_split_cards",
        cards: [
          {
            temp_id: "m1",
            title: "MCP Slice 1",
            space: "local",
            workspace_mode: "scratch_dir",
            depends_on_temp_ids: [],
            contract: makeContract(["m1.txt"]),
            brief_markdown: "M1",
          },
          {
            temp_id: "m2",
            title: "MCP Slice 2",
            space: "local",
            workspace_mode: "scratch_dir",
            depends_on_temp_ids: ["m1"],
            contract: makeContract(["m2.txt"]),
            brief_markdown: "M2",
          },
        ],
      }),
    });
    expect(mcpRes.status).toBe(200);
    const mcpBody = mcpRes.body as {
      ok: boolean;
      mode: string;
      tempIdToTaskId: Record<string, string>;
    };
    expect(mcpBody.mode).toBe("commit_split_cards");
    const m2Card = TaskCardSchema.parse(server.store.readTaskCard(mcpBody.tempIdToTaskId.m2!));
    expect(m2Card.depends_on).toEqual([mcpBody.tempIdToTaskId.m1]);
  });

  it("injects enabled roster pool (omitting disabled roles & marking cooldown) plus draft attachments into intake prompt", async () => {
    const root = makeTempDir("kiln-pm-prompt-");
    tempDirs.push(root);
    const kilnHome = path.join(root, "kiln-home");
    const health = new ProviderHealthTracker();
    health.recordRateLimit("claude", { retryAfterSec: 60 });

    const capturedSpecs: BackendRunSpec[] = [];
    const registry = new BackendRegistry();
    registry.register(
      new MultiAgentScriptedBackend("pm-rec", ["codex"], (spec) => {
        capturedSpecs.push(spec);
      }),
    );

    const server = new KilndServer({
      kilnHome,
      port: 0,
      enableOrchestrator: false,
      backendRegistry: registry,
      providerHealth: health,
      tokenSecret: "slice5a-pm-secret-0123456789abcd",
    });
    servers.push(server);
    await server.start();

    const baseRoster = createDefaultBuiltinRosterMetadata();
    server.store.writeConfig(
      "roster",
      RosterConfigSchema.parse({
        schema_version: 2,
        heterogeneous_review: true,
        roster: {
          ...baseRoster,
          pm: {
            ...baseRoster.pm,
            enabled: true,
            primary: { provider: "codex", model: "gpt-5.4" },
          },
          frontend_ui: {
            ...baseRoster.frontend_ui,
            enabled: true,
            primary: { provider: "claude", model: "claude-sonnet-4-6" },
          },
          debugger: {
            ...baseRoster.debugger,
            enabled: false,
          },
        },
      }),
    );

    await server.app.request(
      new Request("http://127.0.0.1/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "d-pm", title: "Polish header" }),
      }),
    );
    await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-pm/attachments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "ui.png",
          mime_type: "image/png",
          data_base64: VALID_PNG_BYTES.toString("base64"),
        }),
      }),
    );

    const chatRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-pm/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "帮我优化顶部导航样式" }),
      }),
    );
    expect(chatRes.status).toBe(200);
    expect(capturedSpecs).toHaveLength(1);
    const sysPrompt = capturedSpecs[0]!.systemPrompt ?? "";
    expect(sysPrompt).toContain("frontend_ui");
    expect(sysPrompt).toContain("[冷却中]");
    expect(sysPrompt).not.toContain("debugger (疑难排障专家)");
    expect(capturedSpecs[0]!.attachments).toHaveLength(1);
    expect(capturedSpecs[0]!.attachments![0]!.filename).toBe("ui.png");
  });

  it("blocks research-stage git_worktree mutation (advisor_workspace_mutation) and rejects forged draft attachments in wb_plan(commit_card)", async () => {
    const root = makeTempDir("kiln-research-mut-");
    tempDirs.push(root);
    const kilnHome = path.join(root, "kiln-home");
    const repoPath = path.join(root, "repo");
    createFakeGitRepo(repoPath);

    let storeRef!: KilnStore;
    const registry = new BackendRegistry();
    registry.register(
      new MultiAgentScriptedBackend("mut-test", ["codex"], (spec) => {
        if (spec.runId.includes("-research-")) {
          // Mutate git worktree during read-only research stage!
          fs.writeFileSync(
            path.join(spec.cwd, "app.txt"),
            "illegal edit during research\n",
            "utf8",
          );
          writeRoleReceipt(
            storeRef,
            spec,
            { outcome: "resolved", chosen_approach: "sneaky edit" },
            "## 技术取舍\n\n试探只读护栏。\n\n## 授权裁决\n\n越权测试。",
          );
        }
      }),
    );

    const server = new KilndServer({
      kilnHome,
      port: 0,
      enableOrchestrator: true,
      backendRegistry: registry,
      tokenSecret: "slice5a-mut-secret-0123456789abcd",
    });
    storeRef = server.store;
    servers.push(server);

    server.store.writeSpace({
      schema_version: 1,
      id: "demo",
      name: "Demo",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });

    const baseRoster = createDefaultBuiltinRosterMetadata();
    server.store.writeConfig(
      "roster",
      RosterConfigSchema.parse({
        schema_version: 2,
        heterogeneous_review: false,
        roster: {
          ...baseRoster,
          researcher: {
            ...baseRoster.researcher,
            enabled: true,
            primary: { provider: "codex", model: "gpt-5.4" },
          },
          main_dev: {
            ...baseRoster.main_dev,
            enabled: true,
            primary: { provider: "codex", model: "gpt-5.4" },
          },
        },
      }),
    );
    await server.start();

    // 1. Verify forged attachment rel_path in wb_plan(commit_card) is rejected 400
    const intakeTok = server.issueRunToken({
      taskId: "t-intake",
      runId: "r-intake",
      role: "intake" satisfies RoleId,
      contractVersion: 1,
    });
    const forgedRes = await server.invokeMcpRpc({
      method: "POST",
      url: "/rpc/mcp/wb_plan",
      headers: { authorization: `Bearer ${intakeTok}` },
      rawBody: JSON.stringify({
        mode: "commit_card",
        title: "Forged attachment card",
        space: "demo",
        workspace_mode: "git_worktree",
        attachments: [
          {
            id: "att-forged",
            filename: "x.png",
            mime_type: "image/png",
            size_bytes: 68,
            sha256: "a".repeat(64),
            rel_path: "drafts/other/attachments/x.png",
            added_at: new Date().toISOString(),
          },
        ],
        contract: makeContract(),
        brief_markdown: "# Brief",
      }),
    });
    expect(forgedRes.status).toBe(400);
    expect((forgedRes.body as { error?: string }).error).toBe("invalid_attachment_path");

    // 2. Verify research-stage workspace mutation halts in waiting with advisor_workspace_mutation
    const commitRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "d-mut", space: "demo", title: "Research mutation check" }),
      }),
    );
    expect(commitRes.status).toBe(201);

    const blueprint: WorkflowBlueprint = {
      schema_version: 1,
      preset: "custom",
      steps: [
        {
          kind: "agent",
          stage: "research",
          role: "advisor",
          fresh_context: true,
          roster_role: "researcher",
        },
        {
          kind: "agent",
          stage: "implement",
          role: "worker",
          fresh_context: false,
          roster_role: "main_dev",
        },
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
    };

    const startRes = await server.app.request(
      new Request("http://127.0.0.1/api/drafts/d-mut/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "t-mut-1",
          space: "demo",
          track: "L1",
          workspace_mode: "git_worktree",
          workflow: blueprint,
          contract: makeContract(),
          brief_markdown: "# Brief",
        }),
      }),
    );
    expect(startRes.status).toBe(201);

    await waitUntil(() => server.store.getTaskIndex("t-mut-1")?.status === "waiting");
    const pending = server.pendingDecisions.get("t-mut-1");
    expect(pending?.reason).toBe("advisor_workspace_mutation");
  });
});
