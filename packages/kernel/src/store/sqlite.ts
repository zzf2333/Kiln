import path from "node:path";
import Database from "better-sqlite3";
import type {
  Priority,
  StageId,
  TaskStatus,
  Track,
  WorkspaceMode,
} from "@kiln/protocol";
import { ensureDir } from "./fs-atomic.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks_index (
  id TEXT PRIMARY KEY,
  space TEXT NOT NULL,
  parent_id TEXT,
  title TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('P0','P1','P2','P3')),
  effective_priority TEXT NOT NULL CHECK (effective_priority IN ('P0','P1','P2','P3')),
  track TEXT NOT NULL CHECK (track IN ('L1','L2','L3')),
  workspace_mode TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','paused','waiting','external','done','cancelled')),
  contract_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stage_leases (
  task_id TEXT PRIMARY KEY REFERENCES tasks_index(id),
  run_id TEXT NOT NULL UNIQUE,
  stage TEXT NOT NULL,
  round INTEGER NOT NULL,
  contract_version INTEGER NOT NULL,
  session_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','completed','expired','cancelled')),
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS host_path_locks (
  canonical_path TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks_index(id),
  locked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_turns (
  run_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (run_id, turn_id)
);
`;

export interface TaskIndexRow {
  id: string;
  space: string;
  parent_id: string | null;
  title: string;
  priority: Priority;
  effective_priority: Priority;
  track: Track;
  workspace_mode: WorkspaceMode;
  status: TaskStatus;
  contract_version: number;
  created_at: string;
  updated_at: string;
}

export interface TaskStatusAndPriorityPatch {
  status?: TaskStatus;
  priority?: Priority;
  effective_priority?: Priority;
  track?: Track;
  contract_version?: number;
  updated_at: string;
}

export type LeaseState = "active" | "completed" | "expired" | "cancelled";

export interface StageLeaseRow {
  task_id: string;
  run_id: string;
  stage: StageId;
  round: number;
  contract_version: number;
  session_ref: string;
  state: LeaseState;
  started_at: string;
  heartbeat_at: string;
}

export interface AcquireStageLeaseInput {
  task_id: string;
  run_id: string;
  stage: StageId;
  round: number;
  contract_version: number;
  session_ref: string;
  started_at: string;
  heartbeat_at: string;
}

export type AcquireStageLeaseResult =
  | { acquired: true }
  | { acquired: false; activeRunId: string };

export interface HostPathLockRow {
  canonical_path: string;
  task_id: string;
  locked_at: string;
}

export interface HostPathLockConflict {
  path: string;
  heldByTaskId: string;
}

export type AcquireHostPathLocksResult =
  | { acquired: true }
  | { acquired: false; conflicts: HostPathLockConflict[] };

export interface UsageTurnRow {
  run_id: string;
  turn_id: string;
  task_id: string;
  agent: string;
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  recorded_at: string;
}

export interface TaskTokenTotals {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface SqlitePragmaSettings {
  journalMode: string;
  synchronous: number;
  foreignKeys: number;
}

function assertNonNegativeInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, got: ${value}`);
  }
}

/**
 * Synchronous SQLite derived index & concurrency lock layer (`index.sqlite`).
 * Always enforces WAL, `synchronous = NORMAL`, and `foreign_keys = ON`.
 */
export class KilnSqliteIndex {
  private readonly db: Database.Database;
  private closed = false;

  private readonly upsertTaskStmt: Database.Statement;
  private readonly getTaskStmt: Database.Statement;
  private readonly selectLeaseByTaskStmt: Database.Statement;
  private readonly upsertLeaseStmt: Database.Statement;
  private readonly completeLeaseStmt: Database.Statement;
  private readonly releaseOrExpireLeaseStmt: Database.Statement;
  private readonly expireActiveByTaskStmt: Database.Statement;
  private readonly listActiveLeasesStmt: Database.Statement;
  private readonly selectHostLockStmt: Database.Statement;
  private readonly upsertHostLockStmt: Database.Statement;
  private readonly deleteHostLocksByTaskStmt: Database.Statement;
  private readonly upsertUsageTurnStmt: Database.Statement;
  private readonly sumTaskUsageStmt: Database.Statement;

  constructor(dbPath: string) {
    ensureDir(path.dirname(dbPath));
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);

    this.upsertTaskStmt = this.db.prepare(`
      INSERT INTO tasks_index (
        id, space, parent_id, title, priority, effective_priority,
        track, workspace_mode, status, contract_version, created_at, updated_at
      ) VALUES (
        @id, @space, @parent_id, @title, @priority, @effective_priority,
        @track, @workspace_mode, @status, @contract_version, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        space = excluded.space,
        parent_id = excluded.parent_id,
        title = excluded.title,
        priority = excluded.priority,
        effective_priority = excluded.effective_priority,
        track = excluded.track,
        workspace_mode = excluded.workspace_mode,
        status = excluded.status,
        contract_version = excluded.contract_version,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `);

    this.getTaskStmt = this.db.prepare(`SELECT * FROM tasks_index WHERE id = ?`);

    this.selectLeaseByTaskStmt = this.db.prepare(
      `SELECT * FROM stage_leases WHERE task_id = ?`,
    );

    this.upsertLeaseStmt = this.db.prepare(`
      INSERT INTO stage_leases (
        task_id, run_id, stage, round, contract_version,
        session_ref, state, started_at, heartbeat_at
      ) VALUES (
        @task_id, @run_id, @stage, @round, @contract_version,
        @session_ref, 'active', @started_at, @heartbeat_at
      )
      ON CONFLICT(task_id) DO UPDATE SET
        run_id = excluded.run_id,
        stage = excluded.stage,
        round = excluded.round,
        contract_version = excluded.contract_version,
        session_ref = excluded.session_ref,
        state = 'active',
        started_at = excluded.started_at,
        heartbeat_at = excluded.heartbeat_at
    `);

    this.completeLeaseStmt = this.db.prepare(`
      UPDATE stage_leases
      SET state = 'completed', heartbeat_at = @now
      WHERE task_id = @taskId
        AND run_id = @runId
        AND contract_version = @contractVersion
        AND state = 'active'
    `);

    this.releaseOrExpireLeaseStmt = this.db.prepare(`
      UPDATE stage_leases
      SET state = @state, heartbeat_at = @now
      WHERE task_id = @taskId
        AND run_id = @runId
        AND state = 'active'
    `);

    this.expireActiveByTaskStmt = this.db.prepare(`
      UPDATE stage_leases
      SET state = @state, heartbeat_at = @now
      WHERE task_id = @taskId
        AND state = 'active'
    `);

    this.listActiveLeasesStmt = this.db.prepare(
      `SELECT * FROM stage_leases WHERE state = 'active' ORDER BY started_at ASC`,
    );

    this.selectHostLockStmt = this.db.prepare(
      `SELECT canonical_path, task_id, locked_at FROM host_path_locks WHERE canonical_path = ?`,
    );

    this.upsertHostLockStmt = this.db.prepare(`
      INSERT INTO host_path_locks (canonical_path, task_id, locked_at)
      VALUES (@canonical_path, @task_id, @locked_at)
      ON CONFLICT(canonical_path) DO UPDATE SET
        locked_at = excluded.locked_at
      WHERE host_path_locks.task_id = excluded.task_id
    `);

    this.deleteHostLocksByTaskStmt = this.db.prepare(
      `DELETE FROM host_path_locks WHERE task_id = ?`,
    );

    this.upsertUsageTurnStmt = this.db.prepare(`
      INSERT INTO usage_turns (
        run_id, turn_id, task_id, agent, model,
        input_tokens, cached_input_tokens, output_tokens, recorded_at
      ) VALUES (
        @run_id, @turn_id, @task_id, @agent, @model,
        @input_tokens, @cached_input_tokens, @output_tokens, @recorded_at
      )
      ON CONFLICT(run_id, turn_id) DO UPDATE SET
        task_id = excluded.task_id,
        agent = excluded.agent,
        model = excluded.model,
        input_tokens = excluded.input_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        output_tokens = excluded.output_tokens,
        recorded_at = excluded.recorded_at
    `);

    this.sumTaskUsageStmt = this.db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM usage_turns
      WHERE task_id = ?
    `);
  }

  /**
   * Executes `fn` inside a synchronous SQLite transaction.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getPragmaSettings(): SqlitePragmaSettings {
    const journalMode = this.db.pragma("journal_mode", { simple: true }) as string;
    const synchronous = this.db.pragma("synchronous", { simple: true }) as number;
    const foreignKeys = this.db.pragma("foreign_keys", { simple: true }) as number;
    return { journalMode, synchronous, foreignKeys };
  }

  upsertTaskIndex(row: TaskIndexRow): void {
    this.upsertTaskStmt.run({
      ...row,
      parent_id: row.parent_id ?? null,
    });
  }

  getTaskIndex(id: string): TaskIndexRow | null {
    const row = this.getTaskStmt.get(id) as TaskIndexRow | undefined;
    return row ?? null;
  }

  listTaskIndices(filter?: { space?: string; status?: TaskStatus }): TaskIndexRow[] {
    const clauses: string[] = [];
    const params: Record<string, string> = {};

    if (filter?.space !== undefined) {
      clauses.push("space = @space");
      params.space = filter.space;
    }
    if (filter?.status !== undefined) {
      clauses.push("status = @status");
      params.status = filter.status;
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const stmt = this.db.prepare(
      `SELECT * FROM tasks_index ${whereClause} ORDER BY created_at ASC, id ASC`,
    );
    return stmt.all(params) as TaskIndexRow[];
  }

  updateTaskStatusAndPriority(id: string, patch: TaskStatusAndPriorityPatch): boolean {
    const assignments: string[] = ["updated_at = @updated_at"];
    const params: Record<string, string | number> = {
      id,
      updated_at: patch.updated_at,
    };

    if (patch.status !== undefined) {
      assignments.push("status = @status");
      params.status = patch.status;
    }
    if (patch.priority !== undefined) {
      assignments.push("priority = @priority");
      params.priority = patch.priority;
    }
    if (patch.effective_priority !== undefined) {
      assignments.push("effective_priority = @effective_priority");
      params.effective_priority = patch.effective_priority;
    }
    if (patch.track !== undefined) {
      assignments.push("track = @track");
      params.track = patch.track;
    }
    if (patch.contract_version !== undefined) {
      assignments.push("contract_version = @contract_version");
      params.contract_version = patch.contract_version;
    }

    const stmt = this.db.prepare(
      `UPDATE tasks_index SET ${assignments.join(", ")} WHERE id = @id`,
    );
    const info = stmt.run(params);
    return info.changes > 0;
  }

  /**
   * Acquires the single active stage lease for `task_id` atomically.
   * Rejects acquisition if another `run_id` already holds an active lease.
   */
  acquireStageLease(input: AcquireStageLeaseInput): AcquireStageLeaseResult {
    return this.transaction((): AcquireStageLeaseResult => {
      const task = this.getTaskStmt.get(input.task_id) as TaskIndexRow | undefined;
      if (!task) {
        throw new Error(`Cannot acquire stage lease for unknown task "${input.task_id}"`);
      }
      if (task.contract_version !== input.contract_version) {
        throw new Error(
          `Cannot acquire stage lease for run "${input.run_id}": contract_version ${input.contract_version} does not match current task contract_version ${task.contract_version}`,
        );
      }

      const existing = this.selectLeaseByTaskStmt.get(input.task_id) as
        | StageLeaseRow
        | undefined;

      if (existing) {
        if (existing.state === "active" && existing.run_id !== input.run_id) {
          return { acquired: false, activeRunId: existing.run_id };
        }
        if (existing.run_id === input.run_id && existing.state !== "active") {
          throw new Error(
            `Cannot re-acquire run_id "${input.run_id}" in terminal lease state "${existing.state}"`,
          );
        }
      }

      this.upsertLeaseStmt.run(input);
      return { acquired: true };
    });
  }

  /**
   * Atomically transitions an active stage lease to `completed` only when
   * `task_id`, `run_id`, `contract_version`, and `state = 'active'` all match.
   */
  completeStageLease(
    taskId: string,
    runId: string,
    contractVersion: number,
    now: string,
  ): { committed: boolean } {
    return this.transaction((): { committed: boolean } => {
      const info = this.completeLeaseStmt.run({
        taskId,
        runId,
        contractVersion,
        now,
      });
      return { committed: info.changes === 1 };
    });
  }

  releaseOrExpireStageLease(
    taskId: string,
    runId: string,
    state: "expired" | "cancelled",
    now: string,
  ): { updated: boolean } {
    return this.transaction((): { updated: boolean } => {
      const info = this.releaseOrExpireLeaseStmt.run({
        taskId,
        runId,
        state,
        now,
      });
      return { updated: info.changes === 1 };
    });
  }

  /**
   * Expires (or cancels) any active stage lease held by `taskId` regardless of `run_id`.
   */
  expireActiveLeaseByTask(
    taskId: string,
    now: string,
    targetState: "expired" | "cancelled" = "expired",
  ): { updated: boolean } {
    return this.transaction((): { updated: boolean } => {
      const info = this.expireActiveByTaskStmt.run({
        taskId,
        state: targetState,
        now,
      });
      return { updated: info.changes === 1 };
    });
  }

  getStageLease(taskId: string): StageLeaseRow | null {
    const row = this.selectLeaseByTaskStmt.get(taskId) as StageLeaseRow | undefined;
    return row ?? null;
  }

  listActiveStageLeases(): StageLeaseRow[] {
    return this.listActiveLeasesStmt.all() as StageLeaseRow[];
  }

  /**
   * Atomically checks and acquires cross-task exclusive locks for all `canonicalPaths`.
   * Rolls back completely (inserts zero locks) if any path is held by another task.
   */
  acquireHostPathLocks(
    taskId: string,
    canonicalPaths: readonly string[],
    now: string,
  ): AcquireHostPathLocksResult {
    const uniquePaths = Array.from(new Set(canonicalPaths));
    if (uniquePaths.length === 0) {
      return { acquired: true };
    }

    return this.transaction((): AcquireHostPathLocksResult => {
      const conflicts: HostPathLockConflict[] = [];
      for (const canonicalPath of uniquePaths) {
        const existing = this.selectHostLockStmt.get(canonicalPath) as
          | HostPathLockRow
          | undefined;
        if (existing && existing.task_id !== taskId) {
          conflicts.push({
            path: existing.canonical_path,
            heldByTaskId: existing.task_id,
          });
        }
      }

      if (conflicts.length > 0) {
        return { acquired: false, conflicts };
      }

      for (const canonicalPath of uniquePaths) {
        this.upsertHostLockStmt.run({
          canonical_path: canonicalPath,
          task_id: taskId,
          locked_at: now,
        });
      }

      return { acquired: true };
    });
  }

  releaseHostPathLocks(taskId: string): number {
    const info = this.deleteHostLocksByTaskStmt.run(taskId);
    return info.changes;
  }

  listHostPathLocks(taskId?: string): HostPathLockRow[] {
    if (taskId !== undefined) {
      const stmt = this.db.prepare(
        `SELECT * FROM host_path_locks WHERE task_id = ? ORDER BY canonical_path ASC`,
      );
      return stmt.all(taskId) as HostPathLockRow[];
    }
    const stmt = this.db.prepare(
      `SELECT * FROM host_path_locks ORDER BY canonical_path ASC`,
    );
    return stmt.all() as HostPathLockRow[];
  }

  /**
   * Idempotently inserts or overwrites per-turn token usage keyed by `(run_id, turn_id)`.
   * Rejects `cached_input_tokens > input_tokens` with `RangeError`.
   */
  upsertUsageTurn(row: UsageTurnRow): void {
    assertNonNegativeInt(row.input_tokens, "input_tokens");
    assertNonNegativeInt(row.cached_input_tokens, "cached_input_tokens");
    assertNonNegativeInt(row.output_tokens, "output_tokens");

    if (row.cached_input_tokens > row.input_tokens) {
      throw new RangeError(
        `cached_input_tokens (${row.cached_input_tokens}) cannot exceed input_tokens (${row.input_tokens})`,
      );
    }

    this.upsertUsageTurnStmt.run(row);
  }

  listUsageTurns(filter?: { taskId?: string; runId?: string }): UsageTurnRow[] {
    const clauses: string[] = [];
    const params: Record<string, string> = {};

    if (filter?.taskId !== undefined) {
      clauses.push("task_id = @taskId");
      params.taskId = filter.taskId;
    }
    if (filter?.runId !== undefined) {
      clauses.push("run_id = @runId");
      params.runId = filter.runId;
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const stmt = this.db.prepare(
      `SELECT * FROM usage_turns ${whereClause} ORDER BY recorded_at ASC, run_id ASC, turn_id ASC`,
    );
    return stmt.all(params) as UsageTurnRow[];
  }

  getTaskTotalTokens(taskId: string): TaskTokenTotals {
    const row = this.sumTaskUsageStmt.get(taskId) as {
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
    };

    return {
      input_tokens: row.input_tokens,
      cached_input_tokens: row.cached_input_tokens,
      output_tokens: row.output_tokens,
      total_tokens: row.input_tokens + row.output_tokens,
    };
  }

  prepareForAtomicMove(): void {
    if (!this.closed) {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
      this.db.pragma("journal_mode = DELETE");
      this.close();
    }
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
