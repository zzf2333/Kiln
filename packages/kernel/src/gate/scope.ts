import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WorkspaceMode } from "@kiln/protocol";
import { realpathCanonical } from "../store/fs-atomic.js";

export interface ScopeCheckResult {
  ok: boolean;
  outOfScopePaths: string[];
}

export interface FrozenFileEntry {
  path: string;
  exists: boolean;
  sha256: string | null;
}

export interface FrozenSnapshot {
  hash: string;
  acceptCmd: string;
  files: FrozenFileEntry[];
}

export interface DetectFrozenFilesChangedInput {
  rootDir: string;
  freezePatterns: readonly string[];
  acceptCmd: string;
  baselineHash: string;
  changedPaths?: readonly string[];
  baselineSnapshot?: FrozenSnapshot;
}

export interface DetectFrozenFilesChangedResult {
  frozenFilesChanged: string[];
  hashMatched: boolean;
  currentSnapshot: FrozenSnapshot;
}

interface CompiledScopePattern {
  raw: string;
  normalized: string;
  isDirectoryOnly: boolean;
  hasGlob: boolean;
  segmentAlternatives: string[][];
}

const MAX_BRACE_EXPANSIONS = 256;

function compareCodepoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertNoControlChars(value: string, label: string): void {
  if (value.includes("\0")) {
    throw new Error(`Invalid ${label}: NUL byte is forbidden`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${label}: control characters are forbidden`);
  }
}

function isWindowsOrPosixAbsolute(posixLike: string): boolean {
  return posixLike.startsWith("/") || /^[a-zA-Z]:(?:\/|$)/.test(posixLike);
}

/**
 * Normalizes a repository-relative path to POSIX format.
 * Rejects empty paths, NUL/control characters, absolute paths, and `..` traversal segments.
 */
export function normalizeRepoRelativePath(inputPath: string): string {
  if (typeof inputPath !== "string") {
    throw new Error("Invalid relative path: expected string");
  }
  assertNoControlChars(inputPath, "relative path");

  const trimmed = inputPath.trim();
  if (trimmed.length === 0) {
    throw new Error("Invalid relative path: cannot be empty");
  }

  const posix = inputPath.replace(/\\/g, "/");
  if (isWindowsOrPosixAbsolute(posix)) {
    throw new Error(`Invalid relative path "${inputPath}": absolute paths are forbidden`);
  }

  const rawSegments = posix.split("/");
  const cleanSegments: string[] = [];

  for (const segment of rawSegments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      throw new Error(`Invalid relative path "${inputPath}": parent traversal ".." is forbidden`);
    }
    cleanSegments.push(segment);
  }

  if (cleanSegments.length === 0) {
    throw new Error(`Invalid relative path "${inputPath}": resolves to empty path`);
  }

  return cleanSegments.join("/");
}

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

function hasGlobSyntax(pattern: string): boolean {
  return /[*?{}]/.test(pattern);
}

function compileSegmentRegex(segmentPattern: string): RegExp {
  let regexStr = "^";
  for (let i = 0; i < segmentPattern.length; i++) {
    const ch = segmentPattern[i]!;
    if (ch === "*") {
      regexStr += "[^/]*";
    } else if (ch === "?") {
      regexStr += "[^/]";
    } else {
      regexStr += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

function collapseDoubleStars(segments: string[]): string[] {
  const collapsed: string[] = [];
  for (const seg of segments) {
    if (seg === "**" && collapsed.at(-1) === "**") {
      continue;
    }
    collapsed.push(seg);
  }
  return collapsed;
}

function compileScopePattern(rawPattern: string): CompiledScopePattern {
  if (typeof rawPattern !== "string") {
    throw new Error("Invalid scope pattern: expected string");
  }
  assertNoControlChars(rawPattern, "scope pattern");
  const posix = rawPattern.replace(/\\/g, "/");
  const isDirectoryOnly = posix.endsWith("/");
  const normalized = normalizeRepoRelativePath(posix);
  const hasGlob = hasGlobSyntax(normalized);

  const expanded = expandBraces(normalized);
  const segmentAlternatives = expanded.map((item) => {
    const segs = item.split("/").filter((s) => s.length > 0 && s !== ".");
    if (isDirectoryOnly) {
      segs.push("**");
    }
    return collapseDoubleStars(segs);
  });

  return {
    raw: rawPattern,
    normalized,
    isDirectoryOnly,
    hasGlob,
    segmentAlternatives,
  };
}

function matchGlobSegments(patternSegs: readonly string[], targetSegs: readonly string[]): boolean {
  const memo = new Map<number, boolean>();
  const stride = targetSegs.length + 1;

  const visit = (pIdx: number, tIdx: number): boolean => {
    const key = pIdx * stride + tIdx;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }

    let matched = false;
    if (pIdx === patternSegs.length) {
      matched = tIdx === targetSegs.length;
    } else {
      const pSeg = patternSegs[pIdx]!;
      if (pSeg === "**") {
        if (pIdx === patternSegs.length - 1) {
          // Trailing `**` requires at least one remaining path segment under the prefix.
          matched = tIdx < targetSegs.length;
        } else {
          for (let nextT = tIdx; nextT <= targetSegs.length; nextT++) {
            if (visit(pIdx + 1, nextT)) {
              matched = true;
              break;
            }
          }
        }
      } else if (tIdx < targetSegs.length) {
        const segRegex = compileSegmentRegex(pSeg);
        if (segRegex.test(targetSegs[tIdx]!)) {
          matched = visit(pIdx + 1, tIdx + 1);
        }
      }
    }

    memo.set(key, matched);
    return matched;
  };

  return visit(0, 0);
}

function matchesCompiledPattern(
  normalizedTarget: string,
  targetSegs: readonly string[],
  compiled: CompiledScopePattern,
): boolean {
  if (!compiled.hasGlob) {
    if (compiled.isDirectoryOnly) {
      return normalizedTarget.startsWith(`${compiled.normalized}/`);
    }
    return (
      normalizedTarget === compiled.normalized ||
      normalizedTarget.startsWith(`${compiled.normalized}/`)
    );
  }

  for (const altSegs of compiled.segmentAlternatives) {
    if (matchGlobSegments(altSegs, targetSegs)) {
      return true;
    }
  }
  return false;
}

/**
 * Tests whether a single POSIX repo-relative path matches any of the given scope glob patterns.
 */
export function matchesAnyGlobPattern(
  repoRelativePath: string,
  patterns: readonly string[],
): boolean {
  if (patterns.length === 0) {
    return false;
  }
  const normalizedTarget = normalizeRepoRelativePath(repoRelativePath);
  const targetSegs = normalizedTarget.split("/");
  const compiled = patterns.map(compileScopePattern);
  return compiled.some((pattern) => matchesCompiledPattern(normalizedTarget, targetSegs, pattern));
}

/**
 * Checks whether all changed paths fall inside `scopePatterns`.
 * Fails closed when `scopePatterns` is empty and any path was modified.
 */
export function checkScope(
  changedPaths: readonly string[],
  scopePatterns: readonly string[],
): ScopeCheckResult {
  const normalizedChanged: string[] = [];
  const seenChanged = new Set<string>();
  for (const raw of changedPaths) {
    const norm = normalizeRepoRelativePath(raw);
    if (!seenChanged.has(norm)) {
      seenChanged.add(norm);
      normalizedChanged.push(norm);
    }
  }

  if (normalizedChanged.length === 0) {
    return { ok: true, outOfScopePaths: [] };
  }

  if (scopePatterns.length === 0) {
    return {
      ok: false,
      outOfScopePaths: normalizedChanged,
    };
  }

  const compiled = scopePatterns.map(compileScopePattern);
  const outOfScopePaths: string[] = [];

  for (const target of normalizedChanged) {
    const targetSegs = target.split("/");
    const matched = compiled.some((pattern) => matchesCompiledPattern(target, targetSegs, pattern));
    if (!matched) {
      outOfScopePaths.push(target);
    }
  }

  return {
    ok: outOfScopePaths.length === 0,
    outOfScopePaths,
  };
}

function sha256Buffer(content: Buffer): string {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

function isInsideCanonicalRoot(canonicalTarget: string, canonicalRoot: string): boolean {
  const prefix = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep;
  return canonicalTarget === canonicalRoot || canonicalTarget.startsWith(prefix);
}

function collectRepoFiles(canonicalRoot: string, includeNodeModules: boolean): string[] {
  const collected: string[] = [];

  const walk = (absDir: string, relPrefix: string): void => {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    entries.sort((a, b) => compareCodepoints(a.name, b.name));

    for (const entry of entries) {
      if (entry.name === ".git") {
        continue;
      }
      if (!includeNodeModules && entry.name === "node_modules") {
        continue;
      }

      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const fullPath = path.join(absDir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        collected.push(relPath);
      }
    }
  };

  walk(canonicalRoot, "");
  return collected;
}

/**
 * Computes a deterministic `sha256:...` snapshot over `acceptCmd` and all files
 * matching `freezePatterns` (including explicit literal paths that are missing).
 */
export function computeFrozenSnapshot(
  rootDir: string,
  freezePatterns: readonly string[],
  acceptCmd: string,
): FrozenSnapshot {
  if (!fs.existsSync(rootDir)) {
    throw new Error(`Frozen snapshot root directory does not exist: ${rootDir}`);
  }
  const canonicalRoot = realpathCanonical(rootDir);
  if (!fs.statSync(canonicalRoot).isDirectory()) {
    throw new Error(`Frozen snapshot root is not a directory: ${rootDir}`);
  }

  const compiledPatterns = freezePatterns.map(compileScopePattern);
  const includeNodeModules = compiledPatterns.some((p) =>
    p.normalized.split("/").includes("node_modules"),
  );

  const entryMap = new Map<string, FrozenFileEntry>();

  if (compiledPatterns.length > 0) {
    const repoFiles = collectRepoFiles(canonicalRoot, includeNodeModules);
    for (const relPath of repoFiles) {
      const targetSegs = relPath.split("/");
      const matched = compiledPatterns.some((pattern) =>
        matchesCompiledPattern(relPath, targetSegs, pattern),
      );
      if (!matched) {
        continue;
      }

      const absPath = path.join(canonicalRoot, relPath);
      const lstat = fs.lstatSync(absPath);
      if (lstat.isSymbolicLink()) {
        let resolved: string;
        try {
          resolved = realpathCanonical(absPath);
        } catch {
          throw new Error(`Frozen file "${relPath}" is a dangling symlink`);
        }
        if (!isInsideCanonicalRoot(resolved, canonicalRoot)) {
          throw new Error(`Frozen file "${relPath}" symlink escapes workspace root`);
        }
        if (!fs.statSync(resolved).isFile()) {
          continue;
        }
      } else if (!lstat.isFile()) {
        continue;
      }

      const content = fs.readFileSync(absPath);
      entryMap.set(relPath, {
        path: relPath,
        exists: true,
        sha256: sha256Buffer(content),
      });
    }

    // Also record missing state for explicit single-file literal patterns (no glob, no trailing slash).
    for (const pattern of compiledPatterns) {
      if (pattern.hasGlob || pattern.isDirectoryOnly) {
        continue;
      }
      if (entryMap.has(pattern.normalized)) {
        continue;
      }
      const absCandidate = path.join(canonicalRoot, pattern.normalized);
      if (fs.existsSync(absCandidate) && fs.statSync(absCandidate).isDirectory()) {
        continue;
      }
      entryMap.set(pattern.normalized, {
        path: pattern.normalized,
        exists: false,
        sha256: null,
      });
    }
  }

  const files = Array.from(entryMap.values()).sort((a, b) => compareCodepoints(a.path, b.path));

  const digest = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        acceptCmd,
        files: files.map((f) => ({
          path: f.path,
          exists: f.exists,
          sha256: f.sha256,
        })),
      }),
    )
    .digest("hex");

  return {
    hash: `sha256:${digest}`,
    acceptCmd,
    files,
  };
}

/**
 * Re-computes the frozen test snapshot on disk and checks `changedPaths` against
 * `freezePatterns` and `baselineHash`, catching modifications or deletions even if
 * the worker receipt omitted them.
 */
export function detectFrozenFilesChanged(
  input: DetectFrozenFilesChangedInput,
): DetectFrozenFilesChangedResult {
  const effectiveFreezePatterns = Array.from(
    new Set([
      ...input.freezePatterns,
      ...(input.baselineSnapshot?.files.map((entry) => entry.path) ?? []),
    ]),
  );
  const currentSnapshot = computeFrozenSnapshot(
    input.rootDir,
    effectiveFreezePatterns,
    input.acceptCmd,
  );
  const hashMatched = currentSnapshot.hash === input.baselineHash;

  const changedSet = new Set<string>();
  const compiledPatterns = effectiveFreezePatterns.map(compileScopePattern);
  const baselinePaths = new Set(input.baselineSnapshot?.files.map((entry) => entry.path) ?? []);

  if (input.changedPaths && compiledPatterns.length > 0) {
    for (const rawChanged of input.changedPaths) {
      const norm = normalizeRepoRelativePath(rawChanged);
      if (baselinePaths.has(norm)) {
        continue;
      }
      const segs = norm.split("/");
      if (compiledPatterns.some((p) => matchesCompiledPattern(norm, segs, p))) {
        changedSet.add(norm);
      }
    }
  }

  if (input.baselineSnapshot) {
    const baselineByPath = new Map(
      input.baselineSnapshot.files.map((entry) => [entry.path, entry]),
    );
    const currentByPath = new Map(currentSnapshot.files.map((entry) => [entry.path, entry]));
    const allPaths = new Set([...baselineByPath.keys(), ...currentByPath.keys()]);
    for (const filePath of allPaths) {
      const before = baselineByPath.get(filePath);
      const after = currentByPath.get(filePath);
      if (before?.exists !== after?.exists || before?.sha256 !== after?.sha256) {
        changedSet.add(filePath);
      }
    }
  }

  if (!hashMatched && changedSet.size === 0) {
    changedSet.add("<accept_files_hash_mismatch>");
  }

  const frozenFilesChanged = Array.from(changedSet).sort(compareCodepoints);
  return {
    frozenFilesChanged,
    hashMatched,
    currentSnapshot,
  };
}

interface ExpandedScopeBranch {
  normalized: string;
  isDirectoryOnly: boolean;
}

function expandScopePatternBranches(rawPattern: string): ExpandedScopeBranch[] {
  if (typeof rawPattern !== "string") {
    throw new Error("Invalid scope pattern: expected string");
  }
  assertNoControlChars(rawPattern, "scope pattern");
  const posix = rawPattern.replace(/\\/g, "/");
  const isDirectoryOnly = posix.endsWith("/");
  const normalized = normalizeRepoRelativePath(posix);
  if (normalized.includes("{") && !normalized.includes("}")) {
    throw new Error(`Invalid scope brace pattern "${rawPattern}"`);
  }
  if (normalized.includes("}") && !normalized.includes("{")) {
    throw new Error(`Invalid scope brace pattern "${rawPattern}"`);
  }
  const expanded = expandBraces(normalized);
  return expanded.map((item) => ({
    normalized: item,
    isDirectoryOnly,
  }));
}

function isSingleScopeBranchWithinParent(c: ExpandedScopeBranch, p: ExpandedScopeBranch): boolean {
  if (
    c.normalized.includes("{") ||
    c.normalized.includes("}") ||
    p.normalized.includes("{") ||
    p.normalized.includes("}")
  ) {
    return false;
  }

  const cSegs = c.normalized.split("/").filter((s) => s.length > 0 && s !== ".");
  const pSegs = p.normalized.split("/").filter((s) => s.length > 0 && s !== ".");

  const pIsRecursiveTree =
    p.isDirectoryOnly ||
    p.normalized === "**" ||
    (pSegs.length >= 2 &&
      pSegs[pSegs.length - 1] === "**" &&
      !hasGlobSyntax(pSegs.slice(0, -1).join("/")));

  if (pIsRecursiveTree) {
    if (p.normalized === "**") {
      return true;
    }
    const pDir = p.isDirectoryOnly ? p.normalized : pSegs.slice(0, -1).join("/");
    if (!pDir || hasGlobSyntax(pDir)) {
      return false;
    }
    return c.normalized === pDir || c.normalized.startsWith(`${pDir}/`);
  }

  if (!p.isDirectoryOnly && !hasGlobSyntax(p.normalized)) {
    return !c.isDirectoryOnly && !hasGlobSyntax(c.normalized) && c.normalized === p.normalized;
  }

  if (!p.isDirectoryOnly && hasGlobSyntax(p.normalized) && !pSegs.includes("**")) {
    if (c.isDirectoryOnly || cSegs.includes("**") || cSegs.length !== pSegs.length) {
      return false;
    }
    for (let i = 0; i < pSegs.length; i++) {
      const pSeg = pSegs[i]!;
      const cSeg = cSegs[i]!;
      if (cSeg === pSeg) {
        continue;
      }
      if (hasGlobSyntax(cSeg) || !compileSegmentRegex(pSeg).test(cSeg)) {
        return false;
      }
    }
    return true;
  }

  return false;
}

/**
 * Strictly checks structural containment of every child scope pattern inside `parentScope`.
 * Fails closed (`false`) if `parentScope` only allows a single-level wildcard (`*.ts`) while a child
 * attempts recursive traversal (`**`), or on any unexpanded brace / malformed pattern.
 */
export function isChildScopeSubsetOfParent(
  childScope: readonly string[],
  parentScope: readonly string[],
): boolean {
  if (childScope.length === 0 || parentScope.length === 0) {
    return false;
  }

  try {
    const childBranches: ExpandedScopeBranch[] = [];
    for (const rawChild of childScope) {
      childBranches.push(...expandScopePatternBranches(rawChild));
    }
    const parentBranches: ExpandedScopeBranch[] = [];
    for (const rawParent of parentScope) {
      parentBranches.push(...expandScopePatternBranches(rawParent));
    }
    if (childBranches.length === 0 || parentBranches.length === 0) {
      return false;
    }
    return childBranches.every((c) =>
      parentBranches.some((p) => isSingleScopeBranchWithinParent(c, p)),
    );
  } catch {
    return false;
  }
}

const DOCS_ONLY_FAST_FORWARD_PATTERNS = [
  "**/*.md",
  "**/*.mdx",
  "*.md",
  "*.mdx",
  "docs/**",
  "LICENSE*",
  ".gitignore",
] as const;

const TESTS_ONLY_FAST_FORWARD_PATTERNS = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.js",
  "**/*.test.mjs",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/__tests__/**",
  "evals/**",
] as const;

export interface EvaluateDeterministicFastForwardInput {
  changedPaths: readonly string[];
  gatePassed: boolean;
  frozenFilesChanged: readonly string[];
  humanAccept: boolean;
  workspaceMode: WorkspaceMode;
}

export type EvaluateDeterministicFastForwardResult =
  | { fastForward: false }
  | { fastForward: true; reason: "docs_only" | "tests_only" };

/**
 * Deterministically detects whether verified physical file changes qualify for 0-Token
 * stage fast-forwarding (`docs_only` or `tests_only`), never skipping runtime `packages/protocol/src/**`.
 */
export function evaluateDeterministicFastForward(
  input: EvaluateDeterministicFastForwardInput,
): EvaluateDeterministicFastForwardResult {
  if (
    !input.gatePassed ||
    input.frozenFilesChanged.length > 0 ||
    input.humanAccept ||
    input.changedPaths.length === 0 ||
    input.workspaceMode !== "git_worktree"
  ) {
    return { fastForward: false };
  }

  const normalizedPaths: string[] = [];
  for (const raw of input.changedPaths) {
    try {
      normalizedPaths.push(normalizeRepoRelativePath(raw));
    } catch {
      return { fastForward: false };
    }
  }

  if (
    normalizedPaths.every(
      (p) =>
        matchesAnyGlobPattern(p, DOCS_ONLY_FAST_FORWARD_PATTERNS) &&
        !matchesAnyGlobPattern(p, ["evals/**", "REVIEW.md"]),
    )
  ) {
    return { fastForward: true, reason: "docs_only" };
  }

  if (normalizedPaths.every((p) => matchesAnyGlobPattern(p, TESTS_ONLY_FAST_FORWARD_PATTERNS))) {
    return { fastForward: true, reason: "tests_only" };
  }

  return { fastForward: false };
}
