import fs from "node:fs";
import path from "node:path";
import {
  GateReportSchema,
  RunMetaSchema,
  parseAndValidateReceipt,
  type GateReport,
  type WorkerReceiptFrontmatter,
} from "@kiln/protocol";
import { readYamlValidated, realpathCanonical, writeYamlAtomic } from "../store/fs-atomic.js";
import type { KilnStore } from "../store/kiln-store.js";
import { assertSafeSegment } from "../store/paths.js";
import { runIsolatedCommand, type IsolatedCommandResult } from "./command-runner.js";
import { inspectGitWorktreeChanges } from "./git-worktree.js";
import {
  isHostTargetWithinScope,
  readHostBackupManifest,
  resolveCanonicalHostTarget,
} from "./host-scoped.js";
import {
  checkScope,
  detectFrozenFilesChanged,
  normalizeRepoRelativePath,
  type FrozenSnapshot,
} from "./scope.js";
import {
  verifyScratchWorkspace,
  type VerifyScratchWorkspaceResult,
} from "./scratch-dir.js";

export interface RunVerificationGateInput {
  taskId: string;
  runDirName: string;
  worktreePath?: string;
  inputRef?: string;
  freezePatterns?: readonly string[];
  baselineSnapshot?: FrozenSnapshot;
  expectedArtifacts?: readonly string[];
  hostChangedPaths?: readonly string[];
  acceptCwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  extraSafeEnv?: Record<string, string>;
  signal?: AbortSignal;
  now?: string;
}

export interface RunVerificationGateResult {
  passed: boolean;
  report: GateReport;
  gatePath: string;
  schemaErrors: string[];
  commandResult: IsolatedCommandResult | null;
  scratchResult?: VerifyScratchWorkspaceResult;
}

function isInsideCanonicalDir(canonicalTarget: string, canonicalDir: string): boolean {
  const prefix = canonicalDir.endsWith(path.sep) ? canonicalDir : canonicalDir + path.sep;
  return canonicalTarget === canonicalDir || canonicalTarget.startsWith(prefix);
}

function collectWorkspaceEntries(rootDir: string): {
  files: string[];
  escapedSymlinks: string[];
} {
  if (!fs.existsSync(rootDir)) {
    return { files: [], escapedSymlinks: [] };
  }

  const canonicalRoot = realpathCanonical(rootDir);
  if (!fs.statSync(canonicalRoot).isDirectory()) {
    return { files: [], escapedSymlinks: [] };
  }

  const visitedDirs = new Set<string>([canonicalRoot]);
  const files: string[] = [];
  const escapedSymlinks: string[] = [];

  const walk = (dirPath: string, relPrefix: string): void => {
    const entries = fs.readdirSync(dirPath).sort();
    for (const entry of entries) {
      const relPath = relPrefix.length > 0 ? `${relPrefix}/${entry}` : entry;
      const fullPath = path.join(dirPath, entry);
      const lstat = fs.lstatSync(fullPath);

      if (lstat.isSymbolicLink()) {
        let resolved: string;
        try {
          resolved = realpathCanonical(fullPath);
        } catch {
          escapedSymlinks.push(relPath);
          continue;
        }
        if (!isInsideCanonicalDir(resolved, canonicalRoot)) {
          escapedSymlinks.push(relPath);
          continue;
        }
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          if (!visitedDirs.has(resolved)) {
            visitedDirs.add(resolved);
            walk(resolved, relPath);
          }
        } else {
          files.push(relPath);
        }
      } else if (lstat.isDirectory()) {
        const resolved = realpathCanonical(fullPath);
        if (!visitedDirs.has(resolved)) {
          visitedDirs.add(resolved);
          walk(resolved, relPath);
        }
      } else {
        files.push(relPath);
      }
    }
  };

  walk(canonicalRoot, "");
  return { files, escapedSymlinks };
}

function writeAndReturnFailedSchemaGate(
  store: KilnStore,
  taskId: string,
  runDirName: string,
  runId: string,
  contractVersion: number,
  checkedAt: string,
  schemaErrors: string[],
): RunVerificationGateResult {
  const report = GateReportSchema.parse({
    schema_version: 1,
    run_id: runId,
    contract_version: contractVersion,
    schema_ok: false,
    scope_ok: false,
    artifacts_ok: false,
    out_of_scope_paths: [],
    frozen_files_changed: [],
    accept_exit_code: -1,
    accept_duration_ms: 0,
    escalated_to_l2: false,
    checked_at: checkedAt,
  });

  const gatePath = store.paths.gateYaml(taskId, runDirName);
  writeYamlAtomic(gatePath, report, GateReportSchema);

  return {
    passed: false,
    report,
    gatePath,
    schemaErrors,
    commandResult: null,
  };
}

function checkHostScopedTargets(
  store: KilnStore,
  taskId: string,
  contractScope: readonly string[],
  hostChangedPaths: readonly string[] | undefined,
  receiptFrontmatter: WorkerReceiptFrontmatter,
): { scopeOk: boolean; outOfScopePaths: string[] } {
  const candidates: string[] = [];
  const invalidPaths: string[] = [];
  const manifestPath = store.paths.backupManifest(taskId);
  const hasManifest = fs.existsSync(manifestPath);
  const hasExplicitHostPaths =
    hostChangedPaths !== undefined && hostChangedPaths.length > 0;
  const manifestStagedPaths = new Set<string>();

  if (hasManifest) {
    const manifest = readHostBackupManifest(store, taskId);
    for (const fileEntry of manifest.files) {
      candidates.push(fileEntry.target_canonical_path);
      manifestStagedPaths.add(fileEntry.staged_relative_path);
    }
  }

  if (hostChangedPaths) {
    for (const rawTarget of hostChangedPaths) {
      try {
        candidates.push(resolveCanonicalHostTarget(rawTarget));
      } catch {
        invalidPaths.push(rawTarget);
      }
    }
  }

  const stagedScan = collectWorkspaceEntries(store.paths.stagedDir(taskId));
  if (stagedScan.escapedSymlinks.length > 0) {
    return {
      scopeOk: false,
      outOfScopePaths: [...stagedScan.escapedSymlinks].sort(),
    };
  }

  // Fail closed whenever staged/ contains files absent from the verified backup manifest
  // (whether no manifest exists yet or an extra unmapped file was placed alongside manifested files).
  for (const stagedRel of stagedScan.files) {
    if (!hasManifest || !manifestStagedPaths.has(stagedRel)) {
      invalidPaths.push(stagedRel);
    }
  }

  if (!hasManifest && !hasExplicitHostPaths) {
    const unverifiedPaths = Array.from(
      new Set([...stagedScan.files, ...receiptFrontmatter.changed_paths, ...invalidPaths]),
    ).sort();
    if (unverifiedPaths.length > 0) {
      return {
        scopeOk: false,
        outOfScopePaths: unverifiedPaths,
      };
    }
  } else {
    for (const rawPath of receiptFrontmatter.changed_paths) {
      if (path.isAbsolute(rawPath) || rawPath.startsWith("~/")) {
        try {
          candidates.push(resolveCanonicalHostTarget(rawPath));
        } catch {
          invalidPaths.push(rawPath);
        }
      }
    }
  }

  const outOfScopeSet = new Set<string>(invalidPaths);
  for (const target of candidates) {
    try {
      if (!isHostTargetWithinScope(target, contractScope)) {
        outOfScopeSet.add(target);
      }
    } catch {
      outOfScopeSet.add(target);
    }
  }

  const outOfScopePaths = Array.from(outOfScopeSet).sort();
  return {
    scopeOk: outOfScopePaths.length === 0,
    outOfScopePaths,
  };
}

/**
 * Deterministic verification gate runner:
 * 1. Rejects Post-MVP `external_only`.
 * 2. Validates `RECEIPT.md` against `@kiln/protocol` worker schema, `run_id`,
 *    `contract_version`, and bugfix pre-failure reproduction evidence.
 * 3. Never trusts `accept_result: "pass"` or self-reported `changed_paths`; inspects
 *    the real workspace, frozen test snapshot (marking `escalated_to_l2` for L1),
 *    and executes `card.contract.accept_cmd` in an isolated process group.
 * 4. Persists `GATE.yaml` atomically via `writeYamlAtomic`.
 */
export async function runVerificationGate(
  store: KilnStore,
  input: RunVerificationGateInput,
): Promise<RunVerificationGateResult> {
  const taskId = assertSafeSegment(input.taskId, "taskId");
  const runDirName = assertSafeSegment(input.runDirName, "runDirName");
  const checkedAt = input.now ?? new Date().toISOString();

  const card = store.readTaskCard(taskId);
  if (card.workspace_mode === "external_only") {
    throw new Error('Unsupported workspace_mode: "external_only" is Post-MVP');
  }

  const runMeta = readYamlValidated(store.paths.runYaml(taskId, runDirName), RunMetaSchema);
  if (runMeta.task_id !== taskId) {
    throw new Error(
      `RUN.yaml task_id "${runMeta.task_id}" does not match "${taskId}"`,
    );
  }

  const receiptPath = store.paths.receiptMd(taskId, runDirName);
  let rawReceipt: string;
  try {
    rawReceipt = fs.readFileSync(receiptPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return writeAndReturnFailedSchemaGate(
        store,
        taskId,
        runDirName,
        runMeta.run_id,
        card.contract_version,
        checkedAt,
        [`Missing RECEIPT.md at ${receiptPath}`],
      );
    }
    throw err;
  }
  const parsedReceipt = parseAndValidateReceipt("worker", rawReceipt);

  const schemaErrors: string[] = [];
  if (!parsedReceipt.ok) {
    schemaErrors.push(...parsedReceipt.errors);
  }

  if (runMeta.contract_version !== card.contract_version) {
    schemaErrors.push(
      `RUN.yaml contract_version (${runMeta.contract_version}) does not match card contract_version (${card.contract_version})`,
    );
  }

  if (parsedReceipt.ok) {
    if (parsedReceipt.frontmatter.run_id !== runMeta.run_id) {
      schemaErrors.push(
        `Receipt run_id "${parsedReceipt.frontmatter.run_id}" does not match RUN.yaml run_id "${runMeta.run_id}"`,
      );
    }
    if (parsedReceipt.frontmatter.contract_version !== card.contract_version) {
      schemaErrors.push(
        `Receipt contract_version (${parsedReceipt.frontmatter.contract_version}) does not match card contract_version (${card.contract_version})`,
      );
    }
  }

  if (schemaErrors.length > 0 || !parsedReceipt.ok) {
    return writeAndReturnFailedSchemaGate(
      store,
      taskId,
      runDirName,
      runMeta.run_id,
      card.contract_version,
      checkedAt,
      schemaErrors,
    );
  }

  const receiptFrontmatter = parsedReceipt.frontmatter;
  const spaceConfig = store.readSpace(card.space);
  const freezePatterns = input.freezePatterns ?? spaceConfig?.freeze_patterns ?? [];

  let scopeOk = false;
  let outOfScopePaths: string[] = [];
  let frozenFilesChanged: string[] = [];
  let commandResult: IsolatedCommandResult | null = null;
  let scratchResult: VerifyScratchWorkspaceResult | undefined;

  if (card.workspace_mode === "git_worktree") {
    if (!input.worktreePath) {
      throw new Error("worktreePath is required when verifying a git_worktree task");
    }
    const authoritativeInputRef = input.inputRef ?? runMeta.input_ref;
    if (!authoritativeInputRef) {
      throw new Error(
        `Missing authoritative inputRef (input.inputRef or RUN.yaml input_ref) for git_worktree task "${taskId}" run "${runMeta.run_id}"`,
      );
    }

    const gitChanges = await inspectGitWorktreeChanges(
      input.worktreePath,
      authoritativeInputRef,
    );
    const scopeCheck = checkScope(gitChanges.changedPaths, card.contract.scope);
    scopeOk = scopeCheck.ok;
    outOfScopePaths = scopeCheck.outOfScopePaths;

    if (freezePatterns.length > 0 || input.baselineSnapshot !== undefined) {
      const frozenCheck = detectFrozenFilesChanged({
        rootDir: input.worktreePath,
        freezePatterns,
        acceptCmd: card.contract.accept_cmd,
        baselineHash: card.contract.accept_files_hash,
        changedPaths: gitChanges.changedPaths,
        baselineSnapshot: input.baselineSnapshot,
      });
      frozenFilesChanged = frozenCheck.frozenFilesChanged;
    }

    commandResult = await runIsolatedCommand(card.contract.accept_cmd, {
      cwd: input.acceptCwd ?? input.worktreePath,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      env: input.env,
      extraSafeEnv: input.extraSafeEnv,
      signal: input.signal,
    });
  } else if (card.workspace_mode === "host_scoped") {
    const hostScopeCheck = checkHostScopedTargets(
      store,
      taskId,
      card.contract.scope,
      input.hostChangedPaths,
      receiptFrontmatter,
    );
    scopeOk = hostScopeCheck.scopeOk;
    outOfScopePaths = hostScopeCheck.outOfScopePaths;

    const defaultCwd = fs.existsSync(store.paths.workspaceDir(taskId))
      ? store.paths.workspaceDir(taskId)
      : store.paths.taskDir(taskId);
    const acceptCwd = input.acceptCwd ?? defaultCwd;

    if (freezePatterns.length > 0 || input.baselineSnapshot !== undefined) {
      const frozenCheck = detectFrozenFilesChanged({
        rootDir: acceptCwd,
        freezePatterns,
        acceptCmd: card.contract.accept_cmd,
        baselineHash: card.contract.accept_files_hash,
        baselineSnapshot: input.baselineSnapshot,
      });
      frozenFilesChanged = frozenCheck.frozenFilesChanged;
    }

    commandResult = await runIsolatedCommand(card.contract.accept_cmd, {
      cwd: acceptCwd,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      env: input.env,
      extraSafeEnv: input.extraSafeEnv,
      signal: input.signal,
    });
  } else if (card.workspace_mode === "scratch_dir") {
    const workspaceDir = store.paths.workspaceDir(taskId);
    const scratchScan = collectWorkspaceEntries(workspaceDir);
    const normalizedChanged: string[] = [];
    const invalidScopeEntries: string[] = [];

    for (const rawPath of receiptFrontmatter.changed_paths) {
      try {
        normalizedChanged.push(normalizeRepoRelativePath(rawPath));
      } catch {
        invalidScopeEntries.push(rawPath);
      }
    }

    const allChangedPaths = Array.from(
      new Set([...scratchScan.files, ...normalizedChanged]),
    ).sort();
    const scopeCheck = checkScope(allChangedPaths, card.contract.scope);
    const combinedOutOfScope = Array.from(
      new Set([
        ...invalidScopeEntries,
        ...scratchScan.escapedSymlinks,
        ...scopeCheck.outOfScopePaths,
      ]),
    ).sort();

    scopeOk =
      invalidScopeEntries.length === 0 &&
      scratchScan.escapedSymlinks.length === 0 &&
      scopeCheck.ok;
    outOfScopePaths = combinedOutOfScope;

    scratchResult = await verifyScratchWorkspace({
      workspaceDir,
      expectedArtifacts: input.expectedArtifacts ?? [],
      acceptCmd: card.contract.accept_cmd,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      env: input.env,
      extraSafeEnv: input.extraSafeEnv,
      signal: input.signal,
    });
    commandResult = scratchResult.acceptResult;

    if (freezePatterns.length > 0 || input.baselineSnapshot !== undefined) {
      const frozenCheck = detectFrozenFilesChanged({
        rootDir: workspaceDir,
        freezePatterns,
        acceptCmd: card.contract.accept_cmd,
        baselineHash: card.contract.accept_files_hash,
        changedPaths: allChangedPaths,
        baselineSnapshot: input.baselineSnapshot,
      });
      frozenFilesChanged = frozenCheck.frozenFilesChanged;
    }
  }

  const escalatedToL2 = card.track === "L1" && frozenFilesChanged.length > 0;
  const acceptExitCode = commandResult ? commandResult.exitCode : -1;
  const acceptDurationMs = commandResult ? commandResult.durationMs : 0;
  const scratchArtifactsOk =
    scratchResult === undefined ||
    (scratchResult.missingArtifacts.length === 0 &&
      scratchResult.emptyArtifacts.length === 0 &&
      scratchResult.invalidArtifacts.length === 0);

  const report = GateReportSchema.parse({
    schema_version: 1,
    run_id: runMeta.run_id,
    contract_version: card.contract_version,
    schema_ok: true,
    scope_ok: scopeOk,
    artifacts_ok: scratchArtifactsOk,
    out_of_scope_paths: outOfScopePaths,
    frozen_files_changed: frozenFilesChanged,
    accept_exit_code: acceptExitCode,
    accept_duration_ms: acceptDurationMs,
    escalated_to_l2: escalatedToL2,
    checked_at: checkedAt,
  });

  const gatePath = store.paths.gateYaml(taskId, runDirName);
  writeYamlAtomic(gatePath, report, GateReportSchema);

  const acceptPassed =
    commandResult !== null && commandResult.exitCode === 0 && !commandResult.timedOut;
  const passed =
    report.schema_ok &&
    report.scope_ok &&
    report.artifacts_ok &&
    acceptPassed &&
    receiptFrontmatter.outcome === "completed";

  return {
    passed,
    report,
    gatePath,
    schemaErrors: [],
    commandResult,
    ...(scratchResult !== undefined ? { scratchResult } : {}),
  };
}
