import type { StageId, Track, WorkflowPreset, WorkspaceMode } from "./constants.js";

export const WORKFLOW_AGENT_STAGES = ["plan", "implement", "review", "accept"] as const;
export type WorkflowAgentStage = (typeof WORKFLOW_AGENT_STAGES)[number];

export const WORKFLOW_AGENT_ROLES = ["advisor", "worker", "reviewer", "verifier"] as const;
export type WorkflowAgentRole = (typeof WORKFLOW_AGENT_ROLES)[number];

export const WORKFLOW_APPROVAL_ITEMS = [
  "plan",
  "staged_diff",
  "commands",
  "report",
  "sha256",
] as const;
export type WorkflowApprovalItem = (typeof WORKFLOW_APPROVAL_ITEMS)[number];

export interface WorkflowAgentNode {
  kind: "agent";
  stage: WorkflowAgentStage;
  role: WorkflowAgentRole;
  fresh_context: boolean;
  mode?: "normal" | "dry_run_only";
}

export interface WorkflowGateNode {
  kind: "gate";
  stage: "verify";
  check: "full" | "staged_only";
}

export interface WorkflowApprovalNode {
  kind: "approval";
  stage: "accept" | "deliver";
  show: WorkflowApprovalItem[];
}

export interface WorkflowCommandNode {
  kind: "command";
  stage: "deliver";
  apply_staged: boolean;
  run_deliver_cmd: boolean;
  verify_sha256: boolean;
  final_accept_gate: boolean;
}

export type WorkflowAtomicNode =
  | WorkflowAgentNode
  | WorkflowGateNode
  | WorkflowApprovalNode
  | WorkflowCommandNode;

export interface WorkflowLoopNode {
  kind: "loop";
  max_rounds: number;
  stuck_threshold: number;
  steps: WorkflowAtomicNode[];
}

export type WorkflowStep = WorkflowAtomicNode | WorkflowLoopNode;

export interface WorkflowBlueprint {
  schema_version: 1;
  preset: WorkflowPreset;
  steps: WorkflowStep[];
}

export interface WorkflowCardLike {
  track: Track;
  workspace_mode: WorkspaceMode;
  contract: {
    human_accept?: boolean;
    deliver?: {
      mode: string;
      cmd?: string | null;
    };
  };
  workflow?: WorkflowBlueprint;
}

export interface WorkflowPresetOptions {
  humanAccept?: boolean;
  includePlan?: boolean;
  deliverApproval?: boolean;
  hasDeliverCmd?: boolean;
  maxRounds?: number;
  stuckThreshold?: number;
}

export interface ComposableWorkflowOptions {
  preset?: WorkflowPreset;
  includePlan: boolean;
  includeReview: boolean;
  includeAccept: boolean;
  acceptMode?: "verifier" | "approval";
  deliverApproval: boolean;
  hostTwoPhase: boolean;
  hasDeliverCmd: boolean;
  maxRounds?: number;
  stuckThreshold?: number;
}

const EXPECTED_ROLE_BY_STAGE: Readonly<Record<WorkflowAgentStage, WorkflowAgentRole>> = {
  plan: "advisor",
  implement: "worker",
  review: "reviewer",
  accept: "verifier",
};

const STAGE_SEQUENCE_ORDER: Readonly<Record<StageId, number>> = {
  intake: 0,
  plan: 1,
  research: 2,
  implement: 3,
  verify: 4,
  review: 5,
  accept: 6,
  triage: 7,
  advise: 8,
  deliver: 9,
};

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function cloneNode<T extends WorkflowStep>(step: T): T {
  if (step.kind === "loop") {
    return {
      ...step,
      steps: step.steps.map((inner) => cloneNode(inner)),
    };
  }
  if (step.kind === "approval") {
    return {
      ...step,
      show: [...step.show],
    };
  }
  return { ...step };
}

/**
 * Builds a validated composable `WorkflowBlueprint` from high-level step toggles.
 * Automatically inserts a pre-delivery `approval` gate when high-risk `command` actions
 * (`apply_staged` or `run_deliver_cmd`) are active so blueprint invariants always hold.
 */
export function buildCustomWorkflow(options: ComposableWorkflowOptions): WorkflowBlueprint {
  const steps: WorkflowStep[] = [];
  const hostTwoPhase = options.hostTwoPhase;
  const hasDeliverCmd = options.hasDeliverCmd;
  const maxRounds = clampInt(options.maxRounds, 1, 10, 3);
  const stuckThreshold = clampInt(options.stuckThreshold, 1, 5, 2);

  if (options.includePlan) {
    steps.push({
      kind: "agent",
      stage: "plan",
      role: "advisor",
      fresh_context: true,
    });
  }

  const implNode: WorkflowAgentNode = {
    kind: "agent",
    stage: "implement",
    role: "worker",
    fresh_context: false,
    ...(hostTwoPhase ? { mode: "dry_run_only" as const } : {}),
  };
  const gateNode: WorkflowGateNode = {
    kind: "gate",
    stage: "verify",
    check: hostTwoPhase ? "staged_only" : "full",
  };

  if (options.includeReview) {
    steps.push({
      kind: "loop",
      max_rounds: maxRounds,
      stuck_threshold: stuckThreshold,
      steps: [
        implNode,
        gateNode,
        {
          kind: "agent",
          stage: "review",
          role: "reviewer",
          fresh_context: true,
        },
      ],
    });
  } else {
    steps.push(implNode, gateNode);
  }

  if (options.includeAccept) {
    if (options.acceptMode === "approval") {
      steps.push({
        kind: "approval",
        stage: "accept",
        show: ["report"],
      });
    } else {
      steps.push({
        kind: "agent",
        stage: "accept",
        role: "verifier",
        fresh_context: true,
      });
    }
  }

  const needsDeliverApproval = options.deliverApproval || hostTwoPhase || hasDeliverCmd;
  if (needsDeliverApproval) {
    const show: WorkflowApprovalItem[] = hostTwoPhase
      ? ["staged_diff", "commands", "sha256", "report"]
      : ["commands", "report"];
    steps.push({
      kind: "approval",
      stage: "deliver",
      show,
    });
  }

  steps.push({
    kind: "command",
    stage: "deliver",
    apply_staged: hostTwoPhase,
    run_deliver_cmd: hasDeliverCmd,
    verify_sha256: hostTwoPhase,
    final_accept_gate: hostTwoPhase,
  });

  return {
    schema_version: 1,
    preset: options.preset ?? "custom",
    steps,
  };
}

/**
 * Generates one of the four curated preset blueprints (`quick`, `host_op`, `standard_dev`, `full_delivery`).
 */
export function buildWorkflowPreset(
  preset: Exclude<WorkflowPreset, "custom">,
  options: WorkflowPresetOptions = {},
): WorkflowBlueprint {
  switch (preset) {
    case "quick":
      return buildCustomWorkflow({
        preset: "quick",
        includePlan: options.includePlan ?? false,
        includeReview: false,
        includeAccept: options.humanAccept ?? false,
        acceptMode: "approval",
        deliverApproval: options.deliverApproval ?? false,
        hostTwoPhase: false,
        hasDeliverCmd: options.hasDeliverCmd ?? false,
        maxRounds: options.maxRounds,
        stuckThreshold: options.stuckThreshold,
      });
    case "host_op":
      return buildCustomWorkflow({
        preset: "host_op",
        includePlan: options.includePlan ?? false,
        includeReview: false,
        includeAccept: false,
        deliverApproval: true,
        hostTwoPhase: true,
        hasDeliverCmd: options.hasDeliverCmd ?? false,
        maxRounds: options.maxRounds,
        stuckThreshold: options.stuckThreshold,
      });
    case "standard_dev":
      return buildCustomWorkflow({
        preset: "standard_dev",
        includePlan: options.includePlan ?? false,
        includeReview: true,
        includeAccept: options.humanAccept ?? false,
        acceptMode: "approval",
        deliverApproval: options.deliverApproval ?? false,
        hostTwoPhase: false,
        hasDeliverCmd: options.hasDeliverCmd ?? false,
        maxRounds: options.maxRounds ?? 3,
        stuckThreshold: options.stuckThreshold ?? 2,
      });
    case "full_delivery":
      return buildCustomWorkflow({
        preset: "full_delivery",
        includePlan: options.includePlan ?? true,
        includeReview: true,
        includeAccept: true,
        acceptMode: "verifier",
        deliverApproval: options.deliverApproval ?? true,
        hostTwoPhase: false,
        hasDeliverCmd: options.hasDeliverCmd ?? false,
        maxRounds: options.maxRounds ?? 3,
        stuckThreshold: options.stuckThreshold ?? 2,
      });
  }
}

/**
 * Flattens top-level atomic nodes and `loop.steps` into linear execution order.
 */
export function flattenWorkflowSteps(blueprint: WorkflowBlueprint): WorkflowAtomicNode[] {
  const flat: WorkflowAtomicNode[] = [];
  for (const step of blueprint.steps) {
    if (step.kind === "loop") {
      for (const inner of step.steps) {
        flat.push(inner);
      }
    } else {
      flat.push(step);
    }
  }
  return flat;
}

/**
 * Extracts high-level UI toggles back from an arbitrary `WorkflowBlueprint`.
 */
export function extractWorkflowToggles(blueprint: WorkflowBlueprint): ComposableWorkflowOptions {
  const flat = flattenWorkflowSteps(blueprint);
  const loopNode = blueprint.steps.find((s): s is WorkflowLoopNode => s.kind === "loop");
  const acceptAgent = flat.find((n) => n.kind === "agent" && n.stage === "accept");
  const acceptApproval = flat.find((n) => n.kind === "approval" && n.stage === "accept");
  const gateNode = flat.find((n): n is WorkflowGateNode => n.kind === "gate");
  const commandNode = flat.find((n): n is WorkflowCommandNode => n.kind === "command");
  const deliverApprovalNode = flat.find((n) => n.kind === "approval" && n.stage === "deliver");

  return {
    preset: blueprint.preset,
    includePlan: flat.some((n) => n.kind === "agent" && n.stage === "plan"),
    includeReview: flat.some((n) => n.kind === "agent" && n.stage === "review"),
    includeAccept: Boolean(acceptAgent || acceptApproval),
    acceptMode: acceptAgent ? "verifier" : "approval",
    deliverApproval: Boolean(deliverApprovalNode),
    hostTwoPhase:
      gateNode?.check === "staged_only" ||
      Boolean(commandNode?.apply_staged || commandNode?.final_accept_gate),
    hasDeliverCmd: Boolean(commandNode?.run_deliver_cmd),
    ...(loopNode
      ? {
          maxRounds: loopNode.max_rounds,
          stuckThreshold: loopNode.stuck_threshold,
        }
      : {}),
  };
}

/**
 * Enforces structural & safety invariants on a composable workflow blueprint without Zod.
 */
export function validateWorkflowBlueprint(
  blueprint: WorkflowBlueprint,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (!Array.isArray(blueprint.steps) || blueprint.steps.length === 0) {
    errors.push("Workflow blueprint steps must contain at least one step");
    return { ok: false, errors };
  }

  for (let i = 0; i < blueprint.steps.length; i++) {
    const step = blueprint.steps[i]!;
    if (step.kind === "loop") {
      if (!Number.isInteger(step.max_rounds) || step.max_rounds < 1 || step.max_rounds > 10) {
        errors.push(`loop.max_rounds at steps[${i}] must be an integer between 1 and 10`);
      }
      if (
        !Number.isInteger(step.stuck_threshold) ||
        step.stuck_threshold < 1 ||
        step.stuck_threshold > 5
      ) {
        errors.push(`loop.stuck_threshold at steps[${i}] must be an integer between 1 and 5`);
      }
      if (!Array.isArray(step.steps) || step.steps.length === 0) {
        errors.push(`loop.steps at steps[${i}] must be non-empty`);
      } else {
        let loopHasImplement = false;
        for (let j = 0; j < step.steps.length; j++) {
          const inner = step.steps[j] as WorkflowStep;
          if (inner.kind === "loop") {
            errors.push(`Nested loop at steps[${i}].steps[${j}] is forbidden`);
          } else if (inner.kind === "agent" && inner.stage === "implement") {
            loopHasImplement = true;
          }
        }
        if (!loopHasImplement) {
          errors.push(`loop at steps[${i}] must contain an implement stage agent node`);
        }
      }
    }
  }

  const flat = flattenWorkflowSteps(blueprint);
  let hasImplement = false;
  let seenDeliverApproval = false;
  let seenStagedOnlyGate = false;
  let seenFinalAcceptGateAfterStaged = false;
  let maxStageRankSeen = -1;
  let seenPlanRank = -1;
  let firstImplementIdx = -1;

  for (let i = 0; i < flat.length; i++) {
    const node = flat[i]!;
    if (node.kind === "agent") {
      const expectedRole = EXPECTED_ROLE_BY_STAGE[node.stage];
      if (node.role !== expectedRole) {
        errors.push(
          `Agent node stage "${node.stage}" requires role "${expectedRole}", got "${node.role}"`,
        );
      }
      if ((expectedRole !== "worker" || node.role !== "worker") && !node.fresh_context) {
        errors.push(
          `Stage "${node.stage}" (role "${node.role}") at node[${i}] must run with fresh_context=true`,
        );
      }
      if (node.stage === "implement") {
        hasImplement = true;
        if (firstImplementIdx === -1) {
          firstImplementIdx = i;
        }
      }
      if (node.stage === "plan") {
        seenPlanRank = i;
      }
    } else if (node.kind === "gate") {
      if (node.check === "staged_only") {
        seenStagedOnlyGate = true;
      }
    } else if (node.kind === "approval") {
      if (node.stage === "deliver") {
        seenDeliverApproval = true;
      }
    } else if (node.kind === "command") {
      if ((node.apply_staged || node.run_deliver_cmd) && !seenDeliverApproval) {
        errors.push(
          "High-risk deliver command (apply_staged or run_deliver_cmd) requires a preceding deliver approval node",
        );
      }
      if (seenStagedOnlyGate && node.final_accept_gate) {
        seenFinalAcceptGateAfterStaged = true;
      }
    }

    const stageRank = STAGE_SEQUENCE_ORDER[node.stage];
    if (maxStageRankSeen >= STAGE_SEQUENCE_ORDER.deliver && node.stage !== "deliver") {
      errors.push(`Stage "${node.stage}" cannot appear after deliver stage`);
    }
    if (stageRank > maxStageRankSeen) {
      maxStageRankSeen = stageRank;
    }
  }

  if (!hasImplement) {
    errors.push('Workflow blueprint must contain at least one "implement" agent node');
  }
  if (seenPlanRank !== -1 && firstImplementIdx !== -1 && seenPlanRank > firstImplementIdx) {
    errors.push('Stage "plan" must appear before "implement"');
  }
  if (seenStagedOnlyGate && !seenFinalAcceptGateAfterStaged) {
    errors.push(
      'Gate check="staged_only" requires a subsequent command node with final_accept_gate=true',
    );
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Resolves a task card's effective `WorkflowBlueprint`.
 * Cards without `card.workflow` map deterministically to legacy `L1`/`L2` pipelines
 * (preserving `verify(full)` even for legacy `host_scoped` cards).
 */
export function resolveTaskWorkflow(card: WorkflowCardLike): WorkflowBlueprint {
  if (card.workflow) {
    return {
      ...card.workflow,
      steps: card.workflow.steps.map((s) => cloneNode(s)),
    };
  }

  const humanAccept = Boolean(card.contract.human_accept);
  const hasDeliverCmd = card.contract.deliver?.mode === "run_cmd";

  if (card.track === "L1") {
    return buildCustomWorkflow({
      preset: "quick",
      includePlan: false,
      includeReview: false,
      includeAccept: humanAccept,
      acceptMode: "verifier",
      deliverApproval: hasDeliverCmd,
      hostTwoPhase: false,
      hasDeliverCmd,
    });
  }

  return buildCustomWorkflow({
    preset: "standard_dev",
    includePlan: false,
    includeReview: true,
    includeAccept: humanAccept,
    acceptMode: "verifier",
    deliverApproval: hasDeliverCmd,
    hostTwoPhase: false,
    hasDeliverCmd,
  });
}

/**
 * Inserts an independent `review` agent node into a blueprint if absent
 * (used when an L1 task is escalated to L2 due to frozen test edits).
 */
export function ensureWorkflowIncludesReview(blueprint: WorkflowBlueprint): WorkflowBlueprint {
  const flat = flattenWorkflowSteps(blueprint);
  if (flat.some((n) => n.kind === "agent" && n.stage === "review")) {
    return {
      ...blueprint,
      steps: blueprint.steps.map((s) => cloneNode(s)),
    };
  }

  const reviewNode: WorkflowAgentNode = {
    kind: "agent",
    stage: "review",
    role: "reviewer",
    fresh_context: true,
  };

  const nextSteps: WorkflowStep[] = blueprint.steps.map((s) => cloneNode(s));
  for (let i = 0; i < nextSteps.length; i++) {
    const step = nextSteps[i]!;
    if (step.kind === "loop") {
      const idx = step.steps.findIndex((n) => n.kind === "gate" || n.stage === "implement");
      const insertAt = idx >= 0 ? idx + 1 : step.steps.length;
      step.steps.splice(insertAt, 0, reviewNode);
      return { ...blueprint, steps: nextSteps };
    }
  }

  const verifyOrImplIdx = nextSteps.findIndex(
    (s) => s.kind === "gate" || (s.kind === "agent" && s.stage === "implement"),
  );
  let insertAt = verifyOrImplIdx >= 0 ? verifyOrImplIdx + 1 : nextSteps.length;
  // Insert after verify gate if implement came immediately before verify gate.
  if (
    verifyOrImplIdx >= 0 &&
    nextSteps[verifyOrImplIdx]?.kind === "agent" &&
    nextSteps[verifyOrImplIdx + 1]?.kind === "gate"
  ) {
    insertAt = verifyOrImplIdx + 2;
  }
  nextSteps.splice(insertAt, 0, reviewNode);
  return {
    ...blueprint,
    steps: nextSteps,
  };
}

/**
 * Computes ordered unique execution `StageId[]` from the resolved blueprint
 * (excluding `"intake"`, preserving stage order, and injecting `"review"` on L1->L2 escalation).
 */
export function getWorkflowStages(card: WorkflowCardLike, effectiveTrack?: Track): StageId[] {
  const resolved = resolveTaskWorkflow(card);
  const flat = flattenWorkflowSteps(resolved);
  const stages: StageId[] = [];
  for (const node of flat) {
    if (!stages.includes(node.stage)) {
      stages.push(node.stage);
    }
  }

  const targetTrack = effectiveTrack ?? card.track;
  if (card.track === "L1" && targetTrack === "L2" && !stages.includes("review")) {
    const verifyIdx = stages.indexOf("verify");
    const implIdx = stages.indexOf("implement");
    const insertAt = verifyIdx >= 0 ? verifyIdx + 1 : implIdx >= 0 ? implIdx + 1 : stages.length;
    stages.splice(insertAt, 0, "review");
  }

  return stages;
}

export function getWorkflowLoopPolicy(
  card: WorkflowCardLike,
): { maxRounds: number; stuckThreshold: number } | null {
  if (!card.workflow) {
    return null;
  }
  const loopNode = card.workflow.steps.find((s): s is WorkflowLoopNode => s.kind === "loop");
  if (!loopNode) {
    return null;
  }
  return {
    maxRounds: loopNode.max_rounds,
    stuckThreshold: loopNode.stuck_threshold,
  };
}

export function getVerifyGateCheckMode(card: WorkflowCardLike): "full" | "staged_only" {
  const flat = flattenWorkflowSteps(resolveTaskWorkflow(card));
  const gateNode = flat.find((n): n is WorkflowGateNode => n.kind === "gate");
  return gateNode?.check ?? "full";
}

export function getImplementAgentMode(card: WorkflowCardLike): "normal" | "dry_run_only" {
  const flat = flattenWorkflowSteps(resolveTaskWorkflow(card));
  const implNode = flat.find(
    (n): n is WorkflowAgentNode => n.kind === "agent" && n.stage === "implement",
  );
  return implNode?.mode ?? "normal";
}

export function getStageNodeKind(
  card: WorkflowCardLike,
  stage: StageId,
): WorkflowAtomicNode["kind"] | null {
  const flat = flattenWorkflowSteps(resolveTaskWorkflow(card));
  if (stage === "deliver") {
    const cmd = flat.find((n) => n.kind === "command" && n.stage === "deliver");
    if (cmd) return "command";
  }
  const matches = flat.filter((n) => n.stage === stage);
  if (matches.length === 0) {
    return null;
  }
  return matches[matches.length - 1]!.kind;
}

export function getDeliverCommandPolicy(card: WorkflowCardLike): {
  hasCommandNode: boolean;
  applyStaged: boolean;
  runDeliverCmd: boolean;
  verifySha256: boolean;
  finalAcceptGate: boolean;
  requiresDeliverApproval: boolean;
} {
  const hasExplicitWorkflow = card.workflow !== undefined;
  if (!hasExplicitWorkflow) {
    return {
      hasCommandNode: false,
      applyStaged: false,
      runDeliverCmd: card.contract.deliver?.mode === "run_cmd",
      verifySha256: false,
      finalAcceptGate: false,
      requiresDeliverApproval: false,
    };
  }

  const flat = flattenWorkflowSteps(card.workflow!);
  const cmdNode = flat.find((n): n is WorkflowCommandNode => n.kind === "command");
  const hasDeliverApproval = flat.some(
    (n) => n.kind === "approval" && n.stage === "deliver",
  );

  return {
    hasCommandNode: Boolean(cmdNode),
    applyStaged: Boolean(cmdNode?.apply_staged),
    runDeliverCmd:
      Boolean(cmdNode?.run_deliver_cmd) || card.contract.deliver?.mode === "run_cmd",
    verifySha256: Boolean(cmdNode?.verify_sha256),
    finalAcceptGate: Boolean(cmdNode?.final_accept_gate),
    requiresDeliverApproval: hasDeliverApproval,
  };
}
