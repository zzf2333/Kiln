import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CardContractSchema,
  DraftCardSchema,
  LedgerFileSchema,
  LimitsConfigSchema,
  PRIORITY_RANK,
  PricingConfigSchema,
  RolesConfigSchema,
  RunEventSchema,
  RunMetaSchema,
  SpaceConfigSchema,
  StateEventSchema,
  TaskCardSchema,
  parseFrontmatterMarkdown,
  type CardContract,
  type DraftCard,
  type LedgerFile,
  type LimitsConfig,
  type PricingConfig,
  type Priority,
  type RolesConfig,
  type RunEvent,
  type RunMeta,
  type SpaceConfig,
  type StageId,
  type StateEvent,
  type TaskCard,
  type TaskStatus,
  type Track,
} from "@kiln/protocol";
import {
  appendNdjsonLine,
  ensureDir,
  readNdjsonValidated,
  readYamlOptional,
  readYamlValidated,
  writeFileAtomic,
  writeYamlAtomic,
  type AnyZodType,
} from "./fs-atomic.js";
import { KilnPaths, assertSafeSegment, type KilnConfigName } from "./paths.js";
import {
  KilnSqliteIndex,
  type AcquireHostPathLocksResult,
  type AcquireStageLeaseResult,
  type HostPathLockRow,
  type StageLeaseRow,
  type TaskIndexRow,
  type TaskTokenTotals,
  type UsageTurnRow,
} from "./sqlite.js";

const STAGE_ORDER: Record<StageId, number> = {
  intake: 0,
  research: 1,
  implement: 2,
  verify: 3,
  review: 4,
  accept: 5,
  triage: 6,
  advise: 7,
  deliver: 8,
};

const CONFIG_SCHEMAS = {
  roles: RolesConfigSchema,
  limits: LimitsConfigSchema,
  pricing: PricingConfigSchema,
} as const;

export interface DerivedTaskState {
  status: TaskStatus;
  stage: StageId | null;
  round: number | null;
  activeRunId: string | null;
  priority: Priority;
  track: Track;
  contractVersion: number;
  updatedAt: string;
}

export interface SubmitReceiptInput {
  taskId: string;
  runId: string;
  contractVersion: number;
  runDirName: string;
  markdown: string;
  now?: string;
}

export type SubmitReceiptResult =
  | { accepted: true; receiptPath: string }
  | { accepted: false; archivedPath: string; reason: "lease_mismatch_or_expired" };

export interface BumpContractVersionInput {
  taskId: string;
  contractPatch: Partial<CardContract>;
  affectedStages: StageId[];
  acceptFilesHash?: string;
  now?: string;
}

export interface BumpContractVersionResult {
  newVersion: number;
  archivedReceipts: string[];
}

/**
 * Pure state-projection function deriving the current mutually-exclusive status,
 * active stage/round/run, effective priority, track, and contract version from disk facts.
 */
export function deriveTaskStatus(
  card: TaskCard,
  stateEvents: readonly StateEvent[],
): DerivedTaskState {
  let status: TaskStatus = "queued";
  let stage: StageId | null = null;
  let round: number | null = null;
  let activeRunId: string | null = null;
  let priority: Priority = card.priority;
  let track: Track = card.track;
  let contractVersion = card.contract_version;
  let updatedAt = card.updated_at;

  for (const event of stateEvents) {
    if (event.at > updatedAt) {
      updatedAt = event.at;
    }

    switch (event.type) {
      case "queued":
        status = "queued";
        activeRunId = null;
        break;
      case "running":
        status = "running";
        stage = event.stage;
        round = event.round;
        activeRunId = event.run_id;
        break;
      case "paused":
        status = "paused";
        if (event.stage !== undefined) {
          stage = event.stage;
        }
        activeRunId = null;
        break;
      case "resumed":
        status = "queued";
        stage = event.stage;
        activeRunId = null;
        break;
      case "waiting":
        status = "waiting";
        activeRunId = null;
        break;
      case "decided":
        activeRunId = null;
        if (event.action === "resume") {
          status = "queued";
        } else if (event.action === "return_external") {
          status = "external";
        } else if (event.action === "finish") {
          status = "done";
        } else if (event.action === "cancel") {
          status = "cancelled";
        }
        break;
      case "external":
        status = "external";
        activeRunId = null;
        break;
      case "done":
        status = "done";
        activeRunId = null;
        break;
      case "cancelled":
        status = "cancelled";
        activeRunId = null;
        break;
      case "contract_updated":
        if (event.to_version > contractVersion) {
          contractVersion = event.to_version;
        }
        break;
      case "priority_changed":
        priority = event.to;
        break;
      case "track_escalated":
        track = event.to;
        break;
    }
  }

  return {
    status,
    stage,
    round,
    activeRunId,
    priority,
    track,
    contractVersion,
    updatedAt,
  };
}

function uniqueArchivePath(dir: string, baseNameWithoutExt: string): string {
  const safeBase = assertSafeSegment(baseNameWithoutExt, "archiveFile");
  let candidate = path.join(dir, `${safeBase}.md`);
  if (!fs.existsSync(candidate)) {
    return candidate;
  }
  candidate = path.join(dir, `${safeBase}-${randomUUID().slice(0, 8)}.md`);
  return candidate;
}

function isTerminalStatus(status: TaskStatus): boolean {
  return status === "done" || status === "cancelled";
}

function propagateEffectivePriorities(
  cards: Map<string, TaskCard>,
  derivedByTask: Map<string, DerivedTaskState>,
): Map<string, Priority> {
  const effective = new Map<string, Priority>();
  for (const [taskId, derived] of derivedByTask) {
    effective.set(taskId, derived.priority);
  }

  const visit = (taskId: string, inheritedPriority: Priority, visited: Set<string>): void => {
    const card = cards.get(taskId);
    const derived = derivedByTask.get(taskId);
    if (!card || !derived || isTerminalStatus(derived.status)) {
      return;
    }

    const current = effective.get(taskId) ?? derived.priority;
    if (PRIORITY_RANK[inheritedPriority] < PRIORITY_RANK[current]) {
      effective.set(taskId, inheritedPriority);
    }

    const nextPriority = effective.get(taskId) ?? current;
    for (const depId of card.depends_on) {
      if (visited.has(depId)) continue;
      visited.add(depId);
      visit(depId, nextPriority, visited);
      visited.delete(depId);
    }
  };

  for (const [taskId, derived] of derivedByTask) {
    if (!isTerminalStatus(derived.status)) {
      visit(taskId, derived.priority, new Set([taskId]));
    }
  }

  return effective;
}

interface ScannedRun {
  runDirName: string;
  runMeta: RunMeta | null;
  hasReceipt: boolean;
  events: RunEvent[];
}

function scanTaskRuns(paths: KilnPaths, taskId: string): ScannedRun[] {
  const runsDir = paths.runsDir(taskId);
  if (!fs.existsSync(runsDir)) {
    return [];
  }

  const entries = fs.readdirSync(runsDir, { withFileTypes: true });
  const scanned: ScannedRun[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const runDirName = assertSafeSegment(entry.name, "runDirName");
    const runYamlPath = paths.runYaml(taskId, runDirName);
    const receiptPath = paths.receiptMd(taskId, runDirName);
    const eventsPath = paths.runEventsNdjson(taskId, runDirName);

    const runMeta = readYamlOptional(runYamlPath, RunMetaSchema);
    const hasReceipt = fs.existsSync(receiptPath);
    const events = readNdjsonValidated(eventsPath, RunEventSchema);

    scanned.push({ runDirName, runMeta, hasReceipt, events });
  }

  return scanned;
}

/**
 * Dual-layer Kiln storage engine:
 * - Source of truth lives in atomic files under `~/.kiln/`.
 * - SQLite (`index.sqlite`) provides fast queries and synchronous lease/path locks,
 *   and is 100% rebuildable from disk on missing index or explicit `rebuildIndexFromDisk()`.
 */
export class KilnStore {
  readonly paths: KilnPaths;
  private _sqlite: KilnSqliteIndex | null = null;

  constructor(options: { kilnHome?: string } = {}) {
    this.paths = new KilnPaths(options.kilnHome);
    if (fs.existsSync(this.paths.indexSqlite)) {
      this._sqlite = new KilnSqliteIndex(this.paths.indexSqlite);
    } else {
      this.rebuildIndexFromDisk();
    }
  }

  /**
   * Active SQLite derived index handle. Throws if the store has been closed.
   */
  get sqlite(): KilnSqliteIndex {
    if (!this._sqlite) {
      throw new Error("KilnStore is closed");
    }
    return this._sqlite;
  }

  createTask(card: TaskCard, briefMarkdown: string): void {
    const parsed = TaskCardSchema.parse(card);
    assertSafeSegment(parsed.space, "space");
    const cardPath = this.paths.cardYaml(parsed.id);
    if (fs.existsSync(cardPath)) {
      throw new Error(`Task "${parsed.id}" already exists at ${cardPath}`);
    }

    writeYamlAtomic(cardPath, parsed, TaskCardSchema);
    writeFileAtomic(this.paths.briefMd(parsed.id), briefMarkdown);
    appendNdjsonLine(
      this.paths.stateEventsNdjson(parsed.id),
      StateEventSchema.parse({ type: "queued", at: parsed.created_at }),
    );

    this.sqlite.upsertTaskIndex({
      id: parsed.id,
      space: parsed.space,
      parent_id: parsed.parent ?? null,
      title: parsed.title,
      priority: parsed.priority,
      effective_priority: parsed.priority,
      track: parsed.track,
      workspace_mode: parsed.workspace_mode,
      status: "queued",
      contract_version: parsed.contract_version,
      created_at: parsed.created_at,
      updated_at: parsed.updated_at,
    });
  }

  readTaskCard(taskId: string): TaskCard {
    return readYamlValidated(this.paths.cardYaml(taskId), TaskCardSchema);
  }

  readStateEvents(taskId: string): StateEvent[] {
    assertSafeSegment(taskId, "taskId");
    return readNdjsonValidated(this.paths.stateEventsNdjson(taskId), StateEventSchema);
  }

  getTaskIndex(taskId: string): TaskIndexRow | null {
    return this.sqlite.getTaskIndex(taskId);
  }

  listTasks(filter?: { space?: string; status?: TaskStatus }): TaskIndexRow[] {
    return this.sqlite.listTaskIndices(filter);
  }

  /**
   * Persists `RUN.yaml` (including `session_ref` & `contract_version`) and optional `HANDOFF.md`
   * BEFORE attempting to acquire the SQLite stage lease.
   * Does not advance task state if lease acquisition fails.
   */
  persistRunBeforeDispatch(
    runMeta: RunMeta,
    runDirName: string,
    handoffMarkdown?: string,
  ): AcquireStageLeaseResult {
    const parsed = RunMetaSchema.parse(runMeta);
    const taskIndex = this.sqlite.getTaskIndex(parsed.task_id);
    if (!taskIndex) {
      throw new Error(`Cannot dispatch run for unknown task "${parsed.task_id}"`);
    }
    if (parsed.contract_version !== taskIndex.contract_version) {
      throw new Error(
        `Cannot dispatch run "${parsed.run_id}" for task "${parsed.task_id}": contract_version ${parsed.contract_version} does not match current contract_version ${taskIndex.contract_version}`,
      );
    }

    const runYamlPath = this.paths.runYaml(parsed.task_id, runDirName);
    const existingMeta = readYamlOptional(runYamlPath, RunMetaSchema);
    if (existingMeta && existingMeta.run_id !== parsed.run_id) {
      throw new Error(
        `Run directory "${runDirName}" already belongs to run "${existingMeta.run_id}"`,
      );
    }

    writeYamlAtomic(runYamlPath, parsed, RunMetaSchema);
    if (handoffMarkdown !== undefined) {
      writeFileAtomic(this.paths.handoffMd(parsed.task_id, runDirName), handoffMarkdown);
    }

    const leaseResult = this.sqlite.acquireStageLease({
      task_id: parsed.task_id,
      run_id: parsed.run_id,
      stage: parsed.stage,
      round: parsed.round,
      contract_version: parsed.contract_version,
      session_ref: JSON.stringify(parsed.session_ref),
      started_at: parsed.started_at,
      heartbeat_at: parsed.started_at,
    });

    if (!leaseResult.acquired) {
      return leaseResult;
    }

    const runningEvent = StateEventSchema.parse({
      type: "running",
      at: parsed.started_at,
      stage: parsed.stage,
      round: parsed.round,
      run_id: parsed.run_id,
    });
    appendNdjsonLine(this.paths.stateEventsNdjson(parsed.task_id), runningEvent);
    this.sqlite.updateTaskStatusAndPriority(parsed.task_id, {
      status: "running",
      updated_at: parsed.started_at,
    });

    return { acquired: true };
  }

  /**
   * Validates the active stage lease atomically inside SQLite and writes `RECEIPT.md`
   * on commit, or archives stale/mismatched receipts into `history/` without advancing state.
   */
  submitReceipt(params: SubmitReceiptInput): SubmitReceiptResult {
    const taskId = assertSafeSegment(params.taskId, "taskId");
    const runId = assertSafeSegment(params.runId, "runId");
    const runDirName = assertSafeSegment(params.runDirName, "runDirName");
    const timestamp = params.now ?? new Date().toISOString();

    const dirRunMeta = readYamlValidated(
      this.paths.runYaml(taskId, runDirName),
      RunMetaSchema,
    );
    if (dirRunMeta.task_id !== taskId || dirRunMeta.run_id !== runId) {
      throw new Error(
        `Run directory "${runDirName}" belongs to (${dirRunMeta.task_id}, ${dirRunMeta.run_id}), cannot submit receipt for (${taskId}, ${runId})`,
      );
    }

    if (dirRunMeta.contract_version === params.contractVersion) {
      const committedReceiptPath = this.sqlite.transaction((): string | null => {
        const { committed } = this.sqlite.completeStageLease(
          taskId,
          runId,
          params.contractVersion,
          timestamp,
        );
        if (!committed) {
          return null;
        }
        const receiptPath = this.paths.receiptMd(taskId, runDirName);
        writeFileAtomic(receiptPath, params.markdown);
        return receiptPath;
      });

      if (committedReceiptPath !== null) {
        return { accepted: true, receiptPath: committedReceiptPath };
      }
    }

    const historyDir = this.paths.runHistoryDir(taskId, runDirName);
    ensureDir(historyDir);
    const archivedPath = uniqueArchivePath(historyDir, `${runId}-stale-${Date.now()}`);
    writeFileAtomic(archivedPath, params.markdown);

    return {
      accepted: false,
      archivedPath,
      reason: "lease_mismatch_or_expired",
    };
  }

  /**
   * Monotonically increments `contract_version`, merges contract updates, expires active
   * leases bound to prior versions, and moves superseded receipts to `history/`.
   */
  bumpContractVersion(params: BumpContractVersionInput): BumpContractVersionResult {
    const taskId = assertSafeSegment(params.taskId, "taskId");
    const timestamp = params.now ?? new Date().toISOString();
    const card = this.readTaskCard(taskId);
    const oldVersion = card.contract_version;
    const newVersion = oldVersion + 1;

    const mergedContract = CardContractSchema.parse({
      ...card.contract,
      ...params.contractPatch,
      ...(params.acceptFilesHash !== undefined
        ? { accept_files_hash: params.acceptFilesHash }
        : {}),
    });

    const updatedCard = TaskCardSchema.parse({
      ...card,
      contract_version: newVersion,
      contract: mergedContract,
      updated_at: timestamp,
    });

    writeYamlAtomic(this.paths.cardYaml(taskId), updatedCard, TaskCardSchema);

    const contractEvent = StateEventSchema.parse({
      type: "contract_updated",
      at: timestamp,
      from_version: oldVersion,
      to_version: newVersion,
      affected_stages: params.affectedStages,
    });
    appendNdjsonLine(this.paths.stateEventsNdjson(taskId), contractEvent);

    this.sqlite.expireActiveLeaseByTask(taskId, timestamp, "expired");
    this.sqlite.updateTaskStatusAndPriority(taskId, {
      contract_version: newVersion,
      updated_at: timestamp,
    });

    const affectedSet = new Set(params.affectedStages);
    const minAffectedOrder =
      params.affectedStages.length > 0
        ? Math.min(...params.affectedStages.map((s) => STAGE_ORDER[s]))
        : -1;

    const archivedReceipts: string[] = [];
    const runsDir = this.paths.runsDir(taskId);
    if (fs.existsSync(runsDir)) {
      for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const runDirName = assertSafeSegment(entry.name, "runDirName");
        const receiptPath = this.paths.receiptMd(taskId, runDirName);
        if (!fs.existsSync(receiptPath)) continue;

        const meta = readYamlOptional(
          this.paths.runYaml(taskId, runDirName),
          RunMetaSchema,
        );

        let runId: string;
        let runContractVersion: number;
        let stageMatch: boolean;

        if (meta) {
          runId = meta.run_id;
          runContractVersion = meta.contract_version;
          stageMatch =
            params.affectedStages.length === 0 ||
            affectedSet.has(meta.stage) ||
            STAGE_ORDER[meta.stage] >= minAffectedOrder;
        } else {
          const parsedFm = parseFrontmatterMarkdown(fs.readFileSync(receiptPath, "utf8"));
          const rawRunId = parsedFm.frontmatter.run_id;
          const rawVer = parsedFm.frontmatter.contract_version;
          if (typeof rawRunId !== "string" || typeof rawVer !== "number") {
            continue;
          }
          runId = rawRunId;
          runContractVersion = rawVer;
          stageMatch = true;
        }

        if (runContractVersion < newVersion && stageMatch) {
          const historyDir = this.paths.runHistoryDir(taskId, runDirName);
          ensureDir(historyDir);
          const destPath = uniqueArchivePath(
            historyDir,
            `${assertSafeSegment(runId, "runId")}-superseded-v${runContractVersion}`,
          );
          fs.renameSync(receiptPath, destPath);
          archivedReceipts.push(destPath);
        }
      }
    }

    return { newVersion, archivedReceipts };
  }

  /**
   * Validates and appends a state event to `state_events.ndjson`, updates derived task
   * index fields, and expires/cancels active leases when leaving `running`.
   * Never writes fabricated decisions to `decisions.md` or `ledger/`.
   */
  appendStateEvent(taskId: string, event: StateEvent): DerivedTaskState {
    const safeTaskId = assertSafeSegment(taskId, "taskId");
    const parsedEvent = StateEventSchema.parse(event);
    const card = this.readTaskCard(safeTaskId);
    const existingEvents = this.readStateEvents(safeTaskId);

    appendNdjsonLine(this.paths.stateEventsNdjson(safeTaskId), parsedEvent);

    if (
      parsedEvent.type === "cancelled" ||
      (parsedEvent.type === "decided" && parsedEvent.action === "cancel")
    ) {
      this.sqlite.expireActiveLeaseByTask(safeTaskId, parsedEvent.at, "cancelled");
    } else if (
      parsedEvent.type === "queued" ||
      parsedEvent.type === "resumed" ||
      parsedEvent.type === "paused" ||
      parsedEvent.type === "waiting" ||
      parsedEvent.type === "external" ||
      parsedEvent.type === "done" ||
      parsedEvent.type === "decided"
    ) {
      this.sqlite.expireActiveLeaseByTask(safeTaskId, parsedEvent.at, "expired");
    }

    const derived = deriveTaskStatus(card, [...existingEvents, parsedEvent]);
    const existingRow = this.sqlite.getTaskIndex(safeTaskId);

    let effectivePriority = derived.priority;
    if (existingRow) {
      const keepInherited =
        existingRow.effective_priority !== existingRow.priority &&
        PRIORITY_RANK[existingRow.effective_priority] < PRIORITY_RANK[derived.priority];
      if (keepInherited) {
        effectivePriority = existingRow.effective_priority;
      }
    }

    this.sqlite.updateTaskStatusAndPriority(safeTaskId, {
      status: derived.status,
      priority: derived.priority,
      effective_priority: effectivePriority,
      track: derived.track,
      contract_version: derived.contractVersion,
      updated_at: derived.updatedAt,
    });

    return derived;
  }

  /**
   * Validates and appends a run event to `runs/<runDirName>/events.ndjson`.
   * When `event.kind === "usage"`, idempotently records the turn in `usage_turns`.
   */
  recordRunEvent(taskId: string, runDirName: string, event: RunEvent): void {
    const safeTaskId = assertSafeSegment(taskId, "taskId");
    const safeRunDir = assertSafeSegment(runDirName, "runDirName");
    const parsedEvent = RunEventSchema.parse(event);

    let usageRunId: string | null = null;
    if (parsedEvent.kind === "usage") {
      const runMeta = readYamlValidated(
        this.paths.runYaml(safeTaskId, safeRunDir),
        RunMetaSchema,
      );
      if (runMeta.task_id !== safeTaskId) {
        throw new Error(
          `RUN.yaml task_id "${runMeta.task_id}" does not match "${safeTaskId}"`,
        );
      }
      usageRunId = runMeta.run_id;
    }

    appendNdjsonLine(this.paths.runEventsNdjson(safeTaskId, safeRunDir), parsedEvent);

    if (parsedEvent.kind === "usage" && usageRunId !== null) {
      this.sqlite.upsertUsageTurn({
        run_id: usageRunId,
        turn_id: parsedEvent.turnId,
        task_id: safeTaskId,
        agent: parsedEvent.agent,
        model: parsedEvent.model,
        input_tokens: parsedEvent.inputTokens,
        cached_input_tokens: parsedEvent.cachedInputTokens ?? 0,
        output_tokens: parsedEvent.outputTokens,
        recorded_at: parsedEvent.at,
      });
    }
  }

  readConfig(name: "roles"): RolesConfig | null;
  readConfig(name: "limits"): LimitsConfig | null;
  readConfig(name: "pricing"): PricingConfig | null;
  readConfig(name: KilnConfigName): RolesConfig | LimitsConfig | PricingConfig | null {
    const schema = CONFIG_SCHEMAS[name] as AnyZodType<
      RolesConfig | LimitsConfig | PricingConfig
    >;
    return readYamlOptional(this.paths.configFile(name), schema);
  }

  writeConfig(name: "roles", data: RolesConfig): void;
  writeConfig(name: "limits", data: LimitsConfig): void;
  writeConfig(name: "pricing", data: PricingConfig): void;
  writeConfig(
    name: KilnConfigName,
    data: RolesConfig | LimitsConfig | PricingConfig,
  ): void {
    const schema = CONFIG_SCHEMAS[name] as AnyZodType<
      RolesConfig | LimitsConfig | PricingConfig
    >;
    writeYamlAtomic(this.paths.configFile(name), data, schema);
  }

  readSpace(spaceId: string): SpaceConfig | null {
    return readYamlOptional(this.paths.spaceFile(spaceId), SpaceConfigSchema);
  }

  writeSpace(space: SpaceConfig): void {
    const parsed = SpaceConfigSchema.parse(space);
    assertSafeSegment(parsed.id, "spaceId");
    writeYamlAtomic(this.paths.spaceFile(parsed.id), parsed, SpaceConfigSchema);
  }

  readLedger(spaceId: string): LedgerFile | null {
    return readYamlOptional(this.paths.ledgerFile(spaceId), LedgerFileSchema);
  }

  writeLedger(ledger: LedgerFile): void {
    const parsed = LedgerFileSchema.parse(ledger);
    assertSafeSegment(parsed.space, "spaceId");
    writeYamlAtomic(this.paths.ledgerFile(parsed.space), parsed, LedgerFileSchema);
  }

  readDraft(draftId: string): DraftCard | null {
    return readYamlOptional(this.paths.draftYaml(draftId), DraftCardSchema);
  }

  writeDraft(draft: DraftCard): void {
    const parsed = DraftCardSchema.parse(draft);
    assertSafeSegment(parsed.id, "draftId");
    writeYamlAtomic(this.paths.draftYaml(parsed.id), parsed, DraftCardSchema);
  }

  listDrafts(): DraftCard[] {
    if (!fs.existsSync(this.paths.draftsDir)) {
      return [];
    }
    const entries = fs.readdirSync(this.paths.draftsDir, { withFileTypes: true });
    const drafts: DraftCard[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const draft = this.readDraft(entry.name);
      if (draft) {
        drafts.push(draft);
      }
    }
    drafts.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return drafts;
  }

  getStageLease(taskId: string): StageLeaseRow | null {
    return this.sqlite.getStageLease(taskId);
  }

  listActiveStageLeases(): StageLeaseRow[] {
    return this.sqlite.listActiveStageLeases();
  }

  acquireHostPathLocks(
    taskId: string,
    canonicalPaths: readonly string[],
    now = new Date().toISOString(),
  ): AcquireHostPathLocksResult {
    return this.sqlite.acquireHostPathLocks(taskId, canonicalPaths, now);
  }

  releaseHostPathLocks(taskId: string): number {
    return this.sqlite.releaseHostPathLocks(taskId);
  }

  listHostPathLocks(taskId?: string): HostPathLockRow[] {
    return this.sqlite.listHostPathLocks(taskId);
  }

  listUsageTurns(filter?: { taskId?: string; runId?: string }): UsageTurnRow[] {
    return this.sqlite.listUsageTurns(filter);
  }

  getTaskTotalTokens(taskId: string): TaskTokenTotals {
    return this.sqlite.getTaskTotalTokens(taskId);
  }

  /**
   * Reconstructs `index.sqlite` (and removes stale WAL/SHM files) completely from disk
   * files under `~/.kiln/tasks/`, restoring `tasks_index`, active `stage_leases`,
   * and idempotent `usage_turns`.
   */
  rebuildIndexFromDisk(): void {
    const cards = new Map<string, TaskCard>();
    const derivedByTask = new Map<string, DerivedTaskState>();
    const runsByTask = new Map<string, ScannedRun[]>();

    if (fs.existsSync(this.paths.tasksDir)) {
      for (const entry of fs.readdirSync(this.paths.tasksDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) {
          continue;
        }
        const taskId = assertSafeSegment(entry.name, "taskId");
        const cardPath = this.paths.cardYaml(taskId);
        if (!fs.existsSync(cardPath)) {
          continue;
        }

        const card = readYamlValidated(cardPath, TaskCardSchema);
        if (card.id !== taskId) {
          throw new Error(
            `Corrupted task directory "${taskId}": card.yaml id is "${card.id}"`,
          );
        }
        const stateEvents = this.readStateEvents(taskId);
        const derived = deriveTaskStatus(card, stateEvents);
        const runs = scanTaskRuns(this.paths, taskId);

        cards.set(taskId, card);
        derivedByTask.set(taskId, derived);
        runsByTask.set(taskId, runs);
      }
    }

    const effectivePriorities = propagateEffectivePriorities(cards, derivedByTask);

    if (this._sqlite) {
      this._sqlite.close();
      this._sqlite = null;
    }

    const dbPath = this.paths.indexSqlite;
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });

    const sqlite = new KilnSqliteIndex(dbPath);
    try {
      sqlite.transaction(() => {
        for (const [taskId, card] of cards) {
          const derived = derivedByTask.get(taskId);
          if (!derived) continue;
          const effectivePriority = effectivePriorities.get(taskId) ?? derived.priority;

          sqlite.upsertTaskIndex({
            id: card.id,
            space: card.space,
            parent_id: card.parent ?? null,
            title: card.title,
            priority: derived.priority,
            effective_priority: effectivePriority,
            track: derived.track,
            workspace_mode: card.workspace_mode,
            status: derived.status,
            contract_version: derived.contractVersion,
            created_at: card.created_at,
            updated_at: derived.updatedAt,
          });
        }

        for (const [taskId, runs] of runsByTask) {
          const derived = derivedByTask.get(taskId);
          if (!derived) continue;

          for (const run of runs) {
            if (run.runMeta) {
              for (const ev of run.events) {
                if (ev.kind === "usage") {
                  sqlite.upsertUsageTurn({
                    run_id: run.runMeta.run_id,
                    turn_id: ev.turnId,
                    task_id: taskId,
                    agent: ev.agent,
                    model: ev.model,
                    input_tokens: ev.inputTokens,
                    cached_input_tokens: ev.cachedInputTokens ?? 0,
                    output_tokens: ev.outputTokens,
                    recorded_at: ev.at,
                  });
                }
              }
            }

            if (
              derived.status === "running" &&
              derived.activeRunId !== null &&
              run.runMeta !== null &&
              run.runMeta.run_id === derived.activeRunId &&
              !run.hasReceipt &&
              run.runMeta.contract_version === derived.contractVersion
            ) {
              const lastEvent = run.events.at(-1);
              const heartbeatAt = lastEvent ? lastEvent.at : run.runMeta.started_at;
              sqlite.acquireStageLease({
                task_id: taskId,
                run_id: run.runMeta.run_id,
                stage: run.runMeta.stage,
                round: run.runMeta.round,
                contract_version: run.runMeta.contract_version,
                session_ref: JSON.stringify(run.runMeta.session_ref),
                started_at: run.runMeta.started_at,
                heartbeat_at: heartbeatAt,
              });
            }
          }
        }
      });
    } catch (error) {
      sqlite.close();
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
      throw error;
    }

    this._sqlite = sqlite;
  }

  close(): void {
    if (this._sqlite) {
      this._sqlite.close();
      this._sqlite = null;
    }
  }
}
