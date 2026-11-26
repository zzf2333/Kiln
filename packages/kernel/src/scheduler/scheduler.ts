import fs from "node:fs";
import {
  GateReportSchema,
  LimitsConfigSchema,
  PRIORITY_RANK,
  RunMetaSchema,
  getWorkflowFlatSteps,
  getStageNodeKind,
  isReadOnlyRosterPermission,
  parseFrontmatterMarkdown,
  resolveWorkflowStepAt,
  type BackendCapabilities,
  type LimitsConfig,
  type Priority,
  type RoleId,
  type RolesConfig,
  type RosterConfig,
  type RosterPermission,
  type StageId,
  type StateEvent,
  type TaskCard,
  type TaskStatus,
  type WorkflowAtomicNode,
} from "@kiln/protocol";
import type { ProviderHealthTracker } from "../backend/provider-health.js";
import {
  computeEffectivePriorities,
  getTaskPipelineStages,
  type PriorityGraphNode,
  type TaskStateMachine,
} from "../state/index.js";
import {
  deriveTaskStatus,
  readYamlOptional,
  type DerivedTaskState,
  type KilnStore,
  type TaskIndexRow,
} from "../store/index.js";
import {
  RateLimitTracker,
  clampTimerDelayMs,
  hasHostScopedConflict,
  resolveTaskPlannedHostPaths,
  scopesOverlap,
  type HostScopeParticipant,
  type RateLimitKey,
} from "./locks.js";
import {
  filterCandidatesAvoidingPeers,
  resolveRoleAssignment,
  resolveRosterStageAssignment,
  type ResolvedRoleAssignment,
} from "./role-resolver.js";

export interface DispatchPlan {
  taskId: string;
  card: TaskCard;
  stage: StageId;
  stepIndex: number | null;
  round: number;
  role: RoleId | null;
  effectivePriority: Priority;
  contractVersion: number;
  roleAssignment: ResolvedRoleAssignment | null;
}

export interface WaitingAttentionBlockedEvent {
  taskId: string;
  priority: Priority;
  effectivePriority: Priority;
  waitingCount: number;
  maxWaitingWip: number;
}

export interface RateLimitDeferredEvent {
  taskId: string;
  role: RoleId;
  key: RateLimitKey;
  cooldownUntilMs: number;
}

export interface SchedulerTickError {
  taskId: string;
  error: unknown;
}

export interface SchedulerTickResult {
  dispatched: DispatchPlan[];
  deferredByRateLimit: RateLimitDeferredEvent[];
  blockedByAttentionGate: WaitingAttentionBlockedEvent[];
  errors: SchedulerTickError[];
  nextCooldownWakeAtMs: number | null;
}

const DEFAULT_CACHE_AFFINITY_STARVATION_MS = 15 * 60_000;

export interface KilnSchedulerOptions {
  store: KilnStore;
  stateMachine?: TaskStateMachine;
  limits?: LimitsConfig;
  rolesConfig?: RolesConfig;
  rateLimitTracker?: RateLimitTracker;
  providerHealth?: ProviderHealthTracker;
  agentCapabilitiesMap?: ReadonlyMap<string, BackendCapabilities>;
  resolveHostTargetPaths?: (card: TaskCard, store: KilnStore) => readonly string[];
  getCacheAffinity?: (
    candidate: { taskId: string; space: string; stage: StageId },
    nowMs: number,
  ) => 0 | 1 | 2;
  cacheAffinityStarvationMs?: number;
  now?: () => number;
  onDispatch: (plan: DispatchPlan) => Promise<void> | void;
  onWaitingAttentionBlocked?: (event: WaitingAttentionBlockedEvent) => void;
  onRateLimitDeferred?: (event: RateLimitDeferredEvent) => void;
  onDispatchError?: (taskId: string, error: unknown) => void;
}

interface TaskSnapshot {
  row: TaskIndexRow;
  card: TaskCard;
  events: StateEvent[];
  derived: DerivedTaskState;
}

function isTerminalStatus(status: TaskStatus): boolean {
  return status === "done" || status === "cancelled";
}

function compareTimestampAsc(aIso: string, bIso: string): number {
  const aMs = Date.parse(aIso);
  const bMs = Date.parse(bIso);
  if (Number.isFinite(aMs) && Number.isFinite(bMs)) {
    return aMs - bMs;
  }
  return aIso < bIso ? -1 : aIso > bIso ? 1 : 0;
}

function compareStringAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function findLatestStageAgentModel(
  store: KilnStore,
  taskId: string,
  stage: StageId,
): { agent: string; model: string } | null {
  const runsDir = store.paths.runsDir(taskId);
  if (!fs.existsSync(runsDir)) {
    return null;
  }
  const dirs = fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort((a, b) => b.localeCompare(a));
  for (const dirName of dirs) {
    const meta = readYamlOptional(store.paths.runYaml(taskId, dirName), RunMetaSchema);
    if (meta && meta.stage === stage) {
      return { agent: meta.agent, model: meta.model };
    }
  }
  return null;
}

function isGateReportPassing(store: KilnStore, taskId: string, dirName: string): boolean | null {
  const gate = readYamlOptional(store.paths.gateYaml(taskId, dirName), GateReportSchema);
  if (!gate) {
    return null;
  }
  return (
    gate.schema_ok &&
    gate.scope_ok &&
    gate.frozen_files_changed.length === 0 &&
    gate.artifacts_ok !== false &&
    gate.accept_exit_code === 0
  );
}

function resolveImplementRosterRole(
  store: KilnStore,
  card: TaskCard,
  rosterConfig: RosterConfig,
  explicitRosterRoleId?: string,
): { rosterRoleId: string; escalateFromRole?: string } {
  let candidateId = explicitRosterRoleId;
  if (!candidateId) {
    const prefersFast = rosterConfig.pm_orchestration?.plan_prefers_fast_exec !== false;
    const planPath = store.paths.planMd(card.id);
    const hasPlanMd =
      fs.existsSync(planPath) && fs.readFileSync(planPath, "utf8").trim().length > 0;
    const fastFix = rosterConfig.roster.fast_fix;
    if (
      prefersFast &&
      hasPlanMd &&
      fastFix?.enabled &&
      fastFix.mode === "agent" &&
      fastFix.primary
    ) {
      candidateId = "fast_fix";
    } else {
      candidateId = "main_dev";
    }
  }

  const candidateEntry = rosterConfig.roster[candidateId];
  const escalationTargetId = candidateEntry?.escalation_target;
  if (!escalationTargetId || escalationTargetId === candidateId) {
    return { rosterRoleId: candidateId };
  }

  const targetEntry = rosterConfig.roster[escalationTargetId];
  if (
    !targetEntry ||
    !targetEntry.enabled ||
    targetEntry.mode !== "agent" ||
    !targetEntry.primary
  ) {
    return { rosterRoleId: candidateId };
  }

  const runsDir = store.paths.runsDir(card.id);
  if (!fs.existsSync(runsDir)) {
    return { rosterRoleId: candidateId };
  }

  const dirs = fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));

  let seenCandidateRun = false;
  let candidateFailedGates = 0;
  let complexityEscalated = false;
  let adviseAfterCandidate = false;

  for (const dirName of dirs) {
    const meta = readYamlOptional(store.paths.runYaml(card.id, dirName), RunMetaSchema);
    if (!meta || meta.contract_version !== card.contract_version) {
      continue;
    }
    if (meta.stage === "advise" && seenCandidateRun) {
      adviseAfterCandidate = true;
    }
    if (meta.stage === "implement") {
      const effectiveRole = meta.roster_role ?? "main_dev";
      if (effectiveRole !== candidateId) {
        continue;
      }
      seenCandidateRun = true;
      const gatePassed = isGateReportPassing(store, card.id, dirName);
      if (gatePassed === false) {
        candidateFailedGates++;
      }
      const receiptPath = store.paths.receiptMd(card.id, dirName);
      if (fs.existsSync(receiptPath)) {
        try {
          const parsed = parseFrontmatterMarkdown(fs.readFileSync(receiptPath, "utf8"));
          if (parsed.frontmatter.complexity_escalate === true) {
            complexityEscalated = true;
          }
        } catch {
          // Ignore malformed partial receipt
        }
      }
    }
  }

  if (complexityEscalated || candidateFailedGates >= 2 || adviseAfterCandidate) {
    return {
      rosterRoleId: escalationTargetId,
      escalateFromRole: candidateId,
    };
  }

  return { rosterRoleId: candidateId };
}

function getRoleForStage(stage: StageId): RoleId | null {
  switch (stage) {
    case "intake":
      return "intake";
    case "plan":
      return "advisor";
    case "implement":
      return "worker";
    case "review":
      return "reviewer";
    case "accept":
      return "verifier";
    case "triage":
      return "triage";
    case "advise":
      return "advisor";
    case "verify":
    case "deliver":
      return null;
    case "research":
      return "advisor";
  }
}

function computeBlockedDownstreamCounts(
  snapshots: ReadonlyMap<string, TaskSnapshot>,
): Map<string, number> {
  const directDependents = new Map<string, string[]>();
  for (const [taskId, snap] of snapshots) {
    if (isTerminalStatus(snap.derived.status)) {
      continue;
    }
    for (const depId of snap.card.depends_on) {
      let list = directDependents.get(depId);
      if (!list) {
        list = [];
        directDependents.set(depId, list);
      }
      list.push(taskId);
    }
  }

  const counts = new Map<string, number>();
  for (const taskId of snapshots.keys()) {
    const visited = new Set<string>();
    const stack = [...(directDependents.get(taskId) ?? [])];
    while (stack.length > 0) {
      const downstreamId = stack.pop()!;
      if (visited.has(downstreamId)) {
        continue;
      }
      const downstreamSnap = snapshots.get(downstreamId);
      if (!downstreamSnap || isTerminalStatus(downstreamSnap.derived.status)) {
        continue;
      }
      visited.add(downstreamId);
      const next = directDependents.get(downstreamId);
      if (next) {
        stack.push(...next);
      }
    }
    counts.set(taskId, visited.size);
  }

  return counts;
}

function isReadOnlyStage(stage: StageId | null, perm?: RosterPermission): boolean {
  if (
    stage === "plan" ||
    stage === "research" ||
    stage === "review" ||
    stage === "triage" ||
    stage === "advise"
  ) {
    return true;
  }
  if (
    stage !== "implement" &&
    stage !== "deliver" &&
    perm !== undefined &&
    isReadOnlyRosterPermission(perm)
  ) {
    return true;
  }
  return false;
}

function computeNextStageAndRound(
  card: TaskCard,
  derived: DerivedTaskState,
  events: readonly StateEvent[],
): {
  stage: StageId;
  stepIndex: number | null;
  stageNode: WorkflowAtomicNode | null;
  round: number;
} {
  let stage: StageId;
  let stepIndex: number | null = null;
  let stageNode: WorkflowAtomicNode | null = null;

  if (derived.stage === "triage" || derived.stage === "advise") {
    stage = derived.stage;
  } else {
    let hintStepIndex = derived.stepIndex;
    if (hintStepIndex === null && derived.stage !== null) {
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]!;
        if (ev.type === "running" && ev.stage === "implement") {
          break;
        }
        if (
          ev.type === "subtasks_spawned" &&
          ev.contract_version === derived.contractVersion &&
          derived.stage === "verify"
        ) {
          hintStepIndex = ev.resume_step_index;
          break;
        }
      }
      if (hintStepIndex === null) {
        for (let i = events.length - 1; i >= 0; i--) {
          const ev = events[i]!;
          if (ev.type === "workflow_patched" && ev.contract_version === derived.contractVersion) {
            const flat = getWorkflowFlatSteps(card, derived.track);
            const start = Math.max(0, Math.min(ev.preserved_prefix_steps, flat.length));
            const relIdx = flat.slice(start).findIndex((n) => n.stage === derived.stage);
            if (relIdx >= 0) {
              hintStepIndex = start + relIdx;
            }
            break;
          }
        }
      }
    }
    const resolved = resolveWorkflowStepAt(card, hintStepIndex, derived.stage, derived.track);
    if (resolved) {
      stage = resolved.node.stage;
      stepIndex = resolved.stepIndex;
      stageNode = resolved.node;
    } else {
      const pipeline = getTaskPipelineStages(card, derived.track);
      stage = derived.stage ?? pipeline[0]!;
    }
  }

  let maxRound = 0;
  for (const ev of events) {
    if (
      ev.type === "running" &&
      ev.stage === stage &&
      (stepIndex === null || ev.step_index === undefined || ev.step_index === stepIndex) &&
      ev.round > maxRound
    ) {
      maxRound = ev.round;
    }
  }

  return { stage, stepIndex, stageNode, round: maxRound + 1 };
}

function emptyTickResult(nextCooldownWakeAtMs: number | null = null): SchedulerTickResult {
  return {
    dispatched: [],
    deferredByRateLimit: [],
    blockedByAttentionGate: [],
    errors: [],
    nextCooldownWakeAtMs,
  };
}

/**
 * Event-driven cross-task MVP scheduler (`kilnd`).
 *
 * Guarantees:
 * - Zero `setInterval` polling: coalesces concurrent `wake()` calls via `dirty` + `runningTick`
 *   and maintains at most a single `setTimeout` for the earliest active rate-limit cooldown.
 * - Enforces `P0–P3` effective priority ordering, dependency readiness, `p0_extra_slot` without
 *   preempting running tasks, `max_waiting_wip` attention gate (with `paused` strictly isolated),
 *   same-space `git_worktree` scope locks, `host_scoped` path locks, and role resolution rules.
 */
export class KilnScheduler {
  private readonly store: KilnStore;
  private readonly limitsOverride: LimitsConfig | undefined;
  private readonly rolesConfigOverride: RolesConfig | undefined;
  private readonly rateLimitTracker: RateLimitTracker;
  private readonly providerHealth: ProviderHealthTracker | undefined;
  private readonly agentCapabilitiesMap: ReadonlyMap<string, BackendCapabilities> | undefined;
  private readonly resolveHostTargetPaths:
    | ((card: TaskCard, store: KilnStore) => readonly string[])
    | undefined;
  private readonly getCacheAffinity: KilnSchedulerOptions["getCacheAffinity"];
  private readonly cacheAffinityStarvationMs: number;
  private readonly now: () => number;
  private readonly onDispatch: (plan: DispatchPlan) => Promise<void> | void;
  private readonly onWaitingAttentionBlocked:
    | ((event: WaitingAttentionBlockedEvent) => void)
    | undefined;
  private readonly onRateLimitDeferred: ((event: RateLimitDeferredEvent) => void) | undefined;
  private readonly onDispatchError: ((taskId: string, error: unknown) => void) | undefined;

  private stopped = false;
  private dirty = false;
  private runningTick = false;
  private activeRunPromise: Promise<SchedulerTickResult> | null = null;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private cooldownTimerDeadlineMs: number | null = null;
  private readonly inFlightDispatches = new Map<
    string,
    { card: TaskCard; hostTargets: string[] }
  >();

  constructor(options: KilnSchedulerOptions) {
    this.store = options.store;
    void options.stateMachine;
    this.limitsOverride = options.limits ? LimitsConfigSchema.parse(options.limits) : undefined;
    this.rolesConfigOverride = options.rolesConfig;
    this.rateLimitTracker = options.rateLimitTracker ?? new RateLimitTracker();
    this.providerHealth = options.providerHealth;
    this.agentCapabilitiesMap = options.agentCapabilitiesMap;
    this.resolveHostTargetPaths = options.resolveHostTargetPaths;
    this.getCacheAffinity = options.getCacheAffinity;
    this.cacheAffinityStarvationMs =
      options.cacheAffinityStarvationMs ?? DEFAULT_CACHE_AFFINITY_STARVATION_MS;
    this.now = options.now ?? (() => Date.now());
    this.onDispatch = options.onDispatch;
    this.onWaitingAttentionBlocked = options.onWaitingAttentionBlocked;
    this.onRateLimitDeferred = options.onRateLimitDeferred;
    this.onDispatchError = options.onDispatchError;
  }

  start(): Promise<SchedulerTickResult> {
    this.stopped = false;
    return this.wake();
  }

  stop(): void {
    this.stopped = true;
    this.dirty = false;
    this.clearCooldownTimer();
  }

  /**
   * Records a backend/agent/model rate-limit cooldown and schedules the single earliest
   * wakeup timer without counting as a stage failure, retry, or circuit-breaker trip.
   */
  markRateLimited(key: RateLimitKey, retryAfterMs: number, nowMs: number = this.now()): number {
    const cooldownUntilMs = this.rateLimitTracker.markRateLimited(key, retryAfterMs, nowMs);
    if (!this.stopped) {
      this.syncCooldownTimer(nowMs);
    }
    return cooldownUntilMs;
  }

  isKeyInCooldown(key: RateLimitKey, nowMs: number = this.now()): boolean {
    return this.rateLimitTracker.getCooldownUntil(key, nowMs) !== null;
  }

  /**
   * Coalescing wakeup entry point: if a tick is already in flight, marks `dirty` so one
   * follow-up pass drains newly arrived work without concurrent re-entrancy races.
   */
  wake(): Promise<SchedulerTickResult> {
    if (this.stopped) {
      return Promise.resolve(emptyTickResult());
    }

    this.dirty = true;
    if (this.activeRunPromise !== null) {
      return this.activeRunPromise;
    }

    this.runningTick = true;
    this.activeRunPromise = this.drainLoop().finally(() => {
      this.runningTick = false;
      this.activeRunPromise = null;
    });
    return this.activeRunPromise;
  }

  private async drainLoop(): Promise<SchedulerTickResult> {
    const aggregate = emptyTickResult();

    while (this.dirty && !this.stopped) {
      this.dirty = false;
      const tickResult = await this.executeTick();
      aggregate.dispatched.push(...tickResult.dispatched);
      aggregate.deferredByRateLimit.push(...tickResult.deferredByRateLimit);
      aggregate.blockedByAttentionGate.push(...tickResult.blockedByAttentionGate);
      aggregate.errors.push(...tickResult.errors);
      aggregate.nextCooldownWakeAtMs = tickResult.nextCooldownWakeAtMs;
    }

    return aggregate;
  }

  private clearCooldownTimer(): void {
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
      this.cooldownTimerDeadlineMs = null;
    }
  }

  private syncCooldownTimer(nowMs: number): number | null {
    if (this.stopped) {
      this.clearCooldownTimer();
      return null;
    }

    const earliest = this.rateLimitTracker.nextCooldownExpiryMs(nowMs);
    if (earliest === null) {
      this.clearCooldownTimer();
      return null;
    }

    if (
      this.cooldownTimer !== null &&
      this.cooldownTimerDeadlineMs !== null &&
      this.cooldownTimerDeadlineMs > nowMs &&
      this.cooldownTimerDeadlineMs <= earliest
    ) {
      return this.cooldownTimerDeadlineMs;
    }

    this.clearCooldownTimer();
    this.cooldownTimerDeadlineMs = earliest;
    const delayMs = clampTimerDelayMs(earliest - nowMs);
    const timer = setTimeout(() => {
      this.cooldownTimer = null;
      this.cooldownTimerDeadlineMs = null;
      if (!this.stopped) {
        void this.wake();
      }
    }, delayMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
    this.cooldownTimer = timer;
    return earliest;
  }

  private loadLimits(): LimitsConfig {
    if (this.limitsOverride) {
      return this.limitsOverride;
    }
    return this.store.readConfig("limits") ?? LimitsConfigSchema.parse({ schema_version: 1 });
  }

  private loadRolesConfig(): RolesConfig | null {
    return this.rolesConfigOverride ?? this.store.readConfig("roles");
  }

  private async executeTick(): Promise<SchedulerTickResult> {
    if (this.stopped) {
      return emptyTickResult();
    }

    const nowMs = this.now();
    this.rateLimitTracker.pruneExpired(nowMs);

    const limits = this.loadLimits();
    const rosterConfig: RosterConfig | null =
      this.rolesConfigOverride === undefined ? this.store.readConfig("roster") : null;
    const rolesConfig = rosterConfig === null ? this.loadRolesConfig() : null;
    const rows = this.store.listTasks();
    const activeLeases = this.store.listActiveStageLeases();
    const activeLeaseTaskIds = new Set(activeLeases.map((lease) => lease.task_id));
    const existingHostLocks = this.store.listHostPathLocks();

    const snapshots = new Map<string, TaskSnapshot>();
    const parentIdsWithChildren = new Set<string>();
    const priorityNodes = new Map<string, PriorityGraphNode>();

    for (const row of rows) {
      const card = this.store.readTaskCard(row.id);
      const events = this.store.readStateEvents(row.id);
      const derived = deriveTaskStatus(card, events);
      snapshots.set(row.id, { row, card, events, derived });

      if (card.parent !== null) {
        parentIdsWithChildren.add(card.parent);
      }

      priorityNodes.set(row.id, {
        priority: derived.priority,
        status: derived.status,
        dependsOn: card.depends_on,
      });
    }

    const effectivePriorities = computeEffectivePriorities(priorityNodes);
    const blockedCounts = computeBlockedDownstreamCounts(snapshots);

    // Count waiting tasks ONLY for status === "waiting" (paused MUST NEVER enter waitingCount).
    let waitingCount = 0;
    const activeSlotTaskIds = new Set<string>();
    const activeMergeSpaces = new Set<string>();
    const activeGitWorktrees: Array<{ space: string; scope: readonly string[] }> = [];
    const activeHostParticipants: HostScopeParticipant[] = [];

    for (const [taskId, snap] of snapshots) {
      const status = snap.derived.status;
      if (status === "waiting") {
        waitingCount++;
      }

      const inFlight = this.inFlightDispatches.get(taskId);
      const hasActiveLease =
        activeLeaseTaskIds.has(taskId) && !isTerminalStatus(status) && status !== "paused";
      const isRunning = status === "running" || hasActiveLease || inFlight !== undefined;

      if (isRunning) {
        // Parent cards that own child slices do not occupy a separate leaf execution slot.
        if (!parentIdsWithChildren.has(taskId)) {
          activeSlotTaskIds.add(taskId);
        }

        // Read-only stages (plan, research, review, triage, advise) do not hold workspace write locks.
        if (!isReadOnlyStage(snap.derived.stage)) {
          if (snap.card.workspace_mode === "git_worktree") {
            activeGitWorktrees.push({
              space: snap.card.space,
              scope: snap.card.contract.scope,
            });
            if (
              (snap.card.contract.deliver.mode === "merge_main" ||
                snap.card.contract.deliver.mode === "merge_parent") &&
              snap.derived.stage === "deliver"
            ) {
              activeMergeSpaces.add(snap.card.space);
            }
          } else if (snap.card.workspace_mode === "host_scoped") {
            activeHostParticipants.push({
              taskId,
              scope: snap.card.contract.scope,
              plannedCanonicalPaths:
                inFlight?.hostTargets ??
                resolveTaskPlannedHostPaths(snap.card, this.store, this.resolveHostTargetPaths),
            });
          }
        }
      }
    }

    // Collect dependency-ready queued candidates (ignore cancelled-dep / unfinished-dep tasks).
    const candidates: TaskSnapshot[] = [];
    for (const [taskId, snap] of snapshots) {
      if (snap.derived.status !== "queued") {
        continue;
      }
      if (this.inFlightDispatches.has(taskId)) {
        continue;
      }

      let depsReady = true;
      for (const depId of snap.card.depends_on) {
        const depSnap = snapshots.get(depId);
        if (!depSnap || depSnap.derived.status !== "done") {
          depsReady = false;
          break;
        }
      }
      if (!depsReady) {
        continue;
      }

      candidates.push(snap);
    }

    const candidateAffinity = new Map<string, 0 | 1 | 2>();
    const starvingGroups = new Set<string>();
    if (this.getCacheAffinity && candidates.length > 1) {
      for (const snap of candidates) {
        let stageHint: StageId = snap.derived.stage ?? "implement";
        try {
          stageHint = computeNextStageAndRound(snap.card, snap.derived, snap.events).stage;
        } catch {
          // Invalid track/blueprint errors are handled inside candidate validation below.
        }
        const tier = this.getCacheAffinity(
          {
            taskId: snap.card.id,
            space: snap.card.space,
            stage: stageHint,
          },
          nowMs,
        );
        candidateAffinity.set(snap.card.id, tier);
        if (tier === 0) {
          const prio = effectivePriorities.get(snap.card.id) ?? snap.derived.priority;
          const blocked = blockedCounts.get(snap.card.id) ?? 0;
          const waitIso = snap.derived.updatedAt || snap.card.created_at;
          const waitMs = Date.parse(waitIso);
          if (Number.isFinite(waitMs) && nowMs - waitMs >= this.cacheAffinityStarvationMs) {
            starvingGroups.add(`${prio}:${blocked}`);
          }
        }
      }
    }

    candidates.sort((a, b) => {
      const prioA = effectivePriorities.get(a.card.id) ?? a.derived.priority;
      const prioB = effectivePriorities.get(b.card.id) ?? b.derived.priority;
      const rankDiff = PRIORITY_RANK[prioA] - PRIORITY_RANK[prioB];
      if (rankDiff !== 0) {
        return rankDiff;
      }

      const blockedA = blockedCounts.get(a.card.id) ?? 0;
      const blockedB = blockedCounts.get(b.card.id) ?? 0;
      const blockedDiff = blockedB - blockedA;
      if (blockedDiff !== 0) {
        return blockedDiff;
      }

      if (this.getCacheAffinity && !starvingGroups.has(`${prioA}:${blockedA}`)) {
        const affDiff =
          (candidateAffinity.get(b.card.id) ?? 0) - (candidateAffinity.get(a.card.id) ?? 0);
        if (affDiff !== 0) {
          return affDiff;
        }
      }

      const waitA = a.derived.updatedAt || a.card.created_at;
      const waitB = b.derived.updatedAt || b.card.created_at;
      const waitDiff = compareTimestampAsc(waitA, waitB);
      if (waitDiff !== 0) {
        return waitDiff;
      }

      return compareStringAsc(a.card.id, b.card.id);
    });

    const result = emptyTickResult();
    let virtualRunningCount = activeSlotTaskIds.size;
    const approvedPlans: Array<{ plan: DispatchPlan; hostTargets: string[] }> = [];

    for (const snap of candidates) {
      const taskId = snap.card.id;
      const effectivePriority = effectivePriorities.get(taskId) ?? snap.derived.priority;

      // Attention gate: when waitingCount >= max_waiting_wip, pause dispatching P2/P3 tasks.
      if (
        waitingCount >= limits.max_waiting_wip &&
        (effectivePriority === "P2" || effectivePriority === "P3")
      ) {
        const blockedEvent: WaitingAttentionBlockedEvent = {
          taskId,
          priority: snap.derived.priority,
          effectivePriority,
          waitingCount,
          maxWaitingWip: limits.max_waiting_wip,
        };
        result.blockedByAttentionGate.push(blockedEvent);
        this.onWaitingAttentionBlocked?.(blockedEvent);
        continue;
      }

      // Slot limit check: P0 may claim +1 extra slot when p0_extra_slot is enabled, without killing active tasks.
      const allowedSlots =
        effectivePriority === "P0" && limits.p0_extra_slot
          ? limits.max_concurrent_slots + 1
          : limits.max_concurrent_slots;
      if (virtualRunningCount >= allowedSlots) {
        continue;
      }

      // Stage & role resolution + rate-limit check BEFORE write-lock checks so read-only
      // stages (plan/research/review/triage/advise) are never blocked by workspace write locks.
      let stage: StageId;
      let stepIndex: number | null;
      let stageNode: WorkflowAtomicNode | null;
      let round: number;
      let role: RoleId | null;
      let roleAssignment: ResolvedRoleAssignment | null = null;

      try {
        const resolvedStage = computeNextStageAndRound(snap.card, snap.derived, snap.events);
        stage = resolvedStage.stage;
        stepIndex = resolvedStage.stepIndex;
        stageNode = resolvedStage.stageNode;
        round = resolvedStage.round;

        const isAcceptApproval =
          stage === "accept" &&
          (stageNode !== null
            ? stageNode.kind === "approval"
            : getStageNodeKind(snap.card, "accept") === "approval");

        const nodeOverride =
          stageNode?.kind === "agent" &&
          (stageNode.binding !== undefined ||
            stageNode.instructions !== undefined ||
            stageNode.label !== undefined ||
            stageNode.id !== undefined)
            ? {
                ...(stageNode.id !== undefined ? { id: stageNode.id } : {}),
                ...(stageNode.label !== undefined ? { label: stageNode.label } : {}),
                ...(stageNode.binding !== undefined ? { binding: stageNode.binding } : {}),
                ...(stageNode.instructions !== undefined
                  ? { instructions: stageNode.instructions }
                  : {}),
              }
            : undefined;

        if (isAcceptApproval) {
          role = null;
        } else if (stage === "verify" || stage === "deliver") {
          if (rosterConfig !== null) {
            roleAssignment = resolveRosterStageAssignment(rosterConfig, stage, "worker", {
              ...(stageNode?.kind === "agent" && stageNode.roster_role
                ? { rosterRoleId: stageNode.roster_role }
                : {}),
              ...(nodeOverride !== undefined ? { nodeOverride } : {}),
              ...(stage === "deliver" ? { allowOnConflictDeliverer: true } : {}),
              ...(this.agentCapabilitiesMap !== undefined
                ? { agentCapabilitiesMap: this.agentCapabilitiesMap }
                : {}),
              isCoolingDown: (key) =>
                this.rateLimitTracker.getCooldownUntil(key, nowMs) !== null ||
                (this.providerHealth?.isInCooldown(key.agent, nowMs) ?? false),
            });
            role = roleAssignment ? "worker" : null;
          } else {
            role = null;
          }
        } else {
          role = getRoleForStage(stage);
        }

        if (rosterConfig !== null && role !== null && stage !== "verify" && stage !== "deliver") {
          const workflowNodes = getWorkflowFlatSteps(snap.card, snap.derived.track);
          const effectiveNode =
            stageNode ?? workflowNodes.find((n) => n.kind === "agent" && n.stage === stage) ?? null;
          const explicitRosterRoleId =
            effectiveNode?.kind === "agent" && effectiveNode.roster_role
              ? effectiveNode.roster_role
              : undefined;

          let resolvedRosterRoleId = explicitRosterRoleId;
          let escalateFromRole: string | undefined;
          const isTestFirstLockNode =
            stage === "implement" &&
            effectiveNode?.kind === "agent" &&
            effectiveNode.mode === "test_first_lock";

          if (stage === "implement") {
            if (isTestFirstLockNode) {
              const testerEntry = rosterConfig.roster.tester;
              if (
                !resolvedRosterRoleId &&
                testerEntry?.enabled &&
                (testerEntry.primary !== undefined || (testerEntry.fallbacks?.length ?? 0) > 0)
              ) {
                resolvedRosterRoleId = "tester";
              } else if (!resolvedRosterRoleId) {
                const mainDevEntry = rosterConfig.roster.main_dev;
                resolvedRosterRoleId = mainDevEntry?.enabled ? "main_dev" : undefined;
              }
            } else {
              const implChoice = resolveImplementRosterRole(
                this.store,
                snap.card,
                rosterConfig,
                explicitRosterRoleId,
              );
              resolvedRosterRoleId = implChoice.rosterRoleId;
              escalateFromRole = implChoice.escalateFromRole;
            }
          }

          const avoidPeers: Array<{ stage: StageId; agent: string; model: string }> = [];
          if (stage === "review") {
            const implPeer = findLatestStageAgentModel(this.store, taskId, "implement");
            if (implPeer) {
              avoidPeers.push({ stage: "implement", ...implPeer });
            } else {
              const implNode = [...workflowNodes]
                .reverse()
                .find((n) => n.kind === "agent" && n.stage === "implement");
              if (implNode?.kind === "agent" && implNode.binding) {
                avoidPeers.push({
                  stage: "implement",
                  agent: implNode.binding.provider,
                  model: implNode.binding.model,
                });
              } else {
                const implKey =
                  implNode?.kind === "agent" && implNode.roster_role
                    ? implNode.roster_role
                    : "main_dev";
                const implEntry = rosterConfig.roster[implKey];
                if (implEntry?.enabled && implEntry.primary) {
                  avoidPeers.push({
                    stage: "implement",
                    agent: implEntry.primary.provider,
                    model: implEntry.primary.model,
                  });
                }
              }
            }

            const planPeer = findLatestStageAgentModel(this.store, taskId, "plan");
            if (planPeer) {
              avoidPeers.push({ stage: "plan", ...planPeer });
            }
          }

          roleAssignment = resolveRosterStageAssignment(rosterConfig, stage, role, {
            ...(resolvedRosterRoleId !== undefined ? { rosterRoleId: resolvedRosterRoleId } : {}),
            ...(nodeOverride !== undefined ? { nodeOverride } : {}),
            ...(escalateFromRole !== undefined ? { escalateFromRole } : {}),
            ...(avoidPeers.length > 0 ? { avoidPeers } : {}),
            ...(this.agentCapabilitiesMap !== undefined
              ? { agentCapabilitiesMap: this.agentCapabilitiesMap }
              : {}),
            isCoolingDown: (key) =>
              this.rateLimitTracker.getCooldownUntil(key, nowMs) !== null ||
              (this.providerHealth?.isInCooldown(key.agent, nowMs) ?? false),
          });
          if (isTestFirstLockNode && roleAssignment !== null) {
            if (!nodeOverride?.binding && (rosterConfig.heterogeneous_review ?? true)) {
              const downstreamImplNode = workflowNodes.find(
                (n, idx) =>
                  idx > (stepIndex ?? -1) &&
                  n.kind === "agent" &&
                  n.stage === "implement" &&
                  (n.mode ?? "normal") === "normal",
              );
              let answererPeer: { agent: string; model: string } | null = null;
              if (downstreamImplNode?.kind === "agent") {
                if (downstreamImplNode.binding) {
                  answererPeer = {
                    agent: downstreamImplNode.binding.provider,
                    model: downstreamImplNode.binding.model,
                  };
                } else {
                  const ansKey = downstreamImplNode.roster_role ?? "main_dev";
                  const ansEntry = rosterConfig.roster[ansKey];
                  if (ansEntry?.enabled && ansEntry.primary) {
                    answererPeer = {
                      agent: ansEntry.primary.provider,
                      model: ansEntry.primary.model,
                    };
                  }
                }
              }
              if (answererPeer && roleAssignment.rosterRoleId) {
                const authorEntry = rosterConfig.roster[roleAssignment.rosterRoleId];
                const authorCandidates = [
                  ...(authorEntry?.primary ? [authorEntry.primary] : []),
                  ...(authorEntry?.fallbacks ?? []),
                ];
                const distinct = filterCandidatesAvoidingPeers(authorCandidates, [answererPeer]);
                const chosen =
                  distinct.find(
                    (cand) =>
                      this.rateLimitTracker.getCooldownUntil(
                        {
                          ...(cand.backend_id !== undefined ? { backendId: cand.backend_id } : {}),
                          agent: cand.provider,
                          model: cand.model,
                        },
                        nowMs,
                      ) === null &&
                      !(this.providerHealth?.isInCooldown(cand.provider, nowMs) ?? false),
                  ) ?? distinct[0];
                if (chosen) {
                  roleAssignment = {
                    ...roleAssignment,
                    ...(chosen.backend_id !== undefined ? { backendId: chosen.backend_id } : {}),
                    agent: chosen.provider,
                    model: chosen.model,
                    ...(chosen.effort !== undefined ? { reasoningEffort: chosen.effort } : {}),
                  };
                }
              }
            }
            roleAssignment = {
              ...roleAssignment,
              freshContext: true,
              perm: "workspace_write",
            };
          }
          if (stage === "research" && roleAssignment === null) {
            role = null;
          }
        } else if (rolesConfig && role !== null && stage !== "verify" && stage !== "deliver") {
          const isTestFirstLockNode =
            stage === "implement" &&
            stageNode?.kind === "agent" &&
            stageNode.mode === "test_first_lock";
          if (nodeOverride?.binding) {
            roleAssignment = {
              role,
              ...(nodeOverride.label !== undefined ? { stepLabel: nodeOverride.label } : {}),
              ...(nodeOverride.instructions !== undefined
                ? { customInstructions: nodeOverride.instructions }
                : {}),
              ...(nodeOverride.binding.backend_id !== undefined
                ? { backendId: nodeOverride.binding.backend_id }
                : {}),
              agent: nodeOverride.binding.provider,
              model: nodeOverride.binding.model,
              ...(nodeOverride.binding.effort !== undefined
                ? { reasoningEffort: nodeOverride.binding.effort }
                : {}),
              freshContext: stage !== "implement" || isTestFirstLockNode,
              allowFullAccessFallback: false,
              usedFallback: false,
            };
          } else {
            const shouldResolveRole =
              (stage !== "accept" && stage !== "plan") || rolesConfig.roles[role] !== undefined;
            if (shouldResolveRole) {
              roleAssignment = resolveRoleAssignment(
                rolesConfig,
                role,
                this.agentCapabilitiesMap !== undefined
                  ? { agentCapabilitiesMap: this.agentCapabilitiesMap }
                  : {},
              );
              if (roleAssignment) {
                roleAssignment = {
                  ...roleAssignment,
                  ...(nodeOverride?.label !== undefined ? { stepLabel: nodeOverride.label } : {}),
                  ...(nodeOverride?.instructions !== undefined
                    ? { customInstructions: nodeOverride.instructions }
                    : {}),
                  ...(isTestFirstLockNode ? { freshContext: true } : {}),
                };
              }
            }
          }
        }
      } catch (error) {
        result.errors.push({ taskId, error });
        this.onDispatchError?.(taskId, error);
        continue;
      }

      if (roleAssignment !== null && role !== null) {
        const rlKey: RateLimitKey = {
          ...(roleAssignment.backendId !== undefined
            ? { backendId: roleAssignment.backendId }
            : {}),
          agent: roleAssignment.agent,
          model: roleAssignment.model,
        };
        const trackerCooldownMs = this.rateLimitTracker.getCooldownUntil(rlKey, nowMs);
        const healthCooldownIso = this.providerHealth?.getCooldownUntil(
          roleAssignment.agent,
          nowMs,
        );
        const parsedHealthMs = healthCooldownIso ? Date.parse(healthCooldownIso) : Number.NaN;
        const healthCooldownMs =
          Number.isFinite(parsedHealthMs) && parsedHealthMs > nowMs ? parsedHealthMs : null;
        if (healthCooldownMs !== null && trackerCooldownMs === null) {
          this.rateLimitTracker.markRateLimited(rlKey, healthCooldownMs - nowMs, nowMs);
        }
        const cooldownUntilMs =
          trackerCooldownMs !== null && healthCooldownMs !== null
            ? Math.max(trackerCooldownMs, healthCooldownMs)
            : (trackerCooldownMs ?? healthCooldownMs);
        if (cooldownUntilMs !== null) {
          const deferredEvent: RateLimitDeferredEvent = {
            taskId,
            role,
            key: rlKey,
            cooldownUntilMs,
          };
          result.deferredByRateLimit.push(deferredEvent);
          this.onRateLimitDeferred?.(deferredEvent);
          continue;
        }
      }

      // Write-lock checks: only mutating stages hold git_worktree scope / host_scoped path locks.
      const isReadOnlyCandidate = isReadOnlyStage(stage, roleAssignment?.perm);
      const isMergeMainDeliverCandidate =
        stage === "deliver" &&
        snap.card.workspace_mode === "git_worktree" &&
        (snap.card.contract.deliver.mode === "merge_main" ||
          snap.card.contract.deliver.mode === "merge_parent");
      if (isMergeMainDeliverCandidate && activeMergeSpaces.has(snap.card.space)) {
        continue;
      }
      let candidateHostTargets: string[] = [];
      if (!isReadOnlyCandidate) {
        if (snap.card.workspace_mode === "git_worktree") {
          const scopeBlocked = activeGitWorktrees.some(
            (active) =>
              active.space === snap.card.space &&
              scopesOverlap(snap.card.contract.scope, active.scope),
          );
          if (scopeBlocked) {
            continue;
          }
        } else if (snap.card.workspace_mode === "host_scoped") {
          candidateHostTargets = resolveTaskPlannedHostPaths(
            snap.card,
            this.store,
            this.resolveHostTargetPaths,
          );
          const hostBlocked = hasHostScopedConflict(
            {
              taskId,
              scope: snap.card.contract.scope,
              plannedCanonicalPaths: candidateHostTargets,
            },
            existingHostLocks,
            activeHostParticipants,
          );
          if (hostBlocked) {
            continue;
          }
        }
      }

      // Approved: synchronously update active reservations before any async dispatch.
      if (!parentIdsWithChildren.has(taskId)) {
        virtualRunningCount++;
      }
      if (!isReadOnlyCandidate) {
        if (snap.card.workspace_mode === "git_worktree") {
          activeGitWorktrees.push({
            space: snap.card.space,
            scope: snap.card.contract.scope,
          });
          if (isMergeMainDeliverCandidate) {
            activeMergeSpaces.add(snap.card.space);
          }
        } else if (snap.card.workspace_mode === "host_scoped") {
          activeHostParticipants.push({
            taskId,
            scope: snap.card.contract.scope,
            plannedCanonicalPaths: candidateHostTargets,
          });
        }
      }

      this.inFlightDispatches.set(taskId, {
        card: snap.card,
        hostTargets: candidateHostTargets,
      });

      approvedPlans.push({
        plan: {
          taskId,
          card: snap.card,
          stage,
          stepIndex,
          round,
          role,
          effectivePriority,
          contractVersion: snap.derived.contractVersion,
          roleAssignment,
        },
        hostTargets: candidateHostTargets,
      });
    }

    await Promise.allSettled(
      approvedPlans.map(async ({ plan }) => {
        try {
          await Promise.resolve(this.onDispatch(plan));
          result.dispatched.push(plan);
        } catch (error) {
          result.errors.push({ taskId: plan.taskId, error });
          this.onDispatchError?.(plan.taskId, error);
        } finally {
          this.inFlightDispatches.delete(plan.taskId);
        }
      }),
    );

    const endNowMs = this.now();
    if (result.deferredByRateLimit.some((ev) => ev.cooldownUntilMs <= endNowMs)) {
      // Re-run immediately if a deferred task's cooldown already expired during executeTick,
      // otherwise syncCooldownTimer(endNowMs) would clear the timer without re-waking.
      this.dirty = true;
    }
    result.nextCooldownWakeAtMs = this.syncCooldownTimer(endNowMs);
    return result;
  }
}
