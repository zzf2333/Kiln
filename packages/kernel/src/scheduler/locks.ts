import fs from "node:fs";
import path from "node:path";
import type { TaskCard } from "@kiln/protocol";
import { isHostTargetWithinScope, resolveCanonicalHostTarget } from "../gate/host-scoped.js";
import { normalizeRepoRelativePath } from "../gate/scope.js";
import { HostBackupManifestSchema } from "../store/backup-manifest.js";
import type { KilnStore } from "../store/kiln-store.js";
import type { HostPathLockRow } from "../store/sqlite.js";

const MAX_BRACE_EXPANSIONS = 256;
const MAX_TIMEOUT_MS = 2_147_483_647;

function expandBraces(pattern: string): string[] {
  const openIdx = pattern.indexOf("{");
  if (openIdx === -1) {
    return [pattern];
  }

  let depth = 0;
  let closeIdx = -1;
  const commaIndices: number[] = [];

  for (let i = openIdx; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    } else if (ch === "," && depth === 1) {
      commaIndices.push(i);
    }
  }

  if (closeIdx === -1 || commaIndices.length === 0) {
    return [pattern];
  }

  const prefix = pattern.slice(0, openIdx);
  const suffix = pattern.slice(closeIdx + 1);
  const innerParts: string[] = [];
  let start = openIdx + 1;
  for (const comma of commaIndices) {
    innerParts.push(pattern.slice(start, comma));
    start = comma + 1;
  }
  innerParts.push(pattern.slice(start, closeIdx));

  const results: string[] = [];
  for (const part of innerParts) {
    const expandedSuffixes = expandBraces(part + suffix);
    for (const expanded of expandedSuffixes) {
      results.push(prefix + expanded);
      if (results.length > MAX_BRACE_EXPANSIONS) {
        throw new Error(`Glob pattern "${pattern}" exceeds maximum brace expansion limit`);
      }
    }
  }

  return results;
}

function collapseDoubleStars(segments: readonly string[]): string[] {
  const collapsed: string[] = [];
  for (const seg of segments) {
    if (seg === "**" && collapsed.at(-1) === "**") {
      continue;
    }
    collapsed.push(seg);
  }
  return collapsed;
}

function hasGlobSyntax(pattern: string): boolean {
  return /[*?{}]/.test(pattern);
}

function isGlobalWildcardSegments(segments: readonly string[]): boolean {
  if (segments.length === 0) {
    return true;
  }
  if (segments.length === 1) {
    return segments[0] === "**" || segments[0] === "*";
  }
  return segments.length === 2 && segments[0] === "**" && segments[1] === "*";
}

function isBlankOrRootDot(rawPattern: string): boolean {
  const posix = rawPattern.replace(/\\/g, "/").trim();
  if (posix.length === 0 || posix === "/") {
    return true;
  }
  const meaningful = posix.split("/").filter((seg) => seg.length > 0 && seg !== ".");
  return meaningful.length === 0;
}

/**
 * Compiles one raw scope pattern into normalized segment sequences.
 * Returns `null` when the pattern is a global wildcard (empty, `.`, `*`, `**`, or recursive all-files).
 *
 * Trailing `**` (which requires `>= 1` segment in `gate/scope.ts`) is rewritten to `["*", "**"]`
 * where `"**"` inside the compiled array denotes `0` or more segments, keeping DP uniform.
 */
function compilePatternAlternatives(rawPattern: string): string[][] | null {
  if (isBlankOrRootDot(rawPattern)) {
    return null;
  }

  const expandedList = expandBraces(rawPattern);
  const alternatives: string[][] = [];

  for (const expanded of expandedList) {
    if (isBlankOrRootDot(expanded)) {
      return null;
    }

    const posix = expanded.replace(/\\/g, "/");
    const isDirectoryOnly = posix.endsWith("/");
    const normalized = normalizeRepoRelativePath(posix);
    const hasGlob = hasGlobSyntax(normalized);
    const segs = collapseDoubleStars(
      normalized.split("/").filter((s) => s.length > 0 && s !== "."),
    );

    if (isGlobalWildcardSegments(segs)) {
      return null;
    }

    if (!hasGlob) {
      if (isDirectoryOnly) {
        alternatives.push([...segs, "*", "**"]);
      } else {
        // Literal paths in `gate/scope.ts` match both the exact path and any descendant under it.
        alternatives.push(segs);
        alternatives.push([...segs, "*", "**"]);
      }
      continue;
    }

    if (segs.at(-1) === "**") {
      alternatives.push([...segs.slice(0, -1), "*", "**"]);
    } else {
      alternatives.push(segs);
    }
  }

  return alternatives;
}

function segmentsCanIntersect(segA: string, segB: string): boolean {
  if (segA === segB || segA === "*" || segB === "*") {
    return true;
  }
  if (!/[*?]/.test(segA) && !/[*?]/.test(segB)) {
    return false;
  }

  const lenA = segA.length;
  const lenB = segB.length;
  const memo = new Map<number, boolean>();
  const strideB = lenB + 1;

  const visit = (i: number, j: number, hasChar: boolean): boolean => {
    if (i === lenA && j === lenB) {
      return hasChar;
    }

    const key = ((i * strideB + j) << 1) | (hasChar ? 1 : 0);
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const aStar = i < lenA && segA[i] === "*";
    const bStar = j < lenB && segB[j] === "*";
    let result = false;

    if (aStar && bStar) {
      result =
        visit(i + 1, j, hasChar) ||
        visit(i, j + 1, hasChar) ||
        (!hasChar && visit(i, j, true));
    } else if (aStar) {
      result = visit(i + 1, j, hasChar) || (j < lenB && visit(i, j + 1, true));
    } else if (bStar) {
      result = visit(i, j + 1, hasChar) || (i < lenA && visit(i + 1, j, true));
    } else if (i < lenA && j < lenB) {
      const chA = segA[i]!;
      const chB = segB[j]!;
      if (chA === "?" || chB === "?" || chA === chB) {
        result = visit(i + 1, j + 1, true);
      }
    }

    memo.set(key, result);
    return result;
  };

  return visit(0, 0, false);
}

function compiledSequencesOverlap(
  segsA: readonly string[],
  segsB: readonly string[],
): boolean {
  const lenA = segsA.length;
  const lenB = segsB.length;
  const memo = new Map<number, boolean>();
  const stride = lenB + 1;

  const visit = (i: number, j: number): boolean => {
    if (i === lenA && j === lenB) {
      return true;
    }

    const key = i * stride + j;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }

    let result = false;
    if (i < lenA && segsA[i] === "**") {
      result = visit(i + 1, j) || (j < lenB && visit(i, j + 1));
    } else if (j < lenB && segsB[j] === "**") {
      result = visit(i, j + 1) || (i < lenA && visit(i + 1, j));
    } else if (i < lenA && j < lenB && segmentsCanIntersect(segsA[i]!, segsB[j]!)) {
      result = visit(i + 1, j + 1);
    }

    memo.set(key, result);
    return result;
  };

  return visit(0, 0);
}

/**
 * Conservative write-scope overlap check for two `git_worktree` tasks in the same `space`.
 * Returns `true` whenever both scopes can match a common path (or either side is empty/global),
 * while returning `false` for disjoint directories or files (enabling same-repo parallelism).
 */
export function scopesOverlap(
  scopeA: readonly string[],
  scopeB: readonly string[],
): boolean {
  if (scopeA.length === 0 || scopeB.length === 0) {
    return true;
  }

  const compiledA: string[][] = [];
  for (const raw of scopeA) {
    const alts = compilePatternAlternatives(raw);
    if (alts === null) {
      return true;
    }
    compiledA.push(...alts);
  }

  const compiledB: string[][] = [];
  for (const raw of scopeB) {
    const alts = compilePatternAlternatives(raw);
    if (alts === null) {
      return true;
    }
    compiledB.push(...alts);
  }

  for (const seqA of compiledA) {
    for (const seqB of compiledB) {
      if (compiledSequencesOverlap(seqA, seqB)) {
        return true;
      }
    }
  }

  return false;
}

export interface HostScopeParticipant {
  taskId: string;
  scope: readonly string[];
  plannedCanonicalPaths: readonly string[];
}

function safeResolveCanonicalHostTarget(targetPath: string): string {
  try {
    return resolveCanonicalHostTarget(targetPath);
  } catch {
    return targetPath;
  }
}

function isWindowsDriveOrUncPattern(rawPattern: string): boolean {
  return (
    rawPattern.startsWith("\\\\") ||
    rawPattern.startsWith("//") ||
    /^[a-zA-Z]:(?:[\\/]|$)/.test(rawPattern)
  );
}

function isAbsoluteOrHomePattern(rawPattern: string): boolean {
  return (
    rawPattern.startsWith("/") ||
    rawPattern === "~" ||
    rawPattern.startsWith("~/") ||
    rawPattern.startsWith("~\\") ||
    isWindowsDriveOrUncPattern(rawPattern)
  );
}

function hostPathToScopeComparable(absPathPosix: string): string {
  const driveMatch = /^([a-zA-Z]):(?:\/(.*))?$/.exec(absPathPosix);
  if (driveMatch) {
    const drive = driveMatch[1]!.toLowerCase();
    const rest = (driveMatch[2] ?? "").replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
    return rest.length > 0 ? `__win_drive_${drive}/${rest}` : `__win_drive_${drive}`;
  }
  if (absPathPosix.startsWith("//")) {
    const rest = absPathPosix.replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
    return rest.length > 0 ? `__win_unc/${rest}` : "__win_unc";
  }
  return absPathPosix.replace(/^\/+/, "").replace(/\/+$/, "");
}

function resolveHostPrefixToComparable(rawPrefix: string): string {
  if (process.platform !== "win32" && isWindowsDriveOrUncPattern(rawPrefix)) {
    const posix = rawPrefix.replace(/\\/g, "/");
    const unc = posix.startsWith("//");
    const normalized = unc
      ? `//${path.posix.normalize(posix.slice(2)).replace(/^\/+/, "")}`
      : path.posix.normalize(posix);
    return hostPathToScopeComparable(normalized);
  }
  return hostPathToScopeComparable(resolveCanonicalHostTarget(rawPrefix).replace(/\\/g, "/"));
}

function normalizeHostPatternToScopeComparable(rawPattern: string): string | null {
  const posix = rawPattern.replace(/\\/g, "/");
  const trailingSlash = posix.endsWith("/");
  if (!isAbsoluteOrHomePattern(rawPattern)) {
    return posix;
  }

  try {
    if (!hasGlobSyntax(rawPattern)) {
      const trimmed = resolveHostPrefixToComparable(rawPattern);
      if (trimmed.length === 0) {
        return "**";
      }
      return trailingSlash ? `${trimmed}/` : trimmed;
    }

    const winDrive = isWindowsDriveOrUncPattern(rawPattern) && /^[a-zA-Z]:(?:\/|$)/.test(posix);
    const uncPath = posix.startsWith("//");

    if (winDrive) {
      const match = /^([a-zA-Z]:)(?:\/(.*))?$/.exec(posix)!;
      const drivePrefix = match[1]!;
      const restSegs = (match[2] ?? "").split("/").filter((s) => s.length > 0 && s !== ".");
      const firstGlobIdx = restSegs.findIndex((seg) => hasGlobSyntax(seg));
      if (firstGlobIdx === -1) {
        const trimmed = resolveHostPrefixToComparable(rawPattern);
        return trimmed.length === 0 ? "**" : trailingSlash ? `${trimmed}/` : trimmed;
      }
      const prefixComparable =
        firstGlobIdx === 0
          ? `__win_drive_${drivePrefix[0]!.toLowerCase()}`
          : resolveHostPrefixToComparable(`${drivePrefix}/${restSegs.slice(0, firstGlobIdx).join("/")}`);
      const tail = restSegs.slice(firstGlobIdx).join("/").toLowerCase();
      const combined = tail ? `${prefixComparable}/${tail}` : prefixComparable;
      return trailingSlash ? `${combined}/` : combined;
    }

    if (uncPath) {
      const restSegs = posix.slice(2).split("/").filter((s) => s.length > 0 && s !== ".");
      const firstGlobIdx = restSegs.findIndex((seg) => hasGlobSyntax(seg));
      if (firstGlobIdx === -1) {
        const trimmed = resolveHostPrefixToComparable(rawPattern);
        return trimmed.length === 0 ? "**" : trailingSlash ? `${trimmed}/` : trimmed;
      }
      const prefixComparable =
        firstGlobIdx === 0
          ? "__win_unc"
          : resolveHostPrefixToComparable(`//${restSegs.slice(0, firstGlobIdx).join("/")}`);
      const tail = restSegs.slice(firstGlobIdx).join("/").toLowerCase();
      const combined = tail ? `${prefixComparable}/${tail}` : prefixComparable;
      return trailingSlash ? `${combined}/` : combined;
    }

    const segments = posix.split("/").filter((s) => s.length > 0 && s !== ".");
    const firstGlobIdx = segments.findIndex((seg) => hasGlobSyntax(seg));
    if (firstGlobIdx <= 0) {
      const joined = segments.join("/");
      return joined.length === 0 ? "**" : trailingSlash ? `${joined}/` : joined;
    }

    const prefixRaw = posix.startsWith("~")
      ? segments.slice(0, firstGlobIdx).join("/")
      : `/${segments.slice(0, firstGlobIdx).join("/")}`;
    const canonicalPrefix = resolveHostPrefixToComparable(prefixRaw);
    const tail = segments.slice(firstGlobIdx).join("/");
    const combined = canonicalPrefix ? `${canonicalPrefix}/${tail}` : tail;
    return trailingSlash ? `${combined}/` : combined;
  } catch {
    return null;
  }
}

function canonicalHostTargetMatchesScope(
  canonicalTarget: string,
  scope: readonly string[],
): boolean {
  if (scope.length === 0) {
    return true;
  }
  const candidates = [canonicalTarget, safeResolveCanonicalHostTarget(canonicalTarget)];
  for (const pattern of scope) {
    if (!isAbsoluteOrHomePattern(pattern)) {
      const normTarget = hostPathToScopeComparable(canonicalTarget.replace(/\\/g, "/"));
      if (scopesOverlap([normTarget], [pattern])) {
        return true;
      }
      continue;
    }
    if (
      process.platform !== "win32" &&
      (isWindowsDriveOrUncPattern(pattern) || isWindowsDriveOrUncPattern(canonicalTarget))
    ) {
      const normTarget = resolveHostPrefixToComparable(canonicalTarget);
      const normPattern = normalizeHostPatternToScopeComparable(pattern);
      if (normPattern === null || scopesOverlap([normTarget], [normPattern])) {
        return true;
      }
      continue;
    }
    for (const candidate of candidates) {
      try {
        if (isHostTargetWithinScope(candidate, [pattern])) {
          return true;
        }
      } catch {
        // Conservative fallback if pattern cannot be resolved safely
        return true;
      }
    }
  }
  return false;
}

/**
 * Extracts explicit planned canonical host paths for a `host_scoped` task from:
 * 1) caller-supplied `resolveHostTargetPaths` hook, or
 * 2) persisted `backups/<taskId>/manifest.json`.
 * Returns `[]` when concrete files are not yet staged (falling back to `contract.scope`).
 */
export function resolveTaskPlannedHostPaths(
  card: TaskCard,
  store: KilnStore,
  customResolver?: (card: TaskCard, store: KilnStore) => readonly string[],
): string[] {
  if (customResolver) {
    return Array.from(
      new Set(customResolver(card, store).map((p) => safeResolveCanonicalHostTarget(p))),
    );
  }

  const manifestPath = store.paths.backupManifest(card.id);
  if (fs.existsSync(manifestPath)) {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const manifest = HostBackupManifestSchema.parse(JSON.parse(raw) as unknown);
    return manifest.files.map((entry) => entry.target_canonical_path);
  }

  return [];
}

/**
 * Checks whether a candidate `host_scoped` task conflicts with existing SQLite
 * `host_path_locks` or other active `host_scoped` tasks (including pre-staged/in-flight ones).
 */
export function hasHostScopedConflict(
  candidate: HostScopeParticipant,
  existingSqlLocks: readonly HostPathLockRow[],
  activeParticipants: readonly HostScopeParticipant[],
): boolean {
  const candidateHasConcrete = candidate.plannedCanonicalPaths.length > 0;
  const candidateConcreteSet = new Set(candidate.plannedCanonicalPaths);

  for (const lock of existingSqlLocks) {
    if (lock.task_id === candidate.taskId) {
      continue;
    }
    const canonicalLockPath = safeResolveCanonicalHostTarget(lock.canonical_path);
    if (candidateHasConcrete) {
      if (
        candidateConcreteSet.has(lock.canonical_path) ||
        candidateConcreteSet.has(canonicalLockPath)
      ) {
        return true;
      }
    } else if (canonicalHostTargetMatchesScope(canonicalLockPath, candidate.scope)) {
      return true;
    }
  }

  for (const active of activeParticipants) {
    if (active.taskId === candidate.taskId) {
      continue;
    }
    const activeHasConcrete = active.plannedCanonicalPaths.length > 0;

    if (candidateHasConcrete && activeHasConcrete) {
      for (const target of candidate.plannedCanonicalPaths) {
        if (
          active.plannedCanonicalPaths.includes(target) ||
          active.plannedCanonicalPaths.includes(safeResolveCanonicalHostTarget(target))
        ) {
          return true;
        }
      }
      continue;
    }

    if (candidateHasConcrete) {
      if (
        candidate.plannedCanonicalPaths.some((p) =>
          canonicalHostTargetMatchesScope(p, active.scope),
        )
      ) {
        return true;
      }
      continue;
    }

    if (activeHasConcrete) {
      if (
        active.plannedCanonicalPaths.some((p) =>
          canonicalHostTargetMatchesScope(p, candidate.scope),
        )
      ) {
        return true;
      }
      continue;
    }

    if (candidate.scope.length === 0 || active.scope.length === 0) {
      return true;
    }

    const normA = candidate.scope.map(normalizeHostPatternToScopeComparable);
    const normB = active.scope.map(normalizeHostPatternToScopeComparable);
    if (normA.some((x) => x === null) || normB.some((x) => x === null)) {
      return true;
    }
    if (scopesOverlap(normA as string[], normB as string[])) {
      return true;
    }
  }

  return false;
}

export interface RateLimitKey {
  backendId?: string;
  agent: string;
  model: string;
}

export interface RateLimitEntry {
  backendId?: string;
  agent: string;
  model: string;
  cooldownUntilMs: number;
}

function normalizeRateLimitKey(key: RateLimitKey): {
  storageKey: string;
  backendId?: string;
  agent: string;
  model: string;
} {
  const agent = key.agent.trim();
  const model = key.model.trim();
  if (agent.length === 0) {
    throw new Error("RateLimitKey.agent must be a non-empty string");
  }
  if (model.length === 0) {
    throw new Error("RateLimitKey.model must be a non-empty string");
  }

  let backendId: string | undefined;
  if (key.backendId !== undefined) {
    const trimmed = key.backendId.trim();
    if (trimmed.length === 0) {
      throw new Error("RateLimitKey.backendId cannot be empty when specified");
    }
    backendId = trimmed;
  }

  const storageKey = `${backendId ?? "*"}::${agent}::${model}`;
  return {
    storageKey,
    ...(backendId !== undefined ? { backendId } : {}),
    agent,
    model,
  };
}

function matchesRateLimitKey(
  entry: RateLimitEntry,
  query: { backendId?: string; agent: string; model: string },
): boolean {
  if (entry.agent !== query.agent || entry.model !== query.model) {
    return false;
  }
  if (entry.backendId === undefined || query.backendId === undefined) {
    return true;
  }
  return entry.backendId === query.backendId;
}

/**
 * Tracks rate-limit cooldown deadlines keyed by `(backendId, agent, model)`
 * (or wildcard `(agent, model)` when `backendId` is omitted).
 * Rate limits only defer scheduling and NEVER increment stage retries or breaker counters.
 */
export class RateLimitTracker {
  private readonly entries = new Map<string, RateLimitEntry>();

  markRateLimited(
    key: RateLimitKey,
    retryAfterMs: number,
    nowMs: number = Date.now(),
  ): number {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
      throw new RangeError(
        `retryAfterMs must be a non-negative finite number, got: ${retryAfterMs}`,
      );
    }
    if (!Number.isFinite(nowMs)) {
      throw new RangeError(`nowMs must be a finite number, got: ${nowMs}`);
    }

    const normalized = normalizeRateLimitKey(key);
    const candidateDeadline = nowMs + retryAfterMs;
    const existing = this.entries.get(normalized.storageKey);
    const cooldownUntilMs = existing
      ? Math.max(existing.cooldownUntilMs, candidateDeadline)
      : candidateDeadline;

    this.entries.set(normalized.storageKey, {
      ...(normalized.backendId !== undefined ? { backendId: normalized.backendId } : {}),
      agent: normalized.agent,
      model: normalized.model,
      cooldownUntilMs,
    });

    return cooldownUntilMs;
  }

  getCooldownUntil(key: RateLimitKey, nowMs: number = Date.now()): number | null {
    const query = normalizeRateLimitKey(key);
    let maxDeadline: number | null = null;

    for (const entry of this.entries.values()) {
      if (entry.cooldownUntilMs <= nowMs) {
        continue;
      }
      if (!matchesRateLimitKey(entry, query)) {
        continue;
      }
      if (maxDeadline === null || entry.cooldownUntilMs > maxDeadline) {
        maxDeadline = entry.cooldownUntilMs;
      }
    }

    return maxDeadline;
  }

  isCoolingDown(key: RateLimitKey, nowMs: number = Date.now()): boolean {
    return this.getCooldownUntil(key, nowMs) !== null;
  }

  nextCooldownExpiryMs(nowMs: number = Date.now()): number | null {
    let earliest: number | null = null;
    for (const entry of this.entries.values()) {
      if (entry.cooldownUntilMs <= nowMs) {
        continue;
      }
      if (earliest === null || entry.cooldownUntilMs < earliest) {
        earliest = entry.cooldownUntilMs;
      }
    }
    return earliest;
  }

  pruneExpired(nowMs: number = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.cooldownUntilMs <= nowMs) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  listActive(nowMs: number = Date.now()): RateLimitEntry[] {
    const active: RateLimitEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.cooldownUntilMs > nowMs) {
        active.push({ ...entry });
      }
    }
    active.sort((a, b) => a.cooldownUntilMs - b.cooldownUntilMs);
    return active;
  }

  clear(): void {
    this.entries.clear();
  }
}

export function clampTimerDelayMs(delayMs: number): number {
  return Math.min(Math.max(1, Math.ceil(delayMs)), MAX_TIMEOUT_MS);
}
