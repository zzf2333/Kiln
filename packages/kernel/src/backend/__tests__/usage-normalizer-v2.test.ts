import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_USAGE_RULES,
  ProviderHealthTracker,
  accumulateMessageUsage,
  createContextWindowEvent,
  createProviderUsageNormalizerState,
  flushAccumulatedTurnUsage,
  normalizeProviderTurnUsage,
} from "../index.js";
import { computeUsageSnapshot, syncModelPricing } from "../../server/index.js";
import { KilnSqliteIndex, KilnStore, openSqliteDatabase } from "../../store/index.js";

describe("v0.0.5 usage normalizer V2, SQLite migration, provider health, and 5-field pricing sync", () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix = "kiln-s4a-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("normalizes P1 Codex cumulative_thread deltas and context_window telemetry accurately", () => {
    const state = createProviderUsageNormalizerState();
    const rule = DEFAULT_PROVIDER_USAGE_RULES.codex!;

    const turn1 = normalizeProviderTurnUsage({
      provider: "codex",
      model: "gpt-5.4",
      agentId: "agent-codex-1",
      raw: {
        inputTokens: 120_878,
        cachedReadTokens: 97_024,
        cacheWriteTokens: 0,
        outputTokens: 165,
        reasoningTokens: 0,
        costSource: "catalog",
      },
      rule,
      state,
      candidateTurnIds: ["turn-c-1"],
    });
    expect(turn1).toMatchObject({
      turnId: "turn-c-1",
      inputTokens: 120_878,
      cachedInputTokens: 97_024,
      uncachedInputTokens: 23_854,
      cacheReadTokens: 97_024,
      cacheWriteTokens: 0,
      outputTokens: 165,
      reasoningTokens: 0,
      reasoningIncludedInOutput: true,
      costSource: "catalog",
    });

    const turn2 = normalizeProviderTurnUsage({
      provider: "codex",
      model: "gpt-5.4",
      agentId: "agent-codex-1",
      raw: {
        inputTokens: 151_308,
        cachedReadTokens: 127_104,
        cacheWriteTokens: 0,
        outputTokens: 215,
        reasoningTokens: 20,
      },
      rule,
      state,
      candidateTurnIds: ["turn-c-2"],
    });
    expect(turn2).toMatchObject({
      turnId: "turn-c-2",
      inputTokens: 30_430,
      cachedInputTokens: 30_080,
      uncachedInputTokens: 350,
      cacheReadTokens: 30_080,
      outputTokens: 50,
      reasoningTokens: 20,
    });

    // Rejects decreasing cumulative counters
    expect(() =>
      normalizeProviderTurnUsage({
        provider: "codex",
        model: "gpt-5.4",
        agentId: "agent-codex-1",
        raw: { inputTokens: 100, cachedReadTokens: 0, outputTokens: 10 },
        rule,
        state,
      }),
    ).toThrow(RangeError);

    const ctxEv = createContextWindowEvent(30_430, 258_400, "2026-11-23T02:00:00.000Z");
    expect(ctxEv).toEqual({
      kind: "context_window",
      at: "2026-11-23T02:00:00.000Z",
      usedTokens: 30_430,
      contextWindowTokens: 258_400,
      percent: 11.78,
    });
  });

  it("accumulates P2 Pi per_message deltas within one turn and handles P3 agy acp uncached input", () => {
    // P2: Pi --mode rpc sends multiple per-message non-cumulative assistant usages per turn
    const piState = createProviderUsageNormalizerState();
    const piRule = DEFAULT_PROVIDER_USAGE_RULES.pi!;
    accumulateMessageUsage(piState, {
      inputTokens: 168,
      cachedReadTokens: 9_216,
      cacheWriteTokens: 1_000,
      outputTokens: 25,
      reasoningTokens: 18,
      providerCostUsd: 0.004,
      costSource: "catalog",
    });
    accumulateMessageUsage(piState, {
      inputTokens: 42,
      cachedReadTokens: 1_000,
      cacheWriteTokens: 0,
      outputTokens: 15,
      reasoningTokens: 5,
      providerCostUsd: 0.001,
    });
    const piTurn = flushAccumulatedTurnUsage(piState, {
      provider: "pi",
      model: "magpie/group/work",
      agentId: "agent-pi-1",
      rule: piRule,
      candidateTurnIds: ["turn-pi-1"],
    });
    expect(piTurn).toMatchObject({
      turnId: "turn-pi-1",
      uncachedInputTokens: 210,
      cacheReadTokens: 10_216,
      inputTokens: 10_426,
      cachedInputTokens: 10_216,
      cacheWriteTokens: 1_000,
      outputTokens: 40,
      reasoningTokens: 23,
      reasoningIncludedInOutput: true,
      providerCostUsd: 0.005,
    });
    // Subsequent flush with no new messages returns null
    expect(
      flushAccumulatedTurnUsage(piState, {
        provider: "pi",
        model: "magpie/group/work",
        agentId: "agent-pi-1",
        rule: piRule,
      }),
    ).toBeNull();

    // P3: agy acp PromptResponse.usage where inputTokens < cachedReadTokens (already uncached)
    const agyState = createProviderUsageNormalizerState();
    const agyTurn = normalizeProviderTurnUsage({
      provider: "agy",
      model: "claude-sonnet-4-6",
      agentId: "agent-agy-1",
      raw: {
        inputTokens: 20_335,
        cachedReadTokens: 27_184,
        cacheWriteTokens: 5_000,
        outputTokens: 3_900,
        reasoningTokens: 3_766,
      },
      rule: DEFAULT_PROVIDER_USAGE_RULES.agy!,
      state: agyState,
      candidateTurnIds: ["turn-agy-1"],
    });
    expect(agyTurn).toMatchObject({
      turnId: "turn-agy-1",
      uncachedInputTokens: 20_335,
      cacheReadTokens: 27_184,
      inputTokens: 47_519,
      cachedInputTokens: 27_184,
      cacheWriteTokens: 5_000,
      outputTokens: 3_900,
      reasoningTokens: 3_766,
    });
  });

  it("migrates legacy V1 usage_turns SQLite tables in-place and preserves V2 columns on rebuild", () => {
    const home = makeTempDir("kiln-migrate-");
    const dbPath = path.join(home, "index.sqlite");

    // Seed old 9-column usage_turns schema
    const legacyDb = openSqliteDatabase(dbPath);
    legacyDb.exec(`
      CREATE TABLE tasks_index (
        id TEXT PRIMARY KEY,
        space TEXT NOT NULL,
        parent_id TEXT,
        title TEXT NOT NULL,
        priority TEXT NOT NULL,
        effective_priority TEXT NOT NULL,
        track TEXT NOT NULL,
        workspace_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        contract_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE usage_turns (
        run_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (run_id, turn_id)
      );
      INSERT INTO usage_turns VALUES (
        'run-legacy', 'turn-1', 't-legacy', 'codex', 'gpt-5.4', 1000, 400, 100, '2026-11-22T00:00:00.000Z'
      );
    `);
    legacyDb.close();

    // Open via KilnSqliteIndex -> auto-migrates missing V2 columns cleanly
    const migrated = new KilnSqliteIndex(dbPath);
    try {
      migrated.upsertUsageTurn({
        run_id: "run-v2",
        turn_id: "turn-2",
        task_id: "t-legacy",
        agent: "agy",
        model: "claude-sonnet-4-6",
        input_tokens: 15_000,
        cached_input_tokens: 10_000,
        output_tokens: 500,
        cache_write_tokens: 5_000,
        reasoning_tokens: 200,
        provider_cost_usd: 0.042,
        cost_source: "catalog",
        recorded_at: "2026-11-23T02:00:00.000Z",
      });
      const rows = migrated.listUsageTurns({ taskId: "t-legacy" });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        run_id: "run-legacy",
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        provider_cost_usd: null,
        cost_source: null,
      });
      expect(rows[1]).toMatchObject({
        run_id: "run-v2",
        cache_write_tokens: 5_000,
        reasoning_tokens: 200,
        provider_cost_usd: 0.042,
        cost_source: "catalog",
      });
      // getTaskTotalTokens preserves exact 4-key return contract
      expect(migrated.getTaskTotalTokens("t-legacy")).toEqual({
        input_tokens: 16_000,
        cached_input_tokens: 10_400,
        output_tokens: 600,
        total_tokens: 16_600,
      });
    } finally {
      migrated.close();
    }

    // Store readEffectiveProvidersConfig & readEffectiveRosterConfig auto-migrate roles.yaml
    const store = new KilnStore({ kilnHome: home });
    try {
      expect(store.readEffectiveProvidersConfig().providers.map((p) => p.id)).toContain("agy");
      store.writeConfig("roles", {
        schema_version: 1,
        heterogeneous_review: true,
        roles: {
          worker: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
        },
      });
      const roster = store.readEffectiveRosterConfig();
      expect(roster.schema_version).toBe(2);
      expect(roster.roster.main_dev?.enabled).toBe(true);
      expect(roster.roster.main_dev?.primary?.model).toBe("gpt-5.4");
    } finally {
      store.close();
    }
  });

  it("computes V2 orthogonal snapshot savings, honors provider_cost_usd, and tracks 3-tier provider health", async () => {
    const pricing = {
      schema_version: 1 as const,
      models: {
        "claude-sonnet-4-6": { in: 3, cached: 0.3, cache_write: 3.75, out: 15, context_window: 1_000_000 },
      },
    };
    const snapshot = computeUsageSnapshot(
      [
        {
          run_id: "r1",
          turn_id: "t1",
          task_id: "task-1",
          agent: "claude",
          model: "claude-sonnet-4-6",
          input_tokens: 102_000,
          cached_input_tokens: 100_000,
          output_tokens: 1_000,
          cache_write_tokens: 5_000,
          reasoning_tokens: 400,
          recorded_at: "2026-11-23T02:00:00.000Z",
        },
        {
          run_id: "r2",
          turn_id: "t2",
          task_id: "task-1",
          agent: "pi",
          model: "custom-proxy/reported-only",
          input_tokens: 1_000,
          cached_input_tokens: 0,
          output_tokens: 200,
          provider_cost_usd: 0.015,
          cost_source: "provider_reported",
          recorded_at: "2026-11-23T02:01:00.000Z",
        },
        {
          run_id: "r3",
          turn_id: "t3",
          task_id: "task-1",
          agent: "agy",
          model: "unknown-private-model",
          input_tokens: 500,
          cached_input_tokens: 0,
          output_tokens: 100,
          recorded_at: "2026-11-23T02:02:00.000Z",
        },
      ],
      pricing,
    );

    expect(snapshot.cacheWriteTokens).toBe(5_000);
    expect(snapshot.reasoningTokens).toBe(400);
    expect(snapshot.costUsd).toBeCloseTo(0.06975 + 0.015, 8);
    expect(snapshot.cacheNetSavedUsd).toBeCloseTo(0.26625, 8);
    expect(snapshot.unknownPricingModels).toEqual(["unknown-private-model"]);

    const health = new ProviderHealthTracker();
    const nowMs = Date.parse("2026-11-23T02:00:00.000Z");
    const until = health.recordRateLimit("codex", { retryAfterSec: 120, nowMs, detail: "HTTP 429" });
    expect(until).toBe("2026-11-23T02:02:00.000Z");
    expect(health.isInCooldown("codex", nowMs + 60_000)).toBe(true);
    expect(health.isInCooldown("codex", nowMs + 120_000)).toBe(false);

    health.setNativeQuota("codex", { source: "codex", used_percent: 14, window_duration_mins: 10080 });
    const home = makeTempDir("kiln-health-");
    const store = new KilnStore({ kilnHome: home });
    try {
      const providers = store.readEffectiveProvidersConfig().providers;
      const codexEntry = providers.find((p) => p.id === "codex")!;
      const piEntry = providers.find((p) => p.id === "pi")!;
      const piStatus = health.buildRuntimeStatus(
        piEntry,
        [
          {
            run_id: "r2",
            turn_id: "t2",
            task_id: "task-1",
            agent: "pi",
            model: "custom-proxy/reported-only",
            input_tokens: 1_000,
            cached_input_tokens: 0,
            output_tokens: 200,
            provider_cost_usd: 0.015,
            recorded_at: "2026-11-23T02:01:00.000Z",
          },
        ],
        pricing,
        nowMs + 130_000,
      );
      expect(piStatus.native_quota).toBeNull();
      expect(piStatus.local_window_tokens).toBe(1_200);
      expect(piStatus.local_window_cost_usd).toBeCloseTo(0.015, 8);

      const codexStatus = health.buildRuntimeStatus(codexEntry, [], pricing, nowMs + 130_000);
      expect(codexStatus.status).toBe("ready");
      expect(codexStatus.native_quota?.used_percent).toBe(14);
    } finally {
      store.close();
    }

    // 5-field syncModelPricing scans roster.yaml + providers.yaml custom_models
    const syncHome = makeTempDir("kiln-sync5-");
    const fakeHome = makeTempDir("kiln-fakehome-");
    const piDir = path.join(fakeHome, ".pi", "agent");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(
      path.join(piDir, "models.json"),
      JSON.stringify({
        providers: {
          magpie: {
            models: [
              {
                id: "group/work",
                contextWindow: 200_000,
                cost: { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
              },
            ],
          },
        },
      }),
      "utf8",
    );
    const syncStore = new KilnStore({ kilnHome: syncHome });
    try {
      const rosterCfg = syncStore.readEffectiveRosterConfig();
      rosterCfg.roster.architect = {
        ...rosterCfg.roster.architect!,
        enabled: true,
        primary: { provider: "claude", model: "claude-sonnet-4-6" },
        fallbacks: [{ provider: "pi", model: "magpie/group/work" }],
      };
      syncStore.writeConfig("roster", rosterCfg);
      const provCfg = syncStore.readEffectiveProvidersConfig();
      provCfg.providers[0]!.custom_models = ["custom-proxy-m1"];
      syncStore.writeConfig("providers", provCfg);

      const res = await syncModelPricing({
        store: syncStore,
        homeDir: fakeHome,
        request: { force: true },
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              anthropic: {
                models: {
                  "claude-sonnet-4-6": {
                    id: "claude-sonnet-4-6",
                    cost: { input: 3, cache_read: 0.3, cache_write: 3.75, output: 15 },
                    limit: { context: 1_000_000 },
                  },
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )) as unknown as typeof fetch,
      });

      expect(res.pricing.models["claude-sonnet-4-6"]).toEqual({
        in: 3,
        cached: 0.3,
        cache_write: 3.75,
        out: 15,
        context_window: 1_000_000,
      });
      expect(res.pricing.models["magpie/group/work"]).toEqual({
        in: 2,
        cached: 0.1,
        cache_write: 2.5,
        out: 10,
        context_window: 200_000,
      });
      expect(res.unmatched_models).toContain("custom-proxy-m1");
    } finally {
      syncStore.close();
    }
  });
});
