import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  AcceptVerificationReportSchema,
  AdvisorRequestSchema,
  DecisionRecordSchema,
  DualSynthesisRecordSchema,
  GateReportSchema,
  PendingDecisionSchema,
  PendingSubtaskSplitSchema,
  RunEventSchema,
  RunMetaSchema,
  TaskCardSchema,
  applyAdvisorWorkflowPatch,
  buildCustomWorkflow,
  deriveLegacyRolesConfigFromRoster,
  findLoopRestartStepIndex,
  flattenWorkflowSteps,
  getVerifyGateCheckMode,
  getWorkflowFlatSteps,
  isAdvisorEligibleDecisionCategory,
  isReadOnlyRosterPermission,
  isWriteCapableRosterPermission,
  nextWorkflowStepAfter,
  parseAndValidateReceipt,
  parseFrontmatterMarkdown,
  resolveTaskWorkflow,
  resolveWorkflowStepAt,
  serializeFrontmatterMarkdown,
  validateSplitCardsDag,
  type AcceptEntryConfig,
  type AcceptVerificationReport,
  type AdvisorRequest,
  type BackendCapabilities,
  type DualSynthesisCandidateSummary,
  type DualSynthesisRecord,
  type GateReport,
  type MidFlightSubtaskSpec,
  type PendingDecision,
  type ReceiptKind,
  type RoleId,
  type RunEvent,
  type RunMeta,
  type SessionRef,
  type StageId,
  type StateEvent,
  type SteerNote,
  type SteerTaskRequest,
  type TaskCard,
  type TaskRetroReport,
  type Track,
  type VerifierCapability,
  type WorkflowAgentNode,
} from "@kiln/protocol";
import { generateAndWriteContextMap } from "./context-map.js";
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
  type SessionProbeResult,
} from "../backend/index.js";
import {
  checkScope,
  cleanupTaskCheckpoints,
  computeFrozenSnapshot,
  createGitWorktreeCheckpoint,
  detectFrozenFilesChanged,
  evaluateDeterministicFastForward,
  inspectGitWorktreeChanges,
  isChildScopeSubsetOfParent,
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
  resolveDualSynthesisPeerAssignment,
  type DispatchPlan,
  type ResolvedRoleAssignment,
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
  nextTaskStageAfter,
  type ContractUpdateInput,
  type StageCounters,
} from "../state/index.js";
import {
  KilnStore,
  assertSafeSegment,
  deriveTaskStatus,
  ensureDir,
  readNdjsonValidated,
  readYamlOptional,
  realpathCanonical,
  writeFileAtomic,
  writeYamlAtomic,
  type DerivedTaskState,
} from "../store/index.js";
import { resolveRunAttachmentInputs } from "./attachments.js";
import { computeTaskSpentUsd, evaluateDispatchBudget } from "./budget.js";
import type { CaffeinateController } from "./caffeinate.js";
import { captureHostEnvironmentSnapshot } from "./host-snapshot.js";
import type { RemoteNotifier } from "./remote-notify.js";
import { resolveMcpServerCommand, type McpCommandSpec } from "./chat.js";
import { ServerHttpError } from "./errors.js";
import { validateCommitContract } from "./space-inspect.js";
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
import { SpaceMergeLock } from "./merge-queue.js";
import {
  DEFAULT_STALL_CHECK_INTERVAL_MS,
  DEFAULT_STALL_TIMEOUT_SEC,
  evaluateRunStallState,
  probeSessionWithTimeout,
  type EvaluateRunStallResult,
} from "./stall-watchdog.js";
import { z } from "zod";

const RATE_LIMIT_MESSAGE_RE = /\b429\b|rate[_ -]?limit|too many requests|quota exceeded/i;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15_000;
const MAX_IN_RUN_RECEIPT_CONTINUATIONS = 2;

function resolveReceiptKindForRole(role: RoleId): ReceiptKind | null {
  switch (role) {
    case "worker":
      return "worker";
    case "reviewer":
    case "verifier":
    case "triage":
    case "advisor":
      return role;
    default:
      return null;
  }
}

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
  stallCheckIntervalMs?: number;
  nowMs?: () => number;
}

interface ActiveRunHandle {
  taskId: string;
  runId: string;
  runDirName: string;
  role: RoleId;
  stage: StageId;
  contractVersion: number;
  runMeta: RunMeta;
  backend: ExecutionBackend;
  sessionRef: SessionRef;
  abortController: AbortController;
  consumePromise: Promise<void>;
  cancelledByControl: boolean;
  startedAtMs: number;
  lastEventAtMs: number;
  stallWarnedAtMs: number | null;
  stallRecovering: boolean;
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

export function resolveStagedHostMapping(
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
        (p) => p.replace(/\\/g, "/").endsWith(`/${stagedRel}`) || path.basename(p) === stagedBase,
      ) ?? (absChanged.length === stagedFiles.length ? absChanged[i] : undefined);

    if (!matchedTarget) {
      matchedTarget =
        literalScopePaths.find(
          (p) => p.replace(/\\/g, "/").endsWith(`/${stagedRel}`) || path.basename(p) === stagedBase,
        ) ??
        (literalScopePaths.length === 1 &&
        stagedFiles.length === 1 &&
        !stagedRel.includes("/") &&
        (fs.existsSync(literalScopePaths[0]!) ||
          path.posix.extname(literalScopePaths[0]!.replace(/\\/g, "/")) !== "" ||
          path.posix.extname(stagedRel) === "")
          ? literalScopePaths[0]
          : undefined);
    }

    if (!matchedTarget && process.platform !== "win32" && !stagedRel.startsWith("/")) {
      const rootedCandidate = `/${stagedRel}`;
      try {
        const canonicalRooted = resolveCanonicalHostTarget(rootedCandidate);
        if (isHostTargetWithinScope(canonicalRooted, contractScope)) {
          matchedTarget = rootedCandidate;
        }
      } catch {
        // Ignore unresolvable or out-of-scope rooted candidate; fall back to scopeDirs.
      }
    }

    if (!matchedTarget && scopeDirs.length > 0) {
      const candidateDir = scopeDirs[0]!;
      try {
        if (fs.existsSync(candidateDir) && fs.statSync(candidateDir).isDirectory()) {
          matchedTarget = path.join(candidateDir, stagedRel);
        } else if (!fs.existsSync(candidateDir)) {
          try {
            fs.lstatSync(candidateDir);
          } catch (lstatErr) {
            if ((lstatErr as NodeJS.ErrnoException)?.code === "ENOENT") {
              matchedTarget = path.join(candidateDir, stagedRel);
            }
          }
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
  private readonly testFirstLockPreHeadByRunId = new Map<string, string>();
  private readonly activeAuxiliaryReceipts = new Map<
    string,
    { taskId: string; contractVersion: number; rawMarkdown?: string }
  >();
  private readonly auxiliaryActiveHandles = new Map<
    string,
    {
      taskId: string;
      runId: string;
      role: RoleId;
      backend: ExecutionBackend;
      sessionRef: SessionRef;
      lastEventAtMs: number;
    }
  >();
  private readonly activeAcceptEnvs = new Map<string, AcceptEnvSession>();
  private readonly activeAcceptEnvConfigs = new Map<string, AcceptEntryConfig>();
  private readonly approvalUnsubscribers: Array<() => void> = [];
  private readonly deferredApprovals: Array<{
    backend: ExecutionBackend;
    req: ApprovalRequestEvent;
  }> = [];
  private readonly scheduler: KilnScheduler;
  private readonly warmPool = new WarmSessionPool();
  private readonly spaceMergeLock = new SpaceMergeLock();
  private readonly latestContextPercentByRunId = new Map<string, number>();
  private readonly recentSpaceCompletedAtMs = new Map<string, number>();
  private readonly sessionKeyByRunId = new Map<string, string>();
  private readonly reuseCountByRunId = new Map<string, number>();
  private readonly warmStepMetaByRunId = new Map<
    string,
    { stepIndex: number | null; stepLabel?: string; customInstructions?: string }
  >();
  private readonly stallCheckIntervalMs: number;
  private readonly nowMs: () => number;

  private startingBackendCount = 0;
  private started = false;
  private stopped = false;
  private stallCheckTimer: ReturnType<typeof setInterval> | null = null;
  private stallSweepInFlight = false;

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
    this.rateLimitCooldownMs = options.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    this.providerHealth = options.providerHealth;
    this.scriptRunner = options.scriptRunner;
    this.remoteNotifier = options.remoteNotifier;
    this.acceptEnvStarter = options.acceptEnvStarter ?? startAcceptEnvSession;
    this.stallCheckIntervalMs = Math.max(
      20,
      options.stallCheckIntervalMs ?? DEFAULT_STALL_CHECK_INTERVAL_MS,
    );
    this.nowMs = options.nowMs ?? (() => Date.now());

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
    let matched: {
      taskId: string;
      runId: string;
      role: RoleId;
    } | null = null;
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
      const auxKey = `${backend.backendId}:${req.sessionRef.sessionId}`;
      const aux = this.auxiliaryActiveHandles.get(auxKey);
      if (aux) {
        matched = aux;
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
      finalizePlanRun: (taskId, dirName, meta) => this.finalizePlanRun(taskId, dirName, meta),
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
      finalizeTriageRun: (taskId, dirName, meta) => this.finalizeTriageRun(taskId, dirName, meta),
      finalizeAdvisorRun: (taskId, dirName, meta) => this.finalizeAdvisorRun(taskId, dirName, meta),
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
    if (this.stallCheckTimer) {
      clearInterval(this.stallCheckTimer);
    }
    this.stallCheckTimer = setInterval(() => {
      void this.checkStalledRunsNow();
    }, this.stallCheckIntervalMs);
    this.stallCheckTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.stallCheckTimer) {
      clearInterval(this.stallCheckTimer);
      this.stallCheckTimer = null;
    }
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
    const auxHandles = Array.from(this.auxiliaryActiveHandles.values());
    this.auxiliaryActiveHandles.clear();
    this.activeAuxiliaryReceipts.clear();
    for (const aux of auxHandles) {
      await aux.backend.cancel(aux.sessionRef).catch(() => {});
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
    }
    for (const [auxKey, aux] of this.auxiliaryActiveHandles.entries()) {
      if (aux.taskId === safeTaskId) {
        this.auxiliaryActiveHandles.delete(auxKey);
        await aux.backend.cancel(aux.sessionRef).catch(() => {});
      }
    }
    if (op) {
      await op.promise.catch(() => {});
      if (this.inFlightOperations.get(safeTaskId)?.runId === op.runId) {
        this.inFlightOperations.delete(safeTaskId);
      }
    }
  }

  tryAcceptAuxiliaryReceipt(input: {
    claims: { taskId: string; runId: string; contractVersion: number };
    rawMarkdown: string;
  }): boolean {
    const entry = this.activeAuxiliaryReceipts.get(input.claims.runId);
    if (
      !entry ||
      entry.taskId !== input.claims.taskId ||
      entry.contractVersion !== input.claims.contractVersion
    ) {
      return false;
    }
    entry.rawMarkdown = input.rawMarkdown;
    return true;
  }

  async cleanupDeletedTask(taskId: string, card: TaskCard): Promise<void> {
    const safeTaskId = assertSafeSegment(taskId, "taskId");
    this.rateTracker.clearTask(safeTaskId);
    this.warmPool.evictTask(safeTaskId);
    await this.stopAcceptEnv(safeTaskId).catch(() => {});
    this.activeAcceptEnvConfigs.delete(safeTaskId);
    if (card.workspace_mode === "git_worktree") {
      const space = this.store.readSpace(card.space);
      if (space?.repo_path && fs.existsSync(space.repo_path)) {
        const worktreeDir = this.getGitWorktreeDir(safeTaskId);
        if (fs.existsSync(worktreeDir)) {
          await runGitCommand(
            ["worktree", "remove", "--force", worktreeDir],
            space.repo_path,
          ).catch(() => "");
        }
        await runGitCommand(["branch", "-D", `kiln/${safeTaskId}`], space.repo_path).catch(
          () => "",
        );
        await cleanupTaskCheckpoints(space.repo_path, safeTaskId).catch(() => 0);
      }
    }
  }

  /**
   * Sweeps all active running turns under the Witness heartbeat policy:
   * - At `1x stall_timeout_sec` without new events, probes session liveness (5s timeout).
   * - If dead/closed, aborts immediately; if alive and unwarned, emits a single `soft_warning`.
   * - At `2x stall_timeout_sec`, force-aborts even if alive and drives bounded recovery
   *   (`retry_stage` -> `invoke_advisor` (`run_stalled`) -> `escalate_failure`).
   */
  async checkStalledRunsNow(): Promise<void> {
    if (this.stopped || this.stallSweepInFlight) {
      return;
    }
    const timeoutSec =
      this.store.readConfig("limits")?.stall_timeout_sec ?? DEFAULT_STALL_TIMEOUT_SEC;
    if (timeoutSec <= 0) {
      return;
    }

    this.stallSweepInFlight = true;
    try {
      const stallTimeoutMs = timeoutSec * 1_000;
      const handles = Array.from(this.activeRuns.values());
      for (const handle of handles) {
        if (
          this.stopped ||
          handle.cancelledByControl ||
          handle.stallRecovering ||
          handle.abortController.signal.aborted
        ) {
          continue;
        }
        const current = this.activeRuns.get(handle.taskId);
        if (!current || current.runId !== handle.runId) {
          continue;
        }

        const now = this.nowMs();
        const silentMs = Math.max(0, now - handle.lastEventAtMs);
        if (silentMs < stallTimeoutMs) {
          continue;
        }

        const probeResult = await probeSessionWithTimeout(handle.backend, handle.sessionRef);
        if (
          this.stopped ||
          handle.cancelledByControl ||
          handle.stallRecovering ||
          handle.abortController.signal.aborted ||
          this.activeRuns.get(handle.taskId)?.runId !== handle.runId
        ) {
          continue;
        }

        const afterProbeNow = this.nowMs();
        const afterProbeSilentMs = Math.max(0, afterProbeNow - handle.lastEventAtMs);
        const evalResult = evaluateRunStallState({
          silentMs: afterProbeSilentMs,
          stallTimeoutMs,
          alreadyWarned: handle.stallWarnedAtMs !== null,
          probeResult,
        });

        if (evalResult.action === "soft_warn") {
          handle.stallWarnedAtMs = afterProbeNow;
          const warnEvent: RunEvent = {
            kind: "stall_warning",
            at: new Date(afterProbeNow).toISOString(),
            phase: "soft_warning",
            silentSec: evalResult.silentSec,
            probeAlive: probeResult ? probeResult.alive : null,
            ...(probeResult ? { probeStatus: probeResult.status } : {}),
            action: "warn",
            detail: `No run events for ${evalResult.silentSec}s while session status is ${probeResult?.status ?? "unknown"}`,
          };
          this.store.recordRunEvent(handle.taskId, handle.runDirName, warnEvent);
          this.sseHub.publish({
            type: "run.event",
            taskId: handle.taskId,
            runId: handle.runId,
            event: warnEvent,
          });
          void this.remoteNotifier?.notifyRunStalled({
            taskId: handle.taskId,
            stage: handle.stage,
            silentSec: evalResult.silentSec,
            phase: "soft_warning",
          });
          continue;
        }

        if (evalResult.action === "abort_dead" || evalResult.action === "abort_hard_timeout") {
          await this.recoverStalledRun(handle, evalResult, probeResult);
        }
      }

      const auxHandles = Array.from(this.auxiliaryActiveHandles.entries());
      for (const [auxKey, aux] of auxHandles) {
        if (this.stopped || !this.auxiliaryActiveHandles.has(auxKey)) {
          continue;
        }
        const silentMs = Math.max(0, this.nowMs() - aux.lastEventAtMs);
        if (silentMs < stallTimeoutMs) {
          continue;
        }
        const probeResult = await probeSessionWithTimeout(aux.backend, aux.sessionRef);
        const evalResult = evaluateRunStallState({
          silentMs: Math.max(0, this.nowMs() - aux.lastEventAtMs),
          stallTimeoutMs,
          alreadyWarned: silentMs >= stallTimeoutMs * 2,
          probeResult,
        });
        if (evalResult.action === "abort_dead" || evalResult.action === "abort_hard_timeout") {
          this.auxiliaryActiveHandles.delete(auxKey);
          await aux.backend.cancel(aux.sessionRef).catch(() => {});
        }
      }
    } finally {
      this.stallSweepInFlight = false;
    }
  }

  private countPriorAbortedStallsInWindow(
    taskId: string,
    card: TaskCard,
    stage: StageId,
    excludeRunId: string,
  ): number {
    let count = 0;
    const windowRuns = this.listCurrentWindowRuns(taskId, card);
    for (const r of windowRuns) {
      if (r.meta.stage !== stage || r.meta.run_id === excludeRunId) {
        continue;
      }
      const evs = readNdjsonValidated(
        this.store.paths.runEventsNdjson(taskId, r.dirName),
        RunEventSchema,
      );
      if (evs.some((ev) => ev.kind === "stall_warning" && ev.phase === "aborted")) {
        count += 1;
      }
    }
    return count;
  }

  private async recoverStalledRun(
    handle: ActiveRunHandle,
    evalResult: Extract<EvaluateRunStallResult, { action: "abort_dead" | "abort_hard_timeout" }>,
    probeResult: SessionProbeResult | null,
  ): Promise<void> {
    if (
      this.stopped ||
      handle.cancelledByControl ||
      handle.stallRecovering ||
      handle.abortController.signal.aborted ||
      !this.isRunStillCurrent(handle.taskId, handle.runId, handle.contractVersion)
    ) {
      return;
    }

    handle.stallRecovering = true;
    handle.cancelledByControl = true;
    handle.abortController.abort();
    this.rateTracker.clearTask(handle.taskId);

    await handle.backend.cancel(handle.sessionRef).catch(() => {});
    await Promise.race([
      handle.consumePromise.catch(() => {}),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref?.();
      }),
    ]);

    this.latestContextPercentByRunId.delete(handle.runId);
    this.sessionKeyByRunId.delete(handle.runId);
    this.reuseCountByRunId.delete(handle.runId);
    if (this.activeRuns.get(handle.taskId)?.runId === handle.runId) {
      this.activeRuns.delete(handle.taskId);
    }
    this.warmPool.evictTask(handle.taskId);
    if (handle.stage === "accept") {
      await this.stopAcceptEnv(handle.taskId).catch(() => {});
      this.activeAcceptEnvConfigs.delete(handle.taskId);
    }

    if (!this.isRunStillCurrent(handle.taskId, handle.runId, handle.contractVersion)) {
      this.syncCaffeinate();
      return;
    }

    const nowIso = new Date(this.nowMs()).toISOString();
    this.store.sqlite.expireActiveLeaseByTask(handle.taskId, nowIso, "expired");

    const card = this.store.readTaskCard(handle.taskId);
    const { counters } = this.computeStageCounters(handle.taskId, card, handle.stage, handle.runId);
    const priorStalls = this.countPriorAbortedStallsInWindow(
      handle.taskId,
      card,
      handle.stage,
      handle.runId,
    );
    const stalledCountOnStage = priorStalls + 1;
    const canAdvise =
      handle.stage !== "advise" &&
      handle.stage !== "triage" &&
      this.isAdvisorConfigured() &&
      counters.advisorCalls < card.limits.advisor_calls;

    let recoveryAction: "retry_stage" | "invoke_advisor" | "escalate_failure";
    if (stalledCountOnStage === 1 && counters.stageRetries < card.limits.retries_per_stage) {
      recoveryAction = "retry_stage";
    } else if (canAdvise) {
      recoveryAction = "invoke_advisor";
    } else {
      recoveryAction = "escalate_failure";
    }

    const abortReason =
      evalResult.action === "abort_dead"
        ? `Session probe reported dead/closed after ${evalResult.silentSec}s silence`
        : `Hard stall timeout reached after ${evalResult.silentSec}s silence`;

    const abortEvent: RunEvent = {
      kind: "stall_warning",
      at: nowIso,
      phase: "aborted",
      silentSec: evalResult.silentSec,
      probeAlive: probeResult ? probeResult.alive : null,
      ...(probeResult ? { probeStatus: probeResult.status } : {}),
      action: recoveryAction,
      detail: abortReason,
    };
    const exitEvent: RunEvent = {
      kind: "exit",
      at: nowIso,
      reason: "failed",
      detail: `run_stalled: ${abortReason}`,
    };

    this.store.recordRunEvent(handle.taskId, handle.runDirName, abortEvent);
    this.store.recordRunEvent(handle.taskId, handle.runDirName, exitEvent);
    this.sseHub.publish({
      type: "run.event",
      taskId: handle.taskId,
      runId: handle.runId,
      event: abortEvent,
    });
    this.sseHub.publish({
      type: "run.event",
      taskId: handle.taskId,
      runId: handle.runId,
      event: exitEvent,
    });

    void this.remoteNotifier?.notifyRunStalled({
      taskId: handle.taskId,
      stage: handle.stage,
      silentSec: evalResult.silentSec,
      phase: "aborted",
      recoveryAction,
      priority: card.priority,
    });

    const guard: ExpectedRunGuard = {
      runId: handle.runId,
      contractVersion: handle.contractVersion,
    };

    if (recoveryAction === "retry_stage") {
      await this.advanceToNextStage(
        handle.taskId,
        handle.stage,
        guard,
        handle.runMeta.step_index ?? null,
      );
      return;
    }

    if (recoveryAction === "invoke_advisor") {
      assertCanInvokeAdvisor("kernel");
      this.writeAdvisorRequest(handle.taskId, {
        schema_version: 1,
        contract_version: card.contract_version,
        trigger: "run_stalled",
        source_stage: handle.stage,
        source_run_id: handle.runId,
        source_role: handle.role,
        category: "run_stalled",
        reason: abortReason,
        question: `任务 "${card.title}" 在阶段 ${handle.stage} 连续第 ${stalledCountOnStage} 次发生心跳停滞（${abortReason}），请在不改动契约目标与 scope 的前提下评估卡点并给出收敛执行方案。`,
        options: [],
        consecutive_failures: stalledCountOnStage,
        created_at: nowIso,
      });
      await this.advanceToNextStage(handle.taskId, "advise", guard);
      return;
    }

    await this.applyStageFailure(
      handle.taskId,
      handle.stage,
      handle.runMeta,
      {
        kind: "runtime_error",
        message: `run_stalled: ${abortReason}`,
      },
      guard,
    );
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
    if (before.status !== "queued" && before.status !== "running" && before.status !== "paused") {
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
        this.store.sqlite.expireActiveLeaseByTask(safeTaskId, new Date().toISOString(), "expired");
        const latestCard = this.store.readTaskCard(safeTaskId);
        const currentDerived = deriveTaskStatus(latestCard, this.store.readStateEvents(safeTaskId));
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
    const createdSteer = activeSteers.find((s) => s.id === steerId) ?? {
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
    const card = readYamlOptional(this.store.paths.cardYaml(taskId), TaskCardSchema);
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
      status?: TaskCard["priority"] extends never
        ? never
        : "queued" | "running" | "paused" | "waiting" | "external" | "done" | "cancelled";
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

  private readSavedFrozenBaseline(taskId: string, card: TaskCard): FrozenSnapshot | undefined {
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
    writeFileAtomic(this.frozenBaselineFilePath(taskId), `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  private ensureFrozenBaselineInitialized(card: TaskCard, rootDir: string): void {
    const space = this.store.readSpace(card.space);
    const freezePatterns = space?.freeze_patterns ?? [];

    if (card.contract.accept_files_hash === "pending") {
      const snap = computeFrozenSnapshot(rootDir, freezePatterns, card.contract.accept_cmd);
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
      const snap = computeFrozenSnapshot(rootDir, freezePatterns, card.contract.accept_cmd);
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
      return realpathCanonical(dir);
    } catch {
      return path.resolve(dir);
    }
  }

  private async refreshTaskContextMap(
    card: Pick<TaskCard, "id" | "workspace_mode" | "contract">,
    worktreePath: string,
    inputRef?: string,
  ): Promise<void> {
    if (card.workspace_mode !== "git_worktree" || !fs.existsSync(worktreePath)) {
      return;
    }
    try {
      await generateAndWriteContextMap({
        card,
        worktreePath,
        outputPath: this.store.paths.contextMapMd(card.id),
        ...(inputRef ? { inputRef } : {}),
      });
    } catch {
      // Best-effort context map never blocks task progression.
    }
  }

  private async prepareWorkspaceForPlan(
    card: TaskCard,
    stage: StageId,
  ): Promise<{ cwd: string; inputRef?: string }> {
    const prep = await this.prepareWorkspaceForPlanInner(card, stage);
    if (card.workspace_mode === "git_worktree") {
      await this.refreshTaskContextMap(card, prep.cwd, prep.inputRef);
    }
    return prep;
  }

  private async prepareWorkspaceForPlanInner(
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
      if (stage === "implement") {
        try {
          const snapshot = await captureHostEnvironmentSnapshot();
          writeFileAtomic(
            path.join(canonicalWsDir, "host-snapshot.json"),
            `${JSON.stringify(snapshot, null, 2)}\n`,
          );
        } catch {
          // Host snapshot is best-effort enrichment and never blocks dispatch.
        }
      }
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
      let baseRef = space.default_branch;
      if (card.parent !== null) {
        const hasParentBranch = await runGitCommand([
          "-C",
          space.repo_path,
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/kiln/${card.parent}`,
        ]).then(
          () => true,
          () => false,
        );
        if (hasParentBranch) {
          baseRef = `kiln/${card.parent}`;
        }
      }

      const prep = await prepareGitWorktree({
        repoPath: space.repo_path,
        worktreePath,
        branchName: `kiln/${card.id}`,
        baseRef,
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
      const subtaskBase = this.findActiveSubtaskBaseRefSha(card.id, card.contract_version);
      if (
        subtaskBase !== null &&
        (!firstImplementRun || subtaskBase.at <= firstImplementRun.meta!.started_at)
      ) {
        return {
          cwd: resolvedWorktreePath,
          inputRef: subtaskBase.sha,
        };
      }
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
      return this.backendRegistry.has(backendId) ? this.backendRegistry.get(backendId) : null;
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

  private resolveVerifierCapabilities(rosterRoleId?: string): readonly VerifierCapability[] {
    const roster = this.store.readEffectiveRosterConfig();
    const entry =
      (rosterRoleId ? roster.roster[rosterRoleId] : undefined) ?? roster.roster.verifier;
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
    if (stage !== "implement" && stage !== "review") {
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
        stage === "implement" &&
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
      if (stage === "implement" && previousAcceptSummary === null && r.meta.stage === "accept") {
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
      const gate = readYamlOptional(this.store.paths.gateYaml(taskId, r.dirName), GateReportSchema);
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
    stepLabel?: string;
    customInstructions?: string;
    escalatedFrom?: string;
    escalatedDiffStat?: string;
    deliverConflictNote?: string;
    acceptEnvContext?: AcceptEnvHandoffContext | null;
    implementMode?: "normal" | "dry_run_only" | "test_first_lock";
    lockedContractTests?: readonly string[];
  }): HandoffPayload {
    const advisorReq =
      params.stage === "advise"
        ? this.readAdvisorRequest(params.card.id, params.card.contract_version)
        : null;
    const { previousFailureSummary, previousReviewSummary, previousAcceptSummary } =
      this.buildPreviousDeltaSummaries(params.card.id, params.card, params.stage);
    return buildHandoffPayload({
      store: this.store,
      ...params,
      advisorReq,
      previousFailureSummary,
      previousReviewSummary,
      previousAcceptSummary,
    });
  }

  private async handleSchedulerDispatchError(taskId: string, error: unknown): Promise<void> {
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
      const nextStep = nextWorkflowStepAfter(
        plan.card,
        plan.stepIndex,
        plan.stage,
        plan.card.track,
      );
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
    const backend = await this.findBackendWithAgent(assignment.backendId, assignment.agent);
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
    if (
      budgetEval.blocked &&
      budgetEval.blockingStatus &&
      budgetEval.blockingStatus.limit_usd !== null
    ) {
      const bScope = budgetEval.blockingScope ?? budgetEval.blockingStatus.scope;
      const bStatus = budgetEval.blockingStatus;
      const scopeLabel =
        bScope === "card"
          ? "单卡 USD 预算"
          : bScope === "daily"
            ? "全局每日 USD 预算"
            : "全局每月 USD 预算";
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
                  id: "opt-unlimited-global-budget",
                  label: `移除${bScope === "daily" ? "每日" : "每月"}金额上限并继续`,
                  action: "resume",
                  recommended: false,
                },
                {
                  id: "opt-retry-budget",
                  label: "已在设置调整预算或等待重置后直接继续",
                  action: "resume",
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

    const resolvedDispatchStep = resolveWorkflowStepAt(
      plan.card,
      plan.stepIndex ?? null,
      plan.stage,
      plan.card.track,
    )?.node;
    const isDualPlanNode =
      plan.stage === "plan" &&
      resolvedDispatchStep?.kind === "agent" &&
      resolvedDispatchStep.plan_mode === "dual_synthesis";
    const isEscalatedDualAdvise =
      plan.stage === "advise" &&
      this.listCurrentWindowRuns(plan.taskId, plan.card).filter((r) => r.meta.stage === "advise")
        .length >= 1;
    if ((isDualPlanNode || isEscalatedDualAdvise) && plan.role === "advisor") {
      const handled = await this.dispatchDualSynthesisStageRun(plan, assignment);
      if (handled) {
        return;
      }
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
            ...(assignment.rosterRoleId !== undefined
              ? { roster_role: assignment.rosterRoleId }
              : {}),
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
            ...((startRes.prepareError ?? startRes.errorMessage)
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
          const restartIdx = this.resolveImplementReworkStepIndex(
            plan.taskId,
            plan.card,
            findLoopRestartStepIndex(plan.card, "implement", plan.card.track),
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

    const resolvedStepNode = resolveWorkflowStepAt(
      plan.card,
      plan.stepIndex ?? null,
      plan.stage,
      plan.card.track,
    )?.node;
    const dispatchImplementMode =
      plan.stage === "implement" && resolvedStepNode?.kind === "agent"
        ? (resolvedStepNode.mode ?? "normal")
        : undefined;
    const activeTestsLock =
      plan.stage === "implement" && (dispatchImplementMode ?? "normal") === "normal"
        ? this.getActiveContractTestsLock(plan.taskId, plan.contractVersion)
        : null;

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
      ...(assignment.stepLabel !== undefined ? { stepLabel: assignment.stepLabel } : {}),
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
      ...(dispatchImplementMode !== undefined ? { implementMode: dispatchImplementMode } : {}),
      ...(activeTestsLock !== null && activeTestsLock.test_files.length > 0
        ? { lockedContractTests: activeTestsLock.test_files }
        : {}),
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
            stepIndex: plan.stepIndex,
            stepLabel: assignment.stepLabel,
            customInstructions: assignment.customInstructions,
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
      const leaseResult = this.store.persistRunBeforeDispatch(warmRunMeta, runDirName, warmMessage);
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
      this.warmStepMetaByRunId.set(runId, {
        stepIndex: plan.stepIndex,
        ...(assignment.stepLabel !== undefined ? { stepLabel: assignment.stepLabel } : {}),
        ...(assignment.customInstructions !== undefined
          ? { customInstructions: assignment.customInstructions }
          : {}),
      });
      this.startingBackendCount += 1;
      let sendSucceeded = false;
      try {
        await backend.send(warmEntry.sessionRef, warmMessage);
        sendSucceeded = true;
      } catch {
        this.sessionKeyByRunId.delete(runId);
        this.reuseCountByRunId.delete(runId);
        this.warmStepMetaByRunId.delete(runId);
        void backend.cancel(warmEntry.sessionRef).catch(() => {});
        warmEntry = null;
      } finally {
        this.startingBackendCount = Math.max(0, this.startingBackendCount - 1);
      }
      if (sendSucceeded) {
        this.attachSessionConsumer(plan.taskId, runDirName, warmRunMeta, backend, warmSessionRef);
        this.flushDeferredApprovals();
        return;
      }
    }

    if (plan.stage === "implement" && !canTryWarm) {
      this.warmPool.evictTask(plan.taskId);
    }

    const handoffMarkdown = handoff.fullMarkdown;
    const coldSessionKey =
      plan.stage === "implement" && plan.role === "worker" && caps.warmSessionReuse === true
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
      writeYamlAtomic(this.store.paths.runYaml(plan.taskId, runDirName), runMeta, RunMetaSchema);
      writeFileAtomic(this.store.paths.handoffMd(plan.taskId, runDirName), handoffMarkdown);
    } else {
      const leaseResult = this.store.persistRunBeforeDispatch(runMeta, runDirName, handoffMarkdown);
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
      this.warmStepMetaByRunId.set(runId, {
        stepIndex: plan.stepIndex,
        ...(assignment.stepLabel !== undefined ? { stepLabel: assignment.stepLabel } : {}),
        ...(assignment.customInstructions !== undefined
          ? { customInstructions: assignment.customInstructions }
          : {}),
      });
    }

    const mcpServers: McpStdioMountSpec[] | undefined = caps.mcpInjection
      ? [
          {
            name: "kiln",
            command: this.mcpServerCommand.command,
            args: [...this.mcpServerCommand.args],
            env: {
              ...(this.mcpServerCommand.env ?? {}),
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

    const allowedWriteRoots =
      !isReadOnly &&
      (plan.card.workspace_mode === "host_scoped" || assignment.perm === "host_staged")
        ? [this.canonicalizeWorkspacePath(this.store.paths.stagedDir(plan.taskId))]
        : undefined;

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
      ...(allowedWriteRoots !== undefined ? { allowedWriteRoots } : {}),
      ...(mcpServers !== undefined ? { mcpServers } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };

    if (
      dispatchImplementMode === "test_first_lock" &&
      plan.card.workspace_mode === "git_worktree"
    ) {
      const preHead = (
        await runGitCommand(["-C", workspace.cwd, "rev-parse", "HEAD"]).catch(() => "")
      ).trim();
      if (preHead.length > 0) {
        this.testFirstLockPreHeadByRunId.set(runId, preHead);
      }
    }

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

    const latestCard = readYamlOptional(this.store.paths.cardYaml(plan.taskId), TaskCardSchema);
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
        this.store.sqlite.expireActiveLeaseByTask(plan.taskId, new Date().toISOString(), "expired");
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

    this.attachSessionConsumer(plan.taskId, runDirName, updatedRunMeta, backend, sessionRef);
    this.flushDeferredApprovals();
  }

  private async dispatchDualSynthesisStageRun(
    plan: DispatchPlan,
    primaryAssignment: ResolvedRoleAssignment,
  ): Promise<boolean> {
    if (plan.stage !== "plan" && plan.stage !== "advise") {
      return false;
    }
    const stage: "plan" | "advise" = plan.stage;
    const nowMs = this.nowMs();
    const rosterConfig = this.store.readConfig("roster");
    if (!rosterConfig) {
      return false;
    }

    const peerAssignment = resolveDualSynthesisPeerAssignment(
      rosterConfig,
      stage,
      { agent: primaryAssignment.agent, model: primaryAssignment.model },
      {
        agentCapabilitiesMap: this.agentCapabilitiesMap,
        isCoolingDown: (key) =>
          this.scheduler.isKeyInCooldown(key, nowMs) ||
          (this.providerHealth?.isInCooldown(key.agent, nowMs) ?? false),
      },
    );
    const backendA = await this.findBackendWithAgent(
      primaryAssignment.backendId,
      primaryAssignment.agent,
    );
    const peerBackend = peerAssignment
      ? await this.findBackendWithAgent(peerAssignment.backendId, peerAssignment.agent)
      : null;

    if (!peerAssignment || !peerBackend || !backendA) {
      const fallbackRecord: DualSynthesisRecord = DualSynthesisRecordSchema.parse({
        schema_version: 1,
        stage,
        run_id: `fallback-${randomUUID().slice(0, 6)}`,
        contract_version: plan.contractVersion,
        status: "fallback_single",
        reused_brain_a_session: false,
        created_at: new Date().toISOString(),
        candidates: [
          {
            brain: "A",
            agent: primaryAssignment.agent,
            model: primaryAssignment.model,
            outcome: "skipped",
            summary: "未找到可用异构备选模型，降级单脑执行",
          },
        ],
        note: "当前未配置或无健康异构备选模型（Brain B），已退化为单脑规划/裁决",
      });
      writeYamlAtomic(
        this.store.paths.dualSynthesisYaml(plan.taskId),
        fallbackRecord,
        DualSynthesisRecordSchema,
      );
      return false;
    }

    const workspace = await this.prepareWorkspaceForPlan(plan.card, stage);
    const runDirName = this.allocateRunDirName(plan.taskId, stage);
    const runId = `run-${plan.taskId}-${stage}-r${plan.round}-v${plan.contractVersion}-${randomUUID().slice(0, 6)}`;
    const now = new Date().toISOString();
    const guard: ExpectedRunGuard = {
      runId,
      contractVersion: plan.contractVersion,
    };

    const capsA = await backendA.capabilities(primaryAssignment.agent);
    assertRoleAgentEligible("advisor", primaryAssignment.agent, capsA);

    fs.rmSync(this.store.paths.planCandidateAMd(plan.taskId), { force: true });
    fs.rmSync(this.store.paths.planCandidateBMd(plan.taskId), { force: true });

    const handoff = this.buildHandoffPayload({
      card: plan.card,
      runId,
      runDirName,
      stage,
      round: plan.round,
      role: "advisor",
      cwd: workspace.cwd,
      inputRef: workspace.inputRef,
      mcpEnabled: capsA.mcpInjection,
      ...(primaryAssignment.rosterRoleId !== undefined
        ? { rosterRoleId: primaryAssignment.rosterRoleId }
        : {}),
      ...(primaryAssignment.stepLabel !== undefined
        ? { stepLabel: primaryAssignment.stepLabel }
        : {}),
      ...(primaryAssignment.customInstructions !== undefined
        ? { customInstructions: primaryAssignment.customInstructions }
        : {}),
    });

    const runMeta: RunMeta = RunMetaSchema.parse({
      schema_version: 1,
      run_id: runId,
      task_id: plan.taskId,
      stage,
      ...(plan.stepIndex !== null ? { step_index: plan.stepIndex } : {}),
      round: plan.round,
      role: "advisor",
      ...(primaryAssignment.rosterRoleId !== undefined
        ? { roster_role: primaryAssignment.rosterRoleId }
        : {}),
      contract_version: plan.contractVersion,
      backend_id: backendA.backendId,
      agent: primaryAssignment.agent,
      model: primaryAssignment.model,
      ...(primaryAssignment.reasoningEffort !== undefined
        ? { reasoning_effort: primaryAssignment.reasoningEffort }
        : {}),
      session_ref: {
        backendId: backendA.backendId,
        sessionId: `dual-${runId}`,
      },
      cwd: workspace.cwd,
      ...(workspace.inputRef !== undefined ? { input_ref: workspace.inputRef } : {}),
      started_at: now,
    });

    const leaseResult = this.store.persistRunBeforeDispatch(
      runMeta,
      runDirName,
      handoff.fullMarkdown,
    );
    if (!leaseResult.acquired) {
      return true;
    }

    this.syncCaffeinate();
    this.publishTaskUpdated(plan.taskId, {
      status: "running",
      stage,
      round: plan.round,
      contractVersion: plan.contractVersion,
    });

    if (plan.card.workspace_mode === "git_worktree") {
      const preDirtySig = await this.computeWorktreeDirtySignature(workspace.cwd);
      this.advisorPreRunDirtySignatures.set(runId, preDirtySig);
    }

    const opAbortController = new AbortController();
    const signal = opAbortController.signal;
    const runPromise = (async () => {
      const runIdA = `${runId}-cand-a`;
      const runIdB = `${runId}-cand-b`;
      const registeredSessions: Array<{ backend: ExecutionBackend; sessionRef: SessionRef }> = [];
      const rateLimitHits: Array<{
        backendId: string;
        agent: string;
        model: string;
      }> = [];

      const consumeTurnEvents = async (
        brainTag: "A" | "B" | "S",
        backend: ExecutionBackend,
        sessionRef: SessionRef,
        assign: { agent: string; model: string },
        turnSeqTag: string,
      ): Promise<Extract<RunEvent, { kind: "exit" }> | null> => {
        let exitEv: Extract<RunEvent, { kind: "exit" }> | null = null;
        const auxKey = `${backend.backendId}:${sessionRef.sessionId}`;
        try {
          for await (const ev of backend.events(sessionRef)) {
            if (signal.aborted) {
              break;
            }
            const auxEntry = this.auxiliaryActiveHandles.get(auxKey);
            if (auxEntry) {
              auxEntry.lastEventAtMs = this.nowMs();
            }
            if (ev.kind === "rate_limited") {
              rateLimitHits.push({
                backendId: backend.backendId,
                agent: assign.agent,
                model: assign.model,
              });
              this.scheduler.markRateLimited(
                {
                  backendId: backend.backendId,
                  agent: assign.agent,
                  model: assign.model,
                },
                this.rateLimitCooldownMs,
              );
              const untilIso =
                this.providerHealth?.recordRateLimit(ev.provider, {
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
            const normalizedEv: RunEvent =
              ev.kind === "usage"
                ? {
                    ...ev,
                    turnId: `${brainTag.toLowerCase()}-${turnSeqTag}-${ev.turnId ?? "t"}`,
                  }
                : ev;
            this.store.recordRunEvent(plan.taskId, runDirName, normalizedEv);
            this.sseHub.publish({
              type: "run.event",
              taskId: plan.taskId,
              runId,
              event: normalizedEv,
            });
            if (ev.kind === "exit") {
              exitEv = ev;
              if (ev.reason === "failed" && ev.detail && isRateLimitErrorMessage(ev.detail)) {
                rateLimitHits.push({
                  backendId: backend.backendId,
                  agent: assign.agent,
                  model: assign.model,
                });
                this.scheduler.markRateLimited(
                  {
                    backendId: backend.backendId,
                    agent: assign.agent,
                    model: assign.model,
                  },
                  this.rateLimitCooldownMs,
                );
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (isRateLimitErrorMessage(msg)) {
            rateLimitHits.push({
              backendId: backend.backendId,
              agent: assign.agent,
              model: assign.model,
            });
            this.scheduler.markRateLimited(
              {
                backendId: backend.backendId,
                agent: assign.agent,
                model: assign.model,
              },
              this.rateLimitCooldownMs,
            );
          }
          exitEv = {
            kind: "exit",
            at: new Date().toISOString(),
            reason: "failed",
            detail: msg,
          };
        }
        return exitEv;
      };

      interface AuxCandidateResult {
        brain: "A" | "B";
        agent: string;
        model: string;
        backend: ExecutionBackend;
        sessionRef: SessionRef | null;
        exitEvent: Extract<RunEvent, { kind: "exit" }> | null;
        rawReceipt: string | null;
        parsed: ReturnType<typeof parseAndValidateReceipt<"advisor">> | null;
        mcpServers: McpStdioMountSpec[] | undefined;
        caps: BackendCapabilities;
        error?: string;
        policyError?: string;
      }

      const runCandidateBrain = async (
        brain: "A" | "B",
        backend: ExecutionBackend,
        assign: ResolvedRoleAssignment,
        auxRunId: string,
      ): Promise<AuxCandidateResult> => {
        const caps = await backend.capabilities(assign.agent);
        try {
          assertRoleAgentEligible("advisor", assign.agent, caps);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            brain,
            agent: assign.agent,
            model: assign.model,
            backend,
            sessionRef: null,
            exitEvent: null,
            rawReceipt: null,
            parsed: null,
            mcpServers: undefined,
            caps,
            error: msg,
            ...(err instanceof IneligibleRoleAgentError ? { policyError: msg } : {}),
          };
        }

        const candReceiptPath = path.join(
          this.store.paths.runDir(plan.taskId, runDirName),
          `RECEIPT_CAND_${brain}.md`,
        );
        if (!caps.mcpInjection) {
          fs.rmSync(candReceiptPath, { force: true });
        }

        const mcpServers: McpStdioMountSpec[] | undefined = caps.mcpInjection
          ? [
              {
                name: "kiln",
                command: this.mcpServerCommand.command,
                args: [...this.mcpServerCommand.args],
                env: {
                  ...(this.mcpServerCommand.env ?? {}),
                  KILN_RUN_TOKEN: this.issueRunToken({
                    taskId: plan.taskId,
                    runId: auxRunId,
                    role: "advisor",
                    contractVersion: plan.contractVersion,
                    ttlSeconds: 7_200,
                  }),
                  KILN_SOCK_PATH: this.socketPath,
                  KILN_HOME: this.store.paths.home,
                },
              },
            ]
          : undefined;

        this.activeAuxiliaryReceipts.set(auxRunId, {
          taskId: plan.taskId,
          contractVersion: plan.contractVersion,
        });

        const candHandoff = this.buildHandoffPayload({
          card: plan.card,
          runId: auxRunId,
          runDirName,
          stage,
          round: plan.round,
          role: "advisor",
          cwd: workspace.cwd,
          inputRef: workspace.inputRef,
          mcpEnabled: caps.mcpInjection,
          ...(!caps.mcpInjection ? { receiptPathOverride: candReceiptPath } : {}),
          ...(assign.rosterRoleId !== undefined ? { rosterRoleId: assign.rosterRoleId } : {}),
          ...(assign.stepLabel !== undefined ? { stepLabel: assign.stepLabel } : {}),
          ...(assign.customInstructions !== undefined
            ? { customInstructions: assign.customInstructions }
            : {}),
        });

        const candPrompt = [
          candHandoff.fullMarkdown,
          ``,
          `---`,
          `### 双脑并行独立草案指令（Brain ${brain} · ${assign.agent}/${assign.model}）`,
          `- 当前运行处于 E2 方案层双脑博弈独立起草阶段（只读），你的独立 \`run_id\` 为 \`${auxRunId}\`。`,
          ...(caps.mcpInjection
            ? [
                `- 请调用 \`wb_submit_receipt\` 提交 \`advisor\` 回执，务必将 frontmatter 中的 \`run_id\` 设为 \`${auxRunId}\`。`,
              ]
            : [
                `- 请将 \`advisor\` 回执直接写入独立路径：\`${candReceiptPath}\`（勿写主 \`RECEIPT.md\`），并将 frontmatter 中的 \`run_id\` 设为 \`${auxRunId}\`。`,
              ]),
          `- 如需人工拍板分歧，请直接通过 \`advisor\` 回执提交 \`outcome: need_decision\`（勿调用 \`wb_ask_decision\`）；严禁修改工作区文件。`,
        ].join("\n");

        const attachments = resolveRunAttachmentInputs(this.store, {
          kind: "task",
          taskId: plan.taskId,
        });
        const auxSpec: BackendRunSpec = {
          runId: auxRunId,
          taskId: plan.taskId,
          role: "advisor",
          agent: assign.agent,
          model: assign.model,
          ...(assign.reasoningEffort !== undefined
            ? { reasoningEffort: assign.reasoningEffort }
            : {}),
          cwd: workspace.cwd,
          prompt: candPrompt,
          freshContext: true,
          allowFullAccessFallback: assign.allowFullAccessFallback,
          readOnly: true,
          ...(mcpServers !== undefined ? { mcpServers } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        };

        if (
          signal.aborted ||
          this.stopped ||
          !this.isRunStillCurrent(plan.taskId, runId, plan.contractVersion)
        ) {
          return {
            brain,
            agent: assign.agent,
            model: assign.model,
            backend,
            sessionRef: null,
            exitEvent: null,
            rawReceipt: null,
            parsed: null,
            mcpServers,
            caps,
            error: "aborted_before_start",
          };
        }

        let sessionRef: SessionRef | null = null;
        this.startingBackendCount += 1;
        try {
          sessionRef = await backend.start(auxSpec);
          if (
            signal.aborted ||
            this.stopped ||
            !this.isRunStillCurrent(plan.taskId, runId, plan.contractVersion)
          ) {
            await backend.cancel(sessionRef).catch(() => {});
            return {
              brain,
              agent: assign.agent,
              model: assign.model,
              backend,
              sessionRef: null,
              exitEvent: null,
              rawReceipt: null,
              parsed: null,
              mcpServers,
              caps,
              error: "aborted_after_start",
            };
          }
          registeredSessions.push({ backend, sessionRef });
          this.auxiliaryActiveHandles.set(`${backend.backendId}:${sessionRef.sessionId}`, {
            taskId: plan.taskId,
            runId: auxRunId,
            role: "advisor",
            backend,
            sessionRef,
            lastEventAtMs: this.nowMs(),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isPolicyErr =
            err instanceof FullAccessOnlyProviderError || err instanceof IneligibleRoleAgentError;
          if (!isPolicyErr && isRateLimitErrorMessage(msg)) {
            rateLimitHits.push({
              backendId: backend.backendId,
              agent: assign.agent,
              model: assign.model,
            });
            this.scheduler.markRateLimited(
              {
                backendId: backend.backendId,
                agent: assign.agent,
                model: assign.model,
              },
              this.rateLimitCooldownMs,
            );
          }
          return {
            brain,
            agent: assign.agent,
            model: assign.model,
            backend,
            sessionRef: null,
            exitEvent: null,
            rawReceipt: null,
            parsed: null,
            mcpServers,
            caps,
            error: msg,
            ...(isPolicyErr ? { policyError: msg } : {}),
          };
        } finally {
          this.startingBackendCount = Math.max(0, this.startingBackendCount - 1);
          this.flushDeferredApprovals();
        }

        const exitEvent = await consumeTurnEvents(brain, backend, sessionRef, assign, "cand");
        let rawReceipt = this.activeAuxiliaryReceipts.get(auxRunId)?.rawMarkdown ?? null;
        if (!rawReceipt && !caps.mcpInjection) {
          rawReceipt = readOptionalText(candReceiptPath);
        }
        const parsed = rawReceipt ? parseAndValidateReceipt("advisor", rawReceipt) : null;
        return {
          brain,
          agent: assign.agent,
          model: assign.model,
          backend,
          sessionRef,
          exitEvent,
          rawReceipt,
          parsed,
          mcpServers,
          caps,
        };
      };

      try {
        const [resA, resB] = await Promise.all([
          runCandidateBrain("A", backendA, primaryAssignment, runIdA),
          runCandidateBrain("B", peerBackend, peerAssignment, runIdB),
        ]);

        if (
          signal.aborted ||
          this.stopped ||
          !this.isRunStillCurrent(plan.taskId, runId, plan.contractVersion)
        ) {
          this.syncCaffeinate();
          return;
        }

        const latestCard = this.store.readTaskCard(plan.taskId);
        const workspaceMutated = await this.detectAdvisorWorkspaceMutation(latestCard, runId);
        if (workspaceMutated) {
          this.escalateAdvisorWorkspaceMutation({
            taskId: plan.taskId,
            stage,
            card: latestCard,
            runMeta,
            guard,
          });
          return;
        }

        const policyErrorMessage = resA.policyError ?? resB.policyError;
        if (policyErrorMessage && !(resA.parsed?.ok || resB.parsed?.ok)) {
          const decision = PendingDecisionSchema.parse({
            id: `dec-${randomUUID().slice(0, 8)}`,
            task_id: plan.taskId,
            run_id: runId,
            contract_version: plan.contractVersion,
            reason: "backend_policy_blocked",
            category: "backend_policy",
            question: `${policyErrorMessage}。请在设置调整角色配置后继续推进或取消任务。`,
            options: [
              {
                id: "opt-retry",
                label: "已调整配置，重新派发",
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
          this.transitionTaskToWaiting(plan.taskId, decision, guard);
          return;
        }

        const formatCandidateDoc = (res: AuxCandidateResult): string | null => {
          if (!res.parsed?.ok) {
            return res.rawReceipt;
          }
          return [
            `# 候选方案 ${res.brain} (${res.agent}/${res.model})`,
            ``,
            `- outcome: ${res.parsed.frontmatter.outcome}`,
            `- chosen_approach: ${res.parsed.frontmatter.chosen_approach}`,
            ``,
            res.parsed.body.trim(),
            ``,
          ].join("\n");
        };

        const candADoc = formatCandidateDoc(resA);
        const candBDoc = formatCandidateDoc(resB);
        if (candADoc) {
          writeFileAtomic(this.store.paths.planCandidateAMd(plan.taskId), candADoc);
        }
        if (candBDoc) {
          writeFileAtomic(this.store.paths.planCandidateBMd(plan.taskId), candBDoc);
        }

        const summarizeCandidate = (res: AuxCandidateResult): DualSynthesisCandidateSummary => ({
          brain: res.brain,
          agent: res.agent,
          model: res.model,
          outcome: res.parsed?.ok
            ? res.parsed.frontmatter.outcome === "need_decision"
              ? "need_decision"
              : "completed"
            : "failed",
          ...(res.parsed?.ok
            ? { summary: res.parsed.frontmatter.chosen_approach }
            : res.error
              ? { summary: res.error }
              : {}),
          run_id: res.brain === "A" ? runIdA : runIdB,
        });

        const candidatesSummary: DualSynthesisCandidateSummary[] = [
          summarizeCandidate(resA),
          summarizeCandidate(resB),
        ];

        const aResolved = Boolean(
          resA.parsed?.ok && resA.parsed.frontmatter.outcome === "resolved",
        );
        const bResolved = Boolean(
          resB.parsed?.ok && resB.parsed.frontmatter.outcome === "resolved",
        );
        const aNeedDec = Boolean(
          resA.parsed?.ok && resA.parsed.frontmatter.outcome === "need_decision",
        );
        const bNeedDec = Boolean(
          resB.parsed?.ok && resB.parsed.frontmatter.outcome === "need_decision",
        );

        const rewriteReceiptRunId = (rawMarkdown: string): string => {
          try {
            const parsedDoc = parseFrontmatterMarkdown(rawMarkdown);
            return serializeFrontmatterMarkdown(
              {
                ...parsedDoc.frontmatter,
                run_id: runId,
                contract_version: plan.contractVersion,
              },
              parsedDoc.body,
            );
          } catch {
            return rawMarkdown;
          }
        };

        const dispatchFinalizer = async (): Promise<void> => {
          if (stage === "plan") {
            await this.finalizePlanRun(plan.taskId, runDirName, runMeta);
          } else {
            await this.finalizeAdvisorRun(plan.taskId, runDirName, runMeta);
          }
        };

        const enterDualNeedDecision = (
          summaryList: DualSynthesisCandidateSummary[],
          headline: string,
        ): void => {
          const guardA = resA.parsed?.ok
            ? evaluateAdvisorAuthorityGuard(resA.parsed.frontmatter)
            : { allowed: true as const };
          const guardB = resB.parsed?.ok
            ? evaluateAdvisorAuthorityGuard(resB.parsed.frontmatter)
            : { allowed: true as const };
          const guardNotes = [
            ...(!guardA.allowed ? [`- ⚠️ Brain A 护栏提示：${guardA.detail}`] : []),
            ...(!guardB.allowed ? [`- ⚠️ Brain B 护栏提示：${guardB.detail}`] : []),
          ];
          const effectiveHeadline =
            guardNotes.length > 0 ? `${headline}\n${guardNotes.join("\n")}` : headline;
          writeYamlAtomic(
            this.store.paths.dualSynthesisYaml(plan.taskId),
            DualSynthesisRecordSchema.parse({
              schema_version: 1,
              stage,
              run_id: runId,
              contract_version: plan.contractVersion,
              status: "awaiting_decision",
              reused_brain_a_session: false,
              created_at: new Date().toISOString(),
              candidates: summaryList,
              note: "双脑阶段提出需人类拍板分歧，等待人工择优或重审",
            }),
            DualSynthesisRecordSchema,
          );
          const pending = PendingDecisionSchema.parse({
            id: `dec-${randomUUID().slice(0, 8)}`,
            task_id: plan.taskId,
            run_id: runId,
            contract_version: plan.contractVersion,
            reason: "dual_synthesis_need_decision",
            category: "design_tradeoff",
            question: effectiveHeadline,
            options: [
              ...(resA.parsed?.ok
                ? [
                    {
                      id: "opt-adopt-brain-a",
                      label: `采纳 Brain A 方案 (${primaryAssignment.agent}/${primaryAssignment.model}) 并继续实施`,
                      action: "resume" as const,
                      target_stage: "implement" as const,
                      recommended: !aNeedDec && guardA.allowed,
                    },
                  ]
                : []),
              ...(resB.parsed?.ok
                ? [
                    {
                      id: "opt-adopt-brain-b",
                      label: `采纳 Brain B 方案 (${peerAssignment.agent}/${peerAssignment.model}) 并继续实施`,
                      action: "resume" as const,
                      target_stage: "implement" as const,
                      recommended: aNeedDec && !bNeedDec && guardB.allowed,
                    },
                  ]
                : []),
              {
                id: `opt-retry-${stage}`,
                label: `补充要求后重新执行${stage === "plan" ? "方案" : "顾问"}阶段`,
                action: "resume" as const,
                target_stage: stage,
                recommended: false,
              },
              {
                id: "opt-cancel",
                label: "取消任务",
                action: "cancel" as const,
                recommended: false,
              },
            ],
            created_at: new Date().toISOString(),
          });
          if (stage === "advise") {
            this.clearAdvisorRequest(plan.taskId);
          }
          this.transitionTaskToWaiting(plan.taskId, pending, guard);
        };

        if (aNeedDec || bNeedDec) {
          enterDualNeedDecision(
            candidatesSummary,
            `双脑博弈${stage === "plan" ? "方案" : "顾问"}阶段出现待决分歧（A: ${resA.parsed?.ok ? resA.parsed.frontmatter.chosen_approach : "失败"}；B: ${resB.parsed?.ok ? resB.parsed.frontmatter.chosen_approach : "失败"}），请直接拍板采纳候选方案 A / B 或重试：`,
          );
          return;
        }

        if (aResolved && bResolved && resA.parsed?.ok && resB.parsed?.ok) {
          const synthReceiptPath = path.join(
            this.store.paths.runDir(plan.taskId, runDirName),
            "RECEIPT_SYNTH.md",
          );
          if (!resA.caps.mcpInjection) {
            fs.rmSync(synthReceiptPath, { force: true });
          }

          const synthesisPrompt = [
            `### E2 双脑博弈合成指令（请基于 Brain A 与 Brain B 的独立草案合成终版方案）`,
            `- 请对比 Brain A（你自身上一轮方案）与异构 Brain B（${peerAssignment.agent}/${peerAssignment.model}）方案的优缺点，取长补短收敛为唯一可执行方案。`,
            `- 回执正文开头**必须保留** 3 行以内 \`> **双脑博弈合成摘要**\` 引用块说明采纳与权衡要点。`,
            ...(resA.caps.mcpInjection
              ? [
                  `- 请调用 \`wb_submit_receipt\` 提交 \`advisor\` 回执，务必将 \`run_id\` 设为 \`${runIdA}\`、\`contract_version\` 设为 \`${plan.contractVersion}\`、\`outcome\` 设为 \`resolved\`。`,
                ]
              : [
                  `- 请将合成后的 \`advisor\` 回执写入 \`${synthReceiptPath}\`，并将 \`run_id\` 设为 \`${runIdA}\`、\`contract_version\` 设为 \`${plan.contractVersion}\`、\`outcome\` 设为 \`resolved\`。`,
                ]),
            ``,
            `#### Brain B 候选方案 (${peerAssignment.agent}/${peerAssignment.model})`,
            `- chosen_approach: ${resB.parsed.frontmatter.chosen_approach}`,
            resB.parsed.body.trim(),
          ].join("\n");

          const auxEntryA = this.activeAuxiliaryReceipts.get(runIdA);
          if (auxEntryA) {
            auxEntryA.rawMarkdown = undefined;
          }

          let reusedBrainASession = false;
          let synthRaw: string | null = null;

          if (resA.sessionRef) {
            try {
              await backendA.send(resA.sessionRef, synthesisPrompt);
              reusedBrainASession = true;
              await consumeTurnEvents("S", backendA, resA.sessionRef, primaryAssignment, "synth");
              synthRaw = this.activeAuxiliaryReceipts.get(runIdA)?.rawMarkdown ?? null;
              if (!synthRaw && !resA.caps.mcpInjection) {
                synthRaw = readOptionalText(synthReceiptPath);
              }
            } catch {
              reusedBrainASession = false;
              synthRaw = null;
            }
          }

          if (
            signal.aborted ||
            this.stopped ||
            !this.isRunStillCurrent(plan.taskId, runId, plan.contractVersion)
          ) {
            this.syncCaffeinate();
            return;
          }

          const postSynthMutated = await this.detectAdvisorWorkspaceMutation(
            this.store.readTaskCard(plan.taskId),
            runId,
          );
          if (postSynthMutated) {
            this.escalateAdvisorWorkspaceMutation({
              taskId: plan.taskId,
              stage,
              card: this.store.readTaskCard(plan.taskId),
              runMeta,
              guard,
            });
            return;
          }

          const synthParsedCheck = synthRaw ? parseAndValidateReceipt("advisor", synthRaw) : null;
          if (synthParsedCheck?.ok && synthParsedCheck.frontmatter.outcome === "need_decision") {
            if (synthRaw) {
              writeFileAtomic(this.store.paths.planCandidateAMd(plan.taskId), synthRaw);
            }
            enterDualNeedDecision(
              candidatesSummary,
              `双脑合成阶段提出需人类拍板事项（${synthParsedCheck.frontmatter.chosen_approach}），请直接拍板或重试：`,
            );
            return;
          }

          let resolvedSynthRaw: string;
          if (synthParsedCheck?.ok && synthRaw) {
            resolvedSynthRaw = synthRaw;
          } else {
            // Deterministic synthesis fallback preserving Candidate A + B merits and 3-line summary
            const fallbackHeader = [
              `> **双脑博弈合成摘要**：综合 Brain A (${primaryAssignment.agent}/${primaryAssignment.model})「${resA.parsed.frontmatter.chosen_approach}」与 Brain B (${peerAssignment.agent}/${peerAssignment.model})「${resB.parsed.frontmatter.chosen_approach}」，取双方边界与验证重点收敛为唯一终版。`,
              `> - 采纳要点 A：${resA.parsed.frontmatter.chosen_approach}`,
              `> - 补充边界 B：${resB.parsed.frontmatter.chosen_approach}`,
            ].join("\n");
            resolvedSynthRaw = serializeFrontmatterMarkdown(
              {
                run_id: runId,
                contract_version: plan.contractVersion,
                outcome: "resolved",
                chosen_approach: `${resA.parsed.frontmatter.chosen_approach}（融合 ${peerAssignment.model} 审视要点）`,
                ...(resA.parsed.frontmatter.decision_kind !== undefined
                  ? { decision_kind: resA.parsed.frontmatter.decision_kind }
                  : {}),
                ...(resA.parsed.frontmatter.workflow_patch !== undefined
                  ? { workflow_patch: resA.parsed.frontmatter.workflow_patch }
                  : {}),
                ...(resA.parsed.frontmatter.spawn_subtasks !== undefined
                  ? { spawn_subtasks: resA.parsed.frontmatter.spawn_subtasks }
                  : {}),
              },
              `${fallbackHeader}\n\n${resA.parsed.body.trim()}\n\n### Brain B 补充审视与对照\n${resB.parsed.body.trim()}`,
            );
          }

          let finalMarkdown = rewriteReceiptRunId(resolvedSynthRaw);
          const finalParsed = parseAndValidateReceipt("advisor", finalMarkdown);
          if (finalParsed.ok && !finalParsed.body.includes("双脑博弈合成摘要")) {
            const synthHeader = [
              `> **双脑博弈合成摘要**：融合 Brain A (${primaryAssignment.model}) 与 Brain B (${peerAssignment.model}) 方案优势收敛成终版。`,
              `> - Brain A: ${resA.parsed.frontmatter.chosen_approach}`,
              `> - Brain B: ${resB.parsed.frontmatter.chosen_approach}`,
            ].join("\n");
            finalMarkdown = serializeFrontmatterMarkdown(
              finalParsed.frontmatter,
              `${synthHeader}\n\n${finalParsed.body.trim()}`,
            );
          }

          this.store.submitReceipt({
            taskId: plan.taskId,
            runId,
            contractVersion: plan.contractVersion,
            runDirName,
            markdown: finalMarkdown,
          });
          writeYamlAtomic(
            this.store.paths.dualSynthesisYaml(plan.taskId),
            DualSynthesisRecordSchema.parse({
              schema_version: 1,
              stage,
              run_id: runId,
              contract_version: plan.contractVersion,
              status: "synthesized",
              reused_brain_a_session: reusedBrainASession,
              created_at: new Date().toISOString(),
              candidates: candidatesSummary,
            }),
            DualSynthesisRecordSchema,
          );
          await dispatchFinalizer();
          return;
        }

        if (aResolved || bResolved) {
          const survivor = aResolved ? resA : resB;
          const rewritten = rewriteReceiptRunId(survivor.rawReceipt!);
          this.store.submitReceipt({
            taskId: plan.taskId,
            runId,
            contractVersion: plan.contractVersion,
            runDirName,
            markdown: rewritten,
          });
          writeYamlAtomic(
            this.store.paths.dualSynthesisYaml(plan.taskId),
            DualSynthesisRecordSchema.parse({
              schema_version: 1,
              stage,
              run_id: runId,
              contract_version: plan.contractVersion,
              status: "adopted_single",
              reused_brain_a_session: false,
              created_at: new Date().toISOString(),
              candidates: candidatesSummary,
              note: `另一侧失败或未提交有效回执，自动采纳 Brain ${survivor.brain} (${survivor.agent}/${survivor.model}) 方案`,
            }),
            DualSynthesisRecordSchema,
          );
          await dispatchFinalizer();
          return;
        }

        if (rateLimitHits.length > 0) {
          const rateNow = new Date().toISOString();
          writeFileAtomic(
            path.join(this.store.paths.runDir(plan.taskId, runDirName), "RATE_LIMITED"),
            `${rateNow}\n`,
          );
          this.store.sqlite.expireActiveLeaseByTask(plan.taskId, rateNow, "expired");
          if (!this.isRunStillCurrent(plan.taskId, runId, plan.contractVersion)) {
            this.syncCaffeinate();
            return;
          }
          this.store.appendStateEvent(plan.taskId, {
            type: "queued",
            at: rateNow,
          });
          this.syncCaffeinate();
          this.publishTaskUpdated(plan.taskId, { status: "queued", stage });
          void this.wake();
          return;
        }

        writeYamlAtomic(
          this.store.paths.dualSynthesisYaml(plan.taskId),
          DualSynthesisRecordSchema.parse({
            schema_version: 1,
            stage,
            run_id: runId,
            contract_version: plan.contractVersion,
            status: "failed",
            reused_brain_a_session: false,
            created_at: new Date().toISOString(),
            candidates: candidatesSummary,
            note: "Brain A 与 Brain B 均未产出有效回执",
          }),
          DualSynthesisRecordSchema,
        );
        await dispatchFinalizer();
      } finally {
        this.activeAuxiliaryReceipts.delete(runIdA);
        this.activeAuxiliaryReceipts.delete(runIdB);
        for (const { backend, sessionRef } of registeredSessions) {
          this.auxiliaryActiveHandles.delete(`${backend.backendId}:${sessionRef.sessionId}`);
          await backend.cancel(sessionRef).catch(() => {});
        }
        if (this.inFlightOperations.get(plan.taskId)?.runId === runId) {
          this.inFlightOperations.delete(plan.taskId);
        }
      }
    })();

    this.inFlightOperations.set(plan.taskId, {
      runId,
      abortController: opAbortController,
      promise: runPromise,
    });
    return true;
  }

  private async handleBackendStartError(
    plan: DispatchPlan,
    runDirName: string,
    runMeta: RunMeta,
    err: unknown,
  ): Promise<void> {
    if (!this.isRunStillCurrent(plan.taskId, runMeta.run_id, plan.contractVersion, true)) {
      const existingLease = this.store.getStageLease(plan.taskId);
      const latestCard = readYamlOptional(this.store.paths.cardYaml(plan.taskId), TaskCardSchema);
      if (
        this.isRunStillCurrent(plan.taskId, runMeta.run_id, plan.contractVersion, false) &&
        latestCard?.contract_version === plan.contractVersion &&
        existingLease?.state === "completed" &&
        existingLease.run_id === runMeta.run_id &&
        existingLease.contract_version === plan.contractVersion &&
        fs.existsSync(this.store.paths.receiptMd(plan.taskId, runDirName))
      ) {
        await this.runTrackedStageOperation(plan.taskId, runMeta.run_id, async (signal) => {
          try {
            await this.finalizeActiveRun(plan.taskId, runDirName, runMeta, null, signal);
          } catch (finalizeErr) {
            if (
              !signal.aborted &&
              this.isRunStillCurrent(plan.taskId, runMeta.run_id, plan.contractVersion)
            ) {
              await this.applyStageFailure(
                plan.taskId,
                plan.stage,
                runMeta,
                {
                  kind: "runtime_error",
                  message: finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr),
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
        });
        return;
      }

      if (existingLease?.state === "active" && existingLease.run_id === runMeta.run_id) {
        this.store.sqlite.expireActiveLeaseByTask(plan.taskId, new Date().toISOString(), "expired");
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

    if (err instanceof FullAccessOnlyProviderError || err instanceof IneligibleRoleAgentError) {
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

  private buildInRunReceiptNudgePrompt(params: {
    taskId: string;
    runDirName: string;
    runMeta: RunMeta;
    reason: string;
    mcpEnabled: boolean;
    attempt: number;
    maxAttempts: number;
  }): string {
    const { taskId, runDirName, runMeta, reason, mcpEnabled, attempt, maxAttempts } = params;
    const receiptPath = this.store.paths.receiptMd(taskId, runDirName);
    const submitAction = mcpEnabled
      ? `调用 \`wb_submit_receipt\` 提交合法回执（如确有阻塞请调用 \`wb_ask_decision\`）`
      : `将合法回执写入 \`${receiptPath}\``;
    return [
      `### 单步单会话闭环提醒（第 ${attempt}/${maxAttempts} 次）`,
      `你本轮虽然结束了输出，但当前阶段 \`${runMeta.stage}\` 尚未收到可结案的回执：${reason}`,
      `请**就在当前会话内**直接补齐并${submitAction}（不要忽略该要求或重述计划）：`,
      `- \`run_id\`: \`${runMeta.run_id}\``,
      `- \`contract_version\`: \`${runMeta.contract_version}\``,
    ].join("\n");
  }

  private attachSessionConsumer(
    taskId: string,
    runDirName: string,
    runMeta: RunMeta,
    backend: ExecutionBackend,
    sessionRef: SessionRef,
  ): void {
    const abortController = new AbortController();
    const startedAtMs = this.nowMs();
    const handle: ActiveRunHandle = {
      taskId,
      runId: runMeta.run_id,
      runDirName,
      role: runMeta.role,
      stage: runMeta.stage,
      contractVersion: runMeta.contract_version,
      runMeta,
      backend,
      sessionRef,
      abortController,
      consumePromise: Promise.resolve(),
      cancelledByControl: false,
      startedAtMs,
      lastEventAtMs: startedAtMs,
      stallWarnedAtMs: null,
      stallRecovering: false,
    };

    handle.consumePromise = (async () => {
      let exitEvent: Extract<RunEvent, { kind: "exit" }> | null = null;
      let continuationCount = 0;

      try {
        try {
          while (true) {
            if (
              this.stopped ||
              handle.cancelledByControl ||
              abortController.signal.aborted ||
              handle.stallRecovering
            ) {
              break;
            }
            exitEvent = null;
            for await (const ev of backend.events(handle.sessionRef)) {
              if (handle.stallRecovering) {
                break;
              }
              handle.lastEventAtMs = this.nowMs();
              handle.stallWarnedAtMs = null;

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
                handle.runMeta = nextMeta;
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
              } else if (ev.kind === "thinking" && ev.chars && ev.chars > 0) {
                this.rateTracker.recordCharDelta({ taskId, chars: ev.chars });
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

            if (
              this.stopped ||
              handle.cancelledByControl ||
              abortController.signal.aborted ||
              handle.stallRecovering ||
              exitEvent?.reason !== "completed" ||
              continuationCount >= MAX_IN_RUN_RECEIPT_CONTINUATIONS
            ) {
              break;
            }

            const latestCard = readYamlOptional(this.store.paths.cardYaml(taskId), TaskCardSchema);
            const latestDerived = latestCard
              ? deriveTaskStatus(latestCard, this.store.readStateEvents(taskId))
              : null;
            if (
              !latestCard ||
              !latestDerived ||
              latestDerived.status !== "running" ||
              latestDerived.activeRunId !== runMeta.run_id ||
              latestCard.contract_version !== runMeta.contract_version
            ) {
              break;
            }

            const caps =
              this.agentCapabilitiesMap.get(runMeta.agent) ??
              (await backend.capabilities(runMeta.agent).catch(() => undefined));
            const lastContextPct = this.latestContextPercentByRunId.get(runMeta.run_id) ?? 0;
            if (caps?.warmSessionReuse !== true || lastContextPct >= WARM_CONTEXT_PERCENT_LIMIT) {
              break;
            }

            const rawReceipt = readOptionalText(this.store.paths.receiptMd(taskId, runDirName));
            const receiptKind = resolveReceiptKindForRole(runMeta.role);
            let nudgeReason: string | null = null;
            if (rawReceipt === null) {
              nudgeReason = "尚未收到当前阶段的有效回执（RECEIPT.md 缺失）。";
            } else if (caps.mcpInjection !== true && receiptKind !== null) {
              const parsed = parseAndValidateReceipt(receiptKind, rawReceipt);
              if (!parsed.ok) {
                nudgeReason = `回执格式校验未通过：${parsed.errors.join("; ")}`;
              } else if (
                parsed.frontmatter.run_id !== runMeta.run_id ||
                parsed.frontmatter.contract_version !== runMeta.contract_version
              ) {
                nudgeReason = `回执 frontmatter 中的 run_id (${parsed.frontmatter.run_id}) 或 contract_version (${parsed.frontmatter.contract_version}) 与当前运行 (${runMeta.run_id}, v${runMeta.contract_version}) 不匹配。`;
              }
            }

            if (nudgeReason === null) {
              break;
            }

            const nudgePrompt = this.buildInRunReceiptNudgePrompt({
              taskId,
              runDirName,
              runMeta,
              reason: nudgeReason,
              mcpEnabled: caps.mcpInjection === true,
              attempt: continuationCount + 1,
              maxAttempts: MAX_IN_RUN_RECEIPT_CONTINUATIONS,
            });
            if (
              this.stopped ||
              handle.cancelledByControl ||
              abortController.signal.aborted ||
              handle.stallRecovering
            ) {
              break;
            }
            try {
              handle.lastEventAtMs = this.nowMs();
              await backend.send(handle.sessionRef, nudgePrompt);
              if (
                this.stopped ||
                handle.cancelledByControl ||
                abortController.signal.aborted ||
                handle.stallRecovering
              ) {
                await backend.cancel(handle.sessionRef).catch(() => {});
                break;
              }
              continuationCount += 1;
            } catch {
              break;
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

        if (this.stopped || handle.cancelledByControl || abortController.signal.aborted) {
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
            this.store.sqlite.expireActiveLeaseByTask(taskId, new Date().toISOString(), "expired");
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
    const warmStepMeta = this.warmStepMetaByRunId.get(runMeta.run_id);
    const lastContextPercent = this.latestContextPercentByRunId.get(runMeta.run_id) ?? null;
    this.sessionKeyByRunId.delete(runMeta.run_id);
    this.reuseCountByRunId.delete(runMeta.run_id);
    this.warmStepMetaByRunId.delete(runMeta.run_id);
    this.latestContextPercentByRunId.delete(runMeta.run_id);

    const latestRunMeta =
      readYamlOptional(this.store.paths.runYaml(taskId, runDirName), RunMetaSchema) ?? runMeta;
    const backendForRun = this.backendRegistry.get(latestRunMeta.backend_id);
    const capsForRun =
      this.agentCapabilitiesMap.get(latestRunMeta.agent) ??
      (backendForRun
        ? await backendForRun.capabilities(latestRunMeta.agent).catch(() => undefined)
        : undefined);
    let parkedInWarmPool = false;

    if (
      runMeta.stage === "implement" &&
      runMeta.role === "worker" &&
      exitEvent?.reason === "completed" &&
      sessionKey !== undefined
    ) {
      const cwd =
        latestRunMeta.cwd ??
        (card.workspace_mode === "git_worktree"
          ? this.getGitWorktreeDir(taskId)
          : this.store.paths.workspaceDir(taskId));
      if (
        backendForRun &&
        capsForRun?.warmSessionReuse === true &&
        reuseCount < WARM_MAX_CONSECUTIVE_REUSES &&
        (lastContextPercent === null || lastContextPercent < WARM_CONTEXT_PERCENT_LIMIT)
      ) {
        this.warmPool.park(
          {
            taskId,
            sessionRef: latestRunMeta.session_ref,
            sessionKey,
            backend: backendForRun,
            backendId: latestRunMeta.backend_id,
            agent: latestRunMeta.agent,
            model: latestRunMeta.model,
            cwd,
            rosterRoleId: latestRunMeta.roster_role,
            contractVersion: latestRunMeta.contract_version,
            stepIndex: warmStepMeta?.stepIndex ?? latestRunMeta.step_index ?? null,
            stepLabel: warmStepMeta?.stepLabel,
            customInstructions: warmStepMeta?.customInstructions,
            lastRunId: latestRunMeta.run_id,
            reuseCount,
            lastContextPercent,
            lastUsedAtMs: Date.now(),
          },
          this.getWarmCacheTtlMs(),
        );
        parkedInWarmPool = true;
      }
    }

    try {
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
    } finally {
      if (!parkedInWarmPool && capsForRun?.warmSessionReuse === true && backendForRun) {
        await backendForRun.cancel(latestRunMeta.session_ref).catch(() => {});
      }
    }
  }

  private ensureLeaseCommittedForDiskReceipt(taskId: string, runMeta: RunMeta): boolean {
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
    writeYamlAtomic(this.store.paths.advisorRequestYaml(taskId), parsed, AdvisorRequestSchema);
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

  private async detectAdvisorWorkspaceMutation(card: TaskCard, runId: string): Promise<boolean> {
    const preSig = this.advisorPreRunDirtySignatures.get(runId);
    this.advisorPreRunDirtySignatures.delete(runId);
    if (preSig === undefined || card.workspace_mode !== "git_worktree") {
      return false;
    }
    const postSig = await this.computeWorktreeDirtySignature(this.getGitWorktreeDir(card.id));
    return postSig !== preSig;
  }

  private listCurrentWindowRuns(
    taskId: string,
    card: TaskCard,
  ): Array<ScannedRunDir & { meta: RunMeta }> {
    const events = this.store.readStateEvents(taskId);
    let lastResetIso = card.created_at;
    for (const ev of events) {
      if (ev.type === "contract_updated" || (ev.type === "decided" && ev.action === "resume")) {
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

  private getLatestWorkflowResetIso(taskId: string, card: TaskCard): string {
    let resetIso = card.created_at;
    for (const ev of this.store.readStateEvents(taskId)) {
      if (
        (ev.type === "contract_updated" ||
          ((ev.type === "workflow_patched" || ev.type === "subtasks_spawned") &&
            ev.contract_version === card.contract_version) ||
          (ev.type === "decided" && ev.action === "resume")) &&
        ev.at > resetIso
      ) {
        resetIso = ev.at;
      }
    }
    return resetIso;
  }

  private listCurrentSegmentRuns(
    taskId: string,
    card: TaskCard,
  ): Array<ScannedRunDir & { meta: RunMeta }> {
    const resetIso = this.getLatestWorkflowResetIso(taskId, card);
    return this.listCurrentWindowRuns(taskId, card).filter((r) => r.meta.started_at >= resetIso);
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
    const { counters } = this.computeStageCounters(taskId, card, currentStage, currentRunId);
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
    const runs = this.listCurrentSegmentRuns(taskId, card);
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
    const runs = this.listCurrentSegmentRuns(taskId, card);
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
        const prevFp = computeReviewerFailureFingerprint(parsed.frontmatter, parsed.body);
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
    const card = readYamlOptional(this.store.paths.cardYaml(input.taskId), TaskCardSchema);
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
    const windowRuns = this.listCurrentWindowRuns(taskId, card);
    const segmentRuns = this.listCurrentSegmentRuns(taskId, card);

    let advisorCalls = 0;
    for (const r of windowRuns) {
      if (r.meta.stage === "advise") {
        advisorCalls += 1;
      }
    }

    let reviewRounds = 0;
    let inReviewCycle = false;
    for (const r of segmentRuns) {
      if (r.meta.stage === "implement") {
        inReviewCycle = false;
      } else if (r.meta.stage === "review" && r.meta.run_id !== currentRunId && r.hasReceipt) {
        if (!inReviewCycle) {
          reviewRounds += 1;
          inReviewCycle = true;
        }
      }
    }

    const currentIdx = segmentRuns.findIndex((r) => r.meta.run_id === currentRunId);
    const slice = currentIdx >= 0 ? segmentRuns.slice(0, currentIdx + 1) : segmentRuns;
    const currentStepIndex = currentIdx >= 0 ? segmentRuns[currentIdx]!.meta.step_index : undefined;

    let sameStageStreak = 0;
    for (let i = slice.length - 1; i >= 0; i--) {
      const item = slice[i]!;
      const sameStep =
        currentStepIndex === undefined ||
        item.meta.step_index === undefined ||
        item.meta.step_index === currentStepIndex;
      if (item.meta.stage === currentStage && sameStep) {
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

    const taskTotals = this.store.getTaskTotalTokens(taskId);
    // Exclude cache-read input tokens from the circuit-breaker budget so repeated multi-turn
    // prompt-cache hits do not falsely trip max_tokens_exceeded.
    const totalTokens =
      Math.max(0, taskTotals.input_tokens - taskTotals.cached_input_tokens) +
      taskTotals.output_tokens;
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

  private findActiveSubtaskBaseRefSha(
    taskId: string,
    contractVersion: number,
  ): { sha: string; at: string } | null {
    const events = this.store.readStateEvents(taskId);
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (
        ev.type === "subtasks_spawned" &&
        ev.contract_version === contractVersion &&
        ev.base_ref_sha
      ) {
        return { sha: ev.base_ref_sha, at: ev.at };
      }
    }
    return null;
  }

  private async collectTaskChangedPathsForFastForward(card: TaskCard): Promise<string[] | null> {
    if (card.workspace_mode === "git_worktree") {
      const worktreePath = this.getGitWorktreeDir(card.id);
      if (!fs.existsSync(worktreePath)) {
        return null;
      }
      const runs = this.listTaskRunDirs(card.id);
      const firstImpl = runs.find((r) => r.meta?.stage === "implement" && r.meta.input_ref);
      const subtaskBase = this.findActiveSubtaskBaseRefSha(card.id, card.contract_version);
      let baseRef =
        subtaskBase !== null && (!firstImpl || subtaskBase.at <= firstImpl.meta!.started_at)
          ? subtaskBase.sha
          : firstImpl?.meta?.input_ref;
      if (!baseRef) {
        baseRef = this.store.readSpace(card.space)?.default_branch ?? "main";
      }
      try {
        const changes = await inspectGitWorktreeChanges(worktreePath, baseRef);
        return changes.changedPaths;
      } catch {
        return null;
      }
    }
    return null;
  }

  private async tryApplyDeterministicFastForward(params: {
    taskId: string;
    card: TaskCard;
    fromStage: "verify" | "review";
    candidateStep: { stage: StageId; stepIndex: number; node: { kind: string } };
    gateReport: GateReport;
    guard: ExpectedRunGuard;
  }): Promise<boolean> {
    const { taskId, card, fromStage, candidateStep, gateReport, guard } = params;
    if (this.stopped || !this.isRunStillCurrent(taskId, guard.runId, guard.contractVersion)) {
      this.syncCaffeinate();
      return true;
    }

    const flatSteps = getWorkflowFlatSteps(card, card.track);
    const deliverIdx = flatSteps.findIndex((n) => n.stage === "deliver");
    if (deliverIdx <= candidateStep.stepIndex) {
      return false;
    }
    const skippedSlice = flatSteps.slice(candidateStep.stepIndex, deliverIdx);
    if (skippedSlice.length === 0 || skippedSlice.some((n) => n.kind !== "agent")) {
      return false;
    }

    const changedPaths = await this.collectTaskChangedPathsForFastForward(card);
    if (changedPaths === null || changedPaths.length === 0) {
      return false;
    }

    const ff = evaluateDeterministicFastForward({
      changedPaths,
      gatePassed:
        gateReport.accept_exit_code === 0 && gateReport.scope_ok && gateReport.artifacts_ok,
      frozenFilesChanged: gateReport.frozen_files_changed,
      humanAccept: card.contract.human_accept,
      workspaceMode: card.workspace_mode,
    });
    if (!ff.fastForward) {
      return false;
    }

    const canSkipAll =
      ff.reason === "docs_only"
        ? skippedSlice.every((n) => n.stage === "review" || n.stage === "accept")
        : skippedSlice.every((n) => n.stage === "accept");

    const shouldSkip =
      canSkipAll &&
      (fromStage === "verify"
        ? (ff.reason === "docs_only" &&
            (candidateStep.stage === "review" || candidateStep.stage === "accept")) ||
          (ff.reason === "tests_only" &&
            candidateStep.stage === "accept" &&
            candidateStep.node.kind === "agent")
        : candidateStep.stage === "accept" && candidateStep.node.kind === "agent");

    if (!shouldSkip) {
      return false;
    }

    this.warmPool.evictTask(taskId);
    const nextState = this.store.appendStateEvent(taskId, {
      type: "stage_fast_forwarded",
      at: new Date().toISOString(),
      contract_version: card.contract_version,
      skipped_stage: candidateStep.stage,
      skipped_step_index: candidateStep.stepIndex,
      to_stage: "deliver",
      to_step_index: deliverIdx,
      reason: ff.reason,
      changed_paths: changedPaths,
    });
    this.syncCaffeinate();
    this.publishTaskUpdated(taskId, {
      status: nextState.status,
      stage: "deliver",
      contractVersion: nextState.contractVersion,
    });
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
      await this.advanceToNextStage(taskId, stage, guard, runMeta.step_index ?? null);
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

    if (signal?.aborted || !this.isRunStillCurrent(taskId, activeRunId, runMeta.contract_version)) {
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

    const resolvedCurrentStep =
      effectiveStage === "implement"
        ? resolveWorkflowStepAt(card, runMeta.step_index ?? null, effectiveStage, card.track)
        : null;
    if (
      resolvedCurrentStep?.node.kind === "agent" &&
      resolvedCurrentStep.node.stage === "implement" &&
      resolvedCurrentStep.node.mode === "test_first_lock" &&
      parsedReceipt.ok &&
      parsedReceipt.frontmatter.outcome === "completed" &&
      parsedReceipt.frontmatter.run_id === runMeta.run_id &&
      parsedReceipt.frontmatter.contract_version === card.contract_version
    ) {
      await this.verifyAndLockRedTests({
        taskId,
        card,
        runDirName,
        runMeta,
        worktreePath,
        baselineSnapshot,
        guard,
        activeRunId,
        ...(signal !== undefined ? { signal } : {}),
      });
      return;
    }

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
        const dirtyPaths =
          statusRaw.length > 0 ? parseGitPorcelainStatusZ(statusRaw).dirtyPaths : [];
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
      } else if (parsedReceipt.frontmatter.complexity_escalate && card.track === "L1") {
        const escalatedState = this.stateMachine.escalateTrackToL2(taskId, "complexity_escalate");
        this.publishTaskUpdated(taskId, {
          contractVersion: escalatedState.contractVersion,
        });
      }

      await this.advanceToNextStage(taskId, preNextStep.stage, guard, preNextStep.stepIndex);
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

    const subtaskBase = this.findActiveSubtaskBaseRefSha(taskId, card.contract_version);
    const effectiveGateInputRef =
      subtaskBase !== null &&
      (!runMeta.input_ref ||
        subtaskBase.at <=
          (this.listTaskRunDirs(taskId).find((r) => r.meta?.stage === "implement")?.meta
            ?.started_at ?? runMeta.started_at))
        ? subtaskBase.sha
        : runMeta.input_ref;

    const gateResult = await runVerificationGate(this.store, {
      taskId,
      runDirName,
      gateCheckMode: getVerifyGateCheckMode(card),
      ...(worktreePath !== undefined ? { worktreePath } : {}),
      ...(effectiveGateInputRef !== undefined ? { inputRef: effectiveGateInputRef } : {}),
      ...(baselineSnapshot !== undefined ? { baselineSnapshot } : {}),
      ...(explicitHostChangedPaths !== undefined
        ? { hostChangedPaths: explicitHostChangedPaths }
        : {}),
      ...(scratchExpectedArtifacts !== undefined
        ? { expectedArtifacts: scratchExpectedArtifacts }
        : {}),
      ...(signal !== undefined ? { signal } : {}),
    });

    if (signal?.aborted || !this.isRunStillCurrent(taskId, activeRunId, card.contract_version)) {
      this.syncCaffeinate();
      return;
    }

    if (effectiveStage === "implement") {
      const activeTestsLock = this.getActiveContractTestsLock(taskId, card.contract_version);
      if (
        activeTestsLock &&
        gateResult.report.frozen_files_changed.some((p) => activeTestsLock.test_files.includes(p))
      ) {
        if (worktreePath && fs.existsSync(worktreePath) && activeTestsLock.test_files.length > 0) {
          await runGitCommand([
            "-c",
            "core.autocrlf=false",
            "-C",
            worktreePath,
            "checkout",
            "HEAD",
            "--",
            ...activeTestsLock.test_files,
          ]).catch(() => {});
        }
        gateResult.report = GateReportSchema.parse({
          ...gateResult.report,
          artifacts_ok: false,
        });
        gateResult.passed = false;
        writeYamlAtomic(
          this.store.paths.gateYaml(taskId, runDirName),
          gateResult.report,
          GateReportSchema,
        );
      }
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
      await this.commitVerifiedWorktreeChanges(latestCard, worktreePath, runMeta.round);
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
      if (effectiveStage === "implement") {
        await this.refreshTaskContextMap(latestCard, worktreePath, effectiveGateInputRef);
      }
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
        if (
          afterVerify !== null &&
          (afterVerify.stage === "review" || afterVerify.stage === "accept")
        ) {
          const fastForwarded = await this.tryApplyDeterministicFastForward({
            taskId,
            card: latestCard,
            fromStage: "verify",
            candidateStep: afterVerify,
            gateReport: gateResult.report,
            guard,
          });
          if (fastForwarded) {
            return;
          }
        }
        await this.advanceToNextStage(
          taskId,
          afterVerify?.stage ?? "deliver",
          guard,
          afterVerify?.stepIndex ?? null,
        );
        return;
      }
      if (
        effectiveStage === "verify" &&
        postNext !== null &&
        (postNext.stage === "review" || postNext.stage === "accept")
      ) {
        const fastForwarded = await this.tryApplyDeterministicFastForward({
          taskId,
          card: latestCard,
          fromStage: "verify",
          candidateStep: postNext,
          gateReport: gateResult.report,
          guard,
        });
        if (fastForwarded) {
          return;
        }
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
      const failureFp = computeGateFailureFingerprint(gateResult.report) ?? stageDecision.reason;
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
      const retryStepIndex =
        stageDecision.stage === "implement"
          ? this.resolveImplementReworkStepIndex(
              taskId,
              latestCard,
              runMeta.step_index ?? null,
              stageDecision.effectiveTrack,
            )
          : (runMeta.step_index ?? null);
      await this.advanceToNextStage(taskId, stageDecision.stage, guard, retryStepIndex);
      return;
    }

    if (stageDecision.action === "invoke_triage") {
      const roles = this.store.readConfig("roles");
      if (roles?.roles.triage) {
        await this.advanceToNextStage(taskId, "triage", guard);
        return;
      }
    }

    const gatePassedTokenCap =
      stageDecision.gatePassed && stageDecision.reason === "max_tokens_exceeded";
    const afterCurrentStep = nextWorkflowStepAfter(
      latestCard,
      runMeta.step_index ?? null,
      effectiveStage,
      stageDecision.effectiveTrack,
    );
    const afterVerifyStep =
      afterCurrentStep?.stage === "verify"
        ? nextWorkflowStepAfter(
            latestCard,
            afterCurrentStep.stepIndex,
            "verify",
            stageDecision.effectiveTrack,
          )
        : afterCurrentStep;
    const fallbackTargetStage =
      afterVerifyStep?.stage ??
      nextTaskStageAfter(latestCard, "verify", stageDecision.effectiveTrack);
    const proceedTargetStage: StageId = hasReviewInPipeline
      ? "review"
      : fallbackTargetStage &&
          fallbackTargetStage !== "implement" &&
          fallbackTargetStage !== "verify"
        ? fallbackTargetStage
        : "deliver";

    const gateDecisionQuestion = gatePassedTokenCap
      ? `任务 "${latestCard.title}" 实施与确定性门禁已通过，但触及单卡 Token 软上限 (max_tokens_exceeded)，请确认是否继续推进下一阶段。`
      : `任务 "${latestCard.title}" 门禁或实施异常 (${stageDecision.reason})，请选择后续处理方式。`;

    const gateDecisionOptions = gatePassedTokenCap
      ? [
          hasReviewInPipeline
            ? {
                id: "opt-send-review",
                label: "转入独立审查",
                action: "resume" as const,
                target_stage: "review" as const,
                recommended: true,
              }
            : {
                id: "opt-proceed-next",
                label: proceedTargetStage === "accept" ? "进入真实验收" : "进入交付",
                action: "resume" as const,
                target_stage: proceedTargetStage,
                recommended: true,
              },
          {
            id: "opt-retry-implement",
            label: "退回实施阶段修复",
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
            id: "opt-retry-implement",
            label: "退回实施阶段修复",
            action: "resume" as const,
            target_stage: "implement" as const,
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
            action: "cancel" as const,
            recommended: false,
          },
        ];

    const pending = PendingDecisionSchema.parse({
      id: `dec-${randomUUID().slice(0, 8)}`,
      task_id: taskId,
      run_id: runMeta.run_id,
      contract_version: latestCard.contract_version,
      reason: stageDecision.reason,
      category: stageDecision.escalateToL2 ? "frozen_test_escalation" : "gate_failure_escalation",
      question: gateDecisionQuestion,
      options: gateDecisionOptions,
      created_at: new Date().toISOString(),
    });
    this.transitionTaskToWaiting(taskId, pending, guard);
  }

  private getActiveContractTestsLock(
    taskId: string,
    contractVersion: number,
  ): Extract<StateEvent, { type: "contract_tests_locked" }> | null {
    const card = this.store.readTaskCard(taskId);
    const events = this.store.readStateEvents(taskId);
    let active: Extract<StateEvent, { type: "contract_tests_locked" }> | null = null;
    for (const ev of events) {
      if (ev.type === "contract_tests_locked" && ev.contract_version === contractVersion) {
        active = ev;
      } else if (
        ev.type === "workflow_patched" &&
        (ev.contract_version === undefined || ev.contract_version === contractVersion)
      ) {
        const flat = getWorkflowFlatSteps(card, card.track);
        const remaining = flat.slice(ev.resume_step_index);
        if (
          remaining.some(
            (n) => n.kind === "agent" && n.stage === "implement" && n.mode === "test_first_lock",
          )
        ) {
          active = null;
        }
      } else if (ev.type === "contract_updated" && ev.to_version === contractVersion) {
        active = null;
      }
    }
    return active;
  }

  private resolveImplementReworkStepIndex(
    taskId: string,
    card: TaskCard,
    candidateStepIndex: number | null,
    effectiveTrack?: Track,
  ): number | null {
    if (candidateStepIndex === null) {
      return null;
    }
    const flat = getWorkflowFlatSteps(card, effectiveTrack ?? card.track);
    const candidate = flat[candidateStepIndex];
    if (
      candidate?.kind === "agent" &&
      candidate.stage === "implement" &&
      candidate.mode === "test_first_lock" &&
      this.getActiveContractTestsLock(taskId, card.contract_version) !== null
    ) {
      for (let i = candidateStepIndex + 1; i < flat.length; i++) {
        const next = flat[i]!;
        if (
          next.kind === "agent" &&
          next.stage === "implement" &&
          (next.mode ?? "normal") !== "test_first_lock"
        ) {
          return i;
        }
      }
    }
    return candidateStepIndex;
  }

  private async verifyAndLockRedTests(params: {
    taskId: string;
    card: TaskCard;
    runDirName: string;
    runMeta: RunMeta;
    worktreePath: string | undefined;
    baselineSnapshot: FrozenSnapshot | undefined;
    guard: ExpectedRunGuard;
    activeRunId: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const {
      taskId,
      card,
      runDirName,
      runMeta,
      worktreePath,
      baselineSnapshot,
      guard,
      activeRunId,
      signal,
    } = params;

    const failRedTestCheck = async (gateReport: GateReport, detailNote: string): Promise<void> => {
      writeYamlAtomic(this.store.paths.gateYaml(taskId, runDirName), gateReport, GateReportSchema);
      const decPath = this.store.paths.decisionsMd(taskId);
      const existing = readOptionalText(decPath) ?? "";
      const noteBlock = [`### 红绿建测安检退回 (${runMeta.run_id})`, `- 原因: ${detailNote}`].join(
        "\n",
      );
      writeFileAtomic(
        decPath,
        existing.trim().length > 0 ? `${existing.trimEnd()}\n\n${noteBlock}\n` : `${noteBlock}\n`,
      );

      const { counters, triageAttempted } = this.computeStageCounters(
        taskId,
        card,
        "implement",
        runMeta.run_id,
      );
      const advisorAvailable = this.isAdvisorConfigured();
      const consecutiveSameFailureCount = this.computeConsecutiveSameGateFailureCount(
        taskId,
        card,
        runMeta.run_id,
        gateReport,
      );
      const syntheticReceipt = parseAndValidateReceipt(
        "worker",
        readOptionalText(this.store.paths.receiptMd(taskId, runDirName)) ?? "",
      );
      const stageDecision = evaluateWorkerStageOutcome(
        card,
        syntheticReceipt,
        gateReport,
        counters,
        {
          currentStage: "implement",
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
      if (stageDecision.action === "advance_stage") {
        return;
      }
      if (stageDecision.action === "invoke_advisor") {
        assertCanInvokeAdvisor("kernel");
        this.writeAdvisorRequest(taskId, {
          schema_version: 1,
          contract_version: latestCard.contract_version,
          trigger: "stuck_same_failure",
          source_stage: "implement",
          source_run_id: runMeta.run_id,
          source_role: "worker",
          category: "stuck_loop",
          reason: stageDecision.reason,
          question: `红绿建测出卷阶段 (${runMeta.run_id}) 连续失败 (${detailNote})，请在不改目标与 scope 前提下研判破局。`,
          options: [],
          failure_fingerprint: computeGateFailureFingerprint(gateReport) ?? stageDecision.reason,
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
        category: stageDecision.escalateToL2 ? "frozen_test_escalation" : "gate_failure_escalation",
        question: `红绿建测出卷节点未通过 0-Token 安检：${detailNote}`,
        options: [
          {
            id: "opt-retry-implement",
            label: "重新生成失败测试 (test_first_lock)",
            action: "resume",
            target_stage: "implement",
            step_index: runMeta.step_index ?? 0,
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
    };

    if (!worktreePath || !fs.existsSync(worktreePath)) {
      const report = GateReportSchema.parse({
        schema_version: 1,
        run_id: runMeta.run_id,
        contract_version: card.contract_version,
        schema_ok: true,
        scope_ok: false,
        artifacts_ok: false,
        out_of_scope_paths: [],
        frozen_files_changed: [],
        accept_exit_code: 1,
        accept_duration_ms: 0,
        escalated_to_l2: false,
        checked_at: new Date().toISOString(),
      });
      await failRedTestCheck(report, "test_first_lock 缺少可用 git_worktree 工作区");
      return;
    }

    const recordedPreHead = this.testFirstLockPreHeadByRunId.get(runMeta.run_id);
    this.testFirstLockPreHeadByRunId.delete(runMeta.run_id);
    const preHeadSha = recordedPreHead && recordedPreHead.length > 0 ? recordedPreHead : "HEAD";
    const rollbackWorktree = async () => {
      await runGitCommand(["-C", worktreePath, "reset", "--hard", preHeadSha]).catch(() => {});
      await runGitCommand(["-C", worktreePath, "clean", "-fd"]).catch(() => {});
    };

    const gitChanges = await inspectGitWorktreeChanges(worktreePath, preHeadSha);
    const changedPaths = gitChanges.changedPaths;
    const isTestFilePath = (p: string): boolean =>
      /\.(test|spec)\.[^./]+$/i.test(p) || /(^|\/)(__tests__|evals)\//.test(p);

    const nonTestPaths = changedPaths.filter((p) => !isTestFilePath(p));
    const scopeCheck = checkScope(changedPaths, card.contract.scope);
    const space = this.store.readSpace(card.space);
    const freezePatterns = space?.freeze_patterns ?? [];
    const activeLock = this.getActiveContractTestsLock(taskId, card.contract_version);
    const unlockedTestFiles = new Set<string>();
    if (activeLock === null) {
      for (const ev of this.store.readStateEvents(taskId)) {
        if (ev.type === "contract_tests_locked" && ev.contract_version === card.contract_version) {
          for (const tf of ev.test_files) {
            unlockedTestFiles.add(tf);
          }
        }
      }
    }
    const effectiveFreezePatterns = freezePatterns;
    const effectiveBaselineSnapshot: FrozenSnapshot | undefined = (() => {
      if (activeLock !== null || unlockedTestFiles.size === 0 || !baselineSnapshot) {
        return baselineSnapshot;
      }
      if (freezePatterns.length === 0) {
        return undefined;
      }
      const retainedFiles = baselineSnapshot.files.filter(
        (f) => !unlockedTestFiles.has(f.path) || checkScope([f.path], freezePatterns).ok,
      );
      if (retainedFiles.length === 0) {
        return undefined;
      }
      const retainedDigest = createHash("sha256")
        .update(
          JSON.stringify({
            version: 1,
            acceptCmd: card.contract.accept_cmd,
            files: retainedFiles.map((f) => ({
              path: f.path,
              exists: f.exists,
              sha256: f.sha256,
            })),
          }),
        )
        .digest("hex");
      return {
        hash: `sha256:${retainedDigest}`,
        acceptCmd: card.contract.accept_cmd,
        files: retainedFiles,
      };
    })();
    const effectiveBaselineHash = effectiveBaselineSnapshot
      ? effectiveBaselineSnapshot.hash
      : "sha256:empty";

    let frozenFilesChanged: string[] = [];
    if (effectiveFreezePatterns.length > 0 || effectiveBaselineSnapshot !== undefined) {
      const frozenCheck = detectFrozenFilesChanged({
        rootDir: worktreePath,
        freezePatterns: effectiveFreezePatterns,
        acceptCmd: card.contract.accept_cmd,
        baselineHash: effectiveBaselineHash,
        changedPaths,
        ...(effectiveBaselineSnapshot !== undefined
          ? { baselineSnapshot: effectiveBaselineSnapshot }
          : {}),
      });
      frozenFilesChanged = frozenCheck.frozenFilesChanged;
    }

    if (
      changedPaths.length === 0 ||
      nonTestPaths.length > 0 ||
      !scopeCheck.ok ||
      frozenFilesChanged.length > 0
    ) {
      await rollbackWorktree();
      const reasonParts: string[] = [];
      if (changedPaths.length === 0) {
        reasonParts.push("未产生任何测试文件改动");
      }
      if (nonTestPaths.length > 0) {
        reasonParts.push(`触及非测试源码 (${nonTestPaths.join(", ")})`);
      }
      if (!scopeCheck.ok) {
        reasonParts.push(`越出 contract.scope (${scopeCheck.outOfScopePaths.join(", ")})`);
      }
      if (frozenFilesChanged.length > 0) {
        reasonParts.push(`篡改既有冻结文件 (${frozenFilesChanged.join(", ")})`);
      }
      const report = GateReportSchema.parse({
        schema_version: 1,
        run_id: runMeta.run_id,
        contract_version: card.contract_version,
        schema_ok: true,
        scope_ok: scopeCheck.ok && nonTestPaths.length === 0,
        artifacts_ok: false,
        out_of_scope_paths: scopeCheck.ok ? nonTestPaths : scopeCheck.outOfScopePaths,
        frozen_files_changed: frozenFilesChanged,
        accept_exit_code: 1,
        accept_duration_ms: 0,
        escalated_to_l2: frozenFilesChanged.length > 0 && card.track === "L1",
        checked_at: new Date().toISOString(),
      });
      await failRedTestCheck(report, `Check 1 路径安检失败: ${reasonParts.join("; ")}`);
      return;
    }

    const startedMs = Date.now();
    const redResult = await runIsolatedCommand(card.contract.accept_cmd, {
      cwd: worktreePath,
      ...(signal !== undefined ? { signal } : {}),
    });
    const redDurationMs = Math.max(0, Date.now() - startedMs);
    if (signal?.aborted || !this.isRunStillCurrent(taskId, activeRunId, card.contract_version)) {
      this.syncCaffeinate();
      return;
    }

    if (redResult.timedOut || redResult.exitCode === 0) {
      await rollbackWorktree();
      const report = GateReportSchema.parse({
        schema_version: 1,
        run_id: runMeta.run_id,
        contract_version: card.contract_version,
        schema_ok: true,
        scope_ok: true,
        artifacts_ok: false,
        out_of_scope_paths: [],
        frozen_files_changed: [],
        accept_exit_code: redResult.timedOut ? 124 : redResult.exitCode,
        accept_duration_ms: redDurationMs,
        escalated_to_l2: false,
        checked_at: new Date().toISOString(),
      });
      await failRedTestCheck(
        report,
        redResult.timedOut
          ? "Check 2 红灯校验超时（accept_cmd 超时），已回滚工作区"
          : "Check 2 红灯校验未失败（accept_cmd 意外返回 0，疑似空壳/假测试），已回滚工作区",
      );
      return;
    }

    await this.commitVerifiedWorktreeChanges(card, worktreePath, runMeta.round);
    const commitSha = (
      await runGitCommand(["-C", worktreePath, "rev-parse", "HEAD"]).catch(() => "")
    ).trim();

    const mergedFreezePatterns = Array.from(
      new Set([
        ...freezePatterns,
        ...(effectiveBaselineSnapshot?.files.map((f) => f.path) ?? []),
        ...changedPaths,
      ]),
    );
    const nextSnapshot = computeFrozenSnapshot(
      worktreePath,
      mergedFreezePatterns,
      card.contract.accept_cmd,
    );
    this.saveFrozenBaseline(taskId, nextSnapshot);

    const nowIso = new Date().toISOString();
    const latestCard = this.store.readTaskCard(taskId);
    const updatedCard = TaskCardSchema.parse({
      ...latestCard,
      contract: {
        ...latestCard.contract,
        accept_files_hash: nextSnapshot.hash,
      },
      updated_at: nowIso,
    });
    writeYamlAtomic(this.store.paths.cardYaml(taskId), updatedCard, TaskCardSchema);
    this.store.appendStateEvent(taskId, {
      type: "contract_tests_locked",
      at: nowIso,
      contract_version: updatedCard.contract_version,
      run_id: runMeta.run_id,
      test_files: changedPaths,
      accept_files_hash: nextSnapshot.hash,
      ...(commitSha ? { commit_sha: commitSha } : {}),
    });

    const lockGateReport = GateReportSchema.parse({
      schema_version: 1,
      run_id: runMeta.run_id,
      contract_version: updatedCard.contract_version,
      schema_ok: true,
      scope_ok: true,
      artifacts_ok: true,
      out_of_scope_paths: [],
      frozen_files_changed: [],
      accept_exit_code: 0,
      accept_duration_ms: redDurationMs,
      escalated_to_l2: false,
      checked_at: nowIso,
    });
    writeYamlAtomic(
      this.store.paths.gateYaml(taskId, runDirName),
      lockGateReport,
      GateReportSchema,
    );

    await createGitWorktreeCheckpoint({
      worktreePath,
      taskId,
      runId: runMeta.run_id,
      phase: "post",
      stage: "implement",
      round: runMeta.round,
    }).catch(() => {});
    await this.refreshTaskContextMap(updatedCard, worktreePath, runMeta.input_ref);

    const derived = deriveTaskStatus(updatedCard, this.store.readStateEvents(taskId));
    const nextStep = nextWorkflowStepAfter(
      updatedCard,
      runMeta.step_index ?? null,
      "implement",
      derived.track,
    );
    await this.advanceToNextStage(
      taskId,
      nextStep?.stage ?? "implement",
      guard,
      nextStep?.stepIndex ?? null,
    );
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
    const workspaceMutated = await this.detectAdvisorWorkspaceMutation(card, runMeta.run_id);
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

    const activeNode = resolveWorkflowStepAt(
      card,
      runMeta.step_index ?? null,
      "review",
      card.track,
    )?.node;
    const continueOnFail =
      parsedReceipt.ok &&
      parsedReceipt.frontmatter.run_id === runMeta.run_id &&
      parsedReceipt.frontmatter.contract_version === card.contract_version &&
      activeNode?.kind === "agent" &&
      activeNode.on_fail === "continue" &&
      (reviewDecision.action === "advance_stage" ||
        reviewDecision.reason !== "max_tokens_exceeded");

    if (reviewDecision.action === "advance_stage" || continueOnFail) {
      const nextStep = nextWorkflowStepAfter(
        card,
        runMeta.step_index ?? null,
        "review",
        card.track,
      );
      if (
        reviewDecision.action === "advance_stage" &&
        !continueOnFail &&
        nextStep !== null &&
        nextStep.stage === "accept" &&
        nextStep.node.kind === "agent"
      ) {
        const segRuns = [...this.listCurrentSegmentRuns(taskId, card)].reverse();
        let latestGate: GateReport | null = null;
        for (const sr of segRuns) {
          const gr = readYamlOptional(
            this.store.paths.gateYaml(taskId, sr.dirName),
            GateReportSchema,
          );
          if (gr && gr.contract_version === card.contract_version) {
            latestGate = gr;
            break;
          }
        }
        if (latestGate !== null) {
          const fastForwarded = await this.tryApplyDeterministicFastForward({
            taskId,
            card,
            fromStage: "review",
            candidateStep: nextStep,
            gateReport: latestGate,
            guard,
          });
          if (fastForwarded) {
            return;
          }
        }
      }
      await this.advanceToNextStage(
        taskId,
        nextStep?.stage ??
          (reviewDecision.action === "advance_stage" ? reviewDecision.nextStage : undefined) ??
          "deliver",
        guard,
        nextStep?.stepIndex ?? null,
      );
      return;
    }

    if (reviewDecision.action === "rework_implement") {
      const restartStepIndex = this.resolveImplementReworkStepIndex(
        taskId,
        card,
        findLoopRestartStepIndex(
          card,
          reviewDecision.targetStage,
          card.track,
          runMeta.step_index ?? null,
        ),
        card.track,
      );
      await this.advanceToNextStage(taskId, reviewDecision.targetStage, guard, restartStepIndex);
      return;
    }

    if (reviewDecision.action === "retry_stage") {
      await this.advanceToNextStage(taskId, "review", guard, runMeta.step_index ?? null);
      return;
    }

    if (reviewDecision.action === "invoke_advisor") {
      assertCanInvokeAdvisor("kernel");
      const failureFp = parsedReceipt.ok
        ? (computeReviewerFailureFingerprint(parsedReceipt.frontmatter, parsedReceipt.body) ??
          reviewDecision.reason)
        : reviewDecision.reason;
      const isRoundsExceeded = reviewDecision.reason === "review_rounds_exceeded";
      this.writeAdvisorRequest(taskId, {
        schema_version: 1,
        contract_version: card.contract_version,
        trigger: "review_deadlock",
        source_stage: "review",
        source_run_id: runMeta.run_id,
        source_role: "reviewer",
        category: isRoundsExceeded ? "design_tradeoff" : "stuck_loop",
        reason: reviewDecision.reason,
        question: isRoundsExceeded
          ? `任务 "${card.title}" 独立审查已达上限轮次仍未放行（${reviewDecision.reason}），请在不更改交付目标与 scope 的前提下裁决争议取舍并明确收敛方向。`
          : `任务 "${card.title}" 独立审查连续 ${consecutiveSameFailureCount} 次因同类缺陷未能放行（${reviewDecision.reason}），请在不更改目标与 scope 的前提下裁决破局方向。`,
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

    const nextStepAfterReview = nextWorkflowStepAfter(
      card,
      runMeta.step_index ?? null,
      "review",
      card.track,
    );
    const proceedStage =
      nextStepAfterReview?.stage ?? nextTaskStageAfter(card, "review", card.track);
    const proceedLabel =
      proceedStage === "deliver"
        ? card.workspace_mode === "host_scoped"
          ? "忽略剩余审查意见，直接进入交付审批"
          : "忽略剩余审查意见，直接进入交付"
        : proceedStage === "accept"
          ? "忽略剩余审查意见，直接进入真实验收"
          : "忽略剩余审查意见，直接推进下一阶段";

    const reviewEscalationOptions = [
      {
        id: "opt-rework",
        label: "退回实施继续修复",
        action: "resume" as const,
        target_stage: "implement" as const,
        recommended: true,
      },
      ...(proceedStage && proceedStage !== "implement" && proceedStage !== "review"
        ? [
            {
              id: "opt-accept-and-proceed",
              label: proceedLabel,
              action: "resume" as const,
              target_stage: proceedStage,
              cost_note: "由人类接管拍板，跳过剩余非致命审查意见并进入下一阶段",
              recommended: false,
            },
          ]
        : []),
      {
        id: "opt-cancel",
        label: "取消任务",
        action: "cancel" as const,
        recommended: false,
      },
    ];

    const pending = PendingDecisionSchema.parse({
      id: `dec-${randomUUID().slice(0, 8)}`,
      task_id: taskId,
      run_id: runMeta.run_id,
      contract_version: card.contract_version,
      reason: reviewDecision.reason,
      category: "review_escalation",
      question: `任务 "${card.title}" 独立审查未通过且达到升级条件 (${reviewDecision.reason})，请拍板决定。`,
      options: reviewEscalationOptions,
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
    const workspaceMutated = await this.detectAdvisorWorkspaceMutation(card, runMeta.run_id);
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
      const restartIdx = this.resolveImplementReworkStepIndex(
        taskId,
        card,
        findLoopRestartStepIndex(card, "implement", card.track, runMeta.step_index ?? null),
        card.track,
      );
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
    const workspaceMutated = await this.detectAdvisorWorkspaceMutation(card, runMeta.run_id);
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
      const { counters } = this.computeStageCounters(taskId, card, "triage", runMeta.run_id);
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
    const workspaceMutated = await this.detectAdvisorWorkspaceMutation(card, runMeta.run_id);
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
      if (stage === "plan" && parsed.frontmatter.spawn_subtasks !== undefined) {
        await this.handleMidFlightSubtaskSplitProposal({
          taskId,
          card,
          runMeta,
          guard,
          rationale: parsed.frontmatter.chosen_approach,
          subtasks: parsed.frontmatter.spawn_subtasks,
          sourceStage: "plan",
        });
        return;
      }
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
    const contextSuffix = input.advisorReq ? `\n- 原触发问题: ${input.advisorReq.question}` : "";
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
    const workspaceMutated = await this.detectAdvisorWorkspaceMutation(card, runMeta.run_id);
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
        const contextSuffix = advisorReq ? `\n- 原触发问题: ${advisorReq.question}` : "";
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
              label: resumeTargetStage === "review" ? "按讨论方向继续审查" : "按讨论方向继续实施",
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

      if (parsed.frontmatter.spawn_subtasks !== undefined) {
        this.clearAdvisorRequest(taskId);
        await this.handleMidFlightSubtaskSplitProposal({
          taskId,
          card,
          runMeta,
          guard,
          rationale: parsed.frontmatter.chosen_approach,
          subtasks: parsed.frontmatter.spawn_subtasks,
          sourceStage: "advise",
          advisorReq,
        });
        return;
      }

      if (parsed.frontmatter.workflow_patch !== undefined) {
        const sourceRunMeta = advisorReq
          ? this.listTaskRunDirs(taskId).find((r) => r.meta?.run_id === advisorReq.source_run_id)
              ?.meta
          : undefined;
        const rosterEntries = this.store.readEffectiveRosterConfig().roster;
        const rosterPermMap = Object.fromEntries(
          Object.entries(rosterEntries).map(([k, v]) => [
            k,
            {
              enabled: v.enabled,
              perm: v.perm,
              stage: v.stage,
              secondary_stages: v.secondary_stages,
            },
          ]),
        );
        const patchRes = applyAdvisorWorkflowPatch({
          currentBlueprint: resolveTaskWorkflow(card),
          sourceStepIndex: sourceRunMeta
            ? (sourceRunMeta.step_index ?? null)
            : (runMeta.step_index ?? null),
          sourceStage: advisorReq?.source_stage ?? "advise",
          replaceRemainingSteps: parsed.frontmatter.workflow_patch.replace_remaining_steps,
          rationale: parsed.frontmatter.workflow_patch.rationale,
          roster: rosterPermMap,
          workspaceMode: card.workspace_mode,
        });
        if (!patchRes.ok) {
          this.clearAdvisorRequest(taskId);
          const pending = PendingDecisionSchema.parse({
            id: `dec-${randomUUID().slice(0, 8)}`,
            task_id: taskId,
            run_id: runMeta.run_id,
            contract_version: card.contract_version,
            reason: "advisor_invalid_workflow_patch",
            category: "advisor_guardrail_escalation",
            question: `技术顾问提交的动态流程补丁未通过蓝图不变量校验：${patchRes.errors.join("; ")}。\n- 顾问建议: ${parsed.frontmatter.chosen_approach}`,
            options: [
              {
                id: "opt-resume-safe-stage",
                label:
                  resumeTargetStage === "review"
                    ? "忽略流程补丁，留在原流程继续审查"
                    : "忽略流程补丁，留在原流程继续实施",
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

        const now = new Date().toISOString();
        const updatedCard = TaskCardSchema.parse({
          ...card,
          workflow: patchRes.blueprint,
          updated_at: now,
        });
        writeYamlAtomic(this.store.paths.cardYaml(taskId), updatedCard, TaskCardSchema);

        const record = DecisionRecordSchema.parse({
          schema_version: 1,
          id: `adv-${runMeta.run_id}`,
          task_id: taskId,
          contract_version: card.contract_version,
          category: advisorReq?.category ?? "workflow_replan",
          decider: "advisor",
          action: "resume",
          affected_stages: [patchRes.resumeStage],
          rationale: parsed.frontmatter.workflow_patch.rationale,
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
            `## 技术顾问动态重排流程 (${record.id})`,
            ``,
            `- 选定方案: ${parsed.frontmatter.chosen_approach}`,
            `- 重排理由: ${parsed.frontmatter.workflow_patch.rationale}`,
            `- 保留前缀步数: ${patchRes.preservedPrefixSteps}`,
            `- 恢复执行阶段: ${patchRes.resumeStage} (step #${patchRes.resumeStepIndex})`,
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
        this.warmPool.evictTask(taskId);
        const nextState = this.store.appendStateEvent(taskId, {
          type: "workflow_patched",
          at: now,
          run_id: runMeta.run_id,
          contract_version: card.contract_version,
          preserved_prefix_steps: patchRes.preservedPrefixSteps,
          new_total_steps: flattenWorkflowSteps(patchRes.blueprint).length,
          resume_stage: patchRes.resumeStage,
          resume_step_index: patchRes.resumeStepIndex,
          rationale: parsed.frontmatter.workflow_patch.rationale,
        });
        this.syncCaffeinate();
        this.publishTaskUpdated(taskId, {
          status: nextState.status,
          stage: patchRes.resumeStage,
          contractVersion: nextState.contractVersion,
        });
        void this.wake();
        return;
      }

      const requestedTargetStage = parsed.frontmatter.target_stage;
      if (requestedTargetStage !== undefined && !pipelineStages.includes(requestedTargetStage)) {
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

      const nextTargetStage: "implement" | "review" = requestedTargetStage ?? resumeTargetStage;
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
    const originalContext = advisorReq ? `\n- 原触发问题: ${advisorReq.question}` : "";
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
          label: resumeTargetStage === "review" ? "按讨论方向继续审查" : "按讨论方向继续实施",
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
        const dirtyPaths =
          statusRaw.length > 0 ? parseGitPorcelainStatusZ(statusRaw).dirtyPaths : [];
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
        const postHead = (await runGitCommand(["-C", worktreePath, "rev-parse", "HEAD"])).trim();
        if (runMeta.input_ref && postHead !== runMeta.input_ref) {
          const derived = deriveTaskStatus(card, this.store.readStateEvents(taskId));
          const verifyIdx = getWorkflowFlatSteps(card, derived.track).findIndex(
            (n) => n.stage === "verify",
          );
          await this.advanceToNextStage(taskId, "verify", guard, verifyIdx >= 0 ? verifyIdx : null);
          return;
        }
      }
    }

    await this.advanceToNextStage(taskId, "deliver", guard, runMeta.step_index ?? null);
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
    const preEvents = this.store.readStateEvents(plan.taskId);
    let activeSubtaskBarrier: Extract<StateEvent, { type: "subtasks_spawned" }> | null = null;
    for (let i = preEvents.length - 1; i >= 0; i--) {
      const ev = preEvents[i]!;
      if (ev.type === "running" && ev.stage === "implement") {
        break;
      }
      if (ev.type === "subtasks_spawned" && ev.contract_version === plan.contractVersion) {
        activeSubtaskBarrier = ev;
        break;
      }
    }

    if (activeSubtaskBarrier !== null) {
      const now = new Date().toISOString();
      const runDirName = this.allocateRunDirName(plan.taskId, "verify");
      const verifyRunId = `run-${plan.taskId}-verify-r${plan.round}-v${plan.contractVersion}`;
      const barrierWorktreePath =
        plan.card.workspace_mode === "git_worktree"
          ? this.getGitWorktreeDir(plan.taskId)
          : undefined;
      const barrierRunMeta: RunMeta = {
        schema_version: 1,
        run_id: verifyRunId,
        task_id: plan.taskId,
        stage: "verify",
        ...(plan.stepIndex !== null ? { step_index: plan.stepIndex } : {}),
        round: plan.round,
        role: "verifier",
        contract_version: plan.contractVersion,
        backend_id: "deterministic",
        agent: "kilnd-gate",
        model: "deterministic",
        session_ref: { backendId: "deterministic", sessionId: verifyRunId },
        ...(barrierWorktreePath !== undefined ? { cwd: barrierWorktreePath } : {}),
        ...(activeSubtaskBarrier.base_ref_sha !== undefined
          ? { input_ref: activeSubtaskBarrier.base_ref_sha }
          : {}),
        started_at: now,
      };
      ensureDir(this.store.paths.runDir(plan.taskId, runDirName));
      writeYamlAtomic(
        this.store.paths.runYaml(plan.taskId, runDirName),
        barrierRunMeta,
        RunMetaSchema,
      );
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

        const card = this.store.readTaskCard(plan.taskId);
        const space = this.store.readSpace(card.space);
        const worktreePath =
          card.workspace_mode === "git_worktree" ? this.getGitWorktreeDir(plan.taskId) : undefined;
        let acceptCwd = this.store.paths.taskDir(plan.taskId);
        let changedPaths: string[] = [];

        if (card.workspace_mode === "scratch_dir") {
          const parentWsDir = this.store.paths.workspaceDir(plan.taskId);
          ensureDir(parentWsDir);
          for (const childId of activeSubtaskBarrier.child_task_ids) {
            const childWsDir = this.store.paths.workspaceDir(childId);
            if (!fs.existsSync(childWsDir)) {
              continue;
            }
            for (const relPath of collectRelativeFiles(childWsDir)) {
              const src = path.join(childWsDir, relPath);
              const dst = path.join(parentWsDir, relPath);
              ensureDir(path.dirname(dst));
              fs.copyFileSync(src, dst);
            }
          }
          acceptCwd = parentWsDir;
          changedPaths = collectRelativeFiles(parentWsDir);
        } else if (worktreePath && fs.existsSync(worktreePath)) {
          acceptCwd = worktreePath;
          const baseRef = activeSubtaskBarrier.base_ref_sha ?? space?.default_branch ?? "main";
          const gitChanges = await inspectGitWorktreeChanges(worktreePath, baseRef);
          changedPaths = gitChanges.changedPaths;
        }

        const scopeCheck = checkScope(changedPaths, card.contract.scope);
        const freezePatterns = space?.freeze_patterns ?? [];
        const baselineSnapshot = this.readSavedFrozenBaseline(plan.taskId, card);
        let frozenFilesChanged: string[] = [];
        if (freezePatterns.length > 0 || baselineSnapshot !== undefined) {
          const frozenCheck = detectFrozenFilesChanged({
            rootDir: acceptCwd,
            freezePatterns,
            acceptCmd: card.contract.accept_cmd,
            baselineHash: card.contract.accept_files_hash,
            changedPaths,
            baselineSnapshot,
          });
          frozenFilesChanged = frozenCheck.frozenFilesChanged;
        }

        const startedMs = Date.now();
        const cmdResult = await runIsolatedCommand(card.contract.accept_cmd, {
          cwd: acceptCwd,
          signal,
        });
        if (
          signal.aborted ||
          !this.isRunStillCurrent(plan.taskId, verifyRunId, card.contract_version)
        ) {
          this.syncCaffeinate();
          return;
        }

        const acceptExitCode = cmdResult.timedOut ? 124 : cmdResult.exitCode;
        const escalatedToL2 = frozenFilesChanged.length > 0 && card.track === "L1";
        const gateReport = GateReportSchema.parse({
          schema_version: 1,
          run_id: verifyRunId,
          contract_version: card.contract_version,
          schema_ok: true,
          scope_ok: scopeCheck.ok,
          artifacts_ok: true,
          out_of_scope_paths: scopeCheck.outOfScopePaths,
          frozen_files_changed: frozenFilesChanged,
          accept_exit_code: acceptExitCode,
          accept_duration_ms: Math.max(0, Date.now() - startedMs),
          escalated_to_l2: escalatedToL2,
          checked_at: new Date().toISOString(),
        });
        writeYamlAtomic(
          this.store.paths.gateYaml(plan.taskId, runDirName),
          gateReport,
          GateReportSchema,
        );

        if (escalatedToL2) {
          const escState = this.stateMachine.escalateTrackToL2(plan.taskId, "frozen_files_changed");
          this.publishTaskUpdated(plan.taskId, {
            contractVersion: escState.contractVersion,
          });
        }

        const latestCard = this.store.readTaskCard(plan.taskId);
        const verifyGuard: ExpectedRunGuard = {
          runId: verifyRunId,
          contractVersion: latestCard.contract_version,
        };
        if (scopeCheck.ok && acceptExitCode === 0) {
          if (worktreePath && fs.existsSync(worktreePath)) {
            await this.commitVerifiedWorktreeChanges(latestCard, worktreePath, plan.round);
          }
          const afterVerify = nextWorkflowStepAfter(
            latestCard,
            plan.stepIndex,
            "verify",
            latestCard.track,
          );
          if (
            afterVerify !== null &&
            (afterVerify.stage === "review" || afterVerify.stage === "accept")
          ) {
            const fastForwarded = await this.tryApplyDeterministicFastForward({
              taskId: plan.taskId,
              card: latestCard,
              fromStage: "verify",
              candidateStep: afterVerify,
              gateReport,
              guard: verifyGuard,
            });
            if (fastForwarded) {
              return;
            }
          }
          await this.advanceToNextStage(
            plan.taskId,
            afterVerify?.stage ?? "deliver",
            verifyGuard,
            afterVerify?.stepIndex ?? null,
          );
          return;
        }

        const tailSnippet = (cmdResult.stderr || cmdResult.stdout).trim().slice(-400);
        const decision = PendingDecisionSchema.parse({
          id: `dec-${randomUUID().slice(0, 8)}`,
          task_id: plan.taskId,
          run_id: verifyRunId,
          contract_version: latestCard.contract_version,
          reason: "integration_verify_failed",
          category: "gate_failure",
          question: `子卡全部合流后，父卡总集成 verify 未通过（scope_ok=${scopeCheck.ok}, accept_exit_code=${acceptExitCode}${scopeCheck.outOfScopePaths.length > 0 ? `, out_of_scope=${scopeCheck.outOfScopePaths.join(", ")}` : ""}）。${tailSnippet ? `\n输出摘要:\n\`\`\`\n${tailSnippet}\n\`\`\`` : ""}`,
          options: [
            {
              id: "opt-retry-verify",
              label: "重跑父卡总集成 verify",
              action: "resume",
              target_stage: "verify",
              recommended: true,
            },
            {
              id: "opt-reimplement",
              label: "退回父卡实施阶段手工/单卡收尾修复",
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
        this.transitionTaskToWaiting(plan.taskId, decision, verifyGuard);
      });
      return;
    }

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

      const postDeliverRun = this.findCompletedDelivererAfterLastImplement(plan.taskId, plan.card);
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
            await this.commitVerifiedWorktreeChanges(card, worktreePath, postDeliverRun.meta.round);
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
        withSpaceMergeLock: (repoPath, fn) => this.spaceMergeLock.withLock(repoPath, fn),
        reworkDeliverFailure: async (p, input, expected) => {
          if (!this.isRunStillCurrent(p.taskId, expected.runId, expected.contractVersion)) {
            this.syncCaffeinate();
            return;
          }
          const nowIso = new Date().toISOString();
          this.store.appendStateEvent(p.taskId, {
            type: "steered",
            at: nowIso,
            steer_id: input.steerId,
            message: input.message,
            interrupt: false,
            contract_version: p.contractVersion,
            stage: "implement",
          });
          const latestCard = this.store.readTaskCard(p.taskId);
          const restartStepIndex = this.resolveImplementReworkStepIndex(
            p.taskId,
            latestCard,
            findLoopRestartStepIndex(latestCard, "implement", latestCard.track, p.stepIndex),
            latestCard.track,
          );
          await this.advanceToNextStage(p.taskId, "implement", expected, restartStepIndex);
        },
        dispatchAgentStageRun: (p) => this.dispatchAgentStageRun(p),
        wake: () => this.wake(),
      },
      plan,
    );
  }

  private async handleMidFlightSubtaskSplitProposal(params: {
    taskId: string;
    card: TaskCard;
    runMeta: RunMeta;
    guard: ExpectedRunGuard;
    rationale: string;
    subtasks: readonly MidFlightSubtaskSpec[];
    sourceStage: "plan" | "advise";
    advisorReq?: AdvisorRequest | null;
  }): Promise<void> {
    const { taskId, card, runMeta, guard, rationale, subtasks, sourceStage, advisorReq } = params;
    const escalateInvalid = (detail: string): void => {
      const pending = PendingDecisionSchema.parse({
        id: `dec-${randomUUID().slice(0, 8)}`,
        task_id: taskId,
        run_id: runMeta.run_id,
        contract_version: card.contract_version,
        reason: "subtask_split_invalid",
        category: "advisor_guardrail_escalation",
        question: `裂变子卡提案未通过不变量校验：${detail}。\n- 建议摘要: ${rationale}${advisorReq ? `\n- 原触发问题: ${advisorReq.question}` : ""}`,
        options: [
          {
            id: "opt-continue-single-card",
            label: "忽略裂变提案，继续单卡实施",
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
    };

    if (card.workspace_mode === "host_scoped") {
      escalateInvalid("host_scoped 任务禁止中途中裂变为并行子卡");
      return;
    }
    if (card.parent !== null) {
      escalateInvalid("子卡禁止再次裂变孙卡（仅支持单层父卡裂变）");
      return;
    }
    const dag = validateSplitCardsDag(
      subtasks.map((s) => ({
        temp_id: s.temp_id,
        depends_on_temp_ids: s.depends_on_temp_ids,
      })),
    );
    if (!dag.ok) {
      escalateInvalid(dag.errors.join("; "));
      return;
    }

    for (const s of subtasks) {
      try {
        validateCommitContract(this.store, {
          end: s.contract.end,
          accept_cmd: s.contract.accept_cmd ?? card.contract.accept_cmd,
          scope: s.contract.scope,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        escalateInvalid(`子卡 "${s.temp_id}" 契约不合规：${msg}`);
        return;
      }
    }

    const scopeSubsetOk = subtasks.every((s) =>
      isChildScopeSubsetOfParent(s.contract.scope, card.contract.scope),
    );
    const autoApproveEligible = subtasks.length >= 2 && subtasks.length <= 4 && scopeSubsetOk;

    if (!autoApproveEligible) {
      const decisionId = `dec-${randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();
      const splitRecord = PendingSubtaskSplitSchema.parse({
        schema_version: 1,
        decision_id: decisionId,
        contract_version: card.contract_version,
        source_run_id: runMeta.run_id,
        source_stage: sourceStage,
        rationale,
        subtasks: [...subtasks],
        created_at: now,
      });
      writeYamlAtomic(
        this.store.paths.pendingSubtaskSplitYaml(taskId),
        splitRecord,
        PendingSubtaskSplitSchema,
      );

      const reasons: string[] = [];
      if (subtasks.length > 4) {
        reasons.push(`拟拆分数量为 ${subtasks.length} 张（超过免批上限 4 张）`);
      }
      if (!scopeSubsetOk) {
        reasons.push("部分子卡 scope 未严格收束在父卡 contract.scope 内");
      }
      const pending = PendingDecisionSchema.parse({
        id: decisionId,
        task_id: taskId,
        run_id: runMeta.run_id,
        contract_version: card.contract_version,
        reason: "subtask_split_approval",
        category: "subtask_split",
        question: `任务 "${card.title}" 在 ${sourceStage} 阶段提出裂变为 ${subtasks.length} 张并行子卡，需您拍板确认（${reasons.join("；")}）：\n- 拆分依据: ${rationale}\n- 子卡列表: ${subtasks.map((s) => `${s.temp_id}:${s.title}[${s.contract.scope.join(",")}]`).join(" | ")}`,
        options: [
          {
            id: "opt-approve-subtask-split",
            label: "批准裂变为子卡并让父卡挂起至总集成验收",
            action: "resume",
            target_stage: "verify",
            recommended: true,
          },
          {
            id: "opt-continue-single-card",
            label: "拒绝拆分，按原单卡继续实施",
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
        created_at: now,
      });
      this.transitionTaskToWaiting(taskId, pending, guard);
      return;
    }

    await this.executeMidFlightSubtaskSplit({
      taskId,
      card,
      runId: runMeta.run_id,
      rationale,
      subtasks,
      guard,
    });
  }

  async approvePendingSubtaskSplit(
    taskId: string,
    decisionId: string,
    options?: {
      rationale?: string;
      applyLedgerRule?: boolean;
      contractUpdate?: ContractUpdateInput;
    },
  ): Promise<void> {
    const safeTaskId = assertSafeSegment(taskId, "taskId");
    const pending = this.pendingDecisions.get(safeTaskId);
    const splitPath = this.store.paths.pendingSubtaskSplitYaml(safeTaskId);
    const splitSpec = readYamlOptional(splitPath, PendingSubtaskSplitSchema);
    if (
      !pending ||
      pending.id !== decisionId ||
      !splitSpec ||
      splitSpec.decision_id !== decisionId
    ) {
      throw new Error(
        `Task "${safeTaskId}" does not have a matching pending subtask split for decision "${decisionId}"`,
      );
    }

    const initialCard = this.store.readTaskCard(safeTaskId);
    if (
      splitSpec.contract_version !== initialCard.contract_version ||
      pending.contract_version !== initialCard.contract_version
    ) {
      fs.rmSync(splitPath, { force: true });
      throw new ServerHttpError(409, {
        error: "stale_subtask_split",
        taskId: safeTaskId,
        expectedContractVersion: initialCard.contract_version,
        splitContractVersion: splitSpec.contract_version,
        message: `Task "${safeTaskId}" contract version changed from v${splitSpec.contract_version} to v${initialCard.contract_version}; subtask split proposal is stale`,
      });
    }

    const baseScope = options?.contractUpdate?.contractPatch.scope ?? initialCard.contract.scope;
    const allChildScopesCovered = splitSpec.subtasks.every((s) =>
      isChildScopeSubsetOfParent(s.contract.scope, baseScope),
    );
    const mergedScope = allChildScopesCovered
      ? [...baseScope]
      : Array.from(new Set([...baseScope, ...splitSpec.subtasks.flatMap((s) => s.contract.scope)]));

    const nextParentEnd = options?.contractUpdate?.contractPatch.end ?? initialCard.contract.end;
    const nextParentAcceptCmd =
      options?.contractUpdate?.contractPatch.accept_cmd ?? initialCard.contract.accept_cmd;
    validateCommitContract(this.store, {
      end: nextParentEnd,
      accept_cmd: nextParentAcceptCmd,
      scope: mergedScope,
      deliver: initialCard.contract.deliver,
    });

    const scopeExpanded =
      mergedScope.length !== initialCard.contract.scope.length ||
      mergedScope.some((entry, idx) => initialCard.contract.scope[idx] !== entry);

    let effectiveContractUpdate: ContractUpdateInput | undefined = options?.contractUpdate;
    if (effectiveContractUpdate !== undefined) {
      if (!allChildScopesCovered) {
        effectiveContractUpdate = {
          ...effectiveContractUpdate,
          contractPatch: {
            ...effectiveContractUpdate.contractPatch,
            scope: mergedScope,
          },
        };
      }
    } else if (scopeExpanded) {
      effectiveContractUpdate = {
        contractPatch: { scope: mergedScope },
        affectedStages: ["verify"],
      };
    }

    const decisionForApply: PendingDecision =
      options?.applyLedgerRule === true
        ? pending
        : {
            ...pending,
            options: pending.options.map((opt) => {
              if (opt.id !== "opt-approve-subtask-split") {
                return opt;
              }
              const { ledger_rule: _omitted, ...withoutLedgerRule } = opt;
              return withoutLedgerRule;
            }),
          };

    this.stateMachine.applyDecision({
      taskId: safeTaskId,
      decision: decisionForApply,
      optionId: "opt-approve-subtask-split",
      decider: "human",
      ...(options?.rationale !== undefined ? { rationale: options.rationale } : {}),
      ...(effectiveContractUpdate !== undefined ? { contractUpdate: effectiveContractUpdate } : {}),
    });
    this.pendingDecisions.remove(safeTaskId);
    fs.rmSync(splitPath, { force: true });

    const card = this.store.readTaskCard(safeTaskId);
    await this.executeMidFlightSubtaskSplit({
      taskId: safeTaskId,
      card,
      runId: splitSpec.source_run_id,
      rationale: splitSpec.rationale,
      subtasks: splitSpec.subtasks,
    });
    const postSplitCard = this.store.readTaskCard(safeTaskId);
    const postSplitState = deriveTaskStatus(postSplitCard, this.store.readStateEvents(safeTaskId));
    this.publishTaskUpdated(safeTaskId, {
      status: postSplitState.status,
      ...(postSplitState.stage !== null ? { stage: postSplitState.stage } : {}),
      contractVersion: postSplitState.contractVersion,
    });
  }

  private async executeMidFlightSubtaskSplit(params: {
    taskId: string;
    card: TaskCard;
    runId: string;
    rationale: string;
    subtasks: readonly MidFlightSubtaskSpec[];
    guard?: ExpectedRunGuard;
  }): Promise<void> {
    const { taskId, card, runId, rationale, subtasks, guard } = params;
    if (
      guard !== undefined &&
      !this.isRunStillCurrent(taskId, guard.runId, guard.contractVersion)
    ) {
      this.syncCaffeinate();
      return;
    }

    const dag = validateSplitCardsDag(
      subtasks.map((s) => ({
        temp_id: s.temp_id,
        depends_on_temp_ids: s.depends_on_temp_ids,
      })),
    );
    if (!dag.ok) {
      throw new Error(`Invalid subtask split DAG: ${dag.errors.join("; ")}`);
    }

    let baseRefSha: string | undefined;
    if (card.workspace_mode === "git_worktree") {
      const prep = await this.prepareWorkspaceForPlan(card, "implement");
      const dirtyOut = (
        await runGitCommand(["-C", prep.cwd, "status", "--porcelain"]).catch(() => "")
      ).trim();
      if (dirtyOut.length > 0) {
        await createGitWorktreeCheckpoint({
          worktreePath: prep.cwd,
          taskId: card.id,
          runId,
          phase: "pre",
          stage: "implement",
          round: 1,
        }).catch(() => {});
        await runGitCommand(["-C", prep.cwd, "reset", "--hard", "HEAD"]);
        await runGitCommand(["-C", prep.cwd, "clean", "-fd"]);
      }
      const cleanHeadSha = (await runGitCommand(["-C", prep.cwd, "rev-parse", "HEAD"])).trim();
      baseRefSha = prep.inputRef ?? (cleanHeadSha.length > 0 ? cleanHeadSha : undefined);
    } else if (card.workspace_mode === "scratch_dir") {
      ensureDir(this.store.paths.workspaceDir(card.id));
    }

    const count = subtasks.length;
    const totals = this.store.getTaskTotalTokens(card.id);
    const spentTokens =
      Math.max(0, totals.input_tokens - totals.cached_input_tokens) + totals.output_tokens;
    const remainingTokens = Math.max(50_000, card.limits.max_tokens - spentTokens);
    const childMaxTokens = Math.max(50_000, Math.floor((remainingTokens * 0.8) / count));
    const spentUsd = computeTaskSpentUsd(this.store, card.id);
    const childMaxCostUsd =
      card.limits.max_cost_usd !== undefined
        ? Number(
            Math.max(
              0.25,
              (Math.max(0.25, card.limits.max_cost_usd - spentUsd) * 0.8) / count,
            ).toFixed(2),
          )
        : undefined;

    const specByTempId = new Map<string, MidFlightSubtaskSpec>();
    for (const s of subtasks) {
      specByTempId.set(s.temp_id, s);
    }

    const existingIds = new Set(this.store.listTasks().map((row) => row.id));
    const tempToRealId = new Map<string, string>();
    for (const tempId of dag.order) {
      let candidate = `t-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
      while (existingIds.has(candidate)) {
        candidate = `t-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
      }
      existingIds.add(candidate);
      tempToRealId.set(tempId, candidate);
    }

    const parentPlanText = readOptionalText(this.store.paths.planMd(card.id)) ?? "";
    const parentResearchText = readOptionalText(this.store.paths.researchMd(card.id)) ?? "";
    const rosterEntries = this.store.readEffectiveRosterConfig().roster;

    const now = new Date().toISOString();
    const createdChildIds: string[] = [];

    try {
      for (const tempId of dag.order) {
        const spec = specByTempId.get(tempId)!;
        const childId = tempToRealId.get(tempId)!;
        const childWorkflow = buildCustomWorkflow({
          preset: "custom",
          includeResearch: false,
          includePlan: false,
          includeReview: spec.include_review && spec.track === "L2",
          includeAccept: false,
          deliverApproval: false,
          hostTwoPhase: false,
          hasDeliverCmd: false,
          maxRounds: card.limits.review_rounds,
          stuckThreshold: 2,
        });

        const assignedRole =
          spec.roster_role &&
          rosterEntries[spec.roster_role]?.enabled === true &&
          isWriteCapableRosterPermission(rosterEntries[spec.roster_role]!.perm)
            ? spec.roster_role
            : undefined;
        if (assignedRole) {
          const patchImplRole = (
            step: (typeof childWorkflow.steps)[number],
          ): (typeof childWorkflow.steps)[number] => {
            if (step.kind === "loop") {
              return {
                ...step,
                steps: step.steps.map((inner) => patchImplRole(inner) as typeof inner),
              };
            }
            if (step.kind === "agent" && step.stage === "implement") {
              return { ...(step as WorkflowAgentNode), roster_role: assignedRole };
            }
            return step;
          };
          childWorkflow.steps = childWorkflow.steps.map(patchImplRole);
        }

        const effectiveAcceptCmd = spec.contract.accept_cmd ?? card.contract.accept_cmd;
        const effectiveAcceptHash =
          effectiveAcceptCmd !== card.contract.accept_cmd
            ? "pending"
            : card.contract.accept_files_hash;
        const childCard = TaskCardSchema.parse({
          schema_version: 1,
          id: childId,
          title: spec.title,
          space: card.space,
          priority: spec.priority ?? card.priority,
          track: spec.track,
          workspace_mode: card.workspace_mode,
          parent: card.id,
          depends_on: spec.depends_on_temp_ids.map((depTemp) => tempToRealId.get(depTemp)!),
          workflow: childWorkflow,
          contract_version: 1,
          contract: {
            goal: spec.contract.goal,
            ...(spec.contract.non_goals.length > 0 ? { non_goals: spec.contract.non_goals } : {}),
            end: spec.contract.end,
            accept_cmd: effectiveAcceptCmd,
            accept_files_hash: effectiveAcceptHash,
            scope: spec.contract.scope,
            deliver:
              card.workspace_mode === "git_worktree"
                ? { mode: "merge_parent", cmd: null }
                : { mode: "manual", cmd: null },
            human_accept: false,
            external_actions: "ask",
          },
          limits: {
            retries_per_stage: card.limits.retries_per_stage,
            review_rounds: card.limits.review_rounds,
            advisor_calls: card.limits.advisor_calls,
            max_tokens: childMaxTokens,
            ...(childMaxCostUsd !== undefined ? { max_cost_usd: childMaxCostUsd } : {}),
          },
          created_at: now,
          updated_at: now,
        });
        validateCommitContract(this.store, childCard.contract);

        const briefParts = [
          spec.brief_markdown.trim(),
          ``,
          `---`,
          `- 父卡: \`${card.id}\` (${card.title})`,
          `- 拆分理由: ${rationale}`,
        ];
        if (parentPlanText.trim().length > 0) {
          briefParts.push(``, `## 父卡方案摘要`, parentPlanText.trim().slice(0, 1500));
        } else if (parentResearchText.trim().length > 0) {
          briefParts.push(``, `## 父卡调研摘要`, parentResearchText.trim().slice(0, 1500));
        }

        this.stateMachine.createTask(childCard, `${briefParts.join("\n")}\n`);
        createdChildIds.push(childId);
      }
    } catch (err) {
      for (const cid of createdChildIds) {
        try {
          this.store.deleteTaskOnRollback(cid);
        } catch {
          // Best-effort cleanup of partially spawned children.
        }
      }
      throw err;
    }

    const updatedParentCard = TaskCardSchema.parse({
      ...card,
      depends_on: Array.from(new Set([...card.depends_on, ...createdChildIds])),
      updated_at: now,
    });
    writeYamlAtomic(this.store.paths.cardYaml(taskId), updatedParentCard, TaskCardSchema);

    const flatParentSteps = getWorkflowFlatSteps(updatedParentCard, updatedParentCard.track);
    let lastVerifyIdx = 0;
    for (let i = flatParentSteps.length - 1; i >= 0; i--) {
      if (flatParentSteps[i]?.stage === "verify") {
        lastVerifyIdx = i;
        break;
      }
    }

    const decPath = this.store.paths.decisionsMd(taskId);
    const existingDec = readOptionalText(decPath) ?? "";
    const record = DecisionRecordSchema.parse({
      schema_version: 1,
      id: `split-${runId}`,
      task_id: taskId,
      contract_version: updatedParentCard.contract_version,
      category: "subtask_split",
      decider: "advisor",
      action: "resume",
      affected_stages: ["verify"],
      rationale,
      decided_at: now,
    });
    const splitBlock = serializeFrontmatterMarkdown(
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
        `## 中途裂变并行子卡 (${record.id})`,
        ``,
        `- 拆分依据: ${rationale}`,
        `- 子卡列表: ${createdChildIds.join(", ")}`,
        `- 父卡集成屏障: verify (step #${lastVerifyIdx})`,
        ``,
      ].join("\n"),
    );
    writeFileAtomic(
      decPath,
      existingDec.trim().length > 0
        ? `${existingDec.trimEnd()}\n\n${splitBlock}\n`
        : `${splitBlock}\n`,
    );

    this.warmPool.evictTask(taskId);
    const nextParentState = this.store.appendStateEvent(taskId, {
      type: "subtasks_spawned",
      at: now,
      run_id: runId,
      contract_version: updatedParentCard.contract_version,
      child_task_ids: createdChildIds,
      ...(baseRefSha !== undefined ? { base_ref_sha: baseRefSha } : {}),
      resume_stage: "verify",
      resume_step_index: lastVerifyIdx,
    });
    this.stateMachine.syncAllEffectivePriorities();
    this.syncCaffeinate();
    for (const childId of createdChildIds) {
      const childRow = this.store.getTaskIndex(childId);
      if (childRow) {
        this.publishTaskUpdated(childId, {
          status: childRow.status,
          contractVersion: childRow.contract_version,
        });
      }
    }
    this.publishTaskUpdated(taskId, {
      status: nextParentState.status,
      stage: "verify",
      contractVersion: nextParentState.contractVersion,
    });
    void this.wake();
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

  async triggerTaskRetro(taskId: string, opts?: { useAi?: boolean }): Promise<TaskRetroReport> {
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
