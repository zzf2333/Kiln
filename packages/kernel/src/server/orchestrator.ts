import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  DecisionOptionSchema,
  DecisionRecordSchema,
  PendingDecisionSchema,
  RunMetaSchema,
  TaskCardSchema,
  parseAndValidateReceipt,
  parseFrontmatterMarkdown,
  serializeFrontmatterMarkdown,
  type BackendCapabilities,
  type DecisionOption,
  type GateReport,
  type PendingDecision,
  type RoleId,
  type RunEvent,
  type RunMeta,
  type SessionRef,
  type StageId,
  type StateEvent,
  type TaskCard,
} from "@kiln/protocol";
import {
  FullAccessOnlyProviderError,
  IneligibleRoleAgentError,
  assertRoleAgentEligible,
  type ApprovalRequestEvent,
  type BackendRegistry,
  type BackendRunSpec,
  type ExecutionBackend,
  type McpStdioMountSpec,
} from "../backend/index.js";
import {
  applyApprovedHostScopedChanges,
  buildSanitizedEnv,
  cleanupGitWorktree,
  computeFrozenSnapshot,
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
  evaluateReviewerStageOutcome,
  evaluateWorkerStageOutcome,
  handleExecutionFailure,
  nextStageAfter,
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
} from "../store/index.js";
import type { CaffeinateController } from "./caffeinate.js";
import {
  resolveMcpServerCommand,
  type McpCommandSpec,
} from "./chat.js";
import {
  PendingDecisionStore,
  countRunningLeafTasks,
  readOptionalText,
} from "./pending-decisions.js";
import type { LiveRateTracker } from "./rate-tracker.js";
import type { SseHub } from "./sse.js";

const execFileAsync = promisify(execFile);
const RATE_LIMIT_MESSAGE_RE = /\b429\b|rate[_ -]?limit|too many requests|quota exceeded/i;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15_000;

export interface DeliverContext {
  taskId: string;
  card: TaskCard;
  worktreePath: string | null;
  store: KilnStore;
}

export type DeliverOutcome =
  | { status: "done"; deliverRef?: string }
  | { status: "external"; detail?: string }
  | { status: "waiting"; decision: PendingDecision };

export type DeliverHandler = (
  ctx: DeliverContext,
) => Promise<DeliverOutcome> | DeliverOutcome;

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
    ttlSeconds?: number;
  }) => string;
  mcpServerCommand?: McpCommandSpec;
  deliverHandler?: DeliverHandler;
  approvalHandler?: OrchestratorApprovalHandler;
  rateLimitCooldownMs?: number;
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

async function runGitCommand(args: readonly string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    env: buildSanitizedEnv(),
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout;
}

function collectRelativeFiles(dir: string, relPrefix = ""): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectRelativeFiles(full, rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files.sort();
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

function extractSection(markdownBody: string, heading: string): string {
  const pattern = new RegExp(
    `^#{1,3}[ \\t]+${heading}(?:[ \\t:(（][^\\r\\n]*)?(?=\\r?\\n|$)`,
    "m",
  );
  const match = pattern.exec(markdownBody);
  if (!match) return "";
  const after = markdownBody.slice(match.index + match[0].length);
  const next = /^#{1,3}[ \t]+/m.exec(after);
  return (next ? after.slice(0, next.index) : after).trim();
}

function extractDecisionFromNeedDecisionReceipt(
  rawReceipt: string,
  taskId: string,
  runId: string,
  contractVersion: number,
  body: string,
): PendingDecision {
  const parsedFm = parseFrontmatterMarkdown(rawReceipt).frontmatter;
  const issueSection =
    extractSection(body, "未完成或待决问题") || extractSection(body, "待决问题");

  const question =
    typeof parsedFm.question === "string" && parsedFm.question.trim().length > 0
      ? parsedFm.question.trim()
      : issueSection.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ||
        `任务 "${taskId}" 在执行过程中提出待决问题，请确认继续方案`;

  const reason =
    typeof parsedFm.reason === "string" && parsedFm.reason.trim().length > 0
      ? parsedFm.reason.trim()
      : "worker_need_decision";

  const category =
    typeof parsedFm.category === "string" && parsedFm.category.trim().length > 0
      ? parsedFm.category.trim()
      : "worker_decision";

  let options: DecisionOption[] | null = null;
  if (Array.isArray(parsedFm.options)) {
    const parsedOpts = z.array(DecisionOptionSchema).min(1).safeParse(parsedFm.options);
    if (parsedOpts.success) {
      options = parsedOpts.data;
    }
  }

  if (!options) {
    const parsedFromBullets: DecisionOption[] = [];
    for (const line of body.split(/\r?\n/)) {
      const m = /^[-*]\s+\[([^\]]+)\]\s+(.+?)(?:\s+\(action:\s*(resume|return_external|finish|cancel)\))?$/i.exec(
        line.trim(),
      );
      if (m) {
        parsedFromBullets.push(
          DecisionOptionSchema.parse({
            id: m[1]!.trim(),
            label: m[2]!.trim(),
            action: (m[3]?.toLowerCase() ?? "resume") as DecisionOption["action"],
            recommended: parsedFromBullets.length === 0,
          }),
        );
      }
    }
    if (parsedFromBullets.length > 0) {
      options = parsedFromBullets;
    }
  }

  if (!options) {
    options = [
      DecisionOptionSchema.parse({
        id: "opt-resume",
        label: "确认澄清并继续推进当前阶段",
        action: "resume",
        target_stage: "implement",
        recommended: true,
      }),
      DecisionOptionSchema.parse({
        id: "opt-cancel",
        label: "取消任务",
        action: "cancel",
        recommended: false,
      }),
    ];
  }

  return PendingDecisionSchema.parse({
    id: `dec-${randomUUID().slice(0, 8)}`,
    task_id: taskId,
    run_id: runId,
    contract_version: contractVersion,
    reason,
    category,
    question,
    options,
    created_at: new Date().toISOString(),
  });
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

  private readonly agentCapabilitiesMap = new Map<string, BackendCapabilities>();
  private readonly activeRuns = new Map<string, ActiveRunHandle>();
  private readonly inFlightOperations = new Map<string, InFlightStageOperation>();
  private readonly approvalUnsubscribers: Array<() => void> = [];
  private readonly deferredApprovals: Array<{
    backend: ExecutionBackend;
    req: ApprovalRequestEvent;
  }> = [];
  private readonly scheduler: KilnScheduler;

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

    this.scheduler = new KilnScheduler({
      store: this.store,
      stateMachine: this.stateMachine,
      agentCapabilitiesMap: this.agentCapabilitiesMap,
      onDispatch: async (plan) => {
        await this.dispatchPlan(plan);
      },
      onDispatchError: (taskId, error) => {
        void this.handleSchedulerDispatchError(taskId, error);
      },
    });
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
    await this.syncAgentCapabilities();

    const runningTasks = this.store.listTasks({ status: "running" });
    const activeLeases = this.store.listActiveStageLeases();
    const candidateTaskIds = new Set<string>([
      ...runningTasks.map((t) => t.id),
      ...activeLeases.map((l) => l.task_id),
    ]);

    for (const taskId of candidateTaskIds) {
      const card = this.store.readTaskCard(taskId);
      const events = this.store.readStateEvents(taskId);
      const derived = deriveTaskStatus(card, events);
      if (derived.status !== "running") {
        // Never touch paused/waiting/terminal tasks; ensure orphan lease is expired.
        this.store.sqlite.expireActiveLeaseByTask(
          taskId,
          new Date().toISOString(),
          "expired",
        );
        continue;
      }

      if (derived.stage === "verify" || derived.stage === "deliver") {
        const now = new Date().toISOString();
        this.store.sqlite.expireActiveLeaseByTask(taskId, now, "expired");
        this.store.appendStateEvent(taskId, { type: "queued", at: now });
        this.publishTaskUpdated(taskId, {
          status: "queued",
          stage: derived.stage,
          contractVersion: derived.contractVersion,
        });
        continue;
      }

      const activeRunId = derived.activeRunId;
      const runDirs = this.listTaskRunDirs(taskId);
      const matchingRun = activeRunId
        ? runDirs.find((r) => r.meta?.run_id === activeRunId)
        : undefined;

      if (
        !matchingRun ||
        !matchingRun.meta ||
        matchingRun.meta.contract_version !== derived.contractVersion
      ) {
        const now = new Date().toISOString();
        this.store.sqlite.expireActiveLeaseByTask(taskId, now, "expired");
        this.store.appendStateEvent(taskId, { type: "queued", at: now });
        this.publishTaskUpdated(taskId, { status: "queued" });
        continue;
      }

      const runMeta = matchingRun.meta;
      if (matchingRun.hasReceipt) {
        try {
          switch (runMeta.stage) {
            case "implement":
              await this.finalizeWorkerRun(taskId, matchingRun.dirName, runMeta, null);
              break;
            case "review":
              await this.finalizeReviewerRun(taskId, matchingRun.dirName, runMeta, null);
              break;
            case "accept":
              await this.finalizeVerifierRun(taskId, matchingRun.dirName, runMeta);
              break;
            case "triage":
              await this.finalizeTriageRun(taskId, matchingRun.dirName, runMeta);
              break;
            case "advise":
              await this.finalizeAdvisorRun(taskId, matchingRun.dirName, runMeta);
              break;
            default: {
              const now = new Date().toISOString();
              this.store.sqlite.expireActiveLeaseByTask(taskId, now, "expired");
              this.store.appendStateEvent(taskId, { type: "queued", at: now });
              this.publishTaskUpdated(taskId, { status: "queued" });
              break;
            }
          }
        } catch {
          this.store.sqlite.expireActiveLeaseByTask(
            taskId,
            new Date().toISOString(),
            "expired",
          );
        }
        const afterFinalize = deriveTaskStatus(
          this.store.readTaskCard(taskId),
          this.store.readStateEvents(taskId),
        );
        if (afterFinalize.status === "running" && afterFinalize.activeRunId === runMeta.run_id) {
          const now = new Date().toISOString();
          this.store.sqlite.expireActiveLeaseByTask(taskId, now, "expired");
          this.store.appendStateEvent(taskId, { type: "queued", at: now });
          this.publishTaskUpdated(taskId, {
            status: "queued",
            ...(afterFinalize.stage !== null ? { stage: afterFinalize.stage } : {}),
            contractVersion: afterFinalize.contractVersion,
          });
        }
        continue;
      }

      const lease = this.store.getStageLease(taskId);
      if (!lease || lease.state !== "active" || lease.run_id !== runMeta.run_id) {
        const now = new Date().toISOString();
        this.store.appendStateEvent(taskId, { type: "queued", at: now });
        this.publishTaskUpdated(taskId, { status: "queued" });
        continue;
      }

      if (!this.backendRegistry.has(runMeta.backend_id)) {
        const now = new Date().toISOString();
        this.store.sqlite.expireActiveLeaseByTask(taskId, now, "expired");
        this.store.appendStateEvent(taskId, { type: "queued", at: now });
        this.publishTaskUpdated(taskId, { status: "queued" });
        continue;
      }

      const backend = this.backendRegistry.get(runMeta.backend_id);
      let aliveRunning = false;
      try {
        const probe = await backend.probe(runMeta.session_ref);
        aliveRunning = probe.alive && probe.status === "running";
      } catch {
        aliveRunning = false;
      }

      if (aliveRunning) {
        this.attachSessionConsumer(
          taskId,
          matchingRun.dirName,
          runMeta,
          backend,
          runMeta.session_ref,
        );
      } else {
        const now = new Date().toISOString();
        this.store.sqlite.expireActiveLeaseByTask(taskId, now, "expired");
        this.store.appendStateEvent(taskId, { type: "queued", at: now });
        this.publishTaskUpdated(taskId, { status: "queued" });
      }
    }

    this.syncCaffeinate();
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
    if (handle) {
      handle.cancelledByControl = true;
      handle.abortController.abort();
      await handle.backend.cancel(handle.sessionRef).catch(() => {});
      await handle.consumePromise.catch(() => {});
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

  private async prepareWorkspaceForPlan(
    card: TaskCard,
    stage: StageId,
  ): Promise<{ cwd: string; inputRef?: string }> {
    if (card.workspace_mode === "external_only") {
      throw new Error('Unsupported workspace_mode: "external_only" is Post-MVP');
    }

    if (card.workspace_mode === "scratch_dir") {
      const cwd = prepareScratchWorkspace(this.store, card.id);
      this.ensureFrozenBaselineInitialized(card, cwd);
      return { cwd };
    }

    if (card.workspace_mode === "host_scoped") {
      const wsDir = this.store.paths.workspaceDir(card.id);
      ensureDir(wsDir);
      ensureDir(this.store.paths.stagedDir(card.id));
      this.ensureFrozenBaselineInitialized(card, wsDir);
      return { cwd: wsDir };
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

      this.ensureFrozenBaselineInitialized(card, prep.worktreePath);
      return { cwd: prep.worktreePath, inputRef: prep.baseCommit };
    }

    this.ensureFrozenBaselineInitialized(card, worktreePath);
    const headCommit = (
      await runGitCommand(["-C", worktreePath, "rev-parse", "HEAD"])
    ).trim();

    if (stage === "implement") {
      const firstImplementRun = this.listTaskRunDirs(card.id).find(
        (r) => r.meta?.stage === "implement" && r.meta.input_ref,
      );
      return {
        cwd: worktreePath,
        inputRef: firstImplementRun?.meta?.input_ref ?? headCommit,
      };
    }

    return { cwd: worktreePath, inputRef: headCommit };
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

  private buildHandoffMarkdown(params: {
    card: TaskCard;
    runId: string;
    runDirName: string;
    stage: StageId;
    round: number;
    role: RoleId;
    cwd: string;
    inputRef?: string;
    mcpEnabled: boolean;
  }): string {
    const { card, runId, runDirName, stage, round, role, cwd, inputRef, mcpEnabled } = params;
    const brief = readOptionalText(this.store.paths.briefMd(card.id)) ?? "";
    const decisions = readOptionalText(this.store.paths.decisionsMd(card.id)) ?? "";
    const ledger = this.store.readLedger(card.space);
    const ledgerText =
      ledger && ledger.entries.length > 0
        ? ledger.entries.map((e) => `- ${e.rule}`).join("\n")
        : "(无)";

    const protocolNote = mcpEnabled
      ? `请使用 kiln-mcp 工具（wb_get_context / wb_read_ledger / wb_submit_receipt / wb_ask_decision）提交阶段产物。`
      : [
          `当前执行环境未注入 MCP，请严格遵守文件降级协议：`,
          `- 将阶段回执直接写入：${this.store.paths.receiptMd(card.id, runDirName)}`,
          `- 若遇到阻塞需要人类裁决，请在回执 frontmatter 填写 outcome: need_decision、question 与 options，并在正文 "## 未完成或待决问题" 写明详情。`,
        ].join("\n");

    const modeNote =
      card.workspace_mode === "host_scoped"
        ? `当前为 host_scoped 模式：只能把待写文件写入沙盒暂存目录 ${this.store.paths.stagedDir(card.id)}，严禁直接修改宿主机目标文件！`
        : card.workspace_mode === "git_worktree"
          ? `当前为 git_worktree 模式：工作区位于 ${cwd}，严禁执行 git push。`
          : `当前为 scratch_dir 模式：独立目录位于 ${cwd}。`;

    return [
      `# HANDOFF (${stage} · round ${round})`,
      ``,
      `- task_id: ${card.id}`,
      `- run_id: ${runId}`,
      `- role: ${role}`,
      `- contract_version: ${card.contract_version}`,
      `- workspace_mode: ${card.workspace_mode}`,
      `- cwd: ${cwd}`,
      ...(inputRef ? [`- input_ref: ${inputRef}`] : []),
      ``,
      `## 交付契约`,
      `- 目标: ${card.contract.goal}`,
      `- 终点: ${card.contract.end}`,
      `- 验收命令: \`${card.contract.accept_cmd}\``,
      `- 可改范围: ${card.contract.scope.join(", ")}`,
      ``,
      `## 安全与协议要求`,
      modeNote,
      protocolNote,
      ``,
      `## 空间决策账本 (${card.space})`,
      ledgerText,
      ``,
      ...(brief ? [`## 立项说明 (BRIEF)`, brief, ``] : []),
      ...(decisions ? [`## 历史裁决 (decisions)`, decisions, ``] : []),
    ].join("\n");
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

  private async dispatchPlan(plan: DispatchPlan): Promise<void> {
    if (this.stopped) {
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

    const workspace = await this.prepareWorkspaceForPlan(plan.card, plan.stage);
    const runDirName = this.allocateRunDirName(plan.taskId, plan.stage);
    const runId = `run-${plan.taskId}-${plan.stage}-r${plan.round}-v${plan.contractVersion}-${randomUUID().slice(0, 6)}`;
    const now = new Date().toISOString();

    const handoffMarkdown = this.buildHandoffMarkdown({
      card: plan.card,
      runId,
      runDirName,
      stage: plan.stage,
      round: plan.round,
      role: plan.role,
      cwd: workspace.cwd,
      inputRef: workspace.inputRef,
      mcpEnabled: caps.mcpInjection,
    });

    const placeholderSessionRef: SessionRef = {
      backendId: backend.backendId,
      sessionId: `pending-${runId}`,
    };

    const runMeta: RunMeta = {
      schema_version: 1,
      run_id: runId,
      task_id: plan.taskId,
      stage: plan.stage,
      round: plan.round,
      role: plan.role,
      contract_version: plan.contractVersion,
      backend_id: backend.backendId,
      agent: assignment.agent,
      model: assignment.model,
      session_ref: placeholderSessionRef,
      ...(workspace.inputRef !== undefined ? { input_ref: workspace.inputRef } : {}),
      started_at: now,
    };

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
                ttlSeconds: 7_200,
              }),
              KILN_SOCK_PATH: this.socketPath,
              KILN_HOME: this.store.paths.home,
            },
          },
        ]
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
      ...(mcpServers !== undefined ? { mcpServers } : {}),
    };

    let sessionRef: SessionRef;
    this.startingBackendCount += 1;
    try {
      sessionRef = await backend.start(runSpec);
    } catch (err) {
      await this.handleBackendStartError(plan, runDirName, runMeta, err);
      return;
    } finally {
      this.startingBackendCount = Math.max(0, this.startingBackendCount - 1);
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
    const leaseStillActive =
      !this.stopped &&
      latestDerived?.status === "running" &&
      latestDerived.activeRunId === runId &&
      latestCard?.contract_version === plan.contractVersion &&
      existingLease?.state === "active" &&
      existingLease.run_id === runId;

    if (!leaseStillActive) {
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

            if (ev.kind === "message" && ev.delta) {
              this.rateTracker.recordDelta({ taskId, text: ev.text });
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
      case "implement":
        await this.finalizeWorkerRun(taskId, runDirName, runMeta, exitEvent, signal);
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

  private computeStageCounters(
    taskId: string,
    card: TaskCard,
    currentStage: StageId,
    currentRunId: string,
  ): { counters: StageCounters; triageAttempted: boolean } {
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

    const runs = this.listTaskRunDirs(taskId).filter(
      (r): r is ScannedRunDir & { meta: RunMeta } =>
        r.meta !== null &&
        !r.rateLimited &&
        r.meta.contract_version === card.contract_version &&
        r.meta.started_at >= lastResetIso,
    );

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
    return {
      counters: {
        stageRetries,
        reviewRounds,
        advisorCalls,
        totalTokens,
      },
      triageAttempted,
    };
  }

  private async advanceToNextStage(
    taskId: string,
    nextStage: StageId,
    expected?: ExpectedRunGuard,
  ): Promise<boolean> {
    if (
      this.stopped ||
      (expected !== undefined &&
        !this.isRunStillCurrent(taskId, expected.runId, expected.contractVersion))
    ) {
      this.syncCaffeinate();
      return false;
    }

    const now = new Date().toISOString();
    const nextState = this.store.appendStateEvent(taskId, {
      type: "resumed",
      at: now,
      stage: nextStage,
    });
    this.syncCaffeinate();
    this.publishTaskUpdated(taskId, {
      status: nextState.status,
      stage: nextStage,
      contractVersion: nextState.contractVersion,
    });
    await this.wake();
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
      await this.advanceToNextStage(taskId, stage, guard);
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

  private async finalizeWorkerRun(
    taskId: string,
    runDirName: string,
    runMeta: RunMeta,
    _exitEvent: Extract<RunEvent, { kind: "exit" }> | null,
    signal?: AbortSignal,
    activeRunIdOverride?: string,
  ): Promise<void> {
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
        "implement",
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
          "implement",
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
      "implement",
      runMeta.run_id,
    );

    const stageDecision = evaluateWorkerStageOutcome(
      card,
      parsedReceipt,
      gateResult.report,
      counters,
      { currentStage: "implement", triageAttempted },
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
      const next =
        stageDecision.nextStage === "verify"
          ? (nextStageAfter(
              stageDecision.effectiveTrack,
              "verify",
              latestCard.contract.human_accept,
            ) ?? "deliver")
          : (stageDecision.nextStage ?? "deliver");
      await this.advanceToNextStage(taskId, next, guard);
      return;
    }

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

    if (stageDecision.action === "retry_stage") {
      await this.advanceToNextStage(taskId, stageDecision.stage, guard);
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
        ...(latestCard.track === "L2"
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

    const reviewDecision = evaluateReviewerStageOutcome(card, parsedReceipt, counters, {
      triageAttempted,
    });

    if (reviewDecision.action === "advance_stage") {
      await this.advanceToNextStage(taskId, reviewDecision.nextStage ?? "deliver", guard);
      return;
    }

    if (reviewDecision.action === "rework_implement") {
      await this.advanceToNextStage(taskId, reviewDecision.targetStage, guard);
      return;
    }

    if (reviewDecision.action === "retry_stage") {
      await this.advanceToNextStage(taskId, "review", guard);
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

    const card = this.store.readTaskCard(taskId);
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

    if (parsed.frontmatter.verdict === "pass") {
      await this.advanceToNextStage(taskId, "deliver", guard);
    } else {
      await this.advanceToNextStage(taskId, "implement", guard);
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
      this.syncCaffeinate();
      return;
    }

    const receiptLoad = this.readReceiptAndCommitLease(taskId, runDirName, runMeta);
    const card = this.store.readTaskCard(taskId);

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
      const roles = this.store.readConfig("roles");
      if (counters.advisorCalls < card.limits.advisor_calls && roles?.roles.advisor) {
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
      this.syncCaffeinate();
      return;
    }

    const receiptLoad = this.readReceiptAndCommitLease(taskId, runDirName, runMeta);
    const card = this.store.readTaskCard(taskId);
    const parsed = receiptLoad.ok
      ? parseAndValidateReceipt("advisor", receiptLoad.rawReceipt)
      : null;
    const versionMatches = Boolean(
      parsed?.ok &&
        parsed.frontmatter.run_id === runMeta.run_id &&
        parsed.frontmatter.contract_version === card.contract_version,
    );

    if (versionMatches && parsed?.ok && parsed.frontmatter.outcome === "resolved") {
      const now = new Date().toISOString();
      const record = DecisionRecordSchema.parse({
        schema_version: 1,
        id: `adv-${runMeta.run_id}`,
        task_id: taskId,
        contract_version: card.contract_version,
        category: "advisor_resolution",
        decider: "advisor",
        action: "resume",
        affected_stages: ["implement"],
        rationale: parsed.frontmatter.chosen_approach,
        decided_at: now,
      });
      const decPath = this.store.paths.decisionsMd(taskId);
      const existing = readOptionalText(decPath) ?? "";
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
        `## 技术顾问裁决 (${record.id})\n\n- 选定方案: ${parsed.frontmatter.chosen_approach}\n`,
      );
      writeFileAtomic(
        decPath,
        existing.trim().length > 0 ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`,
      );
      await this.advanceToNextStage(taskId, "implement", guard);
      return;
    }

    const pending = PendingDecisionSchema.parse({
      id: `dec-${randomUUID().slice(0, 8)}`,
      task_id: taskId,
      run_id: runMeta.run_id,
      contract_version: card.contract_version,
      reason: "advisor_need_decision",
      category: "advisor_escalation",
      question: parsed?.ok
        ? versionMatches
          ? `技术顾问无法在当前授权内决断（${parsed.frontmatter.chosen_approach}），请拍板。`
          : `技术顾问回执 run_id 或 contract_version 不匹配，请人工拍板任务 "${card.title}"。`
        : `技术顾问未产出有效裁决，请人工拍板任务 "${card.title}"。`,
      options: [
        {
          id: "opt-resume-impl",
          label: "按讨论方向继续实施",
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

  private async dispatchVerifyStage(plan: DispatchPlan): Promise<void> {
    const now = new Date().toISOString();
    const verifyRunId = `run-${plan.taskId}-verify-r${plan.round}-v${plan.contractVersion}`;
    this.store.appendStateEvent(plan.taskId, {
      type: "running",
      at: now,
      stage: "verify",
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

  private hasApprovedDeliverDecision(
    events: readonly StateEvent[],
    waitingReason: string,
  ): boolean {
    let lastWaitingIdx = -1;
    let lastImplIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (lastWaitingIdx === -1 && ev.type === "waiting" && ev.reason === waitingReason) {
        lastWaitingIdx = i;
      }
      if (lastImplIdx === -1 && ev.type === "running" && ev.stage === "implement") {
        lastImplIdx = i;
      }
      if (lastWaitingIdx !== -1 && lastImplIdx !== -1) {
        break;
      }
    }
    if (lastWaitingIdx === -1 || lastWaitingIdx < lastImplIdx) {
      return false;
    }
    for (let i = lastWaitingIdx + 1; i < events.length; i++) {
      const ev = events[i]!;
      if (
        ev.type === "decided" &&
        ev.action === "resume" &&
        ev.target_stage === "deliver"
      ) {
        return true;
      }
    }
    return false;
  }

  private async dispatchDeliverStage(plan: DispatchPlan): Promise<void> {
    const now = new Date().toISOString();
    const deliverRunId = `run-${plan.taskId}-deliver-r${plan.round}-v${plan.contractVersion}`;
    const deliverGuard: ExpectedRunGuard = {
      runId: deliverRunId,
      contractVersion: plan.contractVersion,
    };

    this.store.appendStateEvent(plan.taskId, {
      type: "running",
      at: now,
      stage: "deliver",
      round: plan.round,
      run_id: deliverRunId,
    });
    this.syncCaffeinate();
    this.publishTaskUpdated(plan.taskId, {
      status: "running",
      stage: "deliver",
      round: plan.round,
      contractVersion: plan.contractVersion,
    });

    await this.runTrackedStageOperation(plan.taskId, deliverRunId, async (signal) => {
      if (
        signal.aborted ||
        !this.isRunStillCurrent(plan.taskId, deliverRunId, plan.contractVersion)
      ) {
        this.syncCaffeinate();
        return;
      }

      const card = this.store.readTaskCard(plan.taskId);
      const worktreePath =
        card.workspace_mode === "git_worktree"
          ? this.getGitWorktreeDir(plan.taskId)
          : null;
      let deliverRef = worktreePath ?? this.store.paths.workspaceDir(plan.taskId);

      if (card.workspace_mode === "host_scoped") {
        let hostDeliverRef = "host_scoped_completed";
        const manifestPath = this.store.paths.backupManifest(plan.taskId);
        if (fs.existsSync(manifestPath)) {
          const manifest = readHostBackupManifest(this.store, plan.taskId);
          if (manifest.status === "staged_awaiting_approval") {
            const events = this.store.readStateEvents(plan.taskId);
            const approved = this.hasApprovedDeliverDecision(
              events,
              "host_scoped_approval",
            );

            if (!approved) {
              const targetList = manifest.files
                .map((f) => f.target_canonical_path)
                .join(", ");
              const decision = PendingDecisionSchema.parse({
                id: `dec-${randomUUID().slice(0, 8)}`,
                task_id: plan.taskId,
                contract_version: card.contract_version,
                reason: "host_scoped_approval",
                category: "host_scoped_apply",
                question: `本机任务 "${card.title}" 已生成暂存修改并备份原文件，批准原子写入以下白名单路径吗？(${targetList})`,
                options: [
                  {
                    id: "opt-apply-host",
                    label: "批准落盘写入宿主机并执行校验",
                    action: "resume",
                    target_stage: "deliver",
                    recommended: true,
                  },
                  {
                    id: "opt-finish-staged",
                    label: "仅保留暂存补丁，不写本机直接完成",
                    action: "finish",
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
              this.transitionTaskToWaiting(plan.taskId, decision, deliverGuard);
              return;
            }

            const applyRes = await applyApprovedHostScopedChanges(this.store, {
              taskId: plan.taskId,
              approved: true,
              verifyCmd: card.contract.accept_cmd,
            });
            if (
              signal.aborted ||
              !this.isRunStillCurrent(plan.taskId, deliverRunId, plan.contractVersion)
            ) {
              this.syncCaffeinate();
              return;
            }
            if (!applyRes.ok) {
              const decision = PendingDecisionSchema.parse({
                id: `dec-${randomUUID().slice(0, 8)}`,
                task_id: plan.taskId,
                contract_version: card.contract_version,
                reason: `host_apply_${applyRes.reason}`,
                category: "host_scoped_apply_error",
                question: `本机落盘未完成 (${applyRes.reason})，已安全保护或回滚，请选择下一步操作。`,
                options: [
                  {
                    id: "opt-reimplement",
                    label: "退回实施重新生成暂存",
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
              this.transitionTaskToWaiting(plan.taskId, decision, deliverGuard);
              return;
            }

            hostDeliverRef = applyRes.manifest.files
              .map((f) => f.target_canonical_path)
              .join(", ");
          }
        }

        deliverRef = hostDeliverRef;
        if (card.contract.deliver.mode !== "run_cmd") {
          this.completeTaskDelivery(plan.taskId, deliverRef, deliverGuard);
          return;
        }
      }

      if (this.deliverHandler) {
        const outcome = await this.deliverHandler({
          taskId: plan.taskId,
          card,
          worktreePath,
          store: this.store,
        });
        if (
          signal.aborted ||
          !this.isRunStillCurrent(plan.taskId, deliverRunId, plan.contractVersion)
        ) {
          this.syncCaffeinate();
          return;
        }
        if (outcome.status === "waiting") {
          this.transitionTaskToWaiting(plan.taskId, outcome.decision, deliverGuard);
          return;
        }
        if (outcome.status === "external") {
          const extState = this.store.appendStateEvent(plan.taskId, {
            type: "external",
            at: new Date().toISOString(),
            ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
          });
          this.syncCaffeinate();
          this.publishTaskUpdated(plan.taskId, {
            status: extState.status,
            stage: "deliver",
            contractVersion: extState.contractVersion,
          });
          void this.wake();
          return;
        }
        this.completeTaskDelivery(plan.taskId, outcome.deliverRef, deliverGuard);
        return;
      }

      // Default deterministic local delivery handler
      if (
        card.workspace_mode === "git_worktree" &&
        worktreePath &&
        fs.existsSync(worktreePath)
      ) {
        const space = this.store.readSpace(card.space);
        if (card.contract.deliver.mode === "merge_main" && space?.repo_path) {
          const statusOut = (
            await runGitCommand(["-C", worktreePath, "status", "--porcelain"])
          ).trim();
          const headCommit = (
            await runGitCommand(["-C", worktreePath, "rev-parse", "HEAD"])
          ).trim();
          if (
            signal.aborted ||
            !this.isRunStillCurrent(plan.taskId, deliverRunId, plan.contractVersion)
          ) {
            this.syncCaffeinate();
            return;
          }
          deliverRef = headCommit;

          if (statusOut.length > 0) {
            const decision = PendingDecisionSchema.parse({
              id: `dec-${randomUUID().slice(0, 8)}`,
              task_id: plan.taskId,
              contract_version: card.contract_version,
              reason: "worktree_dirty_before_merge",
              category: "deliver_merge_blocked",
              question: `工作树分支 kiln/${plan.taskId} 存在未提交改动，无法执行 merge_main，请先处理未提交变更后再重试合并。`,
              options: [
                {
                  id: "opt-reimplement",
                  label: "退回实施提交或清理工作树",
                  action: "resume",
                  target_stage: "implement",
                  recommended: true,
                },
                {
                  id: "opt-retry-deliver",
                  label: "已在本地处理，重试合并主分支",
                  action: "resume",
                  target_stage: "deliver",
                  recommended: false,
                },
                {
                  id: "opt-finish",
                  label: "保留工作树分支并直接标记完成",
                  action: "finish",
                  recommended: false,
                },
              ],
              created_at: new Date().toISOString(),
            });
            this.transitionTaskToWaiting(plan.taskId, decision, deliverGuard);
            return;
          }

          const baseRef = space.default_branch;
          const aheadCount = Number(
            (
              await runGitCommand([
                "-C",
                space.repo_path,
                "rev-list",
                "--count",
                `${baseRef}..kiln/${plan.taskId}`,
              ]).catch(() => "0")
            ).trim(),
          );
          if (
            signal.aborted ||
            !this.isRunStillCurrent(plan.taskId, deliverRunId, plan.contractVersion)
          ) {
            this.syncCaffeinate();
            return;
          }
          if (aheadCount > 0) {
            const currentMainBranch = (
              await runGitCommand([
                "-C",
                space.repo_path,
                "rev-parse",
                "--abbrev-ref",
                "HEAD",
              ]).catch(() => "")
            ).trim();
            const mainStatus = (
              await runGitCommand(["-C", space.repo_path, "status", "--porcelain"])
            ).trim();
            if (
              signal.aborted ||
              !this.isRunStillCurrent(plan.taskId, deliverRunId, plan.contractVersion)
            ) {
              this.syncCaffeinate();
              return;
            }
            if (mainStatus.length > 0 || currentMainBranch !== baseRef) {
              const reasons: string[] = [];
              if (mainStatus.length > 0) {
                reasons.push("主仓库存在未提交改动");
              }
              if (currentMainBranch !== baseRef) {
                reasons.push(
                  `主仓库当前位于 "${currentMainBranch || "unknown"}" 而非 "${baseRef}"`,
                );
              }
              const decision = PendingDecisionSchema.parse({
                id: `dec-${randomUUID().slice(0, 8)}`,
                task_id: plan.taskId,
                contract_version: card.contract_version,
                reason: "main_repo_not_ready_for_merge",
                category: "deliver_merge_blocked",
                question: `分支 kiln/${plan.taskId} 尚有 ${aheadCount} 个提交未合并至 ${baseRef}，但${reasons.join("且")}，已保留 worktree 等待处理。`,
                options: [
                  {
                    id: "opt-retry-deliver",
                    label: "主仓库就绪后重试合并主分支",
                    action: "resume",
                    target_stage: "deliver",
                    recommended: true,
                  },
                  {
                    id: "opt-finish",
                    label: "跳过合并主分支直接标记完成（保留工作树）",
                    action: "finish",
                    recommended: false,
                  },
                ],
                created_at: new Date().toISOString(),
              });
              this.transitionTaskToWaiting(plan.taskId, decision, deliverGuard);
              return;
            }

            try {
              await runGitCommand([
                "-C",
                space.repo_path,
                "merge",
                "--no-edit",
                `kiln/${plan.taskId}`,
              ]);
              deliverRef = (
                await runGitCommand(["-C", space.repo_path, "rev-parse", "HEAD"])
              ).trim();
            } catch (mergeErr) {
              await runGitCommand(["-C", space.repo_path, "merge", "--abort"]).catch(
                () => {},
              );
              const msg =
                mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
              const decision = PendingDecisionSchema.parse({
                id: `dec-${randomUUID().slice(0, 8)}`,
                task_id: plan.taskId,
                contract_version: card.contract_version,
                reason: "merge_conflict",
                category: "deliver_merge_conflict",
                question: `本地合并分支 kiln/${plan.taskId} 到 ${baseRef} 时冲突（${msg}），请人工处理或选择继续方式。`,
                options: [
                  {
                    id: "opt-reimplement",
                    label: "退回实施解决冲突",
                    action: "resume",
                    target_stage: "implement",
                    recommended: true,
                  },
                  {
                    id: "opt-finish",
                    label: "保留工作区分支并直接标记完成",
                    action: "finish",
                    recommended: false,
                  },
                ],
                created_at: new Date().toISOString(),
              });
              this.transitionTaskToWaiting(plan.taskId, decision, deliverGuard);
              return;
            }
          }
        } else if (card.contract.deliver.mode === "open_pr") {
          const events = this.store.readStateEvents(plan.taskId);
          const approvedPr = this.hasApprovedDeliverDecision(
            events,
            "external_action_approval",
          );
          if (!approvedPr && card.contract.external_actions === "ask") {
            const decision = PendingDecisionSchema.parse({
              id: `dec-${randomUUID().slice(0, 8)}`,
              task_id: plan.taskId,
              contract_version: card.contract_version,
              reason: "external_action_approval",
              category: "external_deliver_pr",
              question: `分支 kiln/${plan.taskId} 已通过验真与审查，是否批准创建外部 PR 或转入外部等待？`,
              options: [
                {
                  id: "opt-return-external",
                  label: "已提交外部 PR，转入外部等待",
                  action: "return_external",
                  recommended: true,
                },
                {
                  id: "opt-finish",
                  label: "直接标记完成",
                  action: "finish",
                  recommended: false,
                },
              ],
              created_at: new Date().toISOString(),
            });
            this.transitionTaskToWaiting(plan.taskId, decision, deliverGuard);
            return;
          }
        }
      }

      if (
        card.contract.deliver.mode === "run_cmd" &&
        card.contract.deliver.cmd
      ) {
        const cmdCwd =
          card.workspace_mode === "git_worktree"
            ? worktreePath
            : this.store.paths.workspaceDir(plan.taskId);
        if (
          !cmdCwd ||
          !fs.existsSync(cmdCwd) ||
          !fs.statSync(cmdCwd).isDirectory()
        ) {
          throw new Error(
            `Delivery command working directory does not exist for task "${plan.taskId}": ${String(cmdCwd)}`,
          );
        }

        const events = this.store.readStateEvents(plan.taskId);
        const approvedCmd = this.hasApprovedDeliverDecision(
          events,
          "external_action_approval",
        );
        if (!approvedCmd && card.contract.external_actions === "ask") {
          const decision = PendingDecisionSchema.parse({
            id: `dec-${randomUUID().slice(0, 8)}`,
            task_id: plan.taskId,
            contract_version: card.contract_version,
            reason: "external_action_approval",
            category: "external_deliver_cmd",
            question: `交付动作需要执行外部命令 \`${card.contract.deliver.cmd}\`，是否批准执行？`,
            options: [
              {
                id: "opt-run-deliver-cmd",
                label: "批准执行交付命令",
                action: "resume",
                target_stage: "deliver",
                recommended: true,
              },
              {
                id: "opt-finish-manual",
                label: "跳过命令并直接完成",
                action: "finish",
                recommended: false,
              },
            ],
            created_at: new Date().toISOString(),
          });
          this.transitionTaskToWaiting(plan.taskId, decision, deliverGuard);
          return;
        }

        const cmdRes = await runIsolatedCommand(card.contract.deliver.cmd, {
          cwd: cmdCwd,
          signal,
        });
        if (
          signal.aborted ||
          !this.isRunStillCurrent(plan.taskId, deliverRunId, plan.contractVersion)
        ) {
          this.syncCaffeinate();
          return;
        }
        if (cmdRes.exitCode !== 0 || cmdRes.timedOut) {
          throw new Error(
            `Delivery command failed (exit=${cmdRes.exitCode}, timedOut=${cmdRes.timedOut})`,
          );
        }
      }

      const delivered = this.completeTaskDelivery(
        plan.taskId,
        deliverRef,
        deliverGuard,
      );

      if (delivered && card.workspace_mode === "git_worktree" && worktreePath) {
        const space = this.store.readSpace(card.space);
        if (space?.repo_path) {
          await cleanupGitWorktree({
            repoPath: space.repo_path,
            worktreePath,
            taskStatus: "done",
            gatePassed: true,
            awaitingHumanReview: false,
          }).catch(() => {});
        }
      }
    });
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
    void this.wake();
    return true;
  }
}
