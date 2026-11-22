import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  ModelPricingSchema,
  PricingConfigSchema,
  PricingSyncSourceSchema,
  SyncPricingResponseSchema,
  type ModelPricing,
  type PricingConfig,
  type PricingSyncSource,
  type SyncPricingRequest,
  type SyncPricingResponse,
} from "@kiln/protocol";
import type { BackendRegistry } from "../backend/index.js";
import { KilnStore, writeFileAtomic } from "../store/index.js";
import { readOptionalText } from "./pending-decisions.js";

export const MODELS_DEV_PRICING_URL = "https://models.dev/api.json";
export const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const DEFAULT_PRICING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PRICING_FETCH_TIMEOUT_MS = 6_000;

/**
 * Curated offline baseline (USD per 1M tokens) used only when remote pricing catalogs are
 * unreachable or missing a specific model. Kept strictly in kernel (never bundled to web).
 */
export const BUILTIN_MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-6.2-sol": { in: 2, cached: 0.1, out: 10 },
  "gpt-6.2-astra": { in: 8, cached: 0.4, out: 40 },
  "gpt-6.1-sol": { in: 2, cached: 0.1, out: 10 },
  "gpt-6.1-terra": { in: 1, cached: 0.05, out: 5 },
  "gpt-6-sol": { in: 2, cached: 0.2, out: 10 },
  "gpt-6-astra": { in: 10, cached: 1, out: 50 },
  "gpt-6-luna": { in: 0.1, cached: 0.01, out: 0.5 },
  "gpt-5.6-sol": { in: 4, cached: 0.4, out: 20 },
  "gpt-5.6-terra": { in: 2, cached: 0.2, out: 12 },
  "gpt-5.6-luna": { in: 0.2, cached: 0.02, out: 1.2 },
  "gpt-5.4": { in: 2.5, cached: 0.25, out: 15 },
  "gpt-5.4-mini": { in: 0.75, cached: 0.075, out: 4.5 },
  "gpt-5.4-nano": { in: 0.2, cached: 0.02, out: 1.25 },
  "gpt-5.3-codex": { in: 1.75, cached: 0.175, out: 14 },
  "gpt-5.2-codex": { in: 1.75, cached: 0.175, out: 14 },
  "gpt-5.2": { in: 1.75, cached: 0.175, out: 14 },
  "gpt-5.1-codex": { in: 1.25, cached: 0.125, out: 10 },
  "gpt-5.1": { in: 1.25, cached: 0.125, out: 10 },
  "gpt-5": { in: 1.25, cached: 0.125, out: 10 },
  "gpt-5-mini": { in: 0.25, cached: 0.025, out: 2 },
  "gpt-5-nano": { in: 0.05, cached: 0.005, out: 0.4 },
  "gpt-4.1": { in: 2, cached: 0.5, out: 8 },
  "gpt-4.1-mini": { in: 0.4, cached: 0.1, out: 1.6 },
  "gpt-4.1-nano": { in: 0.1, cached: 0.025, out: 0.4 },
  "gpt-4o": { in: 2.5, cached: 1.25, out: 10 },
  "gpt-4o-mini": { in: 0.15, cached: 0.075, out: 0.6 },
  "gpt-oss-120b": { in: 0.075, cached: 0.075, out: 0.3 },
  "gpt-oss-20b": { in: 0.045, cached: 0.045, out: 0.167 },
  o3: { in: 2, cached: 0.5, out: 8 },
  "o3-mini": { in: 1.1, cached: 0.55, out: 4.4 },
  "o4-mini": { in: 1.1, cached: 0.275, out: 4.4 },
  "claude-opus-5-5": { in: 4, cached: 0.2, out: 20 },
  "claude-opus-5": { in: 5, cached: 0.5, out: 25 },
  "claude-opus-4-8": { in: 5, cached: 0.5, out: 25 },
  "claude-opus-4-7": { in: 5, cached: 0.5, out: 25 },
  "claude-opus-4-6": { in: 5, cached: 0.5, out: 25 },
  "claude-opus-4-5": { in: 5, cached: 0.5, out: 25 },
  "claude-opus-4-1": { in: 15, cached: 1.5, out: 75 },
  "claude-opus-4": { in: 15, cached: 1.5, out: 75 },
  "claude-sonnet-5-5": { in: 2, cached: 0.1, out: 10 },
  "claude-sonnet-5": { in: 2, cached: 0.2, out: 10 },
  "claude-sonnet-4-6": { in: 3, cached: 0.3, out: 15 },
  "claude-sonnet-4-5": { in: 3, cached: 0.3, out: 15 },
  "claude-sonnet-4": { in: 3, cached: 0.3, out: 15 },
  "claude-3-7-sonnet": { in: 3, cached: 0.3, out: 15 },
  "claude-haiku-5-5": { in: 0.1, cached: 0.01, out: 0.5 },
  "claude-haiku-4-5": { in: 1, cached: 0.1, out: 5 },
  "claude-3-5-haiku": { in: 0.8, cached: 0.08, out: 4 },
  "gemini-4-neon": { in: 3, cached: 0.15, out: 15 },
  "gemini-4-carbon": { in: 2, cached: 0.1, out: 10 },
  "gemini-4-argon": { in: 2, cached: 0.1, out: 10 },
  "gemini-4-hydrogen": { in: 1.5, cached: 0.075, out: 7.5 },
  "gemini-3.8-flash": { in: 0.75, cached: 0.075, out: 3.75 },
  "gemini-3.1-pro": { in: 2, cached: 0.2, out: 12 },
  "gemini-3.1-flash-lite": { in: 0.25, cached: 0.025, out: 1.5 },
  "gemini-3-pro": { in: 2, cached: 0.2, out: 12 },
  "gemini-3-flash": { in: 0.5, cached: 0.05, out: 3 },
  "gemini-2.5-pro": { in: 1.25, cached: 0.125, out: 10 },
  "gemini-2.5-flash": { in: 0.3, cached: 0.03, out: 2.5 },
  "gemini-2.5-flash-lite": { in: 0.1, cached: 0.01, out: 0.4 },
  "deepseek-v3.2": { in: 0.29, cached: 0.29, out: 0.43 },
  "deepseek-chat": { in: 0.28, cached: 0.028, out: 0.42 },
  "deepseek-reasoner": { in: 0.55, cached: 0.14, out: 2.19 },
  "deepseek-v3": { in: 0.28, cached: 0.028, out: 0.42 },
  "deepseek-r1": { in: 0.55, cached: 0.14, out: 2.19 },
  "grok-4": { in: 3, cached: 0.75, out: 15 },
  "grok-3": { in: 3, cached: 0.75, out: 15 },
  "qwen3.8-max": { in: 2, cached: 0.25, out: 6 },
  "qwen3-coder-plus": { in: 1, cached: 0.2, out: 5 },
  "qwen3-max": { in: 1.2, cached: 0.24, out: 6 },
  "kimi-k2.5": { in: 0.627, cached: 0.627, out: 3.3 },
  "glm-5": { in: 0.6, cached: 0.6, out: 2.6 },
  "minimax-m2.5": { in: 0.3, cached: 0.3, out: 1.2 },
};

const OFFICIAL_PROVIDER_PRIORITY = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "xai",
  "mistral",
  "alibaba",
  "qwen",
  "zhipuai",
  "zai",
  "moonshotai",
  "minimax",
] as const;

const PricingCatalogCacheSchema = z.object({
  schema_version: z.literal(1),
  source: PricingSyncSourceSchema,
  fetched_at: z.string().min(1),
  fetched_at_ms: z.number().finite().nonnegative(),
  catalog: z.record(z.string().min(1), ModelPricingSchema),
});

function roundPricePerMillion(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function storeCatalogEntry(
  catalog: Record<string, ModelPricing>,
  rawKey: string,
  pricing: ModelPricing,
  overwriteBare: boolean,
): void {
  const key = rawKey.trim().toLowerCase();
  if (!key) return;
  if (overwriteBare || catalog[key] === undefined) {
    catalog[key] = pricing;
  }
}

/**
 * Parses `https://models.dev/api.json` where prices are already USD per 1M tokens.
 * Prioritizes official vendor providers over proxy aggregators when populating bare model keys.
 */
export function parseModelsDevCatalog(raw: unknown): Record<string, ModelPricing> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const providers = raw as Record<string, unknown>;
  const providerEntries = Object.entries(providers).sort(([a], [b]) => {
    const rankA = OFFICIAL_PROVIDER_PRIORITY.indexOf(
      a.toLowerCase() as (typeof OFFICIAL_PROVIDER_PRIORITY)[number],
    );
    const rankB = OFFICIAL_PROVIDER_PRIORITY.indexOf(
      b.toLowerCase() as (typeof OFFICIAL_PROVIDER_PRIORITY)[number],
    );
    const effA = rankA === -1 ? Number.MAX_SAFE_INTEGER : rankA;
    const effB = rankB === -1 ? Number.MAX_SAFE_INTEGER : rankB;
    if (effA !== effB) return effA - effB;
    return a.localeCompare(b);
  });

  const catalog: Record<string, ModelPricing> = {};
  for (const [providerId, providerVal] of providerEntries) {
    if (!providerVal || typeof providerVal !== "object") continue;
    const modelsObj = (providerVal as { models?: unknown }).models;
    if (!modelsObj || typeof modelsObj !== "object" || Array.isArray(modelsObj)) continue;

    const isOfficial = OFFICIAL_PROVIDER_PRIORITY.includes(
      providerId.toLowerCase() as (typeof OFFICIAL_PROVIDER_PRIORITY)[number],
    );

    for (const [modelKey, modelVal] of Object.entries(modelsObj as Record<string, unknown>)) {
      if (!modelVal || typeof modelVal !== "object") continue;
      const cost = (modelVal as { cost?: unknown }).cost;
      if (!cost || typeof cost !== "object") continue;

      const c = cost as Record<string, unknown>;
      if (!isNonNegativeFinite(c.input) || !isNonNegativeFinite(c.output)) continue;
      const cached = isNonNegativeFinite(c.cache_read) ? c.cache_read : c.input;
      const pricing: ModelPricing = {
        in: roundPricePerMillion(c.input),
        cached: roundPricePerMillion(cached),
        out: roundPricePerMillion(c.output),
      };

      const explicitId =
        typeof (modelVal as { id?: unknown }).id === "string"
          ? (modelVal as { id: string }).id.trim()
          : modelKey.trim();

      if (explicitId) {
        storeCatalogEntry(catalog, `${providerId}/${explicitId}`, pricing, true);
        storeCatalogEntry(catalog, explicitId, pricing, isOfficial && catalog[explicitId.toLowerCase()] === undefined);
      }
      storeCatalogEntry(catalog, `${providerId}/${modelKey}`, pricing, true);
      storeCatalogEntry(catalog, modelKey, pricing, false);
    }
  }

  return catalog;
}

/**
 * Parses LiteLLM `model_prices_and_context_window.json`, converting per-token USD prices
 * (`input_cost_per_token`, `cache_read_input_token_cost`, `output_cost_per_token`) into $/1M tokens.
 */
export function parseLiteLlmCatalog(raw: unknown): Record<string, ModelPricing> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const entries = Object.entries(raw as Record<string, unknown>).sort(([a], [b]) => {
    const hasSlashA = a.includes("/") ? 1 : 0;
    const hasSlashB = b.includes("/") ? 1 : 0;
    if (hasSlashA !== hasSlashB) return hasSlashA - hasSlashB;
    return a.localeCompare(b);
  });

  const catalog: Record<string, ModelPricing> = {};
  for (const [rawKey, entryVal] of entries) {
    if (rawKey === "sample_spec" || !entryVal || typeof entryVal !== "object") continue;
    const entry = entryVal as Record<string, unknown>;
    if (!isNonNegativeFinite(entry.input_cost_per_token) || !isNonNegativeFinite(entry.output_cost_per_token)) {
      continue;
    }
    const rawCache = isNonNegativeFinite(entry.cache_read_input_token_cost)
      ? entry.cache_read_input_token_cost
      : entry.input_cost_per_token;

    const pricing: ModelPricing = {
      in: roundPricePerMillion(entry.input_cost_per_token * 1_000_000),
      cached: roundPricePerMillion(rawCache * 1_000_000),
      out: roundPricePerMillion(entry.output_cost_per_token * 1_000_000),
    };

    storeCatalogEntry(catalog, rawKey, pricing, true);
    const slashIdx = rawKey.lastIndexOf("/");
    if (slashIdx >= 0 && slashIdx + 1 < rawKey.length) {
      const bare = rawKey.slice(slashIdx + 1);
      storeCatalogEntry(catalog, bare, pricing, false);
    }
  }

  return catalog;
}

const TRAILING_VARIANT_SUFFIX_RE =
  /-(?:20\d{2}-\d{2}-\d{2}|20\d{6}|exp-\d{4}|preview-\d{2}-\d{2}|latest|xhigh|high|medium|med|low|minimal|max|thinking|reasoning|think|nothinking|nothink)$/i;

function buildLookupCandidates(rawModelId: string): string[] {
  const seen = new Set<string>();
  const primary: string[] = [];
  const pushPrimary = (val: string): void => {
    const cleaned = val.trim().toLowerCase();
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      primary.push(cleaned);
    }
  };

  pushPrimary(rawModelId);

  // Strip tag/version suffixes such as :free or @2025...
  const withoutTag = rawModelId.replace(/[:@][^/@:]+$/, "");
  pushPrimary(withoutTag);

  // Generate path segments by progressively stripping leading provider prefixes
  const bareNames: string[] = [];
  for (const seed of [rawModelId, withoutTag]) {
    let cursor = seed.trim();
    bareNames.push(cursor);
    while (cursor.includes("/")) {
      const idx = cursor.indexOf("/");
      cursor = cursor.slice(idx + 1);
      pushPrimary(cursor);
      bareNames.push(cursor);
    }
  }

  // Iteratively strip trailing date / preview / latest / effort / thinking suffixes (max 2 passes),
  // trying unmodified hyphen/dot forms first before applying Antigravity aliases.
  const strippedForms: string[] = [];
  for (const base of bareNames) {
    let cur = base.trim();
    for (let pass = 0; pass < 2; pass += 1) {
      const next = cur.replace(TRAILING_VARIANT_SUFFIX_RE, "");
      if (next === cur || !next) break;
      pushPrimary(next);
      strippedForms.push(next);
      cur = next;
    }
  }

  // Antigravity orchestrator aliases map to upstream Gemini tiers
  for (const form of [...bareNames, ...strippedForms]) {
    const trimmedLower = form.trim().toLowerCase();
    if (trimmedLower === "gemini-pro-orchestrator") {
      pushPrimary("gemini-4-neon");
      pushPrimary("gemini-3.1-pro");
      pushPrimary("gemini-3-pro");
      continue;
    }
    const orchMatch = /^gemini-pro-orchestrator-([a-z0-9-]+)$/i.exec(trimmedLower);
    if (orchMatch?.[1]) {
      pushPrimary(`gemini-4-${orchMatch[1]}`);
    }
  }

  // Keep `.` <-> `-` swaps strictly after unmodified candidates so hyphenated official IDs
  // (e.g., `claude-opus-5-5`) always win over reseller dot variants (`claude-opus-5.5`).
  const candidates = [...primary];
  for (const base of primary) {
    for (const swapped of [
      base.replace(/(\d)\.(\d)/g, "$1-$2"),
      base.replace(/(\d)-(\d)/g, "$1.$2"),
    ]) {
      if (swapped && !seen.has(swapped)) {
        seen.add(swapped);
        candidates.push(swapped);
      }
    }
  }

  return candidates;
}

/**
 * Resolves pricing for `modelId` using:
 * exact match -> strip `provider/` prefix -> strip date/effort suffix -> aliases -> `.` <-> `-` normalization.
 */
export function lookupModelPrice(
  modelId: string,
  catalog: Record<string, ModelPricing>,
): ModelPricing | null {
  const direct = catalog[modelId];
  if (direct) {
    return { ...direct };
  }
  for (const candidate of buildLookupCandidates(modelId)) {
    const matched = catalog[candidate];
    if (matched) {
      return { ...matched };
    }
  }
  return null;
}

/**
 * Reads local custom routing model prices from `~/.pi/agent/models.json` strictly read-only
 * (never inspecting or exposing API keys, base URLs, or headers).
 */
export function loadLocalAgentPricingCatalog(homeDir = os.homedir()): Record<string, ModelPricing> {
  const piModelsPath = path.join(homeDir, ".pi", "agent", "models.json");
  const raw = readOptionalText(piModelsPath);
  if (raw === null) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const providers = (parsed as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return {};
  }

  const catalog: Record<string, ModelPricing> = {};
  for (const [providerId, providerVal] of Object.entries(providers as Record<string, unknown>)) {
    if (!providerVal || typeof providerVal !== "object" || Array.isArray(providerVal)) continue;
    const models = (providerVal as { models?: unknown }).models;
    if (!Array.isArray(models)) continue;

    for (const modelVal of models) {
      if (!modelVal || typeof modelVal !== "object" || Array.isArray(modelVal)) continue;
      const rec = modelVal as { id?: unknown; cost?: unknown };
      const rawId = typeof rec.id === "string" ? rec.id.trim() : "";
      if (!rawId) continue;
      const cost = rec.cost;
      if (!cost || typeof cost !== "object" || Array.isArray(cost)) continue;
      const c = cost as Record<string, unknown>;
      if (!isNonNegativeFinite(c.input) || !isNonNegativeFinite(c.output)) continue;

      const cached = isNonNegativeFinite(c.cacheRead)
        ? c.cacheRead
        : isNonNegativeFinite(c.cache_read)
          ? c.cache_read
          : c.input;
      const pricing: ModelPricing = {
        in: roundPricePerMillion(c.input),
        cached: roundPricePerMillion(cached),
        out: roundPricePerMillion(c.output),
      };

      storeCatalogEntry(catalog, `${providerId}/${rawId}`, pricing, true);
      storeCatalogEntry(catalog, rawId, pricing, false);
    }
  }

  return catalog;
}

async function fetchJsonReadOnly(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function readFreshDiskCache(
  cachePath: string,
  nowMs: number,
  ttlMs: number,
): { source: PricingSyncSource; fetchedAt: string; catalog: Record<string, ModelPricing> } | null {
  const raw = readOptionalText(cachePath);
  if (raw === null) return null;
  try {
    const parsed = PricingCatalogCacheSchema.parse(JSON.parse(raw) as unknown);
    if (parsed.source === "builtin") return null;
    if (nowMs - parsed.fetched_at_ms >= ttlMs) return null;
    return {
      source: parsed.source,
      fetchedAt: parsed.fetched_at,
      catalog: parsed.catalog,
    };
  } catch {
    return null;
  }
}

export interface SyncModelPricingOptions {
  store: KilnStore;
  backendRegistry?: BackendRegistry;
  request?: SyncPricingRequest;
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  discoveredModels?: readonly string[];
  homeDir?: string;
}

/**
 * Synchronizes `config/pricing.yaml` strictly for configured role models, historically billed
 * turns, and user custom overrides using local agent catalogs -> `models.dev` -> `litellm` ->
 * built-in offline baseline, pruning unused auto-synced entries cleanly.
 */
export async function syncModelPricing(
  options: SyncModelPricingOptions,
): Promise<SyncPricingResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PRICING_CACHE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PRICING_FETCH_TIMEOUT_MS;
  const nowMsFn = options.now ?? Date.now;
  const nowMs = nowMsFn();
  const force = options.request?.force === true;
  const restoreModel = options.request?.restore_model?.trim();

  // 1. Resolve catalog: fresh 24h disk cache -> models.dev -> litellm -> builtin offline snapshot
  let source: PricingSyncSource = "builtin";
  let fromCache = false;
  let syncedAt = new Date(nowMs).toISOString();
  let catalog: Record<string, ModelPricing> = {};
  let warning: string | undefined;

  const cached = force
    ? null
    : readFreshDiskCache(options.store.paths.pricingCacheFile, nowMs, cacheTtlMs);

  if (cached) {
    source = cached.source;
    syncedAt = cached.fetchedAt;
    catalog = cached.catalog;
    fromCache = true;
  } else {
    const errors: string[] = [];

    try {
      const modelsDevRaw = await fetchJsonReadOnly(MODELS_DEV_PRICING_URL, fetchImpl, timeoutMs);
      const parsed = parseModelsDevCatalog(modelsDevRaw);
      if (Object.keys(parsed).length === 0) {
        throw new Error("models.dev catalog returned zero pricing entries");
      }
      source = "models.dev";
      catalog = parsed;
    } catch (err) {
      errors.push(`models.dev: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (source === "builtin") {
      try {
        const liteLlmRaw = await fetchJsonReadOnly(LITELLM_PRICING_URL, fetchImpl, timeoutMs);
        const parsed = parseLiteLlmCatalog(liteLlmRaw);
        if (Object.keys(parsed).length === 0) {
          throw new Error("LiteLLM catalog returned zero pricing entries");
        }
        source = "litellm";
        catalog = parsed;
      } catch (err) {
        errors.push(`litellm: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (source !== "builtin") {
      const cachePayload = PricingCatalogCacheSchema.parse({
        schema_version: 1,
        source,
        fetched_at: syncedAt,
        fetched_at_ms: nowMs,
        catalog,
      });
      writeFileAtomic(
        options.store.paths.pricingCacheFile,
        `${JSON.stringify(cachePayload)}\n`,
      );
    } else {
      catalog = { ...BUILTIN_MODEL_PRICING };
      warning = `远程单价源不可用，已使用内置离线基线（${errors.join("; ")}）`;
    }
  }

  // 2. Collect target model IDs strictly from configured roles + historical turns + custom overrides (+ explicit callers)
  const targetModels = new Set<string>();
  const existingPricing = options.store.readConfig("pricing");
  const customSet = new Set(
    (existingPricing?.custom_models ?? [])
      .map((m) => m.trim())
      .filter((m) => m.length > 0 && m !== restoreModel),
  );
  for (const customModel of customSet) {
    targetModels.add(customModel);
  }

  const rolesConfig = options.store.readConfig("roles");
  if (rolesConfig) {
    for (const assignment of Object.values(rolesConfig.roles)) {
      if (assignment?.model?.trim()) {
        targetModels.add(assignment.model.trim());
      }
      if (assignment?.fallback?.model?.trim()) {
        targetModels.add(assignment.fallback.model.trim());
      }
    }
  }

  for (const turn of options.store.listUsageTurns()) {
    if (turn.model.trim()) {
      targetModels.add(turn.model.trim());
    }
  }

  if (options.discoveredModels) {
    for (const modelId of options.discoveredModels) {
      if (modelId.trim()) targetModels.add(modelId.trim());
    }
  }

  if (restoreModel) {
    targetModels.add(restoreModel);
  }

  // 3. Rebuild pricing.yaml cleanly (pruning stale unconfigured auto-synced entries) while protecting custom overrides
  const localAgentCatalog = loadLocalAgentPricingCatalog(options.homeDir);
  const nextModels: Record<string, ModelPricing> = {};
  const matchedModels: string[] = [];
  const unmatchedModels: string[] = [];
  const preservedOverrides: string[] = [];

  for (const modelId of Array.from(targetModels).sort()) {
    const existingEntry = existingPricing?.models[modelId];
    if (customSet.has(modelId) && existingEntry !== undefined) {
      nextModels[modelId] = existingEntry;
      preservedOverrides.push(modelId);
      continue;
    }

    const syncedPrice =
      lookupModelPrice(modelId, localAgentCatalog) ??
      lookupModelPrice(modelId, catalog) ??
      (source !== "builtin" ? lookupModelPrice(modelId, BUILTIN_MODEL_PRICING) : null);

    if (syncedPrice) {
      nextModels[modelId] = syncedPrice;
      matchedModels.push(modelId);
      customSet.delete(modelId);
    } else {
      if (existingEntry !== undefined) {
        nextModels[modelId] = existingEntry;
      }
      unmatchedModels.push(modelId);
    }
  }

  const nextCustomModels = Array.from(customSet).sort();
  const nextPricing: PricingConfig = PricingConfigSchema.parse({
    schema_version: 1,
    models: nextModels,
    ...(nextCustomModels.length > 0 ? { custom_models: nextCustomModels } : {}),
    sync: {
      source,
      synced_at: syncedAt,
    },
  });

  options.store.writeConfig("pricing", nextPricing);

  return SyncPricingResponseSchema.parse({
    ok: true,
    pricing: nextPricing,
    source,
    synced_at: syncedAt,
    from_cache: fromCache,
    matched_models: matchedModels,
    unmatched_models: unmatchedModels,
    preserved_overrides: preservedOverrides,
    ...(warning !== undefined ? { warning } : {}),
  });
}

export function isPricingSyncStale(
  pricing: PricingConfig | null,
  nowMs = Date.now(),
  ttlMs = DEFAULT_PRICING_CACHE_TTL_MS,
): boolean {
  if (!pricing?.sync?.synced_at) {
    return pricing === null;
  }
  const parsedMs = Date.parse(pricing.sync.synced_at);
  if (!Number.isFinite(parsedMs)) {
    return true;
  }
  return nowMs - parsedMs >= ttlMs;
}
