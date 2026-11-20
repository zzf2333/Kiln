import type {
  DraftCard,
  HashMismatchError,
  LedgerEntry,
  LedgerFile,
  Priority,
  SpaceConfig,
  SseEvent,
  TaskCard,
} from "@kiln/protocol/web";
import type {
  AgentDescriptorInfo,
  BootstrapResponse,
  ChatMessage,
  ChatResponsePayload,
  CommitDraftPayload,
  HostBackupManifestInfo,
  HostRestoreConflictDetail,
  InspectSpaceResult,
  RestoreHostBackupResult,
  SettingsSectionMap,
  SubmitDecisionPayload,
  TaskDetailResponse,
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

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    const code =
      typeof data.code === "string"
        ? data.code
        : typeof data.error === "string"
          ? data.error
          : `http_${res.status}`;
    const message =
      typeof data.message === "string" ? data.message : `请求失败 (${res.status})`;
    throw new ApiError(res.status, code, message, data);
  }
  return data as unknown as T;
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

export async function resumeTask(taskId: string): Promise<void> {
  await requestJson(`/api/tasks/${encodeURIComponent(taskId)}/resume`, {
    method: "POST",
    body: JSON.stringify({}),
  });
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
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/restore-backup`,
    { method: "POST" },
  );
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

  throw new ApiError(
    res.status,
    typeof data.error === "string" ? data.error : `http_${res.status}`,
    typeof data.message === "string" ? data.message : `恢复备份失败 (${res.status})`,
    data,
  );
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

export async function fetchDraftChat(draftId: string): Promise<ChatMessage[] | null> {
  const res = await fetch(`/api/drafts/${encodeURIComponent(draftId)}/chat`);
  if (res.status === 404) return null;
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      typeof data.error === "string" ? data.error : `http_${res.status}`,
      typeof data.message === "string" ? data.message : "读取草稿对话失败",
      data,
    );
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
  const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/chat`);
  if (res.status === 404) return null;
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      typeof data.error === "string" ? data.error : `http_${res.status}`,
      typeof data.message === "string" ? data.message : "读取讨论记录失败",
      data,
    );
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

export async function fetchAgents(): Promise<AgentDescriptorInfo[] | null> {
  const res = await fetch("/api/agents");
  if (res.status === 404) return null;
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      typeof data.error === "string" ? data.error : `http_${res.status}`,
      typeof data.message === "string" ? data.message : "获取 Agent 列表失败",
      data,
    );
  }
  return Array.isArray(data.agents) ? (data.agents as AgentDescriptorInfo[]) : [];
}

export async function fetchLedgers(): Promise<
  Record<string, LedgerFile> | LedgerFile[] | Array<{ space: string; entries: LedgerEntry[] }> | null
> {
  const res = await fetch("/api/ledgers");
  if (res.status === 404) return null;
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      typeof data.error === "string" ? data.error : `http_${res.status}`,
      typeof data.message === "string" ? data.message : "获取决策账本失败",
      data,
    );
  }
  if (data.ledgers !== undefined) {
    return data.ledgers as Record<string, LedgerFile> | LedgerFile[];
  }
  return null;
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
