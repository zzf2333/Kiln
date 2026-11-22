import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeBackend, BackendRegistry } from "../../backend/index.js";
import {
  BUILTIN_MODEL_PRICING,
  KilndServer,
  LITELLM_PRICING_URL,
  MODELS_DEV_PRICING_URL,
  isPricingSyncStale,
  loadLocalAgentPricingCatalog,
  lookupModelPrice,
  parseLiteLlmCatalog,
  parseModelsDevCatalog,
  syncModelPricing,
} from "../index.js";

function jsonFetchRes(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("model pricing auto-sync (#4)", () => {
  const tempDirs: string[] = [];
  const servers: KilndServer[] = [];

  function makeTempDir(prefix = "kiln-pricing-"): string {
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

  it("parses models.dev and LiteLLM catalogs accurately and normalizes provider prefixes, date suffixes, and . vs - variants", () => {
    const modelsDevCatalog = parseModelsDevCatalog({
      openrouter: {
        models: {
          "anthropic/claude-sonnet-4-5": {
            id: "anthropic/claude-sonnet-4-5",
            cost: { input: 9.9, output: 99, cache_read: 1 },
          },
        },
      },
      anthropic: {
        models: {
          "claude-sonnet-4-5": {
            id: "claude-sonnet-4-5-20250929",
            cost: { input: 3, output: 15, cache_read: 0.3 },
          },
          "claude-opus-4-6": {
            id: "claude-opus-4-6",
            cost: { input: 5, output: 25, cache_read: 0.5 },
          },
        },
      },
      openai: {
        models: {
          "gpt-5.4": {
            id: "gpt-5.4",
            cost: { input: 2.5, output: 15, cache_read: 0.25 },
          },
          "reasoning-no-cache": {
            cost: { input: 4, output: 12 },
          },
        },
      },
    });

    // Official provider wins over proxy for bare model key
    expect(lookupModelPrice("claude-sonnet-4-5", modelsDevCatalog)).toEqual({
      in: 3,
      cached: 0.3,
      out: 15,
    });
    // Strip provider prefixes, tags, date suffixes, and dot/hyphen variants
    expect(lookupModelPrice("anthropic/claude-opus-4.6", modelsDevCatalog)).toEqual({
      in: 5,
      cached: 0.5,
      out: 25,
    });
    expect(lookupModelPrice("gpt-5.4-2026-03-01", modelsDevCatalog)).toEqual({
      in: 2.5,
      cached: 0.25,
      out: 15,
    });
    // Missing cache_read conservatively defaults to input price
    expect(lookupModelPrice("reasoning-no-cache", modelsDevCatalog)).toEqual({
      in: 4,
      cached: 4,
      out: 12,
    });

    // Effort/thinking suffixes & Antigravity aliases resolve cleanly, preferring hyphenated official keys over dot reseller variants
    const multiFamilyCatalog = parseModelsDevCatalog({
      anthropic: {
        models: {
          "claude-opus-5-5": { cost: { input: 4, cache_read: 0.2, output: 20 } },
        },
      },
      reseller: {
        models: {
          "claude-opus-5.5": { cost: { input: 1.6, cache_read: 0.2, output: 8 } },
        },
      },
      google: {
        models: {
          "gemini-4-neon": { cost: { input: 3, cache_read: 0.15, output: 15 } },
          "gemini-4-carbon": { cost: { input: 2, cache_read: 0.1, output: 10 } },
          "gemini-3.8-flash": { cost: { input: 0.75, cache_read: 0.075, output: 3.75 } },
        },
      },
      openai: {
        models: {
          "gpt-oss-120b": { cost: { input: 0.075, cache_read: 0.075, output: 0.3 } },
        },
      },
    });

    expect(lookupModelPrice("claude-opus-5-5-high", multiFamilyCatalog)).toEqual({
      in: 4,
      cached: 0.2,
      out: 20,
    });
    expect(lookupModelPrice("gemini-4-neon-high", multiFamilyCatalog)).toEqual({
      in: 3,
      cached: 0.15,
      out: 15,
    });
    expect(lookupModelPrice("gemini-4-carbon-high", multiFamilyCatalog)).toEqual({
      in: 2,
      cached: 0.1,
      out: 10,
    });
    expect(lookupModelPrice("gemini-pro-orchestrator-neon", multiFamilyCatalog)).toEqual({
      in: 3,
      cached: 0.15,
      out: 15,
    });
    expect(lookupModelPrice("gemini-3.8-flash-high", multiFamilyCatalog)).toEqual({
      in: 0.75,
      cached: 0.075,
      out: 3.75,
    });
    expect(lookupModelPrice("gpt-oss-120b-medium", multiFamilyCatalog)).toEqual({
      in: 0.075,
      cached: 0.075,
      out: 0.3,
    });

    // Reads ~/.pi/agent/models.json strictly read-only without exposing secrets
    const homeDir = makeTempDir("kiln-pi-home-");
    fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".pi", "agent", "models.json"),
      JSON.stringify({
        providers: {
          magpie: {
            apiKey: "secret-should-not-matter",
            models: [
              {
                id: "group/work",
                cost: { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
              },
              {
                id: "group/breach",
              },
            ],
          },
        },
      }),
      "utf8",
    );
    const localCat = loadLocalAgentPricingCatalog(homeDir);
    expect(lookupModelPrice("magpie/group/work", localCat)).toEqual({
      in: 2,
      cached: 0.1,
      out: 10,
    });
    expect(lookupModelPrice("magpie/group/breach", localCat)).toBeNull();

    // LiteLLM converts $/token -> $/1M tokens and ignores sample_spec
    const liteLlmCatalog = parseLiteLlmCatalog({
      sample_spec: { input_cost_per_token: 999, output_cost_per_token: 999 },
      "anthropic/claude-sonnet-4-6": {
        input_cost_per_token: 0.000003,
        cache_read_input_token_cost: 0.0000003,
        output_cost_per_token: 0.000015,
      },
      "gpt-4.1-mini": {
        input_cost_per_token: 4e-7,
        cache_read_input_token_cost: 1e-7,
        output_cost_per_token: 0.0000016,
      },
    });

    expect(liteLlmCatalog.sample_spec).toBeUndefined();
    expect(lookupModelPrice("claude-sonnet-4.6", liteLlmCatalog)).toEqual({
      in: 3,
      cached: 0.3,
      out: 15,
    });
    expect(lookupModelPrice("openai/gpt-4.1-mini-20250414", liteLlmCatalog)).toEqual({
      in: 0.4,
      cached: 0.1,
      out: 1.6,
    });
  });

  it("syncs strictly configured role, local agent, historical, and custom models, prunes unused entries, and protects custom overrides", async () => {
    const kilnHome = makeTempDir();
    const homeDir = makeTempDir("kiln-sync-home-");
    fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".pi", "agent", "models.json"),
      JSON.stringify({
        providers: {
          magpie: {
            models: [
              { id: "group/work", cost: { input: 2, cacheRead: 0.1, output: 10 } },
            ],
          },
        },
      }),
      "utf8",
    );

    const server = new KilndServer({ kilnHome, extensionsHomeDir: homeDir, port: 0 });
    servers.push(server);

    const store = server.store;
    // Register historical usage turn + multi-family role models + custom override + stale unconfigured entry
    store.sqlite.upsertUsageTurn({
      run_id: "run-hist-1",
      turn_id: "turn-hist-1",
      task_id: "t-hist",
      agent: "pi",
      model: "anthropic/claude-sonnet-4-5-20250929",
      input_tokens: 1_000,
      cached_input_tokens: 200,
      output_tokens: 500,
      recorded_at: "2026-11-21T08:00:00.000Z",
    });
    store.writeConfig("roles", {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        intake: { agent: "antigravity", model: "gemini-pro-orchestrator-neon", allow_full_access_fallback: true },
        worker: { agent: "pi", model: "magpie/group/work", allow_full_access_fallback: true },
        reviewer: { agent: "antigravity", model: "gemini-4-neon-high", allow_full_access_fallback: false },
        verifier: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
        triage: {
          agent: "antigravity",
          model: "claude-opus-5-5-high",
          fallback: { agent: "codex", model: "gpt-6.2-astra" },
          allow_full_access_fallback: false,
        },
      },
    });
    store.writeConfig("pricing", {
      schema_version: 1,
      models: {
        "gpt-5.4": { in: 9.9, cached: 0.9, out: 39 },
        "stale-unused-gpt": { in: 1, cached: 0.1, out: 5 },
      },
      custom_models: ["gpt-5.4"],
    });

    const registry = new BackendRegistry();
    registry.register(
      new FakeBackend({
        backendId: "fake",
        models: {
          codex: [
            { id: "gpt-5.4", label: "GPT-5.4", thinkingOptions: ["medium"] },
            { id: "unused-catalog-model", label: "Unused Catalog Model", thinkingOptions: [] },
          ],
          pi: [{ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", thinkingOptions: [] }],
        },
      }),
    );

    const fetchedUrls: string[] = [];
    let currentNow = Date.parse("2026-11-21T10:00:00.000Z");

    // 1. Primary models.dev succeeds (unused backend models & stale entries are NOT synced/kept)
    const r1 = await syncModelPricing({
      store,
      backendRegistry: registry,
      homeDir,
      now: () => currentNow,
      fetchImpl: (async (url: string | URL | Request) => {
        const u = String(url);
        fetchedUrls.push(u);
        return jsonFetchRes({
          openai: {
            models: {
              "gpt-5.4": { cost: { input: 2.5, cache_read: 0.25, output: 15 } },
              "gpt-6.2-astra": { cost: { input: 8, cache_read: 0.4, output: 40 } },
              "unused-catalog-model": { cost: { input: 77, output: 77 } },
              "unrelated-gpt-zero": { cost: { input: 99, output: 99 } },
            },
          },
          anthropic: {
            models: {
              "claude-sonnet-4-5": { cost: { input: 3, cache_read: 0.3, output: 15 } },
              "claude-opus-5-5": { cost: { input: 4, cache_read: 0.2, output: 20 } },
            },
          },
          google: {
            models: {
              "gemini-4-neon": { cost: { input: 3, cache_read: 0.15, output: 15 } },
            },
          },
        });
      }) as typeof fetch,
    });

    expect(fetchedUrls).toEqual([MODELS_DEV_PRICING_URL]);
    expect(r1.source).toBe("models.dev");
    expect(r1.from_cache).toBe(false);
    expect(r1.preserved_overrides).toEqual(["gpt-5.4"]);
    expect(r1.unmatched_models).toEqual([]);
    expect(Object.keys(r1.pricing.models).sort()).toEqual([
      "anthropic/claude-sonnet-4-5-20250929",
      "claude-opus-5-5-high",
      "gemini-4-neon-high",
      "gemini-pro-orchestrator-neon",
      "gpt-5.4",
      "gpt-6.2-astra",
      "magpie/group/work",
    ]);
    expect(r1.pricing.models["gpt-5.4"]).toEqual({ in: 9.9, cached: 0.9, out: 39 });
    expect(r1.pricing.models["claude-opus-5-5-high"]).toEqual({ in: 4, cached: 0.2, out: 20 });
    expect(r1.pricing.models["gemini-4-neon-high"]).toEqual({ in: 3, cached: 0.15, out: 15 });
    expect(r1.pricing.models["gemini-pro-orchestrator-neon"]).toEqual({ in: 3, cached: 0.15, out: 15 });
    expect(r1.pricing.models["magpie/group/work"]).toEqual({ in: 2, cached: 0.1, out: 10 });
    expect(r1.pricing.models["gpt-6.2-astra"]).toEqual({ in: 8, cached: 0.4, out: 40 });
    expect(r1.pricing.models["stale-unused-gpt"]).toBeUndefined();
    expect(r1.pricing.models["unused-catalog-model"]).toBeUndefined();
    expect(r1.pricing.models["gemini-2.5-flash"]).toBeUndefined();
    expect(r1.pricing.models["unrelated-gpt-zero"]).toBeUndefined();
    expect(r1.pricing.custom_models).toEqual(["gpt-5.4"]);
    expect(isPricingSyncStale(r1.pricing, currentNow + 60_000)).toBe(false);

    // 2. Restore custom override within 24h -> hits disk cache with zero network requests!
    currentNow += 60 * 60 * 1000;
    const r2 = await syncModelPricing({
      store,
      backendRegistry: registry,
      homeDir,
      now: () => currentNow,
      request: { restore_model: "gpt-5.4" },
      fetchImpl: (async () => {
        throw new Error("network should not be called while cache is fresh");
      }) as unknown as typeof fetch,
    });
    expect(r2.from_cache).toBe(true);
    expect(r2.pricing.custom_models).toBeUndefined();
    expect(r2.pricing.models["gpt-5.4"]).toEqual({ in: 2.5, cached: 0.25, out: 15 });

    // 3. Force sync when models.dev fails -> transparently falls back to LiteLLM
    const fallbackCalls: string[] = [];
    const r3 = await syncModelPricing({
      store,
      backendRegistry: registry,
      homeDir,
      now: () => currentNow + 1_000,
      request: { force: true },
      fetchImpl: (async (url: string | URL | Request) => {
        const u = String(url);
        fallbackCalls.push(u);
        if (u === MODELS_DEV_PRICING_URL) {
          return jsonFetchRes({ error: "upstream down" }, 503);
        }
        return jsonFetchRes({
          "gpt-5.4": {
            input_cost_per_token: 0.000002,
            cache_read_input_token_cost: 0.0000002,
            output_cost_per_token: 0.000012,
          },
        });
      }) as typeof fetch,
    });
    expect(fallbackCalls).toEqual([MODELS_DEV_PRICING_URL, LITELLM_PRICING_URL]);
    expect(r3.source).toBe("litellm");
    expect(r3.from_cache).toBe(false);
    expect(r3.pricing.models["gpt-5.4"]).toEqual({ in: 2, cached: 0.2, out: 12 });

    // 4. Both remote sources fail with force: true -> falls back cleanly to built-in offline baseline + warning
    const r4 = await syncModelPricing({
      store,
      backendRegistry: registry,
      homeDir,
      now: () => currentNow + 2_000,
      request: { force: true },
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(r4.source).toBe("builtin");
    expect(r4.warning).toContain("内置离线基线");
    expect(r4.pricing.models["gpt-5.4"]).toEqual(BUILTIN_MODEL_PRICING["gpt-5.4"]);
    expect(r4.pricing.models["claude-opus-5-5-high"]).toEqual(BUILTIN_MODEL_PRICING["claude-opus-5-5"]);
    expect(r4.pricing.models["gemini-pro-orchestrator-neon"]).toEqual(BUILTIN_MODEL_PRICING["gemini-4-neon"]);
  });

  it("handles POST /api/settings/pricing/sync HTTP endpoint and auto-syncs on PUT /api/settings/roles when cache exists", async () => {
    const kilnHome = makeTempDir();
    const homeDir = makeTempDir("kiln-http-home-");
    const server = new KilndServer({
      kilnHome,
      extensionsHomeDir: homeDir,
      port: 0,
      pricingFetchImpl: (async () =>
        jsonFetchRes({
          openai: {
            models: {
              "gpt-5.4": { cost: { input: 2.5, cache_read: 0.25, output: 15 } },
            },
          },
          anthropic: {
            models: {
              "claude-opus-5-5": { cost: { input: 4, cache_read: 0.2, output: 20 } },
            },
          },
        })) as typeof fetch,
    });
    servers.push(server);

    server.store.writeConfig("roles", {
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        worker: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
      },
    });

    const syncRes = await server.app.request("http://127.0.0.1:4310/api/settings/pricing/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    expect(syncRes.status).toBe(200);
    const body = (await syncRes.json()) as {
      ok: boolean;
      source: string;
      pricing: { models: Record<string, unknown> };
    };
    expect(body.ok).toBe(true);
    expect(body.source).toBe("models.dev");
    expect(body.pricing.models["gpt-5.4"]).toEqual({ in: 2.5, cached: 0.25, out: 15 });

    // Saving roles with a newly selected model automatically refreshes pricing from the local cache
    const updateRolesRes = await server.app.request("http://127.0.0.1:4310/api/settings/roles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        heterogeneous_review: true,
        roles: {
          worker: { agent: "antigravity", model: "claude-opus-5-5-high", allow_full_access_fallback: false },
        },
      }),
    });
    expect(updateRolesRes.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    const refreshedPricing = server.store.readConfig("pricing");
    expect(refreshedPricing?.models["claude-opus-5-5-high"]).toEqual({ in: 4, cached: 0.2, out: 20 });
    expect(refreshedPricing?.models["gpt-5.4"]).toBeUndefined();
  });
});
