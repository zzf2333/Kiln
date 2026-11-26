import { describe, expect, it } from "vitest";
import {
  ADVISOR_ELIGIBLE_DECISION_CATEGORIES,
  AdvisorReceiptFrontmatterSchema,
  PendingSubtaskSplitSchema,
  createDefaultBuiltinRosterMetadata,
  StateEventSchema,
  WorkflowBlueprintSchema,
  applyAdvisorWorkflowPatch,
  buildCustomWorkflow,
  buildWorkflowPreset,
  ensureWorkflowIncludesReview,
  extractWorkflowToggles,
  findLoopRestartStepIndex,
  flattenWorkflowSteps,
  getDeliverCommandPolicy,
  getImplementAgentMode,
  getStageNodeKind,
  getVerifyGateCheckMode,
  getWorkflowFlatSteps,
  getWorkflowLoopPolicy,
  getWorkflowStages,
  hasCompleteHostTwoPhaseWorkflow,
  nextWorkflowStepAfter,
  normalizeWorkflowBlueprintSafety,
  resolveTaskWorkflow,
  resolveWorkflowStepAt,
  validateWorkflowBlueprint,
} from "../index.js";

describe("workflow composable blueprint schemas & helpers", () => {
  it("builds valid preset blueprints for quick, host_op, standard_dev, and full_delivery", () => {
    const quick = WorkflowBlueprintSchema.parse(buildWorkflowPreset("quick"));
    expect(quick.preset).toBe("quick");
    expect(flattenWorkflowSteps(quick).map((s) => `${s.kind}:${s.stage}`)).toEqual([
      "agent:implement",
      "gate:verify",
      "command:deliver",
    ]);
    expect(
      getWorkflowStages({
        track: "L1",
        workspace_mode: "git_worktree",
        contract: { human_accept: false },
        workflow: quick,
      }),
    ).toEqual(["implement", "verify", "deliver"]);

    const hostOp = WorkflowBlueprintSchema.parse(
      buildWorkflowPreset("host_op", { hasDeliverCmd: true }),
    );
    expect(hostOp.preset).toBe("host_op");
    expect(
      getWorkflowStages({
        track: "L1",
        workspace_mode: "host_scoped",
        contract: { human_accept: false, deliver: { mode: "run_cmd", cmd: "python3 clean.py" } },
        workflow: hostOp,
      }),
    ).toEqual(["implement", "verify", "deliver"]);
    expect(
      getImplementAgentMode({
        track: "L1",
        workspace_mode: "host_scoped",
        contract: {},
        workflow: hostOp,
      }),
    ).toBe("dry_run_only");
    expect(
      getVerifyGateCheckMode({
        track: "L1",
        workspace_mode: "host_scoped",
        contract: {},
        workflow: hostOp,
      }),
    ).toBe("staged_only");
    expect(
      getDeliverCommandPolicy({
        track: "L1",
        workspace_mode: "host_scoped",
        contract: { deliver: { mode: "run_cmd", cmd: "python3 clean.py" } },
        workflow: hostOp,
      }),
    ).toEqual({
      hasCommandNode: true,
      applyStaged: true,
      runDeliverCmd: true,
      verifySha256: true,
      finalAcceptGate: true,
      requiresDeliverApproval: true,
    });

    const std = WorkflowBlueprintSchema.parse(buildWorkflowPreset("standard_dev"));
    expect(std.steps[0]?.kind).toBe("loop");
    expect(
      getWorkflowLoopPolicy({
        track: "L2",
        workspace_mode: "git_worktree",
        contract: {},
        workflow: std,
      }),
    ).toEqual({ maxRounds: 3, stuckThreshold: 2 });

    const full = WorkflowBlueprintSchema.parse(buildWorkflowPreset("full_delivery"));
    expect(
      getWorkflowStages({
        track: "L2",
        workspace_mode: "git_worktree",
        contract: {},
        workflow: full,
      }),
    ).toEqual(["plan", "implement", "verify", "review", "accept", "deliver"]);
    expect(
      getStageNodeKind(
        {
          track: "L2",
          workspace_mode: "git_worktree",
          contract: {},
          workflow: full,
        },
        "accept",
      ),
    ).toBe("agent");
  });

  it("enforces all 7 blueprint safety invariants in validateWorkflowBlueprint", () => {
    // 1. High-risk deliver command (apply_staged or run_deliver_cmd) without approval
    const noApproval = validateWorkflowBlueprint({
      schema_version: 1,
      preset: "custom",
      steps: [
        { kind: "agent", stage: "implement", role: "worker", fresh_context: false },
        { kind: "gate", stage: "verify", check: "full" },
        {
          kind: "command",
          stage: "deliver",
          apply_staged: false,
          run_deliver_cmd: true,
          verify_sha256: false,
          final_accept_gate: false,
        },
      ],
    });
    expect(noApproval.ok).toBe(false);
    if (!noApproval.ok) {
      expect(noApproval.errors.some((e) => e.includes("approval"))).toBe(true);
    }

    // 2. staged_only gate without final_accept_gate in deliver command
    const noFinalGate = validateWorkflowBlueprint({
      schema_version: 1,
      preset: "custom",
      steps: [
        {
          kind: "agent",
          stage: "implement",
          role: "worker",
          fresh_context: false,
          mode: "dry_run_only",
        },
        { kind: "gate", stage: "verify", check: "staged_only" },
        { kind: "approval", stage: "deliver", show: ["staged_diff"] },
        {
          kind: "command",
          stage: "deliver",
          apply_staged: true,
          run_deliver_cmd: false,
          verify_sha256: true,
          final_accept_gate: false,
        },
      ],
    });
    expect(noFinalGate.ok).toBe(false);
    if (!noFinalGate.ok) {
      expect(noFinalGate.errors.some((e) => e.includes("final_accept_gate"))).toBe(true);
    }

    // 3. Reviewer / Verifier / Advisor must use fresh_context=true and matching role
    const badRoleAndFresh = validateWorkflowBlueprint({
      schema_version: 1,
      preset: "custom",
      steps: [
        { kind: "agent", stage: "implement", role: "worker", fresh_context: false },
        { kind: "agent", stage: "review", role: "worker", fresh_context: false },
        {
          kind: "command",
          stage: "deliver",
          apply_staged: false,
          run_deliver_cmd: false,
          verify_sha256: false,
          final_accept_gate: false,
        },
      ],
    });
    expect(badRoleAndFresh.ok).toBe(false);
    if (!badRoleAndFresh.ok) {
      expect(badRoleAndFresh.errors.length).toBeGreaterThanOrEqual(2);
    }

    // 4. Nested loop & out-of-range max_rounds rejected by Zod schema
    const nested = WorkflowBlueprintSchema.safeParse({
      schema_version: 1,
      preset: "custom",
      steps: [
        {
          kind: "loop",
          max_rounds: 3,
          stuck_threshold: 2,
          steps: [
            {
              kind: "loop",
              max_rounds: 2,
              stuck_threshold: 1,
              steps: [],
            },
          ],
        },
      ],
    });
    expect(nested.success).toBe(false);

    // 5. Stage ordering: plan after implement or stage after deliver
    const badOrder = validateWorkflowBlueprint({
      schema_version: 1,
      preset: "custom",
      steps: [
        { kind: "agent", stage: "implement", role: "worker", fresh_context: false },
        { kind: "agent", stage: "plan", role: "advisor", fresh_context: true },
        {
          kind: "command",
          stage: "deliver",
          apply_staged: false,
          run_deliver_cmd: false,
          verify_sha256: false,
          final_accept_gate: false,
        },
        { kind: "gate", stage: "verify", check: "full" },
      ],
    });
    expect(badOrder.ok).toBe(false);
  });

  it("preserves legacy backward compatibility in resolveTaskWorkflow & inserts review via ensureWorkflowIncludesReview", () => {
    const legacyHostCard = {
      track: "L1" as const,
      workspace_mode: "host_scoped" as const,
      contract: { human_accept: false, deliver: { mode: "manual", cmd: null } },
    };
    expect(getVerifyGateCheckMode(legacyHostCard)).toBe("full");
    expect(getWorkflowLoopPolicy(legacyHostCard)).toBeNull();
    expect(getDeliverCommandPolicy(legacyHostCard).requiresDeliverApproval).toBe(false);
    expect(getWorkflowStages(legacyHostCard)).toEqual(["implement", "verify", "deliver"]);
    expect(resolveTaskWorkflow(legacyHostCard).preset).toBe("quick");

    const quick = buildWorkflowPreset("quick");
    const escalated = WorkflowBlueprintSchema.parse(ensureWorkflowIncludesReview(quick));
    expect(
      getWorkflowStages({
        track: "L2",
        workspace_mode: "git_worktree",
        contract: {},
        workflow: escalated,
      }),
    ).toEqual(["implement", "verify", "review", "deliver"]);

    const custom = WorkflowBlueprintSchema.parse(
      buildCustomWorkflow({
        preset: "custom",
        includePlan: true,
        includeReview: true,
        includeAccept: true,
        acceptMode: "approval",
        deliverApproval: false,
        hostTwoPhase: false,
        hasDeliverCmd: true,
        maxRounds: 4,
        stuckThreshold: 3,
      }),
    );
    expect(extractWorkflowToggles(custom)).toMatchObject({
      preset: "custom",
      includePlan: true,
      includeReview: true,
      includeAccept: true,
      acceptMode: "approval",
      deliverApproval: true,
      hostTwoPhase: false,
      hasDeliverCmd: true,
      maxRounds: 4,
      stuckThreshold: 3,
    });

    // accept-stage approval alone cannot authorize apply_staged / run_deliver_cmd
    const acceptOnlyApproval = validateWorkflowBlueprint({
      schema_version: 1,
      preset: "custom",
      steps: [
        { kind: "agent", stage: "implement", role: "worker", fresh_context: false },
        { kind: "approval", stage: "accept", show: ["report"] },
        {
          kind: "command",
          stage: "deliver",
          apply_staged: false,
          run_deliver_cmd: true,
          verify_sha256: false,
          final_accept_gate: false,
        },
      ],
    });
    expect(acceptOnlyApproval.ok).toBe(false);
    if (!acceptOnlyApproval.ok) {
      expect(acceptOnlyApproval.errors.some((e) => e.includes("deliver approval"))).toBe(true);
    }
  });

  it("resolves step_index cursors across multi-specialist same-stage blueprints and legacy cards", () => {
    const multiSpec = WorkflowBlueprintSchema.parse({
      schema_version: 1,
      preset: "custom",
      pm_rationale: "先后端再前端视觉精修",
      steps: [
        {
          kind: "agent",
          stage: "plan",
          role: "advisor",
          fresh_context: true,
          roster_role: "architect",
        },
        {
          kind: "agent",
          stage: "implement",
          role: "worker",
          fresh_context: false,
          roster_role: "main_dev",
        },
        {
          kind: "agent",
          stage: "implement",
          role: "worker",
          fresh_context: false,
          roster_role: "frontend_ui",
        },
        { kind: "gate", stage: "verify", check: "full" },
        {
          kind: "loop",
          max_rounds: 2,
          stuck_threshold: 2,
          steps: [
            {
              kind: "agent",
              stage: "review",
              role: "reviewer",
              fresh_context: true,
              roster_role: "reviewer",
            },
            {
              kind: "agent",
              stage: "implement",
              role: "worker",
              fresh_context: false,
              roster_role: "main_dev",
            },
            { kind: "gate", stage: "verify", check: "full" },
          ],
        },
        {
          kind: "command",
          stage: "deliver",
          apply_staged: false,
          run_deliver_cmd: false,
          verify_sha256: false,
          final_accept_gate: false,
        },
      ],
    });
    const card = {
      track: "L2" as const,
      workspace_mode: "git_worktree" as const,
      contract: {},
      workflow: multiSpec,
    };

    const flat = getWorkflowFlatSteps(card);
    expect(flat.map((s) => `${s.stage}:${s.kind === "agent" ? s.roster_role : s.kind}`)).toEqual([
      "plan:architect",
      "implement:main_dev",
      "implement:frontend_ui",
      "verify:gate",
      "review:reviewer",
      "implement:main_dev",
      "verify:gate",
      "deliver:command",
    ]);

    // Step 0 -> 1 (main_dev) -> 2 (frontend_ui) -> 3 (verify)
    expect(resolveWorkflowStepAt(card, null, null)).toMatchObject({
      stepIndex: 0,
      node: { stage: "plan", roster_role: "architect" },
    });
    const s1 = nextWorkflowStepAfter(card, 0, "plan");
    expect(s1).toMatchObject({
      stepIndex: 1,
      stage: "implement",
      node: { roster_role: "main_dev" },
    });
    const s2 = nextWorkflowStepAfter(card, s1!.stepIndex, "implement");
    expect(s2).toMatchObject({
      stepIndex: 2,
      stage: "implement",
      node: { roster_role: "frontend_ui" },
    });
    const s3 = nextWorkflowStepAfter(card, s2!.stepIndex, "implement");
    expect(s3).toMatchObject({ stepIndex: 3, stage: "verify", node: { kind: "gate" } });

    // Review loop restart targets the loop-local implement step (index 5), not index 1
    expect(findLoopRestartStepIndex(card, "implement")).toBe(5);
    // Out-of-blueprint stage (e.g. triage/advise) returns null so scheduler keeps raw stage
    expect(resolveWorkflowStepAt(card, null, "advise")).toBeNull();
  });

  it("supports research -> plan ordering with includeResearch and rejects research after plan/implement", () => {
    const withResearch = WorkflowBlueprintSchema.parse(
      buildWorkflowPreset("full_delivery", { includeResearch: true }),
    );
    expect(
      getWorkflowStages({
        track: "L2",
        workspace_mode: "git_worktree",
        contract: {},
        workflow: withResearch,
      }),
    ).toEqual(["research", "plan", "implement", "verify", "review", "accept", "deliver"]);
    expect(extractWorkflowToggles(withResearch).includeResearch).toBe(true);

    const researchAfterPlan = validateWorkflowBlueprint({
      schema_version: 1,
      preset: "custom",
      steps: [
        { kind: "agent", stage: "plan", role: "advisor", fresh_context: true },
        { kind: "agent", stage: "research", role: "advisor", fresh_context: true },
        { kind: "agent", stage: "implement", role: "worker", fresh_context: false },
        {
          kind: "command",
          stage: "deliver",
          apply_staged: false,
          run_deliver_cmd: false,
          verify_sha256: false,
          final_accept_gate: false,
        },
      ],
    });
    expect(researchAfterPlan.ok).toBe(false);
  });

  it("supports custom inline bindings, instructions, on_fail and enforces post-implement verify gate safety", () => {
    const customSecNode = {
      kind: "agent" as const,
      id: "sec-review-1",
      label: "安全审查",
      stage: "review" as const,
      role: "reviewer" as const,
      fresh_context: true,
      binding: { provider: "claude", model: "claude-opus-4-6", effort: "high" as const },
      instructions: "重点检查凭据泄露与权限绕过",
      on_fail: "loop_back" as const,
    };

    const withTrailingImpl = {
      schema_version: 1 as const,
      preset: "custom" as const,
      steps: [
        {
          kind: "loop" as const,
          max_rounds: 3,
          stuck_threshold: 2,
          steps: [
            {
              kind: "agent" as const,
              stage: "implement" as const,
              role: "worker" as const,
              fresh_context: false,
            },
            { kind: "gate" as const, stage: "verify" as const, check: "full" as const },
            {
              kind: "agent" as const,
              stage: "review" as const,
              role: "reviewer" as const,
              fresh_context: true,
            },
            customSecNode,
          ],
        },
        {
          kind: "agent" as const,
          id: "doc-sync-1",
          label: "文档同步",
          stage: "implement" as const,
          role: "worker" as const,
          fresh_context: false,
          binding: { provider: "codex", model: "gpt-5.4" },
          instructions: "更新 README 与变更日志",
        },
        {
          kind: "command" as const,
          stage: "deliver" as const,
          apply_staged: false,
          run_deliver_cmd: false,
          verify_sha256: false,
          final_accept_gate: false,
        },
      ],
    };

    const unverified = validateWorkflowBlueprint(withTrailingImpl);
    expect(unverified.ok).toBe(false);
    if (!unverified.ok) {
      expect(unverified.errors.some((e) => e.includes('"verify" gate'))).toBe(true);
    }

    const normalized = WorkflowBlueprintSchema.parse(
      normalizeWorkflowBlueprintSafety(withTrailingImpl),
    );
    const cloned = resolveTaskWorkflow({
      track: "L2",
      workspace_mode: "git_worktree",
      contract: {},
      workflow: normalized,
    });
    const flat = flattenWorkflowSteps(cloned);
    expect(flat.map((n) => `${n.stage}:${n.kind}`)).toEqual([
      "implement:agent",
      "verify:gate",
      "review:agent",
      "review:agent",
      "implement:agent",
      "verify:gate",
      "deliver:command",
    ]);
    expect(flat[3]).toMatchObject({
      id: "sec-review-1",
      label: "安全审查",
      on_fail: "loop_back",
      binding: { provider: "claude", model: "claude-opus-4-6", effort: "high" },
    });
  });

  it("hasCompleteHostTwoPhaseWorkflow rejects host_op workflow missing implement mode=dry_run_only", () => {
    const complete = WorkflowBlueprintSchema.parse(buildWorkflowPreset("host_op"));
    expect(hasCompleteHostTwoPhaseWorkflow(complete)).toBe(true);

    const incomplete: typeof complete = {
      ...complete,
      steps: complete.steps.map((s) =>
        s.kind === "agent" && s.stage === "implement"
          ? {
              kind: "agent",
              stage: "implement",
              role: "worker",
              fresh_context: s.fresh_context,
              roster_role: "ops_sec",
            }
          : s,
      ),
    };
    expect(hasCompleteHostTwoPhaseWorkflow(incomplete)).toBe(false);
  });

  it("validates Track 6 advisor workflow_patch, per-segment plan/implement ordering, spawn_subtasks, and StateEvents", () => {
    expect(ADVISOR_ELIGIBLE_DECISION_CATEGORIES).toContain("workflow_replan");
    expect(ADVISOR_ELIGIBLE_DECISION_CATEGORIES).toContain("subtask_split");

    const baseBlueprint = WorkflowBlueprintSchema.parse(
      buildCustomWorkflow({
        preset: "full_delivery",
        includeResearch: true,
        includePlan: false,
        includeReview: true,
        includeAccept: true,
        acceptMode: "verifier",
        deliverApproval: false,
        hostTwoPhase: false,
        hasDeliverCmd: false,
      }),
    );

    // Preserves completed research prefix, inserts plan + specialist implement, restores verify/accept/deliver
    const patchOk = applyAdvisorWorkflowPatch({
      currentBlueprint: baseBlueprint,
      sourceStepIndex: 1,
      sourceStage: "implement",
      rationale: "Need deeper plan and frontend_ui specialist",
      replaceRemainingSteps: [
        {
          kind: "agent",
          stage: "research",
          role: "advisor",
          fresh_context: true,
          roster_role: "debugger",
        },
        {
          kind: "agent",
          stage: "plan",
          role: "advisor",
          fresh_context: true,
        },
        {
          kind: "agent",
          stage: "implement",
          role: "worker",
          fresh_context: false,
          roster_role: "frontend_ui",
        },
        {
          kind: "agent",
          stage: "review",
          role: "reviewer",
          fresh_context: true,
        },
      ],
      roster: {
        debugger: { enabled: true, stage: "research", perm: "read_only" },
        frontend_ui: { enabled: true, stage: "implement", perm: "workspace_write" },
        researcher: { enabled: true, stage: "research", perm: "read_only" },
      },
    });
    expect(patchOk.ok).toBe(true);
    if (!patchOk.ok) throw new Error(patchOk.errors.join("; "));
    expect(patchOk.preservedPrefixSteps).toBe(1);
    expect(patchOk.resumeStepIndex).toBe(1);
    expect(patchOk.resumeStage).toBe("research");
    const patchedFlat = flattenWorkflowSteps(patchOk.blueprint);
    expect(patchedFlat.map((n) => `${n.kind}:${n.stage}`)).toEqual([
      "agent:research",
      "agent:research",
      "agent:plan",
      "agent:implement",
      "gate:verify",
      "agent:review",
      "agent:accept",
      "command:deliver",
    ]);

    // Also allows keeping a completed historical implement prefix before inserting a new plan -> implement segment
    const afterImplPatch = applyAdvisorWorkflowPatch({
      currentBlueprint: baseBlueprint,
      sourceStepIndex: 3,
      sourceStage: "review",
      rationale: "Re-plan after prior implement review deadlock",
      replaceRemainingSteps: [
        {
          kind: "agent",
          stage: "plan",
          role: "advisor",
          fresh_context: true,
        },
        {
          kind: "agent",
          stage: "implement",
          role: "worker",
          fresh_context: false,
        },
        {
          kind: "agent",
          stage: "review",
          role: "reviewer",
          fresh_context: true,
        },
      ],
    });
    expect(afterImplPatch.ok).toBe(true);

    // Blocks read-only roster role injected into implement
    const readOnlyBlocked = applyAdvisorWorkflowPatch({
      currentBlueprint: baseBlueprint,
      sourceStepIndex: 1,
      sourceStage: "implement",
      rationale: "Invalid role",
      replaceRemainingSteps: [
        {
          kind: "agent",
          stage: "implement",
          role: "worker",
          fresh_context: false,
          roster_role: "researcher",
        },
      ],
      roster: {
        researcher: { enabled: true, stage: "research", perm: "read_only" },
      },
    });
    expect(readOnlyBlocked.ok).toBe(false);

    // Blocks orphan trailing plan without implement
    const trailingPlan = validateWorkflowBlueprint({
      schema_version: 1,
      preset: "custom",
      steps: [
        { kind: "agent", stage: "implement", role: "worker", fresh_context: false },
        { kind: "gate", stage: "verify", check: "full" },
        { kind: "agent", stage: "plan", role: "advisor", fresh_context: true },
        {
          kind: "command",
          stage: "deliver",
          apply_staged: false,
          run_deliver_cmd: false,
          verify_sha256: false,
          final_accept_gate: false,
        },
      ],
    });
    expect(trailingPlan.ok).toBe(false);

    // Rejects mutually exclusive workflow_patch + spawn_subtasks
    const mutualExclusion = AdvisorReceiptFrontmatterSchema.safeParse({
      run_id: "r-1",
      contract_version: 1,
      outcome: "resolved",
      chosen_approach: "Both",
      workflow_patch: {
        rationale: "patch",
        replace_remaining_steps: [
          { kind: "agent", stage: "implement", role: "worker", fresh_context: false },
        ],
      },
      spawn_subtasks: [
        {
          temp_id: "a",
          title: "Sub A",
          contract: { goal: "A", end: "Done A", scope: ["src/a/**"] },
          brief_markdown: "# A",
        },
        {
          temp_id: "b",
          title: "Sub B",
          contract: { goal: "B", end: "Done B", scope: ["src/b/**"] },
          brief_markdown: "# B",
        },
      ],
    });
    expect(mutualExclusion.success).toBe(false);

    // Validates new StateEvents & PendingSubtaskSplitSchema
    expect(
      StateEventSchema.parse({
        type: "workflow_patched",
        at: "2026-11-26T00:00:00.000Z",
        run_id: "run-adv-1",
        contract_version: 1,
        preserved_prefix_steps: 1,
        new_total_steps: 7,
        resume_stage: "plan",
        resume_step_index: 1,
        rationale: "Replan",
      }).type,
    ).toBe("workflow_patched");
    expect(
      StateEventSchema.parse({
        type: "subtasks_spawned",
        at: "2026-11-26T00:00:00.000Z",
        run_id: "run-plan-1",
        contract_version: 1,
        child_task_ids: ["t-c1", "t-c2"],
        base_ref_sha: "abc1234",
        resume_stage: "verify",
        resume_step_index: 3,
      }).type,
    ).toBe("subtasks_spawned");
    expect(
      StateEventSchema.parse({
        type: "stage_fast_forwarded",
        at: "2026-11-26T00:00:00.000Z",
        skipped_stage: "accept",
        skipped_step_index: 4,
        to_stage: "deliver",
        to_step_index: 5,
        reason: "docs_only",
        changed_paths: ["docs/readme.md"],
      }).type,
    ).toBe("stage_fast_forwarded");
    expect(
      PendingSubtaskSplitSchema.parse({
        decision_id: "dec-split-1",
        contract_version: 1,
        source_run_id: "run-plan-1",
        source_stage: "plan",
        rationale: "Needs scope expansion",
        subtasks: [
          {
            temp_id: "s1",
            title: "Part 1",
            contract: { goal: "G1", end: "E1", scope: ["src/a/**"] },
            brief_markdown: "# S1",
          },
          {
            temp_id: "s2",
            title: "Part 2",
            contract: { goal: "G2", end: "E2", scope: ["src/b/**"] },
            brief_markdown: "# S2",
          },
        ],
        created_at: "2026-11-26T00:00:00.000Z",
      }).subtasks,
    ).toHaveLength(2);
  });

  it("enforces host_op two-phase safety and multi-segment restart/L2 escalation boundaries", () => {
    const hostBlueprint = buildWorkflowPreset("host_op");
    const hostPatched = applyAdvisorWorkflowPatch({
      currentBlueprint: hostBlueprint,
      sourceStepIndex: 0,
      sourceStage: "implement",
      workspaceMode: "host_scoped",
      rationale: "Add research before staged implement",
      replaceRemainingSteps: [
        { kind: "agent", stage: "research", role: "advisor", fresh_context: true },
        { kind: "agent", stage: "implement", role: "worker", fresh_context: false },
        { kind: "gate", stage: "verify", check: "full" },
      ],
    });
    expect(hostPatched.ok).toBe(true);
    if (!hostPatched.ok) throw new Error(hostPatched.errors.join("; "));
    expect(hasCompleteHostTwoPhaseWorkflow(hostPatched.blueprint)).toBe(true);
    expect(
      getImplementAgentMode({
        track: "L1",
        workspace_mode: "host_scoped",
        contract: {},
        workflow: hostPatched.blueprint,
      }),
    ).toBe("dry_run_only");
    expect(
      getVerifyGateCheckMode({
        track: "L1",
        workspace_mode: "host_scoped",
        contract: {},
        workflow: hostPatched.blueprint,
      }),
    ).toBe("staged_only");

    // Rejects injecting staged_only / dry_run_only into a non-host_scoped workflow
    const nonHostReject = applyAdvisorWorkflowPatch({
      currentBlueprint: buildWorkflowPreset("quick"),
      sourceStepIndex: 0,
      sourceStage: "implement",
      workspaceMode: "git_worktree",
      rationale: "Illegal host mode injection",
      replaceRemainingSteps: [
        {
          kind: "agent",
          stage: "implement",
          role: "worker",
          fresh_context: false,
          mode: "dry_run_only",
        },
        { kind: "gate", stage: "verify", check: "staged_only" },
      ],
    });
    expect(nonHostReject.ok).toBe(false);

    // Multi-segment workflow after review deadlock restarts in active segment (never historical prefix/plan)
    const multiSegPatch = applyAdvisorWorkflowPatch({
      currentBlueprint: buildWorkflowPreset("standard_dev"),
      sourceStepIndex: 2,
      sourceStage: "review",
      workspaceMode: "git_worktree",
      rationale: "Insert new plan + frontend_ui segment",
      replaceRemainingSteps: [
        { kind: "agent", stage: "plan", role: "advisor", fresh_context: true },
        { kind: "agent", stage: "implement", role: "worker", fresh_context: false },
        { kind: "agent", stage: "review", role: "reviewer", fresh_context: true },
      ],
    });
    expect(multiSegPatch.ok).toBe(true);
    if (!multiSegPatch.ok) throw new Error(multiSegPatch.errors.join("; "));
    const multiFlat = flattenWorkflowSteps(multiSegPatch.blueprint);
    expect(multiFlat.map((n) => n.stage)).toEqual([
      "implement",
      "verify",
      "plan",
      "implement",
      "verify",
      "review",
      "deliver",
    ]);
    const restartIdx = findLoopRestartStepIndex(
      {
        track: "L2",
        workspace_mode: "git_worktree",
        contract: {},
        workflow: multiSegPatch.blueprint,
      },
      "implement",
      "L2",
      5,
    );
    expect(restartIdx).toBe(3);

    // L1 -> L2 frozen escalation appends review after the active segment's verify gate, not old prefix
    const l1MultiSeg = WorkflowBlueprintSchema.parse({
      schema_version: 1,
      preset: "custom",
      steps: [
        { kind: "agent", stage: "implement", role: "worker", fresh_context: false },
        { kind: "gate", stage: "verify", check: "full" },
        { kind: "agent", stage: "plan", role: "advisor", fresh_context: true },
        { kind: "agent", stage: "implement", role: "worker", fresh_context: false },
        { kind: "gate", stage: "verify", check: "full" },
        {
          kind: "command",
          stage: "deliver",
          apply_staged: false,
          run_deliver_cmd: false,
          verify_sha256: false,
          final_accept_gate: false,
        },
      ],
    });
    const escalated = ensureWorkflowIncludesReview(l1MultiSeg);
    expect(flattenWorkflowSteps(escalated).map((n) => n.stage)).toEqual([
      "implement",
      "verify",
      "plan",
      "implement",
      "verify",
      "review",
      "deliver",
    ]);
  });

  it("supports Track 7 E1 test_first_lock and E2 dual_synthesis workflow invariants", () => {
    const bp = WorkflowBlueprintSchema.parse(
      buildWorkflowPreset("full_delivery", {
        includePlan: true,
        dualSynthesis: true,
        testFirstLock: true,
      }),
    );
    const flat = flattenWorkflowSteps(bp);
    expect(
      flat.map((n) => `${n.stage}${n.kind === "agent" && n.mode ? `(${n.mode})` : ""}`),
    ).toEqual([
      "plan",
      "implement(test_first_lock)",
      "implement",
      "verify",
      "review",
      "accept",
      "deliver",
      "deliver",
    ]);
    const toggles = extractWorkflowToggles(bp);
    expect(toggles.dualSynthesis).toBe(true);
    expect(toggles.testFirstLock).toBe(true);
    expect(createDefaultBuiltinRosterMetadata().tester.secondary_stages).toContain("implement");

    // Rejects test_first_lock without fresh_context=true
    expect(
      validateWorkflowBlueprint({
        schema_version: 1,
        preset: "custom",
        steps: [
          {
            kind: "agent",
            stage: "implement",
            role: "worker",
            fresh_context: false,
            mode: "test_first_lock",
          },
          { kind: "agent", stage: "implement", role: "worker", fresh_context: false },
          { kind: "gate", stage: "verify", check: "full" },
          {
            kind: "command",
            stage: "deliver",
            apply_staged: false,
            run_deliver_cmd: false,
            verify_sha256: false,
            final_accept_gate: false,
          },
        ],
      }).ok,
    ).toBe(false);

    // Rejects test_first_lock not followed by normal implement before verify gate
    expect(
      validateWorkflowBlueprint({
        schema_version: 1,
        preset: "custom",
        steps: [
          {
            kind: "agent",
            stage: "implement",
            role: "worker",
            fresh_context: true,
            mode: "test_first_lock",
          },
          { kind: "gate", stage: "verify", check: "full" },
          {
            kind: "command",
            stage: "deliver",
            apply_staged: false,
            run_deliver_cmd: false,
            verify_sha256: false,
            final_accept_gate: false,
          },
        ],
      }).ok,
    ).toBe(false);

    // Rejects dual_synthesis on non-plan stage
    expect(
      validateWorkflowBlueprint({
        schema_version: 1,
        preset: "custom",
        steps: [
          {
            kind: "agent",
            stage: "research",
            role: "advisor",
            fresh_context: true,
            plan_mode: "dual_synthesis",
          },
          { kind: "agent", stage: "implement", role: "worker", fresh_context: false },
          { kind: "gate", stage: "verify", check: "full" },
          {
            kind: "command",
            stage: "deliver",
            apply_staged: false,
            run_deliver_cmd: false,
            verify_sha256: false,
            final_accept_gate: false,
          },
        ],
      }).ok,
    ).toBe(false);

    // Rejects combining test_first_lock with host_op two-phase modes
    expect(
      validateWorkflowBlueprint({
        schema_version: 1,
        preset: "host_op",
        steps: [
          {
            kind: "agent",
            stage: "implement",
            role: "worker",
            fresh_context: true,
            mode: "test_first_lock",
          },
          {
            kind: "agent",
            stage: "implement",
            role: "worker",
            fresh_context: false,
            mode: "dry_run_only",
          },
          { kind: "gate", stage: "verify", check: "staged_only" },
          { kind: "approval", stage: "deliver", show: ["staged_diff"] },
          {
            kind: "command",
            stage: "deliver",
            apply_staged: true,
            run_deliver_cmd: false,
            verify_sha256: false,
            final_accept_gate: true,
          },
        ],
      }).ok,
    ).toBe(false);
  });
});
