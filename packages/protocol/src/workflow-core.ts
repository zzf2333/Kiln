import type {
  RosterPermission,
  StageId,
  Track,
  WorkflowPreset,
  WorkspaceMode,
} from "./constants.js";
import { isReadOnlyRosterPermission } from "./constants.js";

export const WORKFLOW_AGENT_STAGES = ["plan", "research", "implement", "review", "accept"] as const;
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
  roster_role?: string;
  rationale?: string;
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
  pm_rationale?: string;
}

export interface RosterPermissionLike {
  enabled: boolean;
  stage: StageId;
  secondary_stages?: readonly StageId[];
  perm: RosterPermission;
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
  includeResearch?: boolean;
  includePlan?: boolean;
  deliverApproval?: boolean;
  hasDeliverCmd?: boolean;
  maxRounds?: number;
  stuckThreshold?: number;
}

export interface ComposableWorkflowOptions {
  preset?: WorkflowPreset;
  includeResearch?: boolean;
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
  research: "advisor",
  implement: "worker",
  review: "reviewer",
  accept: "verifier",
};

const STAGE_SEQUENCE_ORDER: Readonly<Record<StageId, number>> = {
  intake: 0,
  research: 1,
  plan: 2,
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

  if (options.includeResearch) {
    steps.push({
      kind: "agent",
      stage: "research",
      role: "advisor",
      fresh_context: true,
    });
  }

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
        includeResearch: options.includeResearch ?? false,
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
        includeResearch: options.includeResearch ?? false,
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
        includeResearch: options.includeResearch ?? false,
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
        includeResearch: options.includeResearch ?? false,
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
    includeResearch: flat.some((n) => n.kind === "agent" && n.stage === "research"),
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
  let seenResearchIdx = -1;
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
      if (node.stage === "research" && seenResearchIdx === -1) {
        seenResearchIdx = i;
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
  if (seenResearchIdx !== -1 && seenPlanRank !== -1 && seenResearchIdx > seenPlanRank) {
    errors.push('Stage "research" must appear before "plan"');
  }
  if (seenResearchIdx !== -1 && firstImplementIdx !== -1 && seenResearchIdx > firstImplementIdx) {
    errors.push('Stage "research" must appear before "implement"');
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
  const flat = getWorkflowFlatSteps(card, effectiveTrack);
  const stages: StageId[] = [];
  for (const node of flat) {
    if (!stages.includes(node.stage)) {
      stages.push(node.stage);
    }
  }
  return stages;
}

/**
 * Returns the full flattened sequence of atomic workflow steps (preserving multiple
 * same-stage steps such as consecutive specialist `implement` nodes and injecting
 * `review` if an L1 card escalated to L2 without one).
 */
export function getWorkflowFlatSteps(
  card: WorkflowCardLike,
  effectiveTrack?: Track,
): WorkflowAtomicNode[] {
  let resolved = resolveTaskWorkflow(card);
  const targetTrack = effectiveTrack ?? card.track;
  if (card.track === "L1" && targetTrack === "L2") {
    resolved = ensureWorkflowIncludesReview(resolved);
  }
  return flattenWorkflowSteps(resolved);
}

/**
 * Resolves the active atomic workflow node at `(stepIndex, fallbackStage)`.
 * Returns `null` when `fallbackStage` is outside the blueprint (e.g. `triage`/`advise`).
 */
export function resolveWorkflowStepAt(
  card: WorkflowCardLike,
  stepIndex: number | null,
  fallbackStage: StageId | null,
  effectiveTrack?: Track,
): { stepIndex: number; node: WorkflowAtomicNode } | null {
  const flat = getWorkflowFlatSteps(card, effectiveTrack);
  if (flat.length === 0) {
    return null;
  }

  if (
    stepIndex !== null &&
    Number.isInteger(stepIndex) &&
    stepIndex >= 0 &&
    stepIndex < flat.length
  ) {
    const candidate = flat[stepIndex]!;
    if (fallbackStage === null || candidate.stage === fallbackStage) {
      return { stepIndex, node: candidate };
    }
  }

  if (fallbackStage !== null) {
    const idx = flat.findIndex((n) => n.stage === fallbackStage);
    if (idx >= 0) {
      return { stepIndex: idx, node: flat[idx]! };
    }
    return null;
  }

  return { stepIndex: 0, node: flat[0]! };
}

/**
 * Resolves the next sequential workflow step after `(currentStepIndex, currentStage)`.
 */
export function nextWorkflowStepAfter(
  card: WorkflowCardLike,
  currentStepIndex: number | null,
  currentStage: StageId,
  effectiveTrack?: Track,
): { stepIndex: number; stage: StageId; node: WorkflowAtomicNode } | null {
  const flat = getWorkflowFlatSteps(card, effectiveTrack);
  const resolved = resolveWorkflowStepAt(card, currentStepIndex, currentStage, effectiveTrack);
  if (!resolved) {
    return null;
  }
  const nextIdx = resolved.stepIndex + 1;
  if (nextIdx >= flat.length) {
    return null;
  }
  const nextNode = flat[nextIdx]!;
  return {
    stepIndex: nextIdx,
    stage: nextNode.stage,
    node: nextNode,
  };
}

/**
 * Finds the step index to restart at when looping back (e.g. review -> implement),
 * preferring the first matching stage inside a `loop` block if one exists.
 */
export function findLoopRestartStepIndex(
  card: WorkflowCardLike,
  targetStage: StageId,
  effectiveTrack?: Track,
): number | null {
  let resolved = resolveTaskWorkflow(card);
  const targetTrack = effectiveTrack ?? card.track;
  if (card.track === "L1" && targetTrack === "L2") {
    resolved = ensureWorkflowIncludesReview(resolved);
  }

  let offset = 0;
  for (const step of resolved.steps) {
    if (step.kind === "loop") {
      for (let i = 0; i < step.steps.length; i++) {
        if (step.steps[i]!.stage === targetStage) {
          return offset + i;
        }
      }
      offset += step.steps.length;
    } else {
      offset += 1;
    }
  }

  const flat = flattenWorkflowSteps(resolved);
  const idx = flat.findIndex((n) => n.stage === targetStage);
  return idx >= 0 ? idx : null;
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
  const hasDeliverApproval = flat.some((n) => n.kind === "approval" && n.stage === "deliver");

  return {
    hasCommandNode: Boolean(cmdNode),
    applyStaged: Boolean(cmdNode?.apply_staged),
    runDeliverCmd: Boolean(cmdNode?.run_deliver_cmd) || card.contract.deliver?.mode === "run_cmd",
    verifySha256: Boolean(cmdNode?.verify_sha256),
    finalAcceptGate: Boolean(cmdNode?.final_accept_gate),
    requiresDeliverApproval: hasDeliverApproval,
  };
}

/**
 * Enforces blueprint structural invariants AND `D25` roster permission safety boundaries
 * (preventing PM selection from routing read-only roles to write stages or bypassing staging).
 */
export function validateBlueprintAgainstRoster(
  blueprint: WorkflowBlueprint,
  roster: Readonly<Record<string, RosterPermissionLike>>,
  options?: { workspaceMode?: WorkspaceMode },
): { ok: true } | { ok: false; errors: string[] } {
  const base = validateWorkflowBlueprint(blueprint);
  const errors: string[] = base.ok ? [] : [...base.errors];

  const flat = flattenWorkflowSteps(blueprint);
  for (let i = 0; i < flat.length; i++) {
    const node = flat[i]!;
    if (node.kind !== "agent" || !node.roster_role) {
      continue;
    }

    const entry = roster[node.roster_role];
    if (!entry) {
      errors.push(`Unknown roster_role "${node.roster_role}" at node[${i}]`);
      continue;
    }
    if (!entry.enabled) {
      errors.push(`Roster role "${node.roster_role}" at node[${i}] is disabled`);
    }

    const allowedStages = [entry.stage, ...(entry.secondary_stages ?? [])];
    if (!allowedStages.includes(node.stage)) {
      errors.push(
        `Roster role "${node.roster_role}" does not support stage "${node.stage}" (allowed: ${allowedStages.join(", ")})`,
      );
    }

    if (node.stage === "implement" && isReadOnlyRosterPermission(entry.perm)) {
      errors.push(
        `Read-only roster role "${node.roster_role}" (perm=${entry.perm}) cannot execute stage "implement"`,
      );
    }

    if (
      node.stage === "implement" &&
      entry.perm === "host_staged" &&
      options?.workspaceMode &&
      options.workspaceMode !== "host_scoped" &&
      node.mode !== "dry_run_only"
    ) {
      errors.push(
        `Roster role "${node.roster_role}" (perm=host_staged) requires workspaceMode="host_scoped" or mode="dry_run_only"`,
      );
    }

    if (node.stage === "review" && entry.perm === "workspace_write") {
      errors.push(
        `Write-capable roster role "${node.roster_role}" (perm=workspace_write) cannot execute read-only stage "review"`,
      );
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export interface SplitCardDagNode {
  temp_id: string;
  depends_on_temp_ids?: readonly string[];
}

/**
 * Validates split-card dependency graphs (duplicate IDs, missing refs, self-loops, DAG cycles)
 * and returns topological creation order (`order`).
 */
export function validateSplitCardsDag(
  cards: readonly SplitCardDagNode[],
): { ok: true; order: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set<string>();

  for (const card of cards) {
    const id = card.temp_id.trim();
    if (!id) {
      errors.push("Split card temp_id must be non-empty");
      continue;
    }
    if (ids.has(id)) {
      errors.push(`Duplicate split card temp_id "${id}"`);
      continue;
    }
    ids.add(id);
  }

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    inDegree.set(id, 0);
    dependents.set(id, []);
  }

  for (const card of cards) {
    const id = card.temp_id.trim();
    if (!ids.has(id)) continue;
    const seenDeps = new Set<string>();
    for (const rawDep of card.depends_on_temp_ids ?? []) {
      const dep = rawDep.trim();
      if (!dep) continue;
      if (dep === id) {
        errors.push(`Split card "${id}" cannot depend on itself`);
        continue;
      }
      if (!ids.has(dep)) {
        errors.push(`Split card "${id}" depends on unknown temp_id "${dep}"`);
        continue;
      }
      if (seenDeps.has(dep)) continue;
      seenDeps.add(dep);
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
      dependents.get(dep)!.push(id);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const queue: string[] = [];
  for (const id of ids) {
    if ((inDegree.get(id) ?? 0) === 0) {
      queue.push(id);
    }
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const next of dependents.get(cur) ?? []) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) {
        queue.push(next);
      }
    }
  }

  if (order.length !== ids.size) {
    return {
      ok: false,
      errors: ["Split cards dependency graph contains a cycle"],
    };
  }

  return { ok: true, order };
}
