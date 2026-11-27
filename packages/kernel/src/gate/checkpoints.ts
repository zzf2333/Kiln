import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  CheckpointRecordSchema,
  type CheckpointRecord,
  type RunMeta,
  type StageId,
} from "@kiln/protocol";
import { assertSafeSegment } from "../store/paths.js";
import { buildSanitizedEnv } from "./command-runner.js";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 10 * 1024 * 1024;
const CHECKPOINT_REF_PREFIX = "refs/kiln/checkpoints/";

export class InvalidCheckpointRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCheckpointRefError";
  }
}

export class CheckpointNotFoundError extends Error {
  constructor(readonly checkpointRef: string) {
    super(`Checkpoint ref "${checkpointRef}" was not found`);
    this.name = "CheckpointNotFoundError";
  }
}

async function runGit(
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd: options.cwd,
    env: options.env ?? buildSanitizedEnv(),
    maxBuffer: GIT_MAX_BUFFER,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout;
}

function assertSafeCheckpointSegment(value: string, label: string): string {
  const safe = assertSafeSegment(value, label);
  if (safe.startsWith("-")) {
    throw new InvalidCheckpointRefError(`Invalid ${label} "${safe}": leading "-" is forbidden`);
  }
  return safe;
}

/**
 * Builds and validates a canonical hidden Git checkpoint ref under
 * `refs/kiln/checkpoints/<taskId>/<checkpointKey>`.
 */
export function buildCheckpointRef(taskId: string, checkpointKey: string): string {
  const safeTaskId = assertSafeCheckpointSegment(taskId, "taskId");
  const safeKey = assertSafeCheckpointSegment(checkpointKey, "checkpointKey");
  return `${CHECKPOINT_REF_PREFIX}${safeTaskId}/${safeKey}`;
}

async function validateFullCheckpointRef(
  taskId: string,
  checkpointRef: string,
): Promise<{ safeTaskId: string; ref: string }> {
  const safeTaskId = assertSafeCheckpointSegment(taskId, "taskId");
  const expectedPrefix = `${CHECKPOINT_REF_PREFIX}${safeTaskId}/`;
  if (
    typeof checkpointRef !== "string" ||
    !checkpointRef.startsWith(expectedPrefix) ||
    /[\u0000-\u001f\u007f]/.test(checkpointRef) ||
    checkpointRef.includes("\\") ||
    checkpointRef.includes("..")
  ) {
    throw new InvalidCheckpointRefError(
      `Invalid checkpoint_ref "${checkpointRef}" for task "${safeTaskId}"`,
    );
  }
  const key = checkpointRef.slice(expectedPrefix.length);
  assertSafeCheckpointSegment(key, "checkpointKey");
  try {
    await runGit(["check-ref-format", checkpointRef]);
  } catch {
    throw new InvalidCheckpointRefError(
      `checkpoint_ref "${checkpointRef}" failed git check-ref-format`,
    );
  }
  return { safeTaskId, ref: checkpointRef };
}

export interface CreateGitWorktreeCheckpointInput {
  worktreePath: string;
  taskId: string;
  runId: string;
  phase?: "pre" | "post";
  stage: StageId;
  round: number;
  message?: string;
}

/**
 * Captures an implicit snapshot of all tracked and non-ignored untracked files
 * in `worktreePath` into `refs/kiln/checkpoints/<taskId>/<runId>[-pre|-post]`
 * using a temporary `GIT_INDEX_FILE` and parentless `commit-tree` so branch `HEAD`
 * and `.git/index` remain untouched.
 */
export async function createGitWorktreeCheckpoint(
  input: CreateGitWorktreeCheckpointInput,
): Promise<CheckpointRecord> {
  if (!fs.existsSync(input.worktreePath) || !fs.statSync(input.worktreePath).isDirectory()) {
    throw new Error(`Worktree directory does not exist: ${input.worktreePath}`);
  }

  const key = input.phase ? `${input.runId}-${input.phase}` : input.runId;
  const ref = buildCheckpointRef(input.taskId, key);
  await validateFullCheckpointRef(input.taskId, ref);

  // Allocate a non-existent path in tmpdir so `git add -A` initializes a fresh index
  // cleanly (a pre-created 0-byte file fails with "index file smaller than expected").
  const tmpIdx = path.join(os.tmpdir(), `kiln-ckpt-idx-${randomUUID()}`);
  const env = buildSanitizedEnv(process.env, {
    GIT_INDEX_FILE: tmpIdx,
    GIT_AUTHOR_NAME: "Kiln Checkpoint",
    GIT_AUTHOR_EMAIL: "kiln@local",
    GIT_COMMITTER_NAME: "Kiln Checkpoint",
    GIT_COMMITTER_EMAIL: "kiln@local",
  });

  try {
    await runGit(["-c", "core.autocrlf=false", "-C", input.worktreePath, "add", "-A"], { env });
    const treeSha = (await runGit(["-C", input.worktreePath, "write-tree"], { env })).trim();
    const message =
      input.message ?? `kiln checkpoint: ${input.taskId} ${input.stage} r${input.round} (${key})`;
    const commitSha = (
      await runGit(["-C", input.worktreePath, "commit-tree", treeSha, "-m", message], {
        env,
      })
    ).trim();
    await runGit(["-C", input.worktreePath, "update-ref", ref, commitSha]);

    return CheckpointRecordSchema.parse({
      schema_version: 1,
      run_id: input.runId,
      task_id: input.taskId,
      stage: input.stage,
      round: input.round,
      ref,
      commit_sha: commitSha,
      created_at: new Date().toISOString(),
    });
  } finally {
    fs.rmSync(tmpIdx, { force: true });
  }
}

export interface ListTaskCheckpointsInput {
  repoPath: string;
  taskId: string;
  runs?: readonly RunMeta[];
}

/**
 * Lists hidden Git checkpoints created for `taskId`, correlated with `runs/` metadata.
 */
export async function listTaskCheckpoints(
  input: ListTaskCheckpointsInput,
): Promise<CheckpointRecord[]> {
  const safeTaskId = assertSafeCheckpointSegment(input.taskId, "taskId");
  if (!fs.existsSync(input.repoPath)) {
    return [];
  }

  const refPrefix = `${CHECKPOINT_REF_PREFIX}${safeTaskId}/`;
  const raw = await runGit([
    "-C",
    input.repoPath,
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(committerdate:iso-strict)",
    refPrefix,
  ]).catch(() => "");

  if (!raw.trim()) {
    return [];
  }

  const runs = input.runs ?? [];
  const records: CheckpointRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const [ref, commitSha, createdAt] = line.split("\0");
    if (!ref || !commitSha) {
      continue;
    }

    const leaf = ref.slice(refPrefix.length);
    const derivedRunId = leaf.replace(/-(pre|post)$/, "");
    const matchedRun = runs.find((r) => r.checkpoint_ref === ref || r.run_id === derivedRunId);

    records.push(
      CheckpointRecordSchema.parse({
        schema_version: 1,
        run_id: matchedRun?.run_id ?? derivedRunId,
        task_id: safeTaskId,
        stage: matchedRun?.stage ?? "implement",
        round: matchedRun?.round ?? 1,
        ref,
        commit_sha: commitSha.trim(),
        created_at: createdAt?.trim() || new Date(0).toISOString(),
      }),
    );
  }

  const runOrder = new Map(runs.map((r, idx) => [r.run_id, idx]));
  const phaseRank = (ref: string): number =>
    ref.endsWith("-pre") ? 0 : ref.endsWith("-post") ? 2 : 1;

  records.sort((a, b) => {
    const byDate = a.created_at.localeCompare(b.created_at);
    if (byDate !== 0) {
      return byDate;
    }
    const rankA = runOrder.get(a.run_id);
    const rankB = runOrder.get(b.run_id);
    if (rankA !== undefined && rankB !== undefined && rankA !== rankB) {
      return rankA - rankB;
    }
    if (a.run_id === b.run_id) {
      const byPhase = phaseRank(a.ref) - phaseRank(b.ref);
      if (byPhase !== 0) {
        return byPhase;
      }
    }
    return a.ref.localeCompare(b.ref);
  });
  return records;
}

export interface RollbackGitWorktreeToCheckpointInput {
  worktreePath: string;
  taskId: string;
  checkpointRef: string;
}

/**
 * Restores a task `git_worktree` to the exact snapshot recorded at `checkpointRef`
 * without altering `HEAD` commit history and while preserving gitignored files
 * (e.g. `.env`, `node_modules`).
 */
export async function rollbackGitWorktreeToCheckpoint(
  input: RollbackGitWorktreeToCheckpointInput,
): Promise<{ checkpointRef: string; commitSha: string }> {
  const { ref } = await validateFullCheckpointRef(input.taskId, input.checkpointRef);
  if (!fs.existsSync(input.worktreePath) || !fs.statSync(input.worktreePath).isDirectory()) {
    throw new Error(`Worktree directory does not exist: ${input.worktreePath}`);
  }

  let commitSha: string;
  try {
    commitSha = (
      await runGit(["-C", input.worktreePath, "rev-parse", "--verify", `${ref}^{commit}`])
    ).trim();
  } catch {
    throw new CheckpointNotFoundError(ref);
  }

  await runGit([
    "-c",
    "core.autocrlf=false",
    "-C",
    input.worktreePath,
    "read-tree",
    "--reset",
    "-u",
    commitSha,
  ]);
  // Clean non-ignored untracked files added after the checkpoint; omit -x to keep .env / node_modules.
  await runGit(["-C", input.worktreePath, "clean", "-fd"]);
  await runGit(["-C", input.worktreePath, "reset", "--mixed", "HEAD"]);

  return { checkpointRef: ref, commitSha };
}

/**
 * Deletes all `refs/kiln/checkpoints/<taskId>/*` refs from `repoPath` on task archive.
 */
export async function cleanupTaskCheckpoints(repoPath: string, taskId: string): Promise<number> {
  const safeTaskId = assertSafeCheckpointSegment(taskId, "taskId");
  if (!fs.existsSync(repoPath)) {
    return 0;
  }

  const refPrefix = `${CHECKPOINT_REF_PREFIX}${safeTaskId}/`;
  const raw = await runGit([
    "-C",
    repoPath,
    "for-each-ref",
    "--format=%(refname)",
    refPrefix,
  ]).catch(() => "");

  const refs = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(refPrefix));

  let deleted = 0;
  for (const ref of refs) {
    try {
      await runGit(["-C", repoPath, "update-ref", "-d", ref]);
      deleted += 1;
    } catch {
      // Ignore individual ref deletion failures during archive GC.
    }
  }
  return deleted;
}
