import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  CardContractSchema,
  DecisionActionSchema,
  DecisionRecordSchema,
  PendingDecisionSchema,
  PrioritySchema,
  StageIdSchema,
  TaskCardSchema,
  ensureWorkflowIncludesReview,
  serializeFrontmatterMarkdown,
  type CardContract,
  type DecisionAction,
  type DecisionOption,
  type DecisionRecord,
  type LedgerEntry,
  type PendingDecision,
  type Priority,
  type StageId,
  type StateEvent,
  type TaskCard,
  type TaskStatus,
} from "@kiln/protocol";
import {
  KilnStore,
  deriveTaskStatus,
  writeFileAtomic,
  writeYamlAtomic,
  type DerivedTaskState,
} from "../store/index.js";
import {
  computeEffectivePriorities,
  findQueuedDownstreamTasks,
  validateDependsOnGraph,
  type DownstreamGraphNode,
  type PriorityGraphNode,
} from "./dag.js";
import {
  InvalidStateTransitionError,
  UnsupportedTrackError,
  assertValidTransition,
  getTaskPipelineStages,
  getTrackStages,
} from "./transitions.js";

export interface ContractUpdateInput {
  contractPatch: Partial<CardContract>;
  affectedStages: StageId[];
  acceptFilesHash?: string;
}

export interface ApplyDecisionInput {
  taskId: string;
  decision: PendingDecision;
  optionId: string;
  decider?: "human" | "triage" | "advisor" | "kernel";
  rationale?: string;
  affectedStages?: StageId[];
  contractUpdate?: ContractUpdateInput;
  unbindCancelledDependencies?: boolean;
  now?: string;
}

export interface ApplyDecisionResult {
  state: DerivedTaskState;
  action: DecisionAction;
  decisionRecord: DecisionRecord;
  contractVersion?: number;
  archivedReceipts?: string[];
  ledgerEntry?: LedgerEntry;
  waitingDownstreamTaskIds: string[];
  unboundDependencyIds?: string[];
}

export interface CreateTaskResult {
  card: TaskCard;
  state: DerivedTaskState;
  effectivePriority: Priority;
}

export interface CancelTaskResult {
  state: DerivedTaskState;
  waitingDownstreamTaskIds: string[];
}

export interface ChangePriorityResult {
  state: DerivedTaskState;
  effectivePriorities: Map<string, Priority>;
}

export interface UnbindDependencyResult {
  taskId: string;
  removedDependencyId: string;
  dependsOn: string[];
  effectivePriority: Priority;
}

export interface UpdateContractInput {
  taskId: string;
  contractPatch: Partial<CardContract>;
  affectedStages: StageId[];
  acceptFilesHash?: string;
  now?: string;
}

export interface UpdateContractResult {
  state: DerivedTaskState;
  newVersion: number;
  archivedReceipts: string[];
}

const ACTION_TO_STATUS: Readonly<Record<DecisionAction, TaskStatus>> = {
  resume: "queued",
  return_external: "external",
  finish: "done",
  cancel: "cancelled",
};

const STAGE_ORDER: Readonly<Record<StageId, number>> = {
  intake: 0,
  plan: 1,
  research: 2,
  implement: 3,
  verify: 4,
  review: 5,
  accept: 6,
  triage: 7,
  advise: 8,
  deliver: 9,
};

function readFileOptionalUtf8(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw err;
  }
}

function formatDecisionEntryMarkdown(
  decision: PendingDecision,
  selectedOption: DecisionOption,
  record: DecisionRecord,
): string {
  const optionsLines = decision.options.map((opt) => {
    const marker = opt.id === selectedOption.id ? "[已选]" : "[备选]";
    const rec = opt.recommended ? " (推荐)" : "";
    const cost = opt.cost_note ? ` — 代价: ${opt.cost_note}` : "";
    return `- ${marker} \`${opt.id}\`${rec} (${opt.action}): ${opt.label}${cost}`;
  });

  const stagesText =
    record.affected_stages.length > 0 ? record.affected_stages.join(", ") : "无";

  const bodyLines = [
    `## 待决问题 (${decision.id})`,
    "",
    `- 原因: ${decision.reason}`,
    `- 问题: ${decision.question}`,
    "",
    "### 选项与代价",
    "",
    ...optionsLines,
    "",
    "### 最终决定与重跑范围",
    "",
    `- 选中项: \`${selectedOption.id}\` — ${selectedOption.label}`,
    `- 动作: \`${record.action}\``,
    `- 决策方: \`${record.decider}\``,
    `- 受影响阶段: ${stagesText}`,
    `- 说明: ${record.rationale}`,
  ];

  const frontmatter: Record<string, unknown> = {
    schema_version: record.schema_version,
    id: record.id,
    task_id: record.task_id,
    contract_version: record.contract_version,
    category: record.category,
    decider: record.decider,
    action: record.action,
    ...(record.chosen_option_id !== undefined
      ? { chosen_option_id: record.chosen_option_id }
      : {}),
    affected_stages: record.affected_stages,
    ...(record.ledger_proposal !== undefined
      ? { ledger_proposal: record.ledger_proposal }
      : {}),
    rationale: record.rationale,
    decided_at: record.decided_at,
  };

  return serializeFrontmatterMarkdown(frontmatter, bodyLines.join("\n"));
}

/**
 * Deterministic task state machine built directly over `KilnStore`.
 * Guarantees DAG acyclicity, strict 6+1 transitions, paused isolation,
 * `upstream_cancelled` propagation, and decision/ledger separation.
 */
export class TaskStateMachine {
  constructor(private readonly store: KilnStore) {}

  private requireTaskState(taskId: string): {
    card: TaskCard;
    events: StateEvent[];
    derived: DerivedTaskState;
  } {
    let card: TaskCard;
    try {
      card = this.store.readTaskCard(taskId);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Unknown task "${taskId}"`);
      }
      throw err;
    }
    const events = this.store.readStateEvents(taskId);
    const derived = deriveTaskStatus(card, events);
    return { card, events, derived };
  }

  private loadDependencyMap(): Map<string, readonly string[]> {
    const deps = new Map<string, readonly string[]>();
    for (const row of this.store.listTasks()) {
      const card = this.store.readTaskCard(row.id);
      deps.set(row.id, card.depends_on);
    }
    return deps;
  }

  private cascadeUpstreamCancelled(
    cancelledTaskId: string,
    timestamp: string,
  ): string[] {
    const nodes = new Map<string, DownstreamGraphNode>();
    for (const row of this.store.listTasks()) {
      const card = this.store.readTaskCard(row.id);
      nodes.set(row.id, {
        status: row.status,
        dependsOn: card.depends_on,
      });
    }

    const downstreamIds = findQueuedDownstreamTasks(nodes, cancelledTaskId);
    for (const downstreamId of downstreamIds) {
      assertValidTransition("queued", "waiting");
      this.store.appendStateEvent(downstreamId, {
        type: "waiting",
        at: timestamp,
        reason: "upstream_cancelled",
      });
    }
    return downstreamIds;
  }

  /**
   * Recomputes `effective_priority` across the full task dependency graph and updates
   * SQLite `tasks_index` atomically while preserving each unchanged task's `updated_at`.
   */
  syncAllEffectivePriorities(): Map<string, Priority> {
    const rows = this.store.listTasks();
    const nodes = new Map<string, PriorityGraphNode>();

    for (const row of rows) {
      const card = this.store.readTaskCard(row.id);
      nodes.set(row.id, {
        priority: row.priority,
        status: row.status,
        dependsOn: card.depends_on,
      });
    }

    const effectivePriorities = computeEffectivePriorities(nodes);

    this.store.sqlite.transaction(() => {
      for (const row of rows) {
        const nextEffective = effectivePriorities.get(row.id) ?? row.priority;
        if (nextEffective !== row.effective_priority) {
          this.store.sqlite.updateTaskStatusAndPriority(row.id, {
            effective_priority: nextEffective,
            updated_at: row.updated_at,
          });
        }
      }
    });

    return effectivePriorities;
  }

  private getCancelledDependencies(dependsOn: readonly string[]): string[] {
    return dependsOn.filter(
      (depId) => this.store.getTaskIndex(depId)?.status === "cancelled",
    );
  }

  /**
   * Validates track support, DAG acyclicity, and prerequisite existence before persisting
   * a new task and recalculating inherited effective priorities.
   */
  createTask(card: TaskCard, briefMarkdown: string): CreateTaskResult {
    const parsed = TaskCardSchema.parse(card);
    getTrackStages(parsed.track, parsed.contract.human_accept);
    getTaskPipelineStages(parsed);

    if (this.store.getTaskIndex(parsed.id) !== null) {
      throw new Error(`Task "${parsed.id}" already exists`);
    }

    const existingDeps = this.loadDependencyMap();
    validateDependsOnGraph(existingDeps, parsed.id, parsed.depends_on, {
      requireExistingDeps: true,
    });

    this.store.createTask(parsed, briefMarkdown);
    let state = deriveTaskStatus(parsed, this.store.readStateEvents(parsed.id));
    if (this.getCancelledDependencies(parsed.depends_on).length > 0) {
      assertValidTransition("queued", "waiting");
      state = this.store.appendStateEvent(parsed.id, {
        type: "waiting",
        at: parsed.created_at,
        reason: "upstream_cancelled",
      });
    }
    const effectivePriorities = this.syncAllEffectivePriorities();

    return {
      card: parsed,
      state,
      effectivePriority: effectivePriorities.get(parsed.id) ?? parsed.priority,
    };
  }

  /**
   * Manually pauses a `queued` or `running` task.
   * Preserves current stage context and never writes to `waiting`, `decisions.md`, or `ledger/`.
   */
  pauseTask(taskId: string, reason?: string, now?: string): DerivedTaskState {
    const { derived } = this.requireTaskState(taskId);
    assertValidTransition(derived.status, "paused");

    const timestamp = now ?? new Date().toISOString();
    const nextState = this.store.appendStateEvent(taskId, {
      type: "paused",
      at: timestamp,
      ...(derived.stage !== null ? { stage: derived.stage } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });

    this.syncAllEffectivePriorities();
    return nextState;
  }

  /**
   * Resumes a `paused` or `external` task back to `queued` at its preserved (or explicit target) stage,
   * or enters `waiting(upstream_cancelled)` if a prerequisite was cancelled while paused/external.
   */
  resumeTask(taskId: string, now?: string, targetStage?: StageId): DerivedTaskState {
    const { card, derived } = this.requireTaskState(taskId);
    if (derived.status !== "paused" && derived.status !== "external") {
      throw new InvalidStateTransitionError(derived.status, "queued");
    }
    assertValidTransition(derived.status, "queued");

    const stages = getTaskPipelineStages(card, derived.track);
    const stageToResume =
      targetStage !== undefined
        ? StageIdSchema.parse(targetStage)
        : (derived.stage ?? stages[0]);
    if (!stageToResume) {
      throw new Error(`No stage available to resume task "${taskId}"`);
    }

    const timestamp = now ?? new Date().toISOString();
    let nextState = this.store.appendStateEvent(taskId, {
      type: "resumed",
      at: timestamp,
      stage: stageToResume,
    });

    if (this.getCancelledDependencies(card.depends_on).length > 0) {
      assertValidTransition("queued", "waiting");
      nextState = this.store.appendStateEvent(taskId, {
        type: "waiting",
        at: timestamp,
        reason: "upstream_cancelled",
      });
    }

    this.syncAllEffectivePriorities();
    return nextState;
  }

  /**
   * Marks an `external` task as manually completed (`done`).
   */
  completeExternalTask(
    taskId: string,
    deliverRef?: string,
    now?: string,
  ): DerivedTaskState {
    const { derived } = this.requireTaskState(taskId);
    if (derived.status !== "external") {
      throw new InvalidStateTransitionError(derived.status, "done");
    }
    assertValidTransition(derived.status, "done");

    const timestamp = now ?? new Date().toISOString();
    const trimmedDeliverRef = deliverRef?.trim();
    const nextState = this.store.appendStateEvent(taskId, {
      type: "done",
      at: timestamp,
      deliver_ref:
        trimmedDeliverRef && trimmedDeliverRef.length > 0
          ? trimmedDeliverRef
          : "manual_external_completed",
    });

    this.syncAllEffectivePriorities();
    return nextState;
  }

  /**
   * Updates task contract via the state machine: rejects terminal tasks, requires non-empty
   * `affectedStages`, bumps `contract_version`, expires active leases, rolls back `running`
   * tasks to `queued` (or `waiting(upstream_cancelled)` when prerequisites were cancelled),
   * and recalculates effective priorities.
   */
  updateContract(input: UpdateContractInput): UpdateContractResult {
    const { derived } = this.requireTaskState(input.taskId);
    if (derived.status === "done" || derived.status === "cancelled") {
      throw new Error(
        `Cannot update contract of terminal task "${input.taskId}" in status "${derived.status}"`,
      );
    }
    if (input.affectedStages.length === 0) {
      throw new Error("Invalid affectedStages: at least one stage is required");
    }

    const timestamp = input.now ?? new Date().toISOString();
    const bump = this.store.bumpContractVersion({
      taskId: input.taskId,
      contractPatch: input.contractPatch,
      affectedStages: input.affectedStages,
      ...(input.acceptFilesHash !== undefined
        ? { acceptFilesHash: input.acceptFilesHash }
        : {}),
      now: timestamp,
    });

    const updatedCard = this.store.readTaskCard(input.taskId);
    let nextState = deriveTaskStatus(updatedCard, this.store.readStateEvents(input.taskId));
    if (
      nextState.status === "queued" &&
      this.getCancelledDependencies(updatedCard.depends_on).length > 0
    ) {
      assertValidTransition("queued", "waiting");
      nextState = this.store.appendStateEvent(input.taskId, {
        type: "waiting",
        at: timestamp,
        reason: "upstream_cancelled",
      });
    }

    this.syncAllEffectivePriorities();
    return {
      state: nextState,
      newVersion: bump.newVersion,
      archivedReceipts: bump.archivedReceipts,
    };
  }

  /**
   * Cancels any non-terminal task, moves direct `queued` dependents to `waiting`
   * with `reason: "upstream_cancelled"`, and recomputes effective priorities.
   */
  cancelTask(taskId: string, reason?: string, now?: string): CancelTaskResult {
    const { derived } = this.requireTaskState(taskId);
    assertValidTransition(derived.status, "cancelled");

    const timestamp = now ?? new Date().toISOString();
    const nextState = this.store.appendStateEvent(taskId, {
      type: "cancelled",
      at: timestamp,
      ...(reason !== undefined ? { reason } : {}),
    });

    const waitingDownstreamTaskIds = this.cascadeUpstreamCancelled(taskId, timestamp);
    this.syncAllEffectivePriorities();

    return {
      state: nextState,
      waitingDownstreamTaskIds,
    };
  }

  /**
   * Updates priority for any non-terminal task and propagates effective priorities across the DAG.
   */
  changePriority(
    taskId: string,
    newPriority: Priority,
    now?: string,
  ): ChangePriorityResult {
    const parsedPriority = PrioritySchema.parse(newPriority);
    const { derived } = this.requireTaskState(taskId);

    if (derived.status === "done" || derived.status === "cancelled") {
      throw new Error(
        `Cannot change priority of terminal task "${taskId}" in status "${derived.status}"`,
      );
    }

    const timestamp = now ?? new Date().toISOString();
    const nextState = this.store.appendStateEvent(taskId, {
      type: "priority_changed",
      at: timestamp,
      from: derived.priority,
      to: parsedPriority,
    });

    const effectivePriorities = this.syncAllEffectivePriorities();
    return {
      state: nextState,
      effectivePriorities,
    };
  }

  /**
   * Transitions a task into `waiting` for a validated `PendingDecision`.
   */
  requestDecision(
    taskId: string,
    decision: PendingDecision,
    now?: string,
  ): DerivedTaskState {
    const parsedDecision = PendingDecisionSchema.parse(decision);
    if (parsedDecision.task_id !== taskId) {
      throw new Error(
        `PendingDecision task_id "${parsedDecision.task_id}" does not match "${taskId}"`,
      );
    }

    const { derived } = this.requireTaskState(taskId);
    assertValidTransition(derived.status, "waiting");

    if (parsedDecision.contract_version !== derived.contractVersion) {
      throw new Error(
        `PendingDecision contract_version (${parsedDecision.contract_version}) does not match current task contract_version (${derived.contractVersion})`,
      );
    }

    const timestamp = now ?? new Date().toISOString();
    const nextState = this.store.appendStateEvent(taskId, {
      type: "waiting",
      at: timestamp,
      reason: parsedDecision.reason,
      decision_id: parsedDecision.id,
    });

    this.syncAllEffectivePriorities();
    return nextState;
  }

  /**
   * Applies an explicit human/judgment decision to a `waiting` task:
   * - Validates option membership & explicit action enum (`resume | return_external | finish | cancel`).
   * - Atomically records the decision in `decisions.md`.
   * - Writes to `ledger/<space>.yaml` ONLY when the chosen option has a non-empty `ledger_rule`.
   * - Bumps `contract_version` and archives superseded receipts if `contractUpdate` is supplied.
   * - Cascades `upstream_cancelled` to queued dependents when `action === "cancel"`.
   */
  applyDecision(input: ApplyDecisionInput): ApplyDecisionResult {
    const parsedDecision = PendingDecisionSchema.parse(input.decision);
    if (parsedDecision.task_id !== input.taskId) {
      throw new Error(
        `PendingDecision task_id "${parsedDecision.task_id}" does not match "${input.taskId}"`,
      );
    }

    const { card, events, derived } = this.requireTaskState(input.taskId);
    if (derived.status !== "waiting") {
      throw new InvalidStateTransitionError(
        derived.status,
        ACTION_TO_STATUS.resume,
      );
    }

    if (parsedDecision.contract_version !== derived.contractVersion) {
      throw new Error(
        `PendingDecision contract_version (${parsedDecision.contract_version}) does not match current task contract_version (${derived.contractVersion})`,
      );
    }

    const latestWaitingEvent = [...events]
      .reverse()
      .find((ev): ev is Extract<StateEvent, { type: "waiting" }> => ev.type === "waiting");
    if (
      latestWaitingEvent?.decision_id !== undefined &&
      latestWaitingEvent.decision_id !== parsedDecision.id
    ) {
      throw new Error(
        `Task "${input.taskId}" is waiting on decision "${latestWaitingEvent.decision_id}", cannot apply "${parsedDecision.id}"`,
      );
    }

    const selectedOption = parsedDecision.options.find(
      (opt) => opt.id === input.optionId,
    );
    if (!selectedOption) {
      throw new Error(
        `Decision option "${input.optionId}" does not exist in decision "${parsedDecision.id}"`,
      );
    }

    const action = DecisionActionSchema.parse(selectedOption.action);
    const targetStatus = ACTION_TO_STATUS[action];
    assertValidTransition(derived.status, targetStatus);

    if (input.contractUpdate !== undefined) {
      if (input.contractUpdate.affectedStages.length === 0) {
        throw new Error("Invalid affectedStages: at least one stage is required");
      }
      const patch = input.contractUpdate.contractPatch;
      if (patch.accept_cmd !== undefined && patch.accept_cmd !== card.contract.accept_cmd) {
        const suppliedHash = input.contractUpdate.acceptFilesHash ?? patch.accept_files_hash;
        if (suppliedHash === undefined || suppliedHash === card.contract.accept_files_hash) {
          throw new Error(
            `Cannot update contract.accept_cmd for task "${input.taskId}" without supplying a new accept_files_hash`,
          );
        }
      }
      CardContractSchema.parse({
        ...card.contract,
        ...patch,
        ...(input.contractUpdate.acceptFilesHash !== undefined
          ? { accept_files_hash: input.contractUpdate.acceptFilesHash }
          : {}),
      });
    }

    const timestamp = input.now ?? new Date().toISOString();
    const trimmedLedgerRule = selectedOption.ledger_rule?.trim();
    const ledgerRule =
      trimmedLedgerRule !== undefined && trimmedLedgerRule.length > 0
        ? trimmedLedgerRule
        : undefined;

    const affectedStages =
      input.affectedStages ??
      input.contractUpdate?.affectedStages ??
      (selectedOption.target_stage !== undefined
        ? [selectedOption.target_stage]
        : derived.stage !== null
          ? [derived.stage]
          : []);

    const prospectiveVersion =
      input.contractUpdate !== undefined
        ? card.contract_version + 1
        : derived.contractVersion;
    const decisionRecord = DecisionRecordSchema.parse({
      schema_version: 1,
      id: parsedDecision.id,
      task_id: input.taskId,
      contract_version: prospectiveVersion,
      category: parsedDecision.category,
      decider: input.decider ?? "human",
      action,
      chosen_option_id: selectedOption.id,
      affected_stages: affectedStages,
      ...(ledgerRule !== undefined ? { ledger_proposal: ledgerRule } : {}),
      rationale: input.rationale ?? selectedOption.label,
      decided_at: timestamp,
    });

    let bumpResult: { newVersion: number; archivedReceipts: string[] } | undefined;
    if (input.contractUpdate !== undefined) {
      bumpResult = this.store.bumpContractVersion({
        taskId: input.taskId,
        contractPatch: input.contractUpdate.contractPatch,
        affectedStages: input.contractUpdate.affectedStages,
        ...(input.contractUpdate.acceptFilesHash !== undefined
          ? { acceptFilesHash: input.contractUpdate.acceptFilesHash }
          : {}),
        now: timestamp,
      });
    }

    const decisionsPath = this.store.paths.decisionsMd(input.taskId);
    const existingDecisions = readFileOptionalUtf8(decisionsPath);
    const entryMarkdown = formatDecisionEntryMarkdown(
      parsedDecision,
      selectedOption,
      decisionRecord,
    );
    const nextDecisionsContent =
      existingDecisions.trim().length > 0
        ? `${existingDecisions.trimEnd()}\n\n${entryMarkdown}\n`
        : `${entryMarkdown}\n`;
    writeFileAtomic(decisionsPath, nextDecisionsContent);

    let ledgerEntry: LedgerEntry | undefined;
    if (ledgerRule !== undefined) {
      const existingLedger = this.store.readLedger(card.space);
      ledgerEntry = {
        id: `led-${parsedDecision.id}-${randomUUID().slice(0, 8)}`,
        space: card.space,
        rule: ledgerRule,
        source_task_id: input.taskId,
        source_decision_id: parsedDecision.id,
        created_at: timestamp,
      };
      this.store.writeLedger({
        schema_version: 1,
        space: card.space,
        entries: [...(existingLedger?.entries ?? []), ledgerEntry],
      });
    }

    const unboundDependencyIds: string[] = [];
    if (action === "resume" && input.unbindCancelledDependencies === true) {
      const latestCard = this.store.readTaskCard(input.taskId);
      const cancelledDepIds = this.getCancelledDependencies(latestCard.depends_on);
      for (const depId of cancelledDepIds) {
        this.unbindCancelledDependency(input.taskId, depId, timestamp);
        unboundDependencyIds.push(depId);
      }
    }

    const resumeTargetStage =
      action === "resume" &&
      (selectedOption.target_stage !== undefined ||
        input.affectedStages !== undefined ||
        input.contractUpdate !== undefined)
        ? ([...affectedStages].sort((a, b) => STAGE_ORDER[a] - STAGE_ORDER[b])[0] ??
            selectedOption.target_stage)
        : undefined;

    let nextState = this.store.appendStateEvent(input.taskId, {
      type: "decided",
      at: timestamp,
      decision_id: parsedDecision.id,
      action,
      ...(resumeTargetStage !== undefined ? { target_stage: resumeTargetStage } : {}),
    });

    if (nextState.status === "queued") {
      const postCard = this.store.readTaskCard(input.taskId);
      if (this.getCancelledDependencies(postCard.depends_on).length > 0) {
        assertValidTransition("queued", "waiting");
        nextState = this.store.appendStateEvent(input.taskId, {
          type: "waiting",
          at: timestamp,
          reason: "upstream_cancelled",
        });
      }
    }

    const waitingDownstreamTaskIds =
      action === "cancel"
        ? this.cascadeUpstreamCancelled(input.taskId, timestamp)
        : [];

    this.syncAllEffectivePriorities();

    return {
      state: nextState,
      action,
      decisionRecord,
      ...(bumpResult !== undefined
        ? {
            contractVersion: bumpResult.newVersion,
            archivedReceipts: bumpResult.archivedReceipts,
          }
        : {}),
      ...(ledgerEntry !== undefined ? { ledgerEntry } : {}),
      waitingDownstreamTaskIds,
      ...(unboundDependencyIds.length > 0 ? { unboundDependencyIds } : {}),
    };
  }

  /**
   * Escalates an `L1` task to `L2` (adding independent review), atomically updating
   * `card.yaml` and appending a `track_escalated` state event.
   */
  escalateTrackToL2(
    taskId: string,
    reason: string,
    now?: string,
  ): DerivedTaskState {
    if (reason.trim().length === 0) {
      throw new Error("Track escalation reason must be a non-empty string");
    }

    const { card, derived } = this.requireTaskState(taskId);
    if (derived.status === "done" || derived.status === "cancelled") {
      throw new Error(
        `Cannot escalate track of terminal task "${taskId}" in status "${derived.status}"`,
      );
    }
    if (derived.track === "L3") {
      throw new UnsupportedTrackError("L3");
    }
    if (derived.track === "L2") {
      return derived;
    }

    const timestamp = now ?? new Date().toISOString();
    const updatedCard = TaskCardSchema.parse({
      ...card,
      track: "L2",
      ...(card.workflow !== undefined
        ? { workflow: ensureWorkflowIncludesReview(card.workflow) }
        : {}),
      updated_at: timestamp,
    });
    writeYamlAtomic(this.store.paths.cardYaml(taskId), updatedCard, TaskCardSchema);

    return this.store.appendStateEvent(taskId, {
      type: "track_escalated",
      at: timestamp,
      from: "L1",
      to: "L2",
      reason,
    });
  }

  /**
   * Atomically removes a cancelled prerequisite ID from `card.yaml`'s `depends_on`,
   * re-validates the DAG, and recomputes effective priorities.
   */
  unbindCancelledDependency(
    taskId: string,
    cancelledDepId: string,
    now?: string,
  ): UnbindDependencyResult {
    const { card, derived } = this.requireTaskState(taskId);
    if (derived.status === "done" || derived.status === "cancelled") {
      throw new Error(
        `Cannot modify dependencies of terminal task "${taskId}" in status "${derived.status}"`,
      );
    }

    if (!card.depends_on.includes(cancelledDepId)) {
      throw new Error(`Task "${taskId}" does not depend on "${cancelledDepId}"`);
    }

    const depIndex = this.store.getTaskIndex(cancelledDepId);
    if (!depIndex) {
      throw new Error(`Prerequisite task "${cancelledDepId}" does not exist`);
    }
    if (depIndex.status !== "cancelled") {
      throw new Error(
        `Cannot unbind prerequisite "${cancelledDepId}" in status "${depIndex.status}": expected "cancelled"`,
      );
    }

    const nextDependsOn = card.depends_on.filter((depId) => depId !== cancelledDepId);
    const existingDeps = this.loadDependencyMap();
    validateDependsOnGraph(existingDeps, taskId, nextDependsOn, {
      requireExistingDeps: true,
    });

    const timestamp = now ?? new Date().toISOString();
    const updatedCard = TaskCardSchema.parse({
      ...card,
      depends_on: nextDependsOn,
      updated_at: timestamp,
    });
    writeYamlAtomic(this.store.paths.cardYaml(taskId), updatedCard, TaskCardSchema);

    const effectiveUpdatedAt =
      timestamp > derived.updatedAt ? timestamp : derived.updatedAt;
    this.store.sqlite.updateTaskStatusAndPriority(taskId, {
      updated_at: effectiveUpdatedAt,
    });

    const effectivePriorities = this.syncAllEffectivePriorities();

    return {
      taskId,
      removedDependencyId: cancelledDepId,
      dependsOn: nextDependsOn,
      effectivePriority: effectivePriorities.get(taskId) ?? derived.priority,
    };
  }
}
