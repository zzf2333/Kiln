import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export const CONFIG_NAMES = [
  "roles",
  "limits",
  "pricing",
  "remote",
  "devices",
  "providers",
  "roster",
] as const;
export type KilnConfigName = (typeof CONFIG_NAMES)[number];

/**
 * Returns true when `ipcPath` targets a Windows Named Pipe (`\\.\pipe\...` or `\\?\pipe\...`).
 */
export function isWindowsNamedPipe(ipcPath: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(ipcPath);
}

function normalizeHomeForPipeHash(kilnHome: string): string {
  if (/^[A-Za-z]:[\\/]/.test(kilnHome) || kilnHome.startsWith("\\\\")) {
    return path.win32.resolve(kilnHome);
  }
  return path.resolve(kilnHome);
}

/**
 * Resolves the default local RPC IPC endpoint for `kilnHome`:
 * - POSIX (`darwin`/`linux`): `<kilnHome>/run/kilnd.sock`
 * - Windows (`win32`): `\\.\pipe\kiln-rpc-<sha256(resolvedHome.toLowerCase()).slice(0, 16)>`
 */
export function resolveDefaultIpcPath(
  kilnHome: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const normalizedHome = normalizeHomeForPipeHash(kilnHome);
    const homeHash = crypto
      .createHash("sha256")
      .update(normalizedHome.toLowerCase())
      .digest("hex")
      .slice(0, 16);
    return `\\\\.\\pipe\\kiln-rpc-${homeHash}`;
  }
  return path.join(path.resolve(kilnHome), "run", "kilnd.sock");
}

/**
 * Resolves the root Kiln home directory (`~/.kiln` by default, overridable via `override` or `KILN_HOME`).
 */
export function resolveKilnHome(override?: string): string {
  if (override !== undefined) {
    if (override.trim().length === 0) {
      throw new Error("kilnHome override cannot be empty");
    }
    return path.resolve(override);
  }

  const envHome = process.env.KILN_HOME;
  if (envHome !== undefined && envHome.trim().length > 0) {
    return path.resolve(envHome);
  }

  return path.resolve(os.homedir(), ".kiln");
}

/**
 * Validates that a dynamic path segment cannot perform traversal or inject control characters.
 */
export function assertSafeSegment(value: string, label = "segment"): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    throw new Error(`Invalid ${label}: must be a non-empty string`);
  }

  const trimmed = value.trim();
  if (value === "." || value === ".." || trimmed === "." || trimmed === "..") {
    throw new Error(`Invalid ${label}: relative path segment "${value}" is forbidden`);
  }

  if (value.includes("/") || value.includes("\\")) {
    throw new Error(`Invalid ${label}: path separator in "${value}" is forbidden`);
  }

  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${label}: control characters are forbidden`);
  }

  return value;
}

function joinUnder(parentDir: string, segment: string, label: string): string {
  const safe = assertSafeSegment(segment, label);
  const parentResolved = path.resolve(parentDir);
  const targetResolved = path.resolve(parentResolved, safe);
  const prefix = parentResolved.endsWith(path.sep)
    ? parentResolved
    : parentResolved + path.sep;

  if (!targetResolved.startsWith(prefix)) {
    throw new Error(`Path "${targetResolved}" escapes parent directory "${parentResolved}"`);
  }

  return targetResolved;
}

/**
 * Canonical path builder aligned with `~/.kiln/` layout (`docs/workflow-and-protocol.md §9.2`).
 * All dynamic segments are validated against traversal before resolution.
 */
export class KilnPaths {
  readonly home: string;

  constructor(kilnHome?: string) {
    this.home = resolveKilnHome(kilnHome);
  }

  get configDir(): string {
    return path.join(this.home, "config");
  }

  get cacheDir(): string {
    return path.join(this.home, "cache");
  }

  get pricingCacheFile(): string {
    return path.join(this.cacheDir, "model-pricing-catalog.json");
  }

  configFile(name: KilnConfigName): string {
    if (!CONFIG_NAMES.includes(name)) {
      throw new Error(`Unknown config name "${String(name)}"`);
    }
    return path.join(this.configDir, `${name}.yaml`);
  }

  get spacesDir(): string {
    return path.join(this.home, "spaces");
  }

  spaceDir(spaceId: string): string {
    return joinUnder(this.spacesDir, spaceId, "spaceId");
  }

  spaceFile(spaceId: string): string {
    return path.join(this.spaceDir(spaceId), "space.yaml");
  }

  get ledgerDir(): string {
    return path.join(this.home, "ledger");
  }

  ledgerFile(spaceId: string): string {
    const safeSpaceId = assertSafeSegment(spaceId, "spaceId");
    return joinUnder(this.ledgerDir, `${safeSpaceId}.yaml`, "ledgerFile");
  }

  get draftsDir(): string {
    return path.join(this.home, "drafts");
  }

  draftDir(draftId: string): string {
    return joinUnder(this.draftsDir, draftId, "draftId");
  }

  draftYaml(draftId: string): string {
    return path.join(this.draftDir(draftId), "draft.yaml");
  }

  draftBriefMd(draftId: string): string {
    return path.join(this.draftDir(draftId), "BRIEF.md");
  }

  draftEvents(draftId: string): string {
    return path.join(this.draftDir(draftId), "events.ndjson");
  }

  get tasksDir(): string {
    return path.join(this.home, "tasks");
  }

  taskDir(taskId: string): string {
    return joinUnder(this.tasksDir, taskId, "taskId");
  }

  cardYaml(taskId: string): string {
    return path.join(this.taskDir(taskId), "card.yaml");
  }

  briefMd(taskId: string): string {
    return path.join(this.taskDir(taskId), "BRIEF.md");
  }

  planMd(taskId: string): string {
    return path.join(this.taskDir(taskId), "PLAN.md");
  }

  advisorRequestYaml(taskId: string): string {
    return path.join(this.taskDir(taskId), "advisor-request.yaml");
  }

  decisionsMd(taskId: string): string {
    return path.join(this.taskDir(taskId), "decisions.md");
  }

  stateEventsNdjson(taskId: string): string {
    return path.join(this.taskDir(taskId), "state_events.ndjson");
  }

  runsDir(taskId: string): string {
    return path.join(this.taskDir(taskId), "runs");
  }

  runDir(taskId: string, runDirName: string): string {
    return joinUnder(this.runsDir(taskId), runDirName, "runDirName");
  }

  runYaml(taskId: string, runDirName: string): string {
    return path.join(this.runDir(taskId, runDirName), "RUN.yaml");
  }

  handoffMd(taskId: string, runDirName: string): string {
    return path.join(this.runDir(taskId, runDirName), "HANDOFF.md");
  }

  receiptMd(taskId: string, runDirName: string): string {
    return path.join(this.runDir(taskId, runDirName), "RECEIPT.md");
  }

  gateYaml(taskId: string, runDirName: string): string {
    return path.join(this.runDir(taskId, runDirName), "GATE.yaml");
  }

  runEventsNdjson(taskId: string, runDirName: string): string {
    return path.join(this.runDir(taskId, runDirName), "events.ndjson");
  }

  runHistoryDir(taskId: string, runDirName: string): string {
    return path.join(this.runDir(taskId, runDirName), "history");
  }

  runHistoryFile(taskId: string, runDirName: string, fileName: string): string {
    return joinUnder(this.runHistoryDir(taskId, runDirName), fileName, "historyFile");
  }

  get workspacesDir(): string {
    return path.join(this.home, "workspaces");
  }

  workspaceDir(taskId: string): string {
    return joinUnder(this.workspacesDir, taskId, "taskId");
  }

  stagedDir(taskId: string): string {
    return path.join(this.workspaceDir(taskId), "staged");
  }

  get backupsDir(): string {
    return path.join(this.home, "backups");
  }

  backupDir(taskId: string): string {
    return joinUnder(this.backupsDir, taskId, "taskId");
  }

  backupManifest(taskId: string): string {
    return path.join(this.backupDir(taskId), "manifest.json");
  }

  get runSockDir(): string {
    return path.join(this.home, "run");
  }

  get kilndSock(): string {
    return resolveDefaultIpcPath(this.home);
  }

  get shutdownTokenFile(): string {
    return path.join(this.runSockDir, "kilnd.shutdown");
  }

  get indexSqlite(): string {
    return path.join(this.home, "index.sqlite");
  }
}
