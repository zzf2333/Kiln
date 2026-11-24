import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  AcceptVerificationReportSchema,
  AdvisorRequestSchema,
  DecisionRecordSchema,
  GateReportSchema,
  PendingDecisionSchema,
  RunMetaSchema,
  TaskCardSchema,
  deriveLegacyRolesConfigFromRoster,
  findLoopRestartStepIndex,
  getVerifyGateCheckMode,
  getWorkflowFlatSteps,
  isAdvisorEligibleDecisionCategory,
  isReadOnlyRosterPermission,
  nextWorkflowStepAfter,
  parseAndValidateReceipt,
  serializeFrontmatterMarkdown,
  type AcceptEntryConfig,
  type AcceptVerificationReport,
  type AdvisorRequest,
  type BackendCapabilities,
  type GateReport,
  type PendingDecision,
  type RoleId,
  type RunEvent,
  type RunMeta,
  type SessionRef,
  type StageId,
  type SteerNote,
  type SteerTaskRequest,
  type TaskCard,
  type TaskRetroReport,
  type VerifierCapability,
} from "@kiln/protocol";
import {
  FullAccessOnlyProviderError,
  IneligibleRoleAgentError,
  ProviderHealthTracker,
  assertRoleAgentEligible,
  isReadOnlyRole,
  type ApprovalRequestEvent,
  type BackendRegistry,
  type BackendRunSpec,
  type ExecutionBackend,
  type McpStdioMountSpec,
  type RunAttachmentInput,
} from "../backend/index.js";
import {
  checkScope,
  computeFrozenSnapshot,
  createGitWorktreeCheckpoint,
  isHostTargetWithinScope,
  normalizeRepoRelativePath,
  prepareGitWorktree,
  prepareScratchWorkspace,
  readHostBackupManifest,
  resolveCanonicalHostTarget,
  runIsolatedCommand,
  runVerificationGate,
  stageHostScopedChanges,
  type FrozenSnapshot,
  type StagedHostFileSpec,
} from "../gate/index.js";
import {
  KilnScheduler,
  type DispatchPlan,
} from "../scheduler/index.js";
import {
  TaskStateMachine,
  assertCanInvokeAdvisor,
  computeGateFailureFingerprint,
  computeReviewerFailureFingerprint,
  evaluateAdvisorAuthorityGuard,
  evaluateReviewerStageOutcome,
  evaluateWorkerStageOutcome,
  getTaskPipelineStages,
  handleExecutionFailure,
  type StageCounters,
} from "../state/index.js";
import {
  KilnStore,
  assertSafeSegment,
  deriveTaskStatus,
  ensureDir,
  readYamlOptional,
  writeFileAtomic,
  writeYamlAtomic,
  type DerivedTaskState,
} from "../store/index.js";
import { resolveRunAttachmentInputs } from "./attachments.js";
import { computeTaskSpentUsd, evaluateDispatchBudget } from "./budget.js";
import type { CaffeinateController } from "./caffeinate.js";
import type { RemoteNotifier } from "./remote-notify.js";
import {
  resolveMcpServerCommand,
  type McpCommandSpec,
} from "./chat.js";
import { ServerHttpError } from "./errors.js";
import type {
  TechnicalDecisionAdvisorRouteInput,
  TechnicalDecisionAdvisorRouteResult,
} from "./mcp-rpc.js";
import {
  executeDeliverStage,
  type DeliverContext,
  type DeliverHandler,
  type DeliverOutcome,
} from "./orchestrator-deliver.js";
import {
  collectRelativeFiles,
  commitVerifiedWorktreeChanges,
  computeWorktreeDirtySignature,
  parseGitPorcelainStatusZ,
  runGitCommand,
} from "./orchestrator-git.js";
import {
  buildHandoffPayload,
  extractActiveSteerNotes,
  extractDecisionFromNeedDecisionReceipt,
  extractSection,
  type AcceptEnvHandoffContext,
  type HandoffPayload,
} from "./orchestrator-handoff.js";
import {
  startAcceptEnvSession,
  type AcceptEnvLiveSnapshot,
  type AcceptEnvSession,
  type AcceptEnvStarterFn,
} from "./accept-env.js";
import {
  detectImageMagic,
  normalizeDeclaredEvidenceRelPath,
  validateVerifierEvidenceGate,
} from "./accept-evidence.js";
import { extractDeterministicTaskRetro, runAiTaskRetro } from "./retro-engine.js";
import {
  DEFAULT_WARM_CACHE_TTL_MS,
  WARM_CONTEXT_PERCENT_LIMIT,
  WARM_MAX_CONSECUTIVE_REUSES,
  WarmSessionPool,
} from "./orchestrator-warm-pool.js";
import { reconcileOrchestratorOnStart } from "./orchestrator-reconcile.js";
import {
  PendingDecisionStore,
  countRunningLeafTasks,
  readOptionalText,
} from "./pending-decisions.js";
import type { LiveRateTracker } from "./rate-tracker.js";
import type { KilnScriptRunner } from "./script-runner.js";
import type { SseHub } from "./sse.js";
import { z } from "zod";

const RATE_LIMIT_MESSAGE_RE = /\b429\b|rate[_ -]?limit|too many requests|quota exceeded/i;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15_000;

export type { DeliverContext, DeliverHandler, DeliverOutcome };

export interface ApprovalDecisionContext {
  taskId: string;
  runId: string;
  role: RoleId;
  card: TaskCard;
  backend: ExecutionBackend;
}

export type OrchestratorApprovalHandler = (
  request: ApprovalRequestEvent,
  context: ApprovalDecisionContext,
) => Promise<void> | void;

export interface KilnOrchestratorOptions {
  store: KilnStore;
  stateMachine: TaskStateMachine;
  backendRegistry: BackendRegistry;
  pendingDecisions: PendingDecisionStore;
  sseHub: SseHub;
  caffeinate: CaffeinateController;
  rateTracker: LiveRateTracker;
  socketPath: string;
  issueRunToken: (input: {
    taskId: string;
    runId: string;
    role: RoleId;
    contractVersion: number;
    sessionKey?: string;
    ttlSeconds?: number;
  }) => string;
  mcpServerCommand?: McpCommandSpec;
  deliverHandler?: DeliverHandler;
  approvalHandler?: OrchestratorApprovalHandler;
  rateLimitCooldownMs?: number;
  providerHealth?: ProviderHealthTracker;
  scriptRunner?: KilnScriptRunner;
  remoteNotifier?: RemoteNotifier;
  acceptEnvStarter?: AcceptEnvStarterFn;
}

interface ActiveRunHandle {
  taskId: string;
  runId: string;
  runDirName: string;
  role: RoleId;
  stage: StageId;
  contractVersion: number;
  backend: ExecutionBackend;
  sessionRef: SessionRef;
  abortController: AbortController;
  consumePromise: Promise<void>;
  cancelledByControl: boolean;
}

interface InFlightStageOperation {
  runId: string;
  abortController: AbortController;
  promise: Promise<void>;
}

interface ExpectedRunGuard {
  runId: string;
  contractVersion: number;
}

interface ScannedRunDir {
  dirName: string;
  meta: RunMeta | null;
  hasReceipt: boolean;
  rateLimited: boolean;
}

const FrozenSnapshotFileSchema = z.object({
  hash: z.string(),
  acceptCmd: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      exists: z.boolean(),
      sha256: z.string().nullable(),
    }),
  ),
});

function isRateLimitErrorMessage(message: string): boolean {
  return RATE_LIMIT_MESSAGE_RE.test(message);
}

function parseRunSequenceNumber(dirName: string): number {
  const m = /^(\d+)-/.exec(dirName);
  return m ? Number(m[1]) : 0;
}

function isAbsoluteOrHomePath(p: string): boolean {
  return path.isAbsolute(p) || p === "~" || p.startsWith("~/") || p.startsWith("~\\");
}

function stripGlobTail(pattern: string): string | null {
  const posix = pattern.replace(/\\/g, "/");
  if (!/[*?{}]/.test(posix)) {
    return posix.endsWith("/") ? posix.slice(0, -1) : posix;
  }
  const segs = posix.split("/");
  const globIdx = segs.findIndex((s) => /[*?{}]/.test(s));
  if (globIdx <= 0) {
    return null;
  }
  const prefix = segs.slice(0, globIdx).join("/");
  return prefix || "/";
}

function resolveExistingHostDir(rawPattern: string): string | null {
  if (!isAbsoluteOrHomePath(rawPattern) || /[*?{}]/.test(rawPattern)) {
    return null;
  }
  try {
    const canonical = resolveCanonicalHostTarget(rawPattern);
    if (fs.existsSync(canonical) && fs.statSync(canonical).isDirectory()) {
      return canonical;
    }
  } catch {
    // Ignore non-existent or unresolvable paths; treat as literal file pattern.
  }
  return null;
}

function resolveStagedHostMapping(
  stagedFiles: readonly string[],
  receiptChangedPaths: readonly string[],
  contractScope: readonly string[],
): { specs: StagedHostFileSpec[]; unmappedPaths: string[] } {
  const specs: StagedHostFileSpec[] = [];
  const unmappedPaths: string[] = [];
  const absChanged = receiptChangedPaths.filter(isAbsoluteOrHomePath);
  const literalScopePaths: string[] = [];
  const scopeDirs: string[] = [];
  const seenScopeDirs = new Set<string>();

  for (const s of contractScope) {
    if (!isAbsoluteOrHomePath(s)) {
      continue;
    }
    const existingDir = resolveExistingHostDir(s);
    if (existingDir) {
      if (!seenScopeDirs.has(existingDir)) {
        seenScopeDirs.add(existingDir);
        scopeDirs.push(existingDir);
      }
      continue;
    }
    if (!/[*?{}]/.test(s) && !s.endsWith("/")) {
      literalScopePaths.push(s);
    }
    const stripped = stripGlobTail(s);
    if (stripped && !seenScopeDirs.has(stripped)) {
      seenScopeDirs.add(stripped);
      scopeDirs.push(stripped);
    }
  }

  for (let i = 0; i < stagedFiles.length; i++) {
    const stagedRel = stagedFiles[i]!;
    const stagedBase = path.posix.basename(stagedRel);

    let matchedTarget: string | undefined =
      absChanged.find(
        (p) =>
          p.replace(/\\/g, "/").endsWith(`/${stagedRel}`) ||
          path.basename(p) === stagedBase,
      ) ?? (absChanged.length === stagedFiles.length ? absChanged[i] : undefined);

    if (!matchedTarget) {
      matchedTarget =
        literalScopePaths.find(
          (p) =>
            p.replace(/\\/g, "/").endsWith(`/${stagedRel}`) ||
            path.basename(p) === stagedBase,
        ) ?? (literalScopePaths.length === 1 && stagedFiles.length === 1
          ? literalScopePaths[0]
          : undefined);
    }

    if (!matchedTarget && scopeDirs.length > 0) {
      const candidateDir = scopeDirs[0]!;
      try {
        if (
          fs.existsSync(candidateDir) &&
          fs.statSync(candidateDir).isDirectory()
        ) {
          matchedTarget = path.join(candidateDir, stagedRel);
        } else if (scopeDirs.length > 0 && contractScope.some((s) => /[*?{}]/.test(s) || s.endsWith("/"))) {
          matchedTarget = path.join(candidateDir, stagedRel);
        }
      } catch {
        matchedTarget = path.join(candidateDir, stagedRel);
      }
    }

    if (matchedTarget) {
      specs.push({ stagedRelativePath: stagedRel, targetPath: matchedTarget });
    } else {
      unmappedPaths.push(stagedRel);
    }
  }

  return { specs, unmappedPaths };
}

/**
 * Deterministic execution orchestrator connecting `KilnScheduler`, `ExecutionBackend`,
 * `KilnStore`, `TaskStateMachine`, `runVerificationGate`, `PendingDecisionStore`,
 * `LiveRateTracker`, `CaffeinateController`, and `SseHub`.
 */
export class KilnOrchestrator {
  private readonly store: KilnStore;
  private readonly stateMachine: TaskStateMachine;
  private readonly backendRegistry: BackendRegistry;
  private readonly pendingDecisions: PendingDecisionStore;
  private readonly sseHub: SseHub;
  private readonly caffeinate: CaffeinateController;
  private readonly rateTracker: LiveRateTracker;
  private readonly socketPath: string;
  private readonly issueRunToken: KilnOrchestratorOptions["issueRunToken"];
  private readonly mcpServerCommand: McpCommandSpec;
  private readonly deliverHandler: DeliverHandler | undefined;
  private readonly approvalHandler: OrchestratorApprovalHandler | undefined;
  private readonly rateLimitCooldownMs: number;
  private readonly providerHealth: ProviderHealthTracker | undefined;
  private readonly scriptRunner: KilnScriptRunner | undefined;
  private readonly remoteNotifier: RemoteNotifier | undefined;
  private readonly acceptEnvStarter: AcceptEnvStarterFn;
  private readonly budgetWarnedKeys = new Set<string>();

  private readonly agentCapabilitiesMap = new Map<string, BackendCapabilities>();
  private readonly activeRuns = new Map<string, ActiveRunHandle>();
  private readonly inFlightOperations = new Map<string, InFlightStageOperation>();
  private readonly abortingBeforeDispatch = new Set<string>();
  private readonly advisorPreRunDirtySignatures = new Map<string, string>();
  private readonly activeAcceptEnvs = new Map<string, AcceptEnvSession>();
  private readonly activeAcceptEnvConfigs = new Map<string, AcceptEntryConfig>();
  private readonly approvalUnsubscribers: Array<() => void> = [];
  private readonly deferredApprovals: Array<{
    backend: ExecutionBackend;
    req: ApprovalRequestEvent;
  }> = [];
  private readonly scheduler: KilnScheduler;
  private readonly warmPool = new WarmSessionPool();
  private readonly latestContextPercentByRunId = new Map<string, number>();
  private readonly recentSpaceCompletedAtMs = new Map<string, number>();
  private readonly sessionKeyByRunId = new Map<string, string>();
  private readonly reuseCountByRunId = new Map<string, number>();

  private startingBackendCount = 0;
  private started = false;
  private stopped = false;

  constructor(options: KilnOrchestratorOptions) {
    this.store = options.store;
    this.stateMachine = options.stateMachine;
    this.backendRegistry = options.backendRegistry;
    this.pendingDecisions = options.pendingDecisions;
    this.sseHub = options.sseHub;
    this.caffeinate = options.caffeinate;
    this.rateTracker = options.rateTracker;
    this.socketPath = options.socketPath;
    this.issueRunToken = options.issueRunToken;
    this.mcpServerCommand = resolveMcpServerCommand(options.mcpServerCommand);
    this.deliverHandler = options.deliverHandler;
    this.approvalHandler = options.approvalHandler;
    this.rateLimitCooldownMs =
      options.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    this.providerHealth = options.providerHealth;
    this.scriptRunner = options.scriptRunner;
    this.remoteNotifier = options.remoteNotifier;
    this.acceptEnvStarter = options.acceptEnvStarter ?? startAcceptEnvSession;

    this.scheduler = new KilnScheduler({
      store: this.store,
      stateMachine: this.stateMachine,
      ...(this.providerHealth !== undefined ? { providerHealth: this.providerHealth } : {}),
      agentCapabilitiesMap: this.agentCapabilitiesMap,
      getCacheAffinity: ({ taskId, space, stage }, nowMs) => {
        const ttlMs = this.getWarmCacheTtlMs();
        if (stage === "implement" && this.warmPool.hasWarmSession(taskId, nowMs, ttlMs)) {
          return 2;
        }
        const recentAt = this.recentSpaceCompletedAtMs.get(space);
        if (recentAt !== undefined && nowMs - recentAt <= ttlMs) {
          return 1;
        }
        return 0;
      },
      onDispatch: async (plan) => {
        await this.dispatchPlan(plan);
      },
      onDispatchError: (taskId, error) => {
        void this.handleSchedulerDispatchError(taskId, error);
      },
    });
  }

  private getWarmCacheTtlMs(): number {
    const ttlSec = this.store.readConfig("limits")?.warm_cache_ttl_sec;
    return ttlSec !== undefined ? ttlSec * 1_000 : DEFAULT_WARM_CACHE_TTL_MS;
  }

  private registerApprovalListeners(): void {
    this.clearApprovalListeners();
    for (const backend of this.backendRegistry.list()) {
      const unsub = backend.onApproval(async (req) => {
        await this.handleBackendApproval(backend, req);
      });
      this.approvalUnsubscribers.push(unsub);
    }
  }

  private clearApprovalListeners(): void {
    while (this.approvalUnsubscribers.length > 0) {
      try {
        this.approvalUnsubscribers.pop()!();
      } catch {
        // Ignore unsubscribe error on teardown
      }
    }
  }

  private async handleBackendApproval(
    backend: ExecutionBackend,
    req: ApprovalRequestEvent,
  ): Promise<void> {
    let matched: ActiveRunHandle | null = null;
    for (const handle of this.activeRuns.values()) {
      if (
        handle.backend.backendId === backend.backendId &&
        handle.sessionRef.sessionId === req.sessionRef.sessionId
      ) {
        matched = handle;
        break;
      }
    }

    if (!matched) {
      if (this.startingBackendCount > 0) {
        this.deferredApprovals.push({ backend, req });
      }
      return;
    }

    if (this.approvalHandler) {
      const card = this.store.readTaskCard(matched.taskId);
      await this.approvalHandler(req, {
        taskId: matched.taskId,
        runId: matched.runId,
        role: matched.role,
        card,
        backend,
      });
      return;
    }

    const mutatingActionRe = /write|edit|delete|remove|execute|command|shell|bash|patch|move/i;
    if (isReadOnlyRole(matched.role) && mutatingActionRe.test(req.action)) {
      await backend
        .answer(
          req.id,
          false,
          `Read-only role "${matched.role}" is denied mutating action "${req.action}"`,
        )
        .catch(() => {});
      return;
    }

    const denyRe = /outside_scope|push|publish|release|delete_branch/i;
    if (denyRe.test(req.action)) {
      await backend
        .answer(req.id, false, `Action "${req.action}" denied by Kiln sandbox policy`)
        .catch(() => {});
    } else {
      await backend.answer(req.id, true).catch(() => {});
    }
  }

  private flushDeferredApprovals(): void {
    if (this.deferredApprovals.length === 0) {
      return;
    }
    const pending = this.deferredApprovals.splice(0, this.deferredApprovals.length);
    for (const item of pending) {
      void this.handleBackendApproval(item.backend, item.req);
    }
  }

  async syncAgentCapabilities(): Promise<void> {
    this.agentCapabilitiesMap.clear();
    for (const backend of this.backendRegistry.list()) {
      try {
        const agents = await backend.listAgents();
        for (const a of agents) {
          this.agentCapabilitiesMap.set(a.id, a.capabilities);
        }
      } catch {
        // Offline backend leaves capabilities unset until reachable
      }
    }
  }

  /**
   * Startup reconciliation (`reconcileOnStart()`):
   * Inspects all `running` tasks and active `stage_leases` after daemon restart or
   * `index.sqlite` rebuild. Reattaches live backend sessions, converges unfinalized
   * receipts, or safely returns orphaned runs back to `queued` without disturbing `paused`.
   */
  async reconcileOnStart(): Promise<void> {
    await reconcileOrchestratorOnStart({
      store: this.store,
      backendRegistry: this.backendRegistry,
      syncAgentCapabilities: () => this.syncAgentCapabilities(),
      listTaskRunDirs: (taskId) => this.listTaskRunDirs(taskId),
      finalizePlanRun: (taskId, dirName, meta) =>
        this.finalizePlanRun(taskId, dirName, meta),
      finalizeResearchRun: (taskId, dirName, meta) =>
        this.finalizeResearchRun(taskId, dirName, meta),
      finalizeWorkerRun: (taskId, dirName, meta, exitEvent) =>
        this.finalizeWorkerRun(taskId, dirName, meta, exitEvent),
      finalizeVerifyAgentRun: (taskId, dirName, meta, exitEvent) =>
        this.finalizeVerifyAgentRun(taskId, dirName, meta, exitEvent),
      finalizeReviewerRun: (taskId, dirName, meta, exitEvent) =>
        this.finalizeReviewerRun(taskId, dirName, meta, exitEvent),
      finalizeVerifierRun: (taskId, dirName, meta) =>
        this.finalizeVerifierRun(taskId, dirName, meta),
      finalizeTriageRun: (taskId, dirName, meta) =>
        this.finalizeTriageRun(taskId, dirName, meta),
      finalizeAdvisorRun: (taskId, dirName, meta) =>
        this.finalizeAdvisorRun(taskId, dirName, meta),
      finalizeDeliverAgentRun: (taskId, dirName, meta) =>
        this.finalizeDeliverAgentRun(taskId, dirName, meta),
      attachSessionConsumer: (taskId, dirName, meta, backend, sessionRef) =>
        this.attachSessionConsumer(taskId, dirName, meta, backend, sessionRef),
      publishTaskUpdated: (taskId, patch) => this.publishTaskUpdated(taskId, patch),
      syncCaffeinate: () => this.syncCaffeinate(),
    });
  }

  async start(): Promise<void> {
    if (this.started && !this.stopped) {
      return;
    }
    this.stopped = false;
    this.started = true;
    this.registerApprovalListeners();
    await this.syncAgentCapabilities();
    await this.scheduler.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.scheduler.stop();
    this.clearApprovalListeners();
    this.deferredApprovals.length = 0;

    const activeHandles = Array.from(this.activeRuns.values());
    for (const handle of activeHandles) {
      handle.cancelledByControl = true;
      handle.abortController.abort();
      this.rateTracker.clearTask(handle.taskId);
      await handle.backend.cancel(handle.sessionRef).catch(() => {});
    }
    const inFlightOps = Array.from(this.inFlightOperations.values());
    for (const op of inFlightOps) {
      op.abortController.abort();
    }
    await Promise.allSettled([
      ...activeHandles.map((h) => h.consumePromise),
      ...inFlightOps.map((op) => op.promise),
    ]);
    this.activeRuns.clear();
    this.inFlightOperations.clear();
    this.abortingBeforeDispatch.clear();
    await this.warmPool.evictAll();
    this.latestContextPercentByRunId.clear();
    this.sessionKeyByRunId.clear();
    this.reuseCountByRunId.clear();
    const activeEnvs = Array.from(this.activeAcceptEnvs.values());
    this.activeAcceptEnvs.clear();
    this.activeAcceptEnvConfigs.clear();
    await Promise.allSettled(activeEnvs.map((env) => env.stop()));
  }

  getActiveAcceptEnvSnapshot(taskId: string): AcceptEnvLiveSnapshot | null {
    const safeTaskId = assertSafeSegment(taskId, "taskId");
    const env = this.activeAcceptEnvs.get(safeTaskId);
    return env ? env.getLiveSnapshot() : null;
  }

  private async stopAcceptEnv(taskId: string): Promise<AcceptEnvLiveSnapshot | null> {
    const env = this.activeAcceptEnvs.get(taskId);
    if (!env) {
      return null;
    }
    this.activeAcceptEnvs.delete(taskId);
    let snapshot: AcceptEnvLiveSnapshot | null = null;
    try {
      snapshot = env.getLiveSnapshot();
    } catch {
      snapshot = null;
    }
    await env.stop().catch(() => {});
    return snapshot;
  }

  async wake(): Promise<void> {
    if (!this.started || this.stopped) {
      return;
    }
    await this.syncAgentCapabilities();
    await this.scheduler.wake();
  }

  async abortActiveRun(taskId: string): Promise<void> {
    const safeTaskId = assertSafeSegment(taskId, "taskId");
    const handle = this.activeRuns.get(safeTaskId);
    const op = this.inFlightOperations.get(safeTaskId);
    this.rateTracker.clearTask(safeTaskId);
    this.warmPool.evictTask(safeTaskId);
    await this.stopAcceptEnv(safeTaskId);
    this.activeAcceptEnvConfigs.delete(safeTaskId);
    if (handle) {
      handle.cancelledByControl = true;
      handle.abortController.abort();
      await handle.backend.cancel(handle.sessionRef).catch(() => {});
      await handle.consumePromise.catch(() => {});
      this.latestContextPercentByRunId.delete(handle.runId);
      this.sessionKeyByRunId.delete(handle.runId);
      this.reuseCountByRunId.delete(handle.runId);
      if (this.activeRuns.get(safeTaskId)?.runId === handle.runId) {
        this.activeRuns.delete(safeTaskId);
      }
    }
    if (op) {
      op.abortController.abort();
      await op.promise.catch(() => {});
      if (this.inFlightOperations.get(safeTaskId)?.runId === op.runId) {
        this.inFlightOperations.delete(safeTaskId);
      }
    }
  }

  /**
   * Records a mid-flight steering directive without mutating `contract_version`.
   * Optionally interrupts the currently active run and immediately re-queues the same
   * `(stage, stepIndex)` with the steering note injected into `HANDOFF.md`.
   */
  async steerTask(
    taskId: string,
    input: SteerTaskRequest,
  ): Promise<{ steer: SteerNote; state: DerivedTaskState; interrupted: boolean }> {
    const safeTaskId = assertSafeSegment(taskId, "taskId");
    const card = readYamlOptional(this.store.paths.cardYaml(safeTaskId), TaskCardSchema);
    if (!card) {
      throw new ServerHttpError(404, {
        error: "task_not_found",
        taskId: safeTaskId,
        message: `Task "${safeTaskId}" does not exist`,
      });
    }

    const before = deriveTaskStatus(card, this.store.readStateEvents(safeTaskId));
    if (
      before.status !== "queued" &&
      before.status !== "running" &&
      before.status !== "paused"
    ) {
      throw new ServerHttpError(409, {
        error: "invalid_task_state",
        taskId: safeTaskId,
        status: before.status,
        message: `Cannot steer task "${safeTaskId}" in status "${before.status}"`,
      });
    }

    const now = new Date().toISOString();
    const steerId = `steer-${randomUUID().slice(0, 8)}`;
    const wantsInterrupt = Boolean(input.interrupt) && before.status === "running";

    let nextState = this.store.appendStateEvent(safeTaskId, {
      type: "steered",
      at: now,
      steer_id: steerId,
      message: input.message,
      interrupt: wantsInterrupt,
      contract_version: before.contractVersion,
      ...(before.stage !== null ? { stage: before.stage } : {}),
    });

    let interrupted = false;
    if (wantsInterrupt) {
      this.abortingBeforeDispatch.add(safeTaskId);
      try {
        await this.abortActiveRun(safeTaskId);
        this.store.sqlite.expireActiveLeaseByTask(
          safeTaskId,
          new Date().toISOString(),
          "expired",
        );
        const latestCard = this.store.readTaskCard(safeTaskId);
        const currentDerived = deriveTaskStatus(
          latestCard,
          this.store.readStateEvents(safeTaskId),
        );
        if (currentDerived.status === "running") {
          const targetStage = currentDerived.stage ?? before.stage ?? "implement";
          const targetStepIndex =
            currentDerived.stepIndex !== null ? currentDerived.stepIndex : before.stepIndex;
          nextState = this.store.appendStateEvent(safeTaskId, {
            type: "resumed",
            at: new Date().toISOString(),
            stage: targetStage,
            ...(targetStepIndex !== null ? { step_index: targetStepIndex } : {}),
          });
          interrupted = true;
        }
      } finally {
        this.abortingBeforeDispatch.delete(safeTaskId);
      }
    }

    this.syncCaffeinate();
    this.publishTaskUpdated(safeTaskId, {
      status: nextState.status,
      ...(nextState.stage !== null ? { stage: nextState.stage } : {}),
      contractVersion: nextState.contractVersion,
    });
    if (interrupted) {
      void this.wake();
    }

    const activeSteers = extractActiveSteerNotes(
      this.store.readStateEvents(safeTaskId),
      before.contractVersion,
    );
    const createdSteer =
      activeSteers.find((s) => s.id === steerId) ?? {
        id: steerId,
        at: now,
        message: input.message,
        interrupt: wantsInterrupt,
        contract_version: before.contractVersion,
        ...(before.stage !== null ? { stage: before.stage } : {}),
      };

    return {
      steer: createdSteer,
      state: nextState,
      interrupted,
    };
  }

  private isRunStillCurrent(
    taskId: string,
    expectedRunId: string,
    expectedContractVersion: number,
    requireActiveLease = false,
  ): boolean {
    if (this.stopped) {
      return false;
    }
    const card = readYamlOptional(
      this.store.paths.cardYaml(taskId),
      TaskCardSchema,
    );
    if (!card || card.contract_version !== expectedContractVersion) {
      return false;
    }
    const derived = deriveTaskStatus(card, this.store.readStateEvents(taskId));
    if (derived.status !== "running" || derived.activeRunId !== expectedRunId) {
      return false;
    }
    if (requireActiveLease) {
      const lease = this.store.getStageLease(taskId);
      if (!lease || lease.state !== "active" || lease.run_id !== expectedRunId) {
        return false;
      }
    }
    return true;
  }

  private async runTrackedStageOperation(
    taskId: string,
    runId: string,
    fn: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const abortController = new AbortController();
    const promise = fn(abortController.signal).finally(() => {
      if (this.inFlightOperations.get(taskId)?.runId === runId) {
        this.inFlightOperations.delete(taskId);
      }
    });
    this.inFlightOperations.set(taskId, {
      runId,
      abortController,
      promise,
    });
    await promise;
  }

  private syncCaffeinate(): void {
    this.caffeinate.syncRunningCount(countRunningLeafTasks(this.store));
  }

  private publishTaskUpdated(
    taskId: string,
    patch: {
      status?: TaskCard["priority"] extends never ? never : "queued" | "running" | "paused" | "waiting" | "external" | "done" | "cancelled";
      stage?: StageId;
      round?: number;
      priority?: TaskCard["priority"];
      effectivePriority?: TaskCard["priority"];
      contractVersion?: number;
    },
  ): void {
    this.sseHub.publish({
      type: "task.updated",
      taskId,
      patch,
    });
  }

  private transitionTaskToWaiting(
    taskId: string,
    decision: PendingDecision,
    expected?: ExpectedRunGuard,
  ): boolean {
    if (
      this.stopped ||
      (expected !== undefined &&
        !this.isRunStillCurrent(taskId, expected.runId, expected.contractVersion))
    ) {
      this.syncCaffeinate();
      return false;
    }
    const parsed = PendingDecisionSchema.parse(decision);
    this.pendingDecisions.set(parsed);
    try {
      const nextState = this.stateMachine.requestDecision(taskId, parsed, parsed.created_at);
      this.syncCaffeinate();
      this.sseHub.publish({
        type: "decision.requested",
        taskId,
        priority: nextState.priority,
        question: parsed.question,
      });
      this.publishTaskUpdated(taskId, {
        status: nextState.status,
        ...(nextState.stage !== null ? { stage: nextState.stage } : {}),
        contractVersion: nextState.contractVersion,
      });
      void this.wake();
      return true;
    } catch (err) {
      this.pendingDecisions.remove(taskId);
      throw err;
    }
  }

  private listTaskRunDirs(taskId: string): ScannedRunDir[] {
    const runsDir = this.store.paths.runsDir(taskId);
    if (!fs.existsSync(runsDir)) {
      return [];
    }
    const entries = fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => assertSafeSegment(e.name, "runDirName"))
      .sort((a, b) => a.localeCompare(b));

    return entries.map((dirName) => ({
      dirName,
      meta: readYamlOptional(this.store.paths.runYaml(taskId, dirName), RunMetaSchema),
      hasReceipt: fs.existsSync(this.store.paths.receiptMd(taskId, dirName)),
      rateLimited: fs.existsSync(
        path.join(this.store.paths.runDir(taskId, dirName), "RATE_LIMITED"),
      ),
    }));
  }

  private allocateRunDirName(taskId: string, stage: StageId): string {
    const existing = this.listTaskRunDirs(taskId);
    const maxSeq = existing.reduce(
      (max, item) => Math.max(max, parseRunSequenceNumber(item.dirName)),
      0,
    );
    const nextSeq = maxSeq + 1;
    return `${String(nextSeq).padStart(3, "0")}-${stage}`;
  }

  private frozenBaselineFilePath(taskId: string): string {
    const safeTaskId = assertSafeSegment(taskId, "taskId");
    return path.join(this.store.paths.taskDir(safeTaskId), "frozen_baseline.json");
  }

  private readSavedFrozenBaseline(
    taskId: string,
    card: TaskCard,
  ): FrozenSnapshot | undefined {
    const file = this.frozenBaselineFilePath(taskId);
    const raw = readOptionalText(file);
    if (!raw) {
      return undefined;
    }
    try {
      const parsed = FrozenSnapshotFileSchema.parse(JSON.parse(raw) as unknown);
      if (
        parsed.hash === card.contract.accept_files_hash &&
        parsed.acceptCmd === card.contract.accept_cmd
      ) {
        return parsed;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private saveFrozenBaseline(taskId: string, snapshot: FrozenSnapshot): void {
    writeFileAtomic(
      this.frozenBaselineFilePath(taskId),
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
  }

  private ensureFrozenBaselineInitialized(card: TaskCard, rootDir: string): void {
    const space = this.store.readSpace(card.space);
    const freezePatterns = space?.freeze_patterns ?? [];

    if (card.contract.accept_files_hash === "pending") {
      const snap = computeFrozenSnapshot(
        rootDir,
        freezePatterns,
        card.contract.accept_cmd,
      );
      const updatedCard = {
        ...card,
        contract: { ...card.contract, accept_files_hash: snap.hash },
        updated_at: new Date().toISOString(),
      };
      writeYamlAtomic(this.store.paths.cardYaml(card.id), updatedCard);
      this.saveFrozenBaseline(card.id, snap);
    } else if (
      freezePatterns.length > 0 &&
      this.readSavedFrozenBaseline(card.id, card) === undefined
    ) {
      const snap = computeFrozenSnapshot(
        rootDir,
        freezePatterns,
        card.contract.accept_cmd,
      );
      if (snap.hash === card.contract.accept_files_hash) {
        this.saveFrozenBaseline(card.id, snap);
      }
    }
  }

  private resolveScratchExpectedArtifacts(
    taskId: string,
    card: TaskCard,
    receiptChangedPaths: readonly string[],
  ): string[] {
    const workspaceDir = this.store.paths.workspaceDir(taskId);
    const candidates: string[] = [];
    const seen = new Set<string>();

    const addConcreteCandidate = (raw: string): void => {
      const trimmed = raw.trim();
      if (
        trimmed.length === 0 ||
        trimmed === "." ||
        trimmed === "./" ||
        trimmed.endsWith("/") ||
        trimmed.endsWith("\\") ||
        /[*?[\]{}]/.test(trimmed) ||
        path.isAbsolute(trimmed)
      ) {
        return;
      }
      let cleaned: string;
      try {
        cleaned = normalizeRepoRelativePath(trimmed);
      } catch {
        // Skip invalid traversal/drive paths here so gate-runner records scope_ok=false instead of throwing.
        return;
      }
      if (seen.has(cleaned)) {
        return;
      }
      const full = path.join(workspaceDir, cleaned);
      try {
        if (fs.existsSync(full) && fs.lstatSync(full).isDirectory()) {
          return;
        }
      } catch {
        // Keep candidate so verifyScratchWorkspace reports invalid paths cleanly.
      }
      seen.add(cleaned);
      candidates.push(cleaned);
    };

    for (const scopeEntry of card.contract.scope) {
      addConcreteCandidate(scopeEntry);
    }
    for (const changedPath of receiptChangedPaths) {
      addConcreteCandidate(changedPath);
    }
    if (candidates.length > 0) {
      return candidates;
    }

    const existingFiles = collectRelativeFiles(workspaceDir);
    if (existingFiles.length > 0) {
      return existingFiles;
    }
    return ["__kiln_expected_artifact__"];
  }

  private getGitWorktreeDir(taskId: string): string {
    const safeTaskId = assertSafeSegment(taskId, "taskId");
    return path.join(this.store.paths.workspaceDir(safeTaskId), "worktree");
  }

  private canonicalizeWorkspacePath(dir: string): string {
    try {
      return fs.realpathSync(dir);
    } catch {
      return path.resolve(dir);
    }
  }

  private async prepareWorkspaceForPlan(
    card: TaskCard,
    stage: StageId,
  ): Promise<{ cwd: string; inputRef?: string }> {
    if (card.workspace_mode === "external_only") {
      throw new Error('Unsupported workspace_mode: "external_only" is Post-MVP');
    }

    if (card.workspace_mode === "scratch_dir") {
      const cwd = this.canonicalizeWorkspacePath(prepareScratchWorkspace(this.store, card.id));
      this.ensureFrozenBaselineInitialized(card, cwd);
      return { cwd };
    }

    if (card.workspace_mode === "host_scoped") {
      const wsDir = this.store.paths.workspaceDir(card.id);
      ensureDir(wsDir);
      ensureDir(this.store.paths.stagedDir(card.id));
      const canonicalWsDir = this.canonicalizeWorkspacePath(wsDir);
      this.ensureFrozenBaselineInitialized(card, canonicalWsDir);
      return { cwd: canonicalWsDir };
    }

    // git_worktree
    const space = this.store.readSpace(card.space);
    if (!space?.repo_path) {
      throw new Error(
        `Space "${card.space}" has no repo_path configured for git_worktree task "${card.id}"`,
      );
    }

    const worktreePath = this.getGitWorktreeDir(card.id);
    if (!fs.existsSync(worktreePath)) {
      const prep = await prepareGitWorktree({
        repoPath: space.repo_path,
        worktreePath,
        branchName: `kiln/${card.id}`,
        baseRef: space.default_branch,
        copyUntracked: space.copy_untracked,
        cloneDeps: space.clone_deps,
      });

      const canonicalPrepPath = this.canonicalizeWorkspacePath(prep.worktreePath);
      try {
        if (space.scripts?.setup?.trim()) {
          const setupOutcome = this.scriptRunner
            ? await this.scriptRunner.runAndWait({
                spaceId: card.space,
                scriptKey: "setup",
                taskId: card.id,
                timeoutMs: 120_000,
              })
            : await runIsolatedCommand(space.scripts.setup, {
                cwd: canonicalPrepPath,
                timeoutMs: 120_000,
              });
          if (setupOutcome.exitCode !== 0) {
            const detail =
              "tailOutput" in setupOutcome
                ? setupOutcome.tailOutput
                : setupOutcome.stderr || setupOutcome.stdout;
            throw new Error(
              `Space "${card.space}" setup script failed (exit=${setupOutcome.exitCode}) for "${card.id}": ${detail.trim().slice(-400)}`,
            );
          }
        }

        this.ensureFrozenBaselineInitialized(card, canonicalPrepPath);
      } catch (err) {
        await runGitCommand([
          "-C",
          prep.repoPath,
          "worktree",
          "remove",
          "--force",
          canonicalPrepPath,
        ]).catch(() => {});
        throw err;
      }
      return { cwd: canonicalPrepPath, inputRef: prep.baseCommit };
    }

    const resolvedWorktreePath = this.canonicalizeWorkspacePath(worktreePath);
    this.ensureFrozenBaselineInitialized(card, resolvedWorktreePath);
    const headCommit = (
      await runGitCommand(["-C", resolvedWorktreePath, "rev-parse", "HEAD"])
    ).trim();

    if (stage === "implement") {
      const firstImplementRun = this.listTaskRunDirs(card.id).find(
        (r) => r.meta?.stage === "implement" && r.meta.input_ref,
      );
      return {
        cwd: resolvedWorktreePath,
        inputRef: firstImplementRun?.meta?.input_ref ?? headCommit,
      };
    }

    return { cwd: resolvedWorktreePath, inputRef: headCommit };
  }

  private async findBackendWithAgent(
    backendId: string | undefined,
    agent: string,
  ): Promise<ExecutionBackend | null> {
    if (backendId) {
      return this.backendRegistry.has(backendId)
        ? this.backendRegistry.get(backendId)
        : null;
    }

    for (const candidate of this.backendRegistry.list()) {
      try {
        const agents = await candidate.listAgents();
        if (agents.some((a) => a.id === agent)) {
          return candidate;
        }
      } catch {
        // Ignore offline backends
      }
    }
    return null;
  }

  private resolveEffectiveAcceptEntry(card: TaskCard): AcceptEntryConfig {
    return (
      card.contract.accept_entry ??
      this.store.readSpace(card.space)?.accept_entry ?? { kind: "none" }
    );
  }

  private resolveVerifierCapabilities(
    rosterRoleId?: string,
  ): readonly VerifierCapability[] {
    const roster = this.store.readEffectiveRosterConfig();
    const entry =
      (rosterRoleId ? roster.roster[rosterRoleId] : undefined) ??
      roster.roster.verifier;
    if (entry?.verifier_capabilities && entry.verifier_capabilities.length > 0) {
      return entry.verifier_capabilities;
    }
    return ["cli"];
  }

  private buildPreviousDeltaSummaries(
    taskId: string,
    card: TaskCard,
    stage: StageId,
  ): {
    previousFailureSummary: string | null;
    previousReviewSummary: string | null;
    previousAcceptSummary: string | null;
    previousAcceptImagePaths: RunAttachmentInput[];
  } {
    if (stage !== "implement") {
      return {
        previousFailureSummary: null,
        previousReviewSummary: null,
        previousAcceptSummary: null,
        previousAcceptImagePaths: [],
      };
    }
    const runs = this.listCurrentWindowRuns(taskId, card);
    let previousFailureSummary: string | null = null;
    let previousReviewSummary: string | null = null;
    let previousAcceptSummary: string | null = null;
    const previousAcceptImagePaths: RunAttachmentInput[] = [];

    for (let i = runs.length - 1; i >= 0; i--) {
      const r = runs[i]!;
      if (
        previousFailureSummary === null &&
        (r.meta.stage === "implement" || r.meta.stage === "verify")
      ) {
        const gate = readYamlOptional(
          this.store.paths.gateYaml(taskId, r.dirName),
          GateReportSchema,
        );
        if (
          gate &&
          (!gate.schema_ok ||
            !gate.scope_ok ||
            gate.artifacts_ok === false ||
            gate.accept_exit_code !== 0 ||
            gate.frozen_files_changed.length > 0)
        ) {
          const lines = [
            `- 来源 Run: ${r.meta.run_id} (${r.meta.stage} · round ${r.meta.round})`,
            `- schema_ok=${gate.schema_ok}, scope_ok=${gate.scope_ok}, artifacts_ok=${gate.artifacts_ok !== false}, accept_exit_code=${gate.accept_exit_code}`,
          ];
          if (gate.out_of_scope_paths.length > 0) {
            lines.push(`- 越界文件: ${gate.out_of_scope_paths.join(", ")}`);
          }
          if (gate.frozen_files_changed.length > 0) {
            lines.push(`- 冻结文件变动: ${gate.frozen_files_changed.join(", ")}`);
          }
          lines.push(`- 门禁详情文件: ${this.store.paths.gateYaml(taskId, r.dirName)}`);
          previousFailureSummary = lines.join("\n");
        }
      }
      if (previousReviewSummary === null && r.meta.stage === "review" && r.hasReceipt) {
        const raw = readOptionalText(this.store.paths.receiptMd(taskId, r.dirName));
        if (raw) {
          const parsed = parseAndValidateReceipt("reviewer", raw);
          if (parsed.ok && parsed.frontmatter.verdict === "changes_requested") {
            const defects =
              extractSection(parsed.body, "缺陷清单") ||
              extractSection(parsed.body, "结论") ||
              parsed.body;
            previousReviewSummary = [
              `- 审查 Run: ${r.meta.run_id} (P0=${parsed.frontmatter.p0}, P1=${parsed.frontmatter.p1}, P2=${parsed.frontmatter.p2})`,
              defects.trim().slice(0, 1500),
            ].join("\n");
          }
        }
      }
      if (previousAcceptSummary === null && r.meta.stage === "accept") {
        const acceptReport = readYamlOptional(
          this.store.paths.runAcceptReportYaml(taskId, r.dirName),
          AcceptVerificationReportSchema,
        );
        if (acceptReport && (!acceptReport.gate_ok || acceptReport.verdict !== "pass")) {
          const lines: string[] = [
            `- 验收 Run: ${r.meta.run_id} (verdict=${acceptReport.verdict}, gate_ok=${acceptReport.gate_ok})`,
          ];
          if (acceptReport.rejection_reasons.length > 0) {
            lines.push(`- 拦截/失败原因: ${acceptReport.rejection_reasons.join(", ")}`);
          }
          if (acceptReport.prepare_error) {
            lines.push(`- 环境准备失败: ${acceptReport.prepare_error.slice(0, 800)}`);
          }
          const failedScenarios = acceptReport.scenarios.filter((s) => s.status === "fail");
          if (failedScenarios.length > 0) {
            lines.push(
              `- 失败场景:\n${failedScenarios
                .map((s) => `  - ${s.name}${s.note ? `: ${s.note}` : ""}`)
                .join("\n")}`,
            );
          }
          for (const svc of acceptReport.services) {
            if (svc.status === "crashed" || svc.status === "failed") {
              lines.push(
                `- 被测服务异常 [${svc.name}] (${svc.status}, exit=${String(svc.exit_code)}):`,
              );
              if (svc.tail_log) {
                lines.push("```\n" + svc.tail_log.slice(-1000) + "\n```");
              }
            }
          }
          if (acceptReport.traffic.error_responses.length > 0) {
            lines.push(
              `- 代理观测到的异常响应: ${acceptReport.traffic.error_responses
                .slice(0, 8)
                .map((e) => `${e.service} ${e.method} ${e.path} -> ${e.status}`)
                .join("; ")}`,
            );
          }
          const rawReceipt = r.hasReceipt
            ? readOptionalText(this.store.paths.receiptMd(taskId, r.dirName))
            : null;
          if (rawReceipt) {
            const parsedVerifier = parseAndValidateReceipt("verifier", rawReceipt);
            if (parsedVerifier.ok) {
              const detail = extractSection(parsedVerifier.body, "验收场景明细");
              if (detail) {
                lines.push(`- 验收说明:\n${detail.trim().slice(0, 1200)}`);
              }
            }
          }
          const evidenceDir = this.store.paths.runEvidenceDir(taskId, r.dirName);
          for (const ev of acceptReport.evidence_files) {
            if (!ev.valid || ev.kind !== "image" || previousAcceptImagePaths.length >= 4) {
              continue;
            }
            const normRel = normalizeDeclaredEvidenceRelPath(ev.rel_path);
            if (!normRel) continue;
            const absImg = path.resolve(evidenceDir, normRel);
            if (fs.existsSync(absImg)) {
              const magic = ev.mime_type ?? detectImageMagic(fs.readFileSync(absImg));
              if (magic === "image/png" || magic === "image/jpeg" || magic === "image/webp") {
                previousAcceptImagePaths.push({
                  path: absImg,
                  mimeType: magic,
                  filename: path.basename(absImg),
                });
              }
            }
          }
          if (previousAcceptImagePaths.length > 0) {
            lines.push(
              `- 失败视觉证据文件: ${previousAcceptImagePaths.map((a) => a.path).join(", ")}`,
            );
          }
          previousAcceptSummary = lines.join("\n");
        }
      }
      if (
        previousFailureSummary !== null &&
        previousReviewSummary !== null &&
        previousAcceptSummary !== null
      ) {
        break;
      }
    }

    return {
      previousFailureSummary,
      previousReviewSummary,
      previousAcceptSummary,
      previousAcceptImagePaths,
    };
  }

  private hasConsecutiveSameGateFailure(
    taskId: string,
    card: TaskCard,
    threshold: number,
  ): boolean {
    const runs = this.listCurrentWindowRuns(taskId, card);
    let latestFp: string | null = null;
    let streak = 0;

    for (let i = runs.length - 1; i >= 0; i--) {
      const r = runs[i]!;
      if (r.meta.stage === "advise" || r.meta.stage === "triage") {
        break;
      }
      if (r.meta.stage !== "implement" && r.meta.stage !== "verify") {
        if (r.meta.stage === "review") {
          // Review rejection shouldn't mask earlier gate failure checks, stop scanning gate streak.
          break;
        }
        continue;
      }
      const gate = readYamlOptional(
        this.store.paths.gateYaml(taskId, r.dirName),
        GateReportSchema,
      );
      const fp = gate ? computeGateFailureFingerprint(gate) : null;
      if (!fp) {
        break;
      }
      if (latestFp === null) {
        latestFp = fp;
        streak = 1;
      } else if (fp === latestFp) {
        streak += 1;
      } else {
        break;
      }
      if (streak >= threshold) {
        return true;
      }
    }
    return false;
  }

  private buildHandoffPayload(params: {
    card: TaskCard;
    runId: string;
    runDirName: string;
    stage: StageId;
    round: number;
    role: RoleId;
    cwd: string;
    inputRef?: string;
    mcpEnabled: boolean;
    rosterRoleId?: string;
    customInstructions?: string;
    escalatedFrom?: string;
    escalatedDiffStat?: string;
    deliverConflictNote?: string;
    acceptEnvContext?: AcceptEnvHandoffContext | null;
  }): HandoffPayload {
    const advisorReq =
      params.stage === "advise"
        ? this.readAdvisorRequest(params.card.id, params.card.contract_version)
        : null;
    const {
      previousFailureSummary,
      previousReviewSummary,
      previousAcceptSummary,
    } = this.buildPreviousDeltaSummaries(params.card.id, params.card, params.stage);
    return buildHandoffPayload({
      store: this.store,
      ...params,
      advisorReq,
      previousFailureSummary,
      previousReviewSummary,
      previousAcceptSummary,
    });
  }

  private async handleSchedulerDispatchError(
    taskId: string,
    error: unknown,
  ): Promise<void> {
    if (this.stopped) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    try {
      const card = this.store.readTaskCard(taskId);
      const derived = deriveTaskStatus(card, this.store.readStateEvents(taskId));
      if (derived.status !== "queued" && derived.status !== "running") {
        return;
      }

      if (isRateLimitErrorMessage(message)) {
        this.scheduler.markRateLimited(
          { agent: "unknown", model: "unknown" },
          this.rateLimitCooldownMs,
        );
        return;
      }

      const decision = PendingDecisionSchema.parse({
        id: `dec-${randomUUID().slice(0, 8)}`,
        task_id: taskId,
        contract_version: card.contract_version,
        reason: "dispatch_error",
        category: "dispatch_error",
        question: `任务 "${taskId}" 派发失败：${message}。请修正配置后继续或取消任务。`,
        options: [
          {
            id: "opt-retry",
            label: "重新入队重试",
            action: "resume",
            ...(derived.stage ? { target_stage: derived.stage } : {}),
            recommended: true,
          },
          {
            id: "opt-cancel",
            label: "取消任务",
            action: "cancel",
            recommended: false,
          },
        ],
        created_at: new Date().toISOString(),
      });
      this.transitionTaskToWaiting(taskId, decision);
    } catch {
      // Avoid unhandled rejection inside scheduler error callback
    }
  }

  private isTesterAgentModeEnabled(): boolean {
    const roster = this.store.readConfig("roster");
    const entry = roster?.roster.tester;
    return Boolean(entry?.enabled && entry.mode === "agent" && entry.primary);
  }

  private hasCompletedAgentRunInTail(
    taskId: string,
    card: TaskCard,
    targetStage: "verify" | "deliver",
    stopAtStage?: StageId,
  ): boolean {
    const runs = this.listCurrentWindowRuns(taskId, card);
    for (let i = runs.length - 1; i >= 0; i--) {
      const r = runs[i]!;
      if (stopAtStage !== undefined && r.meta.stage === stopAtStage) {
        return false;
      }
      if (r.meta.stage !== targetStage) {
        return false;
      }
      if (!r.hasReceipt) {
        continue;
      }
      const raw = readOptionalText(this.store.paths.receiptMd(taskId, r.dirName));
      if (!raw) {
        continue;
      }
      const parsed = parseAndValidateReceipt("worker", raw);
      if (
        parsed.ok &&
        parsed.frontmatter.run_id === r.meta.run_id &&
        parsed.frontmatter.contract_version === card.contract_version &&
        parsed.frontmatter.outcome === "completed"
      ) {
        if (targetStage === "verify") {
          const gate = readYamlOptional(
            this.store.paths.gateYaml(taskId, r.dirName),
            GateReportSchema,
          );
          const gatePassed =
            gate !== null &&
            gate.schema_ok &&
            gate.scope_ok &&
            gate.artifacts_ok !== false &&
            gate.accept_exit_code === 0;
          if (!gatePassed) {
            continue;
          }
        }
        return true;
      }
    }
    return false;
  }

  private async dispatchPlan(plan: DispatchPlan): Promise<void> {
    if (this.stopped || this.abortingBeforeDispatch.has(plan.taskId)) {
      return;
    }

    if (plan.stage === "verify") {
      await this.dispatchVerifyStage(plan);
      return;
    }

    if (plan.stage === "deliver") {
      await this.dispatchDeliverStage(plan);
      return;
    }

    if ((plan.stage === "plan" || plan.stage === "research") && plan.roleAssignment === null) {
      const nextStep = nextWorkflowStepAfter(plan.card, plan.stepIndex, plan.stage, plan.card.track);
      await this.advanceToNextStage(
        plan.taskId,
        nextStep?.stage ?? "implement",
        undefined,
        nextStep?.stepIndex ?? null,
      );
      return;
    }

    if (plan.stage === "accept" && plan.roleAssignment === null) {
      const decision = PendingDecisionSchema.parse({
        id: `dec-${randomUUID().slice(0, 8)}`,
        task_id: plan.taskId,
        contract_version: plan.contractVersion,
        reason: "human_accept_required",
        category: "human_accept",
        question: `任务 "${plan.card.title}" 开启了人工验收（human_accept），是否确认验收通过并进入交付？`,
        options: [
          {
            id: "opt-accept-deliver",
            label: "验收通过，开始交付",
            action: "resume",
            target_stage: "deliver",
            recommended: true,
          },
          {
            id: "opt-rework",
            label: "退回实施修改",
            action: "resume",
            target_stage: "implement",
            recommended: false,
          },
          {
            id: "opt-cancel",
            label: "取消任务",
            action: "cancel",
            recommended: false,
          },
        ],
        created_at: new Date().toISOString(),
      });
      this.transitionTaskToWaiting(plan.taskId, decision);
      return;
    }

    await this.dispatchAgentStageRun(plan);
  }

  private async dispatchAgentStageRun(
    plan: DispatchPlan,
    opts?: { deliverConflictNote?: string },
  ): Promise<void> {
    if (this.stopped || this.abortingBeforeDispatch.has(plan.taskId)) {
      return;
    }

    if (!plan.role || !plan.roleAssignment) {
      throw new Error(
        `Role "${plan.role ?? plan.stage}" is not configured in roles.yaml for task "${plan.taskId}"`,
      );
    }

    const assignment = plan.roleAssignment;
    const backend = await this.findBackendWithAgent(
      assignment.backendId,
      assignment.agent,
    );
    if (!backend) {
      throw new Error(
        `No registered ExecutionBackend available for agent "${assignment.agent}" (role "${plan.role}")`,
      );
    }

    const caps = await backend.capabilities(assignment.agent);
    assertRoleAgentEligible(plan.role, assignment.agent, caps);

    const effectiveAcceptEntry =
      plan.stage === "accept" ? this.resolveEffectiveAcceptEntry(plan.card) : null;
    if (
      plan.stage === "accept" &&
      effectiveAcceptEntry &&
      effectiveAcceptEntry.kind !== "none" &&
      (effectiveAcceptEntry.required_capability === "browser" ||
        effectiveAcceptEntry.required_capability === "desktop_gui")
    ) {
      const declaredCaps = this.resolveVerifierCapabilities(assignment.rosterRoleId);
      if (!declaredCaps.includes(effectiveAcceptEntry.required_capability)) {
        const capLabel =
          effectiveAcceptEntry.required_capability === "browser"
            ? "真实浏览器（browser）"
            : "桌面 GUI（desktop_gui）";
        const decision = PendingDecisionSchema.parse({
          id: `dec-${randomUUID().slice(0, 8)}`,
          task_id: plan.taskId,
          contract_version: plan.contractVersion,
          reason: "verifier_capability_missing",
          category: "verifier_capability_missing",
          question: `任务 "${plan.card.title}" 的真实验收入口要求 ${capLabel} 能力，但当前验收槽位（${assignment.rosterRoleId ?? "verifier"}）仅声明了 [${declaredCaps.join(", ")}]。请在「编排阵容」确认并启用该槽位的对应能力，或选择转交人工验收/退回实施：`,
          options: [
            {
              id: "opt-retry-accept",
              label: "已调整验收阵容能力，重试真实验收",
              action: "resume",
              target_stage: "accept",
              recommended: true,
            },
            {
              id: "opt-manual-deliver",
              label: "转为人工已验收，直接进入交付",
              action: "resume",
              target_stage: "deliver",
              recommended: false,
            },
            {
              id: "opt-back-implement",
              label: "退回实施修改",
              action: "resume",
              target_stage: "implement",
              recommended: false,
            },
          ],
          created_at: new Date().toISOString(),
        });
        this.transitionTaskToWaiting(plan.taskId, decision);
        return;
      }
    }

    const budgetEval = evaluateDispatchBudget(this.store, plan.card);
    for (const warn of budgetEval.warnings) {
      if (!this.budgetWarnedKeys.has(warn.key)) {
        this.budgetWarnedKeys.add(warn.key);
        if (warn.status.limit_usd !== null) {
          void this.remoteNotifier?.notifyBudgetAlert({
            scope: warn.scope,
            level: "warning",
            spentUsd: warn.status.spent_usd,
            limitUsd: warn.status.limit_usd,
            ...(warn.scope === "card" ? { taskId: plan.taskId } : {}),
            priority: plan.card.priority,
          });
        }
      }
    }
    if (budgetEval.blocked && budgetEval.blockingStatus && budgetEval.blockingStatus.limit_usd !== null) {
      const bScope = budgetEval.blockingScope ?? budgetEval.blockingStatus.scope;
      const bStatus = budgetEval.blockingStatus;
      const scopeLabel =
        bScope === "card" ? "单卡 USD 预算" : bScope === "daily" ? "全局每日 USD 预算" : "全局每月 USD 预算";
      const raiseTarget = Math.max(
        Number((bStatus.spent_usd * 1.5).toFixed(2)),
        Number(((bStatus.limit_usd ?? 0) * 1.5).toFixed(2)),
        bScope === "card" ? 0.5 : 1,
      );
      void this.remoteNotifier?.notifyBudgetAlert({
        scope: bScope,
        level: "exceeded",
        spentUsd: bStatus.spent_usd,
        limitUsd: bStatus.limit_usd!,
        ...(bScope === "card" ? { taskId: plan.taskId } : {}),
        priority: "P1",
      });
      const budgetDecision = PendingDecisionSchema.parse({
        id: `dec-${randomUUID().slice(0, 8)}`,
        task_id: plan.taskId,
        contract_version: plan.contractVersion,
        reason: "budget_exceeded",
        category: "budget_exceeded",
        question: `任务 "${plan.card.title}" 触发${scopeLabel}硬熔断：已消耗 $${bStatus.spent_usd.toFixed(4)} >= 上限 $${bStatus.limit_usd!.toFixed(4)}。请选择是否追加预算并继续推进：`,
        options:
          bScope === "card"
            ? [
                {
                  id: "opt-raise-card-budget",
                  label: `上调本卡预算至 $${raiseTarget.toFixed(2)} 并继续`,
                  action: "resume",
                  recommended: true,
                },
                {
                  id: "opt-unlimited-card-budget",
                  label: "移除本卡金额上限并继续",
                  action: "resume",
                  recommended: false,
                },
                {
                  id: "opt-cancel",
                  label: "取消任务",
                  action: "cancel",
                  recommended: false,
                },
              ]
            : [
                {
                  id: "opt-raise-global-budget",
                  label: `上调${bScope === "daily" ? "每日" : "每月"}预算至 $${raiseTarget.toFixed(2)} 并继续`,
                  action: "resume",
                  recommended: true,
                },
                {
                  id: "opt-pause",
                  label: "暂停任务等待次日/人工恢复",
                  action: "pause",
                  recommended: false,
                },
                {
                  id: "opt-cancel",
                  label: "取消任务",
                  action: "cancel",
                  recommended: false,
                },
              ],
        created_at: new Date().toISOString(),
      });
      this.transitionTaskToWaiting(plan.taskId, budgetDecision);
      return;
    }

    const workspace = await this.prepareWorkspaceForPlan(plan.card, plan.stage);
    const runDirName = this.allocateRunDirName(plan.taskId, plan.stage);
    const runId = `run-${plan.taskId}-${plan.stage}-r${plan.round}-v${plan.contractVersion}-${randomUUID().slice(0, 6)}`;
    const now = new Date().toISOString();

    let acceptEnvContext: AcceptEnvHandoffContext | null = null;
    if (plan.stage === "accept") {
      const evidenceDir = this.store.paths.runEvidenceDir(plan.taskId, runDirName);
      ensureDir(evidenceDir);
      const entry = effectiveAcceptEntry ?? { kind: "none" as const };
      if (entry.kind !== "none") {
        await this.stopAcceptEnv(plan.taskId);
        const startRes = await this.acceptEnvStarter({
          cwd: workspace.cwd,
          acceptEnvDir: this.store.paths.runAcceptEnvDir(plan.taskId, runDirName),
          entry,
        });
        if (!startRes.ok) {
          if (startRes.session) {
            await startRes.session.stop().catch(() => {});
          }
          const failedRunMeta: RunMeta = {
            schema_version: 1,
            run_id: runId,
            task_id: plan.taskId,
            stage: "accept",
            ...(plan.stepIndex !== null ? { step_index: plan.stepIndex } : {}),
            round: plan.round,
            role: plan.role,
            ...(assignment.rosterRoleId !== undefined ? { roster_role: assignment.rosterRoleId } : {}),
            contract_version: plan.contractVersion,
            backend_id: backend.backendId,
            agent: assignment.agent,
            model: assignment.model,
            session_ref: {
              backendId: backend.backendId,
              sessionId: `env-failed-${runId}`,
            },
            cwd: workspace.cwd,
            ...(workspace.inputRef !== undefined ? { input_ref: workspace.inputRef } : {}),
            started_at: now,
          };
          const leaseRes = this.store.persistRunBeforeDispatch(
            failedRunMeta,
            runDirName,
            `# 被测环境拉起失败 (${entry.kind})\n\n${startRes.prepareError ?? startRes.errorMessage ?? "unknown error"}\n`,
          );
          if (!leaseRes.acquired) {
            return;
          }
          this.store.sqlite.completeStageLease(
            plan.taskId,
            runId,
            plan.contractVersion,
            new Date().toISOString(),
          );
          const failedReport: AcceptVerificationReport = AcceptVerificationReportSchema.parse({
            schema_version: 1,
            run_id: runId,
            contract_version: plan.contractVersion,
            checked_at: new Date().toISOString(),
            entry_kind: entry.kind,
            verdict: "fail",
            gate_ok: false,
            rejection_reasons: ["accept_env_startup_failed"],
            services: startRes.services,
            traffic: startRes.traffic,
            evidence_files: [],
            scenarios: [],
            ...(startRes.prepareError ?? startRes.errorMessage
              ? { prepare_error: startRes.prepareError ?? startRes.errorMessage }
              : {}),
          });
          writeYamlAtomic(
            this.store.paths.runAcceptReportYaml(plan.taskId, runDirName),
            failedReport,
            AcceptVerificationReportSchema,
          );
          const windowRuns = this.listCurrentWindowRuns(plan.taskId, plan.card);
          let startupFailCount = 0;
          for (const wr of windowRuns) {
            if (wr.meta.stage !== "accept") continue;
            const rep = readYamlOptional(
              this.store.paths.runAcceptReportYaml(plan.taskId, wr.dirName),
              AcceptVerificationReportSchema,
            );
            if (rep?.rejection_reasons.includes("accept_env_startup_failed")) {
              startupFailCount += 1;
            }
          }
          const guard: ExpectedRunGuard = {
            runId,
            contractVersion: plan.contractVersion,
          };
          if (startupFailCount >= Math.max(1, plan.card.limits.retries_per_stage)) {
            const decision = PendingDecisionSchema.parse({
              id: `dec-${randomUUID().slice(0, 8)}`,
              task_id: plan.taskId,
              run_id: runId,
              contract_version: plan.contractVersion,
              reason: "accept_env_startup_failed",
              category: "accept_env_startup_failed",
              question: `被测环境连续 ${startupFailCount} 次拉起失败（${startRes.prepareError ?? startRes.errorMessage ?? "请检查启动命令或端口配置"}），请选择退回实施修复或调整空间配置后重试：`,
              options: [
                {
                  id: "opt-back-implement",
                  label: "退回实施根据启动日志修复",
                  action: "resume",
                  target_stage: "implement",
                  recommended: true,
                },
                {
                  id: "opt-retry-accept",
                  label: "已调整配置，重新拉起验收",
                  action: "resume",
                  target_stage: "accept",
                  recommended: false,
                },
                {
                  id: "opt-cancel",
                  label: "取消任务",
                  action: "cancel",
                  recommended: false,
                },
              ],
              created_at: new Date().toISOString(),
            });
            this.transitionTaskToWaiting(plan.taskId, decision, guard);
            return;
          }
          const restartIdx = findLoopRestartStepIndex(
            plan.card,
            "implement",
            plan.card.track,
          );
          await this.advanceToNextStage(plan.taskId, "implement", guard, restartIdx);
          return;
        }

        if (startRes.session) {
          this.activeAcceptEnvs.set(plan.taskId, startRes.session);
        }
        this.activeAcceptEnvConfigs.set(plan.taskId, entry);
        acceptEnvContext = {
          entryKind: entry.kind,
          requiredCapability: entry.required_capability,
          ...(startRes.primaryUrl !== undefined ? { primaryUrl: startRes.primaryUrl } : {}),
          services: startRes.services,
          observeHttp: entry.kind === "http_server" && entry.observe_http !== false,
          ...(entry.kind === "cli_binary" && entry.entry_hint !== undefined
            ? { entryHint: entry.entry_hint }
            : {}),
          evidenceDir,
        };
      } else {
        this.activeAcceptEnvConfigs.set(plan.taskId, entry);
        acceptEnvContext = {
          entryKind: "none",
          evidenceDir,
        };
      }
    }

    let escalatedDiffStat: string | undefined;
    if (
      assignment.escalatedFrom &&
      plan.card.workspace_mode === "git_worktree" &&
      fs.existsSync(workspace.cwd)
    ) {
      const diffArgs = workspace.inputRef
        ? ["-C", workspace.cwd, "diff", "--stat", workspace.inputRef]
        : ["-C", workspace.cwd, "status", "--short"];
      const rawStat = await runGitCommand(diffArgs).catch(() => "");
      if (rawStat.trim().length > 0) {
        escalatedDiffStat = rawStat.trim().slice(0, 1_200);
      }
    }

    const handoff = this.buildHandoffPayload({
      card: plan.card,
      runId,
      runDirName,
      stage: plan.stage,
      round: plan.round,
      role: plan.role,
      cwd: workspace.cwd,
      inputRef: workspace.inputRef,
      mcpEnabled: caps.mcpInjection,
      ...(assignment.rosterRoleId !== undefined ? { rosterRoleId: assignment.rosterRoleId } : {}),
      ...(assignment.customInstructions !== undefined
        ? { customInstructions: assignment.customInstructions }
        : {}),
      ...(assignment.escalatedFrom !== undefined
        ? { escalatedFrom: assignment.escalatedFrom }
        : {}),
      ...(escalatedDiffStat !== undefined ? { escalatedDiffStat } : {}),
      ...(opts?.deliverConflictNote !== undefined
        ? { deliverConflictNote: opts.deliverConflictNote }
        : {}),
      ...(acceptEnvContext !== null ? { acceptEnvContext } : {}),
    });

    const isReadOnly =
      isReadOnlyRole(plan.role) ||
      (assignment.perm !== undefined && isReadOnlyRosterPermission(assignment.perm));

    let checkpointRef: string | undefined;
    if (!isReadOnly && plan.card.workspace_mode === "git_worktree") {
      try {
        const ckpt = await createGitWorktreeCheckpoint({
          worktreePath: workspace.cwd,
          taskId: plan.taskId,
          runId,
          phase: "pre",
          stage: plan.stage,
          round: plan.round,
        });
        checkpointRef = ckpt.ref;
      } catch {
        // Checkpoint creation is best-effort and never blocks stage execution.
      }
    }

    const canTryWarm =
      plan.stage === "implement" &&
      plan.role === "worker" &&
      !assignment.freshContext &&
      caps.warmSessionReuse === true &&
      !this.hasConsecutiveSameGateFailure(plan.taskId, plan.card, 2);

    let warmEntry = canTryWarm
      ? this.warmPool.takeMatching(
          {
            taskId: plan.taskId,
            backendId: backend.backendId,
            agent: assignment.agent,
            model: assignment.model,
            cwd: workspace.cwd,
            rosterRoleId: assignment.rosterRoleId,
            contractVersion: plan.contractVersion,
          },
          Date.now(),
          this.getWarmCacheTtlMs(),
        )
      : null;

    if (warmEntry !== null) {
      const probe = await backend.probe(warmEntry.sessionRef).catch(() => null);
      if (!probe || !probe.alive || probe.status !== "idle") {
        void backend.cancel(warmEntry.sessionRef).catch(() => {});
        warmEntry = null;
      }
    }

    let alreadyPersistedLease = false;
    if (warmEntry !== null) {
      const warmMessage = `# HANDOFF (热会话续跑 · 继承自 ${warmEntry.lastRunId})\n\n${handoff.dynamicTail}`;
      const warmSessionRef: SessionRef = {
        ...warmEntry.sessionRef,
        meta: {
          ...(warmEntry.sessionRef.meta ?? {}),
          kilnSessionKey: warmEntry.sessionKey,
        },
      };
      const warmRunMeta: RunMeta = {
        schema_version: 1,
        run_id: runId,
        task_id: plan.taskId,
        stage: plan.stage,
        ...(plan.stepIndex !== null ? { step_index: plan.stepIndex } : {}),
        round: plan.round,
        role: plan.role,
        ...(assignment.rosterRoleId !== undefined ? { roster_role: assignment.rosterRoleId } : {}),
        contract_version: plan.contractVersion,
        backend_id: backend.backendId,
        agent: assignment.agent,
        model: assignment.model,
        session_ref: warmSessionRef,
        session_reused: true,
        parent_run_id: warmEntry.lastRunId,
        ...(assignment.escalatedFrom !== undefined
          ? { escalated_from: assignment.escalatedFrom }
          : {}),
        ...(assignment.heterogeneityLevel !== undefined
          ? { heterogeneity_level: assignment.heterogeneityLevel }
          : {}),
        cwd: workspace.cwd,
        ...(workspace.inputRef !== undefined ? { input_ref: workspace.inputRef } : {}),
        ...(checkpointRef !== undefined ? { checkpoint_ref: checkpointRef } : {}),
        started_at: now,
      };
      const leaseResult = this.store.persistRunBeforeDispatch(
        warmRunMeta,
        runDirName,
        warmMessage,
      );
      if (!leaseResult.acquired) {
        void backend.cancel(warmEntry.sessionRef).catch(() => {});
        return;
      }
      alreadyPersistedLease = true;
      this.syncCaffeinate();
      this.publishTaskUpdated(plan.taskId, {
        status: "running",
        stage: plan.stage,
        round: plan.round,
        contractVersion: plan.contractVersion,
      });

      this.sessionKeyByRunId.set(runId, warmEntry.sessionKey);
      this.reuseCountByRunId.set(runId, warmEntry.reuseCount + 1);
      this.startingBackendCount += 1;
      let sendSucceeded = false;
      try {
        await backend.send(warmEntry.sessionRef, warmMessage);
        sendSucceeded = true;
      } catch {
        this.sessionKeyByRunId.delete(runId);
        this.reuseCountByRunId.delete(runId);
        void backend.cancel(warmEntry.sessionRef).catch(() => {});
        warmEntry = null;
      } finally {
        this.startingBackendCount = Math.max(0, this.startingBackendCount - 1);
      }
      if (sendSucceeded) {
        this.attachSessionConsumer(
          plan.taskId,
          runDirName,
          warmRunMeta,
          backend,
          warmSessionRef,
        );
        this.flushDeferredApprovals();
        return;
      }
    }

    if (!canTryWarm) {
      this.warmPool.evictTask(plan.taskId);
    }

    const handoffMarkdown = handoff.fullMarkdown;
    const coldSessionKey =
      plan.stage === "implement" &&
      plan.role === "worker" &&
      caps.warmSessionReuse === true
        ? `sk-${randomUUID().slice(0, 12)}`
        : undefined;

    const placeholderSessionRef: SessionRef = {
      backendId: backend.backendId,
      sessionId: `pending-${runId}`,
      ...(coldSessionKey !== undefined ? { meta: { kilnSessionKey: coldSessionKey } } : {}),
    };

    const runMeta: RunMeta = {
      schema_version: 1,
      run_id: runId,
      task_id: plan.taskId,
      stage: plan.stage,
      ...(plan.stepIndex !== null ? { step_index: plan.stepIndex } : {}),
      round: plan.round,
      role: plan.role,
      ...(assignment.rosterRoleId !== undefined ? { roster_role: assignment.rosterRoleId } : {}),
      contract_version: plan.contractVersion,
      backend_id: backend.backendId,
      agent: assignment.agent,
      model: assignment.model,
      session_ref: placeholderSessionRef,
      ...(assignment.escalatedFrom !== undefined
        ? { escalated_from: assignment.escalatedFrom }
        : {}),
      ...(assignment.heterogeneityLevel !== undefined
        ? { heterogeneity_level: assignment.heterogeneityLevel }
        : {}),
      cwd: workspace.cwd,
      ...(workspace.inputRef !== undefined ? { input_ref: workspace.inputRef } : {}),
      ...(checkpointRef !== undefined ? { checkpoint_ref: checkpointRef } : {}),
      started_at: now,
    };

    if (alreadyPersistedLease) {
      writeYamlAtomic(
        this.store.paths.runYaml(plan.taskId, runDirName),
        runMeta,
        RunMetaSchema,
      );
      writeFileAtomic(this.store.paths.handoffMd(plan.taskId, runDirName), handoffMarkdown);
    } else {
      const leaseResult = this.store.persistRunBeforeDispatch(
        runMeta,
        runDirName,
        handoffMarkdown,
      );
      if (!leaseResult.acquired) {
        return;
      }
      this.syncCaffeinate();
      this.publishTaskUpdated(plan.taskId, {
        status: "running",
        stage: plan.stage,
        round: plan.round,
        contractVersion: plan.contractVersion,
      });
    }

    if (coldSessionKey !== undefined) {
      this.sessionKeyByRunId.set(runId, coldSessionKey);
      this.reuseCountByRunId.set(runId, 0);
    }

    const mcpServers: McpStdioMountSpec[] | undefined = caps.mcpInjection
      ? [
          {
            name: "kiln",
            command: this.mcpServerCommand.command,
            args: [...this.mcpServerCommand.args],
            env: {
              KILN_RUN_TOKEN: this.issueRunToken({
                taskId: plan.taskId,
                runId,
                role: plan.role,
                contractVersion: plan.contractVersion,
                ...(coldSessionKey !== undefined ? { sessionKey: coldSessionKey } : {}),
                ttlSeconds: 7_200,
              }),
              KILN_SOCK_PATH: this.socketPath,
              KILN_HOME: this.store.paths.home,
            },
          },
        ]
      : undefined;

    const attachments: RunAttachmentInput[] = resolveRunAttachmentInputs(this.store, {
      kind: "task",
      taskId: plan.taskId,
    });
    if (plan.stage === "implement" && caps.imageInput === true) {
      const { previousAcceptImagePaths } = this.buildPreviousDeltaSummaries(
        plan.taskId,
        plan.card,
        plan.stage,
      );
      const seenPaths = new Set(attachments.map((a) => a.path));
      for (const img of previousAcceptImagePaths) {
        if (!seenPaths.has(img.path)) {
          seenPaths.add(img.path);
          attachments.push(img);
        }
      }
    }

    const runSpec: BackendRunSpec = {
      runId,
      taskId: plan.taskId,
      role: plan.role,
      agent: assignment.agent,
      model: assignment.model,
      ...(assignment.reasoningEffort !== undefined
        ? { reasoningEffort: assignment.reasoningEffort }
        : {}),
      cwd: workspace.cwd,
      prompt: handoffMarkdown,
      freshContext: assignment.freshContext,
      allowFullAccessFallback: assignment.allowFullAccessFallback,
      readOnly: isReadOnly,
      ...(mcpServers !== undefined ? { mcpServers } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };

    if (
      (plan.stage === "plan" ||
        plan.stage === "advise" ||
        plan.stage === "research" ||
        plan.stage === "accept" ||
        ((plan.stage === "review" || plan.stage === "triage") &&
          (!this.approvalHandler || caps.readOnlySandbox === false))) &&
      plan.card.workspace_mode === "git_worktree"
    ) {
      const preDirtySig = await this.computeWorktreeDirtySignature(workspace.cwd);
      this.advisorPreRunDirtySignatures.set(runId, preDirtySig);
    }

    let sessionRef: SessionRef;
    this.startingBackendCount += 1;
    try {
      sessionRef = await backend.start(runSpec);
    } catch (err) {
      if (plan.stage === "accept") {
        await this.stopAcceptEnv(plan.taskId);
        this.activeAcceptEnvConfigs.delete(plan.taskId);
      }
      await this.handleBackendStartError(plan, runDirName, runMeta, err);
      return;
    } finally {
      this.startingBackendCount = Math.max(0, this.startingBackendCount - 1);
    }

    if (coldSessionKey !== undefined) {
      sessionRef = {
        ...sessionRef,
        meta: {
          ...(sessionRef.meta ?? {}),
          kilnSessionKey: coldSessionKey,
        },
      };
    }

    const updatedRunMeta: RunMeta = {
      ...runMeta,
      session_ref: sessionRef,
    };
    writeYamlAtomic(
      this.store.paths.runYaml(plan.taskId, runDirName),
      updatedRunMeta,
      RunMetaSchema,
    );

    const latestCard = readYamlOptional(
      this.store.paths.cardYaml(plan.taskId),
      TaskCardSchema,
    );
    const latestDerived = latestCard
      ? deriveTaskStatus(latestCard, this.store.readStateEvents(plan.taskId))
      : null;
    const existingLease = this.store.getStageLease(plan.taskId);
    const runStillValid =
      !this.stopped &&
      latestDerived?.status === "running" &&
      latestDerived.activeRunId === runId &&
      latestCard?.contract_version === plan.contractVersion &&
      existingLease?.run_id === runId &&
      existingLease.contract_version === plan.contractVersion &&
      (existingLease.state === "active" || existingLease.state === "completed");

    if (!runStillValid) {
      this.advisorPreRunDirtySignatures.delete(runId);
      if (plan.stage === "accept") {
        await this.stopAcceptEnv(plan.taskId);
        this.activeAcceptEnvConfigs.delete(plan.taskId);
      }
      if (existingLease?.state === "active" && existingLease.run_id === runId) {
        this.store.sqlite.expireActiveLeaseByTask(
          plan.taskId,
          new Date().toISOString(),
          "expired",
        );
      }
      await backend.cancel(sessionRef).catch(() => {});
      this.syncCaffeinate();
      return;
    }

    if (existingLease.state === "active") {
      this.store.sqlite.acquireStageLease({
        task_id: plan.taskId,
        run_id: runId,
        stage: plan.stage,
        round: plan.round,
        contract_version: plan.contractVersion,
        session_ref: JSON.stringify(sessionRef),
        started_at: now,
        heartbeat_at: new Date().toISOString(),
      });
    }

    this.attachSessionConsumer(
      plan.taskId,
      runDirName,
      updatedRunMeta,
      backend,
      sessionRef,
    );
    this.flushDeferredApprovals();
  }

  private async handleBackendStartError(
    plan: DispatchPlan,
    runDirName: string,
    runMeta: RunMeta,
    err: unknown,
  ): Promise<void> {
    if (
      !this.isRunStillCurrent(plan.taskId, runMeta.run_id, plan.contractVersion, true)
    ) {
      const existingLease = this.store.getStageLease(plan.taskId);
      const latestCard = readYamlOptional(
        this.store.paths.cardYaml(plan.taskId),
        TaskCardSchema,
      );
      if (
        this.isRunStillCurrent(plan.taskId, runMeta.run_id, plan.contractVersion, false) &&
        latestCard?.contract_version === plan.contractVersion &&
        existingLease?.state === "completed" &&
        existingLease.run_id === runMeta.run_id &&
        existingLease.contract_version === plan.contractVersion &&
        fs.existsSync(this.store.paths.receiptMd(plan.taskId, runDirName))
      ) {
        await this.runTrackedStageOperation(
          plan.taskId,
          runMeta.run_id,
          async (signal) => {
            try {
              await this.finalizeActiveRun(
                plan.taskId,
                runDirName,
                runMeta,
                null,
                signal,
              );
            } catch (finalizeErr) {
              if (
                !signal.aborted &&
                this.isRunStillCurrent(
                  plan.taskId,
                  runMeta.run_id,
                  plan.contractVersion,
                )
              ) {
                await this.applyStageFailure(
                  plan.taskId,
                  plan.stage,
                  runMeta,
                  {
                    kind: "runtime_error",
                    message:
                      finalizeErr instanceof Error
                        ? finalizeErr.message
                        : String(finalizeErr),
                  },
                  {
                    runId: runMeta.run_id,
                    contractVersion: plan.contractVersion,
                  },
                ).catch(() => {
                  this.syncCaffeinate();
                });
              }
            }
          },
        );
        return;
      }

      if (
        existingLease?.state === "active" &&
        existingLease.run_id === runMeta.run_id
      ) {
        this.store.sqlite.expireActiveLeaseByTask(
          plan.taskId,
          new Date().toISOString(),
          "expired",
        );
      }
      this.syncCaffeinate();
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    const guard: ExpectedRunGuard = {
      runId: runMeta.run_id,
      contractVersion: plan.contractVersion,
    };

    if (isRateLimitErrorMessage(message)) {
      const now = new Date().toISOString();
      writeFileAtomic(
        path.join(this.store.paths.runDir(plan.taskId, runDirName), "RATE_LIMITED"),
        `${now}\n`,
      );
      this.store.sqlite.expireActiveLeaseByTask(plan.taskId, now, "expired");
      if (!this.isRunStillCurrent(plan.taskId, runMeta.run_id, plan.contractVersion)) {
        this.syncCaffeinate();
        return;
      }
      this.scheduler.markRateLimited(
        {
          backendId: runMeta.backend_id,
          agent: runMeta.agent,
          model: runMeta.model,
        },
        this.rateLimitCooldownMs,
      );
      this.store.appendStateEvent(plan.taskId, {
        type: "queued",
        at: now,
      });
      this.syncCaffeinate();
      this.publishTaskUpdated(plan.taskId, {
        status: "queued",
        stage: plan.stage,
      });
      void this.wake();
      return;
    }

    if (
      err instanceof FullAccessOnlyProviderError ||
      err instanceof IneligibleRoleAgentError
    ) {
      const decision = PendingDecisionSchema.parse({
        id: `dec-${randomUUID().slice(0, 8)}`,
        task_id: plan.taskId,
        run_id: runMeta.run_id,
        contract_version: plan.contractVersion,
        reason: "backend_policy_blocked",
        category: "backend_policy",
        question: `${message}。请在设置调整角色配置后继续推进或取消任务。`,
        options: [
          {
            id: "opt-retry",
            label: "已调整配置，重新派发",
            action: "resume",
            target_stage: plan.stage,
            recommended: true,
          },
          {
            id: "opt-cancel",
            label: "取消任务",
            action: "cancel",
            recommended: false,
          },
        ],
        created_at: new Date().toISOString(),
      });
      this.transitionTaskToWaiting(plan.taskId, decision, guard);
      return;
    }

    await this.applyStageFailure(
      plan.taskId,
      plan.stage,
      runMeta,
      { kind: "runtime_error", message },
      guard,
    );
  }

  private attachSessionConsumer(
    taskId: string,
    runDirName: string,
    runMeta: RunMeta,
    backend: ExecutionBackend,
    sessionRef: SessionRef,
  ): void {
    const abortController = new AbortController();
    const handle: ActiveRunHandle = {
      taskId,
      runId: runMeta.run_id,
      runDirName,
      role: runMeta.role,
      stage: runMeta.stage,
      contractVersion: runMeta.contract_version,
      backend,
      sessionRef,
      abortController,
      consumePromise: Promise.resolve(),
      cancelledByControl: false,
    };

    handle.consumePromise = (async () => {
      let exitEvent: Extract<RunEvent, { kind: "exit" }> | null = null;

      try {
        try {
          for await (const ev of backend.events(sessionRef)) {
            this.store.recordRunEvent(taskId, runDirName, ev);

            if (ev.kind === "session_bound") {
              const currentMeta = readYamlOptional(
                this.store.paths.runYaml(taskId, runDirName),
                RunMetaSchema,
              );
              const baseMeta = currentMeta ?? runMeta;
              const nextMeta: RunMeta = {
                ...baseMeta,
                session_ref: {
                  ...baseMeta.session_ref,
                  meta: {
                    ...(baseMeta.session_ref.meta ?? {}),
                    providerSessionId: ev.providerSessionId,
                    ...(ev.providerSessionPath !== undefined
                      ? { providerSessionPath: ev.providerSessionPath }
                      : {}),
                  },
                },
              };
              runMeta = nextMeta;
              handle.sessionRef = nextMeta.session_ref;
              writeYamlAtomic(
                this.store.paths.runYaml(taskId, runDirName),
                nextMeta,
                RunMetaSchema,
              );
              this.publishTaskUpdated(taskId, {
                stage: runMeta.stage,
                round: runMeta.round,
                contractVersion: runMeta.contract_version,
              });
            }

            if (ev.kind === "message" && ev.delta) {
              this.rateTracker.recordDelta({ taskId, text: ev.text });
            }

            if (ev.kind === "context_window") {
              const pct =
                ev.percent ??
                (ev.contextWindowTokens > 0
                  ? Math.min(100, Math.max(0, (ev.usedTokens / ev.contextWindowTokens) * 100))
                  : 0);
              this.latestContextPercentByRunId.set(runMeta.run_id, pct);
            }

            if (ev.kind === "rate_limited") {
              const cooldownMs =
                ev.retryAfterSec !== undefined
                  ? Math.max(1_000, ev.retryAfterSec * 1_000)
                  : this.rateLimitCooldownMs;
              this.scheduler.markRateLimited(
                {
                  backendId: runMeta.backend_id,
                  agent: runMeta.agent,
                  model: runMeta.model,
                },
                cooldownMs,
              );
              const untilIso =
                this.providerHealth?.recordRateLimit(ev.provider, {
                  ...(ev.retryAfterSec !== undefined ? { retryAfterSec: ev.retryAfterSec } : {}),
                  ...(ev.until !== undefined ? { until: ev.until } : {}),
                  ...(ev.detail !== undefined ? { detail: ev.detail } : {}),
                }) ?? ev.until;
              this.sseHub.publish({
                type: "provider.status",
                providerId: ev.provider,
                status: "cooldown",
                ...(untilIso !== undefined ? { cooldownUntil: untilIso } : {}),
                ...(ev.detail !== undefined ? { detail: ev.detail } : {}),
                at: ev.at,
              });
            }

            this.sseHub.publish({
              type: "run.event",
              taskId,
              runId: runMeta.run_id,
              event: ev,
            });

            if (ev.kind === "exit") {
              exitEvent = ev;
            }
          }
        } catch (err) {
          if (!handle.cancelledByControl && !this.stopped) {
            exitEvent = {
              kind: "exit",
              at: new Date().toISOString(),
              reason: "failed",
              detail: err instanceof Error ? err.message : String(err),
            };
          }
        } finally {
          if (this.activeRuns.get(taskId)?.runId === runMeta.run_id) {
            this.rateTracker.clearTask(taskId);
          }
        }

        if (
          this.stopped ||
          handle.cancelledByControl ||
          abortController.signal.aborted
        ) {
          return;
        }

        try {
          await this.finalizeActiveRun(
            taskId,
            runDirName,
            runMeta,
            exitEvent,
            abortController.signal,
          );
        } catch (err) {
          if (
            !handle.cancelledByControl &&
            !abortController.signal.aborted &&
            this.isRunStillCurrent(taskId, runMeta.run_id, runMeta.contract_version)
          ) {
            this.store.sqlite.expireActiveLeaseByTask(
              taskId,
              new Date().toISOString(),
              "expired",
            );
            await this.applyStageFailure(
              taskId,
              runMeta.stage,
              runMeta,
              {
                kind: "runtime_error",
                message: err instanceof Error ? err.message : String(err),
              },
              {
                runId: runMeta.run_id,
                contractVersion: runMeta.contract_version,
              },
            ).catch(() => {
              this.syncCaffeinate();
            });
          }
        }
      } finally {
        if (this.activeRuns.get(taskId)?.runId === runMeta.run_id) {
          this.activeRuns.delete(taskId);
        }
      }
    })();

    this.activeRuns.set(taskId, handle);
  }

  private async finalizeActiveRun(
    taskId: string,
    runDirName: string,
    runMeta: RunMeta,
    exitEvent: Extract<RunEvent, { kind: "exit" }> | null,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.stopped || signal?.aborted) {
      this.syncCaffeinate();
      return;
    }

    const card = this.store.readTaskCard(taskId);
    const derived = deriveTaskStatus(card, this.store.readStateEvents(taskId));

    // Guard 1: task paused, cancelled, finished, contract bumped, or superseded by newer run.
    if (
      derived.status === "paused" ||
      derived.status === "cancelled" ||
      derived.status === "done" ||
      derived.status === "external" ||
      card.contract_version !== runMeta.contract_version
    ) {
      this.syncCaffeinate();
      return;
    }

    // Guard 2: already moved to waiting via wb_ask_decision during this turn.
    if (derived.status === "waiting" && this.pendingDecisions.get(taskId) !== null) {
      this.syncCaffeinate();
      return;
    }

    if (derived.status !== "running" || derived.activeRunId !== runMeta.run_id) {
      this.syncCaffeinate();
      return;
    }

    const guard: ExpectedRunGuard = {
      runId: runMeta.run_id,
      contractVersion: runMeta.contract_version,
    };

    if (exitEvent?.reason === "failed") {
      const detail = exitEvent.detail ?? "run_failed";
      if (isRateLimitErrorMessage(detail)) {
        const now = new Date().toISOString();
        writeFileAtomic(
          path.join(this.store.paths.runDir(taskId, runDirName), "RATE_LIMITED"),
          `${now}\n`,
        );
        this.store.sqlite.expireActiveLeaseByTask(taskId, now, "expired");
        if (!this.isRunStillCurrent(taskId, runMeta.run_id, runMeta.contract_version)) {
          this.syncCaffeinate();
          return;
        }
        this.scheduler.markRateLimited(
          {
            backendId: runMeta.backend_id,
            agent: runMeta.agent,
            model: runMeta.model,
          },
          this.rateLimitCooldownMs,
        );
        this.store.appendStateEvent(taskId, {
          type: "queued",
          at: now,
        });
        this.syncCaffeinate();
        this.publishTaskUpdated(taskId, { status: "queued", stage: runMeta.stage });
        void this.wake();
        return;
      }

      await this.applyStageFailure(
        taskId,
        runMeta.stage,
        runMeta,
        { kind: "runtime_error", message: detail },
        guard,
      );
      return;
    }

    this.recentSpaceCompletedAtMs.set(card.space, Date.now());
    const sessionKey = this.sessionKeyByRunId.get(runMeta.run_id);
    const reuseCount = this.reuseCountByRunId.get(runMeta.run_id) ?? 0;
    const lastContextPercent =
      this.latestContextPercentByRunId.get(runMeta.run_id) ?? null;
    this.sessionKeyByRunId.delete(runMeta.run_id);
    this.reuseCountByRunId.delete(runMeta.run_id);
    this.latestContextPercentByRunId.delete(runMeta.run_id);

    if (
      runMeta.stage === "implement" &&
      runMeta.role === "worker" &&
      exitEvent?.reason === "completed" &&
      sessionKey !== undefined
    ) {
      const latestRunMeta =
        readYamlOptional(
          this.store.paths.runYaml(taskId, runDirName),
          RunMetaSchema,
        ) ?? runMeta;
      const backend = this.backendRegistry.get(latestRunMeta.backend_id);
      const caps =
        this.agentCapabilitiesMap.get(latestRunMeta.agent) ??
        (backend
          ? await backend.capabilities(latestRunMeta.agent).catch(() => undefined)
          : undefined);
      const cwd =
        latestRunMeta.cwd ??
        (card.workspace_mode === "git_worktree"
          ? this.getGitWorktreeDir(taskId)
          : this.store.paths.workspaceDir(taskId));
      if (
        backend &&
        caps?.warmSessionReuse === true &&
        reuseCount < WARM_MAX_CONSECUTIVE_REUSES &&
        (lastContextPercent === null ||
          lastContextPercent < WARM_CONTEXT_PERCENT_LIMIT)
      ) {
        this.warmPool.park(
          {
            taskId,
            sessionRef: latestRunMeta.session_ref,
            sessionKey,
            backend,
            backendId: latestRunMeta.backend_id,
            agent: latestRunMeta.agent,
            model: latestRunMeta.model,
            cwd,
            rosterRoleId: latestRunMeta.roster_role,
            contractVersion: latestRunMeta.contract_version,
            lastRunId: latestRunMeta.run_id,
            reuseCount,
            lastContextPercent,
            lastUsedAtMs: Date.now(),
          },
          this.getWarmCacheTtlMs(),
        );
      }
    }

    if (exitEvent?.reason === "cancelled") {
      await this.applyStageFailure(
        taskId,
        runMeta.stage,
        runMeta,
        {
          kind: "runtime_error",
          message: exitEvent.detail ?? "run_cancelled_unexpectedly",
        },
        guard,
      );
      return;
    }

    switch (runMeta.stage) {
      case "plan":
        await this.finalizePlanRun(taskId, runDirName, runMeta);
        break;
      case "research":
        await this.finalizeResearchRun(taskId, runDirName, runMeta);
        break;
      case "implement":
        await this.finalizeWorkerRun(taskId, runDirName, runMeta, exitEvent, signal);
        break;
      case "verify":
        await this.finalizeVerifyAgentRun(taskId, runDirName, runMeta, exitEvent, signal);
        break;
      case "review":
        await this.finalizeReviewerRun(taskId, runDirName, runMeta, exitEvent);
        break;
      case "accept":
        await this.finalizeVerifierRun(taskId, runDirName, runMeta);
        break;
      case "triage":
        await this.finalizeTriageRun(taskId, runDirName, runMeta);
        break;
      case "advise":
        await this.finalizeAdvisorRun(taskId, runDirName, runMeta);
        break;
      case "deliver":
        await this.finalizeDeliverAgentRun(taskId, runDirName, runMeta);
        break;
      default:
        break;
    }
  }

  private ensureLeaseCommittedForDiskReceipt(
    taskId: string,
    runMeta: RunMeta,
  ): boolean {
    const lease = this.store.getStageLease(taskId);
    if (!lease || lease.run_id !== runMeta.run_id) {
      return false;
    }
    if (lease.state === "completed") {
      return true;
    }
    if (lease.state === "active") {
      const { committed } = this.store.sqlite.completeStageLease(
        taskId,
        runMeta.run_id,
        runMeta.contract_version,
        new Date().toISOString(),
      );
      return committed;
    }
    return false;
  }

  private readReceiptAndCommitLease(
    taskId: string,
    runDirName: string,
    runMeta: RunMeta,
  ): { ok: true; rawReceipt: string } | { ok: false; reason: "missing" | "lease_expired" } {
    const receiptPath = this.store.paths.receiptMd(taskId, runDirName);
    const rawReceipt = readOptionalText(receiptPath);
    if (rawReceipt === null) {
      return { ok: false, reason: "missing" };
    }

    const leaseValid = this.ensureLeaseCommittedForDiskReceipt(taskId, runMeta);
    if (!leaseValid) {
      const historyDir = this.store.paths.runHistoryDir(taskId, runDirName);
      ensureDir(historyDir);
      const archived = path.join(historyDir, `${runMeta.run_id}-stale-${Date.now()}.md`);
      fs.renameSync(receiptPath, archived);
      return { ok: false, reason: "lease_expired" };
    }

    return { ok: true, rawReceipt };
  }

  private writeAdvisorRequest(taskId: string, request: AdvisorRequest): void {
    const parsed = AdvisorRequestSchema.parse(request);
    writeYamlAtomic(
      this.store.paths.advisorRequestYaml(taskId),
      parsed,
      AdvisorRequestSchema,
    );
  }

  private readAdvisorRequest(
    taskId: string,
    expectedContractVersion: number,
  ): AdvisorRequest | null {
    const parsed = readYamlOptional(
      this.store.paths.advisorRequestYaml(taskId),
      AdvisorRequestSchema,
    );
    if (!parsed || parsed.contract_version !== expectedContractVersion) {
      return null;
    }
    return parsed;
  }

  private clearAdvisorRequest(taskId: string): void {
    fs.rmSync(this.store.paths.advisorRequestYaml(taskId), { force: true });
  }

  private async computeWorktreeDirtySignature(worktreePath: string): Promise<string> {
    return await computeWorktreeDirtySignature(worktreePath);
  }

  private async detectAdvisorWorkspaceMutation(
    card: TaskCard,
    runId: string,
  ): Promise<boolean> {
    const preSig = this.advisorPreRunDirtySignatures.get(runId);
    this.advisorPreRunDirtySignatures.delete(runId);
    if (preSig === undefined || card.workspace_mode !== "git_worktree") {
      return false;
    }
    const postSig = await this.computeWorktreeDirtySignature(
      this.getGitWorktreeDir(card.id),
    );
    return postSig !== preSig;
  }

  private listCurrentWindowRuns(
    taskId: string,
    card: TaskCard,
  ): Array<ScannedRunDir & { meta: RunMeta }> {
    const events = this.store.readStateEvents(taskId);
    let lastResetIso = card.created_at;
    for (const ev of events) {
      if (
        ev.type === "contract_updated" ||
        (ev.type === "decided" && ev.action === "resume")
      ) {
        if (ev.at > lastResetIso) {
          lastResetIso = ev.at;
        }
      }
    }

    return this.listTaskRunDirs(taskId).filter(
      (r): r is ScannedRunDir & { meta: RunMeta } =>
        r.meta !== null &&
        !r.rateLimited &&
        r.meta.contract_version === card.contract_version &&
        r.meta.started_at >= lastResetIso,
    );
  }

  private isAdvisorConfigured(): boolean {
    const roster = this.store.readConfig("roster");
    if (roster !== null) {
      return deriveLegacyRolesConfigFromRoster(roster).roles.advisor !== undefined;
    }
    return this.store.readConfig("roles")?.roles.advisor !== undefined;
  }

  private canInvokeAdvisorForTask(
    taskId: string,
    card: TaskCard,
    currentStage: StageId,
    currentRunId: string,
  ): boolean {
    if (!this.isAdvisorConfigured()) {
      return false;
    }
    const { counters } = this.computeStageCounters(
      taskId,
      card,
      currentStage,
      currentRunId,
    );
    return (
      counters.advisorCalls < card.limits.advisor_calls &&
      counters.totalTokens < card.limits.max_tokens &&
      (card.limits.max_cost_usd === undefined ||
        (counters.totalCostUsd ?? 0) < card.limits.max_cost_usd)
    );
  }

  private computeConsecutiveSameGateFailureCount(
    taskId: string,
    card: TaskCard,
    currentRunId: string,
    currentReport: GateReport,
  ): number {
    const currentFp = computeGateFailureFingerprint(currentReport);
    if (!currentFp) {
      return 0;
    }
    const runs = this.listCurrentWindowRuns(taskId, card);
    const currentIdx = runs.findIndex((r) => r.meta.run_id === currentRunId);
    const slice = currentIdx >= 0 ? runs.slice(0, currentIdx + 1) : runs;

    let count = 0;
    for (let i = slice.length - 1; i >= 0; i--) {
      const r = slice[i]!;
      if (r.meta.run_id === currentRunId) {
        count += 1;
        continue;
      }
      if (r.meta.stage === "advise" || r.meta.stage === "triage") {
        break;
      }
      if (r.meta.stage === "implement") {
        const prevGate = readYamlOptional(
          this.store.paths.gateYaml(taskId, r.dirName),
          GateReportSchema,
        );
        const prevFp = prevGate ? computeGateFailureFingerprint(prevGate) : null;
        if (prevFp === currentFp) {
          count += 1;
          continue;
        }
        break;
      }
      break;
    }
    return count;
  }

  private computeConsecutiveSameReviewerFailureCount(
    taskId: string,
    card: TaskCard,
    currentRunId: string,
    currentFrontmatter: Parameters<typeof computeReviewerFailureFingerprint>[0],
    currentBody: string,
  ): number {
    const currentFp = computeReviewerFailureFingerprint(currentFrontmatter, currentBody);
    if (!currentFp) {
      return 0;
    }
    const runs = this.listCurrentWindowRuns(taskId, card);
    const currentIdx = runs.findIndex((r) => r.meta.run_id === currentRunId);
    const slice = currentIdx >= 0 ? runs.slice(0, currentIdx + 1) : runs;

    let count = 0;
    for (let i = slice.length - 1; i >= 0; i--) {
      const r = slice[i]!;
      if (r.meta.run_id === currentRunId) {
        count += 1;
        continue;
      }
      if (r.meta.stage === "advise" || r.meta.stage === "triage") {
        break;
      }
      if (r.meta.stage === "implement") {
        continue;
      }
      if (r.meta.stage === "review") {
        const raw = readOptionalText(this.store.paths.receiptMd(taskId, r.dirName));
        if (!raw) {
          break;
        }
        const parsed = parseAndValidateReceipt("reviewer", raw);
        if (!parsed.ok) {
          break;
        }
        const prevFp = computeReviewerFailureFingerprint(
          parsed.frontmatter,
          parsed.body,
        );
        if (prevFp === currentFp) {
          count += 1;
          continue;
        }
        break;
      }
      break;
    }
    return count;
  }

  tryRouteTechnicalDecisionToAdvisor(
    input: TechnicalDecisionAdvisorRouteInput,
  ): TechnicalDecisionAdvisorRouteResult {
    if (this.stopped) {
      return { routedToAdvisor: false };
    }
    if (
      (input.role !== "worker" && input.role !== "reviewer") ||
      !isAdvisorEligibleDecisionCategory(input.category)
    ) {
      return { routedToAdvisor: false };
    }
    const card = readYamlOptional(
      this.store.paths.cardYaml(input.taskId),
      TaskCardSchema,
    );
    if (!card || card.contract_version !== input.contractVersion) {
      return { routedToAdvisor: false };
    }
    if (!this.canInvokeAdvisorForTask(input.taskId, card, input.stage, input.runId)) {
      return { routedToAdvisor: false };
    }

    assertCanInvokeAdvisor("kernel");
    const now = new Date().toISOString();
    this.writeAdvisorRequest(input.taskId, {
      schema_version: 1,
      contract_version: card.contract_version,
      trigger: input.stage === "review" ? "review_deadlock" : "technical_ambiguity",
      source_stage: input.stage,
      source_run_id: input.runId,
      source_role: input.role,
      category: input.category,
      reason: input.reason,
      question: input.question,
      options: input.options,
      created_at: now,
    });

    this.abortingBeforeDispatch.add(input.taskId);
    const activeHandle = this.activeRuns.get(input.taskId);
    if (activeHandle) {
      activeHandle.cancelledByControl = true;
      activeHandle.abortController.abort();
    }

    try {
      const nextState = this.store.appendStateEvent(input.taskId, {
        type: "resumed",
        at: now,
        stage: "advise",
      });
      this.syncCaffeinate();
      this.publishTaskUpdated(input.taskId, {
        status: nextState.status,
        ...(nextState.stage !== null ? { stage: nextState.stage } : {}),
        contractVersion: nextState.contractVersion,
      });

      void (async () => {
        try {
          await this.abortActiveRun(input.taskId).catch(() => {});
        } finally {
          this.abortingBeforeDispatch.delete(input.taskId);
        }
        await this.wake().catch(() => {});
      })();

      return { routedToAdvisor: true, state: nextState };
    } catch (err) {
      this.abortingBeforeDispatch.delete(input.taskId);
      throw err;
    }
  }

  private computeStageCounters(
    taskId: string,
    card: TaskCard,
    currentStage: StageId,
    currentRunId: string,
  ): { counters: StageCounters; triageAttempted: boolean } {
    const runs = this.listCurrentWindowRuns(taskId, card);

    let advisorCalls = 0;
    let reviewRounds = 0;
    for (const r of runs) {
      if (r.meta.stage === "advise") {
        advisorCalls += 1;
      }
      if (
        r.meta.stage === "review" &&
        r.meta.run_id !== currentRunId &&
        r.hasReceipt
      ) {
        reviewRounds += 1;
      }
    }

    const currentIdx = runs.findIndex((r) => r.meta.run_id === currentRunId);
    const slice = currentIdx >= 0 ? runs.slice(0, currentIdx + 1) : runs;

    let sameStageStreak = 0;
    for (let i = slice.length - 1; i >= 0; i--) {
      if (slice[i]!.meta.stage === currentStage) {
        sameStageStreak += 1;
      } else {
        break;
      }
    }
    const stageRetries = Math.max(0, sameStageStreak - 1);

    let triageAttempted = false;
    for (let i = slice.length - 1; i >= 0; i--) {
      const s = slice[i]!.meta.stage;
      if (s === "triage") {
        triageAttempted = true;
        break;
      }
      if (s !== currentStage && s !== "advise") {
        break;
      }
    }

    const totalTokens = this.store.getTaskTotalTokens(taskId).total_tokens;
    const totalCostUsd = computeTaskSpentUsd(this.store, taskId);
    return {
      counters: {
        stageRetries,
        reviewRounds,
        advisorCalls,
        totalTokens,
        totalCostUsd,
      },
      triageAttempted,
    };
  }

  private async advanceToNextStage(
    taskId: string,
    nextStage: StageId,
    expected?: ExpectedRunGuard,
    nextStepIndex?: number | null,
  ): Promise<boolean> {
    if (
      this.stopped ||
      (expected !== undefined &&
        !this.isRunStillCurrent(taskId, expected.runId, expected.contractVersion))
    ) {
      this.syncCaffeinate();
      return false;
    }

    if (nextStage === "deliver") {
      this.warmPool.evictTask(taskId);
    }
    const now = new Date().toISOString();
    const nextState = this.store.appendStateEvent(taskId, {
      type: "resumed",
      at: now,
      stage: nextStage,
      ...(nextStepIndex !== undefined && nextStepIndex !== null
        ? { step_index: nextStepIndex }
        : {}),
    });
    this.syncCaffeinate();
    this.publishTaskUpdated(taskId, {
      status: nextState.status,
      stage: nextStage,
      contractVersion: nextState.contractVersion,
    });
    // Use void wake() so callers on KilnScheduler.onDispatch (e.g. handleBackendStartError,
    // dispatchVerifyStage) never deadlock awaiting the currently executing scheduler tick.
    void this.wake();
    return true;
  }

  private async applyStageFailure(
    taskId: string,
    stage: StageId,
    runMeta: RunMeta,
    failure:
      | { kind: "runtime_error"; message: string }
      | { kind: "schema_invalid"; errors: readonly string[] },
    expected?: ExpectedRunGuard,
  ): Promise<void> {
    const guard: ExpectedRunGuard = expected ?? {
      runId: runMeta.run_id,
      contractVersion: runMeta.contract_version,
    };
    if (!this.isRunStillCurrent(taskId, guard.runId, guard.contractVersion)) {
      this.syncCaffeinate();
      return;
    }

    const card = this.store.readTaskCard(taskId);
    const { counters, triageAttempted } = this.computeStageCounters(
      taskId,
      card,
      stage,
      runMeta.run_id,
    );
    const decision = handleExecutionFailure({
      stage,
      failure,
      counters,
      limits: card.limits,
      triageAttempted,
    });

    if (decision.action === "retry_stage") {
      await this.advanceToNextStage(
        taskId,
        stage,
        guard,
        runMeta.step_index ?? null,
      );
      return;
    }

    if (decision.action === "invoke_triage") {
      const roles = this.store.readConfig("roles");
      if (roles?.roles.triage) {
        await this.advanceToNextStage(taskId, "triage", guard);
        return;
      }
    }

    const pending = PendingDecisionSchema.parse({
      id: `dec-${randomUUID().slice(0, 8)}`,
      task_id: taskId,
      run_id: runMeta.run_id,
      contract_version: card.contract_version,
      reason: decision.reason,
      category: "stage_failure_escalation",
      question: `任务 "${card.title}" 在阶段 ${stage} 触发异常升级 (${decision.reason})，请选择后续处理方式。`,
      options: [
        {
          id: "opt-retry-stage",
          label: `重试 ${stage} 阶段`,
          action: "resume",
          target_stage: stage,
          recommended: true,
        },
        {
          id: "opt-cancel",
          label: "取消任务",
          action: "cancel",
          recommended: false,
        },
      ],
      created_at: new Date().toISOString(),
    });
    this.transitionTaskToWaiting(taskId, pending, guard);
  }

  private async finalizeVerifyAgentRun(
    taskId: string,
    runDirName: string,
    runMeta: RunMeta,
    exitEvent: Extract<RunEvent, { kind: "exit" }> | null,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.finalizeWorkerRun(taskId, runDirName, runMeta, exitEvent, signal);
  }

  private async finalizeWorkerRun(
    taskId: string,
    runDirName: string,
    runMeta: RunMeta,
    _exitEvent: Extract<RunEvent, { kind: "exit" }> | null,
    signal?: AbortSignal,
    activeRunIdOverride?: string,
  ): Promise<void> {
    const effectiveStage: "implement" | "verify" =
      runMeta.stage === "verify" ? "verify" : "implement";
    const activeRunId = activeRunIdOverride ?? runMeta.run_id;
    const guard: ExpectedRunGuard = {
      runId: activeRunId,
      contractVersion: runMeta.contract_version,
    };

    if (
      signal?.aborted ||
      !this.isRunStillCurrent(taskId, activeRunId, runMeta.contract_version)
    ) {
      this.syncCaffeinate();
      return;
    }

    const receiptLoad = this.readReceiptAndCommitLease(taskId, runDirName, runMeta);
    if (!receiptLoad.ok) {
      if (receiptLoad.reason === "lease_expired") {
        this.syncCaffeinate();
        return;
      }
      await this.applyStageFailure(
        taskId,
        effectiveStage,
        runMeta,
        {
          kind: "schema_invalid",
          errors: ["Missing RECEIPT.md"],
        },
        guard,
      );
      return;
    }

    const card = this.store.readTaskCard(taskId);
    const parsedReceipt = parseAndValidateReceipt("worker", receiptLoad.rawReceipt);

    // Handle Pi / non-MCP or MCP worker requesting a human decision via RECEIPT.md
    if (parsedReceipt.ok && parsedReceipt.frontmatter.outcome === "need_decision") {
      if (
        parsedReceipt.frontmatter.run_id !== runMeta.run_id ||
        parsedReceipt.frontmatter.contract_version !== card.contract_version
      ) {
        await this.applyStageFailure(
          taskId,
          effectiveStage,
          runMeta,
          {
            kind: "schema_invalid",
            errors: [
              `Receipt run_id/contract_version mismatch (${parsedReceipt.frontmatter.run_id}, v${parsedReceipt.frontmatter.contract_version})`,
            ],
          },
          guard,
        );
        return;
      }

      const pending = extractDecisionFromNeedDecisionReceipt(
        receiptLoad.rawReceipt,
        taskId,
        runMeta.run_id,
        card.contract_version,
        parsedReceipt.body,
      );
      if (
        isAdvisorEligibleDecisionCategory(pending.category) &&
        this.canInvokeAdvisorForTask(taskId, card, effectiveStage, runMeta.run_id)
      ) {
        assertCanInvokeAdvisor("kernel");
        this.writeAdvisorRequest(taskId, {
          schema_version: 1,
          contract_version: card.contract_version,
          trigger: "technical_ambiguity",
          source_stage: effectiveStage,
          source_run_id: runMeta.run_id,
          source_role: "worker",
          category: pending.category,
          reason: pending.reason,
          question: pending.question,
          options: pending.options,
          created_at: new Date().toISOString(),
        });
        await this.advanceToNextStage(taskId, "advise", guard);
        return;
      }
      this.transitionTaskToWaiting(taskId, pending, guard);
      return;
    }

    // For host_scoped tasks, always validate & refresh Phase-1 staging and host_path_locks
    // before verification gate so rework/contract-update rounds cannot bypass with stale manifests.
    let explicitHostChangedPaths: string[] | undefined;
    if (card.workspace_mode === "host_scoped" && parsedReceipt.ok) {
      const manifestPath = this.store.paths.backupManifest(taskId);
      const existingManifest = fs.existsSync(manifestPath)
        ? readHostBackupManifest(this.store, taskId)
        : null;
      const clearAwaitingStaging = (): void => {
        if (existingManifest?.status === "staged_awaiting_approval") {
          this.store.releaseHostPathLocks(taskId);
          fs.rmSync(manifestPath, { force: true });
          fs.rmSync(path.join(this.store.paths.backupDir(taskId), "files"), {
            recursive: true,
            force: true,
          });
        }
      };

      const stagedFiles = collectRelativeFiles(this.store.paths.stagedDir(taskId));
      if (stagedFiles.length === 0) {
        clearAwaitingStaging();
      } else {
        const { specs, unmappedPaths } = resolveStagedHostMapping(
          stagedFiles,
          parsedReceipt.frontmatter.changed_paths,
          card.contract.scope,
        );

        const outOfScopeTargets: string[] = [...unmappedPaths];
        const canonicalCount = new Map<string, number>();
        const resolvedEntries: Array<{
          spec: StagedHostFileSpec;
          canonical: string;
        }> = [];
        for (const spec of specs) {
          try {
            const canonical = resolveCanonicalHostTarget(spec.targetPath);
            if (!isHostTargetWithinScope(canonical, card.contract.scope)) {
              outOfScopeTargets.push(canonical);
              continue;
            }
            canonicalCount.set(canonical, (canonicalCount.get(canonical) ?? 0) + 1);
            resolvedEntries.push({ spec, canonical });
          } catch {
            outOfScopeTargets.push(spec.targetPath);
          }
        }

        const uniqueSpecs: StagedHostFileSpec[] = [];
        for (const entry of resolvedEntries) {
          if ((canonicalCount.get(entry.canonical) ?? 0) > 1) {
            outOfScopeTargets.push(entry.spec.stagedRelativePath);
          } else {
            uniqueSpecs.push(entry.spec);
          }
        }

        if (outOfScopeTargets.length > 0) {
          clearAwaitingStaging();
          explicitHostChangedPaths = outOfScopeTargets;
        } else if (uniqueSpecs.length > 0) {
          clearAwaitingStaging();
          const stageRes = stageHostScopedChanges(this.store, {
            taskId,
            contractScope: card.contract.scope,
            stagedFiles: uniqueSpecs,
          });
          if (!stageRes.ok) {
            if (!this.isRunStillCurrent(taskId, activeRunId, card.contract_version)) {
              this.syncCaffeinate();
              return;
            }
            // Lock conflict with another task: re-queue without counting as failure.
            this.store.appendStateEvent(taskId, {
              type: "queued",
              at: new Date().toISOString(),
            });
            this.syncCaffeinate();
            this.publishTaskUpdated(taskId, { status: "queued", stage: "implement" });
            void this.wake();
            return;
          }
        }
      }
    }

    const worktreePath =
      card.workspace_mode === "git_worktree" ? this.getGitWorktreeDir(taskId) : undefined;
    const baselineSnapshot = this.readSavedFrozenBaseline(taskId, card);

    // Multi-specialist consecutive implement steps: validate receipt, scope & frozen baseline,
    // commit intermediate changes, and hand off directly to the next implement specialist before
    // running full accept_cmd verification at the end of the implement sequence.
    const preNextStep =
      effectiveStage === "implement"
        ? nextWorkflowStepAfter(card, runMeta.step_index ?? null, "implement", card.track)
        : null;
    if (
      effectiveStage === "implement" &&
      preNextStep !== null &&
      preNextStep.node.kind === "agent" &&
      preNextStep.stage === "implement" &&
      card.workspace_mode !== "host_scoped" &&
      parsedReceipt.ok &&
      parsedReceipt.frontmatter.run_id === runMeta.run_id &&
      parsedReceipt.frontmatter.contract_version === card.contract_version
    ) {
      if (worktreePath && fs.existsSync(worktreePath)) {
        const statusRaw = await runGitCommand([
          "-C",
          worktreePath,
          "status",
          "--porcelain=v1",
          "-z",
          "-uall",
        ]);
        const dirtyPaths = statusRaw.length > 0 ? parseGitPorcelainStatusZ(statusRaw).dirtyPaths : [];
        const scopeCheck = checkScope(dirtyPaths, card.contract.scope);
        if (!scopeCheck.ok) {
          await this.applyStageFailure(
            taskId,
            "implement",
            runMeta,
            {
              kind: "runtime_error",
              message: `gate_scope_violation: ${scopeCheck.outOfScopePaths.join(", ")}`,
            },
            guard,
          );
          return;
        }
          let frozenChanged: string[] = [];
          if (baselineSnapshot && baselineSnapshot.files.length > 0) {
            const space = this.store.readSpace(card.space);
            const currentFrozen = computeFrozenSnapshot(
              worktreePath,
              space?.freeze_patterns ?? [],
              card.contract.accept_cmd,
            );
            const baselineMap = new Map(baselineSnapshot.files.map((f) => [f.path, f]));
            frozenChanged = currentFrozen.files
              .filter((f) => {
                const prev = baselineMap.get(f.path);
                return prev && (prev.exists !== f.exists || prev.sha256 !== f.sha256);
              })
              .map((f) => f.path);
          }
          if (
            (frozenChanged.length > 0 || parsedReceipt.frontmatter.complexity_escalate) &&
            card.track === "L1"
          ) {
            const escalatedState = this.stateMachine.escalateTrackToL2(
              taskId,
              frozenChanged.length > 0 ? "frozen_files_changed" : "complexity_escalate",
            );
            this.publishTaskUpdated(taskId, {
              contractVersion: escalatedState.contractVersion,
            });
          }
          const latestCardForIntermediate = this.store.readTaskCard(taskId);
          await this.commitVerifiedWorktreeChanges(
            latestCardForIntermediate,
            worktreePath,
            runMeta.round,
          );
          await createGitWorktreeCheckpoint({
            worktreePath,
            taskId,
            runId: runMeta.run_id,
            phase: "post",
            stage: "implement",
            round: runMeta.round,
          }).catch(() => {});
      } else if (
        parsedReceipt.frontmatter.complexity_escalate &&
        card.track === "L1"
      ) {
        const escalatedState = this.stateMachine.escalateTrackToL2(
          taskId,
          "complexity_escalate",
        );
        this.publishTaskUpdated(taskId, {
          contractVersion: escalatedState.contractVersion,
        });
      }

      await this.advanceToNextStage(
        taskId,
        preNextStep.stage,
        guard,
        preNextStep.stepIndex,
      );
      return;
    }

    const scratchExpectedArtifacts =
      card.workspace_mode === "scratch_dir"
        ? this.resolveScratchExpectedArtifacts(
            taskId,
            card,
            parsedReceipt.ok ? parsedReceipt.frontmatter.changed_paths : [],
          )
        : undefined;

    const gateResult = await runVerificationGate(this.store, {
      taskId,
      runDirName,
      gateCheckMode: getVerifyGateCheckMode(card),
      ...(worktreePath !== undefined ? { worktreePath } : {}),
      ...(runMeta.input_ref !== undefined ? { inputRef: runMeta.input_ref } : {}),
      ...(baselineSnapshot !== undefined ? { baselineSnapshot } : {}),
      ...(explicitHostChangedPaths !== undefined
        ? { hostChangedPaths: explicitHostChangedPaths }
        : {}),
      ...(scratchExpectedArtifacts !== undefined
        ? { expectedArtifacts: scratchExpectedArtifacts }
        : {}),
      ...(signal !== undefined ? { signal } : {}),
    });

    if (
      signal?.aborted ||
      !this.isRunStillCurrent(taskId, activeRunId, card.contract_version)
    ) {
      this.syncCaffeinate();
      return;
    }

    const { counters, triageAttempted } = this.computeStageCounters(
      taskId,
      card,
      effectiveStage,
      runMeta.run_id,
    );
    const advisorAvailable = this.isAdvisorConfigured();
    const consecutiveSameFailureCount = this.computeConsecutiveSameGateFailureCount(
      taskId,
      card,
      runMeta.run_id,
      gateResult.report,
    );

    const stageDecision = evaluateWorkerStageOutcome(
      card,
      parsedReceipt,
      gateResult.report,
      counters,
      {
        currentStage: effectiveStage,
        triageAttempted,
        consecutiveSameFailureCount,
        advisorAvailable,
      },
    );

    if (stageDecision.escalateToL2 && card.track === "L1") {
      const escalatedState = this.stateMachine.escalateTrackToL2(
        taskId,
        stageDecision.escalateReason ?? "frozen_files_changed",
      );
      this.publishTaskUpdated(taskId, {
        contractVersion: escalatedState.contractVersion,
      });
    }

    const latestCard = this.store.readTaskCard(taskId);

    if (
      gateResult.passed &&
      gateResult.report.scope_ok &&
      latestCard.workspace_mode === "git_worktree" &&
      worktreePath &&
      fs.existsSync(worktreePath)
    ) {
      await this.commitVerifiedWorktreeChanges(
        latestCard,
        worktreePath,
        runMeta.round,
      );
      if (
        signal?.aborted ||
        !this.isRunStillCurrent(taskId, activeRunId, latestCard.contract_version)
      ) {
        this.syncCaffeinate();
        return;
      }
    }

    if (
      latestCard.workspace_mode === "git_worktree" &&
      worktreePath &&
      fs.existsSync(worktreePath)
    ) {
      await createGitWorktreeCheckpoint({
        worktreePath,
        taskId,
        runId: runMeta.run_id,
        phase: "post",
        stage: effectiveStage,
        round: runMeta.round,
      }).catch(() => {});
    }

    if (stageDecision.action === "advance_stage") {
      const postNext = nextWorkflowStepAfter(
        latestCard,
        runMeta.step_index ?? null,
        effectiveStage,
        stageDecision.effectiveTrack,
      );
      if (effectiveStage === "implement" && postNext?.stage === "verify") {
        if (
          this.isTesterAgentModeEnabled() &&
          latestCard.workspace_mode !== "host_scoped" &&
          !this.hasCompletedAgentRunInTail(taskId, latestCard, "verify", "implement")
        ) {
          await this.advanceToNextStage(taskId, "verify", guard, postNext.stepIndex);
          return;
        }
        const afterVerify = nextWorkflowStepAfter(
          latestCard,
          postNext.stepIndex,
          "verify",
          stageDecision.effectiveTrack,
        );
        await this.advanceToNextStage(
          taskId,
          afterVerify?.stage ?? "deliver",
          guard,
          afterVerify?.stepIndex ?? null,
        );
        return;
      }
      if (postNext !== null) {
        await this.advanceToNextStage(taskId, postNext.stage, guard, postNext.stepIndex);
        return;
      }
      await this.advanceToNextStage(taskId, stageDecision.nextStage ?? "deliver", guard);
      return;
    }

    const pipelineStages = getTaskPipelineStages(latestCard, latestCard.track);
    const hasReviewInPipeline = pipelineStages.includes("review");

    // L1 frozen-file tampering that also tripped scope_ok=false: escalate directly to review
    // or request human scope confirmation rather than silently looping in implement.
    if (
      gateResult.report.escalated_to_l2 &&
      !gateResult.report.scope_ok &&
      latestCard.track === "L2"
    ) {
      const roles = this.store.readConfig("roles");
      if (roles?.roles.reviewer) {
        await this.advanceToNextStage(taskId, "review", guard);
        return;
      }
    }

    if (stageDecision.action === "invoke_advisor") {
      assertCanInvokeAdvisor("kernel");
      const failureFp =
        computeGateFailureFingerprint(gateResult.report) ?? stageDecision.reason;
      this.writeAdvisorRequest(taskId, {
        schema_version: 1,
        contract_version: latestCard.contract_version,
        trigger: "stuck_same_failure",
        source_stage: effectiveStage,
        source_run_id: runMeta.run_id,
        source_role: "worker",
        category: "stuck_loop",
        reason: stageDecision.reason,
        question: `任务 "${latestCard.title}" 连续 ${consecutiveSameFailureCount} 次在同一门禁失败点停滞（${stageDecision.reason}），请在不更改目标与 scope 的前提下给出突破方案。`,
        options: [],
        failure_fingerprint: failureFp,
        consecutive_failures: consecutiveSameFailureCount,
        created_at: new Date().toISOString(),
      });
      await this.advanceToNextStage(taskId, "advise", guard);
      return;
    }

    if (stageDecision.action === "retry_stage") {
      await this.advanceToNextStage(
        taskId,
        stageDecision.stage,
        guard,
        runMeta.step_index ?? null,
      );
      return;
    }

    if (stageDecision.action === "invoke_triage") {
      const roles = this.store.readConfig("roles");
      if (roles?.roles.triage) {
        await this.advanceToNextStage(taskId, "triage", guard);
        return;
      }
    }

    const pending = PendingDecisionSchema.parse({
      id: `dec-${randomUUID().slice(0, 8)}`,
      task_id: taskId,
      run_id: runMeta.run_id,
      contract_version: latestCard.contract_version,
      reason: stageDecision.reason,
      category: stageDecision.escalateToL2
        ? "frozen_test_escalation"
        : "gate_failure_escalation",
      question: `任务 "${latestCard.title}" 门禁或实施异常 (${stageDecision.reason})，请选择后续处理方式。`,
      options: [
        {
          id: "opt-retry-implement",
          label: "退回实施阶段修复",
          action: "resume",
          target_stage: "implement",
          recommended: true,
        },
        ...(hasReviewInPipeline
          ? [
              {
                id: "opt-send-review",
                label: "转入独立审查",
                action: "resume" as const,
                target_stage: "review" as const,
                recommended: false,
              },
            ]
          : []),
        {
          id: "opt-cancel",
          label: "取消任务",
          action: "cancel",
          recommended: false,
        },
      ],
      created_at: new Date().toISOString(),
    });
    this.transitionTaskToWaiting(taskId, pending, guard);
  }

  private async commitVerifiedWorktreeChanges(
    card: TaskCard,
    worktreePath: string,
    round: number,
  ): Promise<void> {
    await commitVerifiedWorktreeChanges(card, worktreePath, round);
  }

  private async finalizeReviewerRun(
    taskId: string,
    runDirName: string,
    runMeta: RunMeta,
    _exitEvent: Extract<RunEvent, { kind: "exit" }> | null,
  ): Promise<void> {
    const guard: ExpectedRunGuard = {
      runId: runMeta.run_id,
      contractVersion: runMeta.contract_version,
    };
    if (!this.isRunStillCurrent(taskId, runMeta.run_id, runMeta.contract_version)) {
      this.advisorPreRunDirtySignatures.delete(runMeta.run_id);
      this.syncCaffeinate();
      return;
    }

    const receiptLoad = this.readReceiptAndCommitLease(taskId, runDirName, runMeta);
    if (!receiptLoad.ok) {
      this.advisorPreRunDirtySignatures.delete(runMeta.run_id);
      if (receiptLoad.reason === "lease_expired") {
        this.syncCaffeinate();
        return;
      }
      await this.applyStageFailure(
        taskId,
        "review",
        runMeta,
        {
          kind: "schema_invalid",
          errors: ["Missing reviewer RECEIPT.md"],
        },
        guard,
      );
      return;
    }

    const card = this.store.readTaskCard(taskId);
    const workspaceMutated = await this.detectAdvisorWorkspaceMutation(
      card,
      runMeta.run_id,
    );
    if (workspaceMutated) {
      await this.applyStageFailure(
        taskId,
        "review",
        runMeta,
        {
          kind: "runtime_error",
          message:
            "read_only_workspace_mutation: reviewer altered git worktree files in violation of read-only permission",
        },
        guard,
      );
      return;
    }
    const parsedReceipt = parseAndValidateReceipt("reviewer", receiptLoad.rawReceipt);
    if (
      parsedReceipt.ok &&
      (parsedReceipt.frontmatter.run_id !== runMeta.run_id ||
        parsedReceipt.frontmatter.contract_version !== card.contract_version)
    ) {
      await this.applyStageFailure(
        taskId,
        "review",
        runMeta,
        {
          kind: "schema_invalid",
          errors: ["Reviewer receipt run_id or contract_version mismatch"],
        },
        guard,
      );
      return;
    }

    const { counters, triageAttempted } = this.computeStageCounters(
      taskId,
      card,
      "review",
      runMeta.run_id,
    );
    const advisorAvailable = this.isAdvisorConfigured();
    const consecutiveSameFailureCount =
      parsedReceipt.ok &&
      parsedReceipt.frontmatter.run_id === runMeta.run_id &&
      parsedReceipt.frontmatter.contract_version === card.contract_version
        ? this.computeConsecutiveSameReviewerFailureCount(
            taskId,
            card,
            runMeta.run_id,
            parsedReceipt.frontmatter,
            parsedReceipt.body,
          )
        : 0;

    const reviewDecision = evaluateReviewerStageOutcome(card, parsedReceipt, counters, {
      triageAttempted,
      consecutiveSameFailureCount,
      advisorAvailable,
    });

    if (reviewDecision.action === "advance_stage") {
      const nextStep = nextWorkflowStepAfter(
        card,
        runMeta.step_index ?? null,
        "review",
        card.track,
      );
      await this.advanceToNextStage(
        taskId,
        nextStep?.stage ?? reviewDecision.nextStage ?? "deliver",
        guard,
        nextStep?.stepIndex ?? null,
      );
      return;
    }

    if (reviewDecision.action === "rework_implement") {
      const restartStepIndex = findLoopRestartStepIndex(
        card,
        reviewDecision.targetStage,
        card.track,
      );
      await this.advanceToNextStage(
        taskId,
        reviewDecision.targetStage,
        guard,
        restartStepIndex,
      );
      return;
    }

    if (reviewDecision.action === "retry_stage") {
      await this.advanceToNextStage(
        taskId,
        "review",
        guard,
        runMeta.step_index ?? null,
      );
      return;
    }

    if (reviewDecision.action === "invoke_advisor") {
      assertCanInvokeAdvisor("kernel");
      const failureFp = parsedReceipt.ok
        ? (computeReviewerFailureFingerprint(
            parsedReceipt.frontmatter,
            parsedReceipt.body,
          ) ?? reviewDecision.reason)
        : reviewDecision.reason;
      this.writeAdvisorRequest(taskId, {
        schema_version: 1,
        contract_version: card.contract_version,
        trigger: "review_deadlock",
        source_stage: "review",
        source_run_id: runMeta.run_id,
        source_role: "reviewer",
        category: "stuck_loop",
        reason: reviewDecision.reason,
        question: `任务 "${card.title}" 独立审查连续 ${consecutiveSameFailureCount} 次因同类缺陷未能放行（${reviewDecision.reason}），请在不更改目标与 scope 的前提下裁决破局方向。`,
        options: [],
        failure_fingerprint: failureFp,
        consecutive_failures: consecutiveSameFailureCount,
        created_at: new Date().toISOString(),
      });
      await this.advanceToNextStage(taskId, "advise", guard);
      return;
    }

    if (reviewDecision.action === "invoke_triage") {
      const roles = this.store.readConfig("roles");
      if (roles?.roles.triage) {
        await this.advanceToNextStage(taskId, "triage", guard);
        return;
      }
    }

    const pending = PendingDecisionSchema.parse({
      id: `dec-${randomUUID().slice(0, 8)}`,
      task_id: taskId,
      run_id: runMeta.run_id,
      contract_version: card.contract_version,
      reason: reviewDecision.reason,
      category: "review_escalation",
      question: `任务 "${card.title}" 独立审查未通过且达到升级条件 (${reviewDecision.reason})，请拍板决定。`,
      options: [
        {
          id: "opt-rework",
          label: "退回实施继续修复",
          action: "resume",
          target_stage: "implement",
          recommended: true,
        },
        {
          id: "opt-cancel",
          label: "取消任务",
          action: "cancel",
          recommended: false,
        },
      ],
      created_at: new Date().toISOString(),
    });
    this.transitionTaskToWaiting(taskId, pending, guard);
  }

  private async finalizeVerifierRun(
    taskId: string,
    runDirName: string,
    runMeta: RunMeta,
  ): Promise<void> {
    const guard: ExpectedRunGuard = {
      runId: runMeta.run_id,
      contractVersion: runMeta.contract_version,
    };
    const envSnapshot = await this.stopAcceptEnv(taskId);
    const capturedAcceptEntry = this.activeAcceptEnvConfigs.get(taskId);
    this.activeAcceptEnvConfigs.delete(taskId);

    if (!this.isRunStillCurrent(taskId, runMeta.run_id, runMeta.contract_version)) {
      this.advisorPreRunDirtySignatures.delete(runMeta.run_id);
      this.syncCaffeinate();
      return;
    }

    const receiptLoad = this.readReceiptAndCommitLease(taskId, runDirName, runMeta);
    const card = this.store.readTaskCard(taskId);
    const acceptEntry = capturedAcceptEntry ?? this.resolveEffectiveAcceptEntry(card);
    const workspaceMutated = await this.detectAdvisorWorkspaceMutation(
      card,
      runMeta.run_id,
    );
    const leaseExpired = !receiptLoad.ok && receiptLoad.reason === "lease_expired";

    if (workspaceMutated && !leaseExpired) {
      const mutatedReport = AcceptVerificationReportSchema.parse({
        schema_version: 1,
        run_id: runMeta.run_id,
        contract_version: card.contract_version,
        checked_at: new Date().toISOString(),
        entry_kind: acceptEntry.kind,
        verdict: "blocked",
        gate_ok: false,
        rejection_reasons: ["verifier_workspace_mutation"],
        services: envSnapshot?.services ?? [],
        traffic: envSnapshot?.traffic ?? {
          observed: false,
          total_requests: 0,
          unique_paths: [],
          error_responses: [],
        },
        evidence_files: [],
        scenarios: [],
      });
      writeYamlAtomic(
        this.store.paths.runAcceptReportYaml(taskId, runDirName),
        mutatedReport,
        AcceptVerificationReportSchema,
      );
      const pending = PendingDecisionSchema.parse({
        id: `dec-${randomUUID().slice(0, 8)}`,
        task_id: taskId,
        run_id: runMeta.run_id,
        contract_version: card.contract_version,
        reason: "read_only_workspace_mutation",
        category: "read_only_guardrail_escalation",
        question: `真实验收在只读阶段修改了任务工作区文件（已拦截 verifier_workspace_mutation），请核查工作区改动后决定退回实施或取消任务。`,
        options: [
          {
            id: "opt-rework",
            label: "退回实施重新修复与验证",
            action: "resume",
            target_stage: "implement",
            recommended: true,
          },
          {
            id: "opt-cancel",
            label: "取消任务",
            action: "cancel",
            recommended: false,
          },
        ],
        created_at: new Date().toISOString(),
      });
      this.transitionTaskToWaiting(taskId, pending, guard);
      return;
    }

    if (!receiptLoad.ok) {
      if (receiptLoad.reason === "lease_expired") {
        this.syncCaffeinate();
        return;
      }
      await this.applyStageFailure(
        taskId,
        "accept",
        runMeta,
        {
          kind: "schema_invalid",
          errors: ["Missing verifier RECEIPT.md"],
        },
        guard,
      );
      return;
    }

    const parsed = parseAndValidateReceipt("verifier", receiptLoad.rawReceipt);
    if (!parsed.ok) {
      await this.applyStageFailure(
        taskId,
        "accept",
        runMeta,
        {
          kind: "schema_invalid",
          errors: parsed.errors,
        },
        guard,
      );
      return;
    }

    if (
      parsed.frontmatter.run_id !== runMeta.run_id ||
      parsed.frontmatter.contract_version !== card.contract_version
    ) {
      await this.applyStageFailure(
        taskId,
        "accept",
        runMeta,
        {
          kind: "schema_invalid",
          errors: [
            `Verifier receipt run_id/contract_version mismatch (${parsed.frontmatter.run_id}, v${parsed.frontmatter.contract_version})`,
          ],
        },
        guard,
      );
      return;
    }

    const acceptReport = validateVerifierEvidenceGate({
      runId: runMeta.run_id,
      contractVersion: card.contract_version,
      runStartedAtIso: runMeta.started_at,
      evidenceDir: this.store.paths.runEvidenceDir(taskId, runDirName),
      acceptEntry,
      receipt: parsed.frontmatter,
      workspaceMutated,
      services: envSnapshot?.services ?? [],
      traffic: envSnapshot?.traffic ?? {
        observed: false,
        total_requests: 0,
        unique_paths: [],
        error_responses: [],
      },
    });
    writeYamlAtomic(
      this.store.paths.runAcceptReportYaml(taskId, runDirName),
      acceptReport,
      AcceptVerificationReportSchema,
    );

    if (parsed.frontmatter.verdict === "pass") {
      if (!acceptReport.gate_ok) {
        await this.applyStageFailure(
          taskId,
          "accept",
          runMeta,
          {
            kind: "schema_invalid",
            errors: acceptReport.rejection_reasons,
          },
          guard,
        );
        return;
      }
      const nextStep = nextWorkflowStepAfter(
        card,
        runMeta.step_index ?? null,
        "accept",
        card.track,
      );
      await this.advanceToNextStage(
        taskId,
        nextStep?.stage ?? "deliver",
        guard,
        nextStep?.stepIndex ?? null,
      );
    } else {
      const restartIdx = findLoopRestartStepIndex(card, "implement", card.track);
      await this.advanceToNextStage(taskId, "implement", guard, restartIdx);
    }
  }

  private async finalizeTriageRun(
    taskId: string,
    runDirName: string,
    runMeta: RunMeta,
  ): Promise<void> {
    const guard: ExpectedRunGuard = {
      runId: runMeta.run_id,
      contractVersion: runMeta.contract_version,
    };
    if (!this.isRunStillCurrent(taskId, runMeta.run_id, runMeta.contract_version)) {
      this.advisorPreRunDirtySignatures.delete(runMeta.run_id);
      this.syncCaffeinate();
      return;
    }

    const receiptLoad = this.readReceiptAndCommitLease(taskId, runDirName, runMeta);
    const card = this.store.readTaskCard(taskId);
    const workspaceMutated = await this.detectAdvisorWorkspaceMutation(
      card,
      runMeta.run_id,
    );
    if (workspaceMutated) {
      const pending = PendingDecisionSchema.parse({
        id: `dec-${randomUUID().slice(0, 8)}`,
        task_id: taskId,
        run_id: runMeta.run_id,
        contract_version: card.contract_version,
        reason: "read_only_workspace_mutation",
        category: "read_only_guardrail_escalation",
        question: `异常研判在只读阶段修改了任务工作区文件（已拦截），请核查工作区改动后决定退回实施或取消任务。`,
        options: [
          {
            id: "opt-retry-impl",
            label: "退回实施阶段",
            action: "resume",
            target_stage: "implement",
            recommended: true,
          },
          {
            id: "opt-cancel",
            label: "取消任务",
            action: "cancel",
            recommended: false,
          },
        ],
        created_at: new Date().toISOString(),
      });
      this.transitionTaskToWaiting(taskId, pending, guard);
      return;
    }

    if (!receiptLoad.ok) {
      if (receiptLoad.reason === "lease_expired") {
        this.syncCaffeinate();
        return;
      }
      const pending = PendingDecisionSchema.parse({
        id: `dec-${randomUUID().slice(0, 8)}`,
        task_id: taskId,
        run_id: runMeta.run_id,
        contract_version: card.contract_version,
        reason: "triage_no_receipt",
        category: "triage_escalation",
        question: `异常研判未能生成有效回执，请决定如何继续任务 "${card.title}"。`,
        options: [
          {
            id: "opt-retry-impl",
            label: "退回实施重试",
            action: "resume",
            target_stage: "implement",
            recommended: true,
          },
          {
            id: "opt-cancel",
            label: "取消任务",
            action: "cancel",
            recommended: false,
          },
        ],
        created_at: new Date().toISOString(),
      });
      this.transitionTaskToWaiting(taskId, pending, guard);
      return;
    }

    const parsed = parseAndValidateReceipt("triage", receiptLoad.rawReceipt);
    const versionMatches =
      parsed.ok &&
      parsed.frontmatter.run_id === runMeta.run_id &&
      parsed.frontmatter.contract_version === card.contract_version;

    if (versionMatches && parsed.frontmatter.recommendation === "retry") {
      await this.advanceToNextStage(taskId, "implement", guard);
      return;
    }

    if (versionMatches && parsed.frontmatter.recommendation === "escalate_advisor") {
      assertCanInvokeAdvisor("triage");
      const { counters } = this.computeStageCounters(
        taskId,
        card,
        "triage",
        runMeta.run_id,
      );
      if (counters.advisorCalls < card.limits.advisor_calls && this.isAdvisorConfigured()) {
        this.writeAdvisorRequest(taskId, {
          schema_version: 1,
          contract_version: card.contract_version,
          trigger: "triage_escalation",
          source_stage: "triage",
          source_run_id: runMeta.run_id,
          source_role: "triage",
          category: "triage_escalation",
          reason: "triage_escalated_advisor",
          question: parsed.frontmatter.summary,
          options: [],
          created_at: new Date().toISOString(),
        });
        await this.advanceToNextStage(taskId, "advise", guard);
        return;
      }
    }

    const summary = versionMatches
      ? parsed.frontmatter.summary
      : parsed.ok
        ? "Triage 回执 run_id 或 contract_version 与当前运行不一致，交由人工拍板处理"
        : "Triage 建议交由人工拍板处理";
    const pending = PendingDecisionSchema.parse({
      id: `dec-${randomUUID().slice(0, 8)}`,
      task_id: taskId,
      run_id: runMeta.run_id,
      contract_version: card.contract_version,
      reason: "triage_escalated_human",
      category: "triage_escalation",
      question: `异常研判结论：${summary}`,
      options: [
        {
          id: "opt-resume-impl",
          label: "确认处理并继续实施",
          action: "resume",
          target_stage: "implement",
          recommended: true,
        },
        {
          id: "opt-cancel",
          label: "取消任务",
          action: "cancel",
          recommended: false,
        },
      ],
      created_at: new Date().toISOString(),
    });
    this.transitionTaskToWaiting(taskId, pending, guard);
  }

  private async finalizePlanRun(
    taskId: string,
    runDirName: string,
    runMeta: RunMeta,
  ): Promise<void> {
    await this.finalizeReadOnlyPlanningRun({
      taskId,
      runDirName,
      runMeta,
      stage: "plan",
      outputPath: this.store.paths.planMd(taskId),
      titlePrefix: "技术实施方案",
      missingReceiptError: "Missing advisor PLAN RECEIPT.md",
      needDecisionReason: "plan_need_decision",
      needDecisionCategory: "plan_decision",
      stageLabel: "方案阶段",
    });
  }

  private async finalizeResearchRun(
    taskId: string,
    runDirName: string,
    runMeta: RunMeta,
  ): Promise<void> {
    await this.finalizeReadOnlyPlanningRun({
      taskId,
      runDirName,
      runMeta,
      stage: "research",
      outputPath: this.store.paths.researchMd(taskId),
      titlePrefix: "调研结论与可行性报告",
      missingReceiptError: "Missing researcher RECEIPT.md",
      needDecisionReason: "research_need_decision",
      needDecisionCategory: "research_decision",
      stageLabel: "调研阶段",
    });
  }

  private async finalizeReadOnlyPlanningRun(params: {
    taskId: string;
    runDirName: string;
    runMeta: RunMeta;
    stage: "plan" | "research";
    outputPath: string;
    titlePrefix: string;
    missingReceiptError: string;
    needDecisionReason: string;
    needDecisionCategory: string;
    stageLabel: string;
  }): Promise<void> {
    const {
      taskId,
      runDirName,
      runMeta,
      stage,
      outputPath,
      titlePrefix,
      missingReceiptError,
      needDecisionReason,
      needDecisionCategory,
      stageLabel,
    } = params;
    const guard: ExpectedRunGuard = {
      runId: runMeta.run_id,
      contractVersion: runMeta.contract_version,
    };
    if (!this.isRunStillCurrent(taskId, runMeta.run_id, runMeta.contract_version)) {
      this.advisorPreRunDirtySignatures.delete(runMeta.run_id);
      this.syncCaffeinate();
      return;
    }

    const receiptLoad = this.readReceiptAndCommitLease(taskId, runDirName, runMeta);
    if (!receiptLoad.ok && receiptLoad.reason === "lease_expired") {
      this.advisorPreRunDirtySignatures.delete(runMeta.run_id);
      this.syncCaffeinate();
      return;
    }

    const card = this.store.readTaskCard(taskId);
    const workspaceMutated = await this.detectAdvisorWorkspaceMutation(
      card,
      runMeta.run_id,
    );
    const parsed = receiptLoad.ok
      ? parseAndValidateReceipt("advisor", receiptLoad.rawReceipt)
      : null;

    if (workspaceMutated) {
      this.escalateAdvisorWorkspaceMutation({
        taskId,
        stage,
        card,
        runMeta,
        guard,
        approach: parsed?.ok ? parsed.frontmatter.chosen_approach : undefined,
      });
      return;
    }

    if (!receiptLoad.ok) {
      await this.applyStageFailure(
        taskId,
        stage,
        runMeta,
        {
          kind: "schema_invalid",
          errors: [missingReceiptError],
        },
        guard,
      );
      return;
    }

    if (!parsed || !parsed.ok) {
      await this.applyStageFailure(
        taskId,
        stage,
        runMeta,
        {
          kind: "schema_invalid",
          errors: parsed ? parsed.errors : [missingReceiptError],
        },
        guard,
      );
      return;
    }

    if (
      parsed.frontmatter.run_id !== runMeta.run_id ||
      parsed.frontmatter.contract_version !== card.contract_version
    ) {
      await this.applyStageFailure(
        taskId,
        stage,
        runMeta,
        {
          kind: "schema_invalid",
          errors: [
            `Advisor ${stage} receipt run_id/contract_version mismatch (${parsed.frontmatter.run_id}, v${parsed.frontmatter.contract_version})`,
          ],
        },
        guard,
      );
      return;
    }

    const authGuard = evaluateAdvisorAuthorityGuard(parsed.frontmatter, {
      workspaceMutated,
    });
    if (!authGuard.allowed) {
      const pending = PendingDecisionSchema.parse({
        id: `dec-${randomUUID().slice(0, 8)}`,
        task_id: taskId,
        run_id: runMeta.run_id,
        contract_version: card.contract_version,
        reason: authGuard.reason,
        category: "advisor_guardrail_escalation",
        question: `技术顾问在${stageLabel}触发防越权护栏：${authGuard.detail}。\n- 建议结论: ${parsed.frontmatter.chosen_approach}`,
        options: [
          {
            id: `opt-retry-${stage}`,
            label: `重新生成（保持原边界）`,
            action: "resume",
            target_stage: stage,
            recommended: true,
          },
          {
            id: "opt-resume-implement",
            label: "忽略越权部分，按当前讨论直接实施",
            action: "resume",
            target_stage: "implement",
            recommended: false,
          },
          {
            id: "opt-cancel",
            label: "取消任务",
            action: "cancel",
            recommended: false,
          },
        ],
        created_at: new Date().toISOString(),
      });
      this.transitionTaskToWaiting(taskId, pending, guard);
      return;
    }

    if (parsed.frontmatter.outcome === "resolved") {
      const markdown = [
        `# ${titlePrefix} (${card.id})`,
        ``,
        `- 选定方案: ${parsed.frontmatter.chosen_approach}`,
        `- 阶段轮次: ${runMeta.run_id}`,
        ``,
        parsed.body.trim(),
        ``,
      ].join("\n");
      writeFileAtomic(outputPath, markdown);
      const derived = deriveTaskStatus(card, this.store.readStateEvents(taskId));
      const nextStep = nextWorkflowStepAfter(
        card,
        runMeta.step_index ?? null,
        stage,
        derived.track,
      );
      await this.advanceToNextStage(
        taskId,
        nextStep?.stage ?? "implement",
        guard,
        nextStep?.stepIndex ?? null,
      );
      return;
    }

    const pending = PendingDecisionSchema.parse({
      id: `dec-${randomUUID().slice(0, 8)}`,
      task_id: taskId,
      run_id: runMeta.run_id,
      contract_version: card.contract_version,
      reason: needDecisionReason,
      category: needDecisionCategory,
      question: `只读角色在${stageLabel}提出需人工拍板事项（${parsed.frontmatter.chosen_approach}），请确认方向。`,
      options: [
        {
          id: "opt-resume-implement",
          label: "确认方向，进入实施阶段",
          action: "resume",
          target_stage: "implement",
          recommended: true,
        },
        {
          id: `opt-retry-${stage}`,
          label: "补充要求后重新执行本阶段",
          action: "resume",
          target_stage: stage,
          recommended: false,
        },
        {
          id: "opt-cancel",
          label: "取消任务",
          action: "cancel",
          recommended: false,
        },
      ],
      created_at: new Date().toISOString(),
    });
    this.transitionTaskToWaiting(taskId, pending, guard);
  }

  private escalateAdvisorWorkspaceMutation(input: {
    taskId: string;
    stage: "plan" | "research" | "advise";
    card: TaskCard;
    runMeta: RunMeta;
    guard: ExpectedRunGuard;
    advisorReq?: AdvisorRequest | null;
    approach?: string;
    safeMutationTarget?: "implement" | "review";
  }): void {
    const approachSuffix = input.approach ? `\n- 顾问建议: ${input.approach}` : "";
    const contextSuffix = input.advisorReq
      ? `\n- 原触发问题: ${input.advisorReq.question}`
      : "";
    const options =
      input.stage === "plan" || input.stage === "research"
        ? [
            {
              id: `opt-retry-${input.stage}`,
              label:
                input.stage === "research"
                  ? "重新调研（请先核查工作区改动并保持只读）"
                  : "重新生成方案（请先核查工作区改动并保持边界）",
              action: "resume" as const,
              target_stage: input.stage,
              recommended: true,
            },
            {
              id: "opt-resume-implement",
              label: "忽略越权部分，转入实施阶段核查并重跑验证",
              action: "resume" as const,
              target_stage: "implement" as const,
              recommended: false,
            },
            {
              id: "opt-cancel",
              label: "取消任务",
              action: "cancel" as const,
              recommended: false,
            },
          ]
        : [
            {
              id: "opt-resume-implement",
              label:
                (input.safeMutationTarget ?? "implement") === "implement"
                  ? "退回实施阶段核查并重跑验证"
                  : "退回流程核查工作区后继续",
              action: "resume" as const,
              target_stage: input.safeMutationTarget ?? "implement",
              recommended: true,
            },
            {
              id: "opt-cancel",
              label: "取消任务",
              action: "cancel" as const,
              recommended: false,
            },
          ];

    const pending = PendingDecisionSchema.parse({
      id: `dec-${randomUUID().slice(0, 8)}`,
      task_id: input.taskId,
      run_id: input.runMeta.run_id,
      contract_version: input.card.contract_version,
      reason: "advisor_workspace_mutation",
      category: "advisor_guardrail_escalation",
      question:
        input.stage === "plan"
          ? `技术顾问在方案阶段触发防越权护栏：顾问仅限只读分析与方案裁决，禁止直接修改任务工作区文件（已拦截）。${approachSuffix}`
          : input.stage === "research"
            ? `只读调研角色触发防越权护栏：调研侦察仅限只读探索，禁止修改任务工作区文件（已拦截）。${approachSuffix}`
            : `技术顾问在只读决策阶段触发防越权护栏：顾问仅限只读分析与方案裁决，禁止直接修改或提交任务工作区文件（已拦截，请先核查或清理工作区改动）。${approachSuffix}${contextSuffix}`,
      options,
      created_at: new Date().toISOString(),
    });
    this.transitionTaskToWaiting(input.taskId, pending, input.guard);
  }

  private async finalizeAdvisorRun(
    taskId: string,
    runDirName: string,
    runMeta: RunMeta,
  ): Promise<void> {
    const guard: ExpectedRunGuard = {
      runId: runMeta.run_id,
      contractVersion: runMeta.contract_version,
    };
    if (!this.isRunStillCurrent(taskId, runMeta.run_id, runMeta.contract_version)) {
      this.advisorPreRunDirtySignatures.delete(runMeta.run_id);
      this.syncCaffeinate();
      return;
    }

    const receiptLoad = this.readReceiptAndCommitLease(taskId, runDirName, runMeta);
    if (!receiptLoad.ok && receiptLoad.reason === "lease_expired") {
      this.advisorPreRunDirtySignatures.delete(runMeta.run_id);
      this.syncCaffeinate();
      return;
    }

    const card = this.store.readTaskCard(taskId);
    const derivedForPipeline = deriveTaskStatus(card, this.store.readStateEvents(taskId));
    const pipelineStages = getTaskPipelineStages(card, derivedForPipeline.track);
    const workspaceMutated = await this.detectAdvisorWorkspaceMutation(
      card,
      runMeta.run_id,
    );
    const advisorReq = this.readAdvisorRequest(taskId, card.contract_version);
    const resumeTargetStage: "implement" | "review" =
      advisorReq?.source_stage === "review" && pipelineStages.includes("review")
        ? "review"
        : "implement";

    const parsed = receiptLoad.ok
      ? parseAndValidateReceipt("advisor", receiptLoad.rawReceipt)
      : null;
    const versionMatches = Boolean(
      parsed?.ok &&
        parsed.frontmatter.run_id === runMeta.run_id &&
        parsed.frontmatter.contract_version === card.contract_version,
    );

    if (workspaceMutated) {
      this.clearAdvisorRequest(taskId);
      const safeMutationTarget: "implement" | "review" = pipelineStages.includes("implement")
        ? "implement"
        : resumeTargetStage;
      this.escalateAdvisorWorkspaceMutation({
        taskId,
        stage: "advise",
        card,
        runMeta,
        guard,
        advisorReq,
        approach: parsed?.ok ? parsed.frontmatter.chosen_approach : undefined,
        safeMutationTarget,
      });
      return;
    }

    if (versionMatches && parsed?.ok && parsed.frontmatter.outcome === "resolved") {
      const authGuard = evaluateAdvisorAuthorityGuard(parsed.frontmatter, {
        workspaceMutated,
      });
      if (!authGuard.allowed) {
        this.clearAdvisorRequest(taskId);
        const contextSuffix = advisorReq
          ? `\n- 原触发问题: ${advisorReq.question}`
          : "";
        const pending = PendingDecisionSchema.parse({
          id: `dec-${randomUUID().slice(0, 8)}`,
          task_id: taskId,
          run_id: runMeta.run_id,
          contract_version: card.contract_version,
          reason: authGuard.reason,
          category: "advisor_guardrail_escalation",
          question: `技术顾问裁决触发防越权护栏：${authGuard.detail}。\n- 顾问建议: ${parsed.frontmatter.chosen_approach}${contextSuffix}`,
          options: [
            {
              id: "opt-resume-target",
              label:
                resumeTargetStage === "review"
                  ? "按讨论方向继续审查"
                  : "按讨论方向继续实施",
              action: "resume",
              target_stage: resumeTargetStage,
              recommended: true,
            },
            {
              id: "opt-cancel",
              label: "取消任务",
              action: "cancel",
              recommended: false,
            },
          ],
          created_at: new Date().toISOString(),
        });
        this.transitionTaskToWaiting(taskId, pending, guard);
        return;
      }

      const requestedTargetStage = parsed.frontmatter.target_stage;
      if (
        requestedTargetStage !== undefined &&
        !pipelineStages.includes(requestedTargetStage)
      ) {
        this.clearAdvisorRequest(taskId);
        const pending = PendingDecisionSchema.parse({
          id: `dec-${randomUUID().slice(0, 8)}`,
          task_id: taskId,
          run_id: runMeta.run_id,
          contract_version: card.contract_version,
          reason: "advisor_invalid_target_stage",
          category: "advisor_guardrail_escalation",
          question: `技术顾问建议跳转至阶段 "${requestedTargetStage}"，但当前任务流程蓝图仅包含 [${pipelineStages.join(" -> ")}]。请选择后续推进方式：\n- 顾问建议: ${parsed.frontmatter.chosen_approach}`,
          options: [
            {
              id: "opt-resume-safe-stage",
              label:
                resumeTargetStage === "review"
                  ? "留在流程内，继续审查"
                  : "留在流程内，按建议继续实施",
              action: "resume",
              target_stage: resumeTargetStage,
              recommended: true,
            },
            {
              id: "opt-cancel",
              label: "取消任务",
              action: "cancel",
              recommended: false,
            },
          ],
          created_at: new Date().toISOString(),
        });
        this.transitionTaskToWaiting(taskId, pending, guard);
        return;
      }

      const nextTargetStage: "implement" | "review" =
        requestedTargetStage ?? resumeTargetStage;
      const now = new Date().toISOString();
      const record = DecisionRecordSchema.parse({
        schema_version: 1,
        id: `adv-${runMeta.run_id}`,
        task_id: taskId,
        contract_version: card.contract_version,
        category: advisorReq?.category ?? "advisor_resolution",
        decider: "advisor",
        action: "resume",
        affected_stages: [nextTargetStage],
        rationale: parsed.frontmatter.chosen_approach,
        decided_at: now,
      });
      const decPath = this.store.paths.decisionsMd(taskId);
      const existing = readOptionalText(decPath) ?? "";
      const bodyText = parsed.body.trim();
      const block = serializeFrontmatterMarkdown(
        {
          schema_version: 1,
          id: record.id,
          task_id: record.task_id,
          contract_version: record.contract_version,
          category: record.category,
          decider: record.decider,
          action: record.action,
          affected_stages: record.affected_stages,
          rationale: record.rationale,
          decided_at: record.decided_at,
        },
        [
          `## 技术顾问裁决 (${record.id})`,
          ``,
          `- 选定方案: ${parsed.frontmatter.chosen_approach}`,
          `- 回到阶段: ${nextTargetStage}`,
          ...(advisorReq ? [`- 触发原因: ${advisorReq.trigger} (${advisorReq.reason})`] : []),
          ...(bodyText ? [``, bodyText] : []),
          ``,
        ].join("\n"),
      );
      writeFileAtomic(
        decPath,
        existing.trim().length > 0 ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`,
      );
      this.clearAdvisorRequest(taskId);
      await this.advanceToNextStage(taskId, nextTargetStage, guard);
      return;
    }

    this.clearAdvisorRequest(taskId);
    const originalContext = advisorReq
      ? `\n- 原触发问题: ${advisorReq.question}`
      : "";
    const pending = PendingDecisionSchema.parse({
      id: `dec-${randomUUID().slice(0, 8)}`,
      task_id: taskId,
      run_id: runMeta.run_id,
      contract_version: card.contract_version,
      reason: "advisor_need_decision",
      category: "advisor_escalation",
      question: parsed?.ok
        ? versionMatches
          ? `技术顾问无法在当前授权内决断（${parsed.frontmatter.chosen_approach}），请拍板。${originalContext}`
          : `技术顾问回执 run_id 或 contract_version 不匹配，请人工拍板任务 "${card.title}"。`
        : `技术顾问未产出有效裁决，请人工拍板任务 "${card.title}"。${originalContext}`,
      options: [
        {
          id: "opt-resume-impl",
          label:
            resumeTargetStage === "review" ? "按讨论方向继续审查" : "按讨论方向继续实施",
          action: "resume",
          target_stage: resumeTargetStage,
          recommended: true,
        },
        {
          id: "opt-cancel",
          label: "取消任务",
          action: "cancel",
          recommended: false,
        },
      ],
      created_at: new Date().toISOString(),
    });
    this.transitionTaskToWaiting(taskId, pending, guard);
  }

  private async finalizeDeliverAgentRun(
    taskId: string,
    runDirName: string,
    runMeta: RunMeta,
  ): Promise<void> {
    const guard: ExpectedRunGuard = {
      runId: runMeta.run_id,
      contractVersion: runMeta.contract_version,
    };
    if (!this.isRunStillCurrent(taskId, runMeta.run_id, runMeta.contract_version)) {
      this.syncCaffeinate();
      return;
    }

    const receiptLoad = this.readReceiptAndCommitLease(taskId, runDirName, runMeta);
    if (!receiptLoad.ok) {
      if (receiptLoad.reason === "lease_expired") {
        this.syncCaffeinate();
        return;
      }
      await this.applyStageFailure(
        taskId,
        "deliver",
        runMeta,
        {
          kind: "schema_invalid",
          errors: ["Missing deliverer RECEIPT.md"],
        },
        guard,
      );
      return;
    }

    const card = this.store.readTaskCard(taskId);
    const parsed = parseAndValidateReceipt("worker", receiptLoad.rawReceipt);
    if (!parsed.ok) {
      await this.applyStageFailure(
        taskId,
        "deliver",
        runMeta,
        {
          kind: "schema_invalid",
          errors: parsed.errors,
        },
        guard,
      );
      return;
    }

    if (
      parsed.frontmatter.run_id !== runMeta.run_id ||
      parsed.frontmatter.contract_version !== card.contract_version
    ) {
      await this.applyStageFailure(
        taskId,
        "deliver",
        runMeta,
        {
          kind: "schema_invalid",
          errors: [
            `Deliverer receipt run_id/contract_version mismatch (${parsed.frontmatter.run_id}, v${parsed.frontmatter.contract_version})`,
          ],
        },
        guard,
      );
      return;
    }

    if (parsed.frontmatter.outcome === "need_decision") {
      const pending = extractDecisionFromNeedDecisionReceipt(
        receiptLoad.rawReceipt,
        taskId,
        runMeta.run_id,
        card.contract_version,
        parsed.body,
      );
      this.transitionTaskToWaiting(taskId, pending, guard);
      return;
    }

    if (card.workspace_mode === "git_worktree") {
      const worktreePath = this.getGitWorktreeDir(taskId);
      if (fs.existsSync(worktreePath)) {
        const statusRaw = await runGitCommand([
          "-C",
          worktreePath,
          "status",
          "--porcelain=v1",
          "-z",
          "-uall",
        ]);
        const dirtyPaths = statusRaw.length > 0 ? parseGitPorcelainStatusZ(statusRaw).dirtyPaths : [];
        const scopeCheck = checkScope(dirtyPaths, card.contract.scope);
        if (!scopeCheck.ok) {
          await this.applyStageFailure(
            taskId,
            "deliver",
            runMeta,
            {
              kind: "runtime_error",
              message: `deliver_scope_violation: ${scopeCheck.outOfScopePaths.join(", ")}`,
            },
            guard,
          );
          return;
        }
        await this.commitVerifiedWorktreeChanges(card, worktreePath, runMeta.round);
        const postHead = (
          await runGitCommand(["-C", worktreePath, "rev-parse", "HEAD"])
        ).trim();
        if (runMeta.input_ref && postHead !== runMeta.input_ref) {
          const derived = deriveTaskStatus(card, this.store.readStateEvents(taskId));
          const verifyIdx = getWorkflowFlatSteps(card, derived.track).findIndex(
            (n) => n.stage === "verify",
          );
          await this.advanceToNextStage(
            taskId,
            "verify",
            guard,
            verifyIdx >= 0 ? verifyIdx : null,
          );
          return;
        }
      }
    }

    await this.advanceToNextStage(
      taskId,
      "deliver",
      guard,
      runMeta.step_index ?? null,
    );
  }

  private findCompletedDelivererAfterLastImplement(
    taskId: string,
    card: TaskCard,
  ): { dirName: string; meta: RunMeta } | null {
    const runs = this.listCurrentWindowRuns(taskId, card);
    for (let i = runs.length - 1; i >= 0; i--) {
      const r = runs[i]!;
      if (r.meta.stage === "implement") {
        return null;
      }
      if (r.meta.stage === "deliver" && r.hasReceipt) {
        const raw = readOptionalText(this.store.paths.receiptMd(taskId, r.dirName));
        if (!raw) {
          continue;
        }
        const parsed = parseAndValidateReceipt("worker", raw);
        if (
          parsed.ok &&
          parsed.frontmatter.run_id === r.meta.run_id &&
          parsed.frontmatter.contract_version === card.contract_version &&
          parsed.frontmatter.outcome === "completed"
        ) {
          return { dirName: r.dirName, meta: r.meta };
        }
      }
    }
    return null;
  }

  private async dispatchVerifyStage(plan: DispatchPlan): Promise<void> {
    if (
      plan.roleAssignment !== null &&
      plan.card.workspace_mode !== "host_scoped" &&
      !this.hasCompletedAgentRunInTail(plan.taskId, plan.card, "verify", "implement")
    ) {
      await this.dispatchAgentStageRun(plan);
      return;
    }

    const now = new Date().toISOString();
    const verifyRunId = `run-${plan.taskId}-verify-r${plan.round}-v${plan.contractVersion}`;
    this.store.appendStateEvent(plan.taskId, {
      type: "running",
      at: now,
      stage: "verify",
      ...(plan.stepIndex !== null ? { step_index: plan.stepIndex } : {}),
      round: plan.round,
      run_id: verifyRunId,
    });
    this.syncCaffeinate();
    this.publishTaskUpdated(plan.taskId, {
      status: "running",
      stage: "verify",
      round: plan.round,
      contractVersion: plan.contractVersion,
    });

    await this.runTrackedStageOperation(plan.taskId, verifyRunId, async (signal) => {
      if (
        signal.aborted ||
        !this.isRunStillCurrent(plan.taskId, verifyRunId, plan.contractVersion)
      ) {
        this.syncCaffeinate();
        return;
      }

      const latestImpl = [...this.listTaskRunDirs(plan.taskId)]
        .reverse()
        .find((r) => r.meta?.stage === "implement");

      const postDeliverRun = this.findCompletedDelivererAfterLastImplement(
        plan.taskId,
        plan.card,
      );
      if (postDeliverRun !== null) {
        const card = this.store.readTaskCard(plan.taskId);
        const worktreePath =
          card.workspace_mode === "git_worktree" ? this.getGitWorktreeDir(plan.taskId) : undefined;
        const baselineSnapshot = this.readSavedFrozenBaseline(plan.taskId, card);
        let inputRef = latestImpl?.meta?.input_ref ?? postDeliverRun.meta.input_ref;
        if (worktreePath && fs.existsSync(worktreePath)) {
          const space = this.store.readSpace(card.space);
          const baseRef = space?.default_branch ?? "main";
          const isAncestor = await runGitCommand([
            "-C",
            worktreePath,
            "merge-base",
            "--is-ancestor",
            baseRef,
            "HEAD",
          ]).then(
            () => true,
            () => false,
          );
          if (isAncestor) {
            const resolvedBaseSha = (
              await runGitCommand(["-C", worktreePath, "rev-parse", baseRef]).catch(() => "")
            ).trim();
            if (resolvedBaseSha.length > 0) {
              inputRef = resolvedBaseSha;
            }
          }
        }

        const gateResult = await runVerificationGate(this.store, {
          taskId: plan.taskId,
          runDirName: postDeliverRun.dirName,
          gateCheckMode: getVerifyGateCheckMode(card),
          ...(worktreePath !== undefined ? { worktreePath } : {}),
          ...(inputRef !== undefined ? { inputRef } : {}),
          ...(baselineSnapshot !== undefined ? { baselineSnapshot } : {}),
          signal,
        });

        if (
          signal.aborted ||
          !this.isRunStillCurrent(plan.taskId, verifyRunId, card.contract_version)
        ) {
          this.syncCaffeinate();
          return;
        }

        const verifyGuard: ExpectedRunGuard = {
          runId: verifyRunId,
          contractVersion: card.contract_version,
        };
        if (gateResult.passed) {
          if (worktreePath && fs.existsSync(worktreePath)) {
            await this.commitVerifiedWorktreeChanges(
              card,
              worktreePath,
              postDeliverRun.meta.round,
            );
          }
          const derived = deriveTaskStatus(card, this.store.readStateEvents(plan.taskId));
          const deliverIdx = getWorkflowFlatSteps(card, derived.track).findIndex(
            (n) => n.stage === "deliver",
          );
          await this.advanceToNextStage(
            plan.taskId,
            "deliver",
            verifyGuard,
            deliverIdx >= 0 ? deliverIdx : null,
          );
          return;
        }

        const decision = PendingDecisionSchema.parse({
          id: `dec-${randomUUID().slice(0, 8)}`,
          task_id: plan.taskId,
          contract_version: card.contract_version,
          reason: "deliver_conflict_verify_failed",
          category: "deliver_merge_conflict",
          question: `交付代理解决合并冲突后，重跑确定性 verify 门禁未通过（accept_exit_code=${gateResult.report.accept_exit_code}, scope_ok=${gateResult.report.scope_ok}），已拦截合入主分支。请选择下一步处理：`,
          options: [
            {
              id: "opt-reimplement",
              label: "退回实施阶段排查修复",
              action: "resume",
              target_stage: "implement",
              recommended: true,
            },
            {
              id: "opt-cancel",
              label: "取消任务",
              action: "cancel",
              recommended: false,
            },
          ],
          created_at: new Date().toISOString(),
        });
        this.transitionTaskToWaiting(plan.taskId, decision, verifyGuard);
        return;
      }

      if (!latestImpl || !latestImpl.meta) {
        await this.advanceToNextStage(plan.taskId, "implement", {
          runId: verifyRunId,
          contractVersion: plan.contractVersion,
        });
        return;
      }

      await this.finalizeWorkerRun(
        plan.taskId,
        latestImpl.dirName,
        latestImpl.meta,
        null,
        signal,
        verifyRunId,
      );
    });
  }

  private async dispatchDeliverStage(plan: DispatchPlan): Promise<void> {
    await executeDeliverStage(
      {
        store: this.store,
        deliverHandler: this.deliverHandler,
        getGitWorktreeDir: (taskId) => this.getGitWorktreeDir(taskId),
        isRunStillCurrent: (taskId, runId, contractVersion) =>
          this.isRunStillCurrent(taskId, runId, contractVersion),
        syncCaffeinate: () => this.syncCaffeinate(),
        transitionTaskToWaiting: (taskId, decision, expected) =>
          this.transitionTaskToWaiting(taskId, decision, expected),
        completeTaskDelivery: (taskId, deliverRef, expected) =>
          this.completeTaskDelivery(taskId, deliverRef, expected),
        runTrackedStageOperation: (taskId, runId, fn) =>
          this.runTrackedStageOperation(taskId, runId, fn),
        publishTaskUpdated: (taskId, patch) => this.publishTaskUpdated(taskId, patch),
        shouldRunDelivererAgent: (p) =>
          p.roleAssignment !== null &&
          (p.roleAssignment.rosterMode ?? "agent") === "agent" &&
          p.card.workspace_mode === "git_worktree" &&
          this.findCompletedDelivererAfterLastImplement(p.taskId, p.card) === null,
        canRunOnConflictDeliverer: (p) =>
          p.roleAssignment !== null &&
          p.roleAssignment.rosterMode === "on_conflict" &&
          p.card.workspace_mode === "git_worktree" &&
          this.findCompletedDelivererAfterLastImplement(p.taskId, p.card) === null,
        dispatchOnConflictDeliverer: (p, conflict) =>
          this.dispatchAgentStageRun(p, {
            deliverConflictNote: [
              `- 自动 \`merge_main\` 将分支 \`kiln/${p.taskId}\` 合入 \`${conflict.baseRef}\` 时发生冲突：\`${conflict.mergeError}\``,
              `- 请在隔离 worktree (${this.getGitWorktreeDir(p.taskId)}) 内执行 \`git merge ${conflict.baseRef}\` 解决冲突并运行验收命令确认无误，严禁执行 \`git push\` 或修改主仓库。`,
              `- 提交 \`worker\` 角色回执后，内核将强制重跑确定性 \`verify\` 门禁，通过后自动完成合并。`,
            ].join("\n"),
          }),
        dispatchAgentStageRun: (p) => this.dispatchAgentStageRun(p),
        wake: () => this.wake(),
      },
      plan,
    );
  }

  private completeTaskDelivery(
    taskId: string,
    deliverRef?: string,
    expected?: ExpectedRunGuard,
  ): boolean {
    if (
      this.stopped ||
      (expected !== undefined &&
        !this.isRunStillCurrent(taskId, expected.runId, expected.contractVersion))
    ) {
      this.syncCaffeinate();
      return false;
    }

    const now = new Date().toISOString();
    this.warmPool.evictTask(taskId);
    const doneState = this.store.appendStateEvent(taskId, {
      type: "done",
      at: now,
      ...(deliverRef !== undefined ? { deliver_ref: deliverRef } : {}),
    });
    this.rateTracker.clearTask(taskId);
    this.syncCaffeinate();
    this.publishTaskUpdated(taskId, {
      status: doneState.status,
      stage: "deliver",
      contractVersion: doneState.contractVersion,
    });
    this.handleTaskTerminatedRetro(taskId);
    void this.wake();
    return true;
  }

  handleTaskTerminatedRetro(taskId: string): void {
    try {
      const report = extractDeterministicTaskRetro(this.store, taskId);
      const autoAi = this.store.readConfig("limits")?.auto_retro_high_signal === true;
      if (report.high_signal && autoAi && !this.stopped) {
        void runAiTaskRetro({
          store: this.store,
          backendRegistry: this.backendRegistry,
          taskId,
        }).catch(() => {});
      }
    } catch {
      // Never block task completion/cancellation if optional retro extraction fails
    }
  }

  async triggerTaskRetro(
    taskId: string,
    opts?: { useAi?: boolean },
  ): Promise<TaskRetroReport> {
    const safeTaskId = assertSafeSegment(taskId, "taskId");
    if (opts?.useAi) {
      return await runAiTaskRetro({
        store: this.store,
        backendRegistry: this.backendRegistry,
        taskId: safeTaskId,
      });
    }
    return extractDeterministicTaskRetro(this.store, safeTaskId);
  }
}
