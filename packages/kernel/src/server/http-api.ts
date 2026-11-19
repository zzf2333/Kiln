import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { Hono, type Context } from "hono";
import { z, ZodError } from "zod";
import {
  CardContractSchema,
  CardLimitsSchema,
  DecideRequestSchema,
  DraftCardSchema,
  GateReportSchema,
  HashMismatchErrorSchema,
  LimitsConfigSchema,
  PricingConfigSchema,
  PrioritySchema,
  PriorityUpdateRequestSchema,
  RolesConfigSchema,
  RunEventSchema,
  RunMetaSchema,
  SessionRefSchema,
  StageIdSchema,
  TaskCardSchema,
  TrackSchema,
  WorkspaceModeSchema,
  type PendingDecision,
  type SpaceConfig,
  type StageId,
} from "@kiln/protocol";
import { restoreHostScopedBackup } from "../gate/index.js";
import {
  InvalidStateTransitionError,
  TaskStateMachine,
  type ContractUpdateInput,
} from "../state/index.js";
import {
  KilnStore,
  assertSafeSegment,
  deriveTaskStatus,
  readNdjsonValidated,
  readYamlOptional,
} from "../store/index.js";
import type { CaffeinateController } from "./caffeinate.js";
import { ServerHttpError, mapDomainError } from "./errors.js";
import {
  computeUsageSnapshot,
  countRunningLeafTasks,
  PendingDecisionStore,
  readLedgerProposals,
  readOptionalText,
  readTaskCardOptional,
  resolveCardLimits,
} from "./pending-decisions.js";
import type { SseHub } from "./sse.js";

export interface HttpApiDependencies {
  store: KilnStore;
  stateMachine: TaskStateMachine;
  sseHub: SseHub;
  pendingDecisions: PendingDecisionStore;
  caffeinate: CaffeinateController;
  version?: string;
}

const UpsertDraftRequestSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().optional(),
  space: z.string().min(1).optional(),
  priority: PrioritySchema.optional(),
  track: TrackSchema.optional(),
  workspace_mode: WorkspaceModeSchema.optional(),
  depends_on: z.array(z.string().min(1)).optional(),
  contract: CardContractSchema.partial().optional(),
  session_ref: SessionRefSchema.nullable().optional(),
});

const CommitDraftRequestSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  space: z.string().min(1).optional(),
  priority: PrioritySchema.optional(),
  track: TrackSchema.optional(),
  workspace_mode: WorkspaceModeSchema.optional(),
  parent: z.string().min(1).nullable().optional(),
  depends_on: z.array(z.string().min(1)).optional(),
  contract: CardContractSchema.partial().optional(),
  limits: CardLimitsSchema.optional(),
  brief_markdown: z.string().min(1),
});

const OptionalReasonBodySchema = z.object({
  reason: z.string().min(1).optional(),
});

const ContractUpdatePayloadSchema = z.object({
  contractPatch: CardContractSchema.partial(),
  affectedStages: z.array(StageIdSchema).min(1),
  acceptFilesHash: z.string().min(1).optional(),
});

const ContractUpdateSnakePayloadSchema = z.object({
  contract_patch: CardContractSchema.partial(),
  affected_stages: z.array(StageIdSchema).min(1),
  accept_files_hash: z.string().min(1).optional(),
});

const DecideExtensionsSchema = z.object({
  affectedStages: z.array(StageIdSchema).optional(),
  affected_stages: z.array(StageIdSchema).optional(),
  contractUpdate: ContractUpdatePayloadSchema.optional(),
  contract_update: ContractUpdateSnakePayloadSchema.optional(),
});

async function readJsonBodyStrict(c: Context): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.trim().length === 0) {
    throw new ServerHttpError(400, {
      error: "invalid_json",
      message: "Request body cannot be empty",
    });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ServerHttpError(400, {
      error: "invalid_json",
      message: "Request body must be valid JSON",
    });
  }
}

async function readJsonBodyOptional(c: Context): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ServerHttpError(400, {
      error: "invalid_json",
      message: "Request body must be valid JSON",
    });
  }
}

function loadAllSpaces(
  store: KilnStore,
  extraSpaceIds: Iterable<string>,
): Record<string, SpaceConfig> {
  const spaceIds = new Set<string>(extraSpaceIds);
  if (fs.existsSync(store.paths.spacesDir)) {
    for (const entry of fs.readdirSync(store.paths.spacesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      spaceIds.add(assertSafeSegment(entry.name, "spaceId"));
    }
  }

  const spaces: Record<string, SpaceConfig> = {};
  for (const spaceId of Array.from(spaceIds).sort()) {
    const cfg = store.readSpace(spaceId);
    if (cfg) {
      spaces[spaceId] = cfg;
    }
  }
  return spaces;
}

function parseLastEventIdParam(rawValue: string | undefined): number | null {
  if (rawValue === undefined) {
    return null;
  }
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new ServerHttpError(400, {
      error: "invalid_last_event_id",
      message: `Invalid Last-Event-ID "${rawValue}": expected non-negative integer`,
    });
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ServerHttpError(400, {
      error: "invalid_last_event_id",
      message: `Invalid Last-Event-ID "${rawValue}": out of safe integer range`,
    });
  }
  return parsed;
}

/**
 * Creates the Hono REST + SSE application serving Web/menubar clients on `127.0.0.1`.
 */
export function createHttpApiApp(deps: HttpApiDependencies): Hono {
  const { store, stateMachine, sseHub, pendingDecisions, caffeinate } = deps;
  const version = deps.version ?? "0.1.0";
  const app = new Hono();

  const requireExistingTask = (rawId: string): string => {
    const taskId = assertSafeSegment(rawId, "taskId");
    const card = readTaskCardOptional(store, taskId);
    if (!card) {
      throw new ServerHttpError(404, {
        error: "task_not_found",
        taskId,
        message: `Task "${taskId}" does not exist`,
      });
    }
    return taskId;
  };

  app.onError((err, c) => {
    const mapped = mapDomainError(err);
    return c.json(mapped.payload, mapped.statusCode);
  });

  app.get("/api/health", (c) => {
    return c.json({
      ok: true,
      pid: process.pid,
      version,
    });
  });

  app.get("/api/bootstrap", (c) => {
    const roles = store.readConfig("roles");
    const limits = store.readConfig("limits");
    const pricing = store.readConfig("pricing");
    const taskRows = store.listTasks();
    const spaces = loadAllSpaces(
      store,
      taskRows.map((row) => row.space),
    );

    const tasks = taskRows.map((row) => {
      const card = store.readTaskCard(row.id);
      const stateEvents = store.readStateEvents(row.id);
      const derived = deriveTaskStatus(card, stateEvents);
      const taskTurns = store.listUsageTurns({ taskId: row.id });
      const taskUsage = computeUsageSnapshot(taskTurns, pricing);

      return {
        id: row.id,
        space: row.space,
        parent_id: row.parent_id,
        title: row.title,
        priority: row.priority,
        effective_priority: row.effective_priority,
        track: row.track,
        workspace_mode: row.workspace_mode,
        status: row.status,
        stage: derived.stage,
        round: derived.round,
        active_run_id: derived.activeRunId,
        contract_version: row.contract_version,
        depends_on: card.depends_on,
        created_at: row.created_at,
        updated_at: row.updated_at,
        tokens: {
          input_tokens: taskUsage.inputTokens,
          cached_input_tokens: taskUsage.cachedInputTokens,
          output_tokens: taskUsage.outputTokens,
          total_tokens: taskUsage.totalTokens,
        },
        cost_usd: taskUsage.costUsd,
      };
    });

    const allTurns = store.listUsageTurns();
    const usage = computeUsageSnapshot(allTurns, pricing);

    return c.json({
      tasks,
      pendingDecisions: pendingDecisions.listAll(),
      drafts: store.listDrafts(),
      spaces,
      settings: { roles, limits, pricing },
      roles,
      limits,
      pricing,
      usage,
      runningCount: countRunningLeafTasks(store),
    });
  });

  app.get("/api/tasks/:id", (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const card = store.readTaskCard(taskId);
    const stateEvents = store.readStateEvents(taskId);
    const derived = deriveTaskStatus(card, stateEvents);
    const taskIndex = store.getTaskIndex(taskId);
    const pricing = store.readConfig("pricing");

    const brief = readOptionalText(store.paths.briefMd(taskId)) ?? "";
    const decisions = readOptionalText(store.paths.decisionsMd(taskId)) ?? "";
    const pendingDecision = pendingDecisions.get(taskId);
    const ledgerProposals = readLedgerProposals(store, taskId);

    const runs: Array<Record<string, unknown>> = [];
    const runsDir = store.paths.runsDir(taskId);
    if (fs.existsSync(runsDir)) {
      const dirNames = fs
        .readdirSync(runsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => assertSafeSegment(entry.name, "runDirName"))
        .sort((a, b) => a.localeCompare(b));

      for (const runDirName of dirNames) {
        const meta = readYamlOptional(store.paths.runYaml(taskId, runDirName), RunMetaSchema);
        const handoff = readOptionalText(store.paths.handoffMd(taskId, runDirName));
        const receipt = readOptionalText(store.paths.receiptMd(taskId, runDirName));
        const gate = readYamlOptional(store.paths.gateYaml(taskId, runDirName), GateReportSchema);
        const events = readNdjsonValidated(
          store.paths.runEventsNdjson(taskId, runDirName),
          RunEventSchema,
        );

        runs.push({
          dirName: runDirName,
          meta,
          handoff,
          receipt,
          gate,
          events,
          eventsCount: events.length,
        });
      }
    }

    const usageTurns = store.listUsageTurns({ taskId });
    const usage = computeUsageSnapshot(usageTurns, pricing);

    return c.json({
      card,
      state: {
        ...derived,
        effectivePriority: taskIndex?.effective_priority ?? derived.priority,
      },
      brief,
      decisions,
      pendingDecision,
      ledgerProposals,
      runs,
      usageTurns,
      usage,
    });
  });

  app.post("/api/drafts", async (c) => {
    const rawBody = await readJsonBodyStrict(c);
    const input = UpsertDraftRequestSchema.parse(rawBody);
    const draftId = assertSafeSegment(
      input.id ?? `d-${randomUUID().slice(0, 8)}`,
      "draftId",
    );
    if (input.space !== undefined) {
      assertSafeSegment(input.space, "space");
    }

    const existing = store.readDraft(draftId);
    const now = new Date().toISOString();
    const draft = DraftCardSchema.parse({
      schema_version: 1,
      id: draftId,
      title: input.title ?? existing?.title ?? "",
      space: input.space ?? existing?.space ?? "local",
      priority: input.priority ?? existing?.priority ?? "P2",
      track: input.track ?? existing?.track ?? "L2",
      workspace_mode: input.workspace_mode ?? existing?.workspace_mode ?? "git_worktree",
      depends_on: input.depends_on ?? existing?.depends_on ?? [],
      contract: {
        ...(existing?.contract ?? {}),
        ...(input.contract ?? {}),
      },
      session_ref:
        input.session_ref !== undefined
          ? input.session_ref
          : (existing?.session_ref ?? null),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });

    store.writeDraft(draft);
    return c.json({ ok: true, draft }, existing ? 200 : 201);
  });

  app.post("/api/drafts/:id/commit", async (c) => {
    const draftId = assertSafeSegment(c.req.param("id"), "draftId");
    const existingDraft = store.readDraft(draftId);
    if (!existingDraft) {
      throw new ServerHttpError(404, {
        error: "draft_not_found",
        draftId,
        message: `Draft "${draftId}" does not exist`,
      });
    }

    const rawBody = await readJsonBodyStrict(c);
    const input = CommitDraftRequestSchema.parse(rawBody);

    const taskId = assertSafeSegment(
      input.id ?? `t-${randomUUID().slice(0, 8)}`,
      "taskId",
    );
    const space = assertSafeSegment(input.space ?? existingDraft.space, "space");
    const workspaceMode = input.workspace_mode ?? existingDraft.workspace_mode;
    if (workspaceMode === "external_only") {
      throw new ServerHttpError(400, {
        error: "unsupported_workspace_mode",
        message: 'Unsupported workspace_mode: "external_only" is Post-MVP',
      });
    }

    const now = new Date().toISOString();
    const card = TaskCardSchema.parse({
      schema_version: 1,
      id: taskId,
      title: input.title ?? existingDraft.title,
      space,
      priority: input.priority ?? existingDraft.priority,
      track: input.track ?? existingDraft.track,
      workspace_mode: workspaceMode,
      parent: input.parent ?? null,
      depends_on: input.depends_on ?? existingDraft.depends_on,
      contract_version: 1,
      contract: {
        ...existingDraft.contract,
        ...(input.contract ?? {}),
      },
      limits: resolveCardLimits(store, input.limits),
      created_at: now,
      updated_at: now,
    });

    const created = stateMachine.createTask(card, input.brief_markdown);
    if (created.state.status === "waiting") {
      const dec = pendingDecisions.ensureUpstreamCancelledDecision(created.card.id);
      if (dec) {
        sseHub.publish({
          type: "decision.requested",
          taskId: created.card.id,
          priority: created.card.priority,
          question: dec.question,
        });
      }
    }
    caffeinate.syncRunningCount(countRunningLeafTasks(store));
    sseHub.publish({
      type: "task.updated",
      taskId: created.card.id,
      patch: {
        status: created.state.status,
        priority: created.card.priority,
        effectivePriority: created.effectivePriority,
        contractVersion: created.card.contract_version,
      },
    });

    return c.json(
      {
        ok: true,
        card: created.card,
        state: {
          ...created.state,
          effectivePriority: created.effectivePriority,
        },
      },
      201,
    );
  });

  app.post("/api/tasks/:id/pause", async (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const body = OptionalReasonBodySchema.parse(await readJsonBodyOptional(c));
    const nextState = stateMachine.pauseTask(taskId, body.reason);
    caffeinate.syncRunningCount(countRunningLeafTasks(store));
    sseHub.publish({
      type: "task.updated",
      taskId,
      patch: {
        status: nextState.status,
        ...(nextState.stage !== null ? { stage: nextState.stage } : {}),
        ...(nextState.round !== null ? { round: nextState.round } : {}),
        contractVersion: nextState.contractVersion,
      },
    });
    return c.json({ ok: true, taskId, state: nextState });
  });

  app.post("/api/tasks/:id/resume", async (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    await readJsonBodyOptional(c);
    const nextState = stateMachine.resumeTask(taskId);
    let waitingDecision: PendingDecision | null = null;
    if (nextState.status === "waiting") {
      waitingDecision = pendingDecisions.ensureUpstreamCancelledDecision(taskId);
    }
    caffeinate.syncRunningCount(countRunningLeafTasks(store));
    if (waitingDecision) {
      sseHub.publish({
        type: "decision.requested",
        taskId,
        priority: store.getTaskIndex(taskId)?.priority ?? nextState.priority,
        question: waitingDecision.question,
      });
    }
    sseHub.publish({
      type: "task.updated",
      taskId,
      patch: {
        status: nextState.status,
        ...(nextState.stage !== null ? { stage: nextState.stage } : {}),
        ...(nextState.round !== null ? { round: nextState.round } : {}),
        contractVersion: nextState.contractVersion,
      },
    });
    return c.json({ ok: true, taskId, state: nextState });
  });

  const registerUpstreamCancelledDownstreams = (downstreamIds: readonly string[]): void => {
    for (const downstreamId of downstreamIds) {
      const downstreamDecision = pendingDecisions.ensureUpstreamCancelledDecision(downstreamId);
      if (downstreamDecision) {
        sseHub.publish({
          type: "decision.requested",
          taskId: downstreamId,
          priority: store.getTaskIndex(downstreamId)?.priority ?? "P2",
          question: downstreamDecision.question,
        });
      }
      sseHub.publish({
        type: "task.updated",
        taskId: downstreamId,
        patch: { status: "waiting" },
      });
    }
  };

  app.post("/api/tasks/:id/cancel", async (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const body = OptionalReasonBodySchema.parse(await readJsonBodyOptional(c));
    const result = stateMachine.cancelTask(taskId, body.reason);
    pendingDecisions.remove(taskId);
    caffeinate.syncRunningCount(countRunningLeafTasks(store));

    sseHub.publish({
      type: "task.updated",
      taskId,
      patch: {
        status: result.state.status,
        contractVersion: result.state.contractVersion,
      },
    });
    registerUpstreamCancelledDownstreams(result.waitingDownstreamTaskIds);

    return c.json({
      ok: true,
      taskId,
      state: result.state,
      waitingDownstreamTaskIds: result.waitingDownstreamTaskIds,
    });
  });

  app.post("/api/tasks/:id/priority", async (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const body = PriorityUpdateRequestSchema.parse(await readJsonBodyStrict(c));

    const previousEffective = new Map(
      store.listTasks().map((row) => [row.id, row.effective_priority]),
    );
    const result = stateMachine.changePriority(taskId, body.priority);
    const targetEffective = result.effectivePriorities.get(taskId) ?? result.state.priority;

    sseHub.publish({
      type: "task.updated",
      taskId,
      patch: {
        priority: result.state.priority,
        effectivePriority: targetEffective,
      },
    });

    for (const [otherTaskId, nextEffective] of result.effectivePriorities) {
      if (otherTaskId === taskId) {
        continue;
      }
      if (previousEffective.get(otherTaskId) !== nextEffective) {
        sseHub.publish({
          type: "task.updated",
          taskId: otherTaskId,
          patch: { effectivePriority: nextEffective },
        });
      }
    }

    return c.json({
      ok: true,
      taskId,
      state: result.state,
      effectivePriority: targetEffective,
    });
  });

  app.post("/api/tasks/:id/decide", async (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const rawBody = await readJsonBodyStrict(c);
    const decideReq = DecideRequestSchema.parse(rawBody);
    const ext = DecideExtensionsSchema.parse(rawBody);

    const pending = pendingDecisions.get(taskId);
    if (!pending) {
      throw new ServerHttpError(409, {
        error: "no_pending_decision",
        taskId,
        message: `Task "${taskId}" has no registered pending decision`,
      });
    }
    if (pending.id !== decideReq.decision_id) {
      throw new ServerHttpError(409, {
        error: "decision_id_mismatch",
        expectedDecisionId: pending.id,
        receivedDecisionId: decideReq.decision_id,
        message: `Task "${taskId}" is waiting on decision "${pending.id}", not "${decideReq.decision_id}"`,
      });
    }

    const selectedOption = pending.options.find((opt) => opt.id === decideReq.option_id);
    if (!selectedOption) {
      throw new ServerHttpError(400, {
        error: "invalid_option",
        optionId: decideReq.option_id,
        message: `Option "${decideReq.option_id}" does not exist in decision "${pending.id}"`,
      });
    }
    if (decideReq.action !== undefined && decideReq.action !== selectedOption.action) {
      throw new ServerHttpError(400, {
        error: "action_mismatch",
        expectedAction: selectedOption.action,
        receivedAction: decideReq.action,
        message: `Declared action "${decideReq.action}" does not match option "${selectedOption.id}" action "${selectedOption.action}"`,
      });
    }

    // Only persist option's ledger_rule into ledger/<space>.yaml when apply_ledger_rule is explicitly true.
    const decisionForApply: PendingDecision = decideReq.apply_ledger_rule
      ? pending
      : {
          ...pending,
          options: pending.options.map((opt) => {
            if (opt.id !== selectedOption.id) {
              return opt;
            }
            const { ledger_rule: _omitted, ...withoutLedgerRule } = opt;
            return withoutLedgerRule;
          }),
        };

    const affectedStages: StageId[] | undefined =
      ext.affectedStages ?? ext.affected_stages;

    let contractUpdate: ContractUpdateInput | undefined;
    if (ext.contractUpdate !== undefined) {
      contractUpdate = {
        contractPatch: ext.contractUpdate.contractPatch,
        affectedStages: ext.contractUpdate.affectedStages,
        ...(ext.contractUpdate.acceptFilesHash !== undefined
          ? { acceptFilesHash: ext.contractUpdate.acceptFilesHash }
          : {}),
      };
    } else if (ext.contract_update !== undefined) {
      contractUpdate = {
        contractPatch: ext.contract_update.contract_patch,
        affectedStages: ext.contract_update.affected_stages,
        ...(ext.contract_update.accept_files_hash !== undefined
          ? { acceptFilesHash: ext.contract_update.accept_files_hash }
          : {}),
      };
    }

    const shouldUnbindCancelled =
      selectedOption.action === "resume" &&
      (pending.reason === "upstream_cancelled" || pending.category === "upstream_cancelled");

    let result;
    try {
      result = stateMachine.applyDecision({
        taskId,
        decision: decisionForApply,
        optionId: decideReq.option_id,
        decider: "human",
        ...(decideReq.rationale !== undefined ? { rationale: decideReq.rationale } : {}),
        ...(affectedStages !== undefined ? { affectedStages } : {}),
        ...(contractUpdate !== undefined ? { contractUpdate } : {}),
        ...(shouldUnbindCancelled ? { unbindCancelledDependencies: true } : {}),
      });
    } catch (err) {
      if (
        !(err instanceof InvalidStateTransitionError) &&
        !(err instanceof ZodError) &&
        err instanceof Error &&
        /accept_files_hash|does not exist/i.test(err.message)
      ) {
        throw new ServerHttpError(400, { error: "invalid_decision_request", message: err.message });
      }
      throw err;
    }

    pendingDecisions.remove(taskId);

    let nextWaitingDecision: PendingDecision | null = null;
    if (result.state.status === "waiting") {
      nextWaitingDecision = pendingDecisions.ensureUpstreamCancelledDecision(taskId);
    }

    caffeinate.syncRunningCount(countRunningLeafTasks(store));

    if (nextWaitingDecision) {
      sseHub.publish({
        type: "decision.requested",
        taskId,
        priority: store.getTaskIndex(taskId)?.priority ?? result.state.priority,
        question: nextWaitingDecision.question,
      });
    }

    sseHub.publish({
      type: "task.updated",
      taskId,
      patch: {
        status: result.state.status,
        ...(result.state.stage !== null ? { stage: result.state.stage } : {}),
        ...(result.state.round !== null ? { round: result.state.round } : {}),
        contractVersion: result.state.contractVersion,
      },
    });
    registerUpstreamCancelledDownstreams(result.waitingDownstreamTaskIds);

    return c.json({
      ok: true,
      ...result,
    });
  });

  app.post("/api/tasks/:id/restore-backup", (c) => {
    const taskId = requireExistingTask(c.req.param("id"));

    let restoreResult;
    try {
      restoreResult = restoreHostScopedBackup(store, { taskId });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ServerHttpError(404, {
          error: "backup_not_found",
          taskId,
          message: `No host_scoped backup manifest found for task "${taskId}"`,
        });
      }
      if (err instanceof Error && /Cannot restore backup/i.test(err.message)) {
        throw new ServerHttpError(409, {
          error: "invalid_backup_state",
          message: err.message,
        });
      }
      throw err;
    }

    if (restoreResult.ok) {
      return c.json({ ok: true, manifest: restoreResult.manifest }, 200);
    }

    if (restoreResult.reason === "hash_mismatch") {
      const firstConflict = restoreResult.conflicts[0]!;
      const errBody = HashMismatchErrorSchema.parse({
        code: "hash_mismatch",
        path: firstConflict.targetCanonicalPath,
        expectedSha256: firstConflict.expectedPostSha256 ?? "<none>",
        actualSha256: firstConflict.actualSha256 ?? "<missing>",
        diff: firstConflict.diff,
      });
      return c.json(
        {
          ...errBody,
          conflicts: restoreResult.conflicts,
        },
        409,
      );
    }

    return c.json(
      {
        code: "lock_conflict",
        conflicts: restoreResult.conflicts,
        message: "Host path lock conflict prevented backup restore",
      },
      409,
    );
  });

  app.put("/api/settings/:section", async (c) => {
    const section = c.req.param("section");
    if (section !== "roles" && section !== "limits" && section !== "pricing") {
      throw new ServerHttpError(400, {
        error: "invalid_settings_section",
        section,
        message: `Unknown settings section "${section}"; expected one of roles, limits, pricing`,
      });
    }

    const rawBody = await readJsonBodyStrict(c);
    if (section === "roles") {
      const data = RolesConfigSchema.parse(rawBody);
      store.writeConfig("roles", data);
      return c.json({ ok: true, section, data });
    }
    if (section === "limits") {
      const data = LimitsConfigSchema.parse(rawBody);
      store.writeConfig("limits", data);
      return c.json({ ok: true, section, data });
    }
    const data = PricingConfigSchema.parse(rawBody);
    store.writeConfig("pricing", data);
    return c.json({ ok: true, section, data });
  });

  app.get("/api/events", (c) => {
    const headerVal = c.req.header("Last-Event-ID");
    const queryVal = c.req.query("lastEventId");
    const lastEventId =
      headerVal !== undefined && headerVal.trim().length > 0
        ? parseLastEventIdParam(headerVal)
        : parseLastEventIdParam(queryVal);

    const stream = sseHub.createEventStream({
      lastEventId,
      signal: c.req.raw.signal,
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  return app;
}
