import fs from "node:fs";
import path from "node:path";
import { ensureDir, realpathCanonical } from "../store/fs-atomic.js";
import type { KilnStore } from "../store/kiln-store.js";
import { assertSafeSegment } from "../store/paths.js";
import { runIsolatedCommand, type IsolatedCommandResult } from "./command-runner.js";
import { normalizeRepoRelativePath } from "./scope.js";

export interface VerifyScratchWorkspaceInput {
  workspaceDir: string;
  expectedArtifacts: readonly string[];
  acceptCmd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  extraSafeEnv?: Record<string, string>;
  signal?: AbortSignal;
}

export interface VerifyScratchWorkspaceResult {
  ok: boolean;
  workspaceDir: string;
  verifiedArtifacts: string[];
  missingArtifacts: string[];
  emptyArtifacts: string[];
  invalidArtifacts: string[];
  acceptResult: IsolatedCommandResult | null;
}

function isInsideCanonicalDir(canonicalTarget: string, canonicalDir: string): boolean {
  const prefix = canonicalDir.endsWith(path.sep) ? canonicalDir : canonicalDir + path.sep;
  return canonicalTarget === canonicalDir || canonicalTarget.startsWith(prefix);
}

/**
 * Ensures an isolated scratch workspace directory exists at `store.paths.workspaceDir(taskId)`
 * and returns its canonical path.
 */
export function prepareScratchWorkspace(store: KilnStore, taskId: string): string {
  const safeTaskId = assertSafeSegment(taskId, "taskId");
  const dir = store.paths.workspaceDir(safeTaskId);
  ensureDir(dir);
  const canonical = realpathCanonical(dir);
  if (!fs.statSync(canonical).isDirectory()) {
    throw new Error(`Scratch workspace path is not a directory: ${canonical}`);
  }
  return canonical;
}

/**
 * Verifies every expected artifact inside `workspaceDir` (rejecting traversal/absolute paths,
 * escaping symlinks, non-regular files, and zero-byte files) and runs optional `acceptCmd`
 * inside the isolated command runner.
 */
export async function verifyScratchWorkspace(
  input: VerifyScratchWorkspaceInput,
): Promise<VerifyScratchWorkspaceResult> {
  if (!fs.existsSync(input.workspaceDir)) {
    throw new Error(`Scratch workspace directory does not exist: ${input.workspaceDir}`);
  }
  const canonicalWorkspace = realpathCanonical(input.workspaceDir);
  if (!fs.statSync(canonicalWorkspace).isDirectory()) {
    throw new Error(`Scratch workspace is not a directory: ${input.workspaceDir}`);
  }

  const normalizedArtifacts = Array.from(
    new Set(input.expectedArtifacts.map((artifact) => normalizeRepoRelativePath(artifact))),
  );

  const verifiedArtifacts: string[] = [];
  const missingArtifacts: string[] = [];
  const emptyArtifacts: string[] = [];
  const invalidArtifacts: string[] = [];

  for (const relPath of normalizedArtifacts) {
    const candidatePath = path.join(canonicalWorkspace, relPath);
    let lstat: fs.Stats;
    try {
      lstat = fs.lstatSync(candidatePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        missingArtifacts.push(relPath);
        continue;
      }
      throw err;
    }

    let targetStat: fs.Stats = lstat;
    if (lstat.isSymbolicLink()) {
      let realArtifact: string;
      try {
        realArtifact = realpathCanonical(candidatePath);
      } catch {
        invalidArtifacts.push(relPath);
        continue;
      }
      if (!isInsideCanonicalDir(realArtifact, canonicalWorkspace)) {
        invalidArtifacts.push(relPath);
        continue;
      }
      targetStat = fs.statSync(realArtifact);
    }

    if (!targetStat.isFile()) {
      invalidArtifacts.push(relPath);
      continue;
    }

    if (targetStat.size <= 0) {
      emptyArtifacts.push(relPath);
      continue;
    }

    verifiedArtifacts.push(relPath);
  }

  let acceptResult: IsolatedCommandResult | null = null;
  if (input.acceptCmd !== undefined && input.acceptCmd.trim().length > 0) {
    acceptResult = await runIsolatedCommand(input.acceptCmd, {
      cwd: canonicalWorkspace,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      env: input.env,
      extraSafeEnv: input.extraSafeEnv,
      signal: input.signal,
    });
  }

  const artifactsOk =
    missingArtifacts.length === 0 && emptyArtifacts.length === 0 && invalidArtifacts.length === 0;
  const acceptOk = acceptResult === null || (acceptResult.exitCode === 0 && !acceptResult.timedOut);

  return {
    ok: artifactsOk && acceptOk,
    workspaceDir: canonicalWorkspace,
    verifiedArtifacts,
    missingArtifacts,
    emptyArtifacts,
    invalidArtifacts,
    acceptResult,
  };
}
