import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { TaskStatus } from "@kiln/protocol";
import { ensureDir, writeFileAtomic } from "../store/fs-atomic.js";
import { buildSanitizedEnv } from "./command-runner.js";
import { normalizeRepoRelativePath } from "./scope.js";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

export interface PrepareGitWorktreeInput {
  repoPath: string;
  worktreePath: string;
  branchName: string;
  baseRef?: string;
  copyUntracked?: readonly string[];
  cloneDeps?: readonly string[];
}

export interface PrepareGitWorktreeResult {
  repoPath: string;
  worktreePath: string;
  branchName: string;
  baseCommit: string;
  hooksDir: string;
  prePushHookPath: string;
}

export interface GitWorktreeChanges {
  changedPaths: string[];
  dirtyPaths: string[];
  untrackedPaths: string[];
  isDirty: boolean;
}

export interface CleanupGitWorktreeInput {
  repoPath: string;
  worktreePath: string;
  taskStatus: TaskStatus;
  gatePassed: boolean;
  awaitingHumanReview: boolean;
}

export type CleanupRetainedReason =
  | "worktree_not_found"
  | "awaiting_human_review"
  | "non_terminal_status"
  | "gate_not_passed"
  | "dirty_worktree";

export type CleanupGitWorktreeResult =
  | {
      deleted: true;
      retainedReason: null;
      worktreePath: string;
      dirtyPaths: string[];
    }
  | {
      deleted: false;
      retainedReason: CleanupRetainedReason;
      worktreePath: string;
      dirtyPaths: string[];
    };

function assertSafeRef(ref: string, label: string): string {
  if (typeof ref !== "string" || ref.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (ref.includes("\0") || /[\u0000-\u001f\u007f]/.test(ref)) {
    throw new Error(`Invalid ${label}: control characters are forbidden`);
  }
  if (ref.startsWith("-")) {
    throw new Error(`Invalid ${label} "${ref}": leading "-" is forbidden`);
  }
  return ref;
}

function sameCanonicalPath(a: string, b: string): boolean {
  if (process.platform === "win32") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function isInsideCanonicalDir(canonicalTarget: string, canonicalDir: string): boolean {
  const prefix = canonicalDir.endsWith(path.sep) ? canonicalDir : canonicalDir + path.sep;
  if (process.platform === "win32") {
    const targetLower = canonicalTarget.toLowerCase();
    return (
      targetLower === canonicalDir.toLowerCase() ||
      targetLower.startsWith(prefix.toLowerCase())
    );
  }
  return canonicalTarget === canonicalDir || canonicalTarget.startsWith(prefix);
}

function compareCodepoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function runGit(args: readonly string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    env: buildSanitizedEnv(),
    maxBuffer: GIT_MAX_BUFFER,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout;
}

async function gitRefExists(repoPath: string, fullRef: string): Promise<boolean> {
  try {
    await runGit(["-C", repoPath, "show-ref", "--verify", "--quiet", fullRef]);
    return true;
  } catch {
    return false;
  }
}

function resolveExistingSourceInsideRepo(
  canonicalRepo: string,
  relPath: string,
): string | null {
  const fullPath = path.join(canonicalRepo, relPath);
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(fullPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }

  const realSource = fs.realpathSync(fullPath);
  if (!isInsideCanonicalDir(realSource, canonicalRepo)) {
    throw new Error(
      `Refusing to copy "${relPath}": real path "${realSource}" escapes repository root "${canonicalRepo}"`,
    );
  }

  if (lstat.isSymbolicLink() && !fs.existsSync(realSource)) {
    return null;
  }

  return realSource;
}

function ensureDestinationInsideWorktree(
  canonicalWorktree: string,
  relPath: string,
): string {
  const destPath = path.join(canonicalWorktree, relPath);
  const parentDir = path.dirname(destPath);
  ensureDir(parentDir);

  const realParent = fs.realpathSync(parentDir);
  if (!isInsideCanonicalDir(realParent, canonicalWorktree)) {
    throw new Error(
      `Destination parent "${realParent}" escapes worktree root "${canonicalWorktree}"`,
    );
  }

  return destPath;
}

async function cloneDirectoryOrFile(sourcePath: string, destPath: string): Promise<void> {
  if (process.platform === "darwin") {
    try {
      await execFileAsync("/bin/cp", ["-cR", sourcePath, destPath], {
        env: buildSanitizedEnv(),
        maxBuffer: GIT_MAX_BUFFER,
      });
      return;
    } catch {
      fs.rmSync(destPath, { recursive: true, force: true });
    }
  }

  fs.cpSync(sourcePath, destPath, { recursive: true });
}

function parseNulSeparatedPaths(raw: string): string[] {
  if (raw.length === 0) {
    return [];
  }
  const paths: string[] = [];
  for (const token of raw.split("\0")) {
    if (token.length === 0) {
      continue;
    }
    paths.push(normalizeRepoRelativePath(token));
  }
  return paths;
}

function parsePorcelainStatusZ(raw: string): {
  dirtyPaths: string[];
  untrackedPaths: string[];
} {
  const dirtySet = new Set<string>();
  const untrackedSet = new Set<string>();

  const tokens = raw.split("\0");
  let idx = 0;
  while (idx < tokens.length) {
    const token = tokens[idx];
    idx++;
    if (!token || token.length < 4) {
      continue;
    }

    const xy = token.slice(0, 2);
    const filePath = normalizeRepoRelativePath(token.slice(3));
    dirtySet.add(filePath);

    if (xy === "??") {
      untrackedSet.add(filePath);
    }

    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
      const origPath = tokens[idx];
      idx++;
      if (origPath && origPath.length > 0) {
        dirtySet.add(normalizeRepoRelativePath(origPath));
      }
    }
  }

  return {
    dirtyPaths: Array.from(dirtySet).sort(compareCodepoints),
    untrackedPaths: Array.from(untrackedSet).sort(compareCodepoints),
  };
}

async function inspectWorktreeStatus(canonicalWorktree: string): Promise<{
  dirtyPaths: string[];
  untrackedPaths: string[];
  isDirty: boolean;
}> {
  const statusRaw = await runGit([
    "-C",
    canonicalWorktree,
    "status",
    "--porcelain=v1",
    "-z",
    "-uall",
  ]);
  const { dirtyPaths, untrackedPaths } = parsePorcelainStatusZ(statusRaw);
  return {
    dirtyPaths,
    untrackedPaths,
    isDirty: dirtyPaths.length > 0,
  };
}

/**
 * Creates an isolated git worktree, copies optional untracked env files and APFS-cloned
 * dependency directories, and installs a worktree-scoped `pre-push` hook that blocks
 * `git push` without polluting the main repository's hooks configuration.
 */
export async function prepareGitWorktree(
  input: PrepareGitWorktreeInput,
): Promise<PrepareGitWorktreeResult> {
  if (!fs.existsSync(input.repoPath)) {
    throw new Error(`Repository path does not exist: ${input.repoPath}`);
  }
  const canonicalRepo = fs.realpathSync(input.repoPath);
  const topLevel = (await runGit(["-C", canonicalRepo, "rev-parse", "--show-toplevel"])).trim();
  const canonicalTopLevel = fs.realpathSync(topLevel);
  if (!sameCanonicalPath(canonicalTopLevel, canonicalRepo)) {
    throw new Error(
      `repoPath "${input.repoPath}" must be the repository root "${canonicalTopLevel}"`,
    );
  }

  const branchName = assertSafeRef(input.branchName, "branchName");
  await runGit(["check-ref-format", "--branch", branchName]);

  const baseRef = input.baseRef !== undefined ? assertSafeRef(input.baseRef, "baseRef") : "HEAD";

  if (fs.existsSync(input.worktreePath)) {
    throw new Error(`Target worktreePath already exists: ${input.worktreePath}`);
  }
  ensureDir(path.dirname(input.worktreePath));

  const branchExists = await gitRefExists(canonicalRepo, `refs/heads/${branchName}`);
  if (branchExists) {
    await runGit(["-C", canonicalRepo, "worktree", "add", input.worktreePath, branchName]);
  } else {
    await runGit([
      "-C",
      canonicalRepo,
      "worktree",
      "add",
      "-b",
      branchName,
      input.worktreePath,
      baseRef,
    ]);
  }

  const canonicalWorktree = fs.realpathSync(input.worktreePath);

  try {
    for (const rawRel of input.copyUntracked ?? []) {
      const rel = normalizeRepoRelativePath(rawRel);
      const src = resolveExistingSourceInsideRepo(canonicalRepo, rel);
      if (!src) {
        continue;
      }
      const dest = ensureDestinationInsideWorktree(canonicalWorktree, rel);
      fs.cpSync(src, dest, { recursive: true });
    }

    for (const rawRel of input.cloneDeps ?? []) {
      const rel = normalizeRepoRelativePath(rawRel);
      const src = resolveExistingSourceInsideRepo(canonicalRepo, rel);
      if (!src) {
        continue;
      }
      const dest = ensureDestinationInsideWorktree(canonicalWorktree, rel);
      await cloneDirectoryOrFile(src, dest);
    }

    await runGit(["-C", canonicalRepo, "config", "extensions.worktreeConfig", "true"]);
    const rawGitDir = (
      await runGit(["-C", canonicalWorktree, "rev-parse", "--git-dir"])
    ).trim();
    const worktreeGitAdminDir = path.isAbsolute(rawGitDir)
      ? rawGitDir
      : path.resolve(canonicalWorktree, rawGitDir);

    const hooksDir = path.join(worktreeGitAdminDir, "kiln-hooks");
    ensureDir(hooksDir);
    const prePushHookPath = path.join(hooksDir, "pre-push");
    writeFileAtomic(
      prePushHookPath,
      `#!/bin/sh\necho "kiln: git push is disabled inside isolated task worktree" >&2\nexit 1\n`,
    );
    if (process.platform !== "win32") {
      fs.chmodSync(prePushHookPath, 0o755);
    }

    await runGit([
      "-C",
      canonicalWorktree,
      "config",
      "--worktree",
      "core.hooksPath",
      hooksDir,
    ]);

    const baseCommit = (
      await runGit(["-C", canonicalWorktree, "rev-parse", "HEAD"])
    ).trim();

    return {
      repoPath: canonicalRepo,
      worktreePath: canonicalWorktree,
      branchName,
      baseCommit,
      hooksDir,
      prePushHookPath,
    };
  } catch (err) {
    try {
      await runGit(["-C", canonicalRepo, "worktree", "remove", "--force", canonicalWorktree]);
    } catch {
      // Preserve primary setup error; ignore rollback cleanup error.
    }
    throw err;
  }
}

/**
 * Inspects real committed, staged, unstaged, and untracked changes in `worktreePath`
 * relative to `inputRef` without trusting worker receipts.
 */
export async function inspectGitWorktreeChanges(
  worktreePath: string,
  inputRef: string,
): Promise<GitWorktreeChanges> {
  if (!fs.existsSync(worktreePath)) {
    throw new Error(`Worktree path does not exist: ${worktreePath}`);
  }
  const canonicalWorktree = fs.realpathSync(worktreePath);
  const safeRef = assertSafeRef(inputRef, "inputRef");
  await runGit(["-C", canonicalWorktree, "rev-parse", "--verify", `${safeRef}^{commit}`]);

  const [worktreeDiffRaw, cachedDiffRaw, statusResult] = await Promise.all([
    runGit(["-C", canonicalWorktree, "diff", "--no-renames", "--name-only", "-z", safeRef, "--"]),
    runGit([
      "-C",
      canonicalWorktree,
      "diff",
      "--cached",
      "--no-renames",
      "--name-only",
      "-z",
      safeRef,
      "--",
    ]),
    inspectWorktreeStatus(canonicalWorktree),
  ]);

  const changedSet = new Set<string>([
    ...parseNulSeparatedPaths(worktreeDiffRaw),
    ...parseNulSeparatedPaths(cachedDiffRaw),
    ...statusResult.dirtyPaths,
  ]);

  return {
    changedPaths: Array.from(changedSet).sort(compareCodepoints),
    dirtyPaths: statusResult.dirtyPaths,
    untrackedPaths: statusResult.untrackedPaths,
    isDirty: statusResult.isDirty,
  };
}

/**
 * Safely removes a task worktree only when it is in a safe terminal state
 * (`done` with `gatePassed=true`, or `cancelled`), not awaiting human review,
 * and completely free of dirty or untracked working-tree files.
 */
export async function cleanupGitWorktree(
  input: CleanupGitWorktreeInput,
): Promise<CleanupGitWorktreeResult> {
  if (!fs.existsSync(input.worktreePath)) {
    return {
      deleted: false,
      retainedReason: "worktree_not_found",
      worktreePath: input.worktreePath,
      dirtyPaths: [],
    };
  }

  const canonicalWorktree = fs.realpathSync(input.worktreePath);
  const status = await inspectWorktreeStatus(canonicalWorktree);

  if (input.awaitingHumanReview) {
    return {
      deleted: false,
      retainedReason: "awaiting_human_review",
      worktreePath: canonicalWorktree,
      dirtyPaths: status.dirtyPaths,
    };
  }

  if (input.taskStatus !== "done" && input.taskStatus !== "cancelled") {
    return {
      deleted: false,
      retainedReason: "non_terminal_status",
      worktreePath: canonicalWorktree,
      dirtyPaths: status.dirtyPaths,
    };
  }

  if (input.taskStatus === "done" && !input.gatePassed) {
    return {
      deleted: false,
      retainedReason: "gate_not_passed",
      worktreePath: canonicalWorktree,
      dirtyPaths: status.dirtyPaths,
    };
  }

  if (status.isDirty) {
    return {
      deleted: false,
      retainedReason: "dirty_worktree",
      worktreePath: canonicalWorktree,
      dirtyPaths: status.dirtyPaths,
    };
  }

  const canonicalRepo = fs.realpathSync(input.repoPath);
  await runGit(["-C", canonicalRepo, "worktree", "remove", canonicalWorktree]);

  return {
    deleted: true,
    retainedReason: null,
    worktreePath: canonicalWorktree,
    dirtyPaths: [],
  };
}
