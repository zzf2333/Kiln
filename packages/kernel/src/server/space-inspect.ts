import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceMode } from "@kiln/protocol";
import { buildSanitizedEnv } from "../gate/command-runner.js";
import { KilnStore, assertSafeSegment } from "../store/index.js";
import { ServerHttpError } from "./errors.js";

const execFileAsync = promisify(execFile);

export class InvalidSpacePathError extends Error {
  readonly code = "invalid_repo_path";

  constructor(message: string) {
    super(message);
    this.name = "InvalidSpacePathError";
  }
}

export interface InspectedSpaceInfo {
  repo_path: string;
  suggested_id: string;
  suggested_name: string;
  default_branch: string;
  default_accept_cmd?: string;
  copy_untracked: string[];
  clone_deps: string[];
}

function expandTildePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

async function runGitOptional(repoPath: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
      env: buildSanitizedEnv(),
      encoding: "utf8",
      timeout: 5_000,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function detectDefaultBranch(repoPath: string): Promise<string> {
  const originHead = await runGitOptional(repoPath, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (originHead) {
    const stripped = originHead.replace(/^origin\//, "");
    if (stripped.length > 0) {
      return stripped;
    }
  }

  const currentHead = await runGitOptional(repoPath, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (currentHead) {
    return currentHead;
  }

  try {
    await execFileAsync("git", ["-C", repoPath, "show-ref", "--verify", "--quiet", "refs/heads/main"], {
      env: buildSanitizedEnv(),
      timeout: 5_000,
    });
    return "main";
  } catch {
    // Check master fallback below.
  }

  try {
    await execFileAsync("git", ["-C", repoPath, "show-ref", "--verify", "--quiet", "refs/heads/master"], {
      env: buildSanitizedEnv(),
      timeout: 5_000,
    });
    return "master";
  } catch {
    return "main";
  }
}

function deriveSuggestedSpaceId(baseName: string): string {
  let normalized = baseName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized.length === 0) {
    normalized = "project";
  }
  if (normalized === "local" || normalized === "all") {
    normalized = `${normalized}-repo`;
  }
  return assertSafeSegment(normalized, "spaceId");
}

function detectDefaultAcceptCmd(repoPath: string): string | undefined {
  const pkgPath = path.join(repoPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, unknown>;
      };
      const rawTestScript = parsed.scripts?.test;
      if (
        typeof rawTestScript === "string" &&
        rawTestScript.trim().length > 0 &&
        !/no test specified/i.test(rawTestScript)
      ) {
        if (fs.existsSync(path.join(repoPath, "pnpm-lock.yaml"))) {
          return "pnpm test";
        }
        if (fs.existsSync(path.join(repoPath, "yarn.lock"))) {
          return "yarn test";
        }
        if (
          fs.existsSync(path.join(repoPath, "bun.lock")) ||
          fs.existsSync(path.join(repoPath, "bun.lockb"))
        ) {
          return "bun test";
        }
        return "npm test";
      }
    } catch {
      // Ignore invalid package.json during optional detection.
    }
  }

  if (fs.existsSync(path.join(repoPath, "Cargo.toml"))) {
    return "cargo test";
  }
  if (fs.existsSync(path.join(repoPath, "go.mod"))) {
    return "go test ./...";
  }
  if (
    fs.existsSync(path.join(repoPath, "pyproject.toml")) ||
    fs.existsSync(path.join(repoPath, "pytest.ini"))
  ) {
    return "pytest";
  }
  return undefined;
}

/**
 * Inspects a local directory path, verifies it belongs to a Git repository,
 * normalizes `repo_path` to the canonical Git root, and detects default space metadata.
 */
export async function inspectGitSpacePath(rawPath: string): Promise<InspectedSpaceInfo> {
  const expanded = expandTildePath(rawPath);
  if (expanded.length === 0) {
    throw new InvalidSpacePathError("Repository path cannot be empty");
  }

  const resolved = path.resolve(expanded);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new InvalidSpacePathError(`Directory does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new InvalidSpacePathError(`Path is not a directory: ${resolved}`);
  }

  const canonicalInput = fs.realpathSync(resolved);
  let topLevel: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", canonicalInput, "rev-parse", "--show-toplevel"],
      {
        env: buildSanitizedEnv(),
        encoding: "utf8",
        timeout: 5_000,
      },
    );
    topLevel = stdout.trim();
  } catch {
    throw new InvalidSpacePathError(
      `Directory "${canonicalInput}" is not inside a Git repository`,
    );
  }

  if (topLevel.length === 0) {
    throw new InvalidSpacePathError(
      `Unable to resolve Git repository root for "${canonicalInput}"`,
    );
  }

  const repoPath = fs.realpathSync(topLevel);
  const suggestedName = path.basename(repoPath) || "project";
  const suggestedId = deriveSuggestedSpaceId(suggestedName);
  const defaultBranch = await detectDefaultBranch(repoPath);
  const defaultAcceptCmd = detectDefaultAcceptCmd(repoPath);

  const nodeModulesPath = path.join(repoPath, "node_modules");
  const hasNodeModules =
    fs.existsSync(nodeModulesPath) && fs.statSync(nodeModulesPath).isDirectory();

  return {
    repo_path: repoPath,
    suggested_id: suggestedId,
    suggested_name: suggestedName,
    default_branch: defaultBranch,
    ...(defaultAcceptCmd !== undefined ? { default_accept_cmd: defaultAcceptCmd } : {}),
    copy_untracked: [],
    clone_deps: hasNodeModules ? ["node_modules"] : [],
  };
}

/**
 * Validates that a committed task's `(space, workspace_mode)` pairing is executable
 * before entering the scheduler queue (shared by HTTP commit and MCP `wb_plan(commit_card)`).
 */
export function validateCommitWorkspace(
  store: KilnStore,
  space: string,
  workspaceMode: WorkspaceMode,
): void {
  if (workspaceMode === "external_only") {
    throw new ServerHttpError(400, {
      error: "unsupported_workspace_mode",
      message: 'Unsupported workspace_mode: "external_only" is Post-MVP',
    });
  }

  if (workspaceMode === "git_worktree") {
    if (space === "local") {
      throw new ServerHttpError(400, {
        error: "invalid_workspace_space",
        space,
        message: 'Space "local" does not support git_worktree; use scratch_dir or host_scoped',
      });
    }
    const spaceConfig = store.readSpace(space);
    if (!spaceConfig?.repo_path || !fs.existsSync(spaceConfig.repo_path)) {
      throw new ServerHttpError(400, {
        error: "space_repo_required",
        space,
        message: `Space "${space}" requires a valid configured repo_path for git_worktree`,
      });
    }
  }
}
