import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HOST_BACKUP_STATUSES,
  HostBackupFileEntrySchema,
  HostBackupManifestSchema,
  HostBackupStatusSchema,
  type HostBackupFileEntry,
  type HostBackupManifest,
  type HostBackupStatus,
} from "../store/backup-manifest.js";
import { realpathCanonical, writeFileAtomic } from "../store/fs-atomic.js";
import type { KilnStore } from "../store/kiln-store.js";
import { assertSafeSegment } from "../store/paths.js";
import type { HostPathLockConflict } from "../store/sqlite.js";
import { runIsolatedCommand, type IsolatedCommandResult } from "./command-runner.js";
import { matchesAnyGlobPattern, normalizeRepoRelativePath } from "./scope.js";

export {
  HOST_BACKUP_STATUSES,
  HostBackupFileEntrySchema,
  HostBackupManifestSchema,
  HostBackupStatusSchema,
  type HostBackupFileEntry,
  type HostBackupManifest,
  type HostBackupStatus,
};

export interface StagedHostFileSpec {
  stagedRelativePath: string;
  targetPath: string;
}

export interface StageHostScopedChangesInput {
  taskId: string;
  contractScope: readonly string[];
  stagedFiles: readonly StagedHostFileSpec[];
  now?: string;
}

export type StageHostScopedChangesResult =
  | {
      ok: true;
      requiresApproval: true;
      manifest: HostBackupManifest;
    }
  | {
      ok: false;
      reason: "lock_conflict";
      conflicts: HostPathLockConflict[];
    };

export interface ApplyApprovedHostScopedChangesInput {
  taskId: string;
  approved: boolean;
  postApplyCmd?: string;
  postApplyCwd?: string;
  postApplyTimeoutMs?: number;
  verifyCmd?: string;
  verifyCwd?: string;
  verifyTimeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  extraSafeEnv?: Record<string, string>;
  signal?: AbortSignal;
  now?: string;
}

export interface HostPreHashConflict {
  targetCanonicalPath: string;
  expectedPreSha256: string | null;
  actualSha256: string | null;
}

export interface HostStagedHashConflict {
  stagedRelativePath: string;
  targetCanonicalPath: string;
  expectedStagedSha256: string;
  actualStagedSha256: string;
}

export type ApplyApprovedHostScopedChangesResult =
  | {
      ok: true;
      postApplyResult?: IsolatedCommandResult | null;
      verifyResult: IsolatedCommandResult | null;
      manifest: HostBackupManifest;
    }
  | {
      ok: false;
      reason: "not_approved";
      manifest: HostBackupManifest;
    }
  | {
      ok: false;
      reason: "lock_conflict";
      conflicts: HostPathLockConflict[];
    }
  | {
      ok: false;
      reason: "staged_hash_mismatch";
      conflicts: HostStagedHashConflict[];
      manifest: HostBackupManifest;
    }
  | {
      ok: false;
      reason: "pre_hash_mismatch";
      conflicts: HostPreHashConflict[];
      manifest: HostBackupManifest;
    }
  | {
      ok: false;
      reason: "deliver_cmd_failed_rolled_back";
      postApplyResult: IsolatedCommandResult;
      manifest: HostBackupManifest;
    }
  | {
      ok: false;
      reason: "verify_failed_rolled_back";
      verifyResult: IsolatedCommandResult;
      manifest: HostBackupManifest;
    };

export interface RestoreHostScopedBackupInput {
  taskId: string;
  now?: string;
}

export interface HostRestoreHashConflict {
  targetCanonicalPath: string;
  expectedPostSha256: string | null;
  actualSha256: string | null;
  expectedSummary: string;
  actualSummary: string;
  diff: string;
}

export type RestoreHostScopedBackupResult =
  | {
      ok: true;
      statusCode: 200;
      manifest: HostBackupManifest;
    }
  | {
      ok: false;
      statusCode: 409;
      reason: "lock_conflict";
      conflicts: HostPathLockConflict[];
    }
  | {
      ok: false;
      statusCode: 409;
      reason: "hash_mismatch";
      conflicts: HostRestoreHashConflict[];
    };

export interface HostStagedDiffEntry {
  targetPath: string;
  existedBefore: boolean;
  preSha256: string | null;
  stagedSha256?: string | null;
  diff: string;
  truncated: boolean;
}

const MAX_SYMLINK_DEPTH = 40;
const MAX_DIFF_LINES = 400;
const MAX_STAGED_PREVIEW_BYTES = 64 * 1024;
const MAX_STAGED_DIFF_LINES = 200;

function sha256Buffer(buf: Buffer): string {
  return `sha256:${crypto.createHash("sha256").update(buf).digest("hex")}`;
}

function isInsideCanonicalDir(canonicalTarget: string, canonicalDir: string): boolean {
  const prefix = canonicalDir.endsWith(path.sep) ? canonicalDir : canonicalDir + path.sep;
  if (process.platform === "win32") {
    const targetLower = canonicalTarget.toLowerCase();
    return (
      targetLower === canonicalDir.toLowerCase() || targetLower.startsWith(prefix.toLowerCase())
    );
  }
  return canonicalTarget === canonicalDir || canonicalTarget.startsWith(prefix);
}

function expandHomeAndValidateHostInput(rawPath: string, label: string): string {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new Error(`Invalid ${label}: path must be a non-empty string`);
  }
  if (rawPath.includes("\0") || /[\u0000-\u001f\u007f]/.test(rawPath)) {
    throw new Error(`Invalid ${label}: control characters are forbidden`);
  }

  let expanded = rawPath;
  if (rawPath === "~") {
    expanded = os.homedir();
  } else if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    expanded = path.join(os.homedir(), rawPath.slice(2));
  }

  if (!path.isAbsolute(expanded)) {
    throw new Error(`Invalid ${label} "${rawPath}": must be an absolute path`);
  }

  return path.resolve(expanded);
}

function resolveCanonicalAbsolute(absPath: string, depth = 0): string {
  if (depth > MAX_SYMLINK_DEPTH) {
    throw new Error(`Too many levels of symbolic links resolving "${absPath}"`);
  }

  const normalized = path.resolve(absPath);
  const trailing: string[] = [];
  let current = normalized;

  while (true) {
    let lstat: fs.Stats | null = null;
    try {
      lstat = fs.lstatSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    if (lstat !== null) {
      let canonicalCurrent: string;
      if (lstat.isSymbolicLink()) {
        try {
          canonicalCurrent = realpathCanonical(current);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            const linkTarget = fs.readlinkSync(current);
            const resolvedLink = path.resolve(path.dirname(current), linkTarget);
            canonicalCurrent = resolveCanonicalAbsolute(resolvedLink, depth + 1);
          } else {
            throw err;
          }
        }
      } else {
        canonicalCurrent = realpathCanonical(current);
      }

      if (trailing.length > 0) {
        let statCheck: fs.Stats | null = null;
        try {
          statCheck = fs.statSync(canonicalCurrent);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
          }
        }
        if (statCheck !== null && !statCheck.isDirectory()) {
          throw new Error(
            `Cannot resolve host target "${absPath}": ancestor "${canonicalCurrent}" is not a directory`,
          );
        }
        return path.join(canonicalCurrent, ...trailing);
      }

      return canonicalCurrent;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.join(current, ...trailing);
    }
    trailing.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * Resolves a host filesystem target path to its canonical real path, including when
 * trailing path segments or symlink targets do not yet exist (macOS `/var` -> `/private/var`).
 */
export function resolveCanonicalHostTarget(targetPath: string): string {
  const absPath = expandHomeAndValidateHostInput(targetPath, "host target path");
  return resolveCanonicalAbsolute(absPath);
}

function hasHostGlobSyntax(pattern: string): boolean {
  return /[*?{}]/.test(pattern);
}

function normalizeCanonicalForCompare(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function matchesSingleHostScopePattern(canonicalTarget: string, rawPattern: string): boolean {
  const trimmedTrailingSlash = rawPattern.replace(/\\/g, "/").endsWith("/");
  const expandedAbs = expandHomeAndValidateHostInput(rawPattern, "host scope pattern");
  const targetCmp = normalizeCanonicalForCompare(canonicalTarget);

  if (!hasHostGlobSyntax(rawPattern)) {
    const canonicalPattern = resolveCanonicalAbsolute(expandedAbs);
    const prefixWithSep = canonicalPattern.endsWith(path.sep)
      ? canonicalPattern
      : canonicalPattern + path.sep;
    const patternCmp = normalizeCanonicalForCompare(canonicalPattern);
    const prefixCmp = normalizeCanonicalForCompare(prefixWithSep);

    if (trimmedTrailingSlash) {
      return targetCmp.startsWith(prefixCmp);
    }

    if (targetCmp === patternCmp) {
      return true;
    }

    try {
      if (fs.statSync(canonicalPattern).isDirectory()) {
        return targetCmp.startsWith(prefixCmp);
      }
    } catch {
      // Non-existent literal pattern without trailing slash only matches exact target path.
    }
    return false;
  }

  const parsedRoot = path.parse(expandedAbs).root;
  const tailAfterRoot = expandedAbs.slice(parsedRoot.length).replace(/\\/g, "/");
  const segments = tailAfterRoot.split("/").filter((s) => s.length > 0 && s !== ".");

  const firstGlobIdx = segments.findIndex((seg) => hasHostGlobSyntax(seg));
  if (firstGlobIdx === -1) {
    const canonicalPattern = resolveCanonicalAbsolute(expandedAbs);
    return targetCmp === normalizeCanonicalForCompare(canonicalPattern);
  }

  const literalPrefixPath =
    firstGlobIdx === 0 ? parsedRoot : path.join(parsedRoot, ...segments.slice(0, firstGlobIdx));
  const canonicalPrefix = resolveCanonicalAbsolute(literalPrefixPath);
  const prefixWithSep = canonicalPrefix.endsWith(path.sep)
    ? canonicalPrefix
    : canonicalPrefix + path.sep;

  if (!targetCmp.startsWith(normalizeCanonicalForCompare(prefixWithSep))) {
    return false;
  }

  const relativeTail = canonicalTarget.slice(prefixWithSep.length).replace(/\\/g, "/");
  if (relativeTail.length === 0) {
    return false;
  }

  let tailPattern = segments.slice(firstGlobIdx).join("/");
  if (trimmedTrailingSlash && !tailPattern.endsWith("/")) {
    tailPattern += "/";
  }

  return matchesAnyGlobPattern(relativeTail, [tailPattern]);
}

/**
 * Checks whether a canonicalized host target path falls within the `contractScope` whitelist.
 * Fails closed when `contractScope` is empty.
 */
export function isHostTargetWithinScope(
  canonicalTarget: string,
  contractScope: readonly string[],
): boolean {
  if (contractScope.length === 0) {
    return false;
  }
  return contractScope.some((pattern) => matchesSingleHostScopePattern(canonicalTarget, pattern));
}

export function readHostBackupManifest(store: KilnStore, taskId: string): HostBackupManifest {
  const safeTaskId = assertSafeSegment(taskId, "taskId");
  const manifestPath = store.paths.backupManifest(safeTaskId);
  const raw = fs.readFileSync(manifestPath, "utf8");
  const parsedJson: unknown = JSON.parse(raw);
  return HostBackupManifestSchema.parse(parsedJson);
}

function writeHostBackupManifest(
  store: KilnStore,
  manifest: HostBackupManifest,
): HostBackupManifest {
  const validated = HostBackupManifestSchema.parse(manifest);
  const manifestPath = store.paths.backupManifest(validated.task_id);
  writeFileAtomic(manifestPath, `${JSON.stringify(validated, null, 2)}\n`);
  return validated;
}

function resolveValidatedStagedFile(
  stagedDir: string,
  canonicalStagedDir: string,
  stagedRelativePath: string,
): string {
  const normRel = normalizeRepoRelativePath(stagedRelativePath);
  const candidate = path.join(stagedDir, normRel);

  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Staged file does not exist: ${candidate}`);
    }
    throw err;
  }

  if (lstat.isSymbolicLink()) {
    const resolved = realpathCanonical(candidate);
    if (!isInsideCanonicalDir(resolved, canonicalStagedDir)) {
      throw new Error(
        `Staged file "${stagedRelativePath}" symlink escapes staged directory "${canonicalStagedDir}"`,
      );
    }
  }

  const canonicalFile = realpathCanonical(candidate);
  if (!isInsideCanonicalDir(canonicalFile, canonicalStagedDir)) {
    throw new Error(
      `Staged file "${stagedRelativePath}" escapes staged directory "${canonicalStagedDir}"`,
    );
  }
  if (!fs.statSync(canonicalFile).isFile()) {
    throw new Error(`Staged path "${stagedRelativePath}" must be a regular file`);
  }

  return canonicalFile;
}

function readHostFileIfRegular(canonicalTarget: string): Buffer | null {
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(canonicalTarget);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }

  if (lstat.isSymbolicLink()) {
    throw new Error(`Host target "${canonicalTarget}" is unexpectedly a symlink`);
  }
  if (!lstat.isFile()) {
    throw new Error(`Host target "${canonicalTarget}" exists and is not a regular file`);
  }
  return fs.readFileSync(canonicalTarget);
}

function rollbackFromBackupEntries(
  backupDir: string,
  entries: readonly HostBackupFileEntry[],
): void {
  for (const entry of entries) {
    if (entry.existed_before) {
      if (!entry.backup_relative_path) {
        throw new Error(
          `Missing backup_relative_path for pre-existing target "${entry.target_canonical_path}"`,
        );
      }
      const backupFilePath = path.join(backupDir, entry.backup_relative_path);
      const backupBytes = fs.readFileSync(backupFilePath);
      if (entry.pre_sha256 && sha256Buffer(backupBytes) !== entry.pre_sha256) {
        throw new Error(`Backup integrity check failed for "${entry.target_canonical_path}"`);
      }
      writeFileAtomic(entry.target_canonical_path, backupBytes);
      if (process.platform !== "win32" && entry.file_mode !== undefined) {
        fs.chmodSync(entry.target_canonical_path, entry.file_mode);
      }
    } else {
      fs.rmSync(entry.target_canonical_path, { force: true });
    }
  }
}

function summarizeContent(buf: Buffer | null, sha256: string | null): string {
  if (buf === null) {
    return "<missing>";
  }
  const text = buf.toString("utf8");
  const lines = text.split(/\r?\n/);
  const preview = lines.slice(0, 3).join(" | ").slice(0, 120);
  return `${buf.length} bytes, ${lines.length} lines (${sha256 ?? "unknown"}): ${preview}`;
}

interface UnifiedLineDiffOptions {
  fromLabel?: string;
  toLabel?: string;
  treatEmptyAsZeroLines?: boolean;
  maxOutputLines?: number;
}

function buildUnifiedLineDiffWithMeta(
  expectedText: string | null,
  actualText: string | null,
  options: UnifiedLineDiffOptions = {},
): { diff: string; truncated: boolean } {
  if (expectedText === null && actualText === null) {
    return {
      diff: "(both expected and actual contents unavailable)",
      truncated: false,
    };
  }

  const fromLabel = options.fromLabel ?? "expected (post_sha256)";
  const toLabel = options.toLabel ?? "actual (current)";
  const treatEmptyAsZeroLines = options.treatEmptyAsZeroLines ?? false;
  const splitLines = (text: string | null): string[] => {
    if (text === null) {
      return [];
    }
    if (treatEmptyAsZeroLines && text.length === 0) {
      return [];
    }
    return text.split(/\r?\n/);
  };

  const aLines = splitLines(expectedText);
  const bLines = splitLines(actualText);
  const hunkHeader =
    treatEmptyAsZeroLines && aLines.length === 0
      ? `@@ -0,0 +${bLines.length === 0 ? 0 : 1},${bLines.length} @@`
      : `@@ -1,${aLines.length} +1,${bLines.length} @@`;

  let lines: string[];
  let truncated = false;

  if (aLines.length > MAX_DIFF_LINES || bLines.length > MAX_DIFF_LINES) {
    truncated = true;
    const isDefaultLabels = options.fromLabel === undefined && options.toLabel === undefined;
    const beforeTailTag = isDefaultLabels ? "expected" : "before";
    const afterTailTag = isDefaultLabels ? "actual" : "after";
    lines = [
      `--- ${fromLabel}`,
      `+++ ${toLabel}`,
      hunkHeader,
      ...aLines.slice(0, 20).map((l) => `-${l}`),
      ...(aLines.length > 20 ? [`... (${aLines.length - 20} more ${beforeTailTag} lines)`] : []),
      ...bLines.slice(0, 20).map((l) => `+${l}`),
      ...(bLines.length > 20 ? [`... (${bLines.length - 20} more ${afterTailTag} lines)`] : []),
    ];
  } else {
    const m = aLines.length;
    const n = bLines.length;
    const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));

    for (let i = m - 1; i >= 0; i--) {
      const row = dp[i]!;
      const nextRow = dp[i + 1]!;
      for (let j = n - 1; j >= 0; j--) {
        if (aLines[i] === bLines[j]) {
          row[j] = 1 + nextRow[j + 1]!;
        } else {
          row[j] = Math.max(nextRow[j]!, row[j + 1]!);
        }
      }
    }

    const diffBody: string[] = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (aLines[i] === bLines[j]) {
        diffBody.push(` ${aLines[i]!}`);
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
        diffBody.push(`-${aLines[i]!}`);
        i++;
      } else {
        diffBody.push(`+${bLines[j]!}`);
        j++;
      }
    }
    while (i < m) {
      diffBody.push(`-${aLines[i]!}`);
      i++;
    }
    while (j < n) {
      diffBody.push(`+${bLines[j]!}`);
      j++;
    }

    lines = [`--- ${fromLabel}`, `+++ ${toLabel}`, hunkHeader, ...diffBody];
  }

  if (options.maxOutputLines !== undefined && lines.length > options.maxOutputLines) {
    const keepCount = Math.max(1, options.maxOutputLines - 1);
    const omitted = lines.length - keepCount;
    lines = [...lines.slice(0, keepCount), `... (${omitted} more diff lines omitted)`];
    truncated = true;
  }

  return {
    diff: lines.join("\n"),
    truncated,
  };
}

function buildUnifiedLineDiff(expectedText: string | null, actualText: string | null): string {
  return buildUnifiedLineDiffWithMeta(expectedText, actualText).diff;
}

type PreviewFileReadResult =
  | { ok: true; buffer: Buffer; bytesTruncated: boolean; isBinary: boolean }
  | { ok: false; reason: "missing" | "unreadable" };

function resolveCanonicalDirOptional(dirPath: string): string | null {
  try {
    const resolved = realpathCanonical(dirPath);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function readPreviewFileBounded(
  rootDir: string,
  canonicalRootDir: string | null,
  relativePath: string,
  maxBytes: number,
): PreviewFileReadResult {
  if (!canonicalRootDir) {
    return { ok: false, reason: "missing" };
  }

  let normRel: string;
  try {
    normRel = normalizeRepoRelativePath(relativePath);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const candidate = path.join(rootDir, normRel);
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(candidate);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { ok: false, reason: "missing" }
      : { ok: false, reason: "unreadable" };
  }

  let canonicalFile: string;
  try {
    canonicalFile = realpathCanonical(candidate);
  } catch (err) {
    if (!lstat.isSymbolicLink() && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "missing" };
    }
    return { ok: false, reason: "unreadable" };
  }

  if (!isInsideCanonicalDir(canonicalFile, canonicalRootDir)) {
    return { ok: false, reason: "unreadable" };
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(canonicalFile, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      return { ok: false, reason: "unreadable" };
    }
    const toRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.allocUnsafe(toRead);
    let totalRead = 0;
    while (totalRead < toRead) {
      const bytesRead = fs.readSync(fd, buffer, totalRead, toRead - totalRead, totalRead);
      if (bytesRead === 0) {
        break;
      }
      totalRead += bytesRead;
    }
    const slice = totalRead === buffer.length ? buffer : buffer.subarray(0, totalRead);
    return {
      ok: true,
      buffer: slice,
      bytesTruncated: stat.size > maxBytes,
      isBinary: slice.includes(0),
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error on read-only preview descriptor
      }
    }
  }
}

/**
 * Builds bounded per-file unified diffs between backed-up pre-apply originals and
 * staged host-scoped files while the task awaits human approval (`staged_awaiting_approval`).
 */
export function buildHostStagedDiffs(store: KilnStore, taskId: string): HostStagedDiffEntry[] {
  const safeTaskId = assertSafeSegment(taskId, "taskId");

  let manifest: HostBackupManifest;
  try {
    manifest = readHostBackupManifest(store, safeTaskId);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  if (manifest.task_id !== safeTaskId || manifest.status !== "staged_awaiting_approval") {
    return [];
  }

  const backupDir = store.paths.backupDir(safeTaskId);
  const stagedDir = store.paths.stagedDir(safeTaskId);
  const canonicalBackupDir = resolveCanonicalDirOptional(backupDir);
  const canonicalStagedDir = resolveCanonicalDirOptional(stagedDir);

  return manifest.files.map((entry) => {
    const afterRead = readPreviewFileBounded(
      stagedDir,
      canonicalStagedDir,
      entry.staged_relative_path,
      MAX_STAGED_PREVIEW_BYTES,
    );

    const beforeRead: PreviewFileReadResult = entry.existed_before
      ? entry.backup_relative_path
        ? readPreviewFileBounded(
            backupDir,
            canonicalBackupDir,
            entry.backup_relative_path,
            MAX_STAGED_PREVIEW_BYTES,
          )
        : { ok: false, reason: "missing" }
      : { ok: true, buffer: Buffer.alloc(0), bytesTruncated: false, isBinary: false };

    if ((beforeRead.ok && beforeRead.isBinary) || (afterRead.ok && afterRead.isBinary)) {
      return {
        targetPath: entry.target_canonical_path,
        existedBefore: entry.existed_before,
        preSha256: entry.pre_sha256,
        stagedSha256: entry.staged_sha256 ?? null,
        diff: "[binary file diff omitted]",
        truncated: false,
      };
    }

    if (!beforeRead.ok) {
      return {
        targetPath: entry.target_canonical_path,
        existedBefore: entry.existed_before,
        preSha256: entry.pre_sha256,
        stagedSha256: entry.staged_sha256 ?? null,
        diff: "[backup file unavailable]",
        truncated: false,
      };
    }

    if (!afterRead.ok) {
      return {
        targetPath: entry.target_canonical_path,
        existedBefore: entry.existed_before,
        preSha256: entry.pre_sha256,
        stagedSha256: entry.staged_sha256 ?? null,
        diff: "[staged file unavailable]",
        truncated: false,
      };
    }

    const beforeText = beforeRead.buffer.toString("utf8");
    const afterText = afterRead.buffer.toString("utf8");
    const diffResult = buildUnifiedLineDiffWithMeta(beforeText, afterText, {
      fromLabel: entry.existed_before ? `${entry.target_canonical_path} (before)` : "/dev/null",
      toLabel: `${entry.target_canonical_path} (staged)`,
      treatEmptyAsZeroLines: true,
      maxOutputLines: MAX_STAGED_DIFF_LINES,
    });

    return {
      targetPath: entry.target_canonical_path,
      existedBefore: entry.existed_before,
      preSha256: entry.pre_sha256,
      stagedSha256: entry.staged_sha256 ?? null,
      diff: diffResult.diff,
      truncated: beforeRead.bytesTruncated || afterRead.bytesTruncated || diffResult.truncated,
    };
  });
}

/**
 * Phase 1 of `host_scoped` delivery: validates staged sandbox files and canonical host
 * target whitelists, acquires exclusive cross-task `host_path_locks`, backs up pre-existing
 * host files with `pre_sha256`, and persists `manifest.json` (`staged_awaiting_approval`)
 * without modifying any host target file.
 */
export function stageHostScopedChanges(
  store: KilnStore,
  input: StageHostScopedChangesInput,
): StageHostScopedChangesResult {
  const taskId = assertSafeSegment(input.taskId, "taskId");
  const timestamp = input.now ?? new Date().toISOString();

  if (input.stagedFiles.length === 0) {
    throw new Error("stagedFiles cannot be empty");
  }

  const stagedDir = store.paths.stagedDir(taskId);
  if (!fs.existsSync(stagedDir) || !fs.statSync(stagedDir).isDirectory()) {
    throw new Error(`Staged directory does not exist for task "${taskId}": ${stagedDir}`);
  }
  const canonicalStagedDir = realpathCanonical(stagedDir);

  const resolvedItems: Array<{
    stagedRel: string;
    canonicalTarget: string;
    stagedSha: string;
  }> = [];
  const seenTargets = new Set<string>();

  for (const spec of input.stagedFiles) {
    const stagedRel = normalizeRepoRelativePath(spec.stagedRelativePath);
    const stagedFilePath = resolveValidatedStagedFile(stagedDir, canonicalStagedDir, stagedRel);
    const stagedSha = sha256Buffer(fs.readFileSync(stagedFilePath));

    const canonicalTarget = resolveCanonicalHostTarget(spec.targetPath);
    if (!isHostTargetWithinScope(canonicalTarget, input.contractScope)) {
      throw new Error(
        `Host target "${canonicalTarget}" (from "${spec.targetPath}") is outside contract.scope whitelist`,
      );
    }
    if (seenTargets.has(canonicalTarget)) {
      throw new Error(`Duplicate canonical host target "${canonicalTarget}" in stagedFiles`);
    }
    seenTargets.add(canonicalTarget);

    // Ensure any pre-existing target is a regular file (not a directory or symlink).
    readHostFileIfRegular(canonicalTarget);
    resolvedItems.push({ stagedRel, canonicalTarget, stagedSha });
  }

  const canonicalTargets = resolvedItems.map((item) => item.canonicalTarget);
  const lockResult = store.acquireHostPathLocks(taskId, canonicalTargets, timestamp);
  if (!lockResult.acquired) {
    return {
      ok: false,
      reason: "lock_conflict",
      conflicts: lockResult.conflicts,
    };
  }

  const backupDir = store.paths.backupDir(taskId);
  const backupFilesDir = path.join(backupDir, "files");

  try {
    fs.rmSync(backupFilesDir, { recursive: true, force: true });

    const manifestEntries: HostBackupFileEntry[] = [];
    for (let i = 0; i < resolvedItems.length; i++) {
      const item = resolvedItems[i]!;
      const existingBytes = readHostFileIfRegular(item.canonicalTarget);

      if (existingBytes !== null) {
        const preSha = sha256Buffer(existingBytes);
        const fileMode =
          process.platform !== "win32" ? fs.statSync(item.canonicalTarget).mode & 0o777 : undefined;
        const backupRelPath = `files/${String(i).padStart(4, "0")}.bak`;
        writeFileAtomic(path.join(backupDir, backupRelPath), existingBytes);
        manifestEntries.push({
          target_canonical_path: item.canonicalTarget,
          staged_relative_path: item.stagedRel,
          staged_sha256: item.stagedSha,
          backup_relative_path: backupRelPath,
          existed_before: true,
          pre_sha256: preSha,
          post_sha256: null,
          ...(fileMode !== undefined ? { file_mode: fileMode } : {}),
          updated_at: timestamp,
        });
      } else {
        manifestEntries.push({
          target_canonical_path: item.canonicalTarget,
          staged_relative_path: item.stagedRel,
          staged_sha256: item.stagedSha,
          backup_relative_path: null,
          existed_before: false,
          pre_sha256: null,
          post_sha256: null,
          updated_at: timestamp,
        });
      }
    }

    const manifest = writeHostBackupManifest(store, {
      schema_version: 1,
      task_id: taskId,
      status: "staged_awaiting_approval",
      files: manifestEntries,
      created_at: timestamp,
      updated_at: timestamp,
    });

    return {
      ok: true,
      requiresApproval: true,
      manifest,
    };
  } catch (err) {
    store.releaseHostPathLocks(taskId);
    throw err;
  }
}

/**
 * Phase 2 of `host_scoped` delivery: atomically writes approved staged files to
 * host target paths, records `post_sha256`, executes optional verification command,
 * automatically rolls back on verification failure, and releases `host_path_locks`.
 */
export async function applyApprovedHostScopedChanges(
  store: KilnStore,
  input: ApplyApprovedHostScopedChangesInput,
): Promise<ApplyApprovedHostScopedChangesResult> {
  const taskId = assertSafeSegment(input.taskId, "taskId");
  const timestamp = input.now ?? new Date().toISOString();
  const manifest = readHostBackupManifest(store, taskId);

  if (manifest.task_id !== taskId) {
    throw new Error(`Backup manifest task_id "${manifest.task_id}" does not match "${taskId}"`);
  }
  if (manifest.status !== "staged_awaiting_approval") {
    throw new Error(
      `Cannot apply host-scoped changes for task "${taskId}": manifest status is "${manifest.status}", expected "staged_awaiting_approval"`,
    );
  }

  if (input.approved !== true) {
    return {
      ok: false,
      reason: "not_approved",
      manifest,
    };
  }

  const canonicalTargets = manifest.files.map((entry) => {
    const reCanonicalized = resolveCanonicalHostTarget(entry.target_canonical_path);
    if (reCanonicalized !== entry.target_canonical_path) {
      throw new Error(
        `Target path "${entry.target_canonical_path}" changed canonical resolution to "${reCanonicalized}"`,
      );
    }
    return reCanonicalized;
  });

  const lockResult = store.acquireHostPathLocks(taskId, canonicalTargets, timestamp);
  if (!lockResult.acquired) {
    return {
      ok: false,
      reason: "lock_conflict",
      conflicts: lockResult.conflicts,
    };
  }

  const stagedDir = store.paths.stagedDir(taskId);
  const canonicalStagedDir = realpathCanonical(stagedDir);
  const backupDir = store.paths.backupDir(taskId);
  let shouldReleaseLocks = false;

  try {
    // Verify staged/ anti-tamper SHA-256 and pre-apply TOCTOU integrity before modifying any host file.
    const stagedConflicts: HostStagedHashConflict[] = [];
    const preConflicts: HostPreHashConflict[] = [];
    const stagedPayload: Array<{ entry: HostBackupFileEntry; bytes: Buffer; postSha: string }> = [];

    for (const entry of manifest.files) {
      const stagedPath = resolveValidatedStagedFile(
        stagedDir,
        canonicalStagedDir,
        entry.staged_relative_path,
      );
      const stagedBytes = fs.readFileSync(stagedPath);
      const actualStagedSha = sha256Buffer(stagedBytes);
      if (entry.staged_sha256 !== undefined && actualStagedSha !== entry.staged_sha256) {
        stagedConflicts.push({
          stagedRelativePath: entry.staged_relative_path,
          targetCanonicalPath: entry.target_canonical_path,
          expectedStagedSha256: entry.staged_sha256,
          actualStagedSha256: actualStagedSha,
        });
      }

      const currentBytes = readHostFileIfRegular(entry.target_canonical_path);
      const currentSha = currentBytes !== null ? sha256Buffer(currentBytes) : null;

      if (entry.existed_before) {
        if (currentSha !== entry.pre_sha256) {
          preConflicts.push({
            targetCanonicalPath: entry.target_canonical_path,
            expectedPreSha256: entry.pre_sha256,
            actualSha256: currentSha,
          });
        }
      } else if (currentBytes !== null) {
        preConflicts.push({
          targetCanonicalPath: entry.target_canonical_path,
          expectedPreSha256: null,
          actualSha256: currentSha,
        });
      }

      stagedPayload.push({
        entry,
        bytes: stagedBytes,
        postSha: actualStagedSha,
      });
    }

    if (stagedConflicts.length > 0) {
      return {
        ok: false,
        reason: "staged_hash_mismatch",
        conflicts: stagedConflicts,
        manifest,
      };
    }

    if (preConflicts.length > 0) {
      return {
        ok: false,
        reason: "pre_hash_mismatch",
        conflicts: preConflicts,
        manifest,
      };
    }

    const appliedEntries: HostBackupFileEntry[] = [];
    try {
      for (const item of stagedPayload) {
        writeFileAtomic(item.entry.target_canonical_path, item.bytes);
        if (process.platform !== "win32" && item.entry.file_mode !== undefined) {
          fs.chmodSync(item.entry.target_canonical_path, item.entry.file_mode);
        }
        appliedEntries.push({
          ...item.entry,
          post_sha256: item.postSha,
          updated_at: timestamp,
        });
      }
    } catch (writeErr) {
      rollbackFromBackupEntries(backupDir, manifest.files);
      writeHostBackupManifest(store, {
        ...manifest,
        status: "rolled_back",
        files: manifest.files.map((f) => ({
          ...f,
          post_sha256: null,
          updated_at: timestamp,
        })),
        updated_at: timestamp,
      });
      shouldReleaseLocks = true;
      throw writeErr;
    }

    const defaultCmdCwd = fs.existsSync(store.paths.workspaceDir(taskId))
      ? store.paths.workspaceDir(taskId)
      : path.dirname(manifest.files[0]!.target_canonical_path);

    let postApplyResult: IsolatedCommandResult | null = null;
    if (input.postApplyCmd !== undefined && input.postApplyCmd.trim().length > 0) {
      try {
        postApplyResult = await runIsolatedCommand(input.postApplyCmd, {
          cwd: input.postApplyCwd ?? defaultCmdCwd,
          timeoutMs: input.postApplyTimeoutMs ?? input.verifyTimeoutMs,
          maxOutputBytes: input.maxOutputBytes,
          env: input.env,
          extraSafeEnv: input.extraSafeEnv,
          signal: input.signal,
        });
      } catch (execErr) {
        rollbackFromBackupEntries(backupDir, manifest.files);
        writeHostBackupManifest(store, {
          ...manifest,
          status: "rolled_back",
          files: manifest.files.map((f) => ({
            ...f,
            post_sha256: null,
            updated_at: timestamp,
          })),
          updated_at: timestamp,
        });
        shouldReleaseLocks = true;
        throw execErr;
      }

      if (postApplyResult.exitCode !== 0 || postApplyResult.timedOut) {
        rollbackFromBackupEntries(backupDir, manifest.files);
        const rolledBackManifest = writeHostBackupManifest(store, {
          ...manifest,
          status: "rolled_back",
          files: manifest.files.map((f) => ({
            ...f,
            post_sha256: null,
            updated_at: timestamp,
          })),
          updated_at: timestamp,
        });
        shouldReleaseLocks = true;
        return {
          ok: false,
          reason: "deliver_cmd_failed_rolled_back",
          postApplyResult,
          manifest: rolledBackManifest,
        };
      }
    }

    let verifyResult: IsolatedCommandResult | null = null;
    if (input.verifyCmd !== undefined && input.verifyCmd.trim().length > 0) {
      try {
        verifyResult = await runIsolatedCommand(input.verifyCmd, {
          cwd: input.verifyCwd ?? defaultCmdCwd,
          timeoutMs: input.verifyTimeoutMs,
          maxOutputBytes: input.maxOutputBytes,
          env: input.env,
          extraSafeEnv: input.extraSafeEnv,
          signal: input.signal,
        });
      } catch (execErr) {
        rollbackFromBackupEntries(backupDir, manifest.files);
        writeHostBackupManifest(store, {
          ...manifest,
          status: "rolled_back",
          files: manifest.files.map((f) => ({
            ...f,
            post_sha256: null,
            updated_at: timestamp,
          })),
          updated_at: timestamp,
        });
        shouldReleaseLocks = true;
        throw execErr;
      }

      if (verifyResult.exitCode !== 0 || verifyResult.timedOut) {
        rollbackFromBackupEntries(backupDir, manifest.files);
        const rolledBackManifest = writeHostBackupManifest(store, {
          ...manifest,
          status: "rolled_back",
          files: manifest.files.map((f) => ({
            ...f,
            post_sha256: null,
            updated_at: timestamp,
          })),
          updated_at: timestamp,
        });
        shouldReleaseLocks = true;
        return {
          ok: false,
          reason: "verify_failed_rolled_back",
          verifyResult,
          manifest: rolledBackManifest,
        };
      }
    }

    const finalEntries: HostBackupFileEntry[] =
      postApplyResult !== null
        ? appliedEntries.map((entry) => {
            const finalBytes = readHostFileIfRegular(entry.target_canonical_path);
            return {
              ...entry,
              post_sha256: finalBytes !== null ? sha256Buffer(finalBytes) : null,
              updated_at: timestamp,
            };
          })
        : appliedEntries;

    const appliedManifest = writeHostBackupManifest(store, {
      ...manifest,
      status: "applied",
      files: finalEntries,
      updated_at: timestamp,
    });
    shouldReleaseLocks = true;

    return {
      ok: true,
      postApplyResult,
      verifyResult,
      manifest: appliedManifest,
    };
  } finally {
    if (shouldReleaseLocks) {
      store.releaseHostPathLocks(taskId);
    }
  }
}

/**
 * Restores host files from backup only after verifying every target's current SHA256
 * equals `post_sha256`. On any external modification, refuses to overwrite and returns
 * HTTP-style `409 hash_mismatch` with per-file summaries and unified line diffs.
 */
export function restoreHostScopedBackup(
  store: KilnStore,
  input: RestoreHostScopedBackupInput,
): RestoreHostScopedBackupResult {
  const taskId = assertSafeSegment(input.taskId, "taskId");
  const timestamp = input.now ?? new Date().toISOString();
  const manifest = readHostBackupManifest(store, taskId);

  if (manifest.task_id !== taskId) {
    throw new Error(`Backup manifest task_id "${manifest.task_id}" does not match "${taskId}"`);
  }
  if (manifest.status !== "applied") {
    throw new Error(
      `Cannot restore backup for task "${taskId}": manifest status is "${manifest.status}", expected "applied"`,
    );
  }

  const canonicalTargets = manifest.files.map((entry) => {
    const reCanonicalized = resolveCanonicalHostTarget(entry.target_canonical_path);
    if (reCanonicalized !== entry.target_canonical_path) {
      throw new Error(
        `Target path "${entry.target_canonical_path}" changed canonical resolution to "${reCanonicalized}"`,
      );
    }
    return reCanonicalized;
  });

  const lockResult = store.acquireHostPathLocks(taskId, canonicalTargets, timestamp);
  if (!lockResult.acquired) {
    return {
      ok: false,
      statusCode: 409,
      reason: "lock_conflict",
      conflicts: lockResult.conflicts,
    };
  }

  const stagedDir = store.paths.stagedDir(taskId);
  const backupDir = store.paths.backupDir(taskId);

  try {
    const conflicts: HostRestoreHashConflict[] = [];

    for (const entry of manifest.files) {
      const currentBytes = readHostFileIfRegular(entry.target_canonical_path);
      const actualSha = currentBytes !== null ? sha256Buffer(currentBytes) : null;

      if (actualSha !== entry.post_sha256) {
        let expectedBytes: Buffer | null = null;
        const stagedCandidate = path.join(stagedDir, entry.staged_relative_path);
        if (fs.existsSync(stagedCandidate) && fs.statSync(stagedCandidate).isFile()) {
          const candidateBytes = fs.readFileSync(stagedCandidate);
          if (sha256Buffer(candidateBytes) === entry.post_sha256) {
            expectedBytes = candidateBytes;
          }
        }

        const expectedText = expectedBytes !== null ? expectedBytes.toString("utf8") : null;
        const actualText = currentBytes !== null ? currentBytes.toString("utf8") : null;

        conflicts.push({
          targetCanonicalPath: entry.target_canonical_path,
          expectedPostSha256: entry.post_sha256,
          actualSha256: actualSha,
          expectedSummary: summarizeContent(expectedBytes, entry.post_sha256),
          actualSummary: summarizeContent(currentBytes, actualSha),
          diff: buildUnifiedLineDiff(expectedText, actualText),
        });
      }
    }

    if (conflicts.length > 0) {
      return {
        ok: false,
        statusCode: 409,
        reason: "hash_mismatch",
        conflicts,
      };
    }

    rollbackFromBackupEntries(backupDir, manifest.files);

    const restoredManifest = writeHostBackupManifest(store, {
      ...manifest,
      status: "restored",
      files: manifest.files.map((entry) => ({
        ...entry,
        updated_at: timestamp,
      })),
      updated_at: timestamp,
    });

    return {
      ok: true,
      statusCode: 200,
      manifest: restoredManifest,
    };
  } finally {
    store.releaseHostPathLocks(taskId);
  }
}
