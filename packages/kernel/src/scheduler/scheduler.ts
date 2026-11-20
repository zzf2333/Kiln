import {
  LimitsConfigSchema,
  PRIORITY_RANK,
  type BackendCapabilities,
  type LimitsConfig,
  type Priority,
  type RoleId,
  type RolesConfig,
  type StageId,
  type StateEvent,
  type TaskCard,
  type TaskStatus,
} from "@kiln/protocol";
import {
  UnsupportedTrackError,
  computeEffectivePriorities,
  getTrackStages,
  type PriorityGraphNode,
  type TaskStateMachine,
} from "../state/index.js";
import {
  deriveTaskStatus,
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
  resolveRoleAssignment,
  type ResolvedRoleAssignment,
} from "./role-resolver.js";

export interface DispatchPlan {
  taskId: string;
  card: TaskCard;
  stage: StageId;
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

export interface KilnSchedulerOptions {
  store: KilnStore;
  stateMachine?: TaskStateMachine;
  limits?: LimitsConfig;
  rolesConfig?: RolesConfig;
  rateLimitTracker?: RateLimitTracker;
  agentCapabilitiesMap?: ReadonlyMap<string, BackendCapabilities>;
  resolveHostTargetPaths?: (card: TaskCard, store: KilnStore) => readonly string[];
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

function getRoleForStage(stage: StageId): RoleId | null {
  switch (stage) {
    case "intake":
      return "intake";
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
      throw new UnsupportedTrackError("L3");
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

function computeNextStageAndRound(
  card: TaskCard,
  derived: DerivedTaskState,
  events: readonly StateEvent[],
): { stage: StageId; round: number } {
  const pipeline = getTrackStages(derived.track, card.contract.human_accept);
  const stage: StageId = derived.stage ?? pipeline[0]!;

  let maxRound = 0;
  for (const ev of events) {
    if (ev.type === "running" && ev.stage === stage && ev.round > maxRound) {
      maxRound = ev.round;
    }
  }

  return { stage, round: maxRound + 1 };
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
  private readonly agentCapabilitiesMap: ReadonlyMap<string, BackendCapabilities> | undefined;
  private readonly resolveHostTargetPaths:
    | ((card: TaskCard, store: KilnStore) => readonly string[])
    | undefined;
  private readonly now: () => number;
  private readonly onDispatch: (plan: DispatchPlan) => Promise<void> | void;
  private readonly onWaitingAttentionBlocked:
    | ((event: WaitingAttentionBlockedEvent) => void)
    | undefined;
  private readonly onRateLimitDeferred:
    | ((event: RateLimitDeferredEvent) => void)
    | undefined;
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
    this.limitsOverride = options.limits
      ? LimitsConfigSchema.parse(options.limits)
      : undefined;
    this.rolesConfigOverride = options.rolesConfig;
    this.rateLimitTracker = options.rateLimitTracker ?? new RateLimitTracker();
    this.agentCapabilitiesMap = options.agentCapabilitiesMap;
    this.resolveHostTargetPaths = options.resolveHostTargetPaths;
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
  markRateLimited(
    key: RateLimitKey,
    retryAfterMs: number,
    nowMs: number = this.now(),
  ): number {
    const cooldownUntilMs = this.rateLimitTracker.markRateLimited(
      key,
      retryAfterMs,
      nowMs,
    );
    if (!this.stopped) {
      this.syncCooldownTimer(nowMs);
    }
    return cooldownUntilMs;
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
    const rolesConfig = this.loadRolesConfig();
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
    const activeGitWorktrees: Array<{ space: string; scope: readonly string[] }> = [];
    const activeHostParticipants: HostScopeParticipant[] = [];

    for (const [taskId, snap] of snapshots) {
      const status = snap.derived.status;
      if (status === "waiting") {
        waitingCount++;
      }

      const inFlight = this.inFlightDispatches.get(taskId);
      const hasActiveLease =
        activeLeaseTaskIds.has(taskId) &&
        !isTerminalStatus(status) &&
        status !== "paused";
      const isRunning = status === "running" || hasActiveLease || inFlight !== undefined;

      if (isRunning) {
        // Parent cards that own child slices do not occupy a separate leaf execution slot.
        if (!parentIdsWithChildren.has(taskId)) {
          activeSlotTaskIds.add(taskId);
        }

        if (snap.card.workspace_mode === "git_worktree") {
          activeGitWorktrees.push({
            space: snap.card.space,
            scope: snap.card.contract.scope,
          });
        } else if (snap.card.workspace_mode === "host_scoped") {
          activeHostParticipants.push({
            taskId,
            scope: snap.card.contract.scope,
            plannedCanonicalPaths:
              inFlight?.hostTargets ??
              resolveTaskPlannedHostPaths(
                snap.card,
                this.store,
                this.resolveHostTargetPaths,
              ),
          });
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

    candidates.sort((a, b) => {
      const prioA = effectivePriorities.get(a.card.id) ?? a.derived.priority;
      const prioB = effectivePriorities.get(b.card.id) ?? b.derived.priority;
      const rankDiff = PRIORITY_RANK[prioA] - PRIORITY_RANK[prioB];
      if (rankDiff !== 0) {
        return rankDiff;
      }

      const blockedDiff =
        (blockedCounts.get(b.card.id) ?? 0) - (blockedCounts.get(a.card.id) ?? 0);
      if (blockedDiff !== 0) {
        return blockedDiff;
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
      const effectivePriority =
        effectivePriorities.get(taskId) ?? snap.derived.priority;

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

      // Write-lock checks: git_worktree same-space scope overlap and host_scoped path conflicts.
      let candidateHostTargets: string[] = [];
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

      // Stage & role resolution + rate-limit check (before reserving slots or write locks).
      let stage: StageId;
      let round: number;
      let role: RoleId | null;
      let roleAssignment: ResolvedRoleAssignment | null = null;

      try {
        const resolvedStage = computeNextStageAndRound(
          snap.card,
          snap.derived,
          snap.events,
        );
        stage = resolvedStage.stage;
        round = resolvedStage.round;
        role = getRoleForStage(stage);

        if (rolesConfig && role !== null) {
          const shouldResolveRole =
            stage !== "accept" || rolesConfig.roles[role] !== undefined;
          if (shouldResolveRole) {
            roleAssignment = resolveRoleAssignment(rolesConfig, role, {
              ...(this.agentCapabilitiesMap !== undefined
                ? { agentCapabilitiesMap: this.agentCapabilitiesMap }
                : {}),
            });
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
        const cooldownUntilMs = this.rateLimitTracker.getCooldownUntil(rlKey, nowMs);
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

      // Approved: synchronously update active reservations before any async dispatch.
      if (!parentIdsWithChildren.has(taskId)) {
        virtualRunningCount++;
      }
      if (snap.card.workspace_mode === "git_worktree") {
        activeGitWorktrees.push({
          space: snap.card.space,
          scope: snap.card.contract.scope,
        });
      } else if (snap.card.workspace_mode === "host_scoped") {
        activeHostParticipants.push({
          taskId,
          scope: snap.card.contract.scope,
          plannedCanonicalPaths: candidateHostTargets,
        });
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
    if (
      result.deferredByRateLimit.some(
        (ev) => ev.cooldownUntilMs <= endNowMs,
      )
    ) {
      // Re-run immediately if a deferred task's cooldown already expired during executeTick,
      // otherwise syncCooldownTimer(endNowMs) would clear the timer without re-waking.
      this.dirty = true;
    }
    result.nextCooldownWakeAtMs = this.syncCooldownTimer(endNowMs);
    return result;
  }
}
