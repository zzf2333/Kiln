import {
  DERIVED_ROSTER_INHERITANCE,
  type BackendCapabilities,
  type ReasoningEffort,
  type RoleId,
  type RolesConfig,
  type RosterConfig,
  type RosterEntry,
  type RosterExecutionMode,
  type RosterModelBinding,
  type RosterPermission,
  type StageId,
  type WorkflowNodeBinding,
} from "@kiln/protocol";
import { IneligibleRoleAgentError } from "../backend/types.js";
import type { RateLimitKey } from "./locks.js";

const INTERACTIVE_CHAT_ROLES: ReadonlySet<RoleId> = new Set<RoleId>(["intake", "resolver"]);
const FRESH_CONTEXT_ROLES: ReadonlySet<RoleId> = new Set<RoleId>([
  "intake",
  "reviewer",
  "verifier",
  "triage",
  "advisor",
]);

/**
 * Raised when a role requiring interactive chat (`intake` / `resolver`)
 * is assigned an agent whose capabilities lack `interactiveChat`.
 */
export class CapabilityMismatchError extends IneligibleRoleAgentError {
  constructor(
    role: RoleId,
    agent: string,
    missingCapabilities: readonly (keyof BackendCapabilities)[],
  ) {
    super(role, agent, missingCapabilities);
    this.name = "CapabilityMismatchError";
  }
}

/**
 * Raised when `rolesConfig.roles` has no entry for the requested role.
 */
export class RoleNotConfiguredError extends Error {
  readonly role: RoleId;

  constructor(role: RoleId) {
    super(`Role "${role}" is not configured in roles.yaml`);
    this.name = "RoleNotConfiguredError";
    this.role = role;
  }
}

/**
 * Raised when `heterogeneous_review` detects a `(agent, model)` collision (e.g. `reviewer`
 * matching `worker`) and no non-colliding `fallback` is available (`REVIEW.md §3.4 #16`).
 */
export class HeterogeneousReviewConflictError extends Error {
  readonly role: RoleId;
  readonly peerRole: RoleId;
  readonly agent: string;
  readonly model: string;

  constructor(role: RoleId, peerRole: RoleId, agent: string, model: string, detail: string) {
    super(
      `Heterogeneous review conflict for role "${role}" vs "${peerRole}" on (${agent}, ${model}): ${detail}`,
    );
    this.name = "HeterogeneousReviewConflictError";
    this.role = role;
    this.peerRole = peerRole;
    this.agent = agent;
    this.model = model;
  }
}

export interface ResolveRoleAssignmentOptions {
  capabilities?: BackendCapabilities;
  agentCapabilitiesMap?: ReadonlyMap<string, BackendCapabilities>;
}

export interface ResolvedRoleAssignment {
  role: RoleId;
  rosterRoleId?: string;
  stepLabel?: string;
  inheritedFrom?: string;
  escalatedFrom?: string;
  heterogeneityLevel?: "dual" | "single" | "none";
  customInstructions?: string;
  rosterMode?: RosterExecutionMode;
  perm?: RosterPermission;
  backendId?: string;
  agent: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  freshContext: boolean;
  allowFullAccessFallback: boolean;
  usedFallback: boolean;
}

/**
 * Raised when a PM-referenced `roster_role` does not exist or is disabled in `roster.yaml`.
 */
export class RosterRoleUnavailableError extends Error {
  readonly rosterRoleId: string;

  constructor(rosterRoleId: string, detail: string) {
    super(`Roster role "${rosterRoleId}" is unavailable: ${detail}`);
    this.name = "RosterRoleUnavailableError";
    this.rosterRoleId = rosterRoleId;
  }
}

export interface WorkflowNodeOverride {
  id?: string;
  label?: string;
  binding?: WorkflowNodeBinding;
  instructions?: string;
}

export interface ResolveRosterStageOptions {
  rosterRoleId?: string;
  nodeOverride?: WorkflowNodeOverride;
  avoidAgentModel?: { agent: string; model: string } | null;
  avoidPeers?: ReadonlyArray<{ stage: StageId; agent: string; model: string }>;
  allowOnConflictDeliverer?: boolean;
  escalateFromRole?: string;
  agentCapabilitiesMap?: ReadonlyMap<string, BackendCapabilities>;
  isCoolingDown?: (key: RateLimitKey) => boolean;
}

function defaultPermForStage(stage: StageId, role: RoleId): RosterPermission {
  if (stage === "implement") return "workspace_write";
  if (stage === "accept") return "accept_entry";
  if (stage === "intake" || role === "intake" || role === "resolver") return "read_only_draft";
  return "read_only";
}

const DEFAULT_ROSTER_KEY_BY_STAGE: Readonly<Record<StageId, string>> = {
  intake: "pm",
  plan: "architect",
  advise: "advisor",
  research: "researcher",
  implement: "main_dev",
  verify: "tester",
  review: "reviewer",
  accept: "verifier",
  triage: "triage",
  deliver: "deliverer",
};

const OPTIONAL_STAGES: ReadonlySet<StageId> = new Set<StageId>([
  "research",
  "plan",
  "accept",
  "verify",
  "deliver",
]);

function sameAgentModel(
  a: { agent: string; model: string },
  b: { agent: string; model: string },
): boolean {
  return a.agent === b.agent && a.model === b.model;
}

export function filterCandidatesAvoidingPeers(
  candidates: readonly RosterModelBinding[],
  peers: ReadonlyArray<{ agent: string; model: string }>,
): RosterModelBinding[] {
  const diffProvider = candidates.filter((cand) => !peers.some((p) => p.agent === cand.provider));
  if (diffProvider.length > 0) {
    return diffProvider;
  }
  return candidates.filter(
    (cand) => !peers.some((p) => sameAgentModel({ agent: cand.provider, model: cand.model }, p)),
  );
}

/**
 * Resolves the effective agent/model assignment for `role` against `rolesConfig`:
 * 1. Enforces `heterogeneous_review`: auto-switches `reviewer` (or any role with
 *    `avoid_same_model_as`) to `fallback` when `(agent, model)` collides with the peer role,
 *    or throws `HeterogeneousReviewConflictError` if no non-colliding fallback exists.
 * 2. Enforces `interactiveChat` for `intake` and `resolver` whenever
 *    capabilities are provided, throwing `CapabilityMismatchError` otherwise.
 * 3. Always sets `freshContext: true` for `reviewer`, `verifier`, and `advisor` (`REVIEW.md §3.4 #16`).
 * 4. Passes through `allowFullAccessFallback` for backend mode enforcement.
 */
export function resolveRoleAssignment(
  rolesConfig: RolesConfig,
  role: RoleId,
  options?: ResolveRoleAssignmentOptions,
): ResolvedRoleAssignment {
  const assignment = rolesConfig.roles[role];
  if (!assignment) {
    throw new RoleNotConfiguredError(role);
  }

  let selectedAgent = assignment.agent;
  let selectedModel = assignment.model;
  let selectedBackendId = assignment.backend_id;
  let selectedReasoningEffort = assignment.reasoning_effort;
  let usedFallback = false;

  const heterogeneousEnabled = rolesConfig.heterogeneous_review ?? true;
  if (
    heterogeneousEnabled &&
    (role === "reviewer" || assignment.avoid_same_model_as !== undefined)
  ) {
    const peerRole: RoleId = assignment.avoid_same_model_as ?? "worker";
    if (peerRole !== role) {
      const peerAssignment = rolesConfig.roles[peerRole];
      if (peerAssignment && sameAgentModel(assignment, peerAssignment)) {
        const fallback = assignment.fallback;
        if (!fallback || fallback.agent.trim().length === 0 || fallback.model.trim().length === 0) {
          throw new HeterogeneousReviewConflictError(
            role,
            peerRole,
            assignment.agent,
            assignment.model,
            "no valid fallback configured",
          );
        }
        if (sameAgentModel(fallback, peerAssignment)) {
          throw new HeterogeneousReviewConflictError(
            role,
            peerRole,
            fallback.agent,
            fallback.model,
            "configured fallback also collides with peer role",
          );
        }

        selectedAgent = fallback.agent;
        selectedModel = fallback.model;
        selectedBackendId = fallback.backend_id ?? assignment.backend_id;
        selectedReasoningEffort = fallback.reasoning_effort;
        usedFallback = true;
      }
    }
  }

  const caps = options?.capabilities ?? options?.agentCapabilitiesMap?.get(selectedAgent);

  if (INTERACTIVE_CHAT_ROLES.has(role) && caps !== undefined && !caps.interactiveChat) {
    throw new CapabilityMismatchError(role, selectedAgent, ["interactiveChat"]);
  }

  return {
    role,
    ...(selectedBackendId !== undefined ? { backendId: selectedBackendId } : {}),
    agent: selectedAgent,
    model: selectedModel,
    ...(selectedReasoningEffort !== undefined ? { reasoningEffort: selectedReasoningEffort } : {}),
    freshContext: FRESH_CONTEXT_ROLES.has(role),
    allowFullAccessFallback: assignment.allow_full_access_fallback ?? false,
    usedFallback,
  };
}

/**
 * Resolves the effective runtime assignment for `(stage, role)` from `v0.0.5` `roster.yaml`,
 * honoring explicit PM `roster_role` selection, heterogeneous review collision avoidance
 * against actual peer agent/model, and multi-tier cooldown fallback (`[1 -> 2 -> 3]`).
 */
export function resolveRosterStageAssignment(
  rosterConfig: RosterConfig,
  stage: StageId,
  role: RoleId,
  options?: ResolveRosterStageOptions,
): ResolvedRoleAssignment | null {
  let rosterRoleId: string;
  let entry: RosterEntry | undefined;
  let inheritedFrom: string | undefined;

  if (options?.rosterRoleId !== undefined) {
    rosterRoleId = options.rosterRoleId;
    entry = rosterConfig.roster[rosterRoleId];
    if (!entry) {
      throw new RosterRoleUnavailableError(rosterRoleId, "not found in roster.yaml");
    }
    if (!entry.enabled) {
      throw new RosterRoleUnavailableError(rosterRoleId, "disabled in roster.yaml");
    }
  } else {
    rosterRoleId = role === "resolver" ? "resolver" : DEFAULT_ROSTER_KEY_BY_STAGE[stage];
    entry = rosterConfig.roster[rosterRoleId];
    if ((!entry || !entry.enabled) && stage === "advise") {
      const legacyArchitect = rosterConfig.roster.architect;
      if (legacyArchitect?.enabled && legacyArchitect.secondary_stages.includes("advise")) {
        rosterRoleId = "architect";
        entry = legacyArchitect;
      }
    }
    if (!entry || !entry.enabled) {
      const inheritChain = DERIVED_ROSTER_INHERITANCE[rosterRoleId];
      if (inheritChain) {
        for (const ancestorId of inheritChain) {
          const ancestor = rosterConfig.roster[ancestorId];
          if (ancestor?.enabled && ancestor.mode === "agent" && ancestor.primary) {
            inheritedFrom = ancestorId;
            entry = {
              ...ancestor,
              perm: entry?.perm ?? (role === "resolver" ? "read_only_draft" : "read_only"),
              stage,
              secondary_stages: [],
              ...(entry?.avoid_same_as !== undefined ? { avoid_same_as: entry.avoid_same_as } : {}),
              ...(entry?.custom_instructions !== undefined
                ? { custom_instructions: entry.custom_instructions }
                : {}),
            };
            break;
          }
        }
      }
    }
    const overrideBinding = options?.nodeOverride?.binding;
    if ((!entry || (!entry.enabled && inheritedFrom === undefined)) && !overrideBinding) {
      if (OPTIONAL_STAGES.has(stage)) {
        return null;
      }
      throw new RoleNotConfiguredError(role);
    }
  }

  const overrideBinding = options?.nodeOverride?.binding;
  const effectivePerm: RosterPermission = entry?.perm ?? defaultPermForStage(stage, role);
  const effectiveMode: RosterExecutionMode =
    overrideBinding || (entry !== undefined && entry.stage !== stage)
      ? "agent"
      : (entry?.mode ?? "agent");

  if (effectiveMode === "kernel") {
    return null;
  }
  if (effectiveMode === "on_conflict" && !options?.allowOnConflictDeliverer) {
    return null;
  }

  const allCandidates: RosterModelBinding[] = [];
  if (overrideBinding) {
    allCandidates.push(overrideBinding);
  } else {
    if (entry?.primary) {
      allCandidates.push(entry.primary);
    }
    if (entry?.fallbacks) {
      for (const fb of entry.fallbacks) {
        allCandidates.push(fb);
      }
    }
  }
  if (allCandidates.length === 0) {
    throw new RoleNotConfiguredError(role);
  }

  const heterogeneousEnabled = rosterConfig.heterogeneous_review ?? true;
  let filteredCandidates = allCandidates;
  let heterogeneityLevel: "dual" | "single" | "none" | undefined;
  if (
    !overrideBinding &&
    heterogeneousEnabled &&
    (role === "reviewer" || entry?.avoid_same_as !== undefined)
  ) {
    const rawAvoid = entry?.avoid_same_as;
    const avoidStages: StageId[] =
      rawAvoid !== undefined ? (Array.isArray(rawAvoid) ? rawAvoid : [rawAvoid]) : ["implement"];
    const peers: Array<{ stage: StageId; agent: string; model: string }> = [];
    for (const peerStage of avoidStages) {
      if (peerStage === stage) continue;
      const fromOpts = options?.avoidPeers?.find((p) => p.stage === peerStage);
      if (fromOpts) {
        peers.push(fromOpts);
        continue;
      }
      if (peerStage === "implement" && options?.avoidAgentModel) {
        peers.push({
          stage: "implement",
          agent: options.avoidAgentModel.agent,
          model: options.avoidAgentModel.model,
        });
        continue;
      }
      const peerKey = DEFAULT_ROSTER_KEY_BY_STAGE[peerStage];
      let peerEntry = rosterConfig.roster[peerKey];
      if ((!peerEntry || !peerEntry.enabled) && DERIVED_ROSTER_INHERITANCE[peerKey]) {
        for (const ancId of DERIVED_ROSTER_INHERITANCE[peerKey]!) {
          const anc = rosterConfig.roster[ancId];
          if (anc?.enabled && anc.mode === "agent" && anc.primary) {
            peerEntry = anc;
            break;
          }
        }
      }
      if (peerEntry?.enabled && peerEntry.primary) {
        peers.push({
          stage: peerStage,
          agent: peerEntry.primary.provider,
          model: peerEntry.primary.model,
        });
      }
    }

    if (peers.length > 0) {
      const fullPass = filterCandidatesAvoidingPeers(allCandidates, peers);
      if (fullPass.length > 0) {
        filteredCandidates = fullPass;
        heterogeneityLevel = peers.length >= 2 ? "dual" : "single";
      } else if (peers.length > 1) {
        const primaryPeer = peers[0]!;
        const singlePass = filterCandidatesAvoidingPeers(allCandidates, [primaryPeer]);
        if (singlePass.length > 0) {
          filteredCandidates = singlePass;
          heterogeneityLevel = "single";
        } else {
          throw new HeterogeneousReviewConflictError(
            role,
            primaryPeer.stage === "implement" ? "worker" : role,
            primaryPeer.agent,
            primaryPeer.model,
            allCandidates.length === 1
              ? "no valid fallback configured"
              : "all configured fallbacks collide with peer role",
          );
        }
      } else {
        const onlyPeer = peers[0]!;
        throw new HeterogeneousReviewConflictError(
          role,
          onlyPeer.stage === "implement" ? "worker" : role,
          onlyPeer.agent,
          onlyPeer.model,
          allCandidates.length === 1
            ? "no valid fallback configured"
            : "all configured fallbacks collide with peer role",
        );
      }
    } else if (role === "reviewer") {
      heterogeneityLevel = "none";
    }
  } else if (role === "reviewer") {
    heterogeneityLevel = "none";
  }

  const preferUnthrottled = rosterConfig.pm_orchestration?.prefer_unthrottled ?? true;
  let selected = filteredCandidates[0]!;
  if (preferUnthrottled && options?.isCoolingDown) {
    const healthy = filteredCandidates.find(
      (cand) =>
        !options.isCoolingDown!({
          ...(cand.backend_id !== undefined ? { backendId: cand.backend_id } : {}),
          agent: cand.provider,
          model: cand.model,
        }),
    );
    if (healthy) {
      selected = healthy;
    }
  }

  const caps = options?.agentCapabilitiesMap?.get(selected.provider);
  if (INTERACTIVE_CHAT_ROLES.has(role) && caps !== undefined && !caps.interactiveChat) {
    throw new CapabilityMismatchError(role, selected.provider, ["interactiveChat"]);
  }

  const primaryBaseline = overrideBinding ?? entry?.primary;
  const usedFallback =
    primaryBaseline === undefined ||
    selected.provider !== primaryBaseline.provider ||
    selected.model !== primaryBaseline.model ||
    selected.backend_id !== primaryBaseline.backend_id ||
    selected.effort !== primaryBaseline.effort;

  const instructionParts = [entry?.custom_instructions, options?.nodeOverride?.instructions]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s && s.length > 0));
  const mergedInstructions =
    instructionParts.length > 0 ? instructionParts.join("\n\n") : undefined;

  return {
    role,
    rosterRoleId,
    ...(options?.nodeOverride?.label !== undefined
      ? { stepLabel: options.nodeOverride.label }
      : {}),
    ...(inheritedFrom !== undefined ? { inheritedFrom } : {}),
    ...(options?.escalateFromRole !== undefined ? { escalatedFrom: options.escalateFromRole } : {}),
    ...(heterogeneityLevel !== undefined ? { heterogeneityLevel } : {}),
    ...(mergedInstructions !== undefined ? { customInstructions: mergedInstructions } : {}),
    rosterMode: effectiveMode,
    perm: effectivePerm,
    ...(selected.backend_id !== undefined ? { backendId: selected.backend_id } : {}),
    agent: selected.provider,
    model: selected.model,
    ...(selected.effort !== undefined ? { reasoningEffort: selected.effort } : {}),
    freshContext: FRESH_CONTEXT_ROLES.has(role) || options?.escalateFromRole !== undefined,
    allowFullAccessFallback: entry?.allow_full_access_fallback ?? false,
    usedFallback,
  };
}
