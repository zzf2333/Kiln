import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  extractWorkflowToggles,
  flattenWorkflowSteps,
  validateBlueprintAgainstRoster,
  type DiscoveredGitRepo,
  type DiscoverSpacesResponse,
  type PickDirectoryResponse,
  type RosterConfig,
  type SpaceConfig,
  type SpaceFileEntry,
  type WorkflowBlueprint,
  type WorkflowCommandNode,
  type WorkspaceMode,
} from "@kiln/protocol";
import { buildSanitizedEnv } from "../gate/command-runner.js";
import { realpathCanonical } from "../store/fs-atomic.js";
import { KilnStore, assertSafeSegment, resolveKilnHome } from "../store/index.js";
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

  const canonicalInput = realpathCanonical(resolved);
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
      `Directory "${canonicalInput}" is not inside a Git repository（所选目录不是 Git 仓库；项目空间需要 Git 仓库以支持 worktree 隔离，若只需运行临时任务请改选「本机 / 临时任务」）`,
    );
  }

  if (topLevel.length === 0) {
    throw new InvalidSpacePathError(
      `Unable to resolve Git repository root for "${canonicalInput}"`,
    );
  }

  const repoPath = realpathCanonical(topLevel);
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

const DEFAULT_DISCOVER_SUBDIRS = [
  "AI",
  "Projects",
  "projects",
  "Code",
  "code",
  "Workspace",
  "workspace",
  "Work",
  "work",
  "dev",
  "Dev",
  "src",
  "github",
  "GitHub",
  "repos",
  "Repos",
] as const;

const SKIP_DISCOVER_DIR_NAMES = new Set<string>([
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  "vendor",
  "Library",
  "Applications",
  "Movies",
  "Music",
  "Pictures",
  "Downloads",
  "__pycache__",
  ".venv",
  "venv",
  "Pods",
  "DerivedData",
]);

export interface DiscoverLocalGitReposOptions {
  existingSpaces?: Record<string, SpaceConfig>;
  extraRoots?: readonly string[];
  homeDir?: string;
  kilnHome?: string;
  maxDepth?: number;
  maxRepos?: number;
  timeoutMs?: number;
}

function tryRealpathCanonical(targetPath: string): string | null {
  try {
    return realpathCanonical(targetPath);
  } catch {
    return null;
  }
}

function tryStatSync(targetPath: string): fs.Stats | null {
  try {
    return fs.statSync(targetPath);
  } catch {
    return null;
  }
}

function isSameOrInsidePath(candidate: string, ancestor: string): boolean {
  if (candidate === ancestor) {
    return true;
  }
  const prefix = ancestor.endsWith(path.sep) ? ancestor : `${ancestor}${path.sep}`;
  return candidate.startsWith(prefix);
}

function formatDisplayPath(targetPath: string, canonicalHome: string | null): string {
  if (!canonicalHome) {
    return targetPath;
  }
  if (targetPath === canonicalHome) {
    return "~";
  }
  const homePrefix = canonicalHome.endsWith(path.sep)
    ? canonicalHome
    : `${canonicalHome}${path.sep}`;
  if (targetPath.startsWith(homePrefix)) {
    return `~${path.sep}${targetPath.slice(homePrefix.length)}`;
  }
  return targetPath;
}

async function resolveGitEntryDir(repoPath: string, gitEntryPath: string): Promise<string | null> {
  try {
    const lst = await fs.promises.lstat(gitEntryPath);
    if (lst.isDirectory()) {
      return gitEntryPath;
    }
    if (lst.isFile()) {
      const content = await fs.promises.readFile(gitEntryPath, "utf8");
      const match = /^gitdir:\s*(.+)$/im.exec(content);
      if (match?.[1]) {
        const rawGitDir = match[1].trim();
        return path.isAbsolute(rawGitDir) ? rawGitDir : path.resolve(repoPath, rawGitDir);
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function readGitBranchFast(gitDir: string | null): Promise<string> {
  if (!gitDir) {
    return "main";
  }
  try {
    const headRaw = await fs.promises.readFile(path.join(gitDir, "HEAD"), "utf8");
    const trimmed = headRaw.trim();
    const prefix = "ref: refs/heads/";
    if (trimmed.startsWith(prefix)) {
      const branch = trimmed.slice(prefix.length).trim();
      if (branch.length > 0) {
        return branch;
      }
    }
  } catch {
    // Fallback to default branch when HEAD is missing or unreadable.
  }
  return "main";
}

async function readRepoModifiedAt(
  repoPath: string,
  gitDir: string | null,
): Promise<string> {
  let latestMs = 0;
  for (const candidate of [
    repoPath,
    ...(gitDir ? [path.join(gitDir, "index"), path.join(gitDir, "HEAD")] : []),
  ]) {
    try {
      const st = await fs.promises.stat(candidate);
      if (st.mtimeMs > latestMs) {
        latestMs = st.mtimeMs;
      }
    } catch {
      // Ignore missing index or HEAD.
    }
  }
  return new Date(latestMs > 0 ? latestMs : Date.now()).toISOString();
}

/**
 * Discovers local Git repositories in common code roots and registered space parent
 * directories without relying on external daemons such as Paseo.
 */
export async function discoverLocalGitRepos(
  options: DiscoverLocalGitReposOptions = {},
): Promise<DiscoverSpacesResponse> {
  const rawHome = options.homeDir ?? os.homedir();
  const canonicalHome = tryRealpathCanonical(rawHome) ?? path.resolve(rawHome);
  const rawKilnHome = options.kilnHome ?? resolveKilnHome();
  const canonicalKilnHome = tryRealpathCanonical(rawKilnHome) ?? path.resolve(rawKilnHome);

  const maxDepth = options.maxDepth ?? 3;
  const maxRepos = options.maxRepos ?? 150;
  const timeoutMs = options.timeoutMs ?? 2_500;
  const deadline = Date.now() + timeoutMs;

  const existingCanonicalMap = new Map<string, string>();
  const rawCandidates: string[] = [];

  for (const sub of DEFAULT_DISCOVER_SUBDIRS) {
    rawCandidates.push(path.join(canonicalHome, sub));
  }

  for (const sp of Object.values(options.existingSpaces ?? {})) {
    if (sp.id === "local" || !sp.repo_path) {
      continue;
    }
    const expanded = expandTildePath(sp.repo_path);
    const canonicalRepo = tryRealpathCanonical(expanded) ?? path.resolve(expanded);
    existingCanonicalMap.set(canonicalRepo, sp.id);

    const parent = path.dirname(canonicalRepo);
    const grandParent = path.dirname(parent);
    if (
      parent !== canonicalRepo &&
      grandParent !== parent &&
      parent !== canonicalHome
    ) {
      rawCandidates.push(parent);
    }
  }

  for (const extra of options.extraRoots ?? []) {
    const trimmed = extra.trim();
    if (trimmed.length > 0) {
      rawCandidates.push(expandTildePath(trimmed));
    }
  }

  const canonicalCandidates: string[] = [];
  const seenCandidates = new Set<string>();
  for (const candidate of rawCandidates) {
    const canonical = tryRealpathCanonical(candidate);
    if (!canonical || seenCandidates.has(canonical)) {
      continue;
    }
    const st = tryStatSync(canonical);
    if (!st || !st.isDirectory()) {
      continue;
    }
    if (isSameOrInsidePath(canonical, canonicalKilnHome)) {
      continue;
    }
    seenCandidates.add(canonical);
    canonicalCandidates.push(canonical);
  }

  // Deduplicate nested roots (keep ancestors first so shallower roots cover descendants).
  canonicalCandidates.sort((a, b) => a.length - b.length);
  const scanRoots: string[] = [];
  for (const candidate of canonicalCandidates) {
    if (scanRoots.some((root) => isSameOrInsidePath(candidate, root))) {
      continue;
    }
    scanRoots.push(candidate);
  }

  const visitedDirs = new Set<string>();
  const discoveredByPath = new Map<string, DiscoveredGitRepo>();
  const queue: Array<{ dir: string; depth: number }> = scanRoots.map((root) => ({
    dir: root,
    depth: 0,
  }));
  let truncated = false;

  while (queue.length > 0) {
    if (Date.now() >= deadline || discoveredByPath.size >= maxRepos) {
      truncated = true;
      break;
    }

    const current = queue.shift()!;
    const canonicalDir = tryRealpathCanonical(current.dir);
    if (!canonicalDir || visitedDirs.has(canonicalDir)) {
      continue;
    }
    if (isSameOrInsidePath(canonicalDir, canonicalKilnHome)) {
      continue;
    }
    visitedDirs.add(canonicalDir);

    const gitEntryPath = path.join(canonicalDir, ".git");
    const gitDir = await resolveGitEntryDir(canonicalDir, gitEntryPath);
    if (gitDir !== null || tryStatSync(gitEntryPath) !== null) {
      const name = path.basename(canonicalDir) || "project";
      const suggestedId = deriveSuggestedSpaceId(name);
      const existingSpaceId = existingCanonicalMap.get(canonicalDir);
      const [defaultBranch, modifiedAt] = await Promise.all([
        readGitBranchFast(gitDir),
        readRepoModifiedAt(canonicalDir, gitDir),
      ]);

      discoveredByPath.set(canonicalDir, {
        repo_path: canonicalDir,
        display_path: formatDisplayPath(canonicalDir, canonicalHome),
        name,
        suggested_id: suggestedId,
        default_branch: defaultBranch,
        modified_at: modifiedAt,
        already_added: existingSpaceId !== undefined,
        ...(existingSpaceId !== undefined ? { space_id: existingSpaceId } : {}),
      });
      continue;
    }

    if (current.depth >= maxDepth) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(canonicalDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DISCOVER_DIR_NAMES.has(entry.name)) {
        continue;
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      const childPath = path.join(canonicalDir, entry.name);
      if (entry.isSymbolicLink()) {
        const st = tryStatSync(childPath);
        if (!st || !st.isDirectory()) {
          continue;
        }
      }
      queue.push({ dir: childPath, depth: current.depth + 1 });
    }
  }

  const repos = Array.from(discoveredByPath.values()).sort((a, b) => {
    if (a.already_added !== b.already_added) {
      return a.already_added ? 1 : -1;
    }
    const timeCmp = b.modified_at.localeCompare(a.modified_at);
    if (timeCmp !== 0) {
      return timeCmp;
    }
    return a.name.localeCompare(b.name);
  });

  return {
    ok: true,
    repos,
    scanned_roots: scanRoots.map((root) => formatDisplayPath(root, canonicalHome)),
    truncated,
  };
}

export type PickLocalDirectoryExecFn = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; windowsHide?: boolean; encoding?: BufferEncoding },
) => Promise<{ stdout: string; stderr: string }>;

export interface PickLocalDirectoryOptions {
  platform?: NodeJS.Platform;
  execFileFn?: PickLocalDirectoryExecFn;
}

export interface RevealPathResult {
  ok: true;
  path: string;
}

export interface RevealLocalPathOptions {
  platform?: NodeJS.Platform;
  homedir?: string;
  execFileFn?: PickLocalDirectoryExecFn;
}

function extractExecErrorInfo(err: unknown): {
  code: string | number | undefined;
  message: string;
  stderr: string;
} {
  if (typeof err !== "object" || err === null) {
    return { code: undefined, message: String(err), stderr: "" };
  }
  const obj = err as { code?: string | number; message?: string; stderr?: string };
  return {
    code: obj.code,
    message: typeof obj.message === "string" ? obj.message : String(err),
    stderr: typeof obj.stderr === "string" ? obj.stderr : "",
  };
}

function normalizePickedPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length > 1 && (trimmed.endsWith("/") || trimmed.endsWith("\\"))) {
    // Keep Windows drive roots like "C:\" intact while stripping trailing slash on POSIX/subdirs.
    if (!/^[A-Za-z]:\\$/.test(trimmed)) {
      return trimmed.slice(0, -1);
    }
  }
  return trimmed;
}

/**
 * Opens the host OS native folder picker dialog (Finder on macOS, FolderBrowserDialog on Windows,
 * zenity/kdialog on Linux) for local-port users.
 */
export async function pickLocalDirectory(
  options: PickLocalDirectoryOptions = {},
): Promise<PickDirectoryResponse> {
  const platform = options.platform ?? process.platform;
  const execFn: PickLocalDirectoryExecFn =
    options.execFileFn ??
    (async (file, args, opts) => {
      const res = await execFileAsync(file, [...args], {
        encoding: "utf8",
        ...opts,
      });
      return {
        stdout: String(res.stdout ?? ""),
        stderr: String(res.stderr ?? ""),
      };
    });

  if (platform === "darwin") {
    try {
      const { stdout } = await execFn(
        "/usr/bin/osascript",
        ["-e", 'POSIX path of (choose folder with prompt "选择本地 Git 项目目录")'],
        { timeout: 120_000, encoding: "utf8" },
      );
      const picked = normalizePickedPath(stdout);
      if (picked.length === 0) {
        return { ok: true, cancelled: true, path: null };
      }
      return { ok: true, cancelled: false, path: picked };
    } catch (err) {
      const info = extractExecErrorInfo(err);
      if (/-128|User canceled|cancelled/i.test(`${info.stderr}\n${info.message}`)) {
        return { ok: true, cancelled: true, path: null };
      }
      throw new ServerHttpError(500, {
        error: "directory_picker_failed",
        message: `无法打开系统文件夹选择器：${info.message}`,
      });
    }
  }

  if (platform === "win32") {
    const psScript = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog;",
      "$d.Description = '选择本地 Git 项目目录';",
      "$d.ShowNewFolderButton = $false;",
      "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }",
    ].join(" ");
    try {
      const { stdout } = await execFn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-STA", "-Command", psScript],
        { timeout: 120_000, windowsHide: true, encoding: "utf8" },
      );
      const picked = normalizePickedPath(stdout);
      if (picked.length === 0) {
        return { ok: true, cancelled: true, path: null };
      }
      return { ok: true, cancelled: false, path: picked };
    } catch (err) {
      const info = extractExecErrorInfo(err);
      throw new ServerHttpError(500, {
        error: "directory_picker_failed",
        message: `无法打开系统文件夹选择器：${info.message}`,
      });
    }
  }

  if (platform === "linux") {
    try {
      const { stdout } = await execFn(
        "zenity",
        ["--file-selection", "--directory", "--title=选择本地 Git 项目目录"],
        { timeout: 120_000, encoding: "utf8" },
      );
      const picked = normalizePickedPath(stdout);
      return picked.length === 0
        ? { ok: true, cancelled: true, path: null }
        : { ok: true, cancelled: false, path: picked };
    } catch (zenityErr) {
      const zInfo = extractExecErrorInfo(zenityErr);
      if (zInfo.code === 1 || /cancel/i.test(`${zInfo.stderr}\n${zInfo.message}`)) {
        return { ok: true, cancelled: true, path: null };
      }
      if (zInfo.code !== "ENOENT") {
        throw new ServerHttpError(500, {
          error: "directory_picker_failed",
          message: `无法打开系统文件夹选择器：${zInfo.message}`,
        });
      }

      try {
        const { stdout } = await execFn(
          "kdialog",
          ["--getexistingdirectory", os.homedir()],
          { timeout: 120_000, encoding: "utf8" },
        );
        const picked = normalizePickedPath(stdout);
        return picked.length === 0
          ? { ok: true, cancelled: true, path: null }
          : { ok: true, cancelled: false, path: picked };
      } catch (kErr) {
        const kInfo = extractExecErrorInfo(kErr);
        if (kInfo.code === 1 || /cancel/i.test(`${kInfo.stderr}\n${kInfo.message}`)) {
          return { ok: true, cancelled: true, path: null };
        }
        if (kInfo.code === "ENOENT") {
          throw new ServerHttpError(501, {
            error: "directory_picker_unavailable",
            message:
              "当前环境未安装系统文件夹选择器（zenity/kdialog），请从扫描列表选择或手动输入路径",
          });
        }
        throw new ServerHttpError(500, {
          error: "directory_picker_failed",
          message: `无法打开系统文件夹选择器：${kInfo.message}`,
        });
      }
    }
  }

  throw new ServerHttpError(501, {
    error: "directory_picker_unavailable",
    message: `当前平台 (${platform}) 暂不支持系统文件夹选择器，请从扫描列表选择或手动输入路径`,
  });
}

function resolveRevealTargetPath(rawPath: string, homedir: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) {
    throw new ServerHttpError(400, {
      error: "invalid_path",
      message: "Path must be a non-empty local path",
    });
  }

  let candidate = trimmed;
  if (/^file:\/\//i.test(candidate)) {
    const hashIdx = candidate.indexOf("#");
    const noFrag = hashIdx >= 0 ? candidate.slice(0, hashIdx) : candidate;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(noFrag);
    } catch {
      throw new ServerHttpError(400, {
        error: "invalid_path",
        message: "Invalid or non-local file:// URL",
      });
    }
    const hostname = parsedUrl.hostname.toLowerCase();
    if (
      parsedUrl.protocol !== "file:" ||
      parsedUrl.username !== "" ||
      parsedUrl.password !== "" ||
      (hostname !== "" && hostname !== "localhost")
    ) {
      throw new ServerHttpError(400, {
        error: "invalid_path",
        message: "Invalid or non-local file:// URL",
      });
    }
    try {
      candidate = fileURLToPath(parsedUrl);
    } catch {
      throw new ServerHttpError(400, {
        error: "invalid_path",
        message: "Invalid or non-local file:// URL",
      });
    }
  } else if (candidate === "~") {
    candidate = homedir;
  } else if (candidate.startsWith("~/") || candidate.startsWith("~\\")) {
    candidate = path.join(homedir, candidate.slice(2));
  }

  if (candidate.startsWith("\\\\") || /^\/\/[^/]/.test(candidate)) {
    throw new ServerHttpError(400, {
      error: "invalid_path",
      message: "UNC network paths are not allowed",
    });
  }

  if (!path.isAbsolute(candidate)) {
    throw new ServerHttpError(400, {
      error: "invalid_path",
      message: "Path must be an absolute local path",
    });
  }

  const resolved = path.resolve(candidate);
  if (!fs.existsSync(resolved)) {
    throw new ServerHttpError(404, {
      error: "path_not_found",
      path: resolved,
      message: `Local path does not exist: ${resolved}`,
    });
  }
  return resolved;
}

/**
 * Reveals an existing local file or directory in the host file manager (Finder/Explorer/xdg-open)
 * without executing its contents. Strictly restricted to the local listener.
 */
export async function revealLocalPath(
  rawPath: string,
  options: RevealLocalPathOptions = {},
): Promise<RevealPathResult> {
  const homedir = options.homedir ?? os.homedir();
  const resolved = resolveRevealTargetPath(rawPath, homedir);
  const platform = options.platform ?? process.platform;
  const execFn: PickLocalDirectoryExecFn =
    options.execFileFn ??
    (async (file, args, opts) => {
      const res = await execFileAsync(file, [...args], {
        encoding: "utf8",
        ...opts,
      });
      return {
        stdout: String(res.stdout ?? ""),
        stderr: String(res.stderr ?? ""),
      };
    });

  try {
    if (platform === "darwin") {
      await execFn("/usr/bin/open", ["-R", resolved], {
        timeout: 10_000,
        encoding: "utf8",
      });
      return { ok: true, path: resolved };
    }
    if (platform === "win32") {
      await execFn("explorer.exe", [`/select,${resolved}`], {
        timeout: 10_000,
        windowsHide: true,
        encoding: "utf8",
      });
      return { ok: true, path: resolved };
    }
    if (platform === "linux") {
      const stat = fs.statSync(resolved);
      const target = stat.isDirectory() ? resolved : path.dirname(resolved);
      await execFn("xdg-open", [target], {
        timeout: 10_000,
        encoding: "utf8",
      });
      return { ok: true, path: resolved };
    }
  } catch (err) {
    const info = extractExecErrorInfo(err);
    throw new ServerHttpError(500, {
      error: "reveal_path_failed",
      message: `无法在文件管理器中定位路径：${info.message}`,
    });
  }

  throw new ServerHttpError(501, {
    error: "reveal_path_unavailable",
    message: `当前平台 (${platform}) 暂不支持在文件管理器中定位路径`,
  });
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectForbiddenDraftsPrefixes(store: KilnStore): {
  fsRoots: string[];
  textPrefixes: string[];
} {
  const fsRootSet = new Set<string>();
  const textSet = new Set<string>();

  const addFsRoot = (candidate: string): void => {
    const resolved = path.resolve(candidate);
    fsRootSet.add(resolved);
    textSet.add(resolved);
    textSet.add(resolved.replace(/\\/g, "/"));
  };

  addFsRoot(store.paths.draftsDir);
  if (fs.existsSync(store.paths.draftsDir)) {
    try {
      addFsRoot(realpathCanonical(store.paths.draftsDir));
    } catch {
      // Ignore transient filesystem errors during canonical lookup.
    }
  } else if (fs.existsSync(store.paths.home)) {
    try {
      addFsRoot(path.join(realpathCanonical(store.paths.home), "drafts"));
    } catch {
      // Ignore transient filesystem errors during canonical lookup.
    }
  }

  const defaultKilnHome = path.resolve(path.join(os.homedir(), ".kiln"));
  if (path.resolve(store.paths.home) === defaultKilnHome) {
    textSet.add("~/.kiln/drafts");
    textSet.add("~\\.kiln\\drafts");
  }

  return {
    fsRoots: Array.from(fsRootSet),
    textPrefixes: Array.from(textSet).filter((p) => p.length > 0),
  };
}

function isInsideDraftsDir(candidatePath: string, fsRoots: readonly string[]): boolean {
  const expanded = expandTildePath(candidatePath);
  const withoutTrailingGlob = expanded.replace(/([/\\]\*\*?)+$/, "");
  if (!path.isAbsolute(withoutTrailingGlob)) {
    return false;
  }

  const candidates = new Set<string>([path.resolve(withoutTrailingGlob)]);
  let probe = path.resolve(withoutTrailingGlob);
  while (true) {
    if (fs.existsSync(probe)) {
      try {
        const canonicalExisting = realpathCanonical(probe);
        const rel = path.relative(probe, path.resolve(withoutTrailingGlob));
        candidates.add(rel ? path.resolve(canonicalExisting, rel) : canonicalExisting);
      } catch {
        // Ignore unresolvable paths
      }
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) {
      break;
    }
    probe = parent;
  }

  for (const cand of candidates) {
    for (const root of fsRoots) {
      const normalizedCand = process.platform === "win32" ? cand.toLowerCase() : cand;
      const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
      const prefix = normalizedRoot.endsWith(path.sep)
        ? normalizedRoot
        : normalizedRoot + path.sep;
      if (normalizedCand === normalizedRoot || normalizedCand.startsWith(prefix)) {
        return true;
      }
    }
  }
  return false;
}

function containsDraftsReference(text: string, textPrefixes: readonly string[]): boolean {
  const flags = process.platform === "win32" ? "i" : "";
  for (const prefix of textPrefixes) {
    const escaped = escapeRegExp(prefix);
    const pattern = new RegExp(
      `(?:^|[\\s"'\`=:(;|&])${escaped}(?:$|[/\\\\\\s"'\`;|&)])`,
      flags,
    );
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

export function validateCommitWorkflow(
  workspaceMode: WorkspaceMode,
  workflow: WorkflowBlueprint | undefined,
  roster?: RosterConfig | null,
): void {
  if (!workflow) {
    return;
  }
  const toggles = extractWorkflowToggles(workflow);
  const flat = flattenWorkflowSteps(workflow);
  const implNode = flat.find((n) => n.kind === "agent" && n.stage === "implement");
  const gateNode = flat.find((n) => n.kind === "gate");
  const cmdNode = flat.find(
    (n): n is WorkflowCommandNode => n.kind === "command" && n.stage === "deliver",
  );

  if (workspaceMode !== "host_scoped" && toggles.hostTwoPhase) {
    throw new ServerHttpError(400, {
      error: "invalid_workflow_workspace",
      workspaceMode,
      message: 'Only "host_scoped" workspace_mode supports host_op two-phase staging workflows',
    });
  }

  if (workspaceMode === "host_scoped") {
    const hasFullTwoPhase =
      implNode?.kind === "agent" &&
      implNode.mode === "dry_run_only" &&
      gateNode?.kind === "gate" &&
      gateNode.check === "staged_only" &&
      Boolean(cmdNode?.apply_staged) &&
      Boolean(cmdNode?.final_accept_gate);
    if (!hasFullTwoPhase) {
      throw new ServerHttpError(400, {
        error: "invalid_workflow_workspace",
        workspaceMode,
        message:
          '"host_scoped" tasks with explicit workflow must keep dry_run_only + staged_only + apply_staged + final_accept_gate enabled',
      });
    }
  }

  const usesRosterRoles = flat.some(
    (node) => node.kind === "agent" && node.roster_role !== undefined,
  );
  if (usesRosterRoles) {
    const rosterCheck = validateBlueprintAgainstRoster(
      workflow,
      roster?.roster ?? {},
      { workspaceMode },
    );
    if (!rosterCheck.ok) {
      throw new ServerHttpError(400, {
        error: "invalid_workflow_roster",
        errors: rosterCheck.errors,
        message: rosterCheck.errors.join("; "),
      });
    }
  }
}

/**
 * Validates that a committed task contract never references ephemeral `drafts/` directories
 * that are deleted immediately once a draft commits into a task.
 */
export function validateCommitContract(
  store: KilnStore,
  contract: {
    end: string;
    accept_cmd: string;
    scope: readonly string[];
    deliver?: { mode?: string; cmd?: string | null };
  },
): void {
  const { fsRoots, textPrefixes } = collectForbiddenDraftsPrefixes(store);

  const reject = (field: "scope" | "accept_cmd" | "end" | "deliver.cmd"): never => {
    throw new ServerHttpError(400, {
      error: "invalid_contract_path",
      field,
      message:
        "任务契约禁止引用立项临时目录 drafts/（立项提交后会自动删除），请改用持久工作目录或目标白名单路径",
    });
  };

  for (const entry of contract.scope) {
    if (isInsideDraftsDir(entry, fsRoots) || containsDraftsReference(entry, textPrefixes)) {
      reject("scope");
    }
  }
  if (containsDraftsReference(contract.accept_cmd, textPrefixes)) {
    reject("accept_cmd");
  }
  if (containsDraftsReference(contract.end, textPrefixes)) {
    reject("end");
  }
  if (
    contract.deliver?.mode === "run_cmd" &&
    typeof contract.deliver.cmd === "string" &&
    contract.deliver.cmd.trim().length > 0 &&
    containsDraftsReference(contract.deliver.cmd, textPrefixes)
  ) {
    reject("deliver.cmd");
  }
}

const SPACE_FILES_CACHE_TTL_MS = 15_000;
const SPACE_FILES_CACHE_MAX_REPOS = 16;
const spaceFilesCache = new Map<string, { at: number; entries: SpaceFileEntry[] }>();

export function clearSpaceFilesCache(): void {
  spaceFilesCache.clear();
}

function walkBoundedRepoFiles(repoRoot: string, maxFiles = 2_000): string[] {
  const skipDirs = new Set([".git", "node_modules", "dist", "target", ".turbo", ".next"]);
  const out: string[] = [];
  const queue: string[] = [repoRoot];

  while (queue.length > 0 && out.length < maxFiles) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          queue.push(path.join(dir, entry.name));
        }
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        const rel = path.relative(repoRoot, path.join(dir, entry.name)).replace(/\\/g, "/");
        if (rel) {
          out.push(rel);
        }
      }
    }
  }
  return out;
}

async function collectRepoEntries(canonicalRepo: string): Promise<SpaceFileEntry[]> {
  const now = Date.now();
  const cached = spaceFilesCache.get(canonicalRepo);
  if (cached && now - cached.at < SPACE_FILES_CACHE_TTL_MS) {
    return cached.entries;
  }

  let filePaths: string[] = [];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", canonicalRepo, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        env: buildSanitizedEnv(),
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    filePaths = stdout
      .split("\0")
      .map((s) => s.replace(/\\/g, "/").trim())
      .filter(Boolean);
  } catch {
    filePaths = walkBoundedRepoFiles(canonicalRepo);
  }

  const dirs = new Set<string>();
  const seenFiles = new Set<string>();
  for (const rel of filePaths) {
    if (seenFiles.has(rel)) continue;
    seenFiles.add(rel);
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      dirs.add(`${parts.slice(0, i).join("/")}/`);
    }
  }

  const combined: SpaceFileEntry[] = [
    ...Array.from(dirs, (d) => ({ path: d, kind: "dir" as const })),
    ...Array.from(seenFiles, (f) => ({ path: f, kind: "file" as const })),
  ];

  if (spaceFilesCache.size >= SPACE_FILES_CACHE_MAX_REPOS) {
    const oldestKey = spaceFilesCache.keys().next().value;
    if (oldestKey !== undefined) {
      spaceFilesCache.delete(oldestKey);
    }
  }
  spaceFilesCache.set(canonicalRepo, { at: now, entries: combined });
  return combined;
}

function scoreRepoEntry(entry: SpaceFileEntry, query: string): number | null {
  const q = query
    .trim()
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/^[@]+/, "")
    .replace(/^(?:\.\/)+/, "");
  const depth = entry.path.split("/").filter(Boolean).length;

  if (!q) {
    return depth * 10 + (entry.kind === "dir" ? 0 : 2);
  }

  const p = entry.path.toLowerCase();
  if (q.endsWith("/")) {
    if (!p.startsWith(q) || p === q) {
      return null;
    }
    const dirDepth = q.split("/").filter(Boolean).length;
    if (depth === dirDepth + 1) {
      return entry.kind === "dir" ? 0 : 2;
    }
    return 20 + depth * 5 + (entry.kind === "dir" ? 0 : 2);
  }

  const slashIdxInQ = q.lastIndexOf("/");
  if (slashIdxInQ !== -1) {
    const qDirPrefix = q.slice(0, slashIdxInQ + 1);
    const qName = q.slice(slashIdxInQ + 1);
    if (p.startsWith(qDirPrefix) && p !== qDirPrefix) {
      const rest = p.slice(qDirPrefix.length);
      const restTrimmed = rest.endsWith("/") ? rest.slice(0, -1) : rest;
      const isDirectChild = !restTrimmed.includes("/");
      if (isDirectChild) {
        if (restTrimmed === qName) return 0;
        if (restTrimmed.startsWith(qName)) return 2 + (entry.kind === "dir" ? 0 : 1);
        const subIdx = restTrimmed.indexOf(qName);
        if (subIdx !== -1) return 6 + subIdx * 0.01 + (entry.kind === "dir" ? 0 : 1);
      }
      if (rest.startsWith(qName)) return 15 + depth * 2;
      const subRest = rest.indexOf(qName);
      if (subRest !== -1) return 30 + depth * 2 + subRest * 0.01;
    }
  }

  const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
  const slashIdx = trimmed.lastIndexOf("/");
  const base = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;

  if (base === q) return 0 + entry.path.length * 0.001;
  if (base.startsWith(q)) return 10 + entry.path.length * 0.001;
  const baseSub = base.indexOf(q);
  if (baseSub !== -1) return 20 + baseSub * 0.01 + entry.path.length * 0.001;
  const pathSub = p.indexOf(q);
  if (pathSub !== -1) return 40 + pathSub * 0.01 + entry.path.length * 0.001;

  let qi = 0;
  let gap = 0;
  for (let i = 0; i < p.length && qi < q.length; i += 1) {
    if (p[i] === q[qi]) {
      qi += 1;
    } else if (qi > 0) {
      gap += 1;
    }
  }
  if (qi === q.length) {
    return 100 + gap + entry.path.length * 0.001;
  }
  return null;
}

const LOCAL_BLOCKED_NAMES = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".jianhe",
  ".trash",
  "keychains",
  "node_modules",
  ".git",
]);

function isPathInsideRoot(rootDir: string, candidateDir: string): boolean {
  const rel = path.relative(rootDir, candidateDir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function scoreLocalName(name: string, filter: string): number | null {
  if (!filter) return 0;
  const n = name.toLowerCase();
  const f = filter.toLowerCase();
  if (n === f) return 0;
  if (n.startsWith(f)) return 10;
  const idx = n.indexOf(f);
  if (idx !== -1) return 20 + idx * 0.01;
  let fi = 0;
  let gap = 0;
  for (let i = 0; i < n.length && fi < f.length; i += 1) {
    if (n[i] === f[fi]) {
      fi += 1;
    } else if (fi > 0) {
      gap += 1;
    }
  }
  return fi === f.length ? 100 + gap : null;
}

/**
 * Lists files and directories under the user's local home directory (supporting `~/` drill-down)
 * while excluding sensitive credential/system folders and blocking directory traversal.
 */
export function listLocalDirectoryFiles(
  query = "",
  limit = 24,
  options: { rootDir?: string } = {},
): { files: SpaceFileEntry[]; truncated: boolean; rootLabel: string } {
  const safeLimit = Math.max(1, Math.min(80, Number.isFinite(limit) ? Math.floor(limit) : 24));
  const rawRoot = options.rootDir ?? os.homedir();
  let realRoot: string;
  try {
    const stat = fs.statSync(rawRoot);
    if (!stat.isDirectory()) {
      return { files: [], truncated: false, rootLabel: "~" };
    }
    realRoot = fs.realpathSync(rawRoot);
  } catch {
    return { files: [], truncated: false, rootLabel: "~" };
  }

  let normalized = query.trim().replace(/\\/g, "/").replace(/^[@]+/, "");
  if (normalized === "~") {
    normalized = "";
  } else if (normalized.startsWith("~/")) {
    normalized = normalized.slice(2);
  } else if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  if (normalized.startsWith("/")) {
    return { files: [], truncated: false, rootLabel: "~" };
  }
  const segments = normalized.split("/").filter((seg) => seg.length > 0);
  if (segments.some((seg) => seg === ".." || LOCAL_BLOCKED_NAMES.has(seg.toLowerCase()))) {
    return { files: [], truncated: false, rootLabel: "~" };
  }

  let dirPrefix = "";
  let nameFilter = normalized;
  if (normalized.endsWith("/")) {
    dirPrefix = normalized;
    nameFilter = "";
  } else {
    const slashIdx = normalized.lastIndexOf("/");
    if (slashIdx !== -1) {
      dirPrefix = normalized.slice(0, slashIdx + 1);
      nameFilter = normalized.slice(slashIdx + 1);
    }
  }

  const targetDir = dirPrefix ? path.resolve(realRoot, dirPrefix) : realRoot;
  let realTarget: string;
  try {
    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
      return { files: [], truncated: false, rootLabel: "~" };
    }
    realTarget = fs.realpathSync(targetDir);
  } catch {
    return { files: [], truncated: false, rootLabel: "~" };
  }
  if (!isPathInsideRoot(realRoot, realTarget)) {
    return { files: [], truncated: false, rootLabel: "~" };
  }

  let dirEntries: fs.Dirent[];
  try {
    dirEntries = fs.readdirSync(realTarget, { withFileTypes: true });
  } catch {
    return { files: [], truncated: false, rootLabel: "~" };
  }

  const showDotfiles = nameFilter.startsWith(".");
  const scored: Array<{ score: number; entry: SpaceFileEntry }> = [];

  for (const d of dirEntries) {
    if (LOCAL_BLOCKED_NAMES.has(d.name.toLowerCase())) continue;
    if (d.name.startsWith(".") && !showDotfiles) continue;

    const score = scoreLocalName(d.name, nameFilter);
    if (score === null) continue;

    const fullPath = path.join(realTarget, d.name);
    let isDir = false;
    try {
      const resolvedChild = fs.realpathSync(fullPath);
      if (!isPathInsideRoot(realRoot, resolvedChild)) continue;
      const st = fs.statSync(resolvedChild);
      if (st.isDirectory()) {
        isDir = true;
      } else if (!st.isFile()) {
        continue;
      }
    } catch {
      continue;
    }

    scored.push({
      score,
      entry: {
        path: `~/${dirPrefix}${d.name}${isDir ? "/" : ""}`,
        kind: isDir ? "dir" : "file",
      },
    });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.entry.kind !== b.entry.kind) return a.entry.kind === "dir" ? -1 : 1;
    return a.entry.path.localeCompare(b.entry.path);
  });

  const truncated = scored.length > safeLimit;
  return {
    files: scored.slice(0, safeLimit).map((item) => item.entry),
    truncated,
    rootLabel: dirPrefix ? `~/${dirPrefix.replace(/\/+$/, "")}` : "~",
  };
}

/**
 * Lists matching relative files and directories inside a registered Git project space
 * using git index + non-ignored untracked files with a short in-memory cache.
 */
export async function listSpaceFiles(
  repoPath: string,
  query = "",
  limit = 24,
): Promise<{ files: SpaceFileEntry[]; truncated: boolean }> {
  const safeLimit = Math.max(1, Math.min(80, Number.isFinite(limit) ? Math.floor(limit) : 24));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(repoPath);
  } catch {
    return { files: [], truncated: false };
  }
  if (!stat.isDirectory()) {
    return { files: [], truncated: false };
  }

  const canonicalRepo = realpathCanonical(repoPath);
  const allEntries = await collectRepoEntries(canonicalRepo);
  const scored: Array<{ score: number; entry: SpaceFileEntry }> = [];
  for (const entry of allEntries) {
    const score = scoreRepoEntry(entry, query);
    if (score !== null) {
      scored.push({ score, entry });
    }
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.entry.path.localeCompare(b.entry.path);
  });

  const truncated = scored.length > safeLimit;
  return {
    files: scored.slice(0, safeLimit).map((item) => item.entry),
    truncated,
  };
}
