import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import {
  DEFAULT_REMOTE_PORT,
  DecideRequestSchema,
  DraftCardSchema,
  PrioritySchema,
  PublicRemoteUrlSchema,
  RemoteConfigSchema,
  SpaceConfigSchema,
  TrackSchema,
  WorkspaceModeSchema,
  type DraftCard,
  type PendingDecision,
  type Priority,
  type PublicPairedDevice,
  type RemoteConfig,
  type SpaceConfig,
  type StageId,
  type TailscaleStatusResponse,
  type TaskStatus,
  type Track,
  type WorkspaceMode,
} from "@kiln/protocol";
import {
  BackendRegistry,
  CompositeBackend,
  DEFAULT_KILND_HOST,
  DEFAULT_KILND_PORT,
  InvalidSpacePathError,
  KilnPaths,
  KilnStore,
  KilndServer,
  PaseoBackend,
  PendingDecisionStore,
  ProviderHealthTracker,
  assertSafeSegment,
  buildSanitizedEnv,
  computeUsageSnapshot,
  countRunningLeafTasks,
  deriveTaskStatus,
  detectProvidersConfigOnHost,
  ensureDir,
  inspectGitSpacePath,
  isCompiledKilnBinary,
  isPricingSyncStale,
  probeCliBinary,
  writeFileAtomic,
  type CompositeBackendOptions,
  type EmbeddedStaticAssets,
  type ExecutionBackend,
  type UsageSnapshot,
} from "@kiln/kernel";
import { runStdioMcpServer, type RunStdioMcpServerOptions } from "@kiln/mcp";
import { getEmbeddedPublicAssets } from "./embedded-public.js";
import {
  getServiceStatus,
  installService,
  readPidFile,
  resolveCliKilnHome,
  resolveDefaultCliEntrypoint,
  resolveKilnPidPath,
  runUninstall,
  stopManagedDaemon,
  uninstallService,
  type ExecGitFn,
  type GracefulShutdownRequestFn,
  type KillProcessTreeFn,
  type ServiceOptions,
  type SignalProcessFn,
  type SupportedServicePlatform,
  type SystemControlFn,
  type WindowsRegistryBackend,
} from "./service.js";

const execFileAsync = promisify(execFile);
const CLI_VERSION = "0.0.6";
const HEALTH_TIMEOUT_MS = 1_500;
const API_TIMEOUT_MS = 5_000;
const DAEMON_START_TIMEOUT_MS = 5_000;

export type CliOutputSink = ((chunk: string) => void) | { write(chunk: string): unknown };

export interface SpawnDaemonContext {
  kilnHome: string;
  host: string;
  port: number;
  pidFile: string;
}

export interface SpawnDaemonResult {
  pid: number;
  port?: number;
  baseUrl?: string;
}

export type ExecFileFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface CliRuntimeOptions {
  kilnHome?: string;
  homeDir?: string;
  launchAgentsDir?: string;
  systemdDir?: string;
  windowsRunKey?: string;
  windowsValueName?: string;
  windowsRegistry?: WindowsRegistryBackend;
  socketPath?: string;
  port?: number;
  host?: string;
  fetchImpl?: typeof fetch;
  openUrl?: (url: string) => Promise<void> | void;
  spawnDaemon?: (ctx: SpawnDaemonContext) => Promise<SpawnDaemonResult> | SpawnDaemonResult;
  stopDaemon?: () => Promise<boolean | void> | boolean | void;
  requestGracefulShutdown?: GracefulShutdownRequestFn;
  killProcessTree?: KillProcessTreeFn;
  isDaemonRunning?: () => Promise<boolean> | boolean;
  platform?: NodeJS.Platform;
  stdout?: CliOutputSink;
  stderr?: CliOutputSink;
  executeSystemControl?: SystemControlFn;
  signalProcess?: SignalProcessFn;
  execGit?: ExecGitFn;
  execFileImpl?: ExecFileFn;
  nodeVersion?: string;
  now?: () => Date;
  foregroundSignal?: AbortSignal;
  onForegroundServer?: (server: KilndServer) => void;
  paseoUrl?: string;
  disablePaseo?: boolean;
  enableNativeBackends?: boolean;
  disableNativeBackends?: boolean;
  backendRegistry?: BackendRegistry;
  createPaseoBackend?: (opts: { url?: string; password?: string }) => ExecutionBackend;
  createCompositeBackend?: (opts: CompositeBackendOptions) => ExecutionBackend;
  env?: NodeJS.ProcessEnv;
  mcpOptions?: RunStdioMcpServerOptions;
  embeddedPublicAssets?: EmbeddedStaticAssets | null;
  compiledBinary?: boolean;
}

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  data?: unknown;
}

export interface StatusTaskSummary {
  id: string;
  space: string;
  parent_id: string | null;
  title: string;
  priority: Priority;
  effective_priority: Priority;
  track: Track;
  workspace_mode: WorkspaceMode;
  status: TaskStatus;
  stage: StageId | null;
  round: number | null;
  active_run_id: string | null;
  contract_version: number;
  depends_on: string[];
  created_at: string;
  updated_at: string;
}

export interface CliStatusSummary {
  daemon: "online" | "offline";
  baseUrl: string;
  runningCount: number;
  tasks: StatusTaskSummary[];
  pendingDecisions: PendingDecision[];
  drafts: DraftCard[];
  usage: UsageSnapshot;
  todayUsage?: UsageSnapshot;
}

export interface DoctorCheckResult {
  id: "node" | "git" | "apfs_clone" | "kilnd" | "paseo" | "providers" | "service";
  ok: boolean;
  required: boolean;
  status: "pass" | "warn" | "fail" | "skip";
  detail: string;
  meta?: Record<string, unknown>;
}

export interface DoctorReport {
  ok: boolean;
  platform: NodeJS.Platform;
  checks: DoctorCheckResult[];
}

class CliUsageError extends Error {
  constructor(
    message: string,
    readonly helpText?: string,
  ) {
    super(message);
    this.name = "CliUsageError";
  }
}

const GLOBAL_HELP = [
  "Kiln CLI (kiln / kl)",
  "",
  "Usage:",
  "  kiln <command> [options]",
  "",
  "Commands:",
  "  up [--port <port>] [--host <host>] [--foreground]  Start kilnd (idempotent)",
  "        [--kiln-home <dir>] [--paseo-url <url>] [--no-paseo]",
  "  down                                               Stop managed kilnd",
  "  open [--port <port>] [--host <host>]               Open Kiln web UI",
  "  status [--port <port>] [--host <host>] [--json]    Show tasks, pending decisions, usage",
  '  draft "<idea>" [--space <id>] [--priority <P0-P3>] Create a draft card',
  "        [--track <L1|L2>] [--mode <mode>] [--id <id>]",
  "  decide [task-id] [--option <id>] [--rationale <t>] List or submit pending decisions",
  "        [--apply-ledger] [--decision <id>]",
  "  rm <task-id> [--purge-usage] [--json]               Delete a non-running task (preserves usage by default)",
  "  space <list|add|rm> [args]                         Manage project spaces",
  "  remote <status|enable|disable|pair|devices|revoke|tailscale>",
  "                                                     Manage tunnel-agnostic remote mobile access",
  "  doctor [--port <port>] [--host <host>] [--json]    Verify Node, Git, APFS, kilnd, Paseo, service",
  "  service <install|uninstall|status>                 Manage OS startup service",
  "  uninstall [--purge-data]                           Stop daemon, remove service, inspect worktrees",
  "",
  "Global options:",
  "  -h, --help       Show help",
  "  -v, --version    Show CLI version",
].join("\n");

const COMMAND_HELP: Record<string, string> = {
  up: "Usage: kiln up [--port <port>] [--host <host>] [--kiln-home <dir>] [--foreground] [--paseo-url <url>] [--no-paseo]",
  down: "Usage: kiln down",
  open: "Usage: kiln open [--port <port>] [--host <host>]",
  status: "Usage: kiln status [--port <port>] [--host <host>] [--json]",
  draft:
    'Usage: kiln draft "<idea>" [--id <id>] [--space <id>] [--priority <P0|P1|P2|P3>] [--track <L1|L2>] [--mode <git_worktree|host_scoped|scratch_dir>] [--port <port>] [--host <host>]',
  decide:
    "Usage: kiln decide [task-id] [--option <id>] [--decision <id>] [--rationale <text>] [--apply-ledger] [--port <port>] [--host <host>]",
  space: [
    "Usage:",
    "  kiln space list [--port <port>] [--host <host>] [--json]",
    "  kiln space add [path] [--id <id>] [--name <name>] [--branch <branch>] [--accept-cmd <cmd>] [--copy-untracked <csv>] [--clone-deps <csv>] [--port <port>] [--host <host>] [--json]",
    "  kiln space rm <id> [--port <port>] [--host <host>]",
  ].join("\n"),
  remote: [
    "Usage:",
    "  kiln remote status [--port <port>] [--host <host>] [--json]",
    "  kiln remote enable [--remote-port <port>] [--public-url <url>] [--keep-awake-ac] [--port <port>] [--host <host>] [--json]",
    "  kiln remote disable [--port <port>] [--host <host>] [--json]",
    "  kiln remote pair [--port <port>] [--host <host>] [--json]",
    "  kiln remote devices [--port <port>] [--host <host>] [--json]",
    "  kiln remote revoke <device-id> [--port <port>] [--host <host>] [--json]",
    "  kiln remote revoke --all [--port <port>] [--host <host>] [--json]",
    "  kiln remote tailscale [--port <port>] [--host <host>] [--json]",
  ].join("\n"),
  doctor: "Usage: kiln doctor [--port <port>] [--host <host>] [--json]",
  rm: "Usage: kiln rm <task-id> [--purge-usage] [--port <port>] [--host <host>] [--json]",
  service:
    "Usage: kiln service <install|uninstall|status> [--platform <darwin|linux|win32>] [--label <label>] [--service-name <name>]",
  uninstall: "Usage: kiln uninstall [--purge-data] [--platform <darwin|linux|win32>]",
};

function createOutputCollector(options: CliRuntimeOptions): {
  out: (line: string) => void;
  err: (line: string) => void;
  getStdout: () => string;
  getStderr: () => string;
} {
  let stdoutBuf = "";
  let stderrBuf = "";

  const writeToSink = (sink: CliOutputSink | undefined, text: string): void => {
    if (!sink) return;
    if (typeof sink === "function") {
      sink(text);
    } else {
      sink.write(text);
    }
  };

  return {
    out(line: string): void {
      const chunk = line.endsWith("\n") ? line : `${line}\n`;
      stdoutBuf += chunk;
      writeToSink(options.stdout, chunk);
    },
    err(line: string): void {
      const chunk = line.endsWith("\n") ? line : `${line}\n`;
      stderrBuf += chunk;
      writeToSink(options.stderr, chunk);
    },
    getStdout: () => stdoutBuf,
    getStderr: () => stderrBuf,
  };
}

function parseSafeCliSegment(value: string, label: string, helpText?: string): string {
  try {
    return assertSafeSegment(value, label);
  } catch (err) {
    throw new CliUsageError(err instanceof Error ? err.message : String(err), helpText);
  }
}

function parsePortValue(rawPort: string | undefined, fallback: number, allowZero: boolean): number {
  if (rawPort === undefined) {
    return fallback;
  }
  const trimmed = rawPort.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new CliUsageError(
      `Invalid --port "${rawPort}": expected an integer between ${allowZero ? 0 : 1} and 65535`,
    );
  }
  const parsed = Number(trimmed);
  const min = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > 65535) {
    throw new CliUsageError(
      `Invalid --port "${rawPort}": expected an integer between ${min} and 65535`,
    );
  }
  return parsed;
}

function parseHostValue(rawHost: string | undefined, fallback?: string): string {
  const host = rawHost ?? fallback ?? DEFAULT_KILND_HOST;
  if (host.trim().length === 0) {
    throw new CliUsageError("Host cannot be empty");
  }
  return host.trim();
}

function buildBaseUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

function parsePaseoUrlValue(rawUrl: string | undefined): string | undefined {
  if (rawUrl === undefined) {
    return undefined;
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    throw new CliUsageError(
      'Invalid --paseo-url "": expected a non-empty ws:// or wss:// URL',
      COMMAND_HELP.up,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CliUsageError(
      `Invalid --paseo-url "${rawUrl}": expected a valid ws:// or wss:// URL`,
      COMMAND_HELP.up,
    );
  }
  if ((parsed.protocol !== "ws:" && parsed.protocol !== "wss:") || parsed.hostname.length === 0) {
    throw new CliUsageError(
      `Invalid --paseo-url "${rawUrl}": expected a ws:// or wss:// URL`,
      COMMAND_HELP.up,
    );
  }
  return trimmed;
}

export interface BuildDaemonForegroundArgsInput {
  entrypoint?: string;
  host: string;
  port: number;
  paseoUrl?: string;
  disablePaseo?: boolean;
}

/**
 * Builds the child process argument list used by `kiln up` when spawning
 * `kilnd` in detached foreground mode.
 */
export function buildDaemonForegroundArgs(input: BuildDaemonForegroundArgsInput): string[] {
  const args: string[] = [];
  if (input.entrypoint !== undefined && input.entrypoint.length > 0) {
    args.push(input.entrypoint);
  }
  args.push("up", "--foreground", "--host", input.host, "--port", String(input.port));
  if (input.paseoUrl !== undefined) {
    args.push("--paseo-url", input.paseoUrl);
  }
  if (input.disablePaseo) {
    args.push("--no-paseo");
  }
  return args;
}

function parsePlatformFlag(
  rawPlatform: string | undefined,
  fallback?: NodeJS.Platform,
): SupportedServicePlatform | NodeJS.Platform {
  if (rawPlatform === undefined) {
    return fallback ?? process.platform;
  }
  if (rawPlatform !== "darwin" && rawPlatform !== "linux" && rawPlatform !== "win32") {
    throw new CliUsageError(
      `Invalid --platform "${rawPlatform}": expected "darwin", "linux", or "win32"`,
      COMMAND_HELP.service,
    );
  }
  return rawPlatform;
}

function buildServiceOptions(
  options: CliRuntimeOptions,
  platformOverride?: SupportedServicePlatform | NodeJS.Platform,
): ServiceOptions {
  return {
    platform: platformOverride ?? options.platform,
    homeDir: options.homeDir,
    kilnHome: options.kilnHome,
    launchAgentsDir: options.launchAgentsDir,
    systemdDir: options.systemdDir,
    windowsRunKey: options.windowsRunKey,
    windowsValueName: options.windowsValueName,
    windowsRegistry: options.windowsRegistry,
    executeSystemControl: options.executeSystemControl,
  };
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: init?.signal ?? controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function probeHealth(
  fetchImpl: typeof fetch,
  baseUrl: string,
): Promise<{ ok: true; pid: number | null; version?: string } | { ok: false }> {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${baseUrl}/api/health`,
      { method: "GET" },
      HEALTH_TIMEOUT_MS,
    );
    if (!res.ok) {
      return { ok: false };
    }
    const json = (await res.json()) as {
      ok?: unknown;
      pid?: unknown;
      version?: unknown;
    };
    if (json.ok !== true) {
      return { ok: false };
    }
    return {
      ok: true,
      pid: typeof json.pid === "number" ? json.pid : null,
      ...(typeof json.version === "string" ? { version: json.version } : {}),
    };
  } catch {
    return { ok: false };
  }
}

async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  if (text.trim().length === 0) {
    return `HTTP ${res.status}`;
  }
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
    if (typeof parsed.message === "string" && parsed.message.length > 0) {
      return parsed.message;
    }
    if (typeof parsed.error === "string" && parsed.error.length > 0) {
      return parsed.error;
    }
  } catch {
    // Plain text fallback below.
  }
  return text.trim();
}

function hasLocalStoreData(kilnHome: string): boolean {
  const paths = new KilnPaths(kilnHome);
  return (
    fs.existsSync(paths.indexSqlite) ||
    fs.existsSync(paths.tasksDir) ||
    fs.existsSync(paths.draftsDir)
  );
}

function emptyUsageSnapshot(): UsageSnapshot {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    cacheNetSavedUsd: 0,
    unknownPricingModels: [],
    byAgent: {},
    byModel: {},
  };
}

function readOfflineStatusSummary(kilnHome: string, baseUrl: string, now: Date): CliStatusSummary {
  if (!hasLocalStoreData(kilnHome)) {
    const empty = emptyUsageSnapshot();
    return {
      daemon: "offline",
      baseUrl,
      runningCount: 0,
      tasks: [],
      pendingDecisions: [],
      drafts: [],
      usage: empty,
      todayUsage: empty,
    };
  }

  const store = new KilnStore({ kilnHome });
  try {
    const pricing = store.readConfig("pricing");
    const taskRows = store.listTasks();
    const tasks: StatusTaskSummary[] = taskRows.map((row) => {
      const card = store.readTaskCard(row.id);
      const derived = deriveTaskStatus(card, store.readStateEvents(row.id));
      return {
        id: row.id,
        space: row.space,
        parent_id: row.parent_id,
        title: row.title,
        priority: row.priority,
        effective_priority: row.effective_priority,
        track: row.track,
        workspace_mode: row.workspace_mode,
        status: row.status,
        stage: derived.stage,
        round: derived.round,
        active_run_id: derived.activeRunId,
        contract_version: row.contract_version,
        depends_on: card.depends_on,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    });

    const pendingDecisions = new PendingDecisionStore(store).listAll();
    const drafts = store.listDrafts();
    const allTurns = store.listUsageTurns();
    const usage = computeUsageSnapshot(allTurns, pricing);
    const todayPrefix = now.toISOString().slice(0, 10);
    const todayTurns = allTurns.filter((turn) => turn.recorded_at.startsWith(todayPrefix));
    const todayUsage = computeUsageSnapshot(todayTurns, pricing);

    return {
      daemon: "offline",
      baseUrl,
      runningCount: countRunningLeafTasks(store),
      tasks,
      pendingDecisions,
      drafts,
      usage,
      todayUsage,
    };
  } finally {
    store.close();
  }
}

async function fetchStatusSummary(
  options: CliRuntimeOptions,
  kilnHome: string,
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; summary: CliStatusSummary } | { ok: false; error: string }> {
  const now = options.now?.() ?? new Date();
  const explicitRunning = options.isDaemonRunning ? await options.isDaemonRunning() : null;

  if (explicitRunning === false) {
    return { ok: true, summary: readOfflineStatusSummary(kilnHome, baseUrl, now) };
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(
      fetchImpl,
      `${baseUrl}/api/bootstrap`,
      { method: "GET" },
      API_TIMEOUT_MS,
    );
  } catch {
    return { ok: true, summary: readOfflineStatusSummary(kilnHome, baseUrl, now) };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: `Failed to fetch status (${res.status}): ${await readErrorMessage(res)}`,
    };
  }

  const body = (await res.json()) as {
    tasks?: StatusTaskSummary[];
    pendingDecisions?: PendingDecision[];
    drafts?: DraftCard[];
    usage?: UsageSnapshot;
    runningCount?: number;
  };

  return {
    ok: true,
    summary: {
      daemon: "online",
      baseUrl,
      runningCount: body.runningCount ?? 0,
      tasks: body.tasks ?? [],
      pendingDecisions: body.pendingDecisions ?? [],
      drafts: body.drafts ?? [],
      usage: body.usage ?? emptyUsageSnapshot(),
    },
  };
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

function formatStatusReport(summary: CliStatusSummary): string {
  const counts: Record<TaskStatus, number> = {
    queued: 0,
    running: 0,
    paused: 0,
    waiting: 0,
    external: 0,
    done: 0,
    cancelled: 0,
  };
  for (const task of summary.tasks) {
    counts[task.status] += 1;
  }

  const lines: string[] = [
    `Daemon: ${summary.daemon === "online" ? `online (${summary.baseUrl})` : "offline (local store)"}`,
    `Running: ${summary.runningCount} | Queued: ${counts.queued} | Paused: ${counts.paused} | Waiting: ${counts.waiting} | Done: ${counts.done} | Drafts: ${summary.drafts.length}`,
    `API Usage: ${formatUsd(summary.usage.costUsd)} | ${summary.usage.totalTokens} tokens (in: ${summary.usage.inputTokens}, cached: ${summary.usage.cachedInputTokens}, out: ${summary.usage.outputTokens})`,
  ];

  if (summary.todayUsage) {
    lines.push(
      `Today Usage: ${formatUsd(summary.todayUsage.costUsd)} | ${summary.todayUsage.totalTokens} tokens`,
    );
  }

  const activeList = summary.tasks.filter(
    (task) =>
      task.status === "running" ||
      task.status === "queued" ||
      task.status === "paused" ||
      task.status === "waiting",
  );
  if (activeList.length > 0) {
    lines.push("", "Active / Queued / Paused / Waiting Tasks:");
    for (const task of activeList) {
      const stagePart = task.stage ? ` stage=${task.stage}` : "";
      lines.push(
        `- [${task.status}] ${task.id} (${task.effective_priority}, ${task.space}${stagePart}) — ${task.title}`,
      );
    }
  }

  if (summary.pendingDecisions.length > 0) {
    lines.push("", `Pending Decisions (${summary.pendingDecisions.length}):`);
    for (const dec of summary.pendingDecisions) {
      lines.push(`- ${dec.task_id} [${dec.id}]: ${dec.question}`);
    }
  }

  return lines.join("\n");
}

function formatPendingDecisionBlock(dec: PendingDecision): string[] {
  const lines = [
    `- ${dec.task_id} (decision: ${dec.id}, category: ${dec.category})`,
    `  Reason: ${dec.reason}`,
    `  Question: ${dec.question}`,
    "  Options:",
  ];
  for (const opt of dec.options) {
    const marker = opt.recommended ? "* " : "  ";
    const recTag = opt.recommended ? " [recommended]" : "";
    const costNote = opt.cost_note ? ` — ${opt.cost_note}` : "";
    const ledgerNote = opt.ledger_rule ? ` [ledger_rule: ${opt.ledger_rule}]` : "";
    lines.push(
      `    ${marker}${opt.id}${recTag} (${opt.action}): ${opt.label}${costNote}${ledgerNote}`,
    );
  }
  return lines;
}

async function defaultExecFile(
  file: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(file, [...args], {
    env: buildSanitizedEnv(),
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

/**
 * Reads trailing log bytes appended after `startOffset` for startup failure diagnostics.
 */
export function readNewLogTail(logPath: string, startOffset: number, maxBytes = 2048): string {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size <= startOffset) {
      return "";
    }
    const totalNew = stat.size - startOffset;
    const readBytes = Math.min(totalNew, maxBytes);
    const readOffset = stat.size - readBytes;
    const buf = Buffer.alloc(readBytes);
    const fd = fs.openSync(logPath, "r");
    try {
      let bytesReadTotal = 0;
      while (bytesReadTotal < readBytes) {
        const n = fs.readSync(
          fd,
          buf,
          bytesReadTotal,
          readBytes - bytesReadTotal,
          readOffset + bytesReadTotal,
        );
        if (n === 0) break;
        bytesReadTotal += n;
      }
      return buf.subarray(0, bytesReadTotal).toString("utf8").trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

async function handleUp(
  args: readonly string[],
  options: CliRuntimeOptions,
  io: ReturnType<typeof createOutputCollector>,
): Promise<CliRunResult> {
  const parsed = parseArgs({
    args: [...args],
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string" },
      "kiln-home": { type: "string" },
      foreground: { type: "boolean", short: "f", default: false },
      "paseo-url": { type: "string" },
      "no-paseo": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (parsed.values.help) {
    io.out(COMMAND_HELP.up!);
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  const kilnHome = resolveCliKilnHome({
    ...options,
    ...(parsed.values["kiln-home"] !== undefined ? { kilnHome: parsed.values["kiln-home"] } : {}),
  });
  const host = parseHostValue(parsed.values.host, options.host);
  const allowZeroPort = Boolean(parsed.values.foreground) || Boolean(options.spawnDaemon);
  const port = parsePortValue(
    parsed.values.port,
    options.port ?? DEFAULT_KILND_PORT,
    allowZeroPort,
  );
  const disablePaseo =
    Boolean(parsed.values["no-paseo"]) ||
    Boolean(options.disablePaseo) ||
    process.env.KILN_DISABLE_PASEO === "1" ||
    process.env.KILN_DISABLE_PASEO === "true";
  const explicitCliOrOptionPaseoUrl = parsed.values["paseo-url"] ?? options.paseoUrl;
  const rawPaseoUrl =
    explicitCliOrOptionPaseoUrl ?? (disablePaseo ? undefined : process.env.PASEO_URL);
  const paseoUrl = parsePaseoUrlValue(rawPaseoUrl);

  const baseUrl = buildBaseUrl(host, port);
  const pidFile = resolveKilnPidPath(kilnHome);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const explicitRunning = options.isDaemonRunning ? await options.isDaemonRunning() : null;

  if (explicitRunning !== false) {
    const health = await probeHealth(fetchImpl, baseUrl);
    if (health.ok || explicitRunning === true) {
      const pid = health.ok ? health.pid : readPidFile(pidFile).pid;
      const pidText = pid !== null ? ` (PID ${pid})` : "";
      io.out(`kilnd is already running at ${baseUrl}${pidText}.`);
      return {
        exitCode: 0,
        stdout: io.getStdout(),
        stderr: io.getStderr(),
        data: { alreadyRunning: true, pid, port, host, baseUrl },
      };
    }
  }

  if (options.spawnDaemon) {
    const spawned = await options.spawnDaemon({ kilnHome, host, port, pidFile });
    writeFileAtomic(pidFile, `${spawned.pid}\n`);
    const effectivePort = spawned.port ?? port;
    const effectiveUrl = spawned.baseUrl ?? buildBaseUrl(host, effectivePort);
    io.out(`kilnd started at ${effectiveUrl} (PID ${spawned.pid}).`);
    return {
      exitCode: 0,
      stdout: io.getStdout(),
      stderr: io.getStderr(),
      data: {
        alreadyRunning: false,
        pid: spawned.pid,
        port: effectivePort,
        host,
        baseUrl: effectiveUrl,
      },
    };
  }

  if (parsed.values.foreground) {
    const ownsRegistry = options.backendRegistry === undefined;
    const backendRegistry = options.backendRegistry ?? new BackendRegistry();
    let registryDisposed = false;
    const disposeOwnedRegistry = async (): Promise<void> => {
      if (ownsRegistry && !registryDisposed) {
        registryDisposed = true;
        await backendRegistry.disposeAll();
      }
    };

    let server: KilndServer | null = null;
    try {
      const providerHealth = new ProviderHealthTracker();
      const shouldRegisterNativeComposite =
        ownsRegistry &&
        options.createPaseoBackend === undefined &&
        !options.disableNativeBackends &&
        (!process.env.VITEST ||
          options.enableNativeBackends === true ||
          fs.existsSync(new KilnPaths(kilnHome).configFile("providers")));

      if (shouldRegisterNativeComposite && !backendRegistry.has("composite")) {
        const tempStore = new KilnStore({ kilnHome });
        let initialProviders;
        try {
          const hasSavedProviders = fs.existsSync(tempStore.paths.configFile("providers"));
          initialProviders = tempStore.readEffectiveProvidersConfig();
          if (!hasSavedProviders) {
            initialProviders = await detectProvidersConfigOnHost(initialProviders, {
              healthTracker: providerHealth,
            });
            tempStore.writeConfig("providers", initialProviders);
          }
        } finally {
          tempStore.close();
        }
        const compositeOpts: CompositeBackendOptions = {
          backendId: "composite",
          kilnHome,
          initialConfig: initialProviders,
          healthTracker: providerHealth,
          onProviderStatusChanged: (status) => {
            server?.sseHub.publish({
              type: "provider.status",
              providerId: status.provider_id,
              status: status.status,
              ...(status.cooldown_until ? { cooldownUntil: status.cooldown_until } : {}),
              ...(status.detail ? { detail: status.detail } : {}),
              at: new Date().toISOString(),
            });
          },
          getUsageContext: () => ({
            localTurns: server ? server.store.listUsageTurns() : [],
            pricing: server ? server.store.readConfig("pricing") : null,
          }),
        };
        const compositeBackend = options.createCompositeBackend
          ? options.createCompositeBackend(compositeOpts)
          : new CompositeBackend(compositeOpts);
        backendRegistry.register(compositeBackend);
      }

      if (
        (ownsRegistry || options.createPaseoBackend !== undefined) &&
        !disablePaseo &&
        !backendRegistry.has("paseo") &&
        (!shouldRegisterNativeComposite ||
          options.createPaseoBackend !== undefined ||
          explicitCliOrOptionPaseoUrl !== undefined)
      ) {
        const paseoOpts: { url?: string; password?: string } = {
          ...(paseoUrl ? { url: paseoUrl } : {}),
          ...(process.env.PASEO_PASSWORD ? { password: process.env.PASEO_PASSWORD } : {}),
        };
        const paseoBackend = options.createPaseoBackend
          ? options.createPaseoBackend(paseoOpts)
          : new PaseoBackend(paseoOpts);
        backendRegistry.register(paseoBackend);
      }

      const embeddedPublicAssets =
        options.embeddedPublicAssets !== undefined
          ? options.embeddedPublicAssets
          : getEmbeddedPublicAssets();
      const shutdownAc = options.foregroundSignal ? new AbortController() : null;
      server = new KilndServer({
        kilnHome,
        host,
        port,
        ...(options.socketPath !== undefined ? { socketPath: options.socketPath } : {}),
        ...(embeddedPublicAssets !== null ? { embeddedPublicAssets } : {}),
        enableOrchestrator: true,
        backendRegistry,
        providerHealth,
        ...(shutdownAc
          ? {
              onShutdownRequested: () => {
                shutdownAc.abort();
              },
            }
          : {}),
      });
      const addr = await server.start();
      writeFileAtomic(pidFile, `${process.pid}\n`);
      if (!process.env.VITEST && isPricingSyncStale(server.store.readConfig("pricing"))) {
        void server.syncModelPricing({ force: false }).catch(() => {});
      }
      io.out(
        `kilnd listening in foreground at ${addr.baseUrl} (PID ${process.pid}, socket ${addr.socketPath}).`,
      );
      options.onForegroundServer?.(server);

      if (options.foregroundSignal && shutdownAc) {
        await new Promise<void>((resolve) => {
          if (options.foregroundSignal!.aborted || shutdownAc.signal.aborted) {
            resolve();
            return;
          }
          const done = (): void => {
            options.foregroundSignal?.removeEventListener("abort", done);
            shutdownAc.signal.removeEventListener("abort", done);
            resolve();
          };
          options.foregroundSignal!.addEventListener("abort", done, { once: true });
          shutdownAc.signal.addEventListener("abort", done, { once: true });
        });
        await server.stop();
        fs.rmSync(pidFile, { force: true });
        await disposeOwnedRegistry();
      }

      return {
        exitCode: 0,
        stdout: io.getStdout(),
        stderr: io.getStderr(),
        data: {
          alreadyRunning: false,
          pid: process.pid,
          port: addr.port,
          host,
          baseUrl: addr.baseUrl,
          socketPath: addr.socketPath,
        },
      };
    } catch (err) {
      if (server) {
        await server.stop().catch(() => {});
      }
      await disposeOwnedRegistry().catch(() => {});
      throw err;
    }
  }

  const compiledBinary = options.compiledBinary ?? isCompiledKilnBinary();
  const entrypoint = compiledBinary ? undefined : resolveDefaultCliEntrypoint();
  const logDir = path.join(kilnHome, "logs");
  ensureDir(logDir);
  const logPath = path.join(logDir, "kilnd.log");
  const outFd = fs.openSync(logPath, "a");
  const logStartOffset = fs.fstatSync(outFd).size;

  let childPid: number | undefined;
  let earlyExitError: string | null = null;
  let childExited = false;

  try {
    const spawnArgs = buildDaemonForegroundArgs({
      entrypoint,
      host,
      port,
      ...(explicitCliOrOptionPaseoUrl !== undefined && paseoUrl !== undefined ? { paseoUrl } : {}),
      disablePaseo: Boolean(parsed.values["no-paseo"]) || Boolean(options.disablePaseo),
    });
    const isElectronNode = Boolean((process.versions as { electron?: string }).electron);
    const child = spawn(process.execPath, spawnArgs, {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", outFd, outFd],
      env: {
        ...process.env,
        ...(isElectronNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        KILN_HOME: kilnHome,
      },
    });
    childPid = child.pid;
    child.once("error", (err) => {
      childExited = true;
      earlyExitError = err.message;
    });
    child.once("exit", (code, signal) => {
      childExited = true;
      if (code !== 0) {
        earlyExitError = `kilnd exited early (code=${String(code)}, signal=${String(signal)})`;
      }
    });
    child.unref();
  } finally {
    fs.closeSync(outFd);
  }

  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (childExited) {
      const logTail = readNewLogTail(logPath, logStartOffset);
      const baseErr = earlyExitError ?? "kilnd exited before becoming healthy.";
      io.err(logTail.length > 0 ? `${baseErr}\n--- kilnd.log ---\n${logTail}` : baseErr);
      return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
    }
    const health = await probeHealth(fetchImpl, baseUrl);
    if (health.ok) {
      const pid = health.pid ?? childPid ?? null;
      if (pid !== null && !fs.existsSync(pidFile)) {
        writeFileAtomic(pidFile, `${pid}\n`);
      }
      io.out(`kilnd started at ${baseUrl}${pid !== null ? ` (PID ${pid})` : ""}.`);
      return {
        exitCode: 0,
        stdout: io.getStdout(),
        stderr: io.getStderr(),
        data: { alreadyRunning: false, pid, port, host, baseUrl },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  io.err(`Timed out waiting for kilnd to respond at ${baseUrl}/api/health.`);
  return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
}

async function handleDown(
  args: readonly string[],
  options: CliRuntimeOptions,
  io: ReturnType<typeof createOutputCollector>,
): Promise<CliRunResult> {
  const parsed = parseArgs({
    args: [...args],
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (parsed.values.help) {
    io.out(COMMAND_HELP.down!);
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  const kilnHome = resolveCliKilnHome(options);
  const res = await stopManagedDaemon({
    kilnHome,
    platform: options.platform,
    socketPath: options.socketPath,
    stopDaemon: options.stopDaemon,
    requestGracefulShutdown: options.requestGracefulShutdown,
    signalProcess: options.signalProcess,
    killProcessTree: options.killProcessTree,
  });

  if (res.stopped) {
    io.out(`Stopped kilnd${res.pid !== null ? ` (PID ${res.pid})` : ""}.`);
  } else if (res.removedStalePid) {
    io.out(`Removed stale kilnd.pid${res.pid !== null ? ` (PID ${res.pid} not running)` : ""}.`);
  } else {
    io.out("kilnd is not running.");
  }

  return {
    exitCode: 0,
    stdout: io.getStdout(),
    stderr: io.getStderr(),
    data: res,
  };
}

async function handleOpen(
  args: readonly string[],
  options: CliRuntimeOptions,
  io: ReturnType<typeof createOutputCollector>,
): Promise<CliRunResult> {
  const parsed = parseArgs({
    args: [...args],
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (parsed.values.help) {
    io.out(COMMAND_HELP.open!);
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  const host = parseHostValue(parsed.values.host, options.host);
  const port = parsePortValue(parsed.values.port, options.port ?? DEFAULT_KILND_PORT, false);
  const url = buildBaseUrl(host, port);
  const platform = options.platform ?? process.platform;

  if (options.openUrl) {
    await options.openUrl(url);
    io.out(`Opened ${url}`);
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr(), data: { url } };
  }

  const execImpl = options.execFileImpl ?? defaultExecFile;
  if (platform === "darwin") {
    await execImpl("open", [url]);
    io.out(`Opened ${url}`);
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr(), data: { url } };
  }
  if (platform === "linux") {
    try {
      await execImpl("xdg-open", [url]);
      io.out(`Opened ${url}`);
    } catch {
      io.out(`Open Kiln UI in your browser: ${url}`);
    }
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr(), data: { url } };
  }
  if (platform === "win32") {
    try {
      await execImpl("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
      io.out(`Opened ${url}`);
    } catch {
      io.out(`Open Kiln UI in your browser: ${url}`);
    }
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr(), data: { url } };
  }

  io.out(`Open Kiln UI in your browser: ${url}`);
  return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr(), data: { url } };
}

async function handleStatus(
  args: readonly string[],
  options: CliRuntimeOptions,
  io: ReturnType<typeof createOutputCollector>,
): Promise<CliRunResult> {
  const parsed = parseArgs({
    args: [...args],
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (parsed.values.help) {
    io.out(COMMAND_HELP.status!);
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  const kilnHome = resolveCliKilnHome(options);
  const host = parseHostValue(parsed.values.host, options.host);
  const port = parsePortValue(parsed.values.port, options.port ?? DEFAULT_KILND_PORT, false);
  const baseUrl = buildBaseUrl(host, port);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const statusRes = await fetchStatusSummary(options, kilnHome, baseUrl, fetchImpl);
  if (!statusRes.ok) {
    io.err(statusRes.error);
    return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  if (parsed.values.json) {
    io.out(JSON.stringify(statusRes.summary, null, 2));
  } else {
    io.out(formatStatusReport(statusRes.summary));
  }

  return {
    exitCode: 0,
    stdout: io.getStdout(),
    stderr: io.getStderr(),
    data: statusRes.summary,
  };
}

async function handleDraft(
  args: readonly string[],
  options: CliRuntimeOptions,
  io: ReturnType<typeof createOutputCollector>,
): Promise<CliRunResult> {
  const parsed = parseArgs({
    args: [...args],
    options: {
      id: { type: "string" },
      space: { type: "string", short: "s" },
      priority: { type: "string", short: "P" },
      track: { type: "string", short: "t" },
      mode: { type: "string", short: "m" },
      port: { type: "string", short: "p" },
      host: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (parsed.values.help) {
    io.out(COMMAND_HELP.draft!);
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  if (parsed.positionals.length !== 1) {
    throw new CliUsageError("draft requires exactly one <idea> argument", COMMAND_HELP.draft);
  }
  const title = parsed.positionals[0]!.trim();
  if (title.length === 0) {
    throw new CliUsageError("Draft idea cannot be empty", COMMAND_HELP.draft);
  }

  const draftId = parseSafeCliSegment(
    parsed.values.id ?? `d-${randomUUID().slice(0, 8)}`,
    "draftId",
    COMMAND_HELP.draft,
  );
  const space = parseSafeCliSegment(parsed.values.space ?? "local", "space", COMMAND_HELP.draft);

  const priorityResult = PrioritySchema.safeParse(parsed.values.priority ?? "P2");
  if (!priorityResult.success) {
    throw new CliUsageError(
      `Invalid --priority "${String(parsed.values.priority)}": expected P0, P1, P2, or P3`,
      COMMAND_HELP.draft,
    );
  }

  const trackResult = TrackSchema.safeParse(parsed.values.track ?? "L2");
  if (!trackResult.success) {
    throw new CliUsageError(
      `Invalid --track "${String(parsed.values.track)}": expected L1 or L2`,
      COMMAND_HELP.draft,
    );
  }
  if (trackResult.data === "L3") {
    throw new CliUsageError('Track "L3" is Post-MVP and not supported yet', COMMAND_HELP.draft);
  }

  const modeResult = WorkspaceModeSchema.safeParse(parsed.values.mode ?? "git_worktree");
  if (!modeResult.success) {
    throw new CliUsageError(
      `Invalid --mode "${String(parsed.values.mode)}": expected git_worktree, host_scoped, or scratch_dir`,
      COMMAND_HELP.draft,
    );
  }
  if (modeResult.data === "external_only") {
    throw new CliUsageError(
      'Workspace mode "external_only" is Post-MVP and not supported yet',
      COMMAND_HELP.draft,
    );
  }

  const kilnHome = resolveCliKilnHome(options);
  const host = parseHostValue(parsed.values.host, options.host);
  const port = parsePortValue(parsed.values.port, options.port ?? DEFAULT_KILND_PORT, false);
  const baseUrl = buildBaseUrl(host, port);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const explicitRunning = options.isDaemonRunning ? await options.isDaemonRunning() : null;

  if (explicitRunning !== false) {
    let res: Response | null = null;
    try {
      res = await fetchWithTimeout(
        fetchImpl,
        `${baseUrl}/api/drafts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: draftId,
            title,
            space,
            priority: priorityResult.data,
            track: trackResult.data,
            workspace_mode: modeResult.data,
          }),
        },
        API_TIMEOUT_MS,
      );
    } catch {
      res = null;
    }

    if (res !== null) {
      if (!res.ok) {
        io.err(`Failed to create draft: ${await readErrorMessage(res)}`);
        return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
      }
      const body = (await res.json()) as { draft: DraftCard };
      io.out(`Created draft ${body.draft.id} (online): ${body.draft.title}`);
      return {
        exitCode: 0,
        stdout: io.getStdout(),
        stderr: io.getStderr(),
        data: { draft: body.draft, mode: "online" },
      };
    }
  }

  const now = (options.now?.() ?? new Date()).toISOString();
  const draft = DraftCardSchema.parse({
    schema_version: 1,
    id: draftId,
    title,
    space,
    priority: priorityResult.data,
    track: trackResult.data,
    workspace_mode: modeResult.data,
    depends_on: [],
    contract: {},
    session_ref: null,
    created_at: now,
    updated_at: now,
  });

  const store = new KilnStore({ kilnHome });
  try {
    store.writeDraft(draft);
  } finally {
    store.close();
  }

  io.out(`Created draft ${draft.id} (offline): ${draft.title}`);
  return {
    exitCode: 0,
    stdout: io.getStdout(),
    stderr: io.getStderr(),
    data: { draft, mode: "offline" },
  };
}

async function handleDecide(
  args: readonly string[],
  options: CliRuntimeOptions,
  io: ReturnType<typeof createOutputCollector>,
): Promise<CliRunResult> {
  const parsed = parseArgs({
    args: [...args],
    options: {
      option: { type: "string", short: "o" },
      decision: { type: "string", short: "d" },
      rationale: { type: "string", short: "r" },
      "apply-ledger": { type: "boolean", default: false },
      port: { type: "string", short: "p" },
      host: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (parsed.values.help) {
    io.out(COMMAND_HELP.decide!);
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  if (parsed.positionals.length > 1) {
    throw new CliUsageError(
      "decide accepts at most one [task-id] positional argument",
      COMMAND_HELP.decide,
    );
  }

  const rawTaskId = parsed.positionals[0];
  const taskId =
    rawTaskId !== undefined
      ? parseSafeCliSegment(rawTaskId, "taskId", COMMAND_HELP.decide)
      : undefined;

  const kilnHome = resolveCliKilnHome(options);
  const host = parseHostValue(parsed.values.host, options.host);
  const port = parsePortValue(parsed.values.port, options.port ?? DEFAULT_KILND_PORT, false);
  const baseUrl = buildBaseUrl(host, port);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (parsed.values.option === undefined) {
    const statusRes = await fetchStatusSummary(options, kilnHome, baseUrl, fetchImpl);
    if (!statusRes.ok) {
      io.err(statusRes.error);
      return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
    }

    const items = taskId
      ? statusRes.summary.pendingDecisions.filter((d) => d.task_id === taskId)
      : statusRes.summary.pendingDecisions;

    if (items.length === 0) {
      io.out(taskId ? `No pending decisions for task "${taskId}".` : "No pending decisions.");
      return {
        exitCode: 0,
        stdout: io.getStdout(),
        stderr: io.getStderr(),
        data: { pendingDecisions: [] },
      };
    }

    const lines: string[] = [];
    for (const item of items) {
      lines.push(...formatPendingDecisionBlock(item));
    }
    io.out(lines.join("\n"));

    return {
      exitCode: 0,
      stdout: io.getStdout(),
      stderr: io.getStderr(),
      data: { pendingDecisions: items },
    };
  }

  if (!taskId) {
    throw new CliUsageError(
      "<task-id> is required when --option is specified",
      COMMAND_HELP.decide,
    );
  }

  const optionId = parsed.values.option.trim();
  if (optionId.length === 0) {
    throw new CliUsageError("--option cannot be empty", COMMAND_HELP.decide);
  }

  let taskRes: Response;
  try {
    taskRes = await fetchWithTimeout(
      fetchImpl,
      `${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`,
      { method: "GET" },
      API_TIMEOUT_MS,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`Cannot reach kilnd at ${baseUrl}: ${msg}`);
    return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  if (!taskRes.ok) {
    io.err(`Failed to fetch task "${taskId}": ${await readErrorMessage(taskRes)}`);
    return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  const taskDetail = (await taskRes.json()) as {
    pendingDecision?: PendingDecision | null;
  };
  const pending = taskDetail.pendingDecision;
  if (!pending) {
    io.err(`Task "${taskId}" has no pending decision.`);
    return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  if (parsed.values.decision !== undefined && parsed.values.decision !== pending.id) {
    io.err(
      `Decision ID mismatch: task "${taskId}" is waiting on "${pending.id}", not "${parsed.values.decision}".`,
    );
    return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  const selectedOption = pending.options.find((opt) => opt.id === optionId);
  if (!selectedOption) {
    const validIds = pending.options.map((opt) => opt.id).join(", ");
    io.err(
      `Option "${optionId}" does not exist on decision "${pending.id}". Valid options: ${validIds}`,
    );
    return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  const decidePayload = DecideRequestSchema.parse({
    decision_id: pending.id,
    option_id: selectedOption.id,
    action: selectedOption.action,
    ...(parsed.values.rationale !== undefined ? { rationale: parsed.values.rationale } : {}),
    apply_ledger_rule: parsed.values["apply-ledger"],
  });

  let decideRes: Response;
  try {
    decideRes = await fetchWithTimeout(
      fetchImpl,
      `${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/decide`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(decidePayload),
      },
      API_TIMEOUT_MS,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`Failed to submit decision to ${baseUrl}: ${msg}`);
    return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  if (!decideRes.ok) {
    io.err(`Decision rejected: ${await readErrorMessage(decideRes)}`);
    return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  const result = (await decideRes.json()) as {
    ok: boolean;
    state: {
      status: TaskStatus;
      stage: StageId | null;
      round: number | null;
      contractVersion: number;
    };
    contractVersion?: number;
    ledgerEntry?: { rule: string } | null;
  };
  const effectiveContractVersion = result.contractVersion ?? result.state.contractVersion;

  io.out(
    `Decided ${taskId}: option=${selectedOption.id} action=${selectedOption.action} -> status=${result.state.status} (contract v${effectiveContractVersion})`,
  );
  if (result.ledgerEntry) {
    io.out(`Ledger rule recorded: ${result.ledgerEntry.rule}`);
  }

  return {
    exitCode: 0,
    stdout: io.getStdout(),
    stderr: io.getStderr(),
    data: result,
  };
}

function parseCsvFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function handleSpace(
  args: readonly string[],
  options: CliRuntimeOptions,
  io: ReturnType<typeof createOutputCollector>,
): Promise<CliRunResult> {
  const parsed = parseArgs({
    args: [...args],
    options: {
      id: { type: "string" },
      name: { type: "string" },
      branch: { type: "string" },
      "accept-cmd": { type: "string" },
      "copy-untracked": { type: "string" },
      "clone-deps": { type: "string" },
      port: { type: "string", short: "p" },
      host: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (parsed.values.help) {
    io.out(COMMAND_HELP.space!);
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  const subcommand = parsed.positionals[0];
  if (!subcommand) {
    throw new CliUsageError("space requires a subcommand: list, add, or rm", COMMAND_HELP.space);
  }

  const kilnHome = resolveCliKilnHome(options);
  const host = parseHostValue(parsed.values.host, options.host);
  const port = parsePortValue(parsed.values.port, options.port ?? DEFAULT_KILND_PORT, false);
  const baseUrl = buildBaseUrl(host, port);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const explicitRunning = options.isDaemonRunning ? await options.isDaemonRunning() : null;

  if (subcommand === "list") {
    if (parsed.positionals.length > 1) {
      throw new CliUsageError(
        "space list accepts no extra positional arguments",
        COMMAND_HELP.space,
      );
    }

    let spaces: SpaceConfig[] | null = null;
    if (explicitRunning !== false) {
      let res: Response | null = null;
      try {
        res = await fetchWithTimeout(
          fetchImpl,
          `${baseUrl}/api/spaces`,
          { method: "GET" },
          API_TIMEOUT_MS,
        );
      } catch {
        res = null;
      }

      if (res !== null) {
        if (!res.ok) {
          io.err(`Failed to list spaces: ${await readErrorMessage(res)}`);
          return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
        }
        const body = (await res.json()) as { spaces?: Record<string, SpaceConfig> };
        spaces = Object.values(body.spaces ?? {}).sort((a, b) => a.id.localeCompare(b.id));
      }
    }

    if (spaces === null) {
      const paths = new KilnPaths(kilnHome);
      if (!fs.existsSync(paths.spacesDir) && !hasLocalStoreData(kilnHome)) {
        spaces = [];
      } else {
        const store = new KilnStore({ kilnHome });
        try {
          spaces = store.listSpaces();
        } finally {
          store.close();
        }
      }
    }

    if (parsed.values.json) {
      io.out(JSON.stringify({ spaces }, null, 2));
    } else if (spaces.length === 0) {
      io.out("No project spaces registered. Run `kiln space add <path>` to add one.");
    } else {
      for (const sp of spaces) {
        const acceptPart = sp.default_accept_cmd ? `, accept: ${sp.default_accept_cmd}` : "";
        io.out(
          `- ${sp.id} (${sp.name}): ${sp.repo_path ?? "(no repo_path)"} [branch: ${sp.default_branch}${acceptPart}]`,
        );
      }
    }

    return {
      exitCode: 0,
      stdout: io.getStdout(),
      stderr: io.getStderr(),
      data: { spaces },
    };
  }

  if (subcommand === "add") {
    if (parsed.positionals.length > 2) {
      throw new CliUsageError("space add accepts at most one [path] argument", COMMAND_HELP.space);
    }

    const targetPath = parsed.positionals[1] ?? process.cwd();
    let inspected;
    try {
      inspected = await inspectGitSpacePath(targetPath);
    } catch (err) {
      if (err instanceof InvalidSpacePathError) {
        io.err(err.message);
        return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
      }
      throw err;
    }

    const rawId = parsed.values.id ?? inspected.suggested_id;
    const spaceId = parseSafeCliSegment(rawId, "spaceId", COMMAND_HELP.space);
    if (spaceId === "local" || spaceId === "all") {
      throw new CliUsageError(`Space ID "${spaceId}" is reserved`, COMMAND_HELP.space);
    }

    const name = (parsed.values.name ?? inspected.suggested_name).trim();
    if (name.length === 0) {
      throw new CliUsageError("Space --name cannot be empty", COMMAND_HELP.space);
    }
    const defaultBranch = (parsed.values.branch ?? inspected.default_branch).trim();
    if (defaultBranch.length === 0) {
      throw new CliUsageError("Space --branch cannot be empty", COMMAND_HELP.space);
    }
    const rawAcceptCmd = parsed.values["accept-cmd"] ?? inspected.default_accept_cmd;
    const acceptCmd =
      rawAcceptCmd && rawAcceptCmd.trim().length > 0 ? rawAcceptCmd.trim() : undefined;
    const copyUntracked = parseCsvFlag(parsed.values["copy-untracked"]) ?? inspected.copy_untracked;
    const cloneDeps = parseCsvFlag(parsed.values["clone-deps"]) ?? inspected.clone_deps;

    if (explicitRunning !== false) {
      let res: Response | null = null;
      try {
        res = await fetchWithTimeout(
          fetchImpl,
          `${baseUrl}/api/spaces/${encodeURIComponent(spaceId)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name,
              repo_path: inspected.repo_path,
              default_branch: defaultBranch,
              copy_untracked: copyUntracked,
              clone_deps: cloneDeps,
              ...(acceptCmd !== undefined ? { default_accept_cmd: acceptCmd } : {}),
              freeze_patterns: [],
            }),
          },
          API_TIMEOUT_MS,
        );
      } catch {
        res = null;
      }

      if (res !== null) {
        if (!res.ok) {
          io.err(`Failed to save space "${spaceId}": ${await readErrorMessage(res)}`);
          return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
        }
        const body = (await res.json()) as { space: SpaceConfig };
        if (parsed.values.json) {
          io.out(JSON.stringify({ space: body.space, mode: "online" }, null, 2));
        } else {
          io.out(
            `Saved space ${body.space.id} (${body.space.name}) -> ${body.space.repo_path} (online)`,
          );
        }
        return {
          exitCode: 0,
          stdout: io.getStdout(),
          stderr: io.getStderr(),
          data: { space: body.space, mode: "online" },
        };
      }
    }

    const space = SpaceConfigSchema.parse({
      schema_version: 1,
      id: spaceId,
      name,
      repo_path: inspected.repo_path,
      default_branch: defaultBranch,
      copy_untracked: copyUntracked,
      clone_deps: cloneDeps,
      ...(acceptCmd !== undefined ? { default_accept_cmd: acceptCmd } : {}),
      freeze_patterns: [],
    });

    const store = new KilnStore({ kilnHome });
    try {
      store.writeSpace(space);
    } finally {
      store.close();
    }

    if (parsed.values.json) {
      io.out(JSON.stringify({ space, mode: "offline" }, null, 2));
    } else {
      io.out(`Saved space ${space.id} (${space.name}) -> ${space.repo_path} (offline)`);
    }
    return {
      exitCode: 0,
      stdout: io.getStdout(),
      stderr: io.getStderr(),
      data: { space, mode: "offline" },
    };
  }

  if (subcommand === "rm") {
    if (parsed.positionals.length !== 2) {
      throw new CliUsageError("space rm requires <id>", COMMAND_HELP.space);
    }
    const spaceId = parseSafeCliSegment(parsed.positionals[1]!, "spaceId", COMMAND_HELP.space);
    if (spaceId === "local" || spaceId === "all") {
      throw new CliUsageError(`Space ID "${spaceId}" is reserved`, COMMAND_HELP.space);
    }

    if (explicitRunning !== false) {
      let res: Response | null = null;
      try {
        res = await fetchWithTimeout(
          fetchImpl,
          `${baseUrl}/api/spaces/${encodeURIComponent(spaceId)}`,
          { method: "DELETE" },
          API_TIMEOUT_MS,
        );
      } catch {
        res = null;
      }

      if (res !== null) {
        if (!res.ok) {
          io.err(`Failed to remove space "${spaceId}": ${await readErrorMessage(res)}`);
          return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
        }
        if (parsed.values.json) {
          io.out(JSON.stringify({ deleted: true, id: spaceId, mode: "online" }, null, 2));
        } else {
          io.out(`Removed space "${spaceId}" (online).`);
        }
        return {
          exitCode: 0,
          stdout: io.getStdout(),
          stderr: io.getStderr(),
          data: { deleted: true, id: spaceId, mode: "online" },
        };
      }
    }

    const store = new KilnStore({ kilnHome });
    try {
      if (!store.readSpace(spaceId)) {
        io.err(`Space "${spaceId}" does not exist`);
        return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
      }
      const activeTasks = store
        .listTasks({ space: spaceId })
        .filter((t) => t.status !== "done" && t.status !== "cancelled");
      if (activeTasks.length > 0) {
        io.err(
          `Cannot remove space "${spaceId}": ${activeTasks.length} active task(s) remain (${activeTasks.map((t) => t.id).join(", ")})`,
        );
        return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
      }
      store.deleteSpace(spaceId);
    } finally {
      store.close();
    }

    if (parsed.values.json) {
      io.out(JSON.stringify({ deleted: true, id: spaceId, mode: "offline" }, null, 2));
    } else {
      io.out(`Removed space "${spaceId}" (offline).`);
    }
    return {
      exitCode: 0,
      stdout: io.getStdout(),
      stderr: io.getStderr(),
      data: { deleted: true, id: spaceId, mode: "offline" },
    };
  }

  throw new CliUsageError(
    `Unknown space subcommand "${subcommand}": expected list, add, or rm`,
    COMMAND_HELP.space,
  );
}

async function handleRm(
  args: readonly string[],
  options: CliRuntimeOptions,
  io: ReturnType<typeof createOutputCollector>,
): Promise<CliRunResult> {
  const parsed = parseArgs({
    args: [...args],
    options: {
      "purge-usage": { type: "boolean", default: false },
      port: { type: "string", short: "p" },
      host: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (parsed.values.help) {
    io.out(COMMAND_HELP.rm!);
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  if (parsed.positionals.length !== 1) {
    throw new CliUsageError("rm requires <task-id>", COMMAND_HELP.rm);
  }
  const taskId = parseSafeCliSegment(parsed.positionals[0]!, "taskId", COMMAND_HELP.rm);
  const purgeUsage = Boolean(parsed.values["purge-usage"]);

  const kilnHome = resolveCliKilnHome(options);
  const host = parseHostValue(parsed.values.host, options.host);
  const port = parsePortValue(parsed.values.port, options.port ?? DEFAULT_KILND_PORT, false);
  const baseUrl = buildBaseUrl(host, port);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const explicitRunning = options.isDaemonRunning ? await options.isDaemonRunning() : null;

  if (explicitRunning !== false) {
    let res: Response | null = null;
    try {
      res = await fetchWithTimeout(
        fetchImpl,
        `${baseUrl}/api/tasks/${encodeURIComponent(taskId)}${purgeUsage ? "?purge_usage=true" : ""}`,
        { method: "DELETE" },
        API_TIMEOUT_MS,
      );
    } catch {
      res = null;
    }

    if (res !== null) {
      if (!res.ok) {
        io.err(`Failed to remove task "${taskId}": ${await readErrorMessage(res)}`);
        return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
      }
      const body = (await res.json()) as { purgedUsage?: boolean };
      const resolvedPurge = body.purgedUsage ?? purgeUsage;
      if (parsed.values.json) {
        io.out(
          JSON.stringify(
            { deleted: true, id: taskId, purgedUsage: resolvedPurge, mode: "online" },
            null,
            2,
          ),
        );
      } else {
        io.out(
          `Removed task "${taskId}" (online${resolvedPurge ? ", usage purged" : ", usage preserved"}).`,
        );
      }
      return {
        exitCode: 0,
        stdout: io.getStdout(),
        stderr: io.getStderr(),
        data: { deleted: true, id: taskId, purgedUsage: resolvedPurge, mode: "online" },
      };
    }
  }

  const store = new KilnStore({ kilnHome });
  try {
    const existing = store.listTasks().find((row) => row.id === taskId);
    if (!existing) {
      io.err(`Task "${taskId}" does not exist`);
      return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
    }
    const card = store.readTaskCard(taskId);
    const derived = deriveTaskStatus(card, store.readStateEvents(taskId));
    if (derived.status === "running") {
      io.err(`Cannot remove running task "${taskId}"; pause or cancel it first`);
      return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
    }
    const dependentTaskIds = store
      .listTasks()
      .filter((row) => row.id !== taskId && store.readTaskCard(row.id).depends_on.includes(taskId))
      .map((row) => row.id);
    if (dependentTaskIds.length > 0) {
      io.err(
        `Cannot remove task "${taskId}": depended on by downstream task(s) (${dependentTaskIds.join(", ")})`,
      );
      return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
    }
    if (card.workspace_mode === "git_worktree") {
      const space = store.readSpace(card.space);
      if (space?.repo_path && fs.existsSync(space.repo_path)) {
        const worktreeDir = store.paths.workspaceDir(taskId);
        if (fs.existsSync(worktreeDir)) {
          await execFileAsync("git", ["worktree", "remove", "--force", worktreeDir], {
            cwd: space.repo_path,
          }).catch(() => {});
        }
        await execFileAsync("git", ["branch", "-D", `kiln/${taskId}`], {
          cwd: space.repo_path,
        }).catch(() => {});
      }
    }
    new PendingDecisionStore(store).remove(taskId);
    const deleted = store.deleteTask(taskId, { purgeUsage });
    if (parsed.values.json) {
      io.out(
        JSON.stringify(
          { deleted: true, id: taskId, purgedUsage: deleted.purgedUsage, mode: "offline" },
          null,
          2,
        ),
      );
    } else {
      io.out(
        `Removed task "${taskId}" (offline${deleted.purgedUsage ? ", usage purged" : ", usage preserved"}).`,
      );
    }
    return {
      exitCode: 0,
      stdout: io.getStdout(),
      stderr: io.getStderr(),
      data: { deleted: true, id: taskId, purgedUsage: deleted.purgedUsage, mode: "offline" },
    };
  } finally {
    store.close();
  }
}

async function fetchLocalRemoteApi(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  baseUrl: string,
): Promise<{ ok: true; res: Response } | { ok: false; error: string }> {
  try {
    const res = await fetchWithTimeout(fetchImpl, url, init, API_TIMEOUT_MS);
    return { ok: true, res };
  } catch {
    return {
      ok: false,
      error: `kilnd is offline at ${baseUrl}; start it first with "kiln up"`,
    };
  }
}

async function handleRemote(
  args: readonly string[],
  options: CliRuntimeOptions,
  io: ReturnType<typeof createOutputCollector>,
): Promise<CliRunResult> {
  const parsed = parseArgs({
    args: [...args],
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string" },
      "remote-port": { type: "string" },
      "public-url": { type: "string" },
      "keep-awake-ac": { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (parsed.values.help) {
    io.out(COMMAND_HELP.remote!);
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  const subcommand = parsed.positionals[0];
  if (!subcommand) {
    throw new CliUsageError(
      "remote requires a subcommand: status, enable, disable, pair, devices, revoke, or tailscale",
      COMMAND_HELP.remote,
    );
  }

  const host = parseHostValue(parsed.values.host, options.host);
  const port = parsePortValue(parsed.values.port, options.port ?? DEFAULT_KILND_PORT, false);
  const baseUrl = buildBaseUrl(host, port);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (subcommand === "status") {
    if (parsed.positionals.length !== 1) {
      throw new CliUsageError(
        "remote status takes no extra positional arguments",
        COMMAND_HELP.remote,
      );
    }
    const call = await fetchLocalRemoteApi(
      fetchImpl,
      `${baseUrl}/api/settings/remote`,
      { method: "GET" },
      baseUrl,
    );
    if (!call.ok) {
      io.err(call.error);
      return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
    }
    if (!call.res.ok) {
      io.err(`Failed to query remote status: ${await readErrorMessage(call.res)}`);
      return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
    }
    const body = (await call.res.json()) as {
      ok: true;
      remote: RemoteConfig;
      runtime: { listening: boolean; port: number | null; baseUrl: string | null };
      activeDeviceCount: number;
    };

    if (parsed.values.json) {
      io.out(JSON.stringify(body, null, 2));
    } else {
      io.out(
        `Remote access: ${body.remote.enabled ? "enabled" : "disabled"} (configured port: ${body.remote.remote_port})`,
      );
      io.out(
        `Remote listener: ${body.runtime.listening ? `listening at ${body.runtime.baseUrl}` : "stopped"}`,
      );
      io.out(`Public URL: ${body.remote.public_url ?? "(not configured)"}`);
      io.out(`Keep awake on AC: ${body.remote.keep_awake_on_ac ? "enabled" : "disabled"}`);
      io.out(
        `Notifications: ${body.remote.notifications.enabled ? `${body.remote.notifications.channel} (${body.remote.notifications.priorities.join(",")})` : "disabled"}`,
      );
      io.out(`Active paired devices: ${body.activeDeviceCount}`);
    }
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr(), data: body };
  }

  if (subcommand === "enable" || subcommand === "disable") {
    if (parsed.positionals.length !== 1) {
      throw new CliUsageError(
        `remote ${subcommand} takes no extra positional arguments`,
        COMMAND_HELP.remote,
      );
    }

    const currentCall = await fetchLocalRemoteApi(
      fetchImpl,
      `${baseUrl}/api/settings/remote`,
      { method: "GET" },
      baseUrl,
    );
    if (!currentCall.ok) {
      io.err(currentCall.error);
      return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
    }
    if (!currentCall.res.ok) {
      io.err(`Failed to load existing remote settings: ${await readErrorMessage(currentCall.res)}`);
      return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
    }
    const currentBody = (await currentCall.res.json()) as { remote: RemoteConfig };

    let nextRemotePort = currentBody.remote.remote_port ?? DEFAULT_REMOTE_PORT;
    if (parsed.values["remote-port"] !== undefined) {
      const rawRemotePort = parsed.values["remote-port"].trim();
      if (!/^\d+$/.test(rawRemotePort)) {
        throw new CliUsageError(
          `Invalid --remote-port "${parsed.values["remote-port"]}": expected an integer between 1 and 65535`,
          COMMAND_HELP.remote,
        );
      }
      const parsedRemotePort = Number(rawRemotePort);
      if (
        !Number.isSafeInteger(parsedRemotePort) ||
        parsedRemotePort < 1 ||
        parsedRemotePort > 65535
      ) {
        throw new CliUsageError(
          `Invalid --remote-port "${parsed.values["remote-port"]}": expected an integer between 1 and 65535`,
          COMMAND_HELP.remote,
        );
      }
      if (parsedRemotePort === port) {
        throw new CliUsageError(
          `--remote-port (${parsedRemotePort}) must differ from local --port (${port})`,
          COMMAND_HELP.remote,
        );
      }
      nextRemotePort = parsedRemotePort;
    }

    let nextPublicUrl = currentBody.remote.public_url;
    if (parsed.values["public-url"] !== undefined) {
      const validated = PublicRemoteUrlSchema.safeParse(parsed.values["public-url"]);
      if (!validated.success) {
        throw new CliUsageError(
          `Invalid --public-url "${parsed.values["public-url"]}": ${validated.error.issues.map((i) => i.message).join("; ")}`,
          COMMAND_HELP.remote,
        );
      }
      nextPublicUrl = validated.data;
    }

    const nextConfigCandidate: Record<string, unknown> = {
      schema_version: 1,
      enabled: subcommand === "enable",
      remote_port: nextRemotePort,
      keep_awake_on_ac: parsed.values["keep-awake-ac"] ? true : currentBody.remote.keep_awake_on_ac,
      notifications: currentBody.remote.notifications,
      ...(nextPublicUrl !== undefined ? { public_url: nextPublicUrl } : {}),
    };

    const validatedConfig = RemoteConfigSchema.safeParse(nextConfigCandidate);
    if (!validatedConfig.success) {
      throw new CliUsageError(
        `Invalid remote configuration: ${validatedConfig.error.issues.map((i) => i.message).join("; ")}`,
        COMMAND_HELP.remote,
      );
    }

    const updateCall = await fetchLocalRemoteApi(
      fetchImpl,
      `${baseUrl}/api/settings/remote`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validatedConfig.data),
      },
      baseUrl,
    );
    if (!updateCall.ok) {
      io.err(updateCall.error);
      return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
    }
    if (!updateCall.res.ok) {
      io.err(`Failed to ${subcommand} remote access: ${await readErrorMessage(updateCall.res)}`);
      return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
    }
    const updated = (await updateCall.res.json()) as {
      ok: true;
      section: "remote";
      data: RemoteConfig;
      runtime: { listening: boolean; port: number | null; baseUrl: string | null };
    };

    if (parsed.values.json) {
      io.out(JSON.stringify(updated, null, 2));
    } else if (subcommand === "enable") {
      io.out(
        `Remote access enabled on port ${updated.data.remote_port}${updated.runtime.listening ? ` (listening at ${updated.runtime.baseUrl})` : ""}.`,
      );
      if (updated.data.public_url) {
        io.out(`Public URL: ${updated.data.public_url}`);
      }
      io.out(`Tunnel command: tailscale serve --bg http://127.0.0.1:${updated.data.remote_port}`);
    } else {
      io.out("Remote access disabled.");
    }
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr(), data: updated };
  }

  if (subcommand === "pair") {
    if (parsed.positionals.length !== 1) {
      throw new CliUsageError(
        "remote pair takes no extra positional arguments",
        COMMAND_HELP.remote,
      );
    }
    const call = await fetchLocalRemoteApi(
      fetchImpl,
      `${baseUrl}/api/remote/pair`,
      { method: "POST" },
      baseUrl,
    );
    if (!call.ok) {
      io.err(call.error);
      return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
    }
    if (!call.res.ok) {
      io.err(`Failed to create pairing challenge: ${await readErrorMessage(call.res)}`);
      return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
    }
    const body = (await call.res.json()) as {
      ok: true;
      challengeId: string;
      code: string;
      token: string;
      expiresAt: string;
      pairUrl: string | null;
    };

    if (parsed.values.json) {
      io.out(JSON.stringify(body, null, 2));
    } else {
      io.out(`Pairing code: ${body.code}`);
      io.out(`Pairing token: ${body.token}`);
      io.out(`Expires at: ${body.expiresAt}`);
      if (body.pairUrl) {
        io.out(`Pair URL: ${body.pairUrl}`);
      } else {
        io.out(
          'Pair URL: (not set — configure --public-url via "kiln remote enable --public-url https://<your-host>")',
        );
      }
    }
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr(), data: body };
  }

  if (subcommand === "devices") {
    if (parsed.positionals.length !== 1) {
      throw new CliUsageError(
        "remote devices takes no extra positional arguments",
        COMMAND_HELP.remote,
      );
    }
    const call = await fetchLocalRemoteApi(
      fetchImpl,
      `${baseUrl}/api/remote/devices`,
      { method: "GET" },
      baseUrl,
    );
    if (!call.ok) {
      io.err(call.error);
      return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
    }
    if (!call.res.ok) {
      io.err(`Failed to list paired devices: ${await readErrorMessage(call.res)}`);
      return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
    }
    const body = (await call.res.json()) as {
      ok: true;
      devices: PublicPairedDevice[];
    };

    if (parsed.values.json) {
      io.out(JSON.stringify(body, null, 2));
    } else if (body.devices.length === 0) {
      io.out("No paired devices.");
    } else {
      io.out(`Paired devices (${body.devices.length}):`);
      for (const dev of body.devices) {
        const status = dev.revoked_at ? `revoked (${dev.revoked_at})` : "active";
        io.out(`- ${dev.id} | ${dev.label} | ${status} | last_seen=${dev.last_seen_at}`);
      }
    }
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr(), data: body };
  }

  if (subcommand === "revoke") {
    if (parsed.values.all) {
      if (parsed.positionals.length !== 1) {
        throw new CliUsageError(
          "remote revoke --all does not accept a device-id argument",
          COMMAND_HELP.remote,
        );
      }
      const call = await fetchLocalRemoteApi(
        fetchImpl,
        `${baseUrl}/api/remote/devices/revoke-all`,
        { method: "POST" },
        baseUrl,
      );
      if (!call.ok) {
        io.err(call.error);
        return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
      }
      if (!call.res.ok) {
        io.err(`Failed to revoke all devices: ${await readErrorMessage(call.res)}`);
        return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
      }
      const body = (await call.res.json()) as {
        ok: true;
        revokedCount: number;
        closedStreams: number;
      };
      if (parsed.values.json) {
        io.out(JSON.stringify(body, null, 2));
      } else {
        io.out(
          `Revoked ${body.revokedCount} device(s) and closed ${body.closedStreams} remote SSE stream(s).`,
        );
      }
      return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr(), data: body };
    }

    if (parsed.positionals.length !== 2) {
      throw new CliUsageError("remote revoke requires <device-id> or --all", COMMAND_HELP.remote);
    }
    const deviceId = parseSafeCliSegment(parsed.positionals[1]!, "deviceId", COMMAND_HELP.remote);
    const call = await fetchLocalRemoteApi(
      fetchImpl,
      `${baseUrl}/api/remote/devices/${encodeURIComponent(deviceId)}`,
      { method: "DELETE" },
      baseUrl,
    );
    if (!call.ok) {
      io.err(call.error);
      return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
    }
    if (!call.res.ok) {
      io.err(`Failed to revoke device "${deviceId}": ${await readErrorMessage(call.res)}`);
      return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
    }
    const body = (await call.res.json()) as {
      ok: true;
      revoked: true;
      device: PublicPairedDevice;
      closedStreams: number;
    };
    if (parsed.values.json) {
      io.out(JSON.stringify(body, null, 2));
    } else {
      io.out(
        `Revoked device ${body.device.id} (${body.device.label}); closed ${body.closedStreams} remote SSE stream(s).`,
      );
    }
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr(), data: body };
  }

  if (subcommand === "tailscale") {
    if (parsed.positionals.length !== 1) {
      throw new CliUsageError(
        "remote tailscale takes no extra positional arguments",
        COMMAND_HELP.remote,
      );
    }
    const call = await fetchLocalRemoteApi(
      fetchImpl,
      `${baseUrl}/api/remote/tailscale`,
      { method: "GET" },
      baseUrl,
    );
    if (!call.ok) {
      io.err(call.error);
      return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
    }
    if (!call.res.ok) {
      io.err(`Failed to inspect Tailscale status: ${await readErrorMessage(call.res)}`);
      return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
    }
    const body = (await call.res.json()) as TailscaleStatusResponse;

    if (parsed.values.json) {
      io.out(JSON.stringify(body, null, 2));
    } else {
      io.out(
        `Tailscale CLI: ${body.installed ? "installed" : "not installed"} | State: ${body.backendState ?? (body.running ? "Running" : "unavailable")}`,
      );
      if (body.magicDnsUrl) {
        io.out(`MagicDNS URL: ${body.magicDnsUrl}`);
      }
      io.out(
        `Tailscale Serve: ${body.serveConfiguredForPort ? `active for port ${body.remotePort}` : body.serveActive ? "active (other target)" : "not configured"}`,
      );
      io.out(`Recommended command: ${body.recommendedCommand}`);
      if (body.detail) {
        io.out(`Detail: ${body.detail}`);
      }
    }
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr(), data: body };
  }

  throw new CliUsageError(
    `Unknown remote subcommand "${subcommand}": expected status, enable, disable, pair, devices, revoke, or tailscale`,
    COMMAND_HELP.remote,
  );
}

function parseNodeMajor(rawVersion: string): { valid: boolean; major: number; raw: string } {
  const cleaned = rawVersion.startsWith("v") ? rawVersion.slice(1) : rawVersion;
  const match = /^(\d+)/.exec(cleaned);
  if (!match) {
    return { valid: false, major: 0, raw: cleaned };
  }
  return { valid: true, major: Number(match[1]), raw: cleaned };
}

interface AgentsEndpointBackend {
  backendId?: unknown;
  id?: unknown;
  connected?: unknown;
  status?: unknown;
  detail?: unknown;
}

interface AgentsEndpointAgent {
  id?: unknown;
  label?: unknown;
  backendId?: unknown;
}

async function checkDoctorProviders(
  fetchImpl: typeof fetch,
  baseUrl: string,
  kilndOnline: boolean,
  kilnHome: string,
): Promise<DoctorCheckResult> {
  if (kilndOnline) {
    try {
      const res = await fetchWithTimeout(
        fetchImpl,
        `${baseUrl}/api/providers`,
        { method: "GET" },
        API_TIMEOUT_MS,
      );
      if (res.ok) {
        const body = (await res.json()) as {
          providers?: Array<{ provider_id?: string; status?: string; adapter?: string }>;
        };
        const list = Array.isArray(body.providers) ? body.providers : [];
        const ready = list
          .filter((p) => p.status === "ready" || p.status === "cooldown")
          .map((p) => p.provider_id)
          .filter((id): id is string => Boolean(id));
        const unavail = list
          .filter((p) => p.status !== "ready" && p.status !== "cooldown")
          .map((p) => p.provider_id)
          .filter((id): id is string => Boolean(id));
        return {
          id: "providers",
          ok: ready.length > 0,
          required: false,
          status: ready.length > 0 ? "pass" : "warn",
          detail:
            ready.length > 0
              ? `Ready: ${ready.join(", ")}${unavail.length > 0 ? ` | Unavailable: ${unavail.join(", ")}` : ""}`
              : `No ready CLI/ACP providers configured${unavail.length > 0 ? ` (unavailable: ${unavail.join(", ")})` : ""}`,
          meta: { providers: list },
        };
      }
    } catch {
      // Fallback to local binary probe below when /api/providers is unavailable
    }
  }

  let enabledEntries: Array<{
    id: string;
    adapter: string;
    command?: string;
    env: Record<string, string>;
  }> = [];
  const tempStore = new KilnStore({ kilnHome });
  try {
    enabledEntries = tempStore
      .readEffectiveProvidersConfig()
      .providers.filter((p) => p.enabled && p.adapter !== "paseo");
  } finally {
    tempStore.close();
  }

  const ready: string[] = [];
  const missing: string[] = [];
  await Promise.all(
    enabledEntries.map(async (entry) => {
      const cmd = entry.command?.trim() || entry.id;
      const probe = await probeCliBinary(cmd, {
        env: { ...process.env, ...entry.env },
      });
      if (probe.available) {
        ready.push(probe.version ? `${entry.id}(${probe.version})` : entry.id);
      } else {
        missing.push(entry.id);
      }
    }),
  );

  return {
    id: "providers",
    ok: ready.length > 0,
    required: false,
    status: ready.length > 0 ? "pass" : "warn",
    detail:
      ready.length > 0
        ? `Available CLIs: ${ready.sort().join(", ")}${missing.length > 0 ? ` | Missing: ${missing.sort().join(", ")}` : ""}`
        : `No supported Agent CLI binaries detected on PATH (${missing.sort().join(", ")})`,
    meta: { ready: ready.sort(), missing: missing.sort() },
  };
}

async function checkDoctorPaseo(
  fetchImpl: typeof fetch,
  baseUrl: string,
  kilndOnline: boolean,
): Promise<DoctorCheckResult> {
  if (!kilndOnline) {
    return {
      id: "paseo",
      ok: false,
      required: false,
      status: "skip",
      detail: "Paseo check skipped because kilnd is offline",
    };
  }

  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${baseUrl}/api/agents`,
      { method: "GET" },
      API_TIMEOUT_MS,
    );
    if (!res.ok) {
      return {
        id: "paseo",
        ok: false,
        required: false,
        status: "warn",
        detail: `Paseo backend status unavailable (GET /api/agents returned HTTP ${res.status}); check PASEO_URL or paseo daemon`,
        meta: { connected: false, status: res.status },
      };
    }

    const body = (await res.json()) as {
      ok?: unknown;
      backends?: unknown;
      agents?: unknown;
    };
    if (body === null || typeof body !== "object" || body.ok === false) {
      return {
        id: "paseo",
        ok: false,
        required: false,
        status: "warn",
        detail:
          "Paseo backend status unavailable (unexpected /api/agents payload); check PASEO_URL or paseo daemon",
        meta: { connected: false },
      };
    }

    const backends = Array.isArray(body.backends) ? (body.backends as AgentsEndpointBackend[]) : [];
    const agents = Array.isArray(body.agents) ? (body.agents as AgentsEndpointAgent[]) : [];

    const connectedBackends = backends.filter(
      (backend) => backend !== null && typeof backend === "object" && backend.connected === true,
    );

    if (connectedBackends.length > 0) {
      const backendLabels = connectedBackends.map((backend) =>
        typeof backend.backendId === "string" && backend.backendId.length > 0
          ? backend.backendId
          : typeof backend.id === "string" && backend.id.length > 0
            ? backend.id
            : "unknown",
      );
      const agentIds = agents
        .map((agent) =>
          agent !== null &&
          typeof agent === "object" &&
          typeof agent.id === "string" &&
          agent.id.length > 0
            ? agent.id
            : null,
        )
        .filter((id): id is string => id !== null);

      const agentsSummary =
        agentIds.length > 0 ? `agents: ${agentIds.join(", ")}` : "0 agents discovered";

      return {
        id: "paseo",
        ok: true,
        required: false,
        status: "pass",
        detail: `Connected (${backendLabels.join(", ")}); ${agentsSummary}`,
        meta: {
          connected: true,
          backends,
          agents,
        },
      };
    }

    const disconnectedDetails = backends
      .map((backend) => {
        if (!backend || typeof backend !== "object") return null;
        const id =
          typeof backend.backendId === "string"
            ? backend.backendId
            : typeof backend.id === "string"
              ? backend.id
              : null;
        const detail =
          typeof backend.detail === "string" && backend.detail.trim().length > 0
            ? backend.detail.trim()
            : null;
        if (id && detail) return `${id}: ${detail}`;
        return id ?? detail;
      })
      .filter((entry): entry is string => entry !== null);

    const detailSuffix =
      disconnectedDetails.length > 0
        ? ` (${disconnectedDetails.join("; ")})`
        : " (no connected backends)";

    return {
      id: "paseo",
      ok: false,
      required: false,
      status: "warn",
      detail: `Paseo is not connected${detailSuffix}; check PASEO_URL or paseo daemon`,
      meta: {
        connected: false,
        backends,
        agents,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: "paseo",
      ok: false,
      required: false,
      status: "warn",
      detail: `Paseo backend check failed (${msg}); check PASEO_URL or paseo daemon`,
      meta: {
        connected: false,
        error: msg,
      },
    };
  }
}

async function handleDoctor(
  args: readonly string[],
  options: CliRuntimeOptions,
  io: ReturnType<typeof createOutputCollector>,
): Promise<CliRunResult> {
  const parsed = parseArgs({
    args: [...args],
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (parsed.values.help) {
    io.out(COMMAND_HELP.doctor!);
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  const platform = options.platform ?? process.platform;
  const host = parseHostValue(parsed.values.host, options.host);
  const port = parsePortValue(parsed.values.port, options.port ?? DEFAULT_KILND_PORT, false);
  const baseUrl = buildBaseUrl(host, port);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const execImpl = options.execFileImpl ?? defaultExecFile;

  const checks: DoctorCheckResult[] = [];

  const compiledBinary = options.compiledBinary ?? isCompiledKilnBinary();
  if (compiledBinary && options.nodeVersion === undefined) {
    const bunVer =
      typeof (process.versions as Record<string, string | undefined>).bun === "string"
        ? (process.versions as Record<string, string | undefined>).bun!
        : "unknown";
    checks.push({
      id: "node",
      ok: true,
      required: true,
      status: "pass",
      detail: `Standalone Bun ${bunVer} binary (Node.js not required)`,
      meta: { runtime: "bun", version: bunVer, compiledBinary: true },
    });
  } else {
    const nodeVer = parseNodeMajor(options.nodeVersion ?? process.versions.node);
    const nodeOk = nodeVer.valid && nodeVer.major >= 22;
    checks.push({
      id: "node",
      ok: nodeOk,
      required: true,
      status: nodeOk ? "pass" : "fail",
      detail: nodeOk
        ? `Node.js ${nodeVer.raw} (>= 22)`
        : `Node.js ${nodeVer.raw} is below required >= 22`,
      meta: { version: nodeVer.raw, major: nodeVer.major },
    });
  }

  try {
    const gitOut = await execImpl("git", ["--version"]);
    const versionLine = gitOut.stdout.trim();
    checks.push({
      id: "git",
      ok: versionLine.length > 0,
      required: true,
      status: versionLine.length > 0 ? "pass" : "fail",
      detail: versionLine.length > 0 ? versionLine : "git --version returned empty output",
      meta: { output: versionLine },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      id: "git",
      ok: false,
      required: true,
      status: "fail",
      detail: `git unavailable: ${msg}`,
    });
  }

  if (platform === "darwin") {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kiln-doctor-apfs-"));
    try {
      const srcFile = path.join(tmpDir, "src.txt");
      const dstFile = path.join(tmpDir, "dst.txt");
      fs.writeFileSync(srcFile, "kiln-apfs-probe\n", "utf8");
      await execImpl("/bin/cp", ["-c", srcFile, dstFile]);
      const copied = fs.readFileSync(dstFile, "utf8");
      const cloneOk = copied === "kiln-apfs-probe\n";
      checks.push({
        id: "apfs_clone",
        ok: cloneOk,
        required: false,
        status: cloneOk ? "pass" : "warn",
        detail: cloneOk ? "APFS clone (/bin/cp -c) available" : "APFS clone verification mismatch",
        meta: { supported: cloneOk },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({
        id: "apfs_clone",
        ok: false,
        required: false,
        status: "warn",
        detail: `APFS clone (/bin/cp -c) unavailable: ${msg}`,
        meta: { supported: false },
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } else {
    checks.push({
      id: "apfs_clone",
      ok: true,
      required: false,
      status: "skip",
      detail: `APFS clone skipped on ${platform}`,
      meta: { supported: false },
    });
  }

  let kilndOnline = false;
  const explicitRunning = options.isDaemonRunning ? await options.isDaemonRunning() : null;
  if (explicitRunning === false) {
    checks.push({
      id: "kilnd",
      ok: false,
      required: false,
      status: "warn",
      detail: `kilnd is offline (${baseUrl})`,
      meta: { running: false, baseUrl },
    });
  } else {
    const health = await probeHealth(fetchImpl, baseUrl);
    kilndOnline = health.ok;
    checks.push({
      id: "kilnd",
      ok: health.ok,
      required: false,
      status: health.ok ? "pass" : "warn",
      detail: health.ok
        ? `kilnd is online at ${baseUrl}${health.pid !== null ? ` (PID ${health.pid})` : ""}`
        : `kilnd is offline (${baseUrl})`,
      meta: {
        running: health.ok,
        baseUrl,
        ...(health.ok ? { pid: health.pid, version: health.version } : {}),
      },
    });
  }

  checks.push(await checkDoctorPaseo(fetchImpl, baseUrl, kilndOnline));
  checks.push(
    await checkDoctorProviders(fetchImpl, baseUrl, kilndOnline, resolveCliKilnHome(options)),
  );

  if (platform === "darwin" || platform === "linux" || platform === "win32") {
    const svc = getServiceStatus(buildServiceOptions(options, platform));
    checks.push({
      id: "service",
      ok: true,
      required: false,
      status: svc.installed ? "pass" : "warn",
      detail: svc.installed
        ? `Startup service installed (${svc.servicePath})`
        : `Startup service not installed (${svc.servicePath})`,
      meta: { ...svc },
    });
  } else {
    checks.push({
      id: "service",
      ok: true,
      required: false,
      status: "skip",
      detail: `Startup service check skipped on ${platform}`,
      meta: { installed: false, platform },
    });
  }

  const report: DoctorReport = {
    ok: checks.every((c) => !c.required || c.ok),
    platform,
    checks,
  };

  if (parsed.values.json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(`Kiln Doctor (${platform}): ${report.ok ? "OK" : "FAILED"}`);
    for (const check of checks) {
      io.out(`- [${check.status.toUpperCase()}] ${check.id}: ${check.detail}`);
    }
  }

  return {
    exitCode: report.ok ? 0 : 1,
    stdout: io.getStdout(),
    stderr: io.getStderr(),
    data: report,
  };
}

async function handleService(
  args: readonly string[],
  options: CliRuntimeOptions,
  io: ReturnType<typeof createOutputCollector>,
): Promise<CliRunResult> {
  const parsed = parseArgs({
    args: [...args],
    options: {
      platform: { type: "string" },
      label: { type: "string" },
      "service-name": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (parsed.values.help) {
    io.out(COMMAND_HELP.service!);
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  if (parsed.positionals.length !== 1) {
    throw new CliUsageError(
      "service requires one action: install, uninstall, or status",
      COMMAND_HELP.service,
    );
  }

  const action = parsed.positionals[0]!;
  const platformOverride = parsePlatformFlag(parsed.values.platform, options.platform);
  const serviceOptions: ServiceOptions = {
    ...buildServiceOptions(options, platformOverride),
    ...(parsed.values.label !== undefined ? { label: parsed.values.label } : {}),
    ...(parsed.values["service-name"] !== undefined
      ? { serviceName: parsed.values["service-name"] }
      : {}),
  };

  if (action === "install") {
    const res = await installService(serviceOptions);
    io.out(
      `Installed ${res.platform} service at ${res.servicePath} (system control executed: ${res.executedControl}).`,
    );
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr(), data: res };
  }

  if (action === "uninstall") {
    const res = await uninstallService(serviceOptions);
    io.out(
      res.removed
        ? `Removed ${res.platform} service file ${res.servicePath}.`
        : `No ${res.platform} service file found at ${res.servicePath}.`,
    );
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr(), data: res };
  }

  if (action === "status") {
    const res = getServiceStatus(serviceOptions);
    io.out(
      `Service (${res.platform}): ${res.installed ? "installed" : "not installed"} (${res.servicePath})`,
    );
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr(), data: res };
  }

  throw new CliUsageError(
    `Unknown service action "${action}": expected install, uninstall, or status`,
    COMMAND_HELP.service,
  );
}

async function handleUninstall(
  args: readonly string[],
  options: CliRuntimeOptions,
  io: ReturnType<typeof createOutputCollector>,
): Promise<CliRunResult> {
  const parsed = parseArgs({
    args: [...args],
    options: {
      "purge-data": { type: "boolean", default: false },
      platform: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (parsed.values.help) {
    io.out(COMMAND_HELP.uninstall!);
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  const platformOverride = parsePlatformFlag(parsed.values.platform, options.platform);
  const result = await runUninstall({
    ...buildServiceOptions(options, platformOverride),
    socketPath: options.socketPath,
    purgeData: parsed.values["purge-data"],
    stopDaemon: options.stopDaemon,
    requestGracefulShutdown: options.requestGracefulShutdown,
    signalProcess: options.signalProcess,
    killProcessTree: options.killProcessTree,
    execGit: options.execGit,
  });

  io.out(
    `Daemon: ${result.stoppedDaemon ? `stopped (PID ${String(result.daemonPid)})` : "not running"}`,
  );
  io.out(
    `Service (${result.platform}): ${result.serviceRemoved ? `removed ${result.servicePath}` : `not installed (${result.servicePath})`}`,
  );
  if (result.worktrees.length > 0) {
    io.out(`Detected Kiln worktree references (${result.worktrees.length}):`);
    for (const wt of result.worktrees) {
      const stateTag = wt.removed
        ? "clean (removed)"
        : wt.missing
          ? "missing"
          : wt.dirty
            ? "dirty (preserved)"
            : "clean";
      io.out(`- [${wt.spaceId}] ${wt.worktreePath} (${stateTag})`);
    }
  } else {
    io.out("Worktrees: none detected");
  }
  io.out(
    result.dataPurged
      ? `Data purged: removed ${result.kilnHome}`
      : `Data preserved at ${result.kilnHome} (pass --purge-data to delete)`,
  );

  return {
    exitCode: 0,
    stdout: io.getStdout(),
    stderr: io.getStderr(),
    data: result,
  };
}

async function handleInternalMcp(
  args: readonly string[],
  options: CliRuntimeOptions,
  io: ReturnType<typeof createOutputCollector>,
): Promise<CliRunResult> {
  const parsed = parseArgs({
    args: [...args],
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (parsed.values.help) {
    io.err("Usage: kiln __mcp (internal stdio MCP bridge; requires KILN_RUN_TOKEN in environment)");
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  const env = options.env ?? process.env;
  let handle: Awaited<ReturnType<typeof runStdioMcpServer>>;
  try {
    handle = await runStdioMcpServer(env, options.mcpOptions);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.err(`kiln __mcp: ${message}`);
    return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  const usesProcessStdin = options.mcpOptions?.mcpTransport === undefined;
  await new Promise<void>((resolve) => {
    let settled = false;
    let stdinEnded = false;
    let inFlightRequests = 0;

    const done = (): void => {
      if (settled) return;
      settled = true;
      options.foregroundSignal?.removeEventListener("abort", done);
      if (usesProcessStdin) {
        process.stdin.removeListener("end", onStdinEnd);
        process.stdin.removeListener("close", onStdinEnd);
      }
      resolve();
    };

    const maybeFinishAfterDrain = (): void => {
      if (stdinEnded && inFlightRequests <= 0) {
        setImmediate(() => {
          if (stdinEnded && inFlightRequests <= 0) {
            done();
          }
        });
      }
    };

    const onStdinEnd = (): void => {
      stdinEnded = true;
      maybeFinishAfterDrain();
    };

    if (options.foregroundSignal?.aborted) {
      done();
      return;
    }
    options.foregroundSignal?.addEventListener("abort", done, { once: true });

    const prevServerOnClose = handle.server.onclose;
    handle.server.onclose = () => {
      prevServerOnClose?.();
      done();
    };

    if (usesProcessStdin) {
      const origOnMessage = handle.transport.onmessage;
      handle.transport.onmessage = (message, extra) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "id" in message &&
          "method" in message
        ) {
          inFlightRequests += 1;
        }
        origOnMessage?.(message, extra);
      };

      const origSend = handle.transport.send.bind(handle.transport);
      handle.transport.send = async (message, sendOptions) => {
        try {
          await origSend(message, sendOptions);
        } finally {
          if (
            typeof message === "object" &&
            message !== null &&
            "id" in message &&
            !("method" in message)
          ) {
            inFlightRequests = Math.max(0, inFlightRequests - 1);
            maybeFinishAfterDrain();
          }
        }
      };

      process.stdin.once("end", onStdinEnd);
      process.stdin.once("close", onStdinEnd);
    }
  });

  try {
    await handle.close();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.err(`kiln __mcp shutdown error: ${message}`);
    return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr() };
}

/**
 * Executes the Kiln CLI against `argv` without calling `process.exit`, returning
 * buffered stdout, stderr, exit code, and structured command payload.
 */
export async function runCli(
  argv: readonly string[],
  options: CliRuntimeOptions = {},
): Promise<CliRunResult> {
  const io = createOutputCollector(options);

  if (argv.length === 0) {
    io.out(GLOBAL_HELP);
    return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr() };
  }

  try {
    const first = argv[0]!;
    if (first.startsWith("-")) {
      const top = parseArgs({
        args: [...argv],
        options: {
          help: { type: "boolean", short: "h", default: false },
          version: { type: "boolean", short: "v", default: false },
        },
        strict: true,
        allowPositionals: true,
      });

      if (top.values.help) {
        io.out(GLOBAL_HELP);
        return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr() };
      }
      if (top.values.version) {
        io.out(`kiln ${CLI_VERSION}`);
        return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr() };
      }
      io.out(GLOBAL_HELP);
      return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr() };
    }

    const [command, ...rest] = argv;
    switch (command) {
      case "__mcp":
        return await handleInternalMcp(rest, options, io);
      case "help":
        io.out(GLOBAL_HELP);
        return { exitCode: 0, stdout: io.getStdout(), stderr: io.getStderr() };
      case "up":
        return await handleUp(rest, options, io);
      case "down":
        return await handleDown(rest, options, io);
      case "open":
        return await handleOpen(rest, options, io);
      case "status":
        return await handleStatus(rest, options, io);
      case "draft":
        return await handleDraft(rest, options, io);
      case "decide":
        return await handleDecide(rest, options, io);
      case "rm":
        return await handleRm(rest, options, io);
      case "space":
        return await handleSpace(rest, options, io);
      case "remote":
        return await handleRemote(rest, options, io);
      case "doctor":
        return await handleDoctor(rest, options, io);
      case "service":
        return await handleService(rest, options, io);
      case "uninstall":
        return await handleUninstall(rest, options, io);
      default:
        throw new CliUsageError(`Unknown command "${command}"`, GLOBAL_HELP);
    }
  } catch (err) {
    if (err instanceof CliUsageError) {
      io.err(err.message);
      if (err.helpText) {
        io.err("");
        io.err(err.helpText);
      }
      return { exitCode: 2, stdout: io.getStdout(), stderr: io.getStderr() };
    }

    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      typeof (err as { code: unknown }).code === "string" &&
      (err as { code: string }).code.startsWith("ERR_PARSE_ARGS_")
    ) {
      const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : undefined;
      const help = command && COMMAND_HELP[command] ? COMMAND_HELP[command] : GLOBAL_HELP;
      io.err(err instanceof Error ? err.message : String(err));
      io.err("");
      io.err(help);
      return { exitCode: 2, stdout: io.getStdout(), stderr: io.getStderr() };
    }

    const message = err instanceof Error ? err.message : String(err);
    io.err(message);
    return { exitCode: 1, stdout: io.getStdout(), stderr: io.getStderr() };
  }
}

/**
 * Process entrypoint shared by Node (`dist/bin.js`) and standalone Bun compiled binaries.
 */
export function runCliProcessMain(): void {
  const main = async (): Promise<void> => {
    const foregroundAc = new AbortController();
    const onSignal = (): void => {
      foregroundAc.abort();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    try {
      const result = await runCli(process.argv.slice(2), {
        stdout: process.stdout,
        stderr: process.stderr,
        foregroundSignal: foregroundAc.signal,
      });
      process.exitCode = result.exitCode;
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  };

  main().catch((err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
