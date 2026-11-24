import { describe, expect, it } from "vitest";
import {
  IMPROVEMENT_PROPOSAL_STATUSES,
  IMPROVEMENT_TARGET_KINDS,
  MAX_ACTIVE_LEDGER_INJECT,
  RETRO_ATTRIBUTION_CATEGORIES,
  createDefaultBuiltinRosterMetadata,
  ImprovementProposalSchema,
  LedgerEntrySchema,
  LimitsConfigSchema,
  migrateRolesConfigToRoster,
  PolicyChangeRecordSchema,
  RolesConfigSchema,
  SpaceConfigSchema,
  TaskRetroReportSchema,
  UpsertSpaceRequestSchema,
} from "../index.js";
import * as webExports from "../web.js";

describe("Track 4 compounding flywheel contracts", () => {
  it("registers retro role inheriting advisor -> pm with read_only permission and auto_retro_high_signal defaulting to false", () => {
    const meta = createDefaultBuiltinRosterMetadata();
    expect(meta.retro).toBeDefined();
    expect(meta.retro.perm).toBe("read_only");
    expect(meta.retro.tier_hint).toBe("flagship");
    expect(meta.retro.enabled).toBe(false);

    const defaultRoster = migrateRolesConfigToRoster(
      RolesConfigSchema.parse({ schema_version: 1, roles: {} }),
    );
    expect(defaultRoster.roster.retro).toBeDefined();
    expect(defaultRoster.roster.retro?.perm).toBe("read_only");

    const limits = LimitsConfigSchema.parse({ schema_version: 1 });
    expect(limits.auto_retro_high_signal ?? false).toBe(false);
    expect(
      LimitsConfigSchema.parse({ schema_version: 1, auto_retro_high_signal: true })
        .auto_retro_high_signal,
    ).toBe(true);
  });

  it("extends SpaceConfigSchema, UpsertSpaceRequestSchema, and LedgerEntrySchema with compounding fields", () => {
    const space = SpaceConfigSchema.parse({
      schema_version: 1,
      id: "kiln",
      name: "Kiln",
      repo_path: "/tmp/kiln",
      intake_checklist: ["必须确认移动端断点 >= 390px"],
      accept_scenarios: ["登录并创建任务后刷新仍存在"],
      default_workflow_preset: "standard_dev",
    });
    expect(space.intake_checklist).toEqual(["必须确认移动端断点 >= 390px"]);
    expect(space.accept_scenarios).toEqual(["登录并创建任务后刷新仍存在"]);
    expect(space.default_workflow_preset).toBe("standard_dev");

    const upsert = UpsertSpaceRequestSchema.parse({
      name: "Kiln",
      repo_path: "/tmp/kiln",
      intake_checklist: ["a"],
      accept_scenarios: ["b"],
      default_workflow_preset: "full_delivery",
    });
    expect(upsert.default_workflow_preset).toBe("full_delivery");

    const ledgerEntry = LedgerEntrySchema.parse({
      id: "led-1",
      space: "kiln",
      rule: "禁止修改已发布协议字段类型",
      source_task_id: "t-100",
      created_at: "2026-11-24T00:00:00Z",
      failure_mode: "breaking_contract_change",
      detection_signal: "typecheck failure in consumers",
      prevention_rule: "仅做向后兼容扩展",
      scope_tags: ["protocol"],
      evidence_task_ids: ["t-100", "t-101"],
      merged_from: ["led-0"],
      hit_count: 3,
      last_triggered_at: "2026-11-24T01:00:00Z",
      status: "active",
    });
    expect(ledgerEntry.hit_count).toBe(3);
    expect(ledgerEntry.status).toBe("active");
  });

  it("validates TaskRetroReportSchema, ImprovementProposalSchema, PolicyChangeRecordSchema, and web exports", () => {
    expect(MAX_ACTIVE_LEDGER_INJECT).toBe(20);
    expect(RETRO_ATTRIBUTION_CATEGORIES).toEqual([
      "intake_contract",
      "recon_plan",
      "model_fit",
      "context_cache",
      "space_rule",
    ]);
    expect(IMPROVEMENT_TARGET_KINDS).toContain("space_accept_scenario");
    expect(IMPROVEMENT_PROPOSAL_STATUSES).toEqual([
      "pending",
      "approved",
      "dismissed",
    ]);
    expect(webExports.MAX_ACTIVE_LEDGER_INJECT).toBe(20);

    const retro = TaskRetroReportSchema.parse({
      task_id: "t-400",
      space: "kiln",
      terminal_status: "done",
      mode: "deterministic",
      high_signal: true,
      signals: ["accept_failures:1", "rework:1"],
      metrics: {
        total_runs: 4,
        rework_rounds: 1,
        retries_count: 0,
        review_rejections: 1,
        accept_failures: 1,
        escalations_count: 1,
        track_escalated_to_l2: false,
        steer_count: 0,
        contract_updates: 0,
        first_pass: false,
        cache_hit_rate: 0.72,
        total_cost_usd: 0.145,
      },
      attributions: [
        {
          category: "space_rule",
          summary: "真实验收发现未覆盖的登录态失效分支",
          earliest_preventable_stage: "accept",
          evidence: "accept/report.json",
        },
      ],
      summary: "高信号完成：经历 1 次审查打回与 1 次验收失败",
      proposal_ids: ["prop-1"],
      generated_at: "2026-11-24T02:00:00Z",
    });
    expect(retro.high_signal).toBe(true);

    const proposal = ImprovementProposalSchema.parse({
      id: "prop-1",
      source: "retro",
      target_kind: "space_accept_scenario",
      space: "kiln",
      title: "补充登录态过期验收场景",
      rationale: "t-400 在真实验收中暴露 token 刷新遗漏",
      expected_impact: "避免同类认证回归在交付前漏网",
      evidence_task_ids: ["t-400"],
      payload: { scenario: "退出再登录后旧 token 必须 401" },
      created_at: "2026-11-24T02:00:00Z",
    });
    expect(proposal.status).toBe("pending");

    const change = PolicyChangeRecordSchema.parse({
      id: "chg-1",
      proposal_id: "prop-1",
      target_kind: "space_accept_scenario",
      target_ref: "kiln",
      space: "kiln",
      summary: "补充登录态过期验收场景",
      applied_at: "2026-11-24T02:05:00Z",
      before_snapshot: { accept_scenarios: [] },
      after_snapshot: { accept_scenarios: ["退出再登录后旧 token 必须 401"] },
      before_metrics: {
        task_count: 3,
        first_pass_rate: 0.67,
        avg_rework_rounds: 0.67,
        cache_hit_rate: 0.7,
        median_cost_usd: 0.12,
        p90_cost_usd: 0.25,
        accept_defect_catch_rate: 0.33,
      },
    });
    expect(change.schema_version).toBe(1);
  });
});
