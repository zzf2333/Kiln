import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  PRIORITY_RANK,
  PendingDecisionSchema,
  RoleIdSchema,
  calculateTurnCostUsd,
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
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface UsageSnapshot {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  byAgent: Record<string, UsageBucketSummary>;
  byModel: Record<string, UsageBucketSummary>;
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
  };
}

/**
 * Computes token totals and USD cost breakdown using `@kiln/protocol`'s `calculateTurnCostUsd`.
 */
export function computeUsageSnapshot(
  turns: readonly UsageTurnRow[],
  pricing: PricingConfig | null,
): UsageSnapshot {
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;

  const byAgent: Record<string, UsageBucketSummary> = {};
  const byModel: Record<string, UsageBucketSummary> = {};

  const accumulateBucket = (
    map: Record<string, UsageBucketSummary>,
    key: string,
    turn: UsageTurnRow,
    turnCost: number,
  ): void => {
    const existing = map[key] ?? {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    };
    existing.inputTokens += turn.input_tokens;
    existing.cachedInputTokens += turn.cached_input_tokens;
    existing.outputTokens += turn.output_tokens;
    existing.totalTokens += turn.input_tokens + turn.output_tokens;
    existing.costUsd += turnCost;
    map[key] = existing;
  };

  for (const turn of turns) {
    const modelPrice = pricing?.models[turn.model];
    const turnCost = modelPrice
      ? calculateTurnCostUsd(
          {
            inputTokens: turn.input_tokens,
            cachedInputTokens: turn.cached_input_tokens,
            outputTokens: turn.output_tokens,
          },
          modelPrice,
        )
      : 0;

    inputTokens += turn.input_tokens;
    cachedInputTokens += turn.cached_input_tokens;
    outputTokens += turn.output_tokens;
    costUsd += turnCost;

    accumulateBucket(byAgent, turn.agent, turn, turnCost);
    accumulateBucket(byModel, turn.model, turn, turnCost);
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd,
    byAgent,
    byModel,
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
export function appendLedgerProposal(
  store: KilnStore,
  proposal: LedgerProposal,
): LedgerProposal {
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
  rebindContractVersion(
    taskId: string,
    newContractVersion: number,
  ): PendingDecision | null {
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
  ensureUpstreamCancelledDecision(
    taskId: string,
    createdAt?: string,
  ): PendingDecision | null {
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
