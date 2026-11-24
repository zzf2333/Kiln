import path from "node:path";
import {
  MergeQueueEntrySchema,
  PRIORITY_RANK,
  type MergeQueueEntry,
  type StateEvent,
} from "@kiln/protocol";
import { deriveTaskStatus, type KilnStore } from "../store/index.js";

export const MAX_REFINERY_AUTO_REWORKS = 1;

/**
 * Per-repository FIFO async mutex ensuring at most one `merge_main` critical section
 * (`rebase` -> post-rebase `accept_cmd` -> `merge`) mutates a target repository at once.
 */
export class SpaceMergeLock {
  private readonly tails = new Map<string, Promise<void>>();

  async withLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
    const key = path.resolve(repoPath);
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nextTail = prev.then(() => gate, () => gate);
    this.tails.set(key, nextTail);

    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === nextTail) {
        this.tails.delete(key);
      }
    }
  }
}

/**
 * Counts prior Refinery automatic reworks (`refinery-conflict-*` / `refinery-accept-*`)
 * for the active `contract_version` strictly from durable `state_events.ndjson`.
 */
export function countRefineryAutoReworks(
  events: readonly StateEvent[],
  contractVersion: number,
): number {
  let count = 0;
  for (const ev of events) {
    if (
      ev.type === "steered" &&
      ev.contract_version === contractVersion &&
      ev.steer_id.startsWith("refinery-")
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * Derives a deterministic per-space Refinery serial merge queue snapshot directly from disk/SQLite state.
 */
export function computeMergeQueueSnapshot(store: KilnStore): MergeQueueEntry[] {
  const rows = store.listTasks();
  const rowById = new Map(rows.map((r) => [r.id, r]));

  interface CandidateEntry {
    taskId: string;
    space: string;
    title: string;
    state: "merging" | "queued";
    effectivePriority: MergeQueueEntry["priority"];
    blockedCount: number;
    updatedAt: string;
  }

  const derivedByTaskId = new Map<
    string,
    {
      status: string;
      stage: string | null;
      updatedAt: string;
      dependsOn: readonly string[];
      title: string;
      space: string;
      workspaceMode: string;
      deliverMode: string;
      effectivePriority: MergeQueueEntry["priority"];
    }
  >();

  for (const row of rows) {
    const card = store.readTaskCard(row.id);
    const events = store.readStateEvents(row.id);
    const derived = deriveTaskStatus(card, events);
    derivedByTaskId.set(row.id, {
      status: derived.status,
      stage: derived.stage,
      updatedAt: derived.updatedAt || card.updated_at || card.created_at,
      dependsOn: card.depends_on,
      title: card.title,
      space: card.space,
      workspaceMode: card.workspace_mode,
      deliverMode: card.contract.deliver.mode,
      effectivePriority: row.effective_priority ?? derived.priority,
    });
  }

  // Compute direct + transitive unfinished dependent counts for topology tie-breaking.
  const directDependents = new Map<string, string[]>();
  for (const [taskId, info] of derivedByTaskId) {
    if (info.status === "done" || info.status === "cancelled") continue;
    for (const depId of info.dependsOn) {
      const list = directDependents.get(depId) ?? [];
      list.push(taskId);
      directDependents.set(depId, list);
    }
  }

  const countBlocked = (rootId: string): number => {
    const visited = new Set<string>();
    const stack = [...(directDependents.get(rootId) ?? [])];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (visited.has(cur)) continue;
      const curInfo = derivedByTaskId.get(cur);
      if (!curInfo || curInfo.status === "done" || curInfo.status === "cancelled") continue;
      visited.add(cur);
      const next = directDependents.get(cur);
      if (next) stack.push(...next);
    }
    return visited.size;
  };

  const bySpace = new Map<string, CandidateEntry[]>();
  for (const [taskId, info] of derivedByTaskId) {
    if (
      info.workspaceMode !== "git_worktree" ||
      info.deliverMode !== "merge_main" ||
      info.stage !== "deliver"
    ) {
      continue;
    }

    let state: "merging" | "queued" | null = null;
    if (info.status === "running") {
      state = "merging";
    } else if (info.status === "queued") {
      const depsDone = info.dependsOn.every((depId) => {
        const dep = derivedByTaskId.get(depId) ?? rowById.get(depId);
        return dep?.status === "done";
      });
      if (depsDone) {
        state = "queued";
      }
    }

    if (!state) continue;

    const list = bySpace.get(info.space) ?? [];
    list.push({
      taskId,
      space: info.space,
      title: info.title,
      state,
      effectivePriority: info.effectivePriority,
      blockedCount: countBlocked(taskId),
      updatedAt: info.updatedAt,
    });
    bySpace.set(info.space, list);
  }

  const entries: MergeQueueEntry[] = [];
  for (const [, list] of bySpace) {
    list.sort((a, b) => {
      if (a.state !== b.state) {
        return a.state === "merging" ? -1 : 1;
      }
      const pDiff = PRIORITY_RANK[a.effectivePriority] - PRIORITY_RANK[b.effectivePriority];
      if (pDiff !== 0) return pDiff;
      const bDiff = b.blockedCount - a.blockedCount;
      if (bDiff !== 0) return bDiff;
      const tDiff = a.updatedAt.localeCompare(b.updatedAt);
      if (tDiff !== 0) return tDiff;
      return a.taskId.localeCompare(b.taskId);
    });
    list.forEach((item, idx) => {
      entries.push(
        MergeQueueEntrySchema.parse({
          task_id: item.taskId,
          space: item.space,
          title: item.title,
          state: item.state,
          position: idx + 1,
          priority: item.effectivePriority,
        }),
      );
    });
  }

  entries.sort((a, b) => {
    if (a.state !== b.state) return a.state === "merging" ? -1 : 1;
    const sDiff = a.space.localeCompare(b.space);
    if (sDiff !== 0) return sDiff;
    return a.position - b.position;
  });

  return entries;
}
