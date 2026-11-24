import type {
  BudgetScopeStatus,
  GlobalBudgetStatus,
  ProvidersConfig,
  TaskCard,
} from "@kiln/protocol";
import type { KilnStore, UsageTurnRow } from "../store/index.js";
import { computeUsageSnapshot } from "./pending-decisions.js";

const DEFAULT_SOFT_WARNING_RATIO = 0.8;

export type BudgetScope = "card" | "daily" | "monthly";

export interface DispatchBudgetWarning {
  key: string;
  scope: BudgetScope;
  status: BudgetScopeStatus;
}

export interface DispatchBudgetEvaluation {
  blocked: boolean;
  blockingScope?: BudgetScope;
  blockingStatus?: BudgetScopeStatus;
  warnings: DispatchBudgetWarning[];
  cardStatus: BudgetScopeStatus;
  globalStatus: GlobalBudgetStatus;
}

function buildScopeStatus(
  scope: BudgetScope,
  spentUsd: number,
  limitUsd: number | null,
  softWarningRatio: number,
): BudgetScopeStatus {
  const spent = Number(Math.max(0, spentUsd).toFixed(6));
  if (limitUsd === null || !Number.isFinite(limitUsd) || limitUsd <= 0) {
    return {
      scope,
      spent_usd: spent,
      limit_usd: null,
      ratio: null,
      level: "ok",
    };
  }
  const ratio = Number((spent / limitUsd).toFixed(4));
  const level: BudgetScopeStatus["level"] =
    spent >= limitUsd ? "exceeded" : ratio >= softWarningRatio ? "warning" : "ok";
  return {
    scope,
    spent_usd: spent,
    limit_usd: limitUsd,
    ratio,
    level,
  };
}

function startOfLocalDayIso(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  return d.toISOString();
}

function startOfLocalMonthIso(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  return d.toISOString();
}

function localDayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function localMonthKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Filters persisted usage turns according to `budget_exclude_subscription_providers`.
 * When `excludeSubscription` is true, turns from providers marked `billing_mode: "subscription"`
 * are excluded so flat-rate subscriptions do not trip USD hard circuit breakers.
 */
export function filterBudgetUsageTurns(
  turns: readonly UsageTurnRow[],
  providersCfg: ProvidersConfig,
  excludeSubscription: boolean,
): UsageTurnRow[] {
  if (!excludeSubscription) {
    return [...turns];
  }
  const subIds = new Set(
    providersCfg.providers
      .filter((p) => p.billing_mode === "subscription")
      .map((p) => p.id.toLowerCase()),
  );
  if (subIds.size === 0) {
    return [...turns];
  }
  return turns.filter((t) => !subIds.has(t.agent.toLowerCase()));
}

/**
 * Computes total USD spent for a single task from disk-backed `usage_turns`
 * using the active budget billing scope (`exclude_subscription_providers`).
 */
export function computeTaskSpentUsd(store: KilnStore, taskId: string): number {
  const limits = store.readConfig("limits");
  const excludeSub = Boolean(limits?.budget_exclude_subscription_providers);
  const providersCfg = store.readEffectiveProvidersConfig();
  const pricing = store.readConfig("pricing");
  const turns = filterBudgetUsageTurns(store.listUsageTurns({ taskId }), providersCfg, excludeSub);
  return computeUsageSnapshot(turns, pricing).costUsd;
}

/**
 * Evaluates a single task card's USD budget status against `card.limits.max_cost_usd`.
 */
export function computeTaskBudgetStatus(store: KilnStore, card: TaskCard): BudgetScopeStatus {
  const limits = store.readConfig("limits");
  const softRatio = limits?.budget_soft_warning_ratio ?? DEFAULT_SOFT_WARNING_RATIO;
  const spent = computeTaskSpentUsd(store, card.id);
  const limitUsd = card.limits.max_cost_usd ?? null;
  return buildScopeStatus("card", spent, limitUsd, softRatio);
}

/**
 * Computes global natural-day and natural-month USD budget consumption from persisted `usage_turns`,
 * ensuring exact consistency after `rebuildIndexFromDisk()`.
 */
export function computeGlobalBudgetStatus(store: KilnStore, now = new Date()): GlobalBudgetStatus {
  const limits = store.readConfig("limits");
  const softRatio = limits?.budget_soft_warning_ratio ?? DEFAULT_SOFT_WARNING_RATIO;
  const excludeSub = Boolean(limits?.budget_exclude_subscription_providers);
  const providersCfg = store.readEffectiveProvidersConfig();
  const pricing = store.readConfig("pricing");
  const allTurns = filterBudgetUsageTurns(store.listUsageTurns(), providersCfg, excludeSub);

  const dayStartMs = Date.parse(startOfLocalDayIso(now));
  const monthStartMs = Date.parse(startOfLocalMonthIso(now));

  const dailyTurns: UsageTurnRow[] = [];
  const monthlyTurns: UsageTurnRow[] = [];
  for (const t of allTurns) {
    const ms = Date.parse(t.recorded_at);
    if (!Number.isFinite(ms)) continue;
    if (ms >= monthStartMs) {
      monthlyTurns.push(t);
      if (ms >= dayStartMs) {
        dailyTurns.push(t);
      }
    }
  }

  const dailySpent = computeUsageSnapshot(dailyTurns, pricing).costUsd;
  const monthlySpent = computeUsageSnapshot(monthlyTurns, pricing).costUsd;

  return {
    daily: buildScopeStatus("daily", dailySpent, limits?.daily_budget_usd ?? null, softRatio),
    monthly: buildScopeStatus(
      "monthly",
      monthlySpent,
      limits?.monthly_budget_usd ?? null,
      softRatio,
    ),
    soft_warning_ratio: softRatio,
    exclude_subscription_providers: excludeSub,
    computed_at: now.toISOString(),
  };
}

/**
 * Evaluates pre-dispatch USD budgets across card, daily, and monthly scopes.
 */
export function evaluateDispatchBudget(
  store: KilnStore,
  card: TaskCard,
  now = new Date(),
): DispatchBudgetEvaluation {
  const cardStatus = computeTaskBudgetStatus(store, card);
  const globalStatus = computeGlobalBudgetStatus(store, now);

  const warnings: DispatchBudgetWarning[] = [];
  if (cardStatus.level === "warning") {
    warnings.push({
      key: `card:${card.id}:${cardStatus.limit_usd}`,
      scope: "card",
      status: cardStatus,
    });
  }
  if (globalStatus.daily.level === "warning") {
    warnings.push({
      key: `daily:${localDayKey(now)}:${globalStatus.daily.limit_usd}`,
      scope: "daily",
      status: globalStatus.daily,
    });
  }
  if (globalStatus.monthly.level === "warning") {
    warnings.push({
      key: `monthly:${localMonthKey(now)}:${globalStatus.monthly.limit_usd}`,
      scope: "monthly",
      status: globalStatus.monthly,
    });
  }

  const blockingStatus =
    cardStatus.level === "exceeded"
      ? cardStatus
      : globalStatus.daily.level === "exceeded"
        ? globalStatus.daily
        : globalStatus.monthly.level === "exceeded"
          ? globalStatus.monthly
          : undefined;

  return {
    blocked: blockingStatus !== undefined,
    ...(blockingStatus ? { blockingScope: blockingStatus.scope, blockingStatus } : {}),
    warnings,
    cardStatus,
    globalStatus,
  };
}
