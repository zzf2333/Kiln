import { describe, expect, it } from "vitest";
import {
  WorkflowBlueprintSchema,
  buildCustomWorkflow,
  buildWorkflowPreset,
  ensureWorkflowIncludesReview,
  extractWorkflowToggles,
  flattenWorkflowSteps,
  getDeliverCommandPolicy,
  getImplementAgentMode,
  getStageNodeKind,
  getVerifyGateCheckMode,
  getWorkflowLoopPolicy,
  getWorkflowStages,
  resolveTaskWorkflow,
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
  });
});
