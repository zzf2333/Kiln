import type { RunEvent, RunMeta, SessionRef, StageId, TaskStatus } from "@kiln/protocol";
import type { BackendRegistry } from "../backend/index.js";
import { deriveTaskStatus, type KilnStore } from "../store/index.js";

export interface ReconcileScannedRunDir {
  dirName: string;
  meta: RunMeta | null;
  hasReceipt: boolean;
  rateLimited: boolean;
}

export interface OrchestratorReconcileContext {
  store: KilnStore;
  backendRegistry: BackendRegistry;
  syncAgentCapabilities: () => Promise<void>;
  listTaskRunDirs: (taskId: string) => ReconcileScannedRunDir[];
  finalizePlanRun: (taskId: string, runDirName: string, runMeta: RunMeta) => Promise<void>;
  finalizeResearchRun: (taskId: string, runDirName: string, runMeta: RunMeta) => Promise<void>;
  finalizeWorkerRun: (
    taskId: string,
    runDirName: string,
    runMeta: RunMeta,
    exitEvent: Extract<RunEvent, { kind: "exit" }> | null,
  ) => Promise<void>;
  finalizeVerifyAgentRun: (
    taskId: string,
    runDirName: string,
    runMeta: RunMeta,
    exitEvent: Extract<RunEvent, { kind: "exit" }> | null,
  ) => Promise<void>;
  finalizeReviewerRun: (
    taskId: string,
    runDirName: string,
    runMeta: RunMeta,
    exitEvent: Extract<RunEvent, { kind: "exit" }> | null,
  ) => Promise<void>;
  finalizeVerifierRun: (taskId: string, runDirName: string, runMeta: RunMeta) => Promise<void>;
  finalizeTriageRun: (taskId: string, runDirName: string, runMeta: RunMeta) => Promise<void>;
  finalizeAdvisorRun: (taskId: string, runDirName: string, runMeta: RunMeta) => Promise<void>;
  finalizeDeliverAgentRun: (taskId: string, runDirName: string, runMeta: RunMeta) => Promise<void>;
  attachSessionConsumer: (
    taskId: string,
    runDirName: string,
    runMeta: RunMeta,
    backend: ReturnType<BackendRegistry["get"]>,
    sessionRef: SessionRef,
  ) => void;
  publishTaskUpdated: (
    taskId: string,
    patch: {
      status?: TaskStatus;
      stage?: StageId;
      round?: number;
      contractVersion?: number;
    },
  ) => void;
  syncCaffeinate: () => void;
}

/**
 * Startup reconciliation (`reconcileOnStart()`):
 * Inspects all `running` tasks and active `stage_leases` after daemon restart or
 * `index.sqlite` rebuild. Reattaches live backend sessions, converges unfinalized
 * receipts, or safely returns orphaned runs back to `queued` without disturbing `paused`.
 */
export async function reconcileOrchestratorOnStart(
  ctx: OrchestratorReconcileContext,
): Promise<void> {
  await ctx.syncAgentCapabilities();

  const runningTasks = ctx.store.listTasks({ status: "running" });
  const activeLeases = ctx.store.listActiveStageLeases();
  const candidateTaskIds = new Set<string>([
    ...runningTasks.map((t) => t.id),
    ...activeLeases.map((l) => l.task_id),
  ]);

  for (const taskId of candidateTaskIds) {
    const card = ctx.store.readTaskCard(taskId);
    const events = ctx.store.readStateEvents(taskId);
    const derived = deriveTaskStatus(card, events);
    if (derived.status !== "running") {
      // Never touch paused/waiting/terminal tasks; ensure orphan lease is expired.
      ctx.store.sqlite.expireActiveLeaseByTask(taskId, new Date().toISOString(), "expired");
      continue;
    }

    const activeRunId = derived.activeRunId;
    const runDirs = ctx.listTaskRunDirs(taskId);
    const matchingRun = activeRunId
      ? runDirs.find((r) => r.meta?.run_id === activeRunId)
      : undefined;

    // Deterministic kernel verify/deliver operations (no RUN.yaml) expire and re-queue cleanly.
    // Agent-mode verify (`tester`) / deliver (`deliverer`) runs have RUN.yaml and fall through.
    if ((derived.stage === "verify" || derived.stage === "deliver") && !matchingRun) {
      const now = new Date().toISOString();
      ctx.store.sqlite.expireActiveLeaseByTask(taskId, now, "expired");
      ctx.store.appendStateEvent(taskId, { type: "queued", at: now });
      ctx.publishTaskUpdated(taskId, {
        status: "queued",
        stage: derived.stage,
        contractVersion: derived.contractVersion,
      });
      continue;
    }

    if (
      !matchingRun ||
      !matchingRun.meta ||
      matchingRun.meta.contract_version !== derived.contractVersion
    ) {
      const now = new Date().toISOString();
      ctx.store.sqlite.expireActiveLeaseByTask(taskId, now, "expired");
      ctx.store.appendStateEvent(taskId, { type: "queued", at: now });
      ctx.publishTaskUpdated(taskId, { status: "queued" });
      continue;
    }

    const runMeta = matchingRun.meta;
    if (matchingRun.hasReceipt) {
      try {
        switch (runMeta.stage) {
          case "plan":
            await ctx.finalizePlanRun(taskId, matchingRun.dirName, runMeta);
            break;
          case "research":
            await ctx.finalizeResearchRun(taskId, matchingRun.dirName, runMeta);
            break;
          case "implement":
            await ctx.finalizeWorkerRun(taskId, matchingRun.dirName, runMeta, null);
            break;
          case "verify":
            await ctx.finalizeVerifyAgentRun(taskId, matchingRun.dirName, runMeta, null);
            break;
          case "review":
            await ctx.finalizeReviewerRun(taskId, matchingRun.dirName, runMeta, null);
            break;
          case "accept":
            await ctx.finalizeVerifierRun(taskId, matchingRun.dirName, runMeta);
            break;
          case "triage":
            await ctx.finalizeTriageRun(taskId, matchingRun.dirName, runMeta);
            break;
          case "advise":
            await ctx.finalizeAdvisorRun(taskId, matchingRun.dirName, runMeta);
            break;
          case "deliver":
            await ctx.finalizeDeliverAgentRun(taskId, matchingRun.dirName, runMeta);
            break;
          default: {
            const now = new Date().toISOString();
            ctx.store.sqlite.expireActiveLeaseByTask(taskId, now, "expired");
            ctx.store.appendStateEvent(taskId, { type: "queued", at: now });
            ctx.publishTaskUpdated(taskId, { status: "queued" });
            break;
          }
        }
      } catch {
        ctx.store.sqlite.expireActiveLeaseByTask(taskId, new Date().toISOString(), "expired");
      }
      const afterFinalize = deriveTaskStatus(
        ctx.store.readTaskCard(taskId),
        ctx.store.readStateEvents(taskId),
      );
      if (afterFinalize.status === "running" && afterFinalize.activeRunId === runMeta.run_id) {
        const now = new Date().toISOString();
        ctx.store.sqlite.expireActiveLeaseByTask(taskId, now, "expired");
        ctx.store.appendStateEvent(taskId, { type: "queued", at: now });
        ctx.publishTaskUpdated(taskId, {
          status: "queued",
          ...(afterFinalize.stage !== null ? { stage: afterFinalize.stage } : {}),
          contractVersion: afterFinalize.contractVersion,
        });
      }
      continue;
    }

    const lease = ctx.store.getStageLease(taskId);
    if (!lease || lease.state !== "active" || lease.run_id !== runMeta.run_id) {
      const now = new Date().toISOString();
      ctx.store.appendStateEvent(taskId, { type: "queued", at: now });
      ctx.publishTaskUpdated(taskId, { status: "queued" });
      continue;
    }

    if (!ctx.backendRegistry.has(runMeta.backend_id)) {
      const now = new Date().toISOString();
      ctx.store.sqlite.expireActiveLeaseByTask(taskId, now, "expired");
      ctx.store.appendStateEvent(taskId, { type: "queued", at: now });
      ctx.publishTaskUpdated(taskId, { status: "queued" });
      continue;
    }

    const backend = ctx.backendRegistry.get(runMeta.backend_id);
    let aliveRunning = false;
    try {
      const probe = await backend.probe(runMeta.session_ref);
      aliveRunning = probe.alive && probe.status === "running";
    } catch {
      aliveRunning = false;
    }

    if (aliveRunning) {
      ctx.attachSessionConsumer(taskId, matchingRun.dirName, runMeta, backend, runMeta.session_ref);
    } else {
      const now = new Date().toISOString();
      ctx.store.sqlite.expireActiveLeaseByTask(taskId, now, "expired");
      ctx.store.appendStateEvent(taskId, { type: "queued", at: now });
      ctx.publishTaskUpdated(taskId, { status: "queued" });
    }
  }

  ctx.syncCaffeinate();
}
