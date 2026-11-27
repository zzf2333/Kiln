import path from "node:path";

export const DEFAULT_KILND_URL = "http://127.0.0.1:4310";
export const MAIN_WINDOW_LABEL = "main";
export const KILN_BIN_NAME_POSIX = "kiln";
export const KILN_BIN_NAME_WINDOWS = "kiln.exe";
export const MAX_JSON_DEPTH = 128;

export const REQUIRED_KILND_API_REVISION = 3;

export interface KilnHealth {
  ok: boolean;
  pid: number | null;
  version: string | null;
  apiRevision?: number | null;
  uiBuildId?: string | null;
}

export interface KilnLiveRatesTotals {
  costUsd: number;
  tokPerSec: number;
}

export interface KilnBootstrapSummary {
  runningCount: number;
  pendingDecisionCount: number;
  taskCount: number;
  totals: KilnLiveRatesTotals;
}

export type StartActionState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "failed"; error: string };

export type CliInstallActionState =
  | { kind: "idle" }
  | { kind: "installed"; binDir: string; inPath: boolean }
  | { kind: "failed"; error: string };

export type TrayDisplayState =
  | { kind: "offline"; reason: string | null }
  | { kind: "starting" }
  | { kind: "start_failed"; error: string }
  | { kind: "idle"; costUsd: number; taskCount: number }
  | { kind: "running"; runningCount: number; tokPerSec: number; costUsd: number }
  | {
      kind: "waiting_decision";
      pendingDecisions: number;
      runningCount: number;
      tokPerSec: number;
      costUsd: number;
    };

export interface SseEventFrame {
  id: string | null;
  event: string | null;
  data: string;
}

export type WindowClosePolicy = "destroy" | "hide";

export type StartupWindowAction = "open_immediately" | "auto_start_then_open";

export type WorkbenchRoute =
  | "board"
  | "intake"
  | "inbox"
  | "lineup"
  | "ledger"
  | "usage"
  | "settings";

export interface NormalizedKilndUrl {
  host: string;
  port: number;
  baseUrl: string;
  hostHeader: string;
}

export type UrlValidationErrorCode =
  | "Empty"
  | "ControlOrWhitespace"
  | "UnsupportedScheme"
  | "UserinfoNotAllowed"
  | "InvalidAuthority"
  | "NonLoopbackHost"
  | "InvalidPort"
  | "UnexpectedPathOrSuffix";

export class UrlValidationError extends Error {
  readonly code: UrlValidationErrorCode;

  constructor(code: UrlValidationErrorCode, message: string) {
    super(message);
    this.name = "UrlValidationError";
    this.code = code;
  }
}

function sanitizeNonNegative(v: number): number {
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

function nonEmptyTrimmed(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function trayStateFromBootstrap(summary: KilnBootstrapSummary): TrayDisplayState {
  if (summary.pendingDecisionCount > 0) {
    return {
      kind: "waiting_decision",
      pendingDecisions: summary.pendingDecisionCount,
      runningCount: summary.runningCount,
      tokPerSec: sanitizeNonNegative(summary.totals.tokPerSec),
      costUsd: sanitizeNonNegative(summary.totals.costUsd),
    };
  }
  if (summary.runningCount > 0) {
    return {
      kind: "running",
      runningCount: summary.runningCount,
      tokPerSec: sanitizeNonNegative(summary.totals.tokPerSec),
      costUsd: sanitizeNonNegative(summary.totals.costUsd),
    };
  }
  return {
    kind: "idle",
    costUsd: sanitizeNonNegative(summary.totals.costUsd),
    taskCount: summary.taskCount,
  };
}

export function trayStateFromProbe(
  health: { ok: true; value: KilnHealth } | { ok: false; reason: string },
  bootstrap: KilnBootstrapSummary | null,
): TrayDisplayState {
  if (!health.ok) {
    return { kind: "offline", reason: nonEmptyTrimmed(health.reason) };
  }
  if (!health.value.ok) {
    return { kind: "offline", reason: "kilnd ok=false" };
  }
  if (bootstrap) {
    return trayStateFromBootstrap(bootstrap);
  }
  return { kind: "idle", costUsd: 0, taskCount: 0 };
}

export function isTrayStateOnline(state: TrayDisplayState): boolean {
  return state.kind === "idle" || state.kind === "running" || state.kind === "waiting_decision";
}

export function applyStartAction(
  state: TrayDisplayState,
  action: StartActionState,
): TrayDisplayState {
  if (isTrayStateOnline(state)) {
    return state;
  }
  if (action.kind === "starting") {
    return { kind: "starting" };
  }
  if (action.kind === "failed") {
    return { kind: "start_failed", error: action.error };
  }
  return state;
}

export function closePolicyForWindow(_label: string): WindowClosePolicy {
  return "destroy";
}

export function decideStartupWindowAction(kilndOnline: boolean): StartupWindowAction {
  return kilndOnline ? "open_immediately" : "auto_start_then_open";
}

export function shouldRestartStaleDaemon(
  health: KilnHealth,
  requiredRevision: number,
  runningCount: number,
  expectedUiBuildId: string | null = null,
): boolean {
  if (!health.ok || runningCount !== 0) return false;
  if ((health.apiRevision ?? 0) < requiredRevision) return true;
  if (expectedUiBuildId !== null && health.uiBuildId !== expectedUiBuildId) return true;
  return false;
}

export function shouldPreventExit(exitCode: number | null, allowExit: boolean): boolean {
  return exitCode === null && !allowExit;
}

export function resolveDevUserDataPath(appDataDir: string, isUiDevMode: boolean): string | null {
  if (!isUiDevMode) return null;
  const trimmed = appDataDir.trim();
  if (trimmed.length === 0) return null;
  return path.join(trimmed, "Kiln-Dev");
}

export function routeHashFragment(route: WorkbenchRoute): string {
  return `view=${route}`;
}

export function buildWorkbenchUrl(
  origin: NormalizedKilndUrl,
  route?: WorkbenchRoute | null,
): string {
  if (!route) return origin.baseUrl;
  return `${origin.baseUrl}/#${routeHashFragment(route)}`;
}

export function endpointUrl(origin: NormalizedKilndUrl, reqPath: string): string {
  return reqPath.startsWith("/") ? `${origin.baseUrl}${reqPath}` : `${origin.baseUrl}/${reqPath}`;
}

function checkRawUrlCommon(raw: string): string {
  if (raw.length === 0) {
    throw new UrlValidationError("Empty", "kilnd URL must not be empty");
  }
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) {
      throw new UrlValidationError(
        "ControlOrWhitespace",
        "kilnd URL must not contain whitespace or control characters",
      );
    }
  }
  if (raw.includes("\\")) {
    throw new UrlValidationError("InvalidAuthority", "kilnd URL contains an invalid authority");
  }
  if (!raw.slice(0, 7).toLowerCase().startsWith("http://") || raw.length < 7) {
    throw new UrlValidationError("UnsupportedScheme", "kilnd URL must use http:// scheme");
  }
  return raw.slice(7);
}

function splitAuthorityAndSuffix(rest: string): [string, string] {
  let idx = -1;
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i];
    if (ch === "/" || ch === "?" || ch === "#") {
      idx = i;
      break;
    }
  }
  if (idx >= 0) {
    return [rest.slice(0, idx), rest.slice(idx)];
  }
  return [rest, ""];
}

function parseLoopbackAuthority(authority: string): {
  host: string;
  port: number;
  hasExplicitPort: boolean;
} {
  if (authority.length === 0) {
    throw new UrlValidationError("InvalidAuthority", "kilnd URL contains an invalid authority");
  }
  if (authority.includes("@")) {
    throw new UrlValidationError("UserinfoNotAllowed", "kilnd URL must not contain userinfo (@)");
  }
  if (authority.startsWith("[") || authority.endsWith("]")) {
    throw new UrlValidationError(
      "NonLoopbackHost",
      "kilnd URL host must be strictly 127.0.0.1 or localhost",
    );
  }
  const parts = authority.split(":");
  if (parts.length > 2) {
    throw new UrlValidationError("InvalidAuthority", "kilnd URL contains an invalid authority");
  }
  const hostRaw = parts[0] ?? "";
  if (hostRaw.length === 0) {
    throw new UrlValidationError("InvalidAuthority", "kilnd URL contains an invalid authority");
  }
  const hostLower = hostRaw.toLowerCase();
  if (hostLower !== "127.0.0.1" && hostLower !== "localhost") {
    throw new UrlValidationError(
      "NonLoopbackHost",
      "kilnd URL host must be strictly 127.0.0.1 or localhost",
    );
  }
  const portRaw = parts[1];
  if (portRaw === undefined) {
    return { host: hostLower, port: 80, hasExplicitPort: false };
  }
  if (portRaw.length === 0 || !/^\d+$/.test(portRaw)) {
    throw new UrlValidationError(
      "InvalidPort",
      "kilnd URL port must be an integer between 1 and 65535",
    );
  }
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UrlValidationError(
      "InvalidPort",
      "kilnd URL port must be an integer between 1 and 65535",
    );
  }
  return { host: hostLower, port, hasExplicitPort: true };
}

export function validateKilndUrl(raw: string): NormalizedKilndUrl {
  const rest = checkRawUrlCommon(raw);
  const [authority, suffix] = splitAuthorityAndSuffix(rest);
  if (suffix !== "" && suffix !== "/") {
    throw new UrlValidationError(
      "UnexpectedPathOrSuffix",
      "kilnd base URL must not include path segments, query, or fragment",
    );
  }
  const parsed = parseLoopbackAuthority(authority);
  const baseUrl = parsed.hasExplicitPort
    ? `http://${parsed.host}:${parsed.port}`
    : `http://${parsed.host}`;
  return {
    host: parsed.host,
    port: parsed.port,
    baseUrl,
    hostHeader: `${parsed.host}:${parsed.port}`,
  };
}

export interface ResolveWorkbenchOriginOptions {
  kilndUrl: NormalizedKilndUrl;
  uiDevUrlRaw?: string | null;
  isPackaged: boolean;
}

export function resolveWorkbenchOrigin(options: ResolveWorkbenchOriginOptions): NormalizedKilndUrl {
  if (options.isPackaged) {
    return options.kilndUrl;
  }
  const trimmed = nonEmptyTrimmed(options.uiDevUrlRaw);
  if (!trimmed) {
    return options.kilndUrl;
  }
  return validateKilndUrl(trimmed);
}

export function isAllowedKilndUrl(raw: string): boolean {
  try {
    validateKilndUrl(raw);
    return true;
  } catch {
    return false;
  }
}

export function isAllowedNavigationUrl(raw: string, allowedOrigin: NormalizedKilndUrl): boolean {
  try {
    const rest = checkRawUrlCommon(raw);
    const [authority] = splitAuthorityAndSuffix(rest);
    const parsed = parseLoopbackAuthority(authority);
    return parsed.host === allowedOrigin.host && parsed.port === allowedOrigin.port;
  } catch {
    return false;
  }
}

export function summarizeStartError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("unable to locate") && lower.includes("kiln")) {
    return "未找到 kiln CLI，请先安装 @zzf2333/kiln";
  }
  if (lower.includes("kiln_bin points to missing file")) {
    return "KILN_BIN 指向的文件不存在";
  }
  if (
    lower.includes("env: node:") ||
    lower.includes("node: no such file") ||
    lower.includes("cannot find node")
  ) {
    return "未找到 Node.js (>=22)，请先安装 Node.js";
  }
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const stripped = firstLine.startsWith("kiln up failed:")
    ? firstLine.slice("kiln up failed:".length).trim()
    : firstLine;
  const collapsed = stripped.split(/\s+/).filter(Boolean).join(" ");
  if (collapsed.length === 0) {
    return "未知启动错误";
  }
  const chars = Array.from(collapsed);
  if (chars.length > 72) {
    return `${chars.slice(0, 71).join("")}…`;
  }
  return collapsed;
}

export function formatTrayTitle(state: TrayDisplayState): string {
  switch (state.kind) {
    case "offline":
      return "离线";
    case "starting":
      return "启动中…";
    case "start_failed":
      return "启动失败";
    case "idle":
      return "";
    case "running": {
      const rate = sanitizeNonNegative(state.tokPerSec);
      return rate >= 1
        ? `${state.runningCount} 运行 · ${rate.toFixed(0)} tok/s`
        : `${state.runningCount} 运行`;
    }
    case "waiting_decision":
      return state.runningCount > 0
        ? `${state.pendingDecisions} 待决 · ${state.runningCount} 运行`
        : `${state.pendingDecisions} 待决`;
  }
}

export function formatTrayTooltip(state: TrayDisplayState, kilndUrl: string): string {
  switch (state.kind) {
    case "offline":
      return state.reason && state.reason.trim().length > 0
        ? `Kiln · kilnd 未运行（${state.reason.trim()}）— ${kilndUrl}`
        : `Kiln · kilnd 离线 — ${kilndUrl}`;
    case "starting":
      return `Kiln · 正在启动 kilnd… — ${kilndUrl}`;
    case "start_failed":
      return `Kiln · 启动 kilnd 失败（${summarizeStartError(state.error)}）— ${kilndUrl}`;
    case "idle":
      return `Kiln · 待机（任务 ${state.taskCount} 个 · 累计 $${sanitizeNonNegative(state.costUsd).toFixed(2)}）— ${kilndUrl}`;
    case "running":
      return `Kiln · 运行中：${state.runningCount} 个任务 · ${sanitizeNonNegative(state.tokPerSec).toFixed(1)} tok/s · 累计 $${sanitizeNonNegative(state.costUsd).toFixed(2)}`;
    case "waiting_decision":
      return `Kiln · 待决拍板：${state.pendingDecisions} 项 · 运行中 ${state.runningCount} 个 · ${sanitizeNonNegative(state.tokPerSec).toFixed(1)} tok/s · 累计 $${sanitizeNonNegative(state.costUsd).toFixed(2)}`;
  }
}

export function formatTrayVersionTag(appVersion: string, daemonVersion: string | null): string {
  const cleanApp = appVersion.trim().replace(/^v+/, "");
  const appLabel = cleanApp.length > 0 ? cleanApp : "unknown";
  const cleanDaemon = daemonVersion ? daemonVersion.trim().replace(/^v+/, "") : "";
  if (cleanDaemon.length > 0 && cleanDaemon !== appLabel) {
    return `App v${appLabel} / kilnd v${cleanDaemon}`;
  }
  return `v${appLabel}`;
}

export function formatTrayHeader(appVersion: string, daemonVersion: string | null): string {
  return `Kiln 工作台 · ${formatTrayVersionTag(appVersion, daemonVersion)}`;
}

export function formatTrayMenuStatus(state: TrayDisplayState): string {
  switch (state.kind) {
    case "offline":
      return "后台引擎未运行";
    case "starting":
      return "正在启动后台引擎…";
    case "start_failed":
      return `后台引擎启动失败：${summarizeStartError(state.error)}`;
    case "idle":
      return `待机 · ${state.taskCount} 个任务 · 累计 $${sanitizeNonNegative(state.costUsd).toFixed(2)}`;
    case "running":
      return `运行中 · ${state.runningCount} 个任务 · ${sanitizeNonNegative(state.tokPerSec).toFixed(0)} tok/s · $${sanitizeNonNegative(state.costUsd).toFixed(2)}`;
    case "waiting_decision": {
      const cost = sanitizeNonNegative(state.costUsd).toFixed(2);
      return state.runningCount > 0
        ? `${state.pendingDecisions} 项待决 · ${state.runningCount} 个运行中 · $${cost}`
        : `${state.pendingDecisions} 项待决 · $${cost}`;
    }
  }
}

export function formatTrayTooltipWithVersion(
  state: TrayDisplayState,
  kilndUrl: string,
  appVersion: string,
  daemonVersion: string | null,
): string {
  const base = formatTrayTooltip(state, kilndUrl);
  const tag = formatTrayVersionTag(appVersion, daemonVersion);
  if (base.startsWith("Kiln · ")) {
    return `Kiln ${tag} · ${base.slice("Kiln · ".length)}`;
  }
  return `${base} · ${tag}`;
}

export function formatInboxMenuLabel(state: TrayDisplayState): string {
  if (state.kind === "waiting_decision" && state.pendingDecisions > 0) {
    return `等你决定（${state.pendingDecisions}）`;
  }
  return "等你决定";
}

export function formatEngineSubmenuLabel(state: TrayDisplayState): string {
  switch (state.kind) {
    case "offline":
      return "后台引擎（未运行）";
    case "starting":
      return "后台引擎（启动中…）";
    case "start_failed":
      return "后台引擎（启动失败）";
    case "idle":
    case "running":
    case "waiting_decision":
      return "后台引擎（运行中）";
  }
}

export function formatStartMenuLabel(state: TrayDisplayState): string {
  if (state.kind === "starting") return "正在启动 kilnd…";
  if (state.kind === "start_failed") return "重试启动 kilnd";
  return "启动 kilnd";
}

export function isStartMenuEnabled(state: TrayDisplayState): boolean {
  return state.kind === "offline" || state.kind === "start_failed";
}

export function formatInstallCliMenuLabel(state: CliInstallActionState): string {
  if (state.kind === "idle") return "安装 kiln 终端命令";
  if (state.kind === "installed") {
    return state.inPath
      ? `已安装 kiln 终端命令（${state.binDir}）`
      : `已安装 kiln 终端命令（请将 ${state.binDir} 加入 PATH）`;
  }
  return `安装终端命令失败（${summarizeStartError(state.error)}）`;
}

export function platformKilnBinaryName(isWindows: boolean): string {
  return isWindows ? KILN_BIN_NAME_WINDOWS : KILN_BIN_NAME_POSIX;
}

export function platformKilnBinaryNames(isWindows: boolean): readonly string[] {
  return isWindows ? ["kiln.exe", "kiln.cmd"] : ["kiln"];
}

export function windowsKilnSearchDirs(
  localAppData: string | null | undefined,
  homeDir: string | null | undefined,
): string[] {
  const dirs: string[] = [];
  const pushUnique = (d: string): void => {
    if (d.length > 0 && !dirs.includes(d)) dirs.push(d);
  };
  if (localAppData && localAppData.length > 0) {
    pushUnique(path.win32.join(localAppData, "Kiln", "bin"));
  }
  if (homeDir && homeDir.length > 0) {
    pushUnique(path.win32.join(homeDir, "AppData", "Local", "Kiln", "bin"));
    pushUnique(path.win32.join(homeDir, ".local", "bin"));
    pushUnique(path.win32.join(homeDir, "AppData", "Roaming", "npm"));
  }
  return dirs;
}

function assertSafeShimArg(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || value[i] === '"') {
      throw new Error(`${label} contains forbidden control or quote characters`);
    }
  }
  return value;
}

function quotePosixSingleArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function renderPosixCliWrapper(input: {
  executable: string;
  entrypoint?: string | null;
  electronAsNode?: boolean;
}): string {
  const exe = assertSafeShimArg(input.executable, "executable path");
  const parts: string[] = [];
  if (input.electronAsNode) {
    parts.push("env", "ELECTRON_RUN_AS_NODE=1");
  }
  parts.push(quotePosixSingleArg(exe));
  if (input.entrypoint) {
    const ep = assertSafeShimArg(input.entrypoint, "entrypoint path");
    parts.push(quotePosixSingleArg(ep));
  }
  return `#!/bin/sh\nexec ${parts.join(" ")} "$@"\n`;
}

export function renderWindowsCliShim(input: {
  executable: string;
  entrypoint?: string | null;
  electronAsNode?: boolean;
}): string {
  const rawExe = assertSafeShimArg(input.executable, "executable path");
  const escapedExe = rawExe.replace(/%/g, "%%");
  const lower = rawExe.toLowerCase();
  const isBatch = lower.endsWith(".cmd") || lower.endsWith(".bat");

  if (input.entrypoint) {
    const rawEp = assertSafeShimArg(input.entrypoint, "entrypoint path");
    const escapedEp = rawEp.replace(/%/g, "%%");
    if (input.electronAsNode) {
      return `@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${escapedExe}" "${escapedEp}" %*\r\n`;
    }
    return `@echo off\r\n"${escapedExe}" "${escapedEp}" %*\r\n`;
  }

  if (isBatch) {
    return `@echo off\r\ncall "${escapedExe}" %*\r\n`;
  }
  return `@echo off\r\n"${escapedExe}" %*\r\n`;
}

function normalizeDirForPathCompare(dir: string, caseInsensitive: boolean): string {
  if (dir.length === 0) return "";
  if (!caseInsensitive) {
    const collapsed = dir.replace(/\/+/g, "/");
    return collapsed === "/" ? "/" : collapsed.replace(/\/$/, "");
  }

  const win = dir.replace(/\//g, "\\");
  if (/^\\+$/.test(win)) return "\\";

  const hasUncPrefix = win.length >= 3 && win.startsWith("\\\\") && win[2] !== "\\";
  const body = (hasUncPrefix ? win.slice(2) : win).replace(/\\+/g, "\\");
  const rebuilt = hasUncPrefix ? `\\\\${body}` : body;
  const trimmed = /^[a-zA-Z]:\\$/.test(rebuilt) ? rebuilt : rebuilt.replace(/\\$/, "");
  return trimmed.toLowerCase();
}

export function pathContainsDir(
  pathEnv: string | null | undefined,
  targetDir: string,
  caseInsensitive: boolean,
): boolean {
  if (!pathEnv) return false;
  const needle = normalizeDirForPathCompare(targetDir, caseInsensitive);
  if (needle.length === 0) return false;
  const sep = caseInsensitive ? ";" : ":";
  return pathEnv
    .split(sep)
    .filter((entry) => entry.length > 0)
    .some((entry) => normalizeDirForPathCompare(entry, caseInsensitive) === needle);
}

export function parseSemverKey(name: string): readonly [number, number, number] | null {
  const trimmed = name.trim();
  const withoutV = trimmed.startsWith("v") || trimmed.startsWith("V") ? trimmed.slice(1) : trimmed;
  const core = withoutV.split("-")[0] ?? "";
  if (core.length === 0) return null;
  const parts = core.split(".");
  if (parts.length > 3) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    nums.push(Number(part));
  }
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
}

export function standardKilnSearchDirs(
  homeDir: string | null | undefined,
  versionedNodeBins: readonly string[],
): string[] {
  const dirs: string[] = [];
  const pushUnique = (d: string): void => {
    if (d.length > 0 && !dirs.includes(d)) dirs.push(d);
  };
  pushUnique("/opt/homebrew/bin");
  pushUnique("/usr/local/bin");
  if (homeDir && homeDir.length > 0) {
    for (const rel of [
      ".local/bin",
      ".npm-global/bin",
      ".volta/bin",
      ".asdf/shims",
      "Library/pnpm",
      ".local/share/pnpm",
      ".local/share/mise/installs/node/global/bin",
      ".local/share/mise/installs/node/lts/bin",
      ".local/share/mise/installs/node/latest/bin",
      ".local/share/mise/shims",
      ".nvm/current/bin",
      ".fnm/current/bin",
    ]) {
      pushUnique(path.posix.join(homeDir, rel));
    }
  }
  for (const dir of versionedNodeBins) {
    pushUnique(dir);
  }
  return dirs;
}

const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

export function buildChildCommandPathDirs(
  binDir: string | null | undefined,
  currentPath: string | null | undefined,
  homeDir: string | null | undefined,
  versionedNodeBins: readonly string[],
): string[] {
  const dirs: string[] = [];
  const pushUnique = (d: string): void => {
    if (d.length > 0 && !dirs.includes(d)) dirs.push(d);
  };

  if (binDir) pushUnique(binDir);

  const existingEntries = (currentPath ?? "").split(path.delimiter).filter((p) => p.length > 0);
  for (const dir of existingEntries) {
    if (!SYSTEM_PATH_DIRS.includes(dir)) pushUnique(dir);
  }

  if (homeDir && homeDir.length > 0) {
    for (const rel of [
      ".local/share/mise/installs/node/global/bin",
      ".local/share/mise/installs/node/lts/bin",
      ".local/share/mise/installs/node/latest/bin",
      ".local/share/mise/shims",
      ".volta/bin",
      ".asdf/shims",
      ".nvm/current/bin",
      ".fnm/current/bin",
    ]) {
      pushUnique(path.posix.join(homeDir, rel));
    }
  }

  for (const dir of versionedNodeBins) pushUnique(dir);

  if (homeDir && homeDir.length > 0) {
    for (const rel of [".npm-global/bin", "Library/pnpm", ".local/share/pnpm", ".local/bin"]) {
      pushUnique(path.posix.join(homeDir, rel));
    }
  }

  for (const dir of [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/opt/homebrew/opt/node@22/bin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/local/opt/node@22/bin",
  ]) {
    pushUnique(dir);
  }

  for (const dir of existingEntries) pushUnique(dir);
  for (const sys of SYSTEM_PATH_DIRS) pushUnique(sys);
  return dirs;
}

export function parseSseEventBlock(block: string): SseEventFrame | null {
  let id: string | null = null;
  let event: string | null = null;
  const dataLines: string[] = [];

  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0 || line.startsWith(":")) continue;
    const colonIdx = line.indexOf(":");
    const field = colonIdx >= 0 ? line.slice(0, colonIdx) : line;
    const rawVal = colonIdx >= 0 ? line.slice(colonIdx + 1) : "";
    const value = rawVal.startsWith(" ") ? rawVal.slice(1) : rawVal;
    if (field === "id") {
      if (!value.includes("\0")) id = value;
    } else if (field === "event") {
      event = value.length > 0 ? value : null;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) return null;
  return { id, event, data: dataLines.join("\n") };
}

function measureJsonDepth(value: unknown, depth = 0): number {
  if (depth > MAX_JSON_DEPTH) return depth;
  if (Array.isArray(value)) {
    let max = depth;
    for (const item of value) {
      const d = measureJsonDepth(item, depth + 1);
      if (d > MAX_JSON_DEPTH) return d;
      if (d > max) max = d;
    }
    return max;
  }
  if (value !== null && typeof value === "object") {
    let max = depth;
    for (const v of Object.values(value)) {
      const d = measureJsonDepth(v, depth + 1);
      if (d > MAX_JSON_DEPTH) return d;
      if (d > max) max = d;
    }
    return max;
  }
  return depth;
}

export function parseHealthJson(body: string): KilnHealth {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`JSON syntax error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (measureJsonDepth(parsed) > MAX_JSON_DEPTH) {
    throw new Error("JSON nesting depth exceeded limit");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON schema mismatch: health root must be object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.ok !== "boolean") {
    throw new Error("JSON schema mismatch: health.ok must be boolean");
  }
  let pid: number | null = null;
  if (obj.pid !== undefined && obj.pid !== null) {
    if (typeof obj.pid !== "number" || !Number.isInteger(obj.pid) || obj.pid < 0) {
      throw new Error("JSON schema mismatch: health.pid must be u64");
    }
    pid = obj.pid;
  }
  let version: string | null = null;
  if (obj.version !== undefined && obj.version !== null) {
    if (typeof obj.version !== "string") {
      throw new Error("JSON schema mismatch: health.version must be string");
    }
    version = obj.version;
  }
  let apiRevision: number | null = null;
  if (obj.api_revision !== undefined && obj.api_revision !== null) {
    if (
      typeof obj.api_revision !== "number" ||
      !Number.isInteger(obj.api_revision) ||
      obj.api_revision < 0
    ) {
      throw new Error("JSON schema mismatch: health.api_revision must be non-negative integer");
    }
    apiRevision = obj.api_revision;
  }
  let uiBuildId: string | null = null;
  if (obj.ui_build_id !== undefined && obj.ui_build_id !== null) {
    if (typeof obj.ui_build_id !== "string" || obj.ui_build_id.trim().length === 0) {
      throw new Error("JSON schema mismatch: health.ui_build_id must be non-empty string");
    }
    uiBuildId = obj.ui_build_id.trim();
  }
  return {
    ok: obj.ok,
    pid,
    version,
    ...(apiRevision !== null ? { apiRevision } : {}),
    ...(uiBuildId !== null ? { uiBuildId } : {}),
  };
}

export function parseBootstrapSummaryJson(body: string): KilnBootstrapSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`JSON syntax error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (measureJsonDepth(parsed) > MAX_JSON_DEPTH) {
    throw new Error("JSON nesting depth exceeded limit");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON schema mismatch: bootstrap root must be object");
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.runningCount !== "number" ||
    !Number.isInteger(obj.runningCount) ||
    obj.runningCount < 0
  ) {
    throw new Error("JSON schema mismatch: bootstrap.runningCount must be non-negative integer");
  }
  if (!Array.isArray(obj.pendingDecisions)) {
    throw new Error("JSON schema mismatch: bootstrap.pendingDecisions must be array");
  }
  let taskCount = 0;
  if (obj.tasks !== undefined && obj.tasks !== null) {
    if (!Array.isArray(obj.tasks)) {
      throw new Error("JSON schema mismatch: bootstrap.tasks must be array");
    }
    taskCount = obj.tasks.length;
  }

  let totals: KilnLiveRatesTotals = { costUsd: 0, tokPerSec: 0 };
  if (obj.liveRates !== undefined && obj.liveRates !== null) {
    if (typeof obj.liveRates !== "object" || Array.isArray(obj.liveRates)) {
      throw new Error("JSON schema mismatch: bootstrap.liveRates must be object");
    }
    const lr = obj.liveRates as Record<string, unknown>;
    if (lr.totals !== undefined && lr.totals !== null) {
      if (typeof lr.totals !== "object" || Array.isArray(lr.totals)) {
        throw new Error("JSON schema mismatch: bootstrap.liveRates.totals must be object");
      }
      const t = lr.totals as Record<string, unknown>;
      const parseNonNeg = (v: unknown, msg: string): number => {
        if (v === undefined || v === null) return 0;
        if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(msg);
        return sanitizeNonNegative(v);
      };
      totals = {
        costUsd: parseNonNeg(t.costUsd, "bootstrap.liveRates.totals.costUsd must be number"),
        tokPerSec: parseNonNeg(t.tokPerSec, "bootstrap.liveRates.totals.tokPerSec must be number"),
      };
    }
  }

  return {
    runningCount: obj.runningCount,
    pendingDecisionCount: obj.pendingDecisions.length,
    taskCount,
    totals,
  };
}
