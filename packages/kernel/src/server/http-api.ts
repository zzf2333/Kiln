import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { z, ZodError } from "zod";
import {
  AcceptVerificationReportSchema,
  CardContractSchema,
  CardLimitsSchema,
  CommitPrActionRequestSchema,
  DecideRequestSchema,
  DraftCardSchema,
  GateReportSchema,
  GithubPrFeedbackSnapshotSchema,
  HashMismatchErrorSchema,
  ImportGithubIssueRequestSchema,
  InspectSpaceRequestSchema,
  LimitsConfigSchema,
  PairCompleteRequestSchema,
  PrFeedbackReworkRequestSchema,
  PricingConfigSchema,
  PrioritySchema,
  PriorityUpdateRequestSchema,
  ProvidersConfigSchema,
  RemoteConfigSchema,
  RemoteNotificationTestRequestSchema,
  RollbackCheckpointRequestSchema,
  RolesConfigSchema,
  RosterConfigSchema,
  RunEventSchema,
  RunMetaSchema,
  RunSpaceScriptRequestSchema,
  SessionRefSchema,
  SpaceConfigSchema,
  SplitCardPlanItemSchema,
  StageIdSchema,
  SteerTaskRequestSchema,
  SyncPricingRequestSchema,
  TaskCardSchema,
  TaskRetroReportSchema,
  TrackSchema,
  UpdateTaskLimitsRequestSchema,
  UpsertSpaceRequestSchema,
  WorkflowBlueprintSchema,
  WorkspaceModeSchema,
  deriveLegacyRolesConfigFromRoster,
  type DiscoverSpacesResponse,
  type LedgerFile,
  type OpenRunTuiResponse,
  type PendingDecision,
  type PickDirectoryResponse,
  type ProviderRuntimeStatus,
  type ProvidersConfig,
  type PublicPairedDevice,
  type RemoteConfig,
  type RunMeta,
  type SpaceConfig,
  type StageId,
  type SteerNote,
  type SteerTaskRequest,
  type SyncPricingRequest,
  type SyncPricingResponse,
  type TailscaleStatusResponse,
  type TaskRetroReport,
} from "@kiln/protocol";
import {
  ProviderHealthTracker,
  detectProvidersConfigOnHost,
  probeCliBinary,
  type BackendRegistry,
  type TestProviderResult,
} from "../backend/index.js";
import {
  listTaskCheckpoints,
  rollbackGitWorktreeToCheckpoint,
} from "../gate/checkpoints.js";
import {
  HostBackupManifestSchema,
  buildHostStagedDiffs,
  restoreHostScopedBackup,
  type HostBackupManifest,
} from "../gate/index.js";
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
  writeYamlAtomic,
} from "../store/index.js";
import type { CaffeinateController } from "./caffeinate.js";
import {
  MAX_ATTACHMENT_UPLOAD_BODY_BYTES,
  copyDraftAttachmentsToTask,
  deleteDraftAttachment,
  resolveReadableAttachmentFile,
  saveDraftAttachment,
  validateCommitAttachments,
} from "./attachments.js";
import {
  ChatMessageRecordSchema,
  getBuiltinChatCommands,
  KilnChatEngine,
  snapshotBackends,
} from "./chat.js";
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
import type { LiveRateTracker } from "./rate-tracker.js";
import {
  RemoteAuthManager,
  findForbiddenLocalProxyHeader,
  formatClearSessionCookieHeader,
  formatSessionCookieHeader,
  isLocalAllowedOrigin,
  isSecureRequest,
  isStrictLoopbackHost,
  verifyRemoteCsrf,
} from "./remote-auth.js";
import { RemoteNotifier } from "./remote-notify.js";
import {
  inspectTailscaleStatus,
} from "./remote-tailscale.js";
import type { AcceptEnvLiveSnapshot } from "./accept-env.js";
import { detectImageMagic, normalizeDeclaredEvidenceRelPath } from "./accept-evidence.js";
import {
  approveImprovementProposal,
  computeOrchestrationAnalytics,
  dismissImprovementProposal,
  generateAnalyticsProposals,
  listPolicyHistoryWithEvaluation,
  readImprovementProposals,
  rollbackPolicyChange,
} from "./improvements.js";
import { extractDeterministicTaskRetro } from "./retro-engine.js";
import {
  computeGlobalBudgetStatus,
  computeTaskBudgetStatus,
  computeTaskSpentUsd,
} from "./budget.js";
import { realpathCanonical } from "../store/fs-atomic.js";
import {
  buildPrDraft,
  executeCommitPrAction,
  type PrDeliverExecFn,
} from "./pr-deliver.js";
import {
  buildSanitizedPrFeedbackSteerMessage,
  fetchTaskPrFeedback,
  importGithubIssueToDraft,
  parseGithubRepoFromUrl,
} from "./github-bridge.js";
import { computeMergeQueueSnapshot } from "./merge-queue.js";
import { syncModelPricing } from "./pricing-sync.js";
import { KilnScriptRunner } from "./script-runner.js";
import {
  discoverLocalGitRepos,
  inspectGitSpacePath,
  listLocalDirectoryFiles,
  listSpaceFiles,
  pickLocalDirectory,
  revealLocalPath,
  validateCommitContract,
  validateCommitWorkflow,
  validateCommitWorkspace,
} from "./space-inspect.js";
import { commitSplitCards } from "./split-commit.js";
import type { SseHub } from "./sse.js";
import {
  createStaticFilesHandler,
  resolveDefaultPublicDir,
  type EmbeddedStaticAssets,
} from "./static-files.js";
import {
  buildRunOverviewSummary,
  launchNativeAgentTui,
  resolveNativeTuiCommand,
} from "./tui-launcher.js";
import { extractActiveSteerNotes } from "./orchestrator-handoff.js";

export type HttpApiListenerMode = "local" | "remote";

export interface RemoteRuntimeStatus {
  listening: boolean;
  port: number | null;
  baseUrl: string | null;
}

const MUTATING_HTTP_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isLocalOnlyRemoteAdminPath(rawPath: string): boolean {
  const collapsed = rawPath.replace(/\/+/g, "/").replace(/\/+$/, "") || "/";
  const lower = collapsed.toLowerCase();
  return (
    lower === "/api/settings/remote" ||
    lower.startsWith("/api/settings/remote/") ||
    lower === "/api/settings/providers" ||
    lower.startsWith("/api/settings/providers/") ||
    lower === "/api/providers/detect" ||
    /^\/api\/providers\/[^/]+\/test$/.test(lower) ||
    lower === "/api/remote" ||
    lower.startsWith("/api/remote/") ||
    lower === "/api/spaces/pick-directory" ||
    lower === "/api/system/reveal-path" ||
    /^\/api\/tasks\/[^/]+\/runs\/[^/]+\/open-tui$/.test(lower)
  );
}

export interface HttpApiDependencies {
  store: KilnStore;
  stateMachine: TaskStateMachine;
  sseHub: SseHub;
  pendingDecisions: PendingDecisionStore;
  caffeinate: CaffeinateController;
  backendRegistry?: BackendRegistry;
  providerHealth?: ProviderHealthTracker;
  testProvider?: (providerId: string) => Promise<TestProviderResult>;
  detectProviders?: () => Promise<{
    data: ProvidersConfig;
    providers: ProviderRuntimeStatus[];
  }>;
  rateTracker?: LiveRateTracker;
  chatEngine?: KilnChatEngine;
  scriptRunner?: KilnScriptRunner;
  prDeliverExec?: PrDeliverExecFn;
  publicDir?: string | null;
  embeddedPublicAssets?: EmbeddedStaticAssets | null;
  backendQueryTimeoutMs?: number;
  listenerMode?: HttpApiListenerMode;
  remoteAuth?: RemoteAuthManager;
  remoteNotifier?: RemoteNotifier;
  getLocalPort?: () => number;
  getRemoteRuntimeStatus?: () => RemoteRuntimeStatus;
  onRemoteConfigUpdated?: (nextConfig: RemoteConfig) => Promise<void> | void;
  inspectTailscale?: (remotePort: number) => Promise<TailscaleStatusResponse>;
  discoverSpaces?: () => Promise<DiscoverSpacesResponse>;
  pickDirectory?: () => Promise<PickDirectoryResponse>;
  revealPath?: (targetPath: string) => Promise<{ ok: true; path: string }>;
  openRunTui?: (input: { taskId: string; runDir: string }) => Promise<OpenRunTuiResponse>;
  getActiveAcceptEnv?: (taskId: string) => AcceptEnvLiveSnapshot | null;
  triggerTaskRetro?: (taskId: string, useAi: boolean) => Promise<TaskRetroReport>;
  syncPricing?: (input: SyncPricingRequest) => Promise<SyncPricingResponse>;
  extensionsHomeDir?: string;
  onTaskQueued?: (taskId: string) => void;
  onTaskPaused?: (taskId: string) => Promise<void> | void;
  onTaskSteered?: (
    taskId: string,
    input: SteerTaskRequest,
  ) => Promise<{
    steer: SteerNote;
    state: ReturnType<typeof deriveTaskStatus>;
    interrupted: boolean;
  }>;
  onTaskCancelled?: (taskId: string) => Promise<void> | void;
  onBeforeDecisionApply?: (taskId: string) => Promise<void> | void;
  onSettingsUpdated?: (
    section: "roles" | "limits" | "pricing" | "providers" | "roster",
  ) => Promise<void> | void;
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
  open_questions: z.array(z.string().min(1)).optional(),
  workflow: WorkflowBlueprintSchema.optional(),
  contract: CardContractSchema.partial().optional(),
  brief_markdown: z.string().optional(),
  session_ref: SessionRefSchema.nullable().optional(),
  intake_open: z.boolean().optional(),
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
  workflow: WorkflowBlueprintSchema.optional(),
  contract: CardContractSchema.partial().optional(),
  limits: CardLimitsSchema.optional(),
  brief_markdown: z.string().optional(),
});

const OptionalReasonBodySchema = z.object({
  reason: z.string().min(1).optional(),
});

const ResumeTaskBodySchema = z.object({
  stage: StageIdSchema.optional(),
});

const CompleteTaskBodySchema = z.object({
  deliver_ref: z.string().trim().min(1).optional(),
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
  new_max_cost_usd: z.number().finite().positive().optional(),
});

const CommitSplitDraftRequestSchema = z.object({
  cards: z.array(SplitCardPlanItemSchema).min(2).max(12),
});

const AttachmentJsonUploadSchema = z.object({
  filename: z.string().trim().min(1),
  mime_type: z.string().trim().min(1),
  data_base64: z.string().min(1),
});

async function readAttachmentUploadPayload(
  c: Context,
): Promise<{ filename: string; mimeType: string; bytes: Buffer }> {
  const rawLen = c.req.header("content-length");
  if (rawLen && /^\d+$/.test(rawLen.trim())) {
    const contentLen = Number.parseInt(rawLen.trim(), 10);
    if (contentLen > MAX_ATTACHMENT_UPLOAD_BODY_BYTES) {
      throw new ServerHttpError(413, {
        error: "payload_too_large",
        message: `Attachment upload exceeds ${MAX_ATTACHMENT_UPLOAD_BODY_BYTES} bytes`,
      });
    }
  }

  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.raw.formData();
    const fileEntry = form.get("file");
    if (!fileEntry || typeof fileEntry === "string") {
      throw new ServerHttpError(400, {
        error: "invalid_request",
        message: 'Multipart form upload requires a binary "file" field',
      });
    }
    if (fileEntry.size > MAX_ATTACHMENT_UPLOAD_BODY_BYTES) {
      throw new ServerHttpError(413, {
        error: "attachment_too_large",
        message: `Uploaded file exceeds ${MAX_ATTACHMENT_UPLOAD_BODY_BYTES} bytes`,
      });
    }
    const buf = Buffer.from(await fileEntry.arrayBuffer());
    return {
      filename: fileEntry.name || "screenshot.png",
      mimeType: fileEntry.type || "application/octet-stream",
      bytes: buf,
    };
  }

  const rawText = await c.req.text();
  if (Buffer.byteLength(rawText, "utf8") > MAX_ATTACHMENT_UPLOAD_BODY_BYTES) {
    throw new ServerHttpError(413, {
      error: "payload_too_large",
      message: `Attachment upload exceeds ${MAX_ATTACHMENT_UPLOAD_BODY_BYTES} bytes`,
    });
  }
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText) as unknown;
  } catch {
    throw new ServerHttpError(400, {
      error: "invalid_json",
      message: "Request body must be valid JSON",
    });
  }
  const parsed = AttachmentJsonUploadSchema.parse(rawJson);
  const cleanedB64 = parsed.data_base64.replace(/^data:[^;]+;base64,/i, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleanedB64) || cleanedB64.length % 4 !== 0) {
    throw new ServerHttpError(400, {
      error: "invalid_request",
      message: "data_base64 must be valid base64",
    });
  }
  return {
    filename: parsed.filename,
    mimeType: parsed.mime_type,
    bytes: Buffer.from(cleanedB64, "base64"),
  };
}

const ChatMessageBodySchema = z.object({
  message: z.string().trim().min(1),
});

function loadAllLedgers(
  store: KilnStore,
  extraSpaceIds: Iterable<string> = [],
): Record<string, LedgerFile> {
  const spaceIds = new Set<string>(extraSpaceIds);
  if (fs.existsSync(store.paths.ledgerDir)) {
    for (const entry of fs.readdirSync(store.paths.ledgerDir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.endsWith(".yaml")) {
        continue;
      }
      const spaceId = entry.name.slice(0, -".yaml".length);
      spaceIds.add(assertSafeSegment(spaceId, "spaceId"));
    }
  }

  const ledgers: Record<string, LedgerFile> = {};
  for (const spaceId of Array.from(spaceIds).sort()) {
    const file = store.readLedger(spaceId);
    if (file) {
      ledgers[spaceId] = file;
    }
  }
  return ledgers;
}

function readLatestRunMeta(store: KilnStore, taskId: string): RunMeta | null {
  const runsDir = store.paths.runsDir(taskId);
  if (!fs.existsSync(runsDir)) {
    return null;
  }
  const dirNames = fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => assertSafeSegment(e.name, "runDirName"))
    .sort((a, b) => a.localeCompare(b));

  for (let i = dirNames.length - 1; i >= 0; i--) {
    const meta = readYamlOptional(store.paths.runYaml(taskId, dirNames[i]!), RunMetaSchema);
    if (meta) {
      return meta;
    }
  }
  return null;
}

function readHostBackupManifestOptional(
  store: KilnStore,
  taskId: string,
): HostBackupManifest | null {
  const raw = readOptionalText(store.paths.backupManifest(taskId));
  if (raw === null) {
    return null;
  }
  return HostBackupManifestSchema.parse(JSON.parse(raw) as unknown);
}

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

const BUILTIN_LOCAL_SPACE: SpaceConfig = {
  schema_version: 1,
  id: "local",
  name: "本机与临时",
  default_branch: "main",
  copy_untracked: [],
  clone_deps: [],
  freeze_patterns: [],
};

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
  if (!spaces.local) {
    spaces.local = {
      ...BUILTIN_LOCAL_SPACE,
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    };
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
  const {
    store,
    stateMachine,
    sseHub,
    pendingDecisions,
    caffeinate,
    backendRegistry,
    rateTracker,
    chatEngine,
    prDeliverExec,
    backendQueryTimeoutMs,
    getLocalPort,
    getRemoteRuntimeStatus,
    onRemoteConfigUpdated,
    inspectTailscale,
    onTaskQueued,
    onTaskPaused,
    onTaskSteered,
    onTaskCancelled,
    onBeforeDecisionApply,
    onSettingsUpdated,
    getActiveAcceptEnv,
    triggerTaskRetro,
  } = deps;
  const listenerMode: HttpApiListenerMode = deps.listenerMode ?? "local";
  const remoteAuth = deps.remoteAuth ?? new RemoteAuthManager({ store, sseHub });
  const remoteNotifier = deps.remoteNotifier ?? new RemoteNotifier({ store });
  const scriptRunner = deps.scriptRunner ?? new KilnScriptRunner({ store, sseHub });
  const version = deps.version ?? "0.0.4";
  const app = new Hono();
  const authenticatedDevicesByRequest = new WeakMap<Request, PublicPairedDevice>();

  const readDraftChatFallback = (draftId: string) => {
    if (chatEngine) {
      return chatEngine.getDraftChatMessages(draftId);
    }
    const safeDraftId = assertSafeSegment(draftId, "draftId");
    return readNdjsonValidated(
      path.join(store.paths.draftsDir, `${safeDraftId}-chat.ndjson`),
      ChatMessageRecordSchema,
    );
  };

  const readTaskChatFallback = (taskId: string) => {
    if (chatEngine) {
      return chatEngine.getTaskChatMessages(taskId);
    }
    const safeTaskId = assertSafeSegment(taskId, "taskId");
    return readNdjsonValidated(
      path.join(store.paths.taskDir(safeTaskId), "resolver_chat.ndjson"),
      ChatMessageRecordSchema,
    );
  };

  const requireExistingDraft = (rawId: string): { draftId: string; draft: NonNullable<ReturnType<KilnStore["readDraft"]>> } => {
    const draftId = assertSafeSegment(rawId, "draftId");
    const draft = store.readDraft(draftId);
    if (!draft) {
      throw new ServerHttpError(404, {
        error: "draft_not_found",
        draftId,
        message: `Draft "${draftId}" does not exist`,
      });
    }
    return { draftId, draft };
  };

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

  const serializeDraftWithBrief = (
    draft: NonNullable<ReturnType<KilnStore["readDraft"]>>,
  ) => {
    const brief = store.readDraftBrief(draft.id);
    const research = store.readDraftResearch(draft.id);
    return {
      ...draft,
      ...(brief !== null && brief.trim().length > 0 ? { brief_markdown: brief } : {}),
      ...(research !== null && research.trim().length > 0
        ? { research_markdown: research }
        : {}),
    };
  };

  app.onError((err, c) => {
    const mapped = mapDomainError(err);
    return c.json(mapped.payload, mapped.statusCode);
  });

  if (listenerMode === "local") {
    app.use("*", async (c, next) => {
      const matchedProxyHeader = findForbiddenLocalProxyHeader(c.req.raw.headers);
      if (matchedProxyHeader !== null) {
        const remotePort = remoteAuth.getEffectiveRemotePort();
        return c.json(
          {
            error: "remote_port_required",
            header: matchedProxyHeader,
            remotePort,
            message: `Reverse-proxy traffic is blocked on the local Kiln port. Enable remote access and point your tunnel to http://127.0.0.1:${remotePort} instead.`,
          },
          403,
        );
      }

      const hostHeader = c.req.header("host");
      if (hostHeader !== undefined) {
        if (!isStrictLoopbackHost(hostHeader)) {
          return c.json(
            {
              error: "invalid_host",
              host: hostHeader,
              message:
                "Local Kiln listener only accepts loopback Host headers (127.0.0.1, localhost, [::1])",
            },
            403,
          );
        }
      } else {
        let urlHost = "";
        try {
          urlHost = new URL(c.req.url).host;
        } catch {
          urlHost = "";
        }
        if (!isStrictLoopbackHost(urlHost)) {
          return c.json(
            {
              error: "invalid_host",
              host: urlHost,
              message:
                "Local Kiln listener only accepts loopback Host headers (127.0.0.1, localhost, [::1])",
            },
            403,
          );
        }
      }

      const method = c.req.method.toUpperCase();
      if (MUTATING_HTTP_METHODS.has(method)) {
        const originHeader = c.req.header("origin");
        if (originHeader !== undefined && !isLocalAllowedOrigin(originHeader)) {
          return c.json(
            {
              error: "csrf_origin_mismatch",
              origin: originHeader,
              message: "Cross-origin mutating requests to the local Kiln port are forbidden",
            },
            403,
          );
        }
      }

      await next();
    });
  } else {
    app.use("*", async (c, next) => {
      const reqPath = c.req.path;
      const method = c.req.method.toUpperCase();

      if (isLocalOnlyRemoteAdminPath(reqPath)) {
        return c.json(
          {
            error: "local_only_endpoint",
            path: reqPath,
            message:
              "Remote administration endpoints are restricted to the local Kiln port",
          },
          403,
        );
      }

      if (
        (method === "GET" || method === "HEAD") &&
        (reqPath === "/api/health" || reqPath === "/api/auth/status")
      ) {
        await next();
        return;
      }

      if (method === "POST" && reqPath === "/api/auth/pair") {
        // Non-browser callers without Origin are allowed, but an explicit cross-origin
        // browser Origin header must match to prevent cross-site pairing quota exhaustion / Login CSRF.
        if (c.req.header("origin") !== undefined) {
          const csrf = verifyRemoteCsrf(c, store.readConfig("remote"));
          if (!csrf.ok) {
            return c.json({ error: csrf.error, message: csrf.message }, 403);
          }
        }
        await next();
        return;
      }

      if (method === "POST" && reqPath === "/api/auth/logout") {
        const csrf = verifyRemoteCsrf(c, store.readConfig("remote"));
        if (!csrf.ok) {
          return c.json({ error: csrf.error, message: csrf.message }, 403);
        }
        await next();
        return;
      }

      const normalizedPath = reqPath.replace(/\/+/g, "/").toLowerCase();
      if (
        (method === "GET" || method === "HEAD") &&
        normalizedPath !== "/api" &&
        !normalizedPath.startsWith("/api/")
      ) {
        await next();
        return;
      }

      // Unconditional device session cookie verification — ZERO loopback bypass!
      const device = remoteAuth.authenticateCookie(
        c.req.header("cookie"),
        c.req.header("user-agent"),
      );
      if (!device) {
        return c.json(
          {
            error: "unauthorized",
            message:
              "Valid paired device session cookie (kiln_session) is required on the remote port",
          },
          401,
        );
      }
      authenticatedDevicesByRequest.set(c.req.raw, device);

      if (MUTATING_HTTP_METHODS.has(method)) {
        const csrf = verifyRemoteCsrf(c, store.readConfig("remote"));
        if (!csrf.ok) {
          return c.json({ error: csrf.error, message: csrf.message }, 403);
        }
      }

      await next();
    });
  }

  app.get("/api/health", (c) => {
    if (listenerMode === "remote") {
      return c.json({
        ok: true,
        mode: "remote",
      });
    }
    return c.json({
      ok: true,
      pid: process.pid,
      version,
      mode: "local",
    });
  });

  app.get("/api/auth/status", (c) => {
    if (listenerMode === "local") {
      return c.json({
        ok: true,
        mode: "local",
        authenticated: true,
        device: null,
      });
    }
    const device = remoteAuth.authenticateCookie(
      c.req.header("cookie"),
      c.req.header("user-agent"),
    );
    return c.json({
      ok: true,
      mode: "remote",
      authenticated: device !== null,
      device,
    });
  });

  app.post("/api/auth/pair", async (c) => {
    const rawBody = await readJsonBodyStrict(c);
    const body = PairCompleteRequestSchema.parse(rawBody);
    const userAgent = c.req.header("user-agent");
    const result = remoteAuth.completePairing({
      ...(body.token !== undefined ? { token: body.token } : {}),
      ...(body.code !== undefined ? { code: body.code } : {}),
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(userAgent !== undefined ? { userAgent } : {}),
    });
    c.header(
      "Set-Cookie",
      formatSessionCookieHeader(result.sessionToken, {
        secure: isSecureRequest(c),
      }),
    );
    return c.json({
      ok: true,
      device: result.device,
    });
  });

  app.post("/api/auth/logout", (c) => {
    const device = remoteAuth.authenticateCookie(c.req.header("cookie"));
    let revokedDeviceId: string | null = null;
    if (device) {
      remoteAuth.revokeDevice(device.id);
      revokedDeviceId = device.id;
    }
    c.header(
      "Set-Cookie",
      formatClearSessionCookieHeader({ secure: isSecureRequest(c) }),
    );
    return c.json({
      ok: true,
      loggedOut: true,
      revokedDeviceId,
    });
  });

  app.get("/api/settings/remote", (c) => {
    const remote = remoteAuth.readRemoteConfig();
    const runtime = getRemoteRuntimeStatus
      ? getRemoteRuntimeStatus()
      : { listening: false, port: null, baseUrl: null };
    return c.json({
      ok: true,
      remote,
      runtime,
      activeDeviceCount: remoteAuth.activeDeviceCount(),
    });
  });

  app.put("/api/settings/remote", async (c) => {
    const rawBody = await readJsonBodyStrict(c);
    const data = RemoteConfigSchema.parse(rawBody);
    const activeLocalPort = getLocalPort?.();
    if (
      activeLocalPort !== undefined &&
      activeLocalPort > 0 &&
      data.remote_port === activeLocalPort
    ) {
      throw new ServerHttpError(400, {
        error: "remote_port_conflict",
        localPort: activeLocalPort,
        remotePort: data.remote_port,
        message: `remote_port (${data.remote_port}) must differ from local port (${activeLocalPort})`,
      });
    }

    if (onRemoteConfigUpdated) {
      await Promise.resolve(onRemoteConfigUpdated(data));
    } else {
      store.writeConfig("remote", data);
      caffeinate.setRemoteKeepAwakeOnAc(data.enabled && data.keep_awake_on_ac);
    }

    const runtime = getRemoteRuntimeStatus
      ? getRemoteRuntimeStatus()
      : { listening: false, port: null, baseUrl: null };

    return c.json({
      ok: true,
      section: "remote",
      data,
      runtime,
    });
  });

  app.post("/api/remote/pair", (c) => {
    const challenge = remoteAuth.createPairingChallenge();
    return c.json(
      {
        ok: true,
        ...challenge,
      },
      201,
    );
  });

  app.get("/api/remote/devices", (c) => {
    return c.json({
      ok: true,
      devices: remoteAuth.listDevices(),
    });
  });

  app.delete("/api/remote/devices/:id", (c) => {
    const res = remoteAuth.revokeDevice(c.req.param("id"));
    return c.json({
      ok: true,
      revoked: true,
      device: res.device,
      closedStreams: res.closedStreams,
    });
  });

  app.post("/api/remote/devices/revoke-all", (c) => {
    const res = remoteAuth.revokeAllDevices();
    return c.json({
      ok: true,
      revokedCount: res.revokedCount,
      closedStreams: res.closedStreams,
    });
  });

  app.post("/api/remote/notifications/test", async (c) => {
    const rawBody = await readJsonBodyOptional(c);
    const body = RemoteNotificationTestRequestSchema.parse(rawBody);
    const result = await remoteNotifier.sendTestNotification(body);
    if (!result.delivered) {
      return c.json(
        {
          ok: false,
          delivered: false,
          error: "notification_delivery_failed",
          channel: result.channel,
          ...(result.status !== undefined ? { status: result.status } : {}),
          message: result.error ?? "Failed to deliver test notification",
        },
        502,
      );
    }
    return c.json({
      ok: true,
      delivered: true,
      channel: result.channel,
      ...(result.status !== undefined ? { status: result.status } : {}),
    });
  });

  app.get("/api/remote/tailscale", async (c) => {
    const remotePort = remoteAuth.getEffectiveRemotePort();
    const status = inspectTailscale
      ? await inspectTailscale(remotePort)
      : await inspectTailscaleStatus({ remotePort });
    return c.json(status);
  });

  app.get("/api/agents", async (c) => {
    const refreshParam = c.req.query("refresh");
    const refresh = refreshParam === "1" || refreshParam === "true";
    const snap = await snapshotBackends(backendRegistry, {
      timeoutMs: backendQueryTimeoutMs,
      refresh,
    });
    return c.json({
      ok: true,
      agents: snap.agents,
      backends: snap.backends,
    });
  });

  app.get("/api/backends", async (c) => {
    const snap = await snapshotBackends(backendRegistry, {
      timeoutMs: backendQueryTimeoutMs,
    });
    return c.json({
      ok: true,
      backends: snap.backends,
      agents: snap.agents,
    });
  });

  const providerHealth = deps.providerHealth ?? new ProviderHealthTracker();

  const buildSanitizedProviderStatuses = (): ProviderRuntimeStatus[] => {
    const providersCfg = store.readEffectiveProvidersConfig();
    const pricingCfg = store.readConfig("pricing");
    const turns = store.listUsageTurns();
    return providersCfg.providers.map((entry) =>
      providerHealth.buildRuntimeStatus(entry, turns, pricingCfg),
    );
  };

  app.get("/api/providers", (c) => {
    return c.json({
      ok: true,
      providers: buildSanitizedProviderStatuses(),
    });
  });

  app.post("/api/providers/:id/test", async (c) => {
    if (listenerMode !== "local") {
      throw new ServerHttpError(403, {
        error: "local_only_endpoint",
        path: c.req.path,
        message: "Testing providers is restricted to the local Kiln port",
      });
    }
    const providerId = assertSafeSegment(c.req.param("id"), "providerId");
    const providersCfg = store.readEffectiveProvidersConfig();
    const entry = providersCfg.providers.find((p) => p.id === providerId);
    if (!entry) {
      throw new ServerHttpError(404, {
        error: "provider_not_found",
        providerId,
        message: `Provider "${providerId}" does not exist`,
      });
    }

    if (deps.testProvider) {
      const tested = await deps.testProvider(providerId);
      return c.json({
        ok: true,
        ...tested,
      });
    }

    if (!entry.enabled) {
      providerHealth.setAvailability(entry.id, {
        available: false,
        detail: "Provider is disabled",
      });
    } else if (entry.adapter === "paseo") {
      const connected =
        backendRegistry !== undefined &&
        (backendRegistry.has(entry.id) || backendRegistry.has("paseo"));
      providerHealth.setAvailability(entry.id, {
        available: connected,
        ...(connected ? {} : { detail: "Paseo bridge backend not connected" }),
      });
    } else {
      const command = entry.command?.trim() || entry.id;
      const probed = await probeCliBinary(command, {
        env: { ...process.env, ...entry.env },
      });
      providerHealth.setAvailability(entry.id, {
        available: probed.available,
        version: probed.version,
        ...(probed.detail ? { detail: probed.detail } : {}),
      });
    }

    const status = providerHealth.buildRuntimeStatus(
      entry,
      store.listUsageTurns(),
      store.readConfig("pricing"),
    );
    sseHub.publish({
      type: "provider.status",
      providerId: status.provider_id,
      status: status.status,
      ...(status.cooldown_until ? { cooldownUntil: status.cooldown_until } : {}),
      ...(status.detail ? { detail: status.detail } : {}),
      at: new Date().toISOString(),
    });

    return c.json({
      ok: true,
      status,
      modelsCount: 0,
    });
  });

  app.post("/api/providers/detect", async (c) => {
    if (listenerMode !== "local") {
      throw new ServerHttpError(403, {
        error: "local_only_endpoint",
        path: c.req.path,
        message: "Detecting host providers is restricted to the local Kiln port",
      });
    }
    if (deps.detectProviders) {
      const detected = await deps.detectProviders();
      return c.json({
        ok: true,
        ...detected,
      });
    }
    const current = store.readEffectiveProvidersConfig();
    const nextConfig = await detectProvidersConfigOnHost(current, {
      healthTracker: providerHealth,
    });
    store.writeConfig("providers", nextConfig);
    const providers = buildSanitizedProviderStatuses();
    const nowIso = new Date().toISOString();
    for (const st of providers) {
      sseHub.publish({
        type: "provider.status",
        providerId: st.provider_id,
        status: st.status,
        ...(st.cooldown_until ? { cooldownUntil: st.cooldown_until } : {}),
        ...(st.detail ? { detail: st.detail } : {}),
        at: nowIso,
      });
    }
    return c.json({
      ok: true,
      data: nextConfig,
      providers,
    });
  });

  app.get("/api/settings/providers", (c) => {
    if (listenerMode !== "local") {
      throw new ServerHttpError(403, {
        error: "local_only_endpoint",
        path: c.req.path,
        message: "Reading provider command/env settings is restricted to the local Kiln port",
      });
    }
    return c.json({
      ok: true,
      data: store.readEffectiveProvidersConfig(),
    });
  });

  app.get("/api/settings/roster", (c) => {
    return c.json({
      ok: true,
      data: store.readEffectiveRosterConfig(),
    });
  });

  app.get("/api/ledgers", (c) => {
    const extraSpaces = new Set<string>(store.listTasks().map((t) => t.space));
    const ledgers = loadAllLedgers(store, extraSpaces);
    return c.json({
      ok: true,
      ledgers,
    });
  });

  const rethrowImprovementError = (err: unknown): never => {
    if (err instanceof ServerHttpError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|does not exist/i.test(msg)) {
      throw new ServerHttpError(404, { error: "not_found", message: msg });
    }
    if (/already/i.test(msg)) {
      throw new ServerHttpError(409, { error: "conflict", message: msg });
    }
    if (/Rejected\b|forbidden|requires/i.test(msg)) {
      throw new ServerHttpError(400, { error: "invalid_improvement_proposal", message: msg });
    }
    throw err;
  };

  app.post("/api/tasks/:id/retro", async (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const body = z
      .object({ use_ai: z.boolean().optional() })
      .default({})
      .parse(await readJsonBodyOptional(c));
    const useAi = Boolean(body.use_ai);
    const retro = triggerTaskRetro
      ? await triggerTaskRetro(taskId, useAi)
      : extractDeterministicTaskRetro(store, taskId);
    const markdown = readOptionalText(store.paths.retroMd(taskId));
    return c.json({ ok: true, retro, markdown });
  });

  app.get("/api/improvements/summary", (c) => {
    return c.json({
      ok: true,
      proposals: readImprovementProposals(store),
      analytics: computeOrchestrationAnalytics(store),
      policyHistory: listPolicyHistoryWithEvaluation(store),
    });
  });

  app.post("/api/improvements/analyze", (c) => {
    const created = generateAnalyticsProposals(store);
    return c.json({
      ok: true,
      createdCount: created.length,
      proposals: readImprovementProposals(store),
      analytics: computeOrchestrationAnalytics(store),
      policyHistory: listPolicyHistoryWithEvaluation(store),
    });
  });

  app.post("/api/improvements/proposals/:id/approve", async (c) => {
    const proposalId = assertSafeSegment(c.req.param("id"), "proposalId");
    try {
      const result = approveImprovementProposal(store, proposalId);
      if (result.updatedRoster) {
        await Promise.resolve(onSettingsUpdated?.("roster"));
      }
      return c.json({
        ok: true,
        proposal: result.proposal,
        change: result.change,
      });
    } catch (err) {
      return rethrowImprovementError(err);
    }
  });

  app.post("/api/improvements/proposals/:id/dismiss", (c) => {
    const proposalId = assertSafeSegment(c.req.param("id"), "proposalId");
    try {
      const proposal = dismissImprovementProposal(store, proposalId);
      return c.json({ ok: true, proposal });
    } catch (err) {
      return rethrowImprovementError(err);
    }
  });

  app.post("/api/improvements/policy-history/:id/rollback", async (c) => {
    const changeId = assertSafeSegment(c.req.param("id"), "changeId");
    try {
      const result = rollbackPolicyChange(store, changeId);
      if (result.updatedRoster) {
        await Promise.resolve(onSettingsUpdated?.("roster"));
      }
      return c.json({ ok: true, change: result.change });
    } catch (err) {
      return rethrowImprovementError(err);
    }
  });

  app.get("/api/spaces", (c) => {
    const extraSpaces = store.listTasks().map((row) => row.space);
    return c.json({
      ok: true,
      spaces: loadAllSpaces(store, extraSpaces),
    });
  });

  app.get("/api/chat/commands", async (c) => {
    const rawRole = c.req.query("role");
    const role: "intake" | "resolver" = rawRole === "resolver" ? "resolver" : "intake";
    const spaceParam = c.req.query("space")?.trim();
    const draftParam = c.req.query("draftId")?.trim();
    const taskParam = c.req.query("taskId")?.trim();

    const spaceId = spaceParam ? assertSafeSegment(spaceParam, "space") : undefined;
    const draftId = draftParam ? assertSafeSegment(draftParam, "draftId") : undefined;
    const taskId = taskParam ? assertSafeSegment(taskParam, "taskId") : undefined;

    if (!chatEngine) {
      return c.json({
        ok: true,
        role,
        agent: null,
        model: null,
        commands: getBuiltinChatCommands(role),
        mcpServers: [],
      });
    }

    const res = await chatEngine.listChatCommands({
      role,
      ...(spaceId ? { spaceId } : {}),
      ...(draftId ? { draftId } : {}),
      ...(taskId ? { taskId } : {}),
    });
    return c.json(res);
  });

  app.get("/api/spaces/:id/files", async (c) => {
    const spaceId = assertSafeSegment(c.req.param("id"), "spaceId");
    const query = c.req.query("q") ?? "";
    const rawLimit = c.req.query("limit");
    const parsedLimit = rawLimit !== undefined ? Number(rawLimit) : 24;
    const safeLimit = Number.isFinite(parsedLimit) ? parsedLimit : 24;
    const spaceConfig = store.readSpace(spaceId);
    if (spaceId === "local" || !spaceConfig?.repo_path) {
      const localResult = listLocalDirectoryFiles(
        query,
        safeLimit,
        deps.extensionsHomeDir !== undefined
          ? { rootDir: deps.extensionsHomeDir }
          : {},
      );
      return c.json({
        ok: true,
        spaceId,
        query,
        rootLabel: localResult.rootLabel,
        files: localResult.files,
        truncated: localResult.truncated,
      });
    }
    const result = await listSpaceFiles(
      spaceConfig.repo_path,
      query,
      safeLimit,
    );
    return c.json({
      ok: true,
      spaceId,
      query,
      rootLabel: spaceConfig.name || path.basename(spaceConfig.repo_path),
      files: result.files,
      truncated: result.truncated,
    });
  });

  app.get("/api/spaces/discover", async (c) => {
    if (deps.discoverSpaces) {
      return c.json(await deps.discoverSpaces());
    }
    const existingSpaces = loadAllSpaces(store, []);
    const discovered = await discoverLocalGitRepos({
      existingSpaces,
      kilnHome: store.paths.home,
    });
    return c.json(discovered);
  });

  app.post("/api/spaces/pick-directory", async (c) => {
    if (listenerMode !== "local") {
      throw new ServerHttpError(403, {
        error: "local_only_endpoint",
        path: c.req.path,
        message: "Directory picker is restricted to the local Kiln port",
      });
    }
    const result = deps.pickDirectory
      ? await deps.pickDirectory()
      : await pickLocalDirectory();
    return c.json(result);
  });

  app.post("/api/system/reveal-path", async (c) => {
    if (listenerMode !== "local") {
      throw new ServerHttpError(403, {
        error: "local_only_endpoint",
        path: c.req.path,
        message: "Revealing local paths is restricted to the local Kiln port",
      });
    }
    const rawBody = await readJsonBodyStrict(c);
    const body = z.object({ path: z.string().min(1) }).parse(rawBody);
    const result = deps.revealPath
      ? await deps.revealPath(body.path)
      : await revealLocalPath(body.path);
    return c.json(result);
  });

  app.post("/api/spaces/inspect", async (c) => {
    const rawBody = await readJsonBodyStrict(c);
    const body = InspectSpaceRequestSchema.parse(rawBody);
    const inspected = await inspectGitSpacePath(body.path);
    return c.json({
      ok: true,
      ...inspected,
    });
  });

  app.put("/api/spaces/:id", async (c) => {
    const spaceId = assertSafeSegment(c.req.param("id"), "spaceId");
    if (spaceId === "local" || spaceId === "all") {
      throw new ServerHttpError(400, {
        error: "reserved_space_id",
        spaceId,
        message: `Space ID "${spaceId}" is reserved`,
      });
    }

    const rawBody = await readJsonBodyStrict(c);
    const body = UpsertSpaceRequestSchema.parse(rawBody);
    const inspected = await inspectGitSpacePath(body.repo_path);
    const existed = store.readSpace(spaceId) !== null;

    const space = SpaceConfigSchema.parse({
      schema_version: 1,
      id: spaceId,
      name: body.name,
      repo_path: inspected.repo_path,
      default_branch: body.default_branch,
      copy_untracked: body.copy_untracked,
      clone_deps: body.clone_deps,
      ...(body.default_accept_cmd !== undefined
        ? { default_accept_cmd: body.default_accept_cmd }
        : {}),
      ...(body.accept_entry !== undefined
        ? { accept_entry: body.accept_entry }
        : {}),
      ...(body.intake_checklist !== undefined
        ? { intake_checklist: body.intake_checklist }
        : {}),
      ...(body.accept_scenarios !== undefined
        ? { accept_scenarios: body.accept_scenarios }
        : {}),
      ...(body.default_workflow_preset !== undefined
        ? { default_workflow_preset: body.default_workflow_preset }
        : {}),
      freeze_patterns: body.freeze_patterns,
      ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
      ...(body.scripts !== undefined ? { scripts: body.scripts } : {}),
    });

    store.writeSpace(space);
    return c.json({ ok: true, space }, existed ? 200 : 201);
  });

  app.delete("/api/spaces/:id", (c) => {
    const spaceId = assertSafeSegment(c.req.param("id"), "spaceId");
    if (spaceId === "local" || spaceId === "all") {
      throw new ServerHttpError(400, {
        error: "reserved_space_id",
        spaceId,
        message: `Space ID "${spaceId}" is reserved`,
      });
    }
    if (!store.readSpace(spaceId)) {
      throw new ServerHttpError(404, {
        error: "space_not_found",
        spaceId,
        message: `Space "${spaceId}" does not exist`,
      });
    }
    const activeTaskIds = store
      .listTasks({ space: spaceId })
      .filter((t) => t.status !== "done" && t.status !== "cancelled")
      .map((t) => t.id);
    if (activeTaskIds.length > 0) {
      throw new ServerHttpError(409, {
        error: "space_in_use",
        spaceId,
        activeTaskIds,
        message: `空间 "${spaceId}" 仍有 ${activeTaskIds.length} 个未完成任务（${activeTaskIds.join(", ")}），请先完成或取消后再删除`,
      });
    }

    store.deleteSpace(spaceId);
    return c.json({ ok: true, deleted: true, id: spaceId });
  });

  app.get("/api/bootstrap", async (c) => {
    const roles = store.readConfig("roles");
    const limits = store.readConfig("limits");
    const pricing = store.readConfig("pricing");
    const roster = store.readEffectiveRosterConfig();
    const providers = buildSanitizedProviderStatuses();
    const providersConfig =
      listenerMode === "local" ? store.readEffectiveProvidersConfig() : undefined;
    const taskRows = store.listTasks();
    const spaces = loadAllSpaces(
      store,
      taskRows.map((row) => row.space),
    );
    const ledgers = loadAllLedgers(store, [
      ...Object.keys(spaces),
      ...taskRows.map((row) => row.space),
    ]);
    const backendSnap = await snapshotBackends(backendRegistry, {
      timeoutMs: backendQueryTimeoutMs,
    });

    const tasks = taskRows.map((row) => {
      const card = store.readTaskCard(row.id);
      const stateEvents = store.readStateEvents(row.id);
      const derived = deriveTaskStatus(card, stateEvents);
      const taskTurns = store.listUsageTurns({ taskId: row.id });
      const taskUsage = computeUsageSnapshot(taskTurns, pricing);
      const latestRun = readLatestRunMeta(store, row.id);
      const pending = row.status === "waiting" ? pendingDecisions.get(row.id) : null;
      const latestWaiting =
        row.status === "waiting"
          ? [...stateEvents]
              .reverse()
              .find((ev) => ev.type === "waiting")
          : undefined;
      const latestDone =
        row.status === "done"
          ? [...stateEvents]
              .reverse()
              .find((ev) => ev.type === "done")
          : undefined;
      const hasHostBackup =
        card.workspace_mode === "host_scoped" &&
        fs.existsSync(store.paths.backupManifest(row.id));

      return {
        id: row.id,
        space: row.space,
        parent_id: row.parent_id,
        title: row.title,
        priority: row.priority,
        effective_priority: row.effective_priority,
        track: row.track,
        workspace_mode: row.workspace_mode,
        ...(card.workflow !== undefined ? { workflow: card.workflow } : {}),
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
        tokens_by_model: taskUsage.byModel,
        summary: card.contract.goal,
        has_host_backup: hasHostBackup,
        ...(latestRun !== null ? { agent: latestRun.agent, model: latestRun.model } : {}),
        ...(row.status === "waiting"
          ? {
              waiting_reason:
                pending?.question ??
                pending?.reason ??
                (latestWaiting?.type === "waiting" ? latestWaiting.reason : undefined),
              ...(latestWaiting?.type === "waiting"
                ? { waiting_since: latestWaiting.at }
                : {}),
            }
          : {}),
        ...(latestDone?.type === "done" && latestDone.deliver_ref !== undefined
          ? { delivered_ref: latestDone.deliver_ref }
          : {}),
      };
    });

    const allTurns = store.listUsageTurns();
    const usage = computeUsageSnapshot(allTurns, pricing);
    const liveSnap = rateTracker ? rateTracker.snapshot() : { tokPerSec: 0, rates: {} };

    return c.json({
      version,
      tasks,
      pendingDecisions: pendingDecisions.listAll(),
      drafts: store.listDrafts().map(serializeDraftWithBrief),
      spaces,
      ledgers,
      agents: backendSnap.agents,
      backends: backendSnap.backends,
      providers,
      providerUsage: backendSnap.providerUsage,
      liveRates: {
        rates: liveSnap.rates,
        totals: {
          costUsd: usage.costUsd,
          tokPerSec: liveSnap.tokPerSec,
        },
      },
      settings: {
        roles,
        limits,
        pricing,
        roster,
        ...(providersConfig !== undefined ? { providers: providersConfig } : {}),
      },
      roles,
      roster,
      limits,
      pricing,
      usage,
      budget: computeGlobalBudgetStatus(store),
      runningCount: countRunningLeafTasks(store),
      mergeQueue: computeMergeQueueSnapshot(store),
    });
  });

  app.get("/api/tasks/:id", async (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const card = store.readTaskCard(taskId);
    const stateEvents = store.readStateEvents(taskId);
    const derived = deriveTaskStatus(card, stateEvents);
    const taskIndex = store.getTaskIndex(taskId);
    const pricing = store.readConfig("pricing");

    const brief = readOptionalText(store.paths.briefMd(taskId)) ?? "";
    const plan = readOptionalText(store.paths.planMd(taskId)) ?? "";
    const research = readOptionalText(store.paths.researchMd(taskId)) ?? "";
    const decisions = readOptionalText(store.paths.decisionsMd(taskId)) ?? "";
    const pendingDecision = pendingDecisions.get(taskId);
    const ledgerProposals = readLedgerProposals(store, taskId);
    const spaceConfig = store.readSpace(card.space);
    const usageTurns = store.listUsageTurns({ taskId });

    const runs: Array<Record<string, unknown>> = [];
    const runMetas: RunMeta[] = [];
    let latestMeta: RunMeta | null = null;
    const runsDir = store.paths.runsDir(taskId);
    if (fs.existsSync(runsDir)) {
      const dirNames = fs
        .readdirSync(runsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => assertSafeSegment(entry.name, "runDirName"))
        .sort((a, b) => a.localeCompare(b));

      for (const runDirName of dirNames) {
        const meta = readYamlOptional(store.paths.runYaml(taskId, runDirName), RunMetaSchema);
        if (meta) {
          latestMeta = meta;
          runMetas.push(meta);
        }
        const handoff = readOptionalText(store.paths.handoffMd(taskId, runDirName));
        const receipt = readOptionalText(store.paths.receiptMd(taskId, runDirName));
        const gate = readYamlOptional(store.paths.gateYaml(taskId, runDirName), GateReportSchema);
        const acceptReport = readYamlOptional(
          store.paths.runAcceptReportYaml(taskId, runDirName),
          AcceptVerificationReportSchema,
        );
        const events = readNdjsonValidated(
          store.paths.runEventsNdjson(taskId, runDirName),
          RunEventSchema,
        );
        const exitEv = [...events].reverse().find((e) => e.kind === "exit");
        const overview = buildRunOverviewSummary({
          card,
          meta,
          receipt,
          gate,
          events,
          usageTurns,
          pricing,
          dirName: runDirName,
          activeRunId: derived.activeRunId,
          taskStatus: derived.status,
          spaceRepoPath: spaceConfig?.repo_path,
        });

        runs.push({
          dirName: runDirName,
          meta,
          handoff,
          receipt,
          gate,
          ...(acceptReport ? { acceptReport } : {}),
          events,
          eventsCount: events.length,
          ...(meta?.started_at ? { startedAt: meta.started_at } : {}),
          endedAt: exitEv ? exitEv.at : null,
          ...overview,
        });
      }
    }

    let liveViewUrl: string | null = null;
    if (
      latestMeta &&
      backendRegistry &&
      backendRegistry.has(latestMeta.backend_id)
    ) {
      try {
        liveViewUrl = await backendRegistry
          .get(latestMeta.backend_id)
          .liveViewUrl(latestMeta.session_ref);
      } catch {
        liveViewUrl = null;
      }
    }

    const hostBackup = readHostBackupManifestOptional(store, taskId);
    const hostStagedDiffs = buildHostStagedDiffs(store, taskId);
    const chatMessages = readTaskChatFallback(taskId);
    const retroReport = readYamlOptional(store.paths.retroYaml(taskId), TaskRetroReportSchema);
    const retroMd = readOptionalText(store.paths.retroMd(taskId));
    const usage = computeUsageSnapshot(usageTurns, pricing);
    const checkpoints =
      card.workspace_mode === "git_worktree" && spaceConfig?.repo_path
        ? await listTaskCheckpoints({
            repoPath: spaceConfig.repo_path,
            taskId,
            runs: runMetas,
          })
        : [];

    return c.json({
      card,
      state: {
        ...derived,
        effectivePriority: taskIndex?.effective_priority ?? derived.priority,
      },
      brief,
      plan,
      research,
      retro: retroReport ? { report: retroReport, markdown: retroMd } : null,
      attachments: card.attachments ?? [],
      checkpoints,
      decisions,
      pendingDecision,
      ledgerProposals,
      runs,
      usageTurns,
      usage,
      budget: computeTaskBudgetStatus(store, card),
      liveViewUrl,
      activeAcceptEnv: getActiveAcceptEnv ? getActiveAcceptEnv(taskId) : null,
      hostBackup,
      hostStagedDiffs,
      stateEvents,
      steers: extractActiveSteerNotes(stateEvents),
      chatMessages,
      mergeQueueEntry:
        computeMergeQueueSnapshot(store).find((e) => e.task_id === taskId) ?? null,
    });
  });

  app.get("/api/drafts/:id", (c) => {
    const { draftId, draft } = requireExistingDraft(c.req.param("id"));
    const brief = store.readDraftBrief(draftId);
    const research = store.readDraftResearch(draftId);
    return c.json({
      ok: true,
      draft: serializeDraftWithBrief(draft),
      ...(brief !== null && brief.trim().length > 0 ? { brief_markdown: brief } : {}),
      ...(research !== null && research.trim().length > 0
        ? { research_markdown: research }
        : {}),
      messages: readDraftChatFallback(draftId),
    });
  });

  app.delete("/api/drafts/:id", (c) => {
    const { draftId } = requireExistingDraft(c.req.param("id"));
    store.deleteDraft(draftId);
    return c.json({
      ok: true,
      deleted: true,
      id: draftId,
    });
  });

  app.get("/api/drafts/:id/chat", (c) => {
    const { draftId } = requireExistingDraft(c.req.param("id"));
    return c.json({
      ok: true,
      draftId,
      messages: readDraftChatFallback(draftId),
    });
  });

  app.post("/api/drafts/:id/chat", async (c) => {
    const draftId = assertSafeSegment(c.req.param("id"), "draftId");
    const rawBody = await readJsonBodyStrict(c);
    const body = ChatMessageBodySchema.parse(rawBody);
    if (!chatEngine) {
      throw new ServerHttpError(409, {
        error: "chat_engine_unavailable",
        message: "Interactive chat engine is not configured on this server",
      });
    }
    const res = await chatEngine.sendDraftChat(draftId, body.message);
    const brief = store.readDraftBrief(draftId);
    const research = store.readDraftResearch(draftId);
    return c.json({
      ok: true,
      draftId,
      messages: res.messages,
      reply: res.reply,
      draft: serializeDraftWithBrief(res.draft),
      ...(brief !== null && brief.trim().length > 0 ? { brief_markdown: brief } : {}),
      ...(research !== null && research.trim().length > 0
        ? { research_markdown: research }
        : {}),
    });
  });

  app.post("/api/drafts/:id/recon", async (c) => {
    const { draftId } = requireExistingDraft(c.req.param("id"));
    const rawText = await c.req.text();
    let hint = "";
    if (rawText.trim().length > 0) {
      const parsedBody = JSON.parse(rawText) as { hint?: unknown };
      if (typeof parsedBody?.hint === "string") {
        hint = parsedBody.hint;
      }
    }
    if (!chatEngine) {
      throw new ServerHttpError(409, {
        error: "chat_engine_unavailable",
        message: "Interactive chat engine is not configured on this server",
      });
    }
    const res = await chatEngine.runDraftRecon(draftId, hint, { force: true });
    return c.json({
      ok: true,
      draftId,
      ran: res.ran,
      ...(res.researchMarkdown !== null ? { research_markdown: res.researchMarkdown } : {}),
      ...(res.skippedReason !== undefined ? { skipped_reason: res.skippedReason } : {}),
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
      ...((input.open_questions ?? existing?.open_questions) !== undefined
        ? { open_questions: input.open_questions ?? existing?.open_questions }
        : {}),
      ...((input.workflow ?? existing?.workflow) !== undefined
        ? { workflow: input.workflow ?? existing?.workflow }
        : {}),
      ...(existing?.attachments !== undefined ? { attachments: existing.attachments } : {}),
      contract: {
        ...(existing?.contract ?? {}),
        ...(input.contract ?? {}),
      },
      session_ref:
        input.session_ref !== undefined
          ? input.session_ref
          : (existing?.session_ref ?? null),
      ...((input.intake_open ?? existing?.intake_open) !== undefined
        ? { intake_open: input.intake_open ?? existing?.intake_open }
        : {}),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });

    store.writeDraft(draft);
    if (input.brief_markdown !== undefined) {
      store.writeDraftBrief(draftId, input.brief_markdown);
    }
    return c.json({ ok: true, draft: serializeDraftWithBrief(draft) }, existing ? 200 : 201);
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

    const persistedBrief = store.readDraftBrief(draftId);
    const effectiveBrief =
      input.brief_markdown && input.brief_markdown.trim().length > 0
        ? input.brief_markdown
        : persistedBrief && persistedBrief.trim().length > 0
          ? persistedBrief
          : "";
    if (effectiveBrief.trim().length === 0) {
      throw new ServerHttpError(400, {
        error: "invalid_request",
        message: "brief_markdown cannot be empty",
      });
    }

    const taskId = assertSafeSegment(
      input.id ?? `t-${randomUUID().slice(0, 8)}`,
      "taskId",
    );
    if (store.getTaskIndex(taskId) !== null || fs.existsSync(store.paths.cardYaml(taskId))) {
      throw new ServerHttpError(409, {
        error: "task_already_exists",
        taskId,
        message: `Task "${taskId}" already exists`,
      });
    }
    const space = assertSafeSegment(input.space ?? existingDraft.space, "space");
    const workspaceMode = input.workspace_mode ?? existingDraft.workspace_mode;
    validateCommitWorkspace(store, space, workspaceMode);
    const nextWorkflow = input.workflow ?? existingDraft.workflow;
    const roster = store.readEffectiveRosterConfig();
    validateCommitWorkflow(workspaceMode, nextWorkflow, roster);

    const now = new Date().toISOString();

    let created;
    try {
      const copiedAttachments =
        existingDraft.attachments && existingDraft.attachments.length > 0
          ? copyDraftAttachmentsToTask(store, draftId, taskId, existingDraft.attachments)
          : [];
      validateCommitAttachments(copiedAttachments, taskId);
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
        ...(nextWorkflow !== undefined ? { workflow: nextWorkflow } : {}),
        ...(copiedAttachments.length > 0 ? { attachments: copiedAttachments } : {}),
        ...(existingDraft.external_ref !== undefined
          ? { external_ref: existingDraft.external_ref }
          : {}),
        contract_version: 1,
        contract: {
          ...existingDraft.contract,
          ...(input.contract ?? {}),
        },
        limits: resolveCardLimits(store, input.limits),
        created_at: now,
        updated_at: now,
      });
      validateCommitContract(store, card.contract);
      const draftResearch = store.readDraftResearch(draftId);
      created = stateMachine.createTask(card, effectiveBrief);
      if (draftResearch && draftResearch.trim().length > 0) {
        store.writeTaskResearch(created.card.id, draftResearch);
      }
    } catch (err) {
      store.deleteTaskOnRollback(taskId);
      throw err;
    }
    store.deleteDraft(draftId);
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
    if (created.state.status === "queued") {
      onTaskQueued?.(created.card.id);
    }

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

  app.post("/api/drafts/:id/commit-split", async (c) => {
    const { draftId } = requireExistingDraft(c.req.param("id"));
    const rawBody = await readJsonBodyStrict(c);
    const parsed = CommitSplitDraftRequestSchema.parse(rawBody);
    const res = commitSplitCards(
      {
        store,
        stateMachine,
        pendingDecisions,
        sseHub,
        caffeinate,
        ...(onTaskQueued !== undefined ? { onTaskQueued } : {}),
      },
      {
        mode: "commit_split_cards",
        draft_id: draftId,
        cards: parsed.cards,
      },
    );
    return c.json(res, 201);
  });

  app.post("/api/drafts/:id/attachments", async (c) => {
    const { draftId } = requireExistingDraft(c.req.param("id"));
    const upload = await readAttachmentUploadPayload(c);
    const saved = saveDraftAttachment(store, draftId, upload);
    return c.json(
      {
        ok: true,
        attachment: saved.attachment,
        draft: serializeDraftWithBrief(saved.draft),
      },
      201,
    );
  });

  app.delete("/api/drafts/:id/attachments/:attachmentId", (c) => {
    const { draftId } = requireExistingDraft(c.req.param("id"));
    const nextDraft = deleteDraftAttachment(store, draftId, c.req.param("attachmentId"));
    return c.json({
      ok: true,
      deleted: true,
      draft: serializeDraftWithBrief(nextDraft),
    });
  });

  app.get("/api/drafts/:id/attachments/:attachmentId", (c) => {
    const { draftId } = requireExistingDraft(c.req.param("id"));
    const { attachment, absPath } = resolveReadableAttachmentFile(
      store,
      { kind: "draft", draftId },
      c.req.param("attachmentId"),
    );
    const bytes = fs.readFileSync(absPath);
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": attachment.mime_type,
        "Content-Length": String(bytes.length),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
      },
    });
  });

  app.get("/api/tasks/:id/attachments/:attachmentId", (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const { attachment, absPath } = resolveReadableAttachmentFile(
      store,
      { kind: "task", taskId },
      c.req.param("attachmentId"),
    );
    const bytes = fs.readFileSync(absPath);
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": attachment.mime_type,
        "Content-Length": String(bytes.length),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
      },
    });
  });

  app.get("/api/tasks/:id/runs/:runDir/evidence", (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const runDir = assertSafeSegment(c.req.param("runDir"), "runDir");
    const rawRelPath = c.req.query("path") ?? "";
    const normRel = normalizeDeclaredEvidenceRelPath(rawRelPath);
    if (!normRel) {
      throw new ServerHttpError(400, {
        error: "invalid_evidence_path",
        path: rawRelPath,
        message: "Evidence path must be a relative path inside the run evidence directory",
      });
    }
    const evidenceDir = store.paths.runEvidenceDir(taskId, runDir);
    if (!fs.existsSync(evidenceDir)) {
      throw new ServerHttpError(404, {
        error: "evidence_not_found",
        taskId,
        runDir,
        path: normRel,
      });
    }
    const canonicalDir = realpathCanonical(evidenceDir);
    const prefix = canonicalDir.endsWith(path.sep) ? canonicalDir : canonicalDir + path.sep;
    const candidate = path.resolve(canonicalDir, normRel);
    if (!fs.existsSync(candidate)) {
      throw new ServerHttpError(404, {
        error: "evidence_not_found",
        taskId,
        runDir,
        path: normRel,
      });
    }
    const realFile = realpathCanonical(candidate);
    if (!realFile.startsWith(prefix)) {
      throw new ServerHttpError(403, {
        error: "evidence_path_escape",
        path: normRel,
      });
    }
    const bytes = fs.readFileSync(realFile);
    const ext = path.extname(realFile).toLowerCase();
    const detectedImg = detectImageMagic(bytes);
    const contentType =
      detectedImg ??
      (ext === ".txt" || ext === ".log"
        ? "text/plain; charset=utf-8"
        : ext === ".json"
          ? "application/json; charset=utf-8"
          : "application/octet-stream");

    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(bytes.length),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=300",
      },
    });
  });

  app.get("/api/tasks/:id/runs/:runDir/accept-logs/:service", (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const runDir = assertSafeSegment(c.req.param("runDir"), "runDir");
    const service = assertSafeSegment(c.req.param("service"), "service");
    const logPath = path.join(store.paths.runAcceptEnvDir(taskId, runDir), `${service}.log`);
    if (!fs.existsSync(logPath) || !fs.statSync(logPath).isFile()) {
      throw new ServerHttpError(404, {
        error: "accept_log_not_found",
        taskId,
        runDir,
        service,
      });
    }
    const raw = fs.readFileSync(logPath, "utf8");
    const maxBytes = 64 * 1024;
    const content = raw.length > maxBytes ? raw.slice(raw.length - maxBytes) : raw;
    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  app.get("/api/tasks/:id/chat", (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    return c.json({
      ok: true,
      taskId,
      messages: readTaskChatFallback(taskId),
    });
  });

  app.post("/api/tasks/:id/chat", async (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const rawBody = await readJsonBodyStrict(c);
    const body = ChatMessageBodySchema.parse(rawBody);
    if (!chatEngine) {
      throw new ServerHttpError(409, {
        error: "chat_engine_unavailable",
        message: "Interactive chat engine is not configured on this server",
      });
    }
    const res = await chatEngine.sendTaskChat(taskId, body.message);
    return c.json({
      ok: true,
      taskId,
      messages: res.messages,
      reply: res.reply,
      pendingDecision: res.pendingDecision,
      card: res.card,
    });
  });

  app.post("/api/tasks/:id/pause", async (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const body = OptionalReasonBodySchema.parse(await readJsonBodyOptional(c));
    const nextState = stateMachine.pauseTask(taskId, body.reason);
    await Promise.resolve(onTaskPaused?.(taskId));
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

  app.post("/api/tasks/:id/steer", async (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const rawBody = await readJsonBodyStrict(c);
    const body = SteerTaskRequestSchema.parse(rawBody);

    if (onTaskSteered) {
      const res = await onTaskSteered(taskId, body);
      return c.json({
        ok: true,
        taskId,
        interrupted: res.interrupted,
        steer: res.steer,
        state: res.state,
      });
    }

    const card = store.readTaskCard(taskId);
    const derived = deriveTaskStatus(card, store.readStateEvents(taskId));
    if (
      derived.status !== "queued" &&
      derived.status !== "running" &&
      derived.status !== "paused"
    ) {
      throw new ServerHttpError(409, {
        error: "invalid_task_state",
        taskId,
        status: derived.status,
        message: `Cannot steer task "${taskId}" in status "${derived.status}"`,
      });
    }

    const at = new Date().toISOString();
    const steerId = `steer-${randomUUID().slice(0, 8)}`;
    const nextState = store.appendStateEvent(taskId, {
      type: "steered",
      at,
      steer_id: steerId,
      message: body.message,
      interrupt: false,
      contract_version: derived.contractVersion,
      ...(derived.stage !== null ? { stage: derived.stage } : {}),
    });
    sseHub.publish({
      type: "task.updated",
      taskId,
      patch: {
        status: nextState.status,
        ...(nextState.stage !== null ? { stage: nextState.stage } : {}),
        contractVersion: nextState.contractVersion,
      },
    });
    return c.json({
      ok: true,
      taskId,
      interrupted: false,
      steer: {
        id: steerId,
        at,
        message: body.message,
        interrupt: false,
        contract_version: derived.contractVersion,
        ...(derived.stage !== null ? { stage: derived.stage } : {}),
      },
      state: nextState,
    });
  });

  app.post("/api/tasks/:id/resume", async (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const body = ResumeTaskBodySchema.parse(await readJsonBodyOptional(c));
    const nextState = stateMachine.resumeTask(taskId, undefined, body.stage);
    let waitingDecision: PendingDecision | null = null;
    if (nextState.status === "waiting") {
      waitingDecision = pendingDecisions.ensureUpstreamCancelledDecision(taskId);
    } else {
      pendingDecisions.remove(taskId);
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
    if (nextState.status === "queued") {
      onTaskQueued?.(taskId);
    }
    return c.json({ ok: true, taskId, state: nextState });
  });

  app.post("/api/tasks/:id/complete", async (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const body = CompleteTaskBodySchema.parse(await readJsonBodyOptional(c));
    const nextState = stateMachine.completeExternalTask(taskId, body.deliver_ref);
    pendingDecisions.remove(taskId);
    try {
      extractDeterministicTaskRetro(store, taskId);
    } catch {
      // ignore non-critical retro errors during completion
    }
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
    onTaskQueued?.(taskId);
    return c.json({ ok: true, taskId, state: nextState });
  });

  app.post("/api/tasks/:id/runs/:runDir/open-tui", async (c) => {
    if (listenerMode !== "local") {
      throw new ServerHttpError(403, {
        error: "local_only_endpoint",
        path: c.req.path,
        message: "Opening native agent TUI is restricted to the local Kiln port",
      });
    }
    const taskId = requireExistingTask(c.req.param("id"));
    const runDir = assertSafeSegment(c.req.param("runDir"), "runDir");
    const runDirPath = path.join(store.paths.runsDir(taskId), runDir);
    const meta = readYamlOptional(store.paths.runYaml(taskId, runDir), RunMetaSchema);
    if (!fs.existsSync(runDirPath) || !fs.statSync(runDirPath).isDirectory() || !meta) {
      throw new ServerHttpError(404, {
        error: "run_not_found",
        taskId,
        runDir,
        message: `Run "${runDir}" not found for task "${taskId}"`,
      });
    }

    let providerSessionId = meta.session_ref.meta?.providerSessionId?.trim() || null;
    let providerSessionPath = meta.session_ref.meta?.providerSessionPath?.trim() || null;
    if (!providerSessionId || !providerSessionPath) {
      const events = readNdjsonValidated(
        store.paths.runEventsNdjson(taskId, runDir),
        RunEventSchema,
      );
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]!;
        if (ev.kind === "session_bound") {
          if (!providerSessionId) {
            providerSessionId = ev.providerSessionId;
          }
          if (!providerSessionPath && ev.providerSessionPath) {
            providerSessionPath = ev.providerSessionPath;
          }
          break;
        }
      }
    }

    const resolvedCmd = resolveNativeTuiCommand({
      agent: meta.agent,
      providerSessionId,
      providerSessionPath,
    });
    if (!resolvedCmd.ok) {
      throw new ServerHttpError(resolvedCmd.status, {
        error: resolvedCmd.code,
        message: resolvedCmd.message,
      });
    }

    if (deps.openRunTui) {
      return c.json(await deps.openRunTui({ taskId, runDir }));
    }

    const card = store.readTaskCard(taskId);
    const spaceConfig = store.readSpace(card.space);
    const launched = await launchNativeAgentTui({
      kilnHome: store.paths.home,
      taskId,
      runDir,
      agent: meta.agent,
      providerSessionId,
      providerSessionPath,
      cwd: meta.cwd ?? null,
      fallbackCwd: spaceConfig?.repo_path ?? null,
    });
    return c.json(launched);
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
    await Promise.resolve(onTaskCancelled?.(taskId));
    if (!onTaskCancelled) {
      try {
        extractDeterministicTaskRetro(store, taskId);
      } catch {
        // ignore non-critical retro errors during cancel
      }
    }
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

    onTaskQueued?.(taskId);

    return c.json({
      ok: true,
      taskId,
      state: result.state,
      effectivePriority: targetEffective,
    });
  });

  app.patch("/api/tasks/:id/limits", async (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const body = UpdateTaskLimitsRequestSchema.parse(await readJsonBodyStrict(c));
    const card = store.readTaskCard(taskId);
    const nextLimits = { ...card.limits };
    if (body.max_cost_usd === null) {
      delete nextLimits.max_cost_usd;
    } else if (body.max_cost_usd !== undefined) {
      nextLimits.max_cost_usd = body.max_cost_usd;
    }
    const updatedCard = TaskCardSchema.parse({
      ...card,
      limits: nextLimits,
      updated_at: new Date().toISOString(),
    });
    writeYamlAtomic(store.paths.cardYaml(taskId), updatedCard, TaskCardSchema);
    return c.json({
      ok: true,
      card: updatedCard,
      budget: computeTaskBudgetStatus(store, updatedCard),
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

    await Promise.resolve(onBeforeDecisionApply?.(taskId));

    if (pending.reason === "budget_exceeded" && selectedOption.action === "resume") {
      const card = store.readTaskCard(taskId);
      const spent = computeTaskSpentUsd(store, taskId);
      if (selectedOption.id === "opt-raise-card-budget") {
        const curLimit = card.limits.max_cost_usd ?? 0;
        const nextMax =
          ext.new_max_cost_usd ??
          Math.max(Number((spent * 1.5).toFixed(2)), Number((curLimit * 1.5).toFixed(2)), 0.5);
        const updatedCard = TaskCardSchema.parse({
          ...card,
          limits: {
            ...card.limits,
            max_cost_usd: nextMax,
          },
          updated_at: new Date().toISOString(),
        });
        writeYamlAtomic(store.paths.cardYaml(taskId), updatedCard, TaskCardSchema);
      } else if (selectedOption.id === "opt-unlimited-card-budget") {
        const nextLimits = { ...card.limits };
        delete nextLimits.max_cost_usd;
        const updatedCard = TaskCardSchema.parse({
          ...card,
          limits: nextLimits,
          updated_at: new Date().toISOString(),
        });
        writeYamlAtomic(store.paths.cardYaml(taskId), updatedCard, TaskCardSchema);
      } else if (selectedOption.id === "opt-raise-global-budget") {
        const curLimits = store.readConfig("limits") ?? LimitsConfigSchema.parse({ schema_version: 1 });
        const globalBudget = computeGlobalBudgetStatus(store);
        const nextLimitsPayload: Record<string, unknown> = { ...curLimits };
        if (globalBudget.daily.level === "exceeded" && globalBudget.daily.limit_usd !== null) {
          nextLimitsPayload.daily_budget_usd = Math.max(
            Number((globalBudget.daily.spent_usd * 1.5).toFixed(2)),
            Number((globalBudget.daily.limit_usd * 1.5).toFixed(2)),
            1,
          );
        }
        if (globalBudget.monthly.level === "exceeded" && globalBudget.monthly.limit_usd !== null) {
          nextLimitsPayload.monthly_budget_usd = Math.max(
            Number((globalBudget.monthly.spent_usd * 1.5).toFixed(2)),
            Number((globalBudget.monthly.limit_usd * 1.5).toFixed(2)),
            1,
          );
        }
        store.writeConfig("limits", LimitsConfigSchema.parse(nextLimitsPayload));
      }
    }

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
    if (
      result.state.status === "queued" ||
      result.state.status === "done" ||
      result.state.status === "cancelled" ||
      result.state.status === "external"
    ) {
      onTaskQueued?.(taskId);
    }

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

  app.post("/api/settings/pricing/sync", async (c) => {
    const rawBody = await readJsonBodyOptional(c);
    const body = SyncPricingRequestSchema.parse(rawBody);
    const result = deps.syncPricing
      ? await deps.syncPricing(body)
      : await syncModelPricing({
          store,
          backendRegistry,
          request: body,
        });
    onSettingsUpdated?.("pricing");
    return c.json(result);
  });

  app.put("/api/settings/:section", async (c) => {
    const section = c.req.param("section");
    if (
      section !== "roles" &&
      section !== "limits" &&
      section !== "pricing" &&
      section !== "providers" &&
      section !== "roster"
    ) {
      throw new ServerHttpError(400, {
        error: "invalid_settings_section",
        section,
        message: `Unknown settings section "${section}"; expected one of roles, limits, pricing, providers, roster`,
      });
    }

    if (section === "providers" && listenerMode !== "local") {
      throw new ServerHttpError(403, {
        error: "local_only_endpoint",
        path: c.req.path,
        message: "Updating provider command/env settings is restricted to the local Kiln port",
      });
    }

    const rawBody = await readJsonBodyStrict(c);
    if (section === "roles") {
      const data = RolesConfigSchema.parse(rawBody);
      store.writeConfig("roles", data);
      await Promise.resolve(onSettingsUpdated?.("roles"));
      return c.json({ ok: true, section, data });
    }
    if (section === "roster") {
      const data = RosterConfigSchema.parse(rawBody);
      store.writeConfig("roster", data);
      store.writeConfig("roles", deriveLegacyRolesConfigFromRoster(data));
      await Promise.resolve(onSettingsUpdated?.("roster"));
      return c.json({ ok: true, section, data });
    }
    if (section === "providers") {
      const data = ProvidersConfigSchema.parse(rawBody);
      store.writeConfig("providers", data);
      await Promise.resolve(onSettingsUpdated?.("providers"));
      return c.json({ ok: true, section, data });
    }
    if (section === "limits") {
      const data = LimitsConfigSchema.parse(rawBody);
      store.writeConfig("limits", data);
      await Promise.resolve(onSettingsUpdated?.("limits"));
      return c.json({ ok: true, section, data });
    }
    const data = PricingConfigSchema.parse(rawBody);
    store.writeConfig("pricing", data);
    await Promise.resolve(onSettingsUpdated?.("pricing"));
    return c.json({ ok: true, section, data });
  });

  app.get("/api/tasks/:id/checkpoints", async (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const card = store.readTaskCard(taskId);
    if (card.workspace_mode !== "git_worktree") {
      return c.json({ ok: true, taskId, checkpoints: [] });
    }
    const spaceConfig = store.readSpace(card.space);
    if (!spaceConfig?.repo_path) {
      return c.json({ ok: true, taskId, checkpoints: [] });
    }
    const runMetas: RunMeta[] = [];
    const runsDir = store.paths.runsDir(taskId);
    if (fs.existsSync(runsDir)) {
      const dirNames = fs
        .readdirSync(runsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => assertSafeSegment(e.name, "runDirName"))
        .sort((a, b) => a.localeCompare(b));
      for (const dirName of dirNames) {
        const meta = readYamlOptional(store.paths.runYaml(taskId, dirName), RunMetaSchema);
        if (meta) {
          runMetas.push(meta);
        }
      }
    }
    const checkpoints = await listTaskCheckpoints({
      repoPath: spaceConfig.repo_path,
      taskId,
      runs: runMetas,
    });
    return c.json({ ok: true, taskId, checkpoints });
  });

  app.post("/api/tasks/:id/checkpoints/rollback", async (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const rawBody = await readJsonBodyStrict(c);
    const body = RollbackCheckpointRequestSchema.parse(rawBody);
    const card = store.readTaskCard(taskId);
    if (card.workspace_mode !== "git_worktree") {
      throw new ServerHttpError(400, {
        error: "unsupported_workspace_mode",
        workspaceMode: card.workspace_mode,
        message: `Checkpoint rollback is only supported for git_worktree tasks`,
      });
    }
    const derived = deriveTaskStatus(card, store.readStateEvents(taskId));
    if (derived.status === "running") {
      throw new ServerHttpError(409, {
        error: "task_running",
        taskId,
        message: `Task "${taskId}" is currently running; pause or wait before rolling back checkpoint`,
      });
    }

    const worktreePath = path.join(store.paths.workspaceDir(taskId), "worktree");
    if (!fs.existsSync(worktreePath) || !fs.statSync(worktreePath).isDirectory()) {
      throw new ServerHttpError(400, {
        error: "worktree_not_found",
        taskId,
        worktreePath,
        message: `Task "${taskId}" worktree directory does not exist: ${worktreePath}`,
      });
    }
    const rolled = await rollbackGitWorktreeToCheckpoint({
      worktreePath,
      taskId,
      checkpointRef: body.checkpoint_ref,
    });

    const nextState = store.appendStateEvent(taskId, {
      type: "checkpoint_rolled_back",
      at: new Date().toISOString(),
      checkpoint_ref: rolled.checkpointRef,
      commit_sha: rolled.commitSha,
    });
    sseHub.publish({
      type: "task.updated",
      taskId,
      patch: {
        status: nextState.status,
        ...(nextState.stage !== null ? { stage: nextState.stage } : {}),
        contractVersion: nextState.contractVersion,
      },
    });

    return c.json({
      ok: true,
      taskId,
      checkpoint_ref: rolled.checkpointRef,
      commit_sha: rolled.commitSha,
    });
  });

  app.post("/api/spaces/:id/scripts/run", async (c) => {
    const spaceId = assertSafeSegment(c.req.param("id"), "spaceId");
    const rawBody = await readJsonBodyStrict(c);
    const body = RunSpaceScriptRequestSchema.parse(rawBody);
    const { response } = scriptRunner.startScript({
      spaceId,
      scriptKey: body.script,
      ...(body.taskId !== undefined ? { taskId: body.taskId } : {}),
    });
    return c.json(response, 202);
  });

  app.get("/api/scripts", (c) => {
    const rawSpaceId = c.req.query("spaceId");
    const rawTaskId = c.req.query("taskId");
    const spaceId =
      rawSpaceId !== undefined && rawSpaceId.trim().length > 0
        ? assertSafeSegment(rawSpaceId.trim(), "spaceId")
        : undefined;
    const taskId =
      rawTaskId !== undefined && rawTaskId.trim().length > 0
        ? assertSafeSegment(rawTaskId.trim(), "taskId")
        : undefined;
    const runs = scriptRunner.listRuns({
      ...(spaceId !== undefined ? { spaceId } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
    });
    return c.json({ ok: true, runs });
  });

  app.post("/api/scripts/:scriptRunId/stop", async (c) => {
    const scriptRunId = assertSafeSegment(c.req.param("scriptRunId"), "scriptRunId");
    const stopped = await scriptRunner.stop(scriptRunId);
    if (!stopped) {
      throw new ServerHttpError(404, {
        error: "script_run_not_found",
        scriptRunId,
        message: `Running script "${scriptRunId}" was not found`,
      });
    }
    return c.json({ ok: true, scriptRunId, stopped: true });
  });

  app.post("/api/github/import-issue", async (c) => {
    const rawBody = await readJsonBodyStrict(c);
    const body = ImportGithubIssueRequestSchema.parse(rawBody);
    const result = await importGithubIssueToDraft({
      store,
      spaceId: body.space,
      issueInput: body.issue,
      ...(prDeliverExec !== undefined ? { execCommand: prDeliverExec } : {}),
    });
    return c.json(
      {
        ok: true,
        draft: serializeDraftWithBrief(result.draft),
        issue: result.issue,
        brief_markdown: result.brief_markdown,
      },
      201,
    );
  });

  app.get("/api/tasks/:id/pr-feedback", async (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const prRef = c.req.query("pr")?.trim();
    const feedback = GithubPrFeedbackSnapshotSchema.parse(
      await fetchTaskPrFeedback({
        store,
        taskId,
        ...(prRef ? { prRef } : {}),
        ...(prDeliverExec !== undefined ? { execCommand: prDeliverExec } : {}),
      }),
    );
    return c.json({ ok: true, feedback });
  });

  app.post("/api/tasks/:id/pr-feedback/rework", async (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const body = PrFeedbackReworkRequestSchema.parse(await readJsonBodyStrict(c));
    const feedback = await fetchTaskPrFeedback({
      store,
      taskId,
      ...(body.pr_ref ? { prRef: body.pr_ref } : {}),
      ...(prDeliverExec !== undefined ? { execCommand: prDeliverExec } : {}),
    });
    const message = buildSanitizedPrFeedbackSteerMessage({
      snapshot: feedback,
      failedCheckNames: body.failed_check_names,
      commentIds: body.comment_ids,
      ...(body.extra_note !== undefined ? { extraNote: body.extra_note } : {}),
    });

    const card = store.readTaskCard(taskId);
    const derived = deriveTaskStatus(card, store.readStateEvents(taskId));

    if (derived.status === "done") {
      const now = new Date().toISOString();
      const draftId = `dr-${randomUUID().slice(0, 8)}`;
      const followupDraft = DraftCardSchema.parse({
        schema_version: 1,
        id: draftId,
        title: `PR #${feedback.number} 返工：${card.title}`,
        space: card.space,
        priority: card.priority,
        track: card.track,
        workspace_mode: card.workspace_mode,
        depends_on: [],
        external_ref: card.external_ref ?? {
          provider: "github",
          repo: feedback.repo,
          pr_number: feedback.number,
          pr_url: feedback.url,
          pr_branch: feedback.head_branch,
        },
        contract: {
          goal: `响应 PR #${feedback.number} 的 CI/Review 反馈并修复`,
          end: card.contract.end,
          accept_cmd: card.contract.accept_cmd,
          scope: card.contract.scope,
          ...(card.contract.non_goals ? { non_goals: card.contract.non_goals } : {}),
          deliver: card.contract.deliver,
        },
        created_at: now,
        updated_at: now,
      });
      store.writeDraft(followupDraft);
      store.writeDraftBrief(
        draftId,
        `# 基于 ${card.id} 的 PR #${feedback.number} 返工立项\n\n${message}\n`,
      );
      return c.json(
        {
          ok: true,
          mode: "followup_draft",
          draft: serializeDraftWithBrief(followupDraft),
          message,
        },
        201,
      );
    }

    if (derived.status === "waiting" || derived.status === "cancelled") {
      throw new ServerHttpError(409, {
        error: "invalid_task_state",
        taskId,
        status: derived.status,
        message: `Task "${taskId}" cannot enter PR rework directly from status "${derived.status}"`,
      });
    }

    if (derived.status === "running" || derived.status === "queued") {
      if (onTaskSteered) {
        await onTaskSteered(taskId, { message, interrupt: body.interrupt });
      } else {
        store.appendStateEvent(taskId, {
          type: "steered",
          at: new Date().toISOString(),
          steer_id: `steer-${randomUUID().slice(0, 8)}`,
          message,
          interrupt: Boolean(body.interrupt && derived.status === "running"),
          contract_version: derived.contractVersion,
          ...(derived.stage !== null ? { stage: derived.stage } : {}),
        });
      }
      const next = deriveTaskStatus(store.readTaskCard(taskId), store.readStateEvents(taskId));
      return c.json({
        ok: true,
        mode: "steered",
        taskId,
        status: next.status,
        message,
      });
    }

    // paused or external -> append steered context and resume directly into implement stage
    store.appendStateEvent(taskId, {
      type: "steered",
      at: new Date().toISOString(),
      steer_id: `steer-${randomUUID().slice(0, 8)}`,
      message,
      interrupt: false,
      contract_version: derived.contractVersion,
      stage: "implement",
    });
    const nextState = stateMachine.resumeTask(taskId, undefined, "implement");
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
    onTaskQueued?.(taskId);
    return c.json({
      ok: true,
      mode: "resumed",
      taskId,
      status: nextState.status,
      message,
    });
  });

  app.get("/api/tasks/:id/deliver/pr-draft", (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const draft = buildPrDraft(store, taskId);
    return c.json({ ok: true, draft });
  });

  app.post("/api/tasks/:id/deliver/git", async (c) => {
    const taskId = requireExistingTask(c.req.param("id"));
    const rawBody = await readJsonBodyStrict(c);
    const body = CommitPrActionRequestSchema.parse(rawBody);
    const result = await executeCommitPrAction({
      store,
      taskId,
      request: body,
      ...(prDeliverExec !== undefined ? { execCommand: prDeliverExec } : {}),
    });
    if (result.action === "open_pr") {
      const card = store.readTaskCard(taskId);
      const parsedRepo =
        parseGithubRepoFromUrl(result.prUrl) ?? card.external_ref?.repo;
      if (parsedRepo) {
        const updated = TaskCardSchema.parse({
          ...card,
          external_ref: {
            ...(card.external_ref ?? {}),
            provider: "github",
            repo: parsedRepo,
            ...(result.prNumber !== null ? { pr_number: result.prNumber } : {}),
            pr_url: result.prUrl,
            pr_branch: result.branch,
          },
          updated_at: new Date().toISOString(),
        });
        writeYamlAtomic(store.paths.cardYaml(taskId), updated, TaskCardSchema);
      }
    }
    return c.json(result);
  });

  app.get("/api/events", (c) => {
    const headerVal = c.req.header("Last-Event-ID");
    const queryVal = c.req.query("lastEventId");
    const lastEventId =
      headerVal !== undefined && headerVal.trim().length > 0
        ? parseLastEventIdParam(headerVal)
        : parseLastEventIdParam(queryVal);

    const authenticatedDevice =
      listenerMode === "remote"
        ? authenticatedDevicesByRequest.get(c.req.raw)
        : undefined;

    const stream = sseHub.createEventStream({
      lastEventId,
      signal: c.req.raw.signal,
      ...(authenticatedDevice !== undefined
        ? { deviceId: authenticatedDevice.id }
        : {}),
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

  app.all("/api", (c) => {
    return c.json({ error: "not_found", message: "API endpoint not found" }, 404);
  });

  app.all("/api/*", (c) => {
    return c.json(
      { error: "not_found", message: `API endpoint "${c.req.path}" not found` },
      404,
    );
  });

  if (deps.publicDir !== null) {
    const hasEmbeddedAssets =
      deps.embeddedPublicAssets !== undefined &&
      deps.embeddedPublicAssets !== null &&
      deps.embeddedPublicAssets.size > 0;
    const staticHandler = createStaticFilesHandler({
      publicDir:
        deps.publicDir !== undefined
          ? deps.publicDir
          : hasEmbeddedAssets
            ? null
            : resolveDefaultPublicDir(),
      ...(deps.embeddedPublicAssets !== undefined
        ? { embeddedAssets: deps.embeddedPublicAssets }
        : {}),
    });
    app.all("*", staticHandler);
  }

  return app;
}
