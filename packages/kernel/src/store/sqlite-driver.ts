import { createRequire } from "node:module";

export type SqliteRuntimeKind = "bun:sqlite" | "node:sqlite";

export interface SqliteRunResult {
  changes: number;
}

export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  finalize(): void;
}

export interface SqliteDatabase {
  readonly driver: SqliteRuntimeKind;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  pragmaSimple<T = unknown>(statement: string): T;
  pragmaExec(statement: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface OpenSqliteOptions {
  driver?: SqliteRuntimeKind;
}

interface RawRunResult {
  changes?: number | bigint;
}

interface RawSqliteStatement {
  run(...params: unknown[]): RawRunResult | undefined;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  setAllowUnknownNamedParameters?(enabled: boolean): void;
  finalize?(): void;
}

interface RawSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawSqliteStatement;
  close(): void;
}

interface BunSqliteModule {
  Database: new (path: string, options?: { strict?: boolean }) => RawSqliteDatabase;
}

interface NodeSqliteModule {
  DatabaseSync: new (
    path: string,
    options?: { allowUnknownNamedParameters?: boolean },
  ) => RawSqliteDatabase;
}

const runtimeRequire = createRequire(import.meta.url);

export function detectSqliteRuntime(): SqliteRuntimeKind {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
    ? "bun:sqlite"
    : "node:sqlite";
}

function normalizeRow(row: unknown): Record<string, unknown> {
  if (typeof row === "object" && row !== null) {
    return Object.assign({}, row as Record<string, unknown>);
  }
  return {};
}

function wrapStatement(rawStmt: RawSqliteStatement, onFinalize?: () => void): SqliteStatement {
  // Belt-and-suspenders for Node 22.13-22.14 statement-level toggle alongside constructor option.
  if (typeof rawStmt.setAllowUnknownNamedParameters === "function") {
    rawStmt.setAllowUnknownNamedParameters(true);
  }
  let finalized = false;

  return {
    run(...params: unknown[]): SqliteRunResult {
      const info = rawStmt.run(...params);
      const rawChanges = info?.changes ?? 0;
      const changes = typeof rawChanges === "bigint" ? Number(rawChanges) : Number(rawChanges);
      return { changes };
    },

    get(...params: unknown[]): Record<string, unknown> | undefined {
      const row = rawStmt.get(...params);
      if (row === null || row === undefined) {
        return undefined;
      }
      return normalizeRow(row);
    },

    all(...params: unknown[]): Record<string, unknown>[] {
      const rows = rawStmt.all(...params);
      return rows.map((row) => normalizeRow(row));
    },

    finalize(): void {
      if (finalized) {
        return;
      }
      finalized = true;
      onFinalize?.();
      rawStmt.finalize?.();
    },
  };
}

class DualSqliteDatabase implements SqliteDatabase {
  readonly driver: SqliteRuntimeKind;
  private readonly raw: RawSqliteDatabase;
  private readonly statementRefs = new Set<WeakRef<RawSqliteStatement>>();
  private txDepth = 0;

  constructor(driver: SqliteRuntimeKind, raw: RawSqliteDatabase) {
    this.driver = driver;
    this.raw = raw;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    const rawStmt = this.raw.prepare(sql);
    if (typeof rawStmt.finalize === "function") {
      const ref = new WeakRef(rawStmt);
      this.statementRefs.add(ref);
      if (this.statementRefs.size > 64) {
        for (const existing of this.statementRefs) {
          if (existing.deref() === undefined) {
            this.statementRefs.delete(existing);
          }
        }
      }
      return wrapStatement(rawStmt, () => {
        this.statementRefs.delete(ref);
      });
    }
    return wrapStatement(rawStmt);
  }

  pragmaSimple<T = unknown>(statement: string): T {
    const stmt = this.prepare(`PRAGMA ${statement}`);
    let row: Record<string, unknown> | undefined;
    try {
      row = stmt.get();
    } finally {
      stmt.finalize();
    }
    if (!row) {
      return undefined as T;
    }
    const keys = Object.keys(row);
    return (keys.length > 0 ? row[keys[0]!] : undefined) as T;
  }

  pragmaExec(statement: string): void {
    this.raw.exec(`PRAGMA ${statement}`);
  }

  transaction<T>(fn: () => T): T {
    const depth = this.txDepth;
    const savepointName = depth > 0 ? `kiln_sp_${depth}` : null;

    if (savepointName === null) {
      this.raw.exec("BEGIN IMMEDIATE");
    } else {
      this.raw.exec(`SAVEPOINT ${savepointName}`);
    }

    this.txDepth = depth + 1;
    try {
      const result = fn();
      if (savepointName === null) {
        this.raw.exec("COMMIT");
      } else {
        this.raw.exec(`RELEASE SAVEPOINT ${savepointName}`);
      }
      this.txDepth = depth;
      return result;
    } catch (err) {
      this.txDepth = depth;
      try {
        if (savepointName === null) {
          this.raw.exec("ROLLBACK");
        } else {
          this.raw.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
          this.raw.exec(`RELEASE SAVEPOINT ${savepointName}`);
        }
      } catch {
        // Preserve the original transaction error if rollback fails.
      }
      throw err;
    }
  }

  close(): void {
    // Under bun:sqlite, sqlite3_close_v2 defers closing the underlying OS file handle
    // until all prepared statements are finalized; finalize tracked statements explicitly
    // so Windows NTFS never raises EBUSY on subsequent rename/unlink.
    for (const ref of this.statementRefs) {
      const rawStmt = ref.deref();
      if (rawStmt) {
        try {
          rawStmt.finalize?.();
        } catch {
          // Best-effort cleanup before closing raw database handle.
        }
      }
    }
    this.statementRefs.clear();
    this.raw.close();
  }
}

/**
 * Opens a zero-native synchronous SQLite handle backed by `bun:sqlite` under Bun
 * (`{ strict: true }`) or built-in `node:sqlite` under Node >= 22.13 / 24
 * (`{ allowUnknownNamedParameters: true }`).
 */
export function openSqliteDatabase(
  dbPath: string,
  options: OpenSqliteOptions = {},
): SqliteDatabase {
  const driver = options.driver ?? detectSqliteRuntime();

  if (driver === "bun:sqlite") {
    let bunMod: BunSqliteModule;
    try {
      bunMod = runtimeRequire("bun:sqlite") as BunSqliteModule;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load built-in "bun:sqlite": ${msg}`, { cause: err });
    }
    const raw = new bunMod.Database(dbPath, { strict: true });
    return new DualSqliteDatabase("bun:sqlite", raw);
  }

  let nodeMod: NodeSqliteModule;
  try {
    nodeMod = runtimeRequire("node:sqlite") as NodeSqliteModule;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to load built-in "node:sqlite" (requires Node >= 22.13 / 24 or Bun): ${msg}`,
      { cause: err },
    );
  }
  const raw = new nodeMod.DatabaseSync(dbPath, { allowUnknownNamedParameters: true });
  return new DualSqliteDatabase("node:sqlite", raw);
}
