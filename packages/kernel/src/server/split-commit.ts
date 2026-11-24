import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  TaskCardSchema,
  WbSplitCardsPlanInputSchema,
  validateSplitCardsDag,
  type PendingDecision,
  type TaskAttachment,
  type TaskCard,
  type WbSplitCardsPlanInput,
} from "@kiln/protocol";
import type { TaskStateMachine } from "../state/index.js";
import type { DerivedTaskState, KilnStore } from "../store/index.js";
import { copyDraftAttachmentsToTask, validateCommitAttachments } from "./attachments.js";
import type { CaffeinateController } from "./caffeinate.js";
import { ServerHttpError } from "./errors.js";
import {
  countRunningLeafTasks,
  PendingDecisionStore,
  resolveCardLimits,
} from "./pending-decisions.js";
import {
  validateCommitContract,
  validateCommitWorkflow,
  validateCommitWorkspace,
} from "./space-inspect.js";
import type { SseHub } from "./sse.js";

export interface CommitSplitCardsDeps {
  store: KilnStore;
  stateMachine: TaskStateMachine;
  pendingDecisions: PendingDecisionStore;
  sseHub: SseHub;
  caffeinate: CaffeinateController;
  onTaskQueued?: (taskId: string) => void;
}

export interface CommitSplitCardsResult {
  ok: true;
  mode: "commit_split_cards";
  tempIdToTaskId: Record<string, string>;
  cards: TaskCard[];
  states: Array<DerivedTaskState & { effectivePriority: TaskCard["priority"] }>;
}

/**
 * Atomically validates and commits 2–12 dependent split task cards in topological order
 * from either `POST /api/drafts/:id/commit-split` or MCP `wb_plan(mode: "commit_split_cards")`.
 * Rolls back any partially created tasks if any item fails mid-commit, keeping the draft intact.
 */
export function commitSplitCards(
  deps: CommitSplitCardsDeps,
  rawInput: WbSplitCardsPlanInput,
): CommitSplitCardsResult {
  const { store, stateMachine, pendingDecisions, sseHub, caffeinate, onTaskQueued } = deps;
  const input = WbSplitCardsPlanInputSchema.parse(rawInput);

  if (input.draft_id !== undefined) {
    // assert valid segment via readDraft below
    const existingDraft = store.readDraft(input.draft_id);
    if (!existingDraft) {
      throw new ServerHttpError(404, {
        error: "draft_not_found",
        draftId: input.draft_id,
        message: `Draft "${input.draft_id}" does not exist`,
      });
    }
  }

  const dag = validateSplitCardsDag(input.cards);
  if (!dag.ok) {
    throw new ServerHttpError(400, {
      error: "invalid_split_dag",
      errors: dag.errors,
      message: dag.errors.join("; "),
    });
  }

  const roster = store.readEffectiveRosterConfig();
  const byTempId = new Map(input.cards.map((c) => [c.temp_id.trim(), c]));
  const existingTaskIds = new Set(store.listTasks().map((t) => t.id));

  for (const item of input.cards) {
    validateCommitWorkspace(store, item.space, item.workspace_mode);
    validateCommitContract(store, item.contract);
    validateCommitWorkflow(item.workspace_mode, item.workflow, roster);
    for (const depId of item.depends_on) {
      if (!existingTaskIds.has(depId)) {
        throw new ServerHttpError(400, {
          error: "unknown_dependency",
          tempId: item.temp_id,
          dependencyId: depId,
          message: `Card "${item.temp_id}" references unknown existing task "${depId}" in depends_on`,
        });
      }
    }
  }

  const tempIdToTaskId = new Map<string, string>();
  for (const tempId of dag.order) {
    let candidate = `t-${randomUUID().slice(0, 8)}`;
    while (
      existingTaskIds.has(candidate) ||
      fs.existsSync(store.paths.cardYaml(candidate)) ||
      Array.from(tempIdToTaskId.values()).includes(candidate)
    ) {
      candidate = `t-${randomUUID().slice(0, 8)}`;
    }
    tempIdToTaskId.set(tempId, candidate);
  }

  const draftResearch =
    input.draft_id !== undefined ? store.readDraftResearch(input.draft_id) : null;
  const now = new Date().toISOString();
  const createdTaskIds: string[] = [];
  const createdCards: TaskCard[] = [];
  const createdStates: Array<DerivedTaskState & { effectivePriority: TaskCard["priority"] }> = [];

  try {
    for (const tempId of dag.order) {
      const item = byTempId.get(tempId)!;
      const taskId = tempIdToTaskId.get(tempId)!;
      createdTaskIds.push(taskId);

      const resolvedDependsOn = Array.from(
        new Set([
          ...item.depends_on,
          ...item.depends_on_temp_ids.map((tid) => {
            const trimmed = tid.trim();
            const mapped = tempIdToTaskId.get(trimmed);
            if (!mapped) {
              throw new Error(`Missing mapped taskId for temp_id "${tid}"`);
            }
            return mapped;
          }),
        ]),
      );

      let resolvedAttachments: TaskAttachment[] | undefined;
      if (input.draft_id !== undefined) {
        const copied = copyDraftAttachmentsToTask(store, input.draft_id, taskId, item.attachments);
        if (copied.length > 0) {
          resolvedAttachments = copied;
        }
      } else if (item.attachments !== undefined && item.attachments.length > 0) {
        resolvedAttachments = item.attachments;
      }

      if (resolvedAttachments) {
        validateCommitAttachments(resolvedAttachments, taskId);
      }

      const card = TaskCardSchema.parse({
        schema_version: 1,
        id: taskId,
        title: item.title,
        space: item.space,
        priority: item.priority,
        track: item.track,
        workspace_mode: item.workspace_mode,
        parent: null,
        depends_on: resolvedDependsOn,
        ...(item.workflow !== undefined ? { workflow: item.workflow } : {}),
        ...(resolvedAttachments !== undefined ? { attachments: resolvedAttachments } : {}),
        contract_version: 1,
        contract: item.contract,
        limits: resolveCardLimits(store, item.limits),
        created_at: now,
        updated_at: now,
      });

      const created = stateMachine.createTask(card, item.brief_markdown);
      if (draftResearch && draftResearch.trim().length > 0) {
        store.writeTaskResearch(created.card.id, draftResearch);
      }
      createdCards.push(created.card);
      createdStates.push({
        ...created.state,
        effectivePriority: created.effectivePriority,
      });
    }
  } catch (err) {
    for (let i = createdTaskIds.length - 1; i >= 0; i--) {
      try {
        store.deleteTaskOnRollback(createdTaskIds[i]!);
      } catch {
        // Ignore rollback cleanup errors so the primary failure is preserved.
      }
    }
    throw err;
  }

  if (input.draft_id !== undefined) {
    store.deleteDraft(input.draft_id);
  }

  caffeinate.syncRunningCount(countRunningLeafTasks(store));

  for (let i = 0; i < createdCards.length; i++) {
    const card = createdCards[i]!;
    const st = createdStates[i]!;
    let dec: PendingDecision | null = null;
    if (st.status === "waiting") {
      dec = pendingDecisions.ensureUpstreamCancelledDecision(card.id);
      if (dec) {
        sseHub.publish({
          type: "decision.requested",
          taskId: card.id,
          priority: card.priority,
          question: dec.question,
        });
      }
    }
    sseHub.publish({
      type: "task.updated",
      taskId: card.id,
      patch: {
        status: st.status,
        priority: card.priority,
        effectivePriority: st.effectivePriority,
        contractVersion: card.contract_version,
      },
    });
    if (st.status === "queued") {
      onTaskQueued?.(card.id);
    }
  }

  return {
    ok: true,
    mode: "commit_split_cards",
    tempIdToTaskId: Object.fromEntries(tempIdToTaskId),
    cards: createdCards,
    states: createdStates,
  };
}
