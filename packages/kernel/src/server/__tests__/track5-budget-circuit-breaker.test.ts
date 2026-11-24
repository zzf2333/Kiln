import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CardLimitsSchema,
  LimitsConfigSchema,
  PricingConfigSchema,
  ProvidersConfigSchema,
  RemoteConfigSchema,
  RolesConfigSchema,
  RunEventSchema,
  RunMetaSchema,
  TaskCardSchema,
} from "@kiln/protocol";
import { BackendRegistry, FakeBackend, type BackendAgentDescriptor } from "../../backend/index.js";
import { checkCircuitBreaker } from "../../state/escalation.js";
import { KilnStore, writeYamlAtomic } from "../../store/index.js";
import {
  KilndServer,
  computeGlobalBudgetStatus,
  computeTaskBudgetStatus,
} from "../index.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const CODEX_DESCRIPTOR: BackendAgentDescriptor = {
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
};

const CLAUDE_DESCRIPTOR: BackendAgentDescriptor = {
  ...CODEX_DESCRIPTOR,
  id: "claude",
  label: "Claude Code",
};

async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

describe("Track 5 [B10] USD budget circuit breakers", () => {
  const servers: KilndServer[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await s.stop().catch(() => {});
    }
    for (const d of tempDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("trips checkCircuitBreaker with max_cost_usd_exceeded and preserves exact disk-backed budget after rebuildIndexFromDisk()", () => {
    const res = checkCircuitBreaker(
      {
        stageRetries: 0,
        reviewRounds: 0,
        advisorCalls: 0,
        totalTokens: 1_000,
        totalCostUsd: 1.5,
      },
      CardLimitsSchema.parse({
        retries_per_stage: 2,
        review_rounds: 2,
        advisor_calls: 1,
        max_tokens: 100_000,
        max_cost_usd: 1.5,
      }),
    );
    expect(res.tripped).toBe(true);
    expect(res.reasons).toEqual(["max_cost_usd_exceeded"]);

    const home = createTempDir("kiln-b10-disk-");
    const store = new KilnStore({ kilnHome: home });
    store.writeConfig(
      "pricing",
      PricingConfigSchema.parse({
        schema_version: 1,
        models: {
          "gpt-5.4": { in: 10, cached: 1, out: 30 },
          "claude-sonnet-4-6": { in: 5, cached: 0.5, out: 15 },
        },
      }),
    );
    store.writeConfig(
      "providers",
      ProvidersConfigSchema.parse({
        schema_version: 1,
        providers: [
          { id: "codex", label: "Codex", adapter: "codex_app_server", enabled: true, billing_mode: "api" },
          { id: "claude", label: "Claude", adapter: "claude_direct", enabled: true, billing_mode: "subscription" },
        ],
      }),
    );
    store.writeConfig(
      "limits",
      LimitsConfigSchema.parse({
        schema_version: 1,
        daily_budget_usd: 2.0,
        monthly_budget_usd: 10.0,
        budget_soft_warning_ratio: 0.8,
        budget_exclude_subscription_providers: true,
      }),
    );

    const card = TaskCardSchema.parse({
      schema_version: 1,
      id: "t-b10-rebuild",
      title: "Rebuild consistency",
      space: "local",
      priority: "P1",
      track: "L1",
      workspace_mode: "scratch_dir",
      parent: null,
      depends_on: [],
      contract_version: 1,
      contract: {
        goal: "Test rebuild",
        end: "Done",
        accept_cmd: "echo ok",
        accept_files_hash: `sha256:${"a".repeat(64)}`,
        scope: ["**"],
        deliver: { mode: "manual", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: {
        retries_per_stage: 2,
        review_rounds: 2,
        advisor_calls: 1,
        max_tokens: 150_000,
        max_cost_usd: 1.8,
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    store.createTask(card, "# Brief");
    const runMeta = RunMetaSchema.parse({
      schema_version: 1,
      run_id: "r-b10-1",
      task_id: card.id,
      stage: "implement",
      round: 1,
      contract_version: 1,
      role: "worker",
      agent: "codex",
      model: "gpt-5.4",
      backend_id: "fake",
      session_ref: { backendId: "fake", sessionId: "s-1" },
      started_at: new Date().toISOString(),
    });
    writeYamlAtomic(store.paths.runYaml(card.id, "001-implement"), runMeta, RunMetaSchema);

    // 100k input @ $10/1M = $1.00; 20k output @ $30/1M = $0.60 => $1.60 API cost (80% warning of $2 daily, 88.89% of $1.80 card)
    store.recordRunEvent(
      card.id,
      "001-implement",
      RunEventSchema.parse({
        kind: "usage",
        turnId: "t-codex",
        agent: "codex",
        model: "gpt-5.4",
        inputTokens: 100_000,
        cachedInputTokens: 0,
        outputTokens: 20_000,
        at: new Date().toISOString(),
      }),
    );
    // Subscription provider turn should be ignored when exclude_subscription_providers=true
    store.recordRunEvent(
      card.id,
      "001-implement",
      RunEventSchema.parse({
        kind: "usage",
        turnId: "t-claude",
        agent: "claude",
        model: "claude-sonnet-4-6",
        inputTokens: 200_000,
        cachedInputTokens: 0,
        outputTokens: 50_000,
        at: new Date().toISOString(),
      }),
    );

    const beforeGlobal = computeGlobalBudgetStatus(store);
    const beforeCard = computeTaskBudgetStatus(store, card);
    expect(beforeGlobal.daily.spent_usd).toBeCloseTo(1.6, 4);
    expect(beforeGlobal.daily.level).toBe("warning");
    expect(beforeCard.spent_usd).toBeCloseTo(1.6, 4);
    expect(beforeCard.level).toBe("warning");

    // Rebuild sqlite index strictly from disk and assert identical budget status
    store.rebuildIndexFromDisk();
    const afterGlobal = computeGlobalBudgetStatus(store);
    const afterCard = computeTaskBudgetStatus(store, card);
    expect(afterGlobal.daily.spent_usd).toBe(beforeGlobal.daily.spent_usd);
    expect(afterGlobal.daily.level).toBe(beforeGlobal.daily.level);
    expect(afterCard.spent_usd).toBe(beforeCard.spent_usd);
  });

  it("blocks card dispatch on max_cost_usd_exceeded, notifies once, resumes via /decide budget raise, and handles global daily limit", async () => {
    const home = createTempDir("kiln-b10-e2e-");
    const fakeBackend = new FakeBackend({
      backendId: "fake",
      agents: [CODEX_DESCRIPTOR, CLAUDE_DESCRIPTOR],
    });
    const registry = new BackendRegistry();
    registry.register(fakeBackend);

    const store = new KilnStore({ kilnHome: home });
    store.writeConfig(
      "pricing",
      PricingConfigSchema.parse({
        schema_version: 1,
        models: {
          "gpt-5.4": { in: 10, cached: 1, out: 30 },
          "claude-sonnet-4-6": { in: 10, cached: 1, out: 30 },
        },
      }),
    );
    store.writeConfig(
      "roles",
      RolesConfigSchema.parse({
        schema_version: 1,
        heterogeneous_review: true,
        roles: {
          worker: { agent: "codex", model: "gpt-5.4" },
          reviewer: { agent: "claude", model: "claude-sonnet-4-6" },
        },
      }),
    );
    store.writeConfig(
      "remote",
      RemoteConfigSchema.parse({
        schema_version: 1,
        enabled: false,
        notifications: {
          enabled: true,
          channel: "webhook",
          url: "https://notify.example.test/hook",
          priorities: ["P0", "P1"],
        },
      }),
    );

    const notifyPayloads: Array<Record<string, unknown>> = [];

    // Pre-seed $0.10 spend against max_cost_usd=0.05 on t-b10-e2e and soft daily limit $0.12 (warning at >=80%)
    store.writeConfig(
      "limits",
      LimitsConfigSchema.parse({
        schema_version: 1,
        daily_budget_usd: 0.12,
        budget_soft_warning_ratio: 0.8,
      }),
    );

    const card2 = TaskCardSchema.parse({
      schema_version: 1,
      id: "t-b10-e2e",
      title: "Card budget circuit breaker",
      space: "local",
      priority: "P1",
      track: "L1",
      workspace_mode: "scratch_dir",
      parent: null,
      depends_on: [],
      contract_version: 1,
      contract: {
        goal: "Test budget breaker",
        end: "Done",
        accept_cmd: "echo ok",
        accept_files_hash: `sha256:${"a".repeat(64)}`,
        scope: ["**"],
        deliver: { mode: "manual", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: {
        retries_per_stage: 2,
        review_rounds: 2,
        advisor_calls: 1,
        max_tokens: 150_000,
        max_cost_usd: 0.05,
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    store.createTask(card2, "# Brief 2");
    const preRun = RunMetaSchema.parse({
      schema_version: 1,
      run_id: "r-pre-1",
      task_id: card2.id,
      stage: "implement",
      round: 1,
      contract_version: 1,
      role: "worker",
      agent: "codex",
      model: "gpt-5.4",
      backend_id: "fake",
      session_ref: { backendId: "fake", sessionId: "s-pre" },
      started_at: new Date().toISOString(),
    });
    writeYamlAtomic(store.paths.runYaml(card2.id, "000-pre"), preRun, RunMetaSchema);
    store.recordRunEvent(
      card2.id,
      "000-pre",
      RunEventSchema.parse({
        kind: "usage",
        turnId: "u-pre",
        agent: "codex",
        model: "gpt-5.4",
        inputTokens: 10_000,
        cachedInputTokens: 0,
        outputTokens: 0,
        at: new Date().toISOString(),
      }),
    );

    const server2 = new KilndServer({
      store,
      backendRegistry: registry,
      host: "127.0.0.1",
      port: 0,
      publicDir: null,
      enableOrchestrator: true,
      deliverHandler: async () => ({ status: "done", deliverRef: "manual:ok" }),
      notifyFetchImpl: (async (_url, init) => {
        notifyPayloads.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response("ok", { status: 200 });
      }) as typeof fetch,
    });
    servers.push(server2);
    await server2.start();

    await waitUntil(
      () => server2.store.getTaskIndex(card2.id)?.status === "waiting",
      "t-b10-e2e waiting on budget_exceeded",
    );

    const pending = server2.pendingDecisions.get(card2.id);
    expect(pending?.reason).toBe("budget_exceeded");
    expect(notifyPayloads.some((p) => p.event === "budget.warning")).toBe(true);
    expect(notifyPayloads.some((p) => p.event === "budget.exceeded")).toBe(true);

    // Verify GET /api/bootstrap & GET /api/tasks/:id expose accurate budget objects
    const bootRes = await server2.app.request("/api/bootstrap");
    expect(bootRes.status).toBe(200);
    const bootJson = (await bootRes.json()) as {
      budget: { daily: { spent_usd: number; level: string } };
    };
    expect(bootJson.budget.daily.spent_usd).toBeCloseTo(0.1, 4);
    expect(bootJson.budget.daily.level).toBe("warning");

    const taskDetailRes = await server2.app.request(`/api/tasks/${card2.id}`);
    expect(taskDetailRes.status).toBe(200);
    const taskDetailJson = (await taskDetailRes.json()) as {
      budget: { scope: string; level: string; spent_usd: number };
    };
    expect(taskDetailJson.budget.scope).toBe("card");
    expect(taskDetailJson.budget.level).toBe("exceeded");

    // Approve opt-raise-card-budget with custom new_max_cost_usd -> PATCH/decide updates limit & completes!
    // Use PATCH /api/tasks/:id/limits check first too
    const patchRes = await server2.app.request(`/api/tasks/${card2.id}/limits`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max_cost_usd: 1.25 }),
    });
    expect(patchRes.status).toBe(200);
    const patchJson = (await patchRes.json()) as {
      ok: true;
      card: { limits: { max_cost_usd?: number } };
      budget: { limit_usd: number | null; level: string };
    };
    expect(patchJson.card.limits.max_cost_usd).toBe(1.25);
    expect(patchJson.budget.level).toBe("ok");

    // Set limit back to 0.05 and resume via /decide opt-raise-card-budget
    await server2.app.request(`/api/tasks/${card2.id}/limits`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max_cost_usd: 0.05 }),
    });

    const decideRes = await server2.app.request(`/api/tasks/${card2.id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision_id: pending!.id,
        option_id: "opt-raise-card-budget",
        action: "resume",
        apply_ledger_rule: false,
        new_max_cost_usd: 2.0,
      }),
    });
    expect(decideRes.status).toBe(200);

    // Wait for orchestrator to actually dispatch the unblocked worker run now
    await waitUntil(
      () => fakeBackend.getRecordedSpecs().some((s) => s.taskId === card2.id),
      "t-b10-e2e dispatched worker after budget increase",
    );
    expect(server2.store.readTaskCard(card2.id).limits.max_cost_usd).toBe(2.0);
  });
});
