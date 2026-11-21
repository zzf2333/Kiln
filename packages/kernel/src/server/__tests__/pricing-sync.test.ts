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

  it("syncs strictly discovered/historical/role models via models.dev -> litellm -> builtin fallback, reuses 24h cache, and protects custom overrides", async () => {
    const kilnHome = makeTempDir();
    const server = new KilndServer({ kilnHome, port: 0 });
    servers.push(server);

    const store = server.store;
    // Register historical usage turn + role model + custom existing model
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
        worker: { agent: "codex", model: "gpt-5.4", allow_full_access_fallback: false },
      },
    });
    store.writeConfig("pricing", {
      schema_version: 1,
      models: {
        "gpt-5.4": { in: 9.9, cached: 0.9, out: 39 },
      },
      custom_models: ["gpt-5.4"],
    });

    const registry = new BackendRegistry();
    registry.register(
      new FakeBackend({
        backendId: "fake",
        models: {
          codex: [{ id: "gpt-5.4", label: "GPT-5.4", thinkingOptions: ["medium"] }],
          pi: [{ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", thinkingOptions: [] }],
        },
      }),
    );

    const fetchedUrls: string[] = [];
    let currentNow = Date.parse("2026-11-21T10:00:00.000Z");

    // 1. Primary models.dev succeeds (with thousands of unrelated models that must NOT pollute pricing.yaml)
    const r1 = await syncModelPricing({
      store,
      backendRegistry: registry,
      now: () => currentNow,
      fetchImpl: (async (url: string | URL | Request) => {
        const u = String(url);
        fetchedUrls.push(u);
        return jsonFetchRes({
          openai: {
            models: {
              "gpt-5.4": { cost: { input: 2.5, cache_read: 0.25, output: 15 } },
              "unrelated-gpt-zero": { cost: { input: 99, output: 99 } },
            },
          },
          anthropic: {
            models: {
              "claude-sonnet-4-5": { cost: { input: 3, cache_read: 0.3, output: 15 } },
              "unrelated-claude": { cost: { input: 88, output: 88 } },
            },
          },
          google: {
            models: {
              "gemini-2.5-flash": { cost: { input: 0.3, cache_read: 0.03, output: 2.5 } },
            },
          },
        });
      }) as typeof fetch,
    });

    expect(fetchedUrls).toEqual([MODELS_DEV_PRICING_URL]);
    expect(r1.source).toBe("models.dev");
    expect(r1.from_cache).toBe(false);
    expect(r1.preserved_overrides).toEqual(["gpt-5.4"]);
    expect(r1.matched_models).toEqual([
      "anthropic/claude-sonnet-4-5-20250929",
      "gemini-2.5-flash",
      "gemini-3-pro",
    ]);
    // Custom override preserved; unrelated upstream models NOT added; discovered model missing upstream uses BUILTIN_MODEL_PRICING fallback
    expect(r1.pricing.models["gpt-5.4"]).toEqual({ in: 9.9, cached: 0.9, out: 39 });
    expect(r1.pricing.models["gemini-2.5-flash"]).toEqual({ in: 0.3, cached: 0.03, out: 2.5 });
    expect(r1.pricing.models["gemini-3-pro"]).toEqual(BUILTIN_MODEL_PRICING["gemini-3-pro"]);
    expect(r1.pricing.models["anthropic/claude-sonnet-4-5-20250929"]).toEqual({
      in: 3,
      cached: 0.3,
      out: 15,
    });
    expect(r1.pricing.models["unrelated-gpt-zero"]).toBeUndefined();
    expect(r1.pricing.custom_models).toEqual(["gpt-5.4"]);
    expect(isPricingSyncStale(r1.pricing, currentNow + 60_000)).toBe(false);

    // 2. Restore custom override within 24h -> hits disk cache with zero network requests!
    currentNow += 60 * 60 * 1000;
    const r2 = await syncModelPricing({
      store,
      backendRegistry: registry,
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
      now: () => currentNow + 2_000,
      request: { force: true },
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(r4.source).toBe("builtin");
    expect(r4.warning).toContain("内置离线基线");
    expect(r4.pricing.models["gpt-5.4"]).toEqual(BUILTIN_MODEL_PRICING["gpt-5.4"]);
  });

  it("handles POST /api/settings/pricing/sync HTTP endpoint on KilndServer", async () => {
    const kilnHome = makeTempDir();
    const server = new KilndServer({
      kilnHome,
      port: 0,
      pricingFetchImpl: (async () =>
        jsonFetchRes({
          openai: {
            models: {
              "gpt-5.4": { cost: { input: 2.5, cache_read: 0.25, output: 15 } },
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
  });
});
