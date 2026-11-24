import type {
  PricingConfig,
  ProviderEntry,
  ProviderNativeQuota,
  ProviderRuntimeStatus,
} from "@kiln/protocol";
import { computeUsageSnapshot } from "../server/pending-decisions.js";
import type { UsageTurnRow } from "../store/sqlite.js";

const DEFAULT_COOLDOWN_SEC = 60;

export interface ProviderAvailabilityState {
  available: boolean;
  authRequired?: boolean;
  version?: string | null;
  detail?: string;
}

/**
 * Tracks 3-tier honest provider telemetry:
 * 1) universal 429 cooldowns (`cooldownUntil`),
 * 2) native remaining quota windows ONLY when reported by the provider itself,
 * 3) local Kiln window token & USD aggregation.
 */
export class ProviderHealthTracker {
  private readonly cooldowns = new Map<string, { untilMs: number; detail?: string }>();
  private readonly nativeQuotas = new Map<string, ProviderNativeQuota | null>();
  private readonly availability = new Map<string, ProviderAvailabilityState>();

  recordRateLimit(
    providerId: string,
    opts?: { retryAfterSec?: number; until?: string; detail?: string; nowMs?: number },
  ): string {
    const nowMs = opts?.nowMs ?? Date.now();
    let untilMs: number;

    if (opts?.until) {
      const parsed = Date.parse(opts.until);
      untilMs = Number.isFinite(parsed) ? parsed : nowMs + DEFAULT_COOLDOWN_SEC * 1000;
    } else {
      const sec =
        opts?.retryAfterSec !== undefined &&
        Number.isFinite(opts.retryAfterSec) &&
        opts.retryAfterSec > 0
          ? opts.retryAfterSec
          : DEFAULT_COOLDOWN_SEC;
      untilMs = nowMs + Math.round(sec * 1000);
    }

    const existing = this.cooldowns.get(providerId);
    if (!existing || untilMs >= existing.untilMs) {
      this.cooldowns.set(providerId, {
        untilMs,
        ...(opts?.detail !== undefined ? { detail: opts.detail } : {}),
      });
    }

    return new Date(Math.max(untilMs, existing?.untilMs ?? 0)).toISOString();
  }

  clearCooldown(providerId: string): void {
    this.cooldowns.delete(providerId);
  }

  isInCooldown(providerId: string, nowMs = Date.now()): boolean {
    const entry = this.cooldowns.get(providerId);
    if (!entry) return false;
    if (nowMs >= entry.untilMs) {
      this.cooldowns.delete(providerId);
      return false;
    }
    return true;
  }

  getCooldownUntil(providerId: string, nowMs = Date.now()): string | null {
    if (!this.isInCooldown(providerId, nowMs)) {
      return null;
    }
    const entry = this.cooldowns.get(providerId);
    return entry ? new Date(entry.untilMs).toISOString() : null;
  }

  setNativeQuota(providerId: string, quota: ProviderNativeQuota | null): void {
    this.nativeQuotas.set(providerId, quota);
  }

  setAvailability(providerId: string, state: ProviderAvailabilityState): void {
    this.availability.set(providerId, state);
  }

  buildRuntimeStatus(
    entry: ProviderEntry,
    localTurns: readonly UsageTurnRow[],
    pricing: PricingConfig | null,
    nowMs = Date.now(),
  ): ProviderRuntimeStatus {
    const cooldownUntil = this.getCooldownUntil(entry.id, nowMs);
    const avail = this.availability.get(entry.id);

    let status: ProviderRuntimeStatus["status"] = "ready";
    let detail = avail?.detail;

    if (!entry.enabled) {
      status = "unavailable";
      detail = avail && !avail.available && avail.detail ? avail.detail : "Provider is disabled";
    } else if (cooldownUntil !== null) {
      status = "cooldown";
      detail = this.cooldowns.get(entry.id)?.detail ?? detail;
    } else if (avail?.authRequired) {
      status = "auth_required";
    } else if (avail && !avail.available) {
      status = "unavailable";
    }

    const matchingTurns = localTurns.filter(
      (t) => t.agent === entry.id || t.agent.startsWith(`${entry.id}:`),
    );
    const localSnapshot = computeUsageSnapshot(matchingTurns, pricing);

    return {
      provider_id: entry.id,
      label: entry.label,
      adapter: entry.adapter,
      status,
      ...(avail?.version !== undefined ? { version: avail.version } : {}),
      cooldown_until: cooldownUntil,
      ...(detail !== undefined ? { detail } : {}),
      native_quota: this.nativeQuotas.get(entry.id) ?? null,
      local_window_cost_usd: localSnapshot.costUsd,
      local_window_tokens: localSnapshot.totalTokens,
    };
  }
}
