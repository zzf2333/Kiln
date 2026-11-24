import { describe, expect, it } from "vitest";
import {
  CommitPrActionRequestSchema,
  ProviderRuntimeStatusSchema,
  RollbackCheckpointRequestSchema,
  RunSpaceScriptRequestSchema,
  UpsertSpaceRequestSchema,
} from "../api.js";
import {
  CheckpointRecordSchema,
  DraftCardSchema,
  RunAntiDriftSummarySchema,
  RunMetaSchema,
  SpaceConfigSchema,
  StateEventSchema,
  TaskAttachmentSchema,
  TaskCardSchema,
} from "../card.js";
import {
  BUILTIN_ROSTER_ROLE_IDS,
  COST_SOURCES,
  MAX_ATTACHMENT_BYTES,
  ModelPricingSchema,
  PROVIDER_ADAPTER_KINDS,
  ProvidersConfigSchema,
  RolesConfigSchema,
  RosterConfigSchema,
  createDefaultBuiltinRosterMetadata,
  createDefaultProvidersConfig,
  deriveLegacyRolesConfigFromRoster,
  migrateRolesConfigToRoster,
} from "../config.js";
import {
  BackendCapabilitiesSchema,
  RunEventSchema,
  RunUsageSchema,
  SseEventSchema,
  toOrthogonalUsage,
} from "../events.js";
import { WbPlanInputSchema, WbSplitCardsPlanInputSchema } from "../mcp.js";
import {
  calculateCacheNetSavedUsd,
  calculateOrthogonalTurnCostUsd,
  calculateTurnCostUsd,
  resolveEffectiveCacheWritePrice,
} from "../pricing.js";
import * as webExports from "../web.js";
import {
  buildWorkflowPreset,
  validateBlueprintAgainstRoster,
  validateSplitCardsDag,
} from "../workflow.js";

const VALID_SHA = "a".repeat(64);

function makeContract() {
  return {
    goal: "实现 v0.0.5 契约层",
    end: "全部单测与类型检查通过",
    accept_cmd: "pnpm test packages/protocol",
    accept_files_hash: `sha256:${VALID_SHA}`,
    scope: ["packages/protocol/**"],
    non_goals: ["不修改 M4 Epic Loop"],
    deliver: { mode: "merge_main" as const, cmd: null },
    human_accept: false,
    external_actions: "ask" as const,
  };
}

describe("v0.0.5 protocol contracts", () => {
  it("builds default providers.yaml config and validates overrides", () => {
    const defaults = createDefaultProvidersConfig();
    expect(defaults.schema_version).toBe(1);
    const ids = defaults.providers.map((p) => p.id);
    expect(ids).toEqual(["codex", "pi", "agy", "claude", "gemini", "opencode", "paseo"]);
    expect(defaults.providers.find((p) => p.id === "paseo")?.enabled).toBe(false);
    expect(defaults.providers.find((p) => p.id === "codex")?.usage_rule).toEqual({
      scope: "cumulative_thread",
      input_includes_cache: true,
      reasoning_included_in_output: true,
    });

    const parsedCustom = ProvidersConfigSchema.parse({
      schema_version: 1,
      providers: [
        {
          id: "my-acp-1",
          label: "Custom ACP",
          adapter: "acp",
          command: "my-cli",
          args: ["--acp"],
          custom_models: ["my-proxy/sonnet"],
          quota: { soft_daily_usd: 15, soft_weekly_usd: 80 },
        },
      ],
    });
    expect(parsedCustom.providers[0]?.custom_models).toEqual(["my-proxy/sonnet"]);

    expect(
      ProvidersConfigSchema.safeParse({
        schema_version: 1,
        providers: [{ id: "Bad ID!", label: "x", adapter: "acp" }],
      }).success,
    ).toBe(false);
  });

  it("validates 16 built-in roster entries (with standalone advisor) and upgrades/projects v0.0.4 roles.yaml cleanly", () => {
    const seed = createDefaultBuiltinRosterMetadata();
    expect(Object.keys(seed)).toHaveLength(BUILTIN_ROSTER_ROLE_IDS.length);
    expect(seed.tester.mode).toBe("kernel");
    expect(seed.tester.enabled).toBe(true);
    expect(seed.deliverer.mode).toBe("kernel");
    expect(seed.main_dev.enabled).toBe(false);
    expect(seed.architect).toMatchObject({
      group: "core",
      stage: "plan",
      secondary_stages: [],
      perm: "read_only",
      enabled: false,
    });
    expect(seed.advisor).toMatchObject({
      group: "core",
      stage: "advise",
      secondary_stages: [],
      perm: "read_only",
      enabled: false,
      name: "技术顾问",
    });

    // Enabled agent entry must bind primary model
    expect(
      RosterConfigSchema.safeParse({
        schema_version: 2,
        roster: {
          main_dev: {
            ...seed.main_dev,
            enabled: true,
          },
        },
      }).success,
    ).toBe(false);

    const legacy = RolesConfigSchema.parse({
      schema_version: 1,
      heterogeneous_review: true,
      roles: {
        intake: { agent: "claude", model: "claude-sonnet-4-6", reasoning_effort: "medium" },
        worker: {
          agent: "codex",
          model: "gpt-5.4",
          reasoning_effort: "high",
          fallback: { agent: "pi", model: "magpie/group/work" },
        },
        reviewer: {
          agent: "agy",
          model: "gemini-3-pro",
          avoid_same_model_as: "worker",
        },
        advisor: { agent: "claude", model: "claude-opus-4-6" },
      },
    });

    const upgraded = migrateRolesConfigToRoster(legacy);
    expect(upgraded.schema_version).toBe(2);
    expect(upgraded.roster.pm?.enabled).toBe(true);
    expect(upgraded.roster.pm?.primary).toEqual({
      provider: "claude",
      model: "claude-sonnet-4-6",
      effort: "medium",
    });
    expect(upgraded.roster.main_dev?.fallbacks).toEqual([
      { provider: "pi", model: "magpie/group/work" },
    ]);
    expect(upgraded.roster.advisor?.primary?.model).toBe("claude-opus-4-6");
    expect(upgraded.roster.advisor?.enabled).toBe(true);
    expect(upgraded.roster.architect?.enabled).toBe(false);

    const projected = deriveLegacyRolesConfigFromRoster(upgraded);
    expect(projected.roles.intake?.model).toBe("claude-sonnet-4-6");
    expect(projected.roles.worker?.fallback?.agent).toBe("pi");
    expect(projected.roles.reviewer?.avoid_same_model_as).toBe("worker");
    expect(projected.roles.advisor?.model).toBe("claude-opus-4-6");

    // New roster with only architect enabled (no advise secondary stage) does NOT populate legacy advisor
    const architectOnlyRoster = RosterConfigSchema.parse({
      schema_version: 2,
      roster: {
        ...seed,
        architect: {
          ...seed.architect,
          enabled: true,
          primary: { provider: "codex", model: "gpt-5.4" },
        },
      },
    });
    expect(deriveLegacyRolesConfigFromRoster(architectOnlyRoster).roles.advisor).toBeUndefined();

    // Legacy v0.0.5-early roster where architect still carries secondary_stages: ["advise"] retains compatibility
    const legacyArchitectAdviseRoster = RosterConfigSchema.parse({
      schema_version: 2,
      roster: {
        ...seed,
        architect: {
          ...seed.architect,
          enabled: true,
          secondary_stages: ["advise"],
          primary: { provider: "claude", model: "claude-sonnet-4-6" },
        },
      },
    });
    expect(deriveLegacyRolesConfigFromRoster(legacyArchitectAdviseRoster).roles.advisor?.model).toBe(
      "claude-sonnet-4-6",
    );
  });

  it("supports 5-field pricing, cache-write fallback, orthogonal billing, and CacheNetSavedUsd", () => {
    const legacyPrice = ModelPricingSchema.parse({ in: 3, cached: 0.3, out: 15 });
    expect(legacyPrice.cache_write).toBeUndefined();
    expect(resolveEffectiveCacheWritePrice("claude-sonnet-4-6", legacyPrice)).toBeCloseTo(3.75);
    expect(resolveEffectiveCacheWritePrice("gpt-5.4", legacyPrice)).toBe(3);

    const fiveField = ModelPricingSchema.parse({
      in: 3,
      cached: 0.3,
      cache_write: 3.75,
      out: 15,
      context_window: 1_000_000,
    });
    expect(fiveField.context_window).toBe(1_000_000);

    // Cold write turn incurs cache-write premium (negative net saving)
    const coldCost = calculateOrthogonalTurnCostUsd(
      {
        uncachedInputTokens: 10_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 50_000,
        outputTokens: 1_000,
        reasoningTokens: 500,
        reasoningIncludedInOutput: true,
      },
      fiveField,
    );
    expect(coldCost).toBeCloseTo(0.2325, 8);
    expect(
      calculateCacheNetSavedUsd({ cacheReadTokens: 0, cacheWriteTokens: 50_000 }, fiveField),
    ).toBeCloseTo(-0.0375, 8);

    // When reasoning is NOT included in output, it adds billed output tokens once
    const splitCost = calculateOrthogonalTurnCostUsd(
      {
        uncachedInputTokens: 2_000,
        cacheReadTokens: 100_000,
        cacheWriteTokens: 5_000,
        outputTokens: 600,
        reasoningTokens: 400,
        reasoningIncludedInOutput: false,
      },
      fiveField,
    );
    expect(splitCost).toBeCloseTo(0.06975, 8);
    expect(
      calculateCacheNetSavedUsd({ cacheReadTokens: 100_000, cacheWriteTokens: 5_000 }, fiveField),
    ).toBeCloseTo(0.26625, 8);

    // Legacy calculateTurnCostUsd stays exact and optionally folds cacheWriteTokens
    expect(
      calculateTurnCostUsd(
        { inputTokens: 10_000, cachedInputTokens: 0, cacheWriteTokens: 50_000, outputTokens: 1_000 },
        fiveField,
      ),
    ).toBeCloseTo(0.2325, 8);
  });

  it("validates RunUsage V2, RunEvent context_window/rate_limited, and new SSE variants", () => {
    const caps = BackendCapabilitiesSchema.parse({
      interactiveChat: true,
      approvals: true,
      mcpInjection: true,
      usageCacheBreakdown: true,
      interrupt: true,
      imageInput: true,
      cacheWriteTelemetry: true,
      contextWindowTelemetry: true,
      nativeQuotaWindow: false,
      readOnlySandbox: true,
    });
    expect(caps.contextWindowTelemetry).toBe(true);

    const v2Usage = RunUsageSchema.parse({
      turnId: "t-1",
      agent: "agy",
      model: "claude-opus-4-6",
      inputTokens: 47_519,
      cachedInputTokens: 27_184,
      uncachedInputTokens: 20_335,
      cacheReadTokens: 27_184,
      cacheWriteTokens: 1_000,
      outputTokens: 3_900,
      reasoningTokens: 3_766,
      reasoningIncludedInOutput: true,
      costSource: "catalog",
    });
    expect(toOrthogonalUsage(v2Usage)).toEqual({
      uncachedInputTokens: 20_335,
      cacheReadTokens: 27_184,
      cacheWriteTokens: 1_000,
      outputTokens: 3_900,
      reasoningTokens: 3_766,
      reasoningIncludedInOutput: true,
    });

    const ctxEv = RunEventSchema.parse({
      kind: "context_window",
      at: "2026-11-23T02:00:00.000Z",
      usedTokens: 18_517,
      contextWindowTokens: 1_048_576,
      percent: 1.77,
    });
    expect(ctxEv.kind).toBe("context_window");

    const rlEv = RunEventSchema.parse({
      kind: "rate_limited",
      at: "2026-11-23T02:00:01.000Z",
      provider: "codex",
      retryAfterSec: 45,
    });
    expect(rlEv.kind).toBe("rate_limited");

    const scriptSse = SseEventSchema.parse({
      seq: 10,
      type: "script.output",
      spaceId: "kiln",
      scriptRunId: "scr-1",
      scriptKey: "test",
      stream: "stdout",
      chunk: "PASS\n",
      done: true,
      exitCode: 0,
      at: "2026-11-23T02:00:02.000Z",
    });
    expect(scriptSse.type).toBe("script.output");

    const provSse = SseEventSchema.parse({
      seq: 11,
      type: "provider.status",
      providerId: "codex",
      status: "cooldown",
      cooldownUntil: "2026-11-23T02:05:00.000Z",
      at: "2026-11-23T02:00:03.000Z",
    });
    expect(provSse.type).toBe("provider.status");
  });

  it("enforces D25 validateBlueprintAgainstRoster security boundaries", () => {
    const seed = createDefaultBuiltinRosterMetadata();
    const roster = {
      ...seed,
      researcher: { ...seed.researcher, enabled: true },
      frontend_ui: { ...seed.frontend_ui, enabled: true },
      reviewer: { ...seed.reviewer, enabled: true },
      ops_sec: { ...seed.ops_sec, enabled: true },
      fast_fix: { ...seed.fast_fix, enabled: false },
    };

    const validBp = buildWorkflowPreset("standard_dev");
    validBp.pm_rationale = "UI task uses frontend_ui and heterogeneous reviewer";
    validBp.steps.unshift({
      kind: "agent",
      stage: "research",
      role: "advisor",
      fresh_context: true,
      roster_role: "researcher",
    });
    const loopNode = validBp.steps.find((s) => s.kind === "loop");
    if (loopNode && loopNode.kind === "loop") {
      loopNode.steps[0] = {
        ...loopNode.steps[0]!,
        kind: "agent",
        stage: "implement",
        role: "worker",
        fresh_context: false,
        roster_role: "frontend_ui",
      };
    }
    expect(validateBlueprintAgainstRoster(validBp, roster, { workspaceMode: "git_worktree" })).toEqual({
      ok: true,
    });

    // Reject read-only role assigned to implement stage
    const roOnImpl = buildWorkflowPreset("quick");
    (roOnImpl.steps[0] as { roster_role?: string }).roster_role = "researcher";
    const r1 = validateBlueprintAgainstRoster(roOnImpl, roster);
    expect(r1.ok).toBe(false);

    // Reject disabled role
    const disabledRoleBp = buildWorkflowPreset("quick");
    (disabledRoleBp.steps[0] as { roster_role?: string }).roster_role = "fast_fix";
    expect(validateBlueprintAgainstRoster(disabledRoleBp, roster).ok).toBe(false);

    // Reject host_staged outside host_scoped unless dry_run_only
    const opsOutsideHost = buildWorkflowPreset("quick");
    (opsOutsideHost.steps[0] as { roster_role?: string }).roster_role = "ops_sec";
    expect(
      validateBlueprintAgainstRoster(opsOutsideHost, roster, { workspaceMode: "git_worktree" }).ok,
    ).toBe(false);

    // Reject workspace_write role assigned to review stage
    const writerOnReview = buildWorkflowPreset("standard_dev");
    const reviewLoop = writerOnReview.steps.find((s) => s.kind === "loop");
    if (reviewLoop && reviewLoop.kind === "loop") {
      (reviewLoop.steps[2] as { roster_role?: string }).roster_role = "frontend_ui";
    }
    expect(validateBlueprintAgainstRoster(writerOnReview, roster).ok).toBe(false);
  });

  it("validates split-card DAG topological order and rejects cycles/self-links", () => {
    expect(
      validateSplitCardsDag([
        { temp_id: "b", depends_on_temp_ids: ["a"] },
        { temp_id: "a", depends_on_temp_ids: [] },
        { temp_id: "c", depends_on_temp_ids: ["b"] },
      ]),
    ).toEqual({ ok: true, order: ["a", "b", "c"] });

    expect(
      validateSplitCardsDag([
        { temp_id: "a", depends_on_temp_ids: ["b"] },
        { temp_id: "b", depends_on_temp_ids: ["a"] },
      ]).ok,
    ).toBe(false);

    expect(
      validateSplitCardsDag([{ temp_id: "a", depends_on_temp_ids: ["a"] }]).ok,
    ).toBe(false);

    const validSplitMcp = WbSplitCardsPlanInputSchema.safeParse({
      mode: "commit_split_cards",
      cards: [
        {
          temp_id: "slice-1",
          title: "Backend schema",
          space: "kiln",
          workspace_mode: "git_worktree",
          contract: makeContract(),
          brief_markdown: "## Goal\nSchema",
        },
        {
          temp_id: "slice-2",
          title: "Frontend wiring",
          space: "kiln",
          workspace_mode: "git_worktree",
          depends_on_temp_ids: ["slice-1"],
          contract: makeContract(),
          brief_markdown: "## Goal\nUI",
        },
      ],
    });
    expect(validSplitMcp.success).toBe(true);

    const cyclicSplitMcp = WbSplitCardsPlanInputSchema.safeParse({
      mode: "commit_split_cards",
      cards: [
        {
          temp_id: "s1",
          title: "One",
          space: "kiln",
          workspace_mode: "git_worktree",
          depends_on_temp_ids: ["s2"],
          contract: makeContract(),
          brief_markdown: "One",
        },
        {
          temp_id: "s2",
          title: "Two",
          space: "kiln",
          workspace_mode: "git_worktree",
          depends_on_temp_ids: ["s1"],
          contract: makeContract(),
          brief_markdown: "Two",
        },
      ],
    });
    expect(cyclicSplitMcp.success).toBe(false);

    const cyclicSplitPlan = WbPlanInputSchema.safeParse({
      mode: "commit_split_cards",
      cards: [
        {
          temp_id: "s1",
          title: "One",
          space: "kiln",
          workspace_mode: "git_worktree",
          depends_on_temp_ids: ["s2"],
          contract: makeContract(),
          brief_markdown: "One",
        },
        {
          temp_id: "s2",
          title: "Two",
          space: "kiln",
          workspace_mode: "git_worktree",
          depends_on_temp_ids: ["s1"],
          contract: makeContract(),
          brief_markdown: "Two",
        },
      ],
    });
    expect(cyclicSplitPlan.success).toBe(false);

    expect(
      WbPlanInputSchema.safeParse({
        mode: "commit_split_cards",
        cards: [
          {
            temp_id: "s1",
            title: "One",
            space: "kiln",
            workspace_mode: "git_worktree",
            depends_on_temp_ids: [],
            contract: makeContract(),
            brief_markdown: "One",
          },
          {
            temp_id: "s2",
            title: "Two",
            space: "kiln",
            workspace_mode: "git_worktree",
            depends_on_temp_ids: ["s1"],
            contract: makeContract(),
            brief_markdown: "Two",
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      StateEventSchema.safeParse({
        type: "checkpoint_rolled_back",
        at: "2026-11-23T02:00:00.000Z",
        checkpoint_ref: "refs/kiln/checkpoints/t-201/r-1",
        commit_sha: "abcdef1234567",
      }).success,
    ).toBe(true);

    expect(
      WbPlanInputSchema.safeParse({
        mode: "upsert_draft",
        draft_id: "d-1",
        attachments: [
          {
            id: "att-1",
            filename: "shot.png",
            mime_type: "image/png",
            size_bytes: 128,
            sha256: VALID_SHA,
            rel_path: "attachments/att-1-shot.png",
            added_at: "2026-11-23T02:00:00.000Z",
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("validates attachments, checkpoints, anti-drift summaries, space scripts, API DTOs, and web exports", () => {
    const attachment = TaskAttachmentSchema.parse({
      id: "att-1",
      filename: "error.png",
      mime_type: "image/png",
      size_bytes: 4096,
      sha256: VALID_SHA,
      rel_path: "attachments/att-1-error.png",
      added_at: "2026-11-23T02:00:00.000Z",
    });
    expect(
      TaskAttachmentSchema.safeParse({ ...attachment, size_bytes: MAX_ATTACHMENT_BYTES + 1 }).success,
    ).toBe(false);
    expect(
      TaskAttachmentSchema.safeParse({ ...attachment, mime_type: "application/pdf" }).success,
    ).toBe(false);

    const card = TaskCardSchema.parse({
      schema_version: 1,
      id: "t-201",
      title: "Card with attachments",
      space: "kiln",
      priority: "P1",
      track: "L2",
      workspace_mode: "git_worktree",
      parent: null,
      depends_on: [],
      attachments: [attachment],
      contract_version: 1,
      contract: makeContract(),
      limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 250000 },
      created_at: "2026-11-23T02:00:00.000Z",
      updated_at: "2026-11-23T02:00:00.000Z",
    });
    expect(card.attachments).toHaveLength(1);

    const draft = DraftCardSchema.parse({
      schema_version: 1,
      id: "d-1",
      attachments: [attachment],
      created_at: "2026-11-23T02:00:00.000Z",
      updated_at: "2026-11-23T02:00:00.000Z",
    });
    expect(draft.attachments).toHaveLength(1);

    const runMeta = RunMetaSchema.parse({
      run_id: "r-1",
      task_id: "t-201",
      stage: "implement",
      round: 1,
      role: "worker",
      roster_role: "frontend_ui",
      contract_version: 1,
      backend_id: "agy",
      agent: "agy",
      model: "claude-sonnet-4-6",
      session_ref: { backendId: "agy", sessionId: "s-1" },
      checkpoint_ref: "refs/kiln/checkpoints/t-201/r-1",
      started_at: "2026-11-23T02:00:00.000Z",
    });
    expect(runMeta.roster_role).toBe("frontend_ui");

    expect(
      SpaceConfigSchema.parse({
        schema_version: 1,
        id: "kiln",
        name: "Kiln",
        pinned: true,
        scripts: { setup: "pnpm install", test: "pnpm test" },
      }).scripts?.setup,
    ).toBe("pnpm install");

    expect(
      CheckpointRecordSchema.safeParse({
        run_id: "r-1",
        task_id: "t-201",
        stage: "implement",
        round: 1,
        ref: "refs/heads/main",
        commit_sha: "abcdef1",
        created_at: "2026-11-23T02:00:00.000Z",
      }).success,
    ).toBe(false);

    expect(
      RunAntiDriftSummarySchema.parse({
        input: "BRIEF.md §1 + PLAN.md",
        alignment_points: ["保持契约兼容"],
        output: "新增 5 字段单价测试",
        gate_proof: { schema_ok: true, scope_ok: true, frozen_ok: true, accept_ok: true },
      }).gate_proof.frozen_ok,
    ).toBe(true);

    expect(
      UpsertSpaceRequestSchema.parse({
        name: "Kiln",
        repo_path: "/tmp/kiln",
        pinned: true,
        scripts: { dev: "pnpm dev" },
      }).pinned,
    ).toBe(true);

    expect(
      ProviderRuntimeStatusSchema.parse({
        provider_id: "codex",
        label: "Codex CLI",
        adapter: "codex_app_server",
        status: "ready",
        native_quota: { source: "codex", used_percent: 14, window_duration_mins: 10080 },
      }).native_quota?.used_percent,
    ).toBe(14);

    expect(RunSpaceScriptRequestSchema.parse({ script: "test" }).script).toBe("test");
    expect(
      RollbackCheckpointRequestSchema.safeParse({
        checkpoint_ref: "refs/kiln/checkpoints/t-201/r-1",
        confirm: true,
      }).success,
    ).toBe(true);
    expect(
      CommitPrActionRequestSchema.safeParse({
        action: "open_pr",
        pr_title: "feat: v0.0.5 protocol",
        confirm: true,
      }).success,
    ).toBe(true);

    // Zero-Zod web bundle exports
    expect(webExports.PROVIDER_ADAPTER_KINDS).toEqual(PROVIDER_ADAPTER_KINDS);
    expect(webExports.COST_SOURCES).toEqual(COST_SOURCES);
    expect(typeof webExports.validateBlueprintAgainstRoster).toBe("function");
    expect(typeof webExports.validateSplitCardsDag).toBe("function");
    expect(typeof webExports.calculateCacheNetSavedUsd).toBe("function");
  });
});
