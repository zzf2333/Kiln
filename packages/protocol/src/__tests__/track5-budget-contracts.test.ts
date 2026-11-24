import { describe, expect, it } from "vitest";
import {
  BudgetScopeStatusSchema,
  CardLimitsSchema,
  GlobalBudgetStatusSchema,
  LimitsConfigSchema,
  ProviderEntrySchema,
  UpdateTaskLimitsRequestSchema,
} from "../index.js";
import * as webExports from "../web.js";

describe("Track 5 [B10] USD budget contracts", () => {
  it("supports optional max_cost_usd on CardLimits and USD budget settings on LimitsConfig", () => {
    const basicLimits = CardLimitsSchema.parse({
      retries_per_stage: 2,
      review_rounds: 2,
      advisor_calls: 1,
      max_tokens: 150_000,
    });
    expect(basicLimits.max_cost_usd).toBeUndefined();

    const withCost = CardLimitsSchema.parse({
      retries_per_stage: 2,
      review_rounds: 2,
      advisor_calls: 1,
      max_tokens: 150_000,
      max_cost_usd: 1.25,
    });
    expect(withCost.max_cost_usd).toBe(1.25);

    const sysLimits = LimitsConfigSchema.parse({
      schema_version: 1,
      max_card_cost_usd: 2.5,
      daily_budget_usd: 10,
      monthly_budget_usd: 100,
      budget_soft_warning_ratio: 0.85,
      budget_exclude_subscription_providers: true,
    });
    expect(sysLimits.max_card_cost_usd).toBe(2.5);
    expect(sysLimits.daily_budget_usd).toBe(10);
    expect(sysLimits.monthly_budget_usd).toBe(100);
    expect(sysLimits.budget_soft_warning_ratio).toBe(0.85);
    expect(sysLimits.budget_exclude_subscription_providers).toBe(true);
  });

  it("supports billing_mode on ProviderEntry, UpdateTaskLimitsRequestSchema, and budget status schemas", () => {
    const prov = ProviderEntrySchema.parse({
      id: "claude",
      label: "Claude Code",
      adapter: "claude_direct",
      billing_mode: "subscription",
    });
    expect(prov.billing_mode).toBe("subscription");

    expect(UpdateTaskLimitsRequestSchema.parse({ max_cost_usd: 3.5 }).max_cost_usd).toBe(3.5);
    expect(UpdateTaskLimitsRequestSchema.parse({ max_cost_usd: null }).max_cost_usd).toBeNull();

    const scope = BudgetScopeStatusSchema.parse({
      scope: "daily",
      spent_usd: 8.2,
      limit_usd: 10,
      ratio: 0.82,
      level: "warning",
    });
    const global = GlobalBudgetStatusSchema.parse({
      daily: scope,
      monthly: {
        scope: "monthly",
        spent_usd: 8.2,
        limit_usd: null,
        ratio: null,
        level: "ok",
      },
      soft_warning_ratio: 0.8,
      exclude_subscription_providers: false,
      computed_at: "2026-11-24T00:00:00Z",
    });
    expect(global.daily.level).toBe("warning");
    expect(typeof webExports.WORKFLOW_PRESETS).toBe("object");
  });
});
