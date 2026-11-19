import os from "node:os";
import path from "node:path";

export const CONFIG_NAMES = ["roles", "limits", "pricing"] as const;
export type KilnConfigName = (typeof CONFIG_NAMES)[number];

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
    return path.join(this.runSockDir, "kilnd.sock");
  }

  get indexSqlite(): string {
    return path.join(this.home, "index.sqlite");
  }
}
