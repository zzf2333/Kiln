import { describe, expect, it } from "vitest";
import {
  WorkflowBlueprintSchema,
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
  nextWorkflowStepAfter,
  normalizeWorkflowBlueprintSafety,
  resolveTaskWorkflow,
  resolveWorkflowStepAt,
  validateWorkflowBlueprint,
} from "../workflow.js";

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
});
