import type {
  DraftCard,
  HashMismatchError,
  LedgerEntry,
  LedgerFile,
  Priority,
  SpaceConfig,
  SseEvent,
  StageId,
  TaskCard,
} from "@kiln/protocol/web";
import type {
  AgentDescriptorInfo,
  BackendConnectionInfo,
  BootstrapResponse,
  ChatCommandsResponse,
  ChatMessage,
  ChatResponsePayload,
  CommitDraftPayload,
  CommitPrActionRequest,
  CommitSplitCardsResponse,
  DeliverGitResponse,
  DiscoverSpacesResponse,
  DraftAttachmentUploadPayload,
  DraftAttachmentUploadResponse,
  HostBackupManifestInfo,
  HostRestoreConflictDetail,
  InspectSpaceResult,
  ListScriptsResponse,
  LogoutResponse,
  OpenRunTuiResponse,
  PairAuthResponse,
  PairCompleteRequest,
  PickDirectoryResponse,
  PrDraftResponse,
  ProviderSettingsResponse,
  ProvidersStatusResponse,
  RemoteAuthStatusResponse,
  RemoteConfig,
  RemoteDevicesResponse,
  RemoteNotificationTestRequest,
  RemoteNotificationTestResponse,
  RemotePairChallengeResponse,
  RemoteSettingsResponse,
  RestoreHostBackupResult,
  RevokeAllDevicesResponse,
  RevokeDeviceResponse,
  RollbackCheckpointRequest,
  RollbackCheckpointResponse,
  RosterSettingsResponse,
  RunSpaceScriptRequest,
  RunSpaceScriptResponse,
  SettingsSectionMap,
  SpaceFilesResponse,
  SplitCardPlanItem,
  SubmitDecisionPayload,
  SyncPricingRequest,
  SyncPricingResponse,
  TailscaleStatusResponse,
  TaskCheckpointsResponse,
  TaskDetailResponse,
  TestProviderResponse,
  UpdateRemoteSettingsResponse,
  UpsertDraftPayload,
  UpsertSpacePayload,
} from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly payload?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type UnauthorizedHandler = (url: string, error: ApiError) => void;

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

function buildFetchInit(init?: RequestInit): RequestInit {
  const method = (init?.method ?? "GET").toUpperCase();
  const extraHeaders = init?.headers;
  const normalizedExtra: Record<string, string> = {};
  if (extraHeaders instanceof Headers) {
    extraHeaders.forEach((value, key) => {
      normalizedExtra[key] = value;
    });
  } else if (Array.isArray(extraHeaders)) {
    for (const [key, value] of extraHeaders) {
      normalizedExtra[key] = value;
    }
  } else if (extraHeaders) {
    Object.assign(normalizedExtra, extraHeaders);
  }

  return {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(MUTATING_METHODS.has(method) ? { "X-Kiln-Client": "web" } : {}),
      ...normalizedExtra,
    },
  };
}

async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  return await fetch(url, buildFetchInit(init));
}

function shouldNotifyUnauthorized(url: string): boolean {
  return url !== "/api/auth/pair" && url !== "/api/auth/status";
}

function notifyIfUnauthorized(url: string, error: ApiError): void {
  if (error.status === 401 && shouldNotifyUnauthorized(url)) {
    unauthorizedHandler?.(url, error);
  }
}

async function parseJsonSafe(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return { message: text };
  }
}

function makeApiError(
  res: Response,
  data: Record<string, unknown>,
  fallbackMessage?: string,
): ApiError {
  const code =
    typeof data.code === "string"
      ? data.code
      : typeof data.error === "string"
        ? data.error
        : `http_${res.status}`;
  const message =
    typeof data.message === "string"
      ? data.message
      : fallbackMessage ?? `请求失败 (${res.status})`;
  return new ApiError(res.status, code, message, data);
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(url, init);
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    const err = makeApiError(res, data);
    notifyIfUnauthorized(url, err);
    throw err;
  }
  return data as unknown as T;
}

export async function fetchAuthStatus(): Promise<RemoteAuthStatusResponse> {
  const res = await apiFetch("/api/auth/status");
  if (res.status === 404) {
    return { ok: true, mode: "local", authenticated: true, device: null };
  }
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    throw makeApiError(res, data, "检查连接状态失败");
  }
  if (
    (data.mode === "local" || data.mode === "remote") &&
    typeof data.authenticated === "boolean"
  ) {
    return {
      ok: true,
      mode: data.mode,
      authenticated: data.authenticated,
      device:
        data.device && typeof data.device === "object"
          ? (data.device as RemoteAuthStatusResponse["device"])
          : null,
    };
  }
  // Graceful fallback when test harnesses or legacy servers only mock /api/bootstrap.
  return { ok: true, mode: "local", authenticated: true, device: null };
}

export async function pairRemoteDevice(
  payload: PairCompleteRequest,
): Promise<PairAuthResponse> {
  return await requestJson<PairAuthResponse>("/api/auth/pair", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function logoutRemoteDevice(): Promise<LogoutResponse> {
  return await requestJson<LogoutResponse>("/api/auth/logout", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchRemoteSettings(): Promise<RemoteSettingsResponse> {
  return await requestJson<RemoteSettingsResponse>("/api/settings/remote");
}

export async function updateRemoteSettings(
  config: RemoteConfig,
): Promise<UpdateRemoteSettingsResponse> {
  return await requestJson<UpdateRemoteSettingsResponse>("/api/settings/remote", {
    method: "PUT",
    body: JSON.stringify(config),
  });
}

export async function createRemotePairingChallenge(): Promise<RemotePairChallengeResponse> {
  return await requestJson<RemotePairChallengeResponse>("/api/remote/pair", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchRemoteDevices(): Promise<RemoteDevicesResponse> {
  return await requestJson<RemoteDevicesResponse>("/api/remote/devices");
}

export async function revokeRemoteDevice(
  deviceId: string,
): Promise<RevokeDeviceResponse> {
  return await requestJson<RevokeDeviceResponse>(
    `/api/remote/devices/${encodeURIComponent(deviceId)}`,
    { method: "DELETE" },
  );
}

export async function revokeAllRemoteDevices(): Promise<RevokeAllDevicesResponse> {
  return await requestJson<RevokeAllDevicesResponse>(
    "/api/remote/devices/revoke-all",
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function sendRemoteNotificationTest(
  payload?: RemoteNotificationTestRequest,
): Promise<RemoteNotificationTestResponse> {
  return await requestJson<RemoteNotificationTestResponse>(
    "/api/remote/notifications/test",
    {
      method: "POST",
      body: JSON.stringify(payload ?? {}),
    },
  );
}

export async function fetchTailscaleStatus(): Promise<TailscaleStatusResponse> {
  return await requestJson<TailscaleStatusResponse>("/api/remote/tailscale");
}

export async function fetchBootstrap(): Promise<BootstrapResponse> {
  return await requestJson<BootstrapResponse>("/api/bootstrap");
}

export async function fetchTaskDetail(taskId: string): Promise<TaskDetailResponse> {
  return await requestJson<TaskDetailResponse>(
    `/api/tasks/${encodeURIComponent(taskId)}`,
  );
}

export async function pauseTask(taskId: string, reason?: string): Promise<void> {
  await requestJson(`/api/tasks/${encodeURIComponent(taskId)}/pause`, {
    method: "POST",
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export async function resumeTask(taskId: string, stage?: StageId): Promise<void> {
  await requestJson(`/api/tasks/${encodeURIComponent(taskId)}/resume`, {
    method: "POST",
    body: JSON.stringify(stage ? { stage } : {}),
  });
}

export async function completeTask(taskId: string, deliverRef?: string): Promise<void> {
  await requestJson(`/api/tasks/${encodeURIComponent(taskId)}/complete`, {
    method: "POST",
    body: JSON.stringify(deliverRef ? { deliver_ref: deliverRef } : {}),
  });
}

export async function openRunTui(
  taskId: string,
  runDir: string,
): Promise<OpenRunTuiResponse> {
  return await requestJson<OpenRunTuiResponse>(
    `/api/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runDir)}/open-tui`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function cancelTask(taskId: string, reason?: string): Promise<void> {
  await requestJson(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: "POST",
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export async function updatePriority(
  taskId: string,
  priority: Priority,
): Promise<{ ok: boolean; effectivePriority?: Priority }> {
  return await requestJson(`/api/tasks/${encodeURIComponent(taskId)}/priority`, {
    method: "POST",
    body: JSON.stringify({ priority }),
  });
}

export async function submitDecision(
  taskId: string,
  payload: SubmitDecisionPayload,
): Promise<Record<string, unknown>> {
  return await requestJson(`/api/tasks/${encodeURIComponent(taskId)}/decide`, {
    method: "POST",
    body: JSON.stringify({
      decision_id: payload.decision_id,
      option_id: payload.option_id,
      action: payload.action,
      ...(payload.rationale ? { rationale: payload.rationale } : {}),
      apply_ledger_rule: Boolean(payload.apply_ledger_rule),
      ...(payload.contract_update ? { contract_update: payload.contract_update } : {}),
    }),
  });
}

export async function restoreHostBackup(
  taskId: string,
): Promise<RestoreHostBackupResult> {
  const url = `/api/tasks/${encodeURIComponent(taskId)}/restore-backup`;
  const res = await apiFetch(url, { method: "POST" });
  const data = await parseJsonSafe(res);

  if (res.ok) {
    return {
      ok: true,
      manifest: data.manifest as HostBackupManifestInfo,
    };
  }

  if (res.status === 409) {
    const code = typeof data.code === "string"
      ? data.code
      : typeof data.error === "string"
        ? data.error
        : "hash_mismatch";

    if (code === "hash_mismatch") {
      const hashErr: HashMismatchError = {
        code: "hash_mismatch",
        path: typeof data.path === "string" ? data.path : "",
        expectedSha256:
          typeof data.expectedSha256 === "string" ? data.expectedSha256 : "",
        actualSha256:
          typeof data.actualSha256 === "string" ? data.actualSha256 : "",
        diff: typeof data.diff === "string" ? data.diff : "",
      };
      const rawConflicts = Array.isArray(data.conflicts)
        ? (data.conflicts as HostRestoreConflictDetail[])
        : [
            {
              targetCanonicalPath: hashErr.path,
              expectedPostSha256: hashErr.expectedSha256,
              actualSha256: hashErr.actualSha256,
              diff: hashErr.diff,
            },
          ];
      return {
        ok: false,
        status: 409,
        code: "hash_mismatch",
        message: "目标文件已被后续修改（SHA256 不一致），已拦截恢复",
        hashMismatch: hashErr,
        conflicts: rawConflicts,
      };
    }

    if (code === "lock_conflict") {
      return {
        ok: false,
        status: 409,
        code: "lock_conflict",
        message:
          typeof data.message === "string"
            ? data.message
            : "路径正被其他任务锁定，无法恢复备份",
        lockConflicts: Array.isArray(data.conflicts)
          ? (data.conflicts as Array<{ path: string; heldByTaskId: string }>)
          : [],
      };
    }

    return {
      ok: false,
      status: 409,
      code: "invalid_backup_state",
      message:
        typeof data.message === "string" ? data.message : "备份状态不可恢复",
    };
  }

  if (res.status === 404) {
    return {
      ok: false,
      status: 404,
      code: "backup_not_found",
      message:
        typeof data.message === "string" ? data.message : "暂无可恢复的本机备份",
    };
  }

  const err = makeApiError(res, data, `恢复备份失败 (${res.status})`);
  notifyIfUnauthorized(url, err);
  throw err;
}

export async function upsertDraft(
  payload: UpsertDraftPayload,
): Promise<{ ok: boolean; draft: DraftCard }> {
  return await requestJson("/api/drafts", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function deleteDraft(
  draftId: string,
): Promise<{ ok: boolean; deleted: boolean; id: string }> {
  return await requestJson(`/api/drafts/${encodeURIComponent(draftId)}`, {
    method: "DELETE",
  });
}

export async function inspectSpacePath(rawPath: string): Promise<InspectSpaceResult> {
  return await requestJson<InspectSpaceResult>("/api/spaces/inspect", {
    method: "POST",
    body: JSON.stringify({ path: rawPath }),
  });
}

export async function discoverSpaces(): Promise<DiscoverSpacesResponse> {
  const url = "/api/spaces/discover";
  const res = await apiFetch(url);
  if (res.status === 404) {
    return { ok: true, repos: [], scanned_roots: [], truncated: false };
  }
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    const err = makeApiError(res, data, "扫描本机 Git 项目失败");
    notifyIfUnauthorized(url, err);
    throw err;
  }
  if (!Array.isArray(data.repos)) {
    return { ok: true, repos: [], scanned_roots: [], truncated: false };
  }
  return {
    ok: true,
    repos: data.repos as DiscoverSpacesResponse["repos"],
    scanned_roots: Array.isArray(data.scanned_roots)
      ? (data.scanned_roots as string[])
      : [],
    truncated: Boolean(data.truncated),
  };
}

export async function pickSpaceDirectory(): Promise<PickDirectoryResponse> {
  return await requestJson<PickDirectoryResponse>("/api/spaces/pick-directory", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function revealLocalPath(
  targetPath: string,
): Promise<{ ok: true; path: string }> {
  return await requestJson<{ ok: true; path: string }>("/api/system/reveal-path", {
    method: "POST",
    body: JSON.stringify({ path: targetPath }),
  });
}

export async function upsertSpace(
  spaceId: string,
  payload: UpsertSpacePayload,
): Promise<{ ok: boolean; space: SpaceConfig }> {
  return await requestJson(`/api/spaces/${encodeURIComponent(spaceId)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function deleteSpace(
  spaceId: string,
): Promise<{ ok: boolean; deleted: boolean; id: string }> {
  return await requestJson(`/api/spaces/${encodeURIComponent(spaceId)}`, {
    method: "DELETE",
  });
}

function replaceNewTaskPlaceholder(value: string, taskId: string): string {
  return value.replace(/<新任务>/g, taskId);
}

export function resolvePlaceholdersForCommit(
  payload: CommitDraftPayload,
  resolvedTaskId: string,
): CommitDraftPayload {
  const contract = payload.contract
    ? {
        ...payload.contract,
        ...(payload.contract.goal !== undefined
          ? { goal: replaceNewTaskPlaceholder(payload.contract.goal, resolvedTaskId) }
          : {}),
        ...(payload.contract.end !== undefined
          ? { end: replaceNewTaskPlaceholder(payload.contract.end, resolvedTaskId) }
          : {}),
        ...(payload.contract.accept_cmd !== undefined
          ? {
              accept_cmd: replaceNewTaskPlaceholder(
                payload.contract.accept_cmd,
                resolvedTaskId,
              ),
            }
          : {}),
        ...(payload.contract.scope !== undefined
          ? {
              scope: payload.contract.scope.map((s) =>
                replaceNewTaskPlaceholder(s, resolvedTaskId),
              ),
            }
          : {}),
        ...(payload.contract.deliver !== undefined
          ? {
              deliver:
                payload.contract.deliver.mode === "run_cmd"
                  ? {
                      mode: "run_cmd" as const,
                      cmd: replaceNewTaskPlaceholder(
                        payload.contract.deliver.cmd,
                        resolvedTaskId,
                      ),
                    }
                  : payload.contract.deliver,
            }
          : {}),
      }
    : undefined;

  return {
    ...payload,
    id: resolvedTaskId,
    ...(payload.title !== undefined
      ? { title: replaceNewTaskPlaceholder(payload.title, resolvedTaskId) }
      : {}),
    ...(contract ? { contract } : {}),
    brief_markdown: replaceNewTaskPlaceholder(payload.brief_markdown, resolvedTaskId),
  };
}

export async function commitDraft(
  draftId: string,
  payload: CommitDraftPayload,
): Promise<{ ok: boolean; card: TaskCard; state: Record<string, unknown> }> {
  const effectivePayload = payload.id
    ? resolvePlaceholdersForCommit(payload, payload.id)
    : payload;

  return await requestJson(`/api/drafts/${encodeURIComponent(draftId)}/commit`, {
    method: "POST",
    body: JSON.stringify(effectivePayload),
  });
}

export async function updateSettings<K extends keyof SettingsSectionMap>(
  section: K,
  data: SettingsSectionMap[K],
): Promise<{ ok: boolean; section: K; data: SettingsSectionMap[K] }> {
  return await requestJson(`/api/settings/${encodeURIComponent(section)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function syncModelPricing(
  payload?: SyncPricingRequest,
): Promise<SyncPricingResponse> {
  return await requestJson<SyncPricingResponse>("/api/settings/pricing/sync", {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
}

export async function fetchDraftChat(draftId: string): Promise<ChatMessage[] | null> {
  const url = `/api/drafts/${encodeURIComponent(draftId)}/chat`;
  const res = await apiFetch(url);
  if (res.status === 404) return null;
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    const err = makeApiError(res, data, "读取草稿对话失败");
    notifyIfUnauthorized(url, err);
    throw err;
  }
  return Array.isArray(data.messages) ? (data.messages as ChatMessage[]) : [];
}

export async function sendIntakeChat(
  draftId: string,
  message: string,
): Promise<ChatResponsePayload> {
  return await requestJson<ChatResponsePayload>(
    `/api/drafts/${encodeURIComponent(draftId)}/chat`,
    {
      method: "POST",
      body: JSON.stringify({ message }),
    },
  );
}

export async function fetchTaskChat(taskId: string): Promise<ChatMessage[] | null> {
  const url = `/api/tasks/${encodeURIComponent(taskId)}/chat`;
  const res = await apiFetch(url);
  if (res.status === 404) return null;
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    const err = makeApiError(res, data, "读取讨论记录失败");
    notifyIfUnauthorized(url, err);
    throw err;
  }
  return Array.isArray(data.messages) ? (data.messages as ChatMessage[]) : [];
}

export async function sendResolveChat(
  taskId: string,
  message: string,
): Promise<ChatResponsePayload> {
  return await requestJson<ChatResponsePayload>(
    `/api/tasks/${encodeURIComponent(taskId)}/chat`,
    {
      method: "POST",
      body: JSON.stringify({ message }),
    },
  );
}

export async function fetchAgents(options?: {
  refresh?: boolean;
}): Promise<{ agents: AgentDescriptorInfo[]; backends: BackendConnectionInfo[] } | null> {
  const qs = options?.refresh ? "?refresh=1" : "";
  const url = `/api/agents${qs}`;
  const res = await apiFetch(url);
  if (res.status === 404) return null;
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    const err = makeApiError(res, data, "获取 Agent 列表失败");
    notifyIfUnauthorized(url, err);
    throw err;
  }
  return {
    agents: Array.isArray(data.agents) ? (data.agents as AgentDescriptorInfo[]) : [],
    backends: Array.isArray(data.backends) ? (data.backends as BackendConnectionInfo[]) : [],
  };
}

export async function fetchLedgers(): Promise<
  Record<string, LedgerFile> | LedgerFile[] | Array<{ space: string; entries: LedgerEntry[] }> | null
> {
  const url = "/api/ledgers";
  const res = await apiFetch(url);
  if (res.status === 404) return null;
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    const err = makeApiError(res, data, "获取决策账本失败");
    notifyIfUnauthorized(url, err);
    throw err;
  }
  if (data.ledgers !== undefined) {
    return data.ledgers as Record<string, LedgerFile> | LedgerFile[];
  }
  return null;
}

export async function fetchChatCommands(params: {
  role: "intake" | "resolver";
  spaceId?: string;
  draftId?: string | null;
  taskId?: string | null;
}): Promise<ChatCommandsResponse> {
  const qs = new URLSearchParams({ role: params.role });
  if (params.spaceId) qs.set("space", params.spaceId);
  if (params.draftId) qs.set("draftId", params.draftId);
  if (params.taskId) qs.set("taskId", params.taskId);
  return await requestJson<ChatCommandsResponse>(`/api/chat/commands?${qs.toString()}`);
}

export async function fetchSpaceFiles(
  spaceId: string,
  query = "",
  limit = 24,
): Promise<SpaceFilesResponse> {
  const qs = new URLSearchParams();
  if (query.trim().length > 0) qs.set("q", query.trim());
  qs.set("limit", String(limit));
  return await requestJson<SpaceFilesResponse>(
    `/api/spaces/${encodeURIComponent(spaceId)}/files?${qs.toString()}`,
  );
}

export async function fetchProviders(): Promise<ProvidersStatusResponse> {
  return await requestJson<ProvidersStatusResponse>("/api/providers");
}

export async function testProvider(providerId: string): Promise<TestProviderResponse> {
  return await requestJson<TestProviderResponse>(
    `/api/providers/${encodeURIComponent(providerId)}/test`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function fetchProvidersSettings(): Promise<ProviderSettingsResponse> {
  return await requestJson<ProviderSettingsResponse>("/api/settings/providers");
}

export async function fetchRosterSettings(): Promise<RosterSettingsResponse> {
  return await requestJson<RosterSettingsResponse>("/api/settings/roster");
}

export async function fetchTaskCheckpoints(
  taskId: string,
): Promise<TaskCheckpointsResponse> {
  return await requestJson<TaskCheckpointsResponse>(
    `/api/tasks/${encodeURIComponent(taskId)}/checkpoints`,
  );
}

export async function rollbackTaskCheckpoint(
  taskId: string,
  payload: RollbackCheckpointRequest,
): Promise<RollbackCheckpointResponse> {
  return await requestJson<RollbackCheckpointResponse>(
    `/api/tasks/${encodeURIComponent(taskId)}/checkpoints/rollback`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export async function runSpaceScript(
  spaceId: string,
  payload: RunSpaceScriptRequest,
): Promise<RunSpaceScriptResponse> {
  return await requestJson<RunSpaceScriptResponse>(
    `/api/spaces/${encodeURIComponent(spaceId)}/scripts/run`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export async function fetchScriptRuns(params?: {
  spaceId?: string;
  taskId?: string;
}): Promise<ListScriptsResponse> {
  const qs = new URLSearchParams();
  if (params?.spaceId) qs.set("spaceId", params.spaceId);
  if (params?.taskId) qs.set("taskId", params.taskId);
  const query = qs.toString();
  return await requestJson<ListScriptsResponse>(
    `/api/scripts${query ? `?${query}` : ""}`,
  );
}

export async function stopScriptRun(
  scriptRunId: string,
): Promise<{ ok: true; scriptRunId: string; stopped: boolean }> {
  return await requestJson<{ ok: true; scriptRunId: string; stopped: boolean }>(
    `/api/scripts/${encodeURIComponent(scriptRunId)}/stop`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function fetchPrDraft(taskId: string): Promise<PrDraftResponse> {
  return await requestJson<PrDraftResponse>(
    `/api/tasks/${encodeURIComponent(taskId)}/deliver/pr-draft`,
  );
}

export async function executeGitDeliver(
  taskId: string,
  payload: CommitPrActionRequest,
): Promise<DeliverGitResponse> {
  return await requestJson<DeliverGitResponse>(
    `/api/tasks/${encodeURIComponent(taskId)}/deliver/git`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export async function uploadDraftAttachment(
  draftId: string,
  payload: DraftAttachmentUploadPayload,
): Promise<DraftAttachmentUploadResponse> {
  return await requestJson<DraftAttachmentUploadResponse>(
    `/api/drafts/${encodeURIComponent(draftId)}/attachments`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export async function deleteDraftAttachment(
  draftId: string,
  attachmentId: string,
): Promise<{ ok: true; deleted: boolean; draft: DraftAttachmentUploadResponse["draft"] }> {
  return await requestJson<{
    ok: true;
    deleted: boolean;
    draft: DraftAttachmentUploadResponse["draft"];
  }>(
    `/api/drafts/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { method: "DELETE" },
  );
}

export async function commitSplitDraft(
  draftId: string,
  cards: SplitCardPlanItem[],
): Promise<CommitSplitCardsResponse> {
  return await requestJson<CommitSplitCardsResponse>(
    `/api/drafts/${encodeURIComponent(draftId)}/commit-split`,
    {
      method: "POST",
      body: JSON.stringify({ cards }),
    },
  );
}

export interface SseSubscriptionHandlers {
  onEvent: (event: SseEvent) => void;
  onStatusChange?: (status: "connected" | "reconnecting" | "closed") => void;
}

export function subscribeSseEvents(handlers: SseSubscriptionHandlers): () => void {
  if (typeof window === "undefined" || typeof window.EventSource !== "function") {
    return () => {};
  }

  const es = new window.EventSource("/api/events");
  const parseAndEmit = (raw: string): void => {
    try {
      const parsed = JSON.parse(raw) as SseEvent;
      if (parsed && typeof parsed.type === "string") {
        handlers.onEvent(parsed);
      }
    } catch {
      // Ignore malformed SSE payload frames
    }
  };

  const eventTypes: SseEvent["type"][] = [
    "task.updated",
    "rate.tick",
    "decision.requested",
    "run.event",
    "intake.progress",
    "script.output",
    "provider.status",
  ];

  const listener = (ev: Event): void => {
    const msg = ev as MessageEvent<string>;
    if (typeof msg.data === "string") {
      parseAndEmit(msg.data);
    }
  };

  for (const type of eventTypes) {
    es.addEventListener(type, listener);
  }
  es.onmessage = (msg) => {
    if (typeof msg.data === "string") {
      parseAndEmit(msg.data);
    }
  };
  es.onopen = () => {
    handlers.onStatusChange?.("connected");
  };
  es.onerror = () => {
    handlers.onStatusChange?.("reconnecting");
  };

  return () => {
    for (const type of eventTypes) {
      es.removeEventListener(type, listener);
    }
    es.close();
    handlers.onStatusChange?.("closed");
  };
}
