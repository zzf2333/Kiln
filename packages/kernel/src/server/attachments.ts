import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  TaskAttachmentSchema,
  type AttachmentMimeType,
  type DraftCard,
  type TaskAttachment,
} from "@kiln/protocol";
import type { RunAttachmentInput } from "../backend/types.js";
import {
  assertSafeSegment,
  ensureDir,
  KilnStore,
  realpathCanonical,
  writeFileAtomic,
} from "../store/index.js";
import { ServerHttpError } from "./errors.js";

export const MAX_ATTACHMENTS_PER_CARD = 12;
export const MAX_ATTACHMENT_UPLOAD_BODY_BYTES = 15 * 1024 * 1024;

const MIME_TO_EXT: Readonly<Record<AttachmentMimeType, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function isInsideDir(targetPath: string, rootDir: string): boolean {
  const canonicalRoot = fs.existsSync(rootDir) ? realpathCanonical(rootDir) : path.resolve(rootDir);
  const canonicalTarget = fs.existsSync(targetPath)
    ? realpathCanonical(targetPath)
    : path.resolve(targetPath);
  const normRoot = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
  const normTarget = process.platform === "win32" ? canonicalTarget.toLowerCase() : canonicalTarget;
  const prefix = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;
  return normTarget === normRoot || normTarget.startsWith(prefix);
}

/**
 * Verifies real binary image magic headers so spoofed HTML/script payloads
 * cannot masquerade under allowed image MIME types.
 */
export function validateImageMagicBytes(buf: Buffer, mimeType: AttachmentMimeType): boolean {
  switch (mimeType) {
    case "image/png":
      return (
        buf.length >= 8 &&
        buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47 &&
        buf[4] === 0x0d &&
        buf[5] === 0x0a &&
        buf[6] === 0x1a &&
        buf[7] === 0x0a
      );
    case "image/jpeg":
      return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case "image/gif": {
      if (buf.length < 6) return false;
      const sig = buf.subarray(0, 6).toString("ascii");
      return sig === "GIF87a" || sig === "GIF89a";
    }
    case "image/webp":
      return (
        buf.length >= 12 &&
        buf.subarray(0, 4).toString("ascii") === "RIFF" &&
        buf.subarray(8, 12).toString("ascii") === "WEBP"
      );
  }
}

export function sanitizeAttachmentFilename(raw: string, fallbackExt: string): string {
  const base = path
    .basename(raw.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .trim();
  if (base.length === 0 || base === "." || base === "..") {
    return `attachment.${fallbackExt}`;
  }
  return base.length > 120 ? base.slice(0, 120) : base;
}

function assertValidMimeType(rawMime: string): AttachmentMimeType {
  const normalized = rawMime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!(ATTACHMENT_MIME_TYPES as readonly string[]).includes(normalized)) {
    throw new ServerHttpError(400, {
      error: "unsupported_attachment_mime",
      mimeType: rawMime,
      message: `Unsupported attachment mime_type "${rawMime}"; allowed: ${ATTACHMENT_MIME_TYPES.join(", ")}`,
    });
  }
  return normalized as AttachmentMimeType;
}

function resolveDiskFileName(attachment: TaskAttachment): string {
  const diskName = path.posix.basename(attachment.rel_path.replace(/\\/g, "/"));
  return assertSafeSegment(diskName, "attachmentFile");
}

/**
 * Validates and persists an uploaded image attachment onto a draft under `drafts/<id>/attachments/`.
 */
export function saveDraftAttachment(
  store: KilnStore,
  draftId: string,
  input: { filename: string; mimeType: string; bytes: Buffer },
): { attachment: TaskAttachment; draft: DraftCard } {
  const safeDraftId = assertSafeSegment(draftId, "draftId");
  const draft = store.readDraft(safeDraftId);
  if (!draft) {
    throw new ServerHttpError(404, {
      error: "draft_not_found",
      draftId: safeDraftId,
      message: `Draft "${safeDraftId}" does not exist`,
    });
  }

  const current = draft.attachments ?? [];
  if (current.length >= MAX_ATTACHMENTS_PER_CARD) {
    throw new ServerHttpError(400, {
      error: "too_many_attachments",
      max: MAX_ATTACHMENTS_PER_CARD,
      message: `Draft cannot exceed ${MAX_ATTACHMENTS_PER_CARD} attachments`,
    });
  }

  const mimeType = assertValidMimeType(input.mimeType);
  if (input.bytes.length === 0) {
    throw new ServerHttpError(400, {
      error: "empty_attachment",
      message: "Attachment file is empty",
    });
  }
  if (input.bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new ServerHttpError(413, {
      error: "attachment_too_large",
      maxBytes: MAX_ATTACHMENT_BYTES,
      actualBytes: input.bytes.length,
      message: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes limit`,
    });
  }
  if (!validateImageMagicBytes(input.bytes, mimeType)) {
    throw new ServerHttpError(400, {
      error: "invalid_attachment_content",
      mimeType,
      message: `Uploaded file bytes do not match declared MIME type "${mimeType}"`,
    });
  }

  const ext = MIME_TO_EXT[mimeType];
  const id = `att-${randomUUID().slice(0, 8)}`;
  const diskFileName = `${id}.${ext}`;
  const cleanName = sanitizeAttachmentFilename(input.filename, ext);
  const sha256 = crypto.createHash("sha256").update(input.bytes).digest("hex");
  const addedAt = new Date().toISOString();

  const absPath = store.paths.draftAttachmentFile(safeDraftId, diskFileName);
  ensureDir(path.dirname(absPath));
  writeFileAtomic(absPath, input.bytes);

  const attachment = TaskAttachmentSchema.parse({
    id,
    filename: cleanName,
    mime_type: mimeType,
    size_bytes: input.bytes.length,
    sha256,
    rel_path: `drafts/${safeDraftId}/attachments/${diskFileName}`,
    added_at: addedAt,
  });

  const nextDraft: DraftCard = {
    ...draft,
    attachments: [...current, attachment],
    updated_at: addedAt,
  };
  store.writeDraft(nextDraft);
  return { attachment, draft: nextDraft };
}

/**
 * Deletes an attachment from a draft and removes its disk file cleanly.
 */
export function deleteDraftAttachment(
  store: KilnStore,
  draftId: string,
  attachmentId: string,
): DraftCard {
  const safeDraftId = assertSafeSegment(draftId, "draftId");
  const safeAttachmentId = assertSafeSegment(attachmentId, "attachmentId");
  const draft = store.readDraft(safeDraftId);
  if (!draft) {
    throw new ServerHttpError(404, {
      error: "draft_not_found",
      draftId: safeDraftId,
      message: `Draft "${safeDraftId}" does not exist`,
    });
  }

  const current = draft.attachments ?? [];
  const target = current.find((att) => att.id === safeAttachmentId);
  if (!target) {
    throw new ServerHttpError(404, {
      error: "attachment_not_found",
      draftId: safeDraftId,
      attachmentId: safeAttachmentId,
      message: `Attachment "${safeAttachmentId}" not found on draft "${safeDraftId}"`,
    });
  }

  const diskName = resolveDiskFileName(target);
  const absPath = store.paths.draftAttachmentFile(safeDraftId, diskName);
  const draftAttDir = store.paths.draftAttachmentsDir(safeDraftId);
  if (fs.existsSync(absPath) && isInsideDir(absPath, draftAttDir)) {
    fs.rmSync(absPath, { force: true });
  }

  const nextList = current.filter((att) => att.id !== safeAttachmentId);
  const nextDraft: DraftCard = {
    ...draft,
    ...(nextList.length > 0 ? { attachments: nextList } : { attachments: [] }),
    updated_at: new Date().toISOString(),
  };
  store.writeDraft(nextDraft);
  return nextDraft;
}

/**
 * Copies verified draft attachments into `tasks/<taskId>/attachments/` and rewrites `rel_path`.
 */
export function copyDraftAttachmentsToTask(
  store: KilnStore,
  draftId: string,
  taskId: string,
  requestedAttachments?: readonly TaskAttachment[],
): TaskAttachment[] {
  const safeDraftId = assertSafeSegment(draftId, "draftId");
  const safeTaskId = assertSafeSegment(taskId, "taskId");
  const draft = store.readDraft(safeDraftId);
  const draftList = draft?.attachments ?? [];

  if (requestedAttachments && requestedAttachments.length > 0) {
    const draftById = new Map(draftList.map((att) => [att.id, att]));
    for (const req of requestedAttachments) {
      if (!draftById.has(req.id)) {
        throw new ServerHttpError(400, {
          error: "invalid_attachment_path",
          attachmentId: req.id,
          rel_path: req.rel_path,
          message: `Attachment "${req.id}" does not belong to draft "${safeDraftId}"`,
        });
      }
    }
  }

  if (draftList.length === 0) {
    return [];
  }

  const selected =
    requestedAttachments !== undefined
      ? draftList.filter((att) => requestedAttachments.some((req) => req.id === att.id))
      : draftList;
  if (selected.length === 0) {
    return [];
  }

  const draftAttDir = store.paths.draftAttachmentsDir(safeDraftId);
  const taskAttDir = store.paths.taskAttachmentsDir(safeTaskId);
  ensureDir(taskAttDir);

  const copied: TaskAttachment[] = [];
  for (const att of selected) {
    const diskName = resolveDiskFileName(att);
    const srcPath = store.paths.draftAttachmentFile(safeDraftId, diskName);
    if (!fs.existsSync(srcPath) || !isInsideDir(srcPath, draftAttDir)) {
      throw new ServerHttpError(400, {
        error: "invalid_attachment_path",
        attachmentId: att.id,
        message: `Draft attachment "${att.id}" is missing or escapes draft attachments directory`,
      });
    }
    const bytes = fs.readFileSync(srcPath);
    const destPath = store.paths.taskAttachmentFile(safeTaskId, diskName);
    writeFileAtomic(destPath, bytes);
    copied.push(
      TaskAttachmentSchema.parse({
        ...att,
        rel_path: `tasks/${safeTaskId}/attachments/${diskName}`,
      }),
    );
  }
  return copied;
}

/**
 * Rejects any task card attachment pointing outside `tasks/<id>/attachments/` or referencing `drafts/`.
 */
export function validateCommitAttachments(
  attachments: readonly TaskAttachment[] | undefined,
  expectedTaskId?: string,
): void {
  if (!attachments || attachments.length === 0) {
    return;
  }
  for (const att of attachments) {
    const norm = att.rel_path.replace(/\\/g, "/");
    if (
      path.posix.isAbsolute(norm) ||
      att.rel_path.includes("\\") ||
      norm.split("/").includes("..") ||
      norm.startsWith("drafts/")
    ) {
      throw new ServerHttpError(400, {
        error: "invalid_attachment_path",
        attachmentId: att.id,
        rel_path: att.rel_path,
        message: `Invalid task attachment rel_path "${att.rel_path}": must live under tasks/<id>/attachments/`,
      });
    }
    if (expectedTaskId !== undefined) {
      const prefix = `tasks/${expectedTaskId}/attachments/`;
      if (!norm.startsWith(prefix)) {
        throw new ServerHttpError(400, {
          error: "invalid_attachment_path",
          attachmentId: att.id,
          rel_path: att.rel_path,
          message: `Task attachment "${att.id}" rel_path must start with "${prefix}"`,
        });
      }
    }
  }
}

/**
 * Resolves a stored draft or task attachment to an existing canonical file path inside its attachment root.
 */
export function resolveReadableAttachmentFile(
  store: KilnStore,
  scope: { kind: "draft"; draftId: string } | { kind: "task"; taskId: string },
  attachmentId: string,
): { attachment: TaskAttachment; absPath: string } {
  const safeAttId = assertSafeSegment(attachmentId, "attachmentId");
  let list: readonly TaskAttachment[] = [];
  let rootDir: string;
  let resolveFile: (diskName: string) => string;

  if (scope.kind === "draft") {
    const safeDraftId = assertSafeSegment(scope.draftId, "draftId");
    const draft = store.readDraft(safeDraftId);
    if (!draft) {
      throw new ServerHttpError(404, {
        error: "draft_not_found",
        draftId: safeDraftId,
        message: `Draft "${safeDraftId}" does not exist`,
      });
    }
    list = draft.attachments ?? [];
    rootDir = store.paths.draftAttachmentsDir(safeDraftId);
    resolveFile = (diskName) => store.paths.draftAttachmentFile(safeDraftId, diskName);
  } else {
    const safeTaskId = assertSafeSegment(scope.taskId, "taskId");
    const card = store.readTaskCard(safeTaskId);
    list = card.attachments ?? [];
    rootDir = store.paths.taskAttachmentsDir(safeTaskId);
    resolveFile = (diskName) => store.paths.taskAttachmentFile(safeTaskId, diskName);
  }

  const attachment = list.find((a) => a.id === safeAttId);
  if (!attachment) {
    throw new ServerHttpError(404, {
      error: "attachment_not_found",
      attachmentId: safeAttId,
      message: `Attachment "${safeAttId}" not found`,
    });
  }

  const diskName = resolveDiskFileName(attachment);
  const absPath = resolveFile(diskName);
  if (!fs.existsSync(absPath) || !isInsideDir(absPath, rootDir)) {
    throw new ServerHttpError(404, {
      error: "attachment_file_missing",
      attachmentId: safeAttId,
      message: `Attachment file for "${safeAttId}" does not exist on disk`,
    });
  }

  return { attachment, absPath: realpathCanonical(absPath) };
}

/**
 * Builds backend `RunAttachmentInput[]` for stored task/draft attachments whose files exist safely on disk.
 */
export function resolveRunAttachmentInputs(
  store: KilnStore,
  scope: { kind: "draft"; draftId: string } | { kind: "task"; taskId: string },
): RunAttachmentInput[] {
  let attachments: readonly TaskAttachment[] = [];
  if (scope.kind === "draft") {
    attachments = store.readDraft(assertSafeSegment(scope.draftId, "draftId"))?.attachments ?? [];
  } else {
    try {
      attachments = store.readTaskCard(assertSafeSegment(scope.taskId, "taskId")).attachments ?? [];
    } catch {
      attachments = [];
    }
  }
  const out: RunAttachmentInput[] = [];
  for (const att of attachments) {
    try {
      const resolved = resolveReadableAttachmentFile(store, scope, att.id);
      out.push({
        path: resolved.absPath,
        mimeType: resolved.attachment.mime_type,
        filename: resolved.attachment.filename,
      });
    } catch {
      // Skip missing attachments without blocking non-attachment text prompts.
    }
  }
  return out;
}
