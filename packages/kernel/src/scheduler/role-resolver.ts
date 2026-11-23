import type {
  BackendCapabilities,
  ReasoningEffort,
  RoleId,
  RolesConfig,
  RosterConfig,
  RosterEntry,
  RosterModelBinding,
  RosterPermission,
  StageId,
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

  constructor(
    role: RoleId,
    peerRole: RoleId,
    agent: string,
    model: string,
    detail: string,
  ) {
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

export interface ResolveRosterStageOptions {
  rosterRoleId?: string;
  avoidAgentModel?: { agent: string; model: string } | null;
  agentCapabilitiesMap?: ReadonlyMap<string, BackendCapabilities>;
  isCoolingDown?: (key: RateLimitKey) => boolean;
}

const DEFAULT_ROSTER_KEY_BY_STAGE: Readonly<Record<StageId, string>> = {
  intake: "pm",
  plan: "architect",
  advise: "architect",
  research: "researcher",
  implement: "main_dev",
  verify: "tester",
  review: "reviewer",
  accept: "verifier",
  triage: "triage",
  deliver: "deliverer",
};

const OPTIONAL_STAGES: ReadonlySet<StageId> = new Set<StageId>([
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

  const caps =
    options?.capabilities ?? options?.agentCapabilitiesMap?.get(selectedAgent);

  if (INTERACTIVE_CHAT_ROLES.has(role) && caps !== undefined && !caps.interactiveChat) {
    throw new CapabilityMismatchError(role, selectedAgent, ["interactiveChat"]);
  }

  return {
    role,
    ...(selectedBackendId !== undefined ? { backendId: selectedBackendId } : {}),
    agent: selectedAgent,
    model: selectedModel,
    ...(selectedReasoningEffort !== undefined
      ? { reasoningEffort: selectedReasoningEffort }
      : {}),
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
    if (!entry || !entry.enabled) {
      if (OPTIONAL_STAGES.has(stage)) {
        return null;
      }
      throw new RoleNotConfiguredError(role);
    }
  }

  if (entry.mode === "kernel") {
    return null;
  }

  const allCandidates: RosterModelBinding[] = [];
  if (entry.primary) {
    allCandidates.push(entry.primary);
  }
  for (const fb of entry.fallbacks) {
    allCandidates.push(fb);
  }
  if (allCandidates.length === 0) {
    throw new RoleNotConfiguredError(role);
  }

  const heterogeneousEnabled = rosterConfig.heterogeneous_review ?? true;
  let filteredCandidates = allCandidates;
  if (heterogeneousEnabled && (role === "reviewer" || entry.avoid_same_as !== undefined)) {
    const peerStage = entry.avoid_same_as ?? "implement";
    const peerDefaultKey = DEFAULT_ROSTER_KEY_BY_STAGE[peerStage];
    const peerEntry = rosterConfig.roster[peerDefaultKey];
    const peerAgentModel =
      options?.avoidAgentModel ??
      (peerEntry?.enabled && peerEntry.primary
        ? { agent: peerEntry.primary.provider, model: peerEntry.primary.model }
        : null);

    if (peerAgentModel && peerStage !== stage) {
      filteredCandidates = allCandidates.filter(
        (cand) =>
          !sameAgentModel({ agent: cand.provider, model: cand.model }, peerAgentModel),
      );
      if (filteredCandidates.length === 0) {
        throw new HeterogeneousReviewConflictError(
          role,
          peerStage === "implement" ? "worker" : role,
          peerAgentModel.agent,
          peerAgentModel.model,
          allCandidates.length === 1
            ? "no valid fallback configured"
            : "all configured fallbacks collide with peer role",
        );
      }
    }
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

  const usedFallback =
    entry.primary === undefined ||
    selected.provider !== entry.primary.provider ||
    selected.model !== entry.primary.model ||
    selected.backend_id !== entry.primary.backend_id ||
    selected.effort !== entry.primary.effort;

  return {
    role,
    rosterRoleId,
    perm: entry.perm,
    ...(selected.backend_id !== undefined ? { backendId: selected.backend_id } : {}),
    agent: selected.provider,
    model: selected.model,
    ...(selected.effort !== undefined ? { reasoningEffort: selected.effort } : {}),
    freshContext: FRESH_CONTEXT_ROLES.has(role),
    allowFullAccessFallback: entry.allow_full_access_fallback ?? false,
    usedFallback,
  };
}
