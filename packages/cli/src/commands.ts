import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import {
  DecideRequestSchema,
  DraftCardSchema,
  PrioritySchema,
  TrackSchema,
  WorkspaceModeSchema,
  type DraftCard,
  type PendingDecision,
  type Priority,
  type StageId,
  type TaskStatus,
  type Track,
  type WorkspaceMode,
} from "@kiln/protocol";
import {
  BackendRegistry,
  DEFAULT_KILND_HOST,
  DEFAULT_KILND_PORT,
  KilnPaths,
  KilnStore,
  KilndServer,
  PaseoBackend,
  PendingDecisionStore,
  assertSafeSegment,
  buildSanitizedEnv,
  computeUsageSnapshot,
  countRunningLeafTasks,
  deriveTaskStatus,
  ensureDir,
  writeFileAtomic,
  type ExecutionBackend,
  type UsageSnapshot,
} from "@kiln/kernel";
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
  type ServiceOptions,
  type SignalProcessFn,
  type SupportedServicePlatform,
  type SystemControlFn,
} from "./service.js";

const execFileAsync = promisify(execFile);
const CLI_VERSION = "0.0.1";
const HEALTH_TIMEOUT_MS = 1_500;
const API_TIMEOUT_MS = 5_000;
const DAEMON_START_TIMEOUT_MS = 5_000;

export type CliOutputSink =
  | ((chunk: string) => void)
  | { write(chunk: string): unknown };

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
  port?: number;
  host?: string;
  fetchImpl?: typeof fetch;
  openUrl?: (url: string) => Promise<void> | void;
  spawnDaemon?: (
    ctx: SpawnDaemonContext,
  ) => Promise<SpawnDaemonResult> | SpawnDaemonResult;
  stopDaemon?: () => Promise<boolean | void> | boolean | void;
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
  backendRegistry?: BackendRegistry;
  createPaseoBackend?: (opts: { url?: string; password?: string }) => ExecutionBackend;
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
  id: "node" | "git" | "apfs_clone" | "kilnd" | "paseo" | "service";
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
  constructor(message: string, readonly helpText?: string) {
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
  "        [--paseo-url <url>] [--no-paseo]",
  "  down                                               Stop managed kilnd",
  "  open [--port <port>] [--host <host>]               Open Kiln web UI",
  "  status [--port <port>] [--host <host>] [--json]    Show tasks, pending decisions, usage",
  '  draft "<idea>" [--space <id>] [--priority <P0-P3>] Create a draft card',
  "        [--track <L1|L2>] [--mode <mode>] [--id <id>]",
  "  decide [task-id] [--option <id>] [--rationale <t>] List or submit pending decisions",
  "        [--apply-ledger] [--decision <id>]",
  "  doctor [--port <port>] [--host <host>] [--json]    Verify Node, Git, APFS, kilnd, Paseo, service",
  "  service <install|uninstall|status>                 Manage OS startup service",
  "  uninstall [--purge-data]                           Stop daemon, remove service, inspect worktrees",
  "",
  "Global options:",
  "  -h, --help       Show help",
  "  -v, --version    Show CLI version",
].join("\n");

const COMMAND_HELP: Record<string, string> = {
  up: "Usage: kiln up [--port <port>] [--host <host>] [--foreground] [--paseo-url <url>] [--no-paseo]",
  down: "Usage: kiln down",
  open: "Usage: kiln open [--port <port>] [--host <host>]",
  status: "Usage: kiln status [--port <port>] [--host <host>] [--json]",
  draft:
    'Usage: kiln draft "<idea>" [--id <id>] [--space <id>] [--priority <P0|P1|P2|P3>] [--track <L1|L2>] [--mode <git_worktree|host_scoped|scratch_dir>] [--port <port>] [--host <host>]',
  decide:
    "Usage: kiln decide [task-id] [--option <id>] [--decision <id>] [--rationale <text>] [--apply-ledger] [--port <port>] [--host <host>]",
  doctor: "Usage: kiln doctor [--port <port>] [--host <host>] [--json]",
  service:
    "Usage: kiln service <install|uninstall|status> [--platform <darwin|linux>] [--label <label>] [--service-name <name>]",
  uninstall: "Usage: kiln uninstall [--purge-data] [--platform <darwin|linux>]",
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

function parseSafeCliSegment(
  value: string,
  label: string,
  helpText?: string,
): string {
  try {
    return assertSafeSegment(value, label);
  } catch (err) {
    throw new CliUsageError(
      err instanceof Error ? err.message : String(err),
      helpText,
    );
  }
}

function parsePortValue(
  rawPort: string | undefined,
  fallback: number,
  allowZero: boolean,
): number {
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
  if (
    (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
    parsed.hostname.length === 0
  ) {
    throw new CliUsageError(
      `Invalid --paseo-url "${rawUrl}": expected a ws:// or wss:// URL`,
      COMMAND_HELP.up,
    );
  }
  return trimmed;
}

export interface BuildDaemonForegroundArgsInput {
  entrypoint: string;
  host: string;
  port: number;
  paseoUrl?: string;
  disablePaseo?: boolean;
}

/**
 * Builds the child process argument list used by `kiln up` when spawning
 * `kilnd` in detached foreground mode.
 */
export function buildDaemonForegroundArgs(
  input: BuildDaemonForegroundArgsInput,
): string[] {
  const args = [
    input.entrypoint,
    "up",
    "--foreground",
    "--host",
    input.host,
    "--port",
    String(input.port),
  ];
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
  if (rawPlatform !== "darwin" && rawPlatform !== "linux") {
    throw new CliUsageError(
      `Invalid --platform "${rawPlatform}": expected "darwin" or "linux"`,
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
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    byAgent: {},
    byModel: {},
  };
}

function readOfflineStatusSummary(
  kilnHome: string,
  baseUrl: string,
  now: Date,
): CliStatusSummary {
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
    const todayTurns = allTurns.filter((turn) =>
      turn.recorded_at.startsWith(todayPrefix),
    );
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
  const explicitRunning = options.isDaemonRunning
    ? await options.isDaemonRunning()
    : null;

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

  const activeList = summary.tasks.filter((task) =>
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
  });
  return { stdout: result.stdout, stderr: result.stderr };
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

  const kilnHome = resolveCliKilnHome(options);
  const host = parseHostValue(parsed.values.host, options.host);
  const allowZeroPort =
    Boolean(parsed.values.foreground) || Boolean(options.spawnDaemon);
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
  const explicitCliOrOptionPaseoUrl =
    parsed.values["paseo-url"] ?? options.paseoUrl;
  const rawPaseoUrl =
    explicitCliOrOptionPaseoUrl ??
    (disablePaseo ? undefined : process.env.PASEO_URL);
  const paseoUrl = parsePaseoUrlValue(rawPaseoUrl);

  const baseUrl = buildBaseUrl(host, port);
  const pidFile = resolveKilnPidPath(kilnHome);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const explicitRunning = options.isDaemonRunning
    ? await options.isDaemonRunning()
    : null;

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
      if (
        (ownsRegistry || options.createPaseoBackend !== undefined) &&
        !disablePaseo &&
        !backendRegistry.has("paseo")
      ) {
        const paseoOpts: { url?: string; password?: string } = {
          ...(paseoUrl ? { url: paseoUrl } : {}),
          ...(process.env.PASEO_PASSWORD
            ? { password: process.env.PASEO_PASSWORD }
            : {}),
        };
        const paseoBackend = options.createPaseoBackend
          ? options.createPaseoBackend(paseoOpts)
          : new PaseoBackend(paseoOpts);
        backendRegistry.register(paseoBackend);
      }

      server = new KilndServer({
        kilnHome,
        host,
        port,
        enableOrchestrator: true,
        backendRegistry,
      });
      const addr = await server.start();
      writeFileAtomic(pidFile, `${process.pid}\n`);
      io.out(
        `kilnd listening in foreground at ${addr.baseUrl} (PID ${process.pid}, socket ${addr.socketPath}).`,
      );
      options.onForegroundServer?.(server);

      if (options.foregroundSignal) {
        await new Promise<void>((resolve) => {
          if (options.foregroundSignal!.aborted) {
            resolve();
            return;
          }
          options.foregroundSignal!.addEventListener("abort", () => resolve(), {
            once: true,
          });
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

  const entrypoint = resolveDefaultCliEntrypoint();
  const logDir = path.join(kilnHome, "logs");
  ensureDir(logDir);
  const logPath = path.join(logDir, "kilnd.log");
  const outFd = fs.openSync(logPath, "a");

  let childPid: number | undefined;
  let earlyExitError: string | null = null;
  let childExited = false;

  try {
    const spawnArgs = buildDaemonForegroundArgs({
      entrypoint,
      host,
      port,
      ...(explicitCliOrOptionPaseoUrl !== undefined && paseoUrl !== undefined
        ? { paseoUrl }
        : {}),
      disablePaseo:
        Boolean(parsed.values["no-paseo"]) || Boolean(options.disablePaseo),
    });
    const child = spawn(
      process.execPath,
      spawnArgs,
      {
        detached: true,
        stdio: ["ignore", outFd, outFd],
        env: { ...process.env, KILN_HOME: kilnHome },
      },
    );
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
      io.err(earlyExitError ?? "kilnd exited before becoming healthy.");
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
    stopDaemon: options.stopDaemon,
    signalProcess: options.signalProcess,
  });

  if (res.stopped) {
    io.out(
      `Stopped kilnd${res.pid !== null ? ` (PID ${res.pid})` : ""}.`,
    );
  } else if (res.removedStalePid) {
    io.out(
      `Removed stale kilnd.pid${res.pid !== null ? ` (PID ${res.pid} not running)` : ""}.`,
    );
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
  const port = parsePortValue(
    parsed.values.port,
    options.port ?? DEFAULT_KILND_PORT,
    false,
  );
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
  const port = parsePortValue(
    parsed.values.port,
    options.port ?? DEFAULT_KILND_PORT,
    false,
  );
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
    throw new CliUsageError(
      "draft requires exactly one <idea> argument",
      COMMAND_HELP.draft,
    );
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
  const space = parseSafeCliSegment(
    parsed.values.space ?? "local",
    "space",
    COMMAND_HELP.draft,
  );

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
    throw new CliUsageError(
      'Track "L3" is Post-MVP and not supported yet',
      COMMAND_HELP.draft,
    );
  }

  const modeResult = WorkspaceModeSchema.safeParse(
    parsed.values.mode ?? "git_worktree",
  );
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
  const port = parsePortValue(
    parsed.values.port,
    options.port ?? DEFAULT_KILND_PORT,
    false,
  );
  const baseUrl = buildBaseUrl(host, port);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const explicitRunning = options.isDaemonRunning
    ? await options.isDaemonRunning()
    : null;

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
  const port = parsePortValue(
    parsed.values.port,
    options.port ?? DEFAULT_KILND_PORT,
    false,
  );
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
      io.out(
        taskId
          ? `No pending decisions for task "${taskId}".`
          : "No pending decisions.",
      );
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
    ...(parsed.values.rationale !== undefined
      ? { rationale: parsed.values.rationale }
      : {}),
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

    const backends = Array.isArray(body.backends)
      ? (body.backends as AgentsEndpointBackend[])
      : [];
    const agents = Array.isArray(body.agents)
      ? (body.agents as AgentsEndpointAgent[])
      : [];

    const connectedBackends = backends.filter(
      (backend) =>
        backend !== null &&
        typeof backend === "object" &&
        backend.connected === true,
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
        agentIds.length > 0
          ? `agents: ${agentIds.join(", ")}`
          : "0 agents discovered";

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
  const port = parsePortValue(
    parsed.values.port,
    options.port ?? DEFAULT_KILND_PORT,
    false,
  );
  const baseUrl = buildBaseUrl(host, port);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const execImpl = options.execFileImpl ?? defaultExecFile;

  const checks: DoctorCheckResult[] = [];

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
        detail: cloneOk
          ? "APFS clone (/bin/cp -c) available"
          : "APFS clone verification mismatch",
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
  const explicitRunning = options.isDaemonRunning
    ? await options.isDaemonRunning()
    : null;
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

  if (platform === "darwin" || platform === "linux") {
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
    purgeData: parsed.values["purge-data"],
    stopDaemon: options.stopDaemon,
    signalProcess: options.signalProcess,
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
