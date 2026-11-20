import type {
  BackendCapabilities,
  ReasoningEffort,
  RoleId,
  RolesConfig,
} from "@kiln/protocol";
import { IneligibleRoleAgentError } from "../backend/types.js";

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
  backendId?: string;
  agent: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  freshContext: boolean;
  allowFullAccessFallback: boolean;
  usedFallback: boolean;
}

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
