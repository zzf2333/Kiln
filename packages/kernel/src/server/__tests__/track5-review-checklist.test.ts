import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AcceptVerificationReportSchema,
  PendingDecisionSchema,
  RunMetaSchema,
  TaskCardSchema,
} from "@kiln/protocol";
import { TaskStateMachine } from "../../state/index.js";
import { KilnStore, writeFileAtomic, writeYamlAtomic } from "../../store/index.js";
import { PendingDecisionStore } from "../pending-decisions.js";
import { SseHub } from "../sse.js";
import { createHttpApiApp } from "../http-api.js";

const tempDirs: string[] = [];
const stores: KilnStore[] = [];

afterEach(() => {
  for (const st of stores.splice(0, stores.length)) {
    st.close();
  }
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function setupTestServer() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kiln-b12-4-"));
  tempDirs.push(home);
  const store = new KilnStore({ kilnHome: home });
  stores.push(store);
  const stateMachine = new TaskStateMachine(store);
  const pendingDecisions = new PendingDecisionStore(store);
  const sseHub = new SseHub();
  const queuedIds: string[] = [];
  const caffeinate = {
    syncRunningCount: () => {},
    getStatus: () => ({ supported: false, enabled: false, active: false, activeCount: 0 }),
    shutdown: () => {},
  };

  const card = TaskCardSchema.parse({
    schema_version: 1,
    id: "t-chk-1",
    title: "Checklist Task",
    space: "local",
    priority: "P1",
    track: "L2",
    workspace_mode: "git_worktree",
    parent: null,
    depends_on: [],
    contract_version: 1,
    contract: {
      goal: "Verify checklist rework and waive",
      end: "Checklist resolved",
      accept_cmd: "echo ok",
      accept_files_hash: `sha256:${"a".repeat(64)}`,
      scope: ["src/app.ts"],
      deliver: { mode: "merge_main", cmd: null },
      human_accept: true,
      external_actions: "ask",
    },
    limits: {
      retries_per_stage: 2,
      review_rounds: 2,
      advisor_calls: 1,
      max_tokens: 150_000,
    },
    created_at: "2026-11-24T01:00:00Z",
    updated_at: "2026-11-24T01:00:00Z",
  });
  stateMachine.createTask(card, "# Brief\nChecklist");

  // Simulate review run with mixed findings + accept run with scenario report
  const revDir = "002-review";
  fs.mkdirSync(store.paths.runDir("t-chk-1", revDir), { recursive: true });
  writeYamlAtomic(
    store.paths.runYaml("t-chk-1", revDir),
    RunMetaSchema.parse({
      schema_version: 1,
      run_id: "r-rev-1",
      task_id: "t-chk-1",
      stage: "review",
      round: 1,
      role: "reviewer",
      contract_version: 1,
      backend_id: "fake",
      agent: "claude",
      model: "claude-sonnet-4-6",
      session_ref: { backendId: "fake", sessionId: "s-rev" },
      started_at: "2026-11-24T01:01:00Z",
    }),
    RunMetaSchema,
  );
  writeFileAtomic(
    store.paths.receiptMd("t-chk-1", revDir),
    `---
run_id: r-rev-1
contract_version: 1
reviewed_ref: abc123
verdict: changes_requested
p0: 1
p1: 1
p2: 0
---
## 结论
Requires fixes

## 缺陷清单
- [P0] Missing CSRF origin guard in \`src/server.ts\`
  Allowing cross-origin state writes
- [P1] Unchecked timeout branch in \`src/client.ts\`

## 测试真实性与复现核查
Checked.
`,
  );

  const accDir = "003-accept";
  fs.mkdirSync(store.paths.runDir("t-chk-1", accDir), { recursive: true });
  writeYamlAtomic(
    store.paths.runYaml("t-chk-1", accDir),
    RunMetaSchema.parse({
      schema_version: 1,
      run_id: "r-acc-1",
      task_id: "t-chk-1",
      stage: "accept",
      round: 1,
      role: "verifier",
      contract_version: 1,
      backend_id: "fake",
      agent: "codex",
      model: "gpt-5.4",
      session_ref: { backendId: "fake", sessionId: "s-acc" },
      started_at: "2026-11-24T01:02:00Z",
    }),
    RunMetaSchema,
  );
  writeYamlAtomic(
    store.paths.runAcceptReportYaml("t-chk-1", accDir),
    AcceptVerificationReportSchema.parse({
      schema_version: 1,
      run_id: "r-acc-1",
      contract_version: 1,
      checked_at: "2026-11-24T01:03:00Z",
      entry_kind: "http_server",
      verdict: "fail",
      gate_ok: false,
      rejection_reasons: [],
      evidence_files: [],
      scenarios: [
        {
          name: "Login flow",
          status: "fail",
          note: "Returned HTTP 500 on submit",
        },
        {
          name: "Health probe",
          status: "pass",
        },
      ],
      services: [],
      traffic: {
        observed: true,
        total_requests: 3,
        unique_paths: ["/health", "/login"],
        error_responses: [{ method: "POST", path: "/login", status: 500, service: "web" }],
      },
    }),
    AcceptVerificationReportSchema,
  );

  // Move task into waiting(review) with a pending decision
  store.appendStateEvent("t-chk-1", {
    type: "running",
    at: "2026-11-24T01:01:00Z",
    stage: "review",
    round: 1,
    run_id: "r-rev-1",
  });
  const pending = PendingDecisionSchema.parse({
    id: "dec-rev-max",
    task_id: "t-chk-1",
    run_id: "r-rev-1",
    contract_version: 1,
    reason: "review_rounds_exhausted",
    category: "review_escalation",
    question: "Review round exhausted, please decide",
    options: [
      {
        id: "opt-fix",
        label: "Rework",
        action: "resume",
        target_stage: "implement",
        recommended: true,
      },
    ],
    created_at: "2026-11-24T01:04:00Z",
  });
  stateMachine.requestDecision("t-chk-1", pending, "2026-11-24T01:04:00Z");
  pendingDecisions.set(pending);

  const app = createHttpApiApp({
    store,
    stateMachine,
    pendingDecisions,
    sseHub,
    caffeinate: caffeinate as never,
    onTaskQueued: (id: string) => {
      queuedIds.push(id);
    },
    publicDir: null,
  });

  return { app, store, stateMachine, pendingDecisions, queuedIds };
}

describe("Track 5 [B12.4] review checklist HTTP API", () => {
  it("exposes reviewChecklist in GET /api/tasks/:id and validates/persists mixed rework+waive", async () => {
    const { app, store, pendingDecisions, queuedIds } = setupTestServer();

    const detailRes = await app.request("/api/tasks/t-chk-1");
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      reviewChecklist: Array<{
        id: string;
        source: string;
        severity: string;
        title: string;
        location?: string;
      }>;
    };
    expect(detail.reviewChecklist).toHaveLength(4);
    expect(detail.reviewChecklist[0]).toMatchObject({
      id: "002-review:rf-1",
      source: "review",
      severity: "P0",
      location: "src/server.ts",
    });
    expect(detail.reviewChecklist[2]).toMatchObject({
      id: "003-accept:sc-1",
      source: "accept",
      severity: "fail",
      title: "Login flow",
    });

    // Reject waive without rationale
    const badWaive = await app.request("/api/tasks/t-chk-1/checklist/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ item_id: "002-review:rf-2", disposition: "waive", rationale: "" }],
      }),
    });
    expect(badWaive.status).toBe(400);

    // Reject unknown item id
    const badId = await app.request("/api/tasks/t-chk-1/checklist/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ item_id: "missing:rf-9", disposition: "rework" }],
      }),
    });
    expect(badId.status).toBe(400);

    // Reject advance_after_waive while blocking items still lack disposition
    const partialAdvance = await app.request("/api/tasks/t-chk-1/checklist/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          { item_id: "002-review:rf-2", disposition: "waive", rationale: "Acceptable for now" },
        ],
        advance_after_waive: true,
      }),
    });
    expect(partialAdvance.status).toBe(409);
    expect(await partialAdvance.json()).toMatchObject({ error: "unresolved_blocking_items" });

    // Submit mixed rework + waive
    const resolveRes = await app.request("/api/tasks/t-chk-1/checklist/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          { item_id: "002-review:rf-1", disposition: "rework", rationale: "Fix before merge" },
          {
            item_id: "002-review:rf-2",
            disposition: "waive",
            rationale: "Timeout handled upstream",
          },
          { item_id: "003-accept:sc-1", disposition: "rework" },
        ],
        extra_note: "Prioritize login 500",
      }),
    });
    expect(resolveRes.status).toBe(200);
    const body = (await resolveRes.json()) as {
      ok: boolean;
      mode: string;
      status: string;
      stage: string;
      reviewChecklist: Array<{ id: string; disposition?: string; rationale?: string }>;
      message: string;
    };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("rework_queued");
    expect(body.status).toBe("queued");
    expect(body.stage).toBe("implement");
    expect(body.message).toContain("必须打回修复条目");
    expect(body.message).toContain("已确认豁免条目（无需修改）");
    expect(body.message).toContain("Timeout handled upstream");
    expect(queuedIds).toContain("t-chk-1");
    expect(pendingDecisions.get("t-chk-1")).toBeNull();

    // Persisted dispositions & audit log
    expect(fs.existsSync(store.paths.checklistDispositionsYaml("t-chk-1"))).toBe(true);
    const decisionsMd = fs.readFileSync(store.paths.decisionsMd("t-chk-1"), "utf8");
    expect(decisionsMd).toContain("审查/验收清单裁决");
    expect(decisionsMd).toContain("Timeout handled upstream");

    const reloadRes = await app.request("/api/tasks/t-chk-1");
    const reloaded = (await reloadRes.json()) as {
      reviewChecklist: Array<{ id: string; disposition?: string; rationale?: string }>;
      steers: Array<{ message: string }>;
    };
    expect(reloaded.reviewChecklist.find((i) => i.id === "002-review:rf-2")?.disposition).toBe(
      "waive",
    );
    expect(reloaded.steers.at(-1)?.message).toContain("Prioritize login 500");
  });

  it("advances waiting(review) task after waiving all blocking items, and blocks budget_exceeded waiting tasks", async () => {
    const { app, store, stateMachine, pendingDecisions } = setupTestServer();

    // Advance after waiving all 3 blocking items (P0, P1, accept:fail)
    const waiveAdvance = await app.request("/api/tasks/t-chk-1/checklist/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          { item_id: "002-review:rf-1", disposition: "waive", rationale: "Local-only behind auth" },
          { item_id: "002-review:rf-2", disposition: "waive", rationale: "Covered in next sprint" },
          { item_id: "003-accept:sc-1", disposition: "waive", rationale: "Env fixture mismatch" },
        ],
        advance_after_waive: true,
      }),
    });
    expect(waiveAdvance.status).toBe(200);
    const body = (await waiveAdvance.json()) as { mode: string; status: string; stage: string };
    expect(body).toMatchObject({
      mode: "waived_and_advanced",
      status: "queued",
      stage: "accept",
    });

    // Put task into waiting(budget_exceeded) and ensure checklist rework is blocked with 409
    store.appendStateEvent("t-chk-1", {
      type: "running",
      at: "2026-11-24T01:05:00Z",
      stage: "accept",
      round: 1,
      run_id: "r-acc-2",
    });
    const budgetPending = PendingDecisionSchema.parse({
      id: "dec-budget-1",
      task_id: "t-chk-1",
      contract_version: 1,
      reason: "budget_exceeded",
      category: "budget_exceeded",
      question: "Budget exceeded",
      options: [{ id: "opt-raise", label: "Raise", action: "resume", recommended: true }],
      created_at: "2026-11-24T01:06:00Z",
    });
    stateMachine.requestDecision("t-chk-1", budgetPending, "2026-11-24T01:06:00Z");
    pendingDecisions.set(budgetPending);

    const blockedRes = await app.request("/api/tasks/t-chk-1/checklist/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ item_id: "002-review:rf-1", disposition: "rework" }],
      }),
    });
    expect(blockedRes.status).toBe(409);
    expect(await blockedRes.json()).toMatchObject({ error: "waiting_requires_decision" });
  });
});
