import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  PRIORITY_RANK,
  PendingDecisionSchema,
  RoleIdSchema,
  calculateCacheNetSavedUsd,
  calculateOrthogonalTurnCostUsd,
  type CardLimits,
  type PendingDecision,
  type PricingConfig,
  type StateEvent,
  type TaskCard,
} from "@kiln/protocol";
import {
  KilnStore,
  assertSafeSegment,
  writeFileAtomic,
  type UsageTurnRow,
} from "../store/index.js";

export const LedgerProposalSchema = z.object({
  schema_version: z.literal(1).default(1),
  id: z.string().min(1),
  task_id: z.string().min(1),
  run_id: z.string().min(1),
  role: RoleIdSchema,
  space: z.string().min(1),
  rule: z.string().min(1),
  rationale: z.string().min(1),
  status: z.literal("pending_confirmation"),
  proposed_at: z.string().min(1),
});
export type LedgerProposal = z.infer<typeof LedgerProposalSchema>;

export const LedgerProposalsFileSchema = z.object({
  schema_version: z.literal(1),
  task_id: z.string().min(1),
  proposals: z.array(LedgerProposalSchema),
});

export interface UsageBucketSummary {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  cacheNetSavedUsd: number;
}

export interface StageUsageBucketSummary extends UsageBucketSummary {
  runCount: number;
  reusedRunCount: number;
}

export interface WarmSessionStats {
  totalImplementRuns: number;
  reusedImplementRuns: number;
  warmCacheHitRate: number;
  coldCacheHitRate: number;
}

export interface UsageSnapshot {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  cacheNetSavedUsd: number;
  unknownPricingModels: string[];
  byAgent: Record<string, UsageBucketSummary>;
  byModel: Record<string, UsageBucketSummary>;
  byStage?: Record<string, StageUsageBucketSummary>;
  byRosterRole?: Record<string, StageUsageBucketSummary>;
  warmSessionStats?: WarmSessionStats;
}

/**
 * Reads a UTF-8 file if present; returns `null` on `ENOENT` and rethrows other errors.
 */
export function readOptionalText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Counts leaf tasks currently in `running` status (parent containers with child tasks do not occupy execution slots).
 */
export function countRunningLeafTasks(store: KilnStore): number {
  const rows = store.listTasks();
  const parentIds = new Set<string>();
  for (const row of rows) {
    if (row.parent_id !== null) {
      parentIds.add(row.parent_id);
    }
  }
  return rows.filter((row) => row.status === "running" && !parentIds.has(row.id)).length;
}

/**
 * Resolves task card limits from explicit overrides, configured `limits.yaml`, or Kiln defaults.
 */
export function resolveCardLimits(store: KilnStore, override?: CardLimits): CardLimits {
  if (override !== undefined) {
    return override;
  }
  const configured = store.readConfig("limits");
  return {
    retries_per_stage: configured?.retries_per_stage ?? 2,
    review_rounds: configured?.review_rounds ?? 2,
    advisor_calls: configured?.advisor_calls ?? 1,
    max_tokens: configured?.max_card_tokens ?? 250_000,
    ...(configured?.max_card_cost_usd !== undefined
      ? { max_cost_usd: configured.max_card_cost_usd }
      : {}),
  };
}

/**
 * Computes token totals, orthogonal 5-field USD cost breakdown, and net cache savings.
 */
export function computeUsageSnapshot(
  turns: readonly UsageTurnRow[],
  pricing: PricingConfig | null,
): UsageSnapshot {
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let costUsd = 0;
  let cacheNetSavedUsd = 0;
  const unknownPricingSet = new Set<string>();

  const byAgent: Record<string, UsageBucketSummary> = {};
  const byModel: Record<string, UsageBucketSummary> = {};
  const byStage: Record<string, StageUsageBucketSummary> = {};
  const byRosterRole: Record<string, StageUsageBucketSummary> = {};
  const stageRuns = new Map<string, Set<string>>();
  const stageReusedRuns = new Map<string, Set<string>>();
  const rosterRuns = new Map<string, Set<string>>();
  const rosterReusedRuns = new Map<string, Set<string>>();
  const implTotalRuns = new Set<string>();
  const implReusedRuns = new Set<string>();
  let warmInputTokens = 0;
  let warmCachedTokens = 0;
  let coldInputTokens = 0;
  let coldCachedTokens = 0;

  const accumulateBucket = (
    map: Record<string, UsageBucketSummary>,
    key: string,
    turn: UsageTurnRow,
    turnCost: number,
    turnSaved: number,
  ): void => {
    const cacheWrite = turn.cache_write_tokens ?? 0;
    const reasoning = turn.reasoning_tokens ?? 0;
    const existing = map[key] ?? {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      cacheNetSavedUsd: 0,
    };
    existing.inputTokens += turn.input_tokens;
    existing.cachedInputTokens += turn.cached_input_tokens;
    existing.cacheWriteTokens += cacheWrite;
    existing.outputTokens += turn.output_tokens;
    existing.reasoningTokens += reasoning;
    existing.totalTokens += turn.input_tokens + cacheWrite + turn.output_tokens;
    existing.costUsd += turnCost;
    existing.cacheNetSavedUsd += turnSaved;
    map[key] = existing;
  };

  const accumulateStageBucket = (
    map: Record<string, StageUsageBucketSummary>,
    runMap: Map<string, Set<string>>,
    reusedMap: Map<string, Set<string>>,
    key: string,
    turn: UsageTurnRow,
    turnCost: number,
    turnSaved: number,
  ): void => {
    accumulateBucket(map, key, turn, turnCost, turnSaved);
    let runsSet = runMap.get(key);
    if (!runsSet) {
      runsSet = new Set<string>();
      runMap.set(key, runsSet);
    }
    runsSet.add(turn.run_id);

    let reusedSet = reusedMap.get(key);
    if (!reusedSet) {
      reusedSet = new Set<string>();
      reusedMap.set(key, reusedSet);
    }
    if (turn.session_reused) {
      reusedSet.add(turn.run_id);
    }
    map[key]!.runCount = runsSet.size;
    map[key]!.reusedRunCount = reusedSet.size;
  };

  for (const turn of turns) {
    const cacheWrite = turn.cache_write_tokens ?? 0;
    const reasoning = turn.reasoning_tokens ?? 0;
    const modelPrice = pricing?.models[turn.model];

    let turnCost = 0;
    let turnSaved = 0;
    if (modelPrice) {
      const orth = {
        uncachedInputTokens: Math.max(0, turn.input_tokens - turn.cached_input_tokens),
        cacheReadTokens: turn.cached_input_tokens,
        cacheWriteTokens: cacheWrite,
        outputTokens: turn.output_tokens,
        reasoningTokens: reasoning,
        reasoningIncludedInOutput: true,
      };
      turnCost = calculateOrthogonalTurnCostUsd(orth, modelPrice, turn.model);
      turnSaved = calculateCacheNetSavedUsd(orth, modelPrice, turn.model);
    } else if (
      typeof turn.provider_cost_usd === "number" &&
      Number.isFinite(turn.provider_cost_usd) &&
      turn.provider_cost_usd >= 0
    ) {
      turnCost = turn.provider_cost_usd;
      turnSaved = 0;
    } else {
      unknownPricingSet.add(turn.model);
    }

    inputTokens += turn.input_tokens;
    cachedInputTokens += turn.cached_input_tokens;
    cacheWriteTokens += cacheWrite;
    outputTokens += turn.output_tokens;
    reasoningTokens += reasoning;
    costUsd += turnCost;
    cacheNetSavedUsd += turnSaved;

    accumulateBucket(byAgent, turn.agent, turn, turnCost, turnSaved);
    accumulateBucket(byModel, turn.model, turn, turnCost, turnSaved);
    if (turn.stage) {
      accumulateStageBucket(
        byStage,
        stageRuns,
        stageReusedRuns,
        turn.stage,
        turn,
        turnCost,
        turnSaved,
      );
      if (turn.stage === "implement") {
        implTotalRuns.add(turn.run_id);
        if (turn.session_reused) {
          implReusedRuns.add(turn.run_id);
          warmInputTokens += turn.input_tokens;
          warmCachedTokens += turn.cached_input_tokens;
        } else {
          coldInputTokens += turn.input_tokens;
          coldCachedTokens += turn.cached_input_tokens;
        }
      }
    }
    if (turn.roster_role) {
      accumulateStageBucket(
        byRosterRole,
        rosterRuns,
        rosterReusedRuns,
        turn.roster_role,
        turn,
        turnCost,
        turnSaved,
      );
    }
  }

  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: inputTokens + cacheWriteTokens + outputTokens,
    costUsd,
    cacheNetSavedUsd,
    unknownPricingModels: Array.from(unknownPricingSet).sort(),
    byAgent,
    byModel,
    byStage,
    byRosterRole,
    warmSessionStats: {
      totalImplementRuns: implTotalRuns.size,
      reusedImplementRuns: implReusedRuns.size,
      warmCacheHitRate:
        warmInputTokens > 0 ? Math.round((warmCachedTokens / warmInputTokens) * 100) : 0,
      coldCacheHitRate:
        coldInputTokens > 0 ? Math.round((coldCachedTokens / coldInputTokens) * 100) : 0,
    },
  };
}

export function pendingDecisionFilePath(store: KilnStore, taskId: string): string {
  const safeTaskId = assertSafeSegment(taskId, "taskId");
  return path.join(store.paths.taskDir(safeTaskId), "pending_decision.json");
}

export function ledgerProposalsFilePath(store: KilnStore, taskId: string): string {
  const safeTaskId = assertSafeSegment(taskId, "taskId");
  return path.join(store.paths.taskDir(safeTaskId), "ledger_proposals.json");
}

/**
 * Reads proposed (unconfirmed) ledger rules stored under `tasks/<id>/ledger_proposals.json`.
 */
export function readLedgerProposals(store: KilnStore, taskId: string): LedgerProposal[] {
  const raw = readOptionalText(ledgerProposalsFilePath(store, taskId));
  if (raw === null) {
    return [];
  }
  const parsed = LedgerProposalsFileSchema.parse(JSON.parse(raw) as unknown);
  return parsed.proposals;
}

/**
 * Atomically records a ledger rule proposal under `tasks/<id>/ledger_proposals.json`
 * without mutating `ledger/<space>.yaml`.
 */
export function appendLedgerProposal(store: KilnStore, proposal: LedgerProposal): LedgerProposal {
  const validated = LedgerProposalSchema.parse(proposal);
  const existing = readLedgerProposals(store, validated.task_id);
  const next = LedgerProposalsFileSchema.parse({
    schema_version: 1,
    task_id: validated.task_id,
    proposals: [...existing, validated],
  });
  writeFileAtomic(
    ledgerProposalsFilePath(store, validated.task_id),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  return validated;
}

/**
 * Disk-backed + in-memory registry for active `PendingDecision` records under
 * `tasks/<id>/pending_decision.json`, surviving daemon restarts and `index.sqlite` rebuilds.
 */
export class PendingDecisionStore {
  private readonly cache = new Map<string, PendingDecision>();

  constructor(private readonly store: KilnStore) {}

  set(decision: PendingDecision): PendingDecision {
    const parsed = PendingDecisionSchema.parse(decision);
    const filePath = pendingDecisionFilePath(this.store, parsed.task_id);
    writeFileAtomic(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
    this.cache.set(parsed.task_id, parsed);
    return parsed;
  }

  private getLatestWaitingEvent(
    taskId: string,
  ): { index: number; event: Extract<StateEvent, { type: "waiting" }> } | null {
    const events = this.store.readStateEvents(taskId);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i];
      if (ev?.type === "waiting") {
        return { index: i, event: ev };
      }
    }
    return null;
  }

  get(taskId: string): PendingDecision | null {
    const safeTaskId = assertSafeSegment(taskId, "taskId");
    const taskRow = this.store.getTaskIndex(safeTaskId);
    if (!taskRow || taskRow.status !== "waiting") {
      this.remove(safeTaskId);
      return null;
    }

    const latest = this.getLatestWaitingEvent(safeTaskId);
    if (latest?.event.reason === "upstream_cancelled") {
      return this.ensureUpstreamCancelledDecision(safeTaskId);
    }

    let decision = this.cache.get(safeTaskId) ?? null;
    if (decision === null) {
      const raw = readOptionalText(pendingDecisionFilePath(this.store, safeTaskId));
      if (raw === null) {
        return null;
      }
      decision = PendingDecisionSchema.parse(JSON.parse(raw) as unknown);
      if (decision.task_id !== safeTaskId) {
        throw new Error(
          `Corrupted pending_decision.json for "${safeTaskId}": task_id is "${decision.task_id}"`,
        );
      }
      this.cache.set(safeTaskId, decision);
    }

    if (
      decision.contract_version !== taskRow.contract_version ||
      (latest?.event.decision_id !== undefined && decision.id !== latest.event.decision_id)
    ) {
      this.remove(safeTaskId);
      return null;
    }

    return decision;
  }

  /**
   * Rebinds an active waiting task's `PendingDecision` to a bumped `contract_version`
   * (or refreshes an `upstream_cancelled` decision), preventing contract updates from
   * stranding a waiting task without a pending decision.
   */
  rebindContractVersion(taskId: string, newContractVersion: number): PendingDecision | null {
    const safeTaskId = assertSafeSegment(taskId, "taskId");
    const taskRow = this.store.getTaskIndex(safeTaskId);
    if (!taskRow || taskRow.status !== "waiting") {
      this.remove(safeTaskId);
      return null;
    }

    const latest = this.getLatestWaitingEvent(safeTaskId);
    if (latest?.event.reason === "upstream_cancelled") {
      return this.ensureUpstreamCancelledDecision(safeTaskId);
    }

    let existing = this.cache.get(safeTaskId) ?? null;
    if (existing === null) {
      const raw = readOptionalText(pendingDecisionFilePath(this.store, safeTaskId));
      if (raw === null) {
        return null;
      }
      existing = PendingDecisionSchema.parse(JSON.parse(raw) as unknown);
      if (existing.task_id !== safeTaskId) {
        throw new Error(
          `Corrupted pending_decision.json for "${safeTaskId}": task_id is "${existing.task_id}"`,
        );
      }
    }

    if (latest?.event.decision_id !== undefined && existing.id !== latest.event.decision_id) {
      this.remove(safeTaskId);
      return null;
    }

    return this.set({
      ...existing,
      contract_version: newContractVersion,
    });
  }

  /**
   * Ensures a deterministic `PendingDecision` exists on disk for a `waiting` task
   * blocked by `upstream_cancelled`, without recursing into `get()`.
   */
  ensureUpstreamCancelledDecision(taskId: string, createdAt?: string): PendingDecision | null {
    const safeTaskId = assertSafeSegment(taskId, "taskId");
    const taskRow = this.store.getTaskIndex(safeTaskId);
    const card = readTaskCardOptional(this.store, safeTaskId);
    if (!taskRow || taskRow.status !== "waiting" || !card) {
      return null;
    }

    const latest = this.getLatestWaitingEvent(safeTaskId);
    if (!latest || latest.event.reason !== "upstream_cancelled") {
      return null;
    }

    const cancelledDeps = card.depends_on.filter(
      (depId) => this.store.getTaskIndex(depId)?.status === "cancelled",
    );
    const depsText =
      cancelledDeps.length > 0
        ? `前置任务 (${cancelledDeps.join(", ")}) 已取消`
        : "上游前置任务已取消";
    const decisionId =
      latest.event.decision_id ??
      `dec-upstream-${safeTaskId}-v${card.contract_version}-${latest.index}`;
    const question = `${depsText}，请选择解绑已取消前置并继续推进，或一并取消当前任务 "${safeTaskId}"。`;

    let existing = this.cache.get(safeTaskId) ?? null;
    if (existing === null) {
      const existingRaw = readOptionalText(pendingDecisionFilePath(this.store, safeTaskId));
      if (existingRaw !== null) {
        existing = PendingDecisionSchema.parse(JSON.parse(existingRaw) as unknown);
        if (existing.task_id !== safeTaskId) {
          throw new Error(
            `Corrupted pending_decision.json for "${safeTaskId}": task_id is "${existing.task_id}"`,
          );
        }
      }
    }

    if (
      existing !== null &&
      existing.id === decisionId &&
      existing.contract_version === card.contract_version &&
      existing.reason === "upstream_cancelled" &&
      existing.question === question
    ) {
      this.cache.set(safeTaskId, existing);
      return existing;
    }

    const effectiveCreatedAt =
      createdAt ??
      (existing?.id === decisionId ? existing.created_at : undefined) ??
      latest.event.at;

    const decision = PendingDecisionSchema.parse({
      id: decisionId,
      task_id: safeTaskId,
      contract_version: card.contract_version,
      reason: "upstream_cancelled",
      category: "upstream_cancelled",
      question,
      options: [
        {
          id: "unbind_resume",
          label: "解绑已取消前置并继续推进",
          action: "resume",
          recommended: true,
        },
        {
          id: "cancel_downstream",
          label: "一并取消当前任务",
          action: "cancel",
          recommended: false,
        },
      ],
      created_at: effectiveCreatedAt,
    });

    return this.set(decision);
  }

  remove(taskId: string): void {
    const safeTaskId = assertSafeSegment(taskId, "taskId");
    this.cache.delete(safeTaskId);
    fs.rmSync(pendingDecisionFilePath(this.store, safeTaskId), { force: true });
  }

  hydrateFromDisk(): void {
    this.cache.clear();
    for (const row of this.store.listTasks({ status: "waiting" })) {
      this.get(row.id);
    }
  }

  listAll(): PendingDecision[] {
    const waitingTasks = this.store.listTasks({ status: "waiting" });
    const priorityByTask = new Map(waitingTasks.map((row) => [row.id, row.effective_priority]));
    const items: PendingDecision[] = [];

    for (const row of waitingTasks) {
      const decision = this.get(row.id);
      if (decision !== null) {
        items.push(decision);
      }
    }

    items.sort((a, b) => {
      const pa = PRIORITY_RANK[priorityByTask.get(a.task_id) ?? "P3"];
      const pb = PRIORITY_RANK[priorityByTask.get(b.task_id) ?? "P3"];
      if (pa !== pb) {
        return pa - pb;
      }
      return a.created_at.localeCompare(b.created_at);
    });

    return items;
  }
}

/**
 * Helper to read a task card safely, returning `null` if the task does not exist on disk.
 */
export function readTaskCardOptional(store: KilnStore, taskId: string): TaskCard | null {
  try {
    return store.readTaskCard(taskId);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}
