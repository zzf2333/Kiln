import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SpaceConfigSchema } from "@kiln/protocol";
import {
  KilnPaths,
  assertSafeSegment,
  buildSanitizedEnv,
  ensureDir,
  isCompiledKilnBinary,
  isWindowsNamedPipe,
  readYamlOptional,
  realpathCanonical,
  resolveDefaultIpcPath,
  resolveKilnHome,
  sendNetHttpRequest,
  terminateProcessTree,
  writeFileAtomic,
} from "@kiln/kernel";

const execFileAsync = promisify(execFile);
const CONTROL_CHAR_REGEX = /[\u0000-\u001f\u007f]/;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_STOP_TIMEOUT_MS = 3_000;
const SHUTDOWN_RPC_TIMEOUT_MS = 1_500;
const STOP_POLL_INTERVAL_MS = 25;

export const MACOS_LAUNCH_AGENT_LABEL = "work.kiln.daemon";
export const LINUX_SYSTEMD_SERVICE_NAME = "kilnd.service";
export const WINDOWS_RUN_REGISTRY_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const WINDOWS_RUN_VALUE_NAME = "KilnDaemon";

export type SupportedServicePlatform = "darwin" | "linux" | "win32";

export type SystemControlFn = (command: string, args: readonly string[]) => Promise<void> | void;

export interface WindowsRegistryBackend {
  add(key: string, valueName: string, data: string): Promise<void> | void;
  delete(key: string, valueName: string): Promise<boolean> | boolean;
  query(key: string, valueName: string): string | null;
}

export type GracefulShutdownRequestFn = (ctx: {
  socketPath: string;
  shutdownToken: string;
}) => Promise<boolean>;

export type KillProcessTreeFn = (pid: number) => Promise<boolean> | boolean;
export type SignalProcessFn = (pid: number, signal?: NodeJS.Signals | 0) => void;
export type ExecGitFn = (args: readonly string[], cwd?: string) => Promise<string>;

export interface RenderLaunchAgentPlistInput {
  nodeExecutable: string;
  kilndEntrypoint?: string;
  kilnHome: string;
  logDir: string;
  label?: string;
  args?: readonly string[];
  electronAsNode?: boolean;
}

export interface RenderSystemdUnitInput {
  nodeExecutable: string;
  kilndEntrypoint?: string;
  kilnHome: string;
  logDir?: string;
  description?: string;
  args?: readonly string[];
  electronAsNode?: boolean;
}

export interface RenderWindowsRunCommandInput {
  executable: string;
  kilndEntrypoint?: string;
  kilnHome: string;
  args?: readonly string[];
  electronAsNode?: boolean;
}

export interface ServiceOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  kilnHome?: string;
  launchAgentsDir?: string;
  systemdDir?: string;
  label?: string;
  serviceName?: string;
  windowsRunKey?: string;
  windowsValueName?: string;
  windowsRegistry?: WindowsRegistryBackend;
  nodeExecutable?: string;
  kilndEntrypoint?: string;
  args?: readonly string[];
  logDir?: string;
  executeSystemControl?: SystemControlFn;
}

export interface InstallServiceResult {
  installed: true;
  platform: SupportedServicePlatform;
  servicePath: string;
  executedControl: boolean;
  command?: string;
}

export interface UninstallServiceResult {
  removed: boolean;
  platform: SupportedServicePlatform;
  servicePath: string;
  executedControl: boolean;
}

export interface ServiceStatusResult {
  installed: boolean;
  platform: SupportedServicePlatform;
  servicePath: string;
}

export interface StopDaemonResult {
  stopped: boolean;
  pid: number | null;
  removedStalePid: boolean;
  method?: "callback" | "ipc_shutdown" | "signal" | "taskkill";
}

export interface DetectedWorktreeRef {
  spaceId: string;
  repoPath: string;
  worktreePath: string;
  branch: string | null;
  dirty: boolean;
  missing: boolean;
  removed?: boolean;
}

export interface UninstallOptions extends ServiceOptions {
  purgeData?: boolean;
  socketPath?: string;
  stopDaemon?: () => Promise<boolean | void> | boolean | void;
  requestGracefulShutdown?: GracefulShutdownRequestFn;
  signalProcess?: SignalProcessFn;
  killProcessTree?: KillProcessTreeFn;
  execGit?: ExecGitFn;
  waitTimeoutMs?: number;
}

export interface UninstallResult {
  stoppedDaemon: boolean;
  daemonPid: number | null;
  removedStalePid: boolean;
  serviceRemoved: boolean;
  servicePath: string;
  platform: SupportedServicePlatform;
  worktrees: DetectedWorktreeRef[];
  dataPurged: boolean;
  kilnHome: string;
}

function assertNoControlChars(value: string, fieldLabel: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldLabel} must be a non-empty string`);
  }
  if (CONTROL_CHAR_REGEX.test(value)) {
    throw new Error(`${fieldLabel} contains forbidden control characters`);
  }
  return value;
}

function escapeXml(value: string, fieldLabel: string): string {
  assertNoControlChars(value, fieldLabel);
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function quoteSystemdExecArg(value: string, fieldLabel: string): string {
  assertNoControlChars(value, fieldLabel);
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", "$$");
  return `"${escaped}"`;
}

function quoteSystemdEnvAssignment(key: string, value: string): string {
  assertNoControlChars(key, "systemd env key");
  assertNoControlChars(value, "systemd env value");
  const escaped = `${key}=${value}`
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%");
  return `"${escaped}"`;
}

function escapeSystemdPathValue(value: string, fieldLabel: string): string {
  assertNoControlChars(value, fieldLabel);
  return value.replaceAll("%", "%%");
}

function stripTrailingNonRootBackslashes(rawPath: string): string {
  // Preserve Windows drive roots ("C:\") and UNC roots while stripping trailing "\"
  // that could otherwise escape a closing quote in Win32 CommandLineToArgvW.
  if (/^[A-Za-z]:\\+$/.test(rawPath)) {
    return `${rawPath.slice(0, 2)}\\`;
  }
  return rawPath.replace(/\\+$/, "");
}

function quoteWindowsCommandArg(value: string, fieldLabel: string): string {
  assertNoControlChars(value, fieldLabel);
  // Follow Microsoft CommandLineToArgvW escaping rules:
  // double any run of backslashes immediately before a quote or the closing quote.
  let out = '"';
  let pendingBackslashes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch === "\\") {
      pendingBackslashes += 1;
    } else if (ch === '"') {
      out += "\\".repeat(pendingBackslashes * 2 + 1) + '"';
      pendingBackslashes = 0;
    } else {
      if (pendingBackslashes > 0) {
        out += "\\".repeat(pendingBackslashes);
        pendingBackslashes = 0;
      }
      out += ch;
    }
  }
  if (pendingBackslashes > 0) {
    out += "\\".repeat(pendingBackslashes * 2);
  }
  out += '"';
  return out;
}

function assertValidWindowsUserRunKey(rawKey: string): string {
  const key = assertNoControlChars(rawKey, "windowsRunKey").trim();
  if (!/^HKCU\\/i.test(key) && !/^HKEY_CURRENT_USER\\/i.test(key)) {
    throw new Error(`windowsRunKey must be user-level under HKCU\\ (no UAC/HKLM): got "${rawKey}"`);
  }
  return key;
}

function assertValidWindowsValueName(rawName: string): string {
  const name = assertNoControlChars(rawName, "windowsValueName").trim();
  if (name.length === 0 || name.includes("\\") || name.includes("/")) {
    throw new Error(`Invalid windowsValueName "${rawName}": path separators are forbidden`);
  }
  return name;
}

function queryHostWindowsRegistryValue(key: string, valueName: string): string | null {
  if (process.platform !== "win32") {
    return null;
  }
  try {
    const stdout = execFileSync("reg.exe", ["query", key, "/v", valueName], {
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^\s*(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line);
      if (match && match[1] && match[1].toLowerCase() === valueName.toLowerCase()) {
        return (match[2] ?? "").trim();
      }
    }
    return stdout.trim().length > 0 ? stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Returns the canonical `kilnd.shutdown` control token path inside `<kilnHome>/run/kilnd.shutdown`.
 */
export function resolveKilnShutdownTokenPath(kilnHome: string): string {
  return new KilnPaths(kilnHome).shutdownTokenFile;
}

/**
 * Resolves the user home directory, honoring an explicit `homeDir` override to avoid
 * touching host user directories during tests.
 */
export function resolveCliHomeDir(homeDir?: string): string {
  if (homeDir !== undefined) {
    if (homeDir.trim().length === 0) {
      throw new Error("homeDir override cannot be empty");
    }
    return path.resolve(homeDir);
  }
  return path.resolve(os.homedir());
}

/**
 * Resolves the Kiln data directory (`kilnHome` override -> `<homeDir>/.kiln` when `homeDir`
 * is injected -> `resolveKilnHome()`).
 */
export function resolveCliKilnHome(options: { kilnHome?: string; homeDir?: string }): string {
  if (options.kilnHome !== undefined) {
    return resolveKilnHome(options.kilnHome);
  }
  if (options.homeDir !== undefined) {
    return path.join(resolveCliHomeDir(options.homeDir), ".kiln");
  }
  return resolveKilnHome();
}

/**
 * Returns the canonical `kilnd.pid` path inside `<kilnHome>/run/kilnd.pid`.
 */
export function resolveKilnPidPath(kilnHome: string): string {
  return path.join(new KilnPaths(kilnHome).runSockDir, "kilnd.pid");
}

/**
 * Resolves the built CLI executable (`dist/bin.js`) relative to the current module.
 */
export function resolveDefaultCliEntrypoint(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  for (const name of ["bin.js", "kiln-cli.mjs"]) {
    const siblingBin = path.resolve(currentDir, name);
    if (fs.existsSync(siblingBin)) {
      return siblingBin;
    }
  }
  return path.resolve(currentDir, "../dist/bin.js");
}

function resolveSupportedPlatform(platform?: NodeJS.Platform): SupportedServicePlatform {
  const effective = platform ?? process.platform;
  if (effective === "darwin" || effective === "linux" || effective === "win32") {
    return effective;
  }
  throw new Error(
    `Unsupported service platform "${effective}": only darwin, linux, and win32 are supported`,
  );
}

function resolveServiceDescriptor(options: ServiceOptions): {
  platform: SupportedServicePlatform;
  servicePath: string;
  label: string;
  serviceName: string;
  windowsRunKey: string;
  windowsValueName: string;
} {
  const platform = resolveSupportedPlatform(options.platform);

  if (platform === "win32") {
    const windowsRunKey = assertValidWindowsUserRunKey(
      options.windowsRunKey ?? WINDOWS_RUN_REGISTRY_KEY,
    );
    const windowsValueName = assertValidWindowsValueName(
      options.windowsValueName ?? options.serviceName ?? WINDOWS_RUN_VALUE_NAME,
    );
    return {
      platform,
      servicePath: `${windowsRunKey}\\${windowsValueName}`,
      label: MACOS_LAUNCH_AGENT_LABEL,
      serviceName: LINUX_SYSTEMD_SERVICE_NAME,
      windowsRunKey,
      windowsValueName,
    };
  }

  const homeDir = resolveCliHomeDir(options.homeDir);

  if (platform === "darwin") {
    const label = assertNoControlChars(
      assertSafeSegment(options.label ?? MACOS_LAUNCH_AGENT_LABEL, "launchd label"),
      "launchd label",
    );
    const launchAgentsDir =
      options.launchAgentsDir !== undefined
        ? path.resolve(options.launchAgentsDir)
        : path.join(homeDir, "Library", "LaunchAgents");
    return {
      platform,
      servicePath: path.join(launchAgentsDir, `${label}.plist`),
      label,
      serviceName: LINUX_SYSTEMD_SERVICE_NAME,
      windowsRunKey: WINDOWS_RUN_REGISTRY_KEY,
      windowsValueName: WINDOWS_RUN_VALUE_NAME,
    };
  }

  const rawServiceName = options.serviceName ?? LINUX_SYSTEMD_SERVICE_NAME;
  const normalizedName = rawServiceName.endsWith(".service")
    ? rawServiceName
    : `${rawServiceName}.service`;
  const serviceName = assertNoControlChars(
    assertSafeSegment(normalizedName, "systemd serviceName"),
    "systemd serviceName",
  );
  const systemdDir =
    options.systemdDir !== undefined
      ? path.resolve(options.systemdDir)
      : path.join(homeDir, ".config", "systemd", "user");

  return {
    platform,
    servicePath: path.join(systemdDir, serviceName),
    label: MACOS_LAUNCH_AGENT_LABEL,
    serviceName,
    windowsRunKey: WINDOWS_RUN_REGISTRY_KEY,
    windowsValueName: WINDOWS_RUN_VALUE_NAME,
  };
}

/**
 * Renders a macOS `LaunchAgent` plist XML document with strict XML escaping to prevent
 * path/control-character injection, binding `KILN_HOME`, `RunAtLoad`, and `KeepAlive`.
 */
export function renderLaunchAgentPlist(input: RenderLaunchAgentPlistInput): string {
  const label = assertNoControlChars(
    assertSafeSegment(input.label ?? MACOS_LAUNCH_AGENT_LABEL, "launchd label"),
    "launchd label",
  );
  const programArgs = [
    input.nodeExecutable,
    ...(input.kilndEntrypoint !== undefined ? [input.kilndEntrypoint] : []),
    ...(input.args ?? []),
  ];
  const stdoutLog = path.join(input.logDir, "kilnd.out.log");
  const stderrLog = path.join(input.logDir, "kilnd.err.log");

  const argsXml = programArgs
    .map((arg, index) => `    <string>${escapeXml(arg, `programArg[${index}]`)}</string>`)
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(label, "label")}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    argsXml,
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>KILN_HOME</key>",
    `    <string>${escapeXml(input.kilnHome, "kilnHome")}</string>`,
    ...(input.electronAsNode
      ? ["    <key>ELECTRON_RUN_AS_NODE</key>", "    <string>1</string>"]
      : []),
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(stdoutLog, "stdoutLog")}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(stderrLog, "stderrLog")}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/**
 * Renders a Linux `systemd --user` service unit file with argument quoting and
 * newline/specifier sanitization, binding `KILN_HOME` and automatic restart.
 */
export function renderSystemdUnit(input: RenderSystemdUnitInput): string {
  const description = assertNoControlChars(
    input.description ?? "Kiln Local-First Daemon",
    "description",
  );
  const logDir = input.logDir ?? path.join(input.kilnHome, "logs");
  const programArgs = [
    input.nodeExecutable,
    ...(input.kilndEntrypoint !== undefined ? [input.kilndEntrypoint] : []),
    ...(input.args ?? []),
  ];
  const execStart = programArgs
    .map((arg, index) => quoteSystemdExecArg(arg, `programArg[${index}]`))
    .join(" ");

  const stdoutLog = escapeSystemdPathValue(path.join(logDir, "kilnd.out.log"), "stdoutLog");
  const stderrLog = escapeSystemdPathValue(path.join(logDir, "kilnd.err.log"), "stderrLog");

  return [
    "[Unit]",
    `Description=${description}`,
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `Environment=${quoteSystemdEnvAssignment("KILN_HOME", input.kilnHome)}`,
    ...(input.electronAsNode ? ["Environment=ELECTRON_RUN_AS_NODE=1"] : []),
    `ExecStart=${execStart}`,
    "Restart=on-failure",
    "RestartSec=3",
    `StandardOutput=append:${stdoutLog}`,
    `StandardError=append:${stderrLog}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * Renders a sanitized Windows user-level `HKCU\...\Run` command line with Win32
 * `CommandLineToArgvW` quoting, stripped trailing backslashes, and explicit `--kiln-home`.
 */
export function renderWindowsRunCommand(input: RenderWindowsRunCommandInput): string {
  const cleanExecutable = stripTrailingNonRootBackslashes(
    assertNoControlChars(input.executable, "executable"),
  );
  const cleanKilnHome = stripTrailingNonRootBackslashes(
    assertNoControlChars(input.kilnHome, "kilnHome"),
  );

  const tokens: string[] = [quoteWindowsCommandArg(cleanExecutable, "executable")];
  if (input.kilndEntrypoint !== undefined) {
    const cleanEntrypoint = stripTrailingNonRootBackslashes(
      assertNoControlChars(input.kilndEntrypoint, "kilndEntrypoint"),
    );
    tokens.push(quoteWindowsCommandArg(cleanEntrypoint, "kilndEntrypoint"));
  }

  const extraArgs = input.args ?? ["up"];
  let hasKilnHomeFlag = false;
  for (let i = 0; i < extraArgs.length; i += 1) {
    const arg = extraArgs[i]!;
    if (arg === "--kiln-home" || arg.startsWith("--kiln-home=")) {
      hasKilnHomeFlag = true;
    }
    tokens.push(quoteWindowsCommandArg(arg, `programArg[${i}]`));
  }

  if (!hasKilnHomeFlag) {
    tokens.push("--kiln-home", quoteWindowsCommandArg(cleanKilnHome, "kilnHome"));
  }

  const commandLine = tokens.join(" ");
  if (input.electronAsNode) {
    return `cmd.exe /d /s /c "set ELECTRON_RUN_AS_NODE=1&& ${commandLine}"`;
  }
  return commandLine;
}

/**
 * Explicitly installs the platform startup descriptor (`LaunchAgent` plist on macOS,
 * `systemd --user` unit on Linux, or user-level `HKCU\...\Run` entry on Windows without UAC).
 * Never invoked automatically during installation.
 */
export async function installService(options: ServiceOptions = {}): Promise<InstallServiceResult> {
  const descriptor = resolveServiceDescriptor(options);
  const kilnHome = resolveCliKilnHome(options);
  const logDir =
    options.logDir !== undefined ? path.resolve(options.logDir) : path.join(kilnHome, "logs");
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const electronAsNode =
    options.nodeExecutable === undefined &&
    Boolean((process.versions as { electron?: string }).electron);
  const usingDefaultEntrypoint = options.kilndEntrypoint === undefined;
  const kilndEntrypoint =
    options.kilndEntrypoint !== undefined
      ? options.kilndEntrypoint
      : isCompiledKilnBinary()
        ? undefined
        : resolveDefaultCliEntrypoint();

  if (descriptor.platform === "win32") {
    const winArgs = options.args ?? ["up"];
    const command = renderWindowsRunCommand({
      executable: nodeExecutable,
      kilndEntrypoint,
      kilnHome,
      args: winArgs,
      electronAsNode,
    });
    ensureDir(logDir);

    if (options.windowsRegistry) {
      await options.windowsRegistry.add(
        descriptor.windowsRunKey,
        descriptor.windowsValueName,
        command,
      );
    } else if (options.executeSystemControl) {
      await options.executeSystemControl("reg.exe", [
        "add",
        descriptor.windowsRunKey,
        "/v",
        descriptor.windowsValueName,
        "/t",
        "REG_SZ",
        "/d",
        command,
        "/f",
      ]);
    } else if (process.platform === "win32") {
      await execFileAsync(
        "reg.exe",
        [
          "add",
          descriptor.windowsRunKey,
          "/v",
          descriptor.windowsValueName,
          "/t",
          "REG_SZ",
          "/d",
          command,
          "/f",
        ],
        { windowsHide: true, encoding: "utf8" },
      );
    } else {
      throw new Error(
        `Cannot install win32 HKCU Run entry on ${process.platform} without windowsRegistry or executeSystemControl hook`,
      );
    }

    return {
      installed: true,
      platform: "win32",
      servicePath: descriptor.servicePath,
      executedControl: true,
      command,
    };
  }

  const args = options.args ?? (usingDefaultEntrypoint ? ["up", "--foreground"] : []);

  const content =
    descriptor.platform === "darwin"
      ? renderLaunchAgentPlist({
          nodeExecutable,
          kilndEntrypoint,
          kilnHome,
          logDir,
          label: descriptor.label,
          args,
          electronAsNode,
        })
      : renderSystemdUnit({
          nodeExecutable,
          kilndEntrypoint,
          kilnHome,
          logDir,
          args,
          electronAsNode,
        });

  ensureDir(logDir);
  writeFileAtomic(descriptor.servicePath, content);

  let executedControl = false;
  if (options.executeSystemControl) {
    if (descriptor.platform === "darwin") {
      await options.executeSystemControl("launchctl", ["load", "-w", descriptor.servicePath]);
    } else {
      await options.executeSystemControl("systemctl", [
        "--user",
        "enable",
        "--now",
        descriptor.serviceName,
      ]);
    }
    executedControl = true;
  }

  return {
    installed: true,
    platform: descriptor.platform,
    servicePath: descriptor.servicePath,
    executedControl,
  };
}

/**
 * Idempotently removes the platform startup descriptor (`LaunchAgent`, `systemd` unit,
 * or Windows user-level `HKCU\...\Run` entry).
 */
export async function uninstallService(
  options: ServiceOptions = {},
): Promise<UninstallServiceResult> {
  const descriptor = resolveServiceDescriptor(options);

  if (descriptor.platform === "win32") {
    if (options.windowsRegistry) {
      const removed = await options.windowsRegistry.delete(
        descriptor.windowsRunKey,
        descriptor.windowsValueName,
      );
      return {
        removed,
        platform: "win32",
        servicePath: descriptor.servicePath,
        executedControl: removed,
      };
    }

    if (options.executeSystemControl) {
      const existed =
        process.platform === "win32"
          ? queryHostWindowsRegistryValue(descriptor.windowsRunKey, descriptor.windowsValueName) !==
            null
          : true;
      if (existed) {
        await options.executeSystemControl("reg.exe", [
          "delete",
          descriptor.windowsRunKey,
          "/v",
          descriptor.windowsValueName,
          "/f",
        ]);
      }
      return {
        removed: existed,
        platform: "win32",
        servicePath: descriptor.servicePath,
        executedControl: existed,
      };
    }

    const existed =
      queryHostWindowsRegistryValue(descriptor.windowsRunKey, descriptor.windowsValueName) !== null;
    if (!existed) {
      return {
        removed: false,
        platform: "win32",
        servicePath: descriptor.servicePath,
        executedControl: false,
      };
    }

    await execFileAsync(
      "reg.exe",
      ["delete", descriptor.windowsRunKey, "/v", descriptor.windowsValueName, "/f"],
      { windowsHide: true, encoding: "utf8" },
    );
    return {
      removed: true,
      platform: "win32",
      servicePath: descriptor.servicePath,
      executedControl: true,
    };
  }

  const existed = fs.existsSync(descriptor.servicePath);
  let executedControl = false;

  if (existed && options.executeSystemControl) {
    if (descriptor.platform === "darwin") {
      await options.executeSystemControl("launchctl", ["unload", "-w", descriptor.servicePath]);
    } else {
      await options.executeSystemControl("systemctl", [
        "--user",
        "disable",
        "--now",
        descriptor.serviceName,
      ]);
    }
    executedControl = true;
  }

  fs.rmSync(descriptor.servicePath, { force: true });

  return {
    removed: existed,
    platform: descriptor.platform,
    servicePath: descriptor.servicePath,
    executedControl,
  };
}

/**
 * Reports whether the platform startup descriptor is currently installed.
 */
export function getServiceStatus(options: ServiceOptions = {}): ServiceStatusResult {
  const descriptor = resolveServiceDescriptor(options);

  if (descriptor.platform === "win32") {
    const value = options.windowsRegistry
      ? options.windowsRegistry.query(descriptor.windowsRunKey, descriptor.windowsValueName)
      : queryHostWindowsRegistryValue(descriptor.windowsRunKey, descriptor.windowsValueName);
    return {
      installed: value !== null,
      platform: "win32",
      servicePath: descriptor.servicePath,
    };
  }

  return {
    installed: fs.existsSync(descriptor.servicePath),
    platform: descriptor.platform,
    servicePath: descriptor.servicePath,
  };
}

/**
 * Reads and validates a positive integer PID from `kilnd.pid`.
 */
export function readPidFile(pidFile: string): { exists: boolean; pid: number | null } {
  let raw: string;
  try {
    raw = fs.readFileSync(pidFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, pid: null };
    }
    throw err;
  }

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { exists: true, pid: null };
  }
  const pid = Number(trimmed);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { exists: true, pid: null };
  }
  return { exists: true, pid };
}

function isErrCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === code;
}

function isProcessAlive(pid: number, signalProcess: SignalProcessFn): boolean {
  try {
    signalProcess(pid, 0);
    return true;
  } catch (err) {
    if (isErrCode(err, "ESRCH")) {
      return false;
    }
    if (isErrCode(err, "EPERM")) {
      return true;
    }
    throw err;
  }
}

async function waitForProcessExit(
  pid: number,
  signalProcess: SignalProcessFn,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    if (!isProcessAlive(pid, signalProcess)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_INTERVAL_MS));
  }
  return !isProcessAlive(pid, signalProcess);
}

/**
 * Reads a non-empty per-instance shutdown token from `<kilnHome>/run/kilnd.shutdown`, or `null`.
 */
export function readShutdownTokenFile(tokenFile: string): string | null {
  try {
    const raw = fs.readFileSync(tokenFile, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch (err) {
    if (isErrCode(err, "ENOENT")) {
      return null;
    }
    return null;
  }
}

/**
 * Sends a token-authenticated `POST /rpc/shutdown` request over the local IPC endpoint
 * (POSIX UDS or Windows Named Pipe) to trigger graceful daemon shutdown.
 */
export async function requestDaemonGracefulShutdown(ctx: {
  socketPath: string;
  shutdownToken: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const timeoutMs = ctx.timeoutMs ?? SHUTDOWN_RPC_TIMEOUT_MS;
  if (isWindowsNamedPipe(ctx.socketPath)) {
    try {
      const res = await sendNetHttpRequest({
        socketPath: ctx.socketPath,
        method: "POST",
        path: "/rpc/shutdown",
        headers: {
          Authorization: `Bearer ${ctx.shutdownToken}`,
        },
        timeoutMs,
      });
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };

    const req = http.request(
      {
        socketPath: ctx.socketPath,
        method: "POST",
        path: "/rpc/shutdown",
        headers: {
          Host: "kilnd.local",
          Authorization: `Bearer ${ctx.shutdownToken}`,
          "Content-Length": "0",
        },
      },
      (res) => {
        res.resume();
        res.once("end", () => {
          const status = res.statusCode ?? 0;
          finish(status >= 200 && status < 300);
        });
        res.once("error", () => finish(false));
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(false);
    });
    req.once("error", () => finish(false));
    req.end();
  });
}

/**
 * Stops a managed `kilnd` process:
 * 1. If `stopDaemon` callback is injected, delegates directly;
 * 2. Otherwise attempts local IPC `POST /rpc/shutdown` using `kilnd.shutdown` token first
 *    (required on Windows where POSIX `SIGTERM` terminates immediately without cleanup);
 * 3. Falls back to `SIGTERM` (POSIX) or `taskkill /PID <pid> /T /F` (Windows) on timeout/failure,
 *    and cleans up `kilnd.pid` & `kilnd.shutdown`. Never signals `pid <= 0`.
 */
export async function stopManagedDaemon(options: {
  kilnHome: string;
  platform?: NodeJS.Platform;
  socketPath?: string;
  stopDaemon?: () => Promise<boolean | void> | boolean | void;
  requestGracefulShutdown?: GracefulShutdownRequestFn;
  signalProcess?: SignalProcessFn;
  killProcessTree?: KillProcessTreeFn;
  waitTimeoutMs?: number;
}): Promise<StopDaemonResult> {
  const pidFile = resolveKilnPidPath(options.kilnHome);
  const shutdownTokenFile = resolveKilnShutdownTokenPath(options.kilnHome);
  const pidState = readPidFile(pidFile);

  if (options.stopDaemon) {
    const callbackResult = await options.stopDaemon();
    fs.rmSync(pidFile, { force: true });
    fs.rmSync(shutdownTokenFile, { force: true });
    return {
      stopped: callbackResult !== false,
      pid: pidState.pid,
      removedStalePid: pidState.exists && callbackResult === false,
      method: "callback",
    };
  }

  if (!pidState.exists) {
    return { stopped: false, pid: null, removedStalePid: false };
  }

  if (pidState.pid === null) {
    fs.rmSync(pidFile, { force: true });
    fs.rmSync(shutdownTokenFile, { force: true });
    return { stopped: false, pid: null, removedStalePid: true };
  }

  const platform = options.platform ?? process.platform;
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const signalProcess: SignalProcessFn =
    options.signalProcess ?? ((pid, sig) => process.kill(pid, sig));

  if (!isProcessAlive(pidState.pid, signalProcess)) {
    fs.rmSync(pidFile, { force: true });
    fs.rmSync(shutdownTokenFile, { force: true });
    return { stopped: false, pid: pidState.pid, removedStalePid: true };
  }

  // Step 1: Prefer graceful shutdown via local IPC + per-instance 0600 control token.
  const shutdownToken = readShutdownTokenFile(shutdownTokenFile);
  if (shutdownToken !== null) {
    const socketPath = options.socketPath ?? resolveDefaultIpcPath(options.kilnHome, platform);
    const requestShutdown = options.requestGracefulShutdown ?? requestDaemonGracefulShutdown;
    const accepted = await requestShutdown({ socketPath, shutdownToken }).catch(() => false);
    if (accepted) {
      const exitedGracefully = await waitForProcessExit(pidState.pid, signalProcess, waitTimeoutMs);
      if (exitedGracefully) {
        fs.rmSync(pidFile, { force: true });
        fs.rmSync(shutdownTokenFile, { force: true });
        return {
          stopped: true,
          pid: pidState.pid,
          removedStalePid: false,
          method: "ipc_shutdown",
        };
      }
    }
  }

  // Step 2: Platform fallback when IPC shutdown is unavailable or timed out.
  if (platform === "win32") {
    const killTree: KillProcessTreeFn =
      options.killProcessTree ??
      ((pid) =>
        terminateProcessTree(pid, {
          platform: "win32",
          signalProcess,
        }));
    await killTree(pidState.pid);
    await waitForProcessExit(pidState.pid, signalProcess, waitTimeoutMs);
    fs.rmSync(pidFile, { force: true });
    fs.rmSync(shutdownTokenFile, { force: true });
    return {
      stopped: true,
      pid: pidState.pid,
      removedStalePid: false,
      method: "taskkill",
    };
  }

  try {
    signalProcess(pidState.pid, "SIGTERM");
  } catch (err) {
    if (isErrCode(err, "ESRCH")) {
      fs.rmSync(pidFile, { force: true });
      fs.rmSync(shutdownTokenFile, { force: true });
      return { stopped: false, pid: pidState.pid, removedStalePid: true };
    }
    throw err;
  }

  await waitForProcessExit(pidState.pid, signalProcess, waitTimeoutMs);
  fs.rmSync(pidFile, { force: true });
  fs.rmSync(shutdownTokenFile, { force: true });

  return {
    stopped: true,
    pid: pidState.pid,
    removedStalePid: false,
    method: "signal",
  };
}

async function defaultExecGit(args: readonly string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    env: buildSanitizedEnv(),
    maxBuffer: GIT_MAX_BUFFER,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout;
}

interface ParsedWorktreeBlock {
  worktreePath: string;
  branch: string | null;
}

function parseGitWorktreePorcelain(output: string): ParsedWorktreeBlock[] {
  const blocks: ParsedWorktreeBlock[] = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;

  const flush = (): void => {
    if (currentPath !== null) {
      blocks.push({ worktreePath: currentPath, branch: currentBranch });
      currentPath = null;
      currentBranch = null;
    }
  };

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      currentPath = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      currentBranch = line.slice("branch ".length);
    }
  }
  flush();
  return blocks;
}

function safeRealpath(targetPath: string): string {
  try {
    return realpathCanonical(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function isInsideDirectory(candidatePath: string, parentDir: string): boolean {
  const resolvedCandidate = safeRealpath(candidatePath);
  const resolvedParent = safeRealpath(parentDir);
  const prefix = resolvedParent.endsWith(path.sep) ? resolvedParent : resolvedParent + path.sep;
  if (process.platform === "win32") {
    const candLower = resolvedCandidate.toLowerCase();
    return candLower === resolvedParent.toLowerCase() || candLower.startsWith(prefix.toLowerCase());
  }
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(prefix);
}

async function inspectSpaceWorktrees(
  kilnHome: string,
  execGit: ExecGitFn,
): Promise<DetectedWorktreeRef[]> {
  const paths = new KilnPaths(kilnHome);
  if (!fs.existsSync(paths.spacesDir)) {
    return [];
  }

  const detected: DetectedWorktreeRef[] = [];
  const entries = fs.readdirSync(paths.spacesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const spaceId = assertSafeSegment(entry.name, "spaceId");
    const space = readYamlOptional(paths.spaceFile(spaceId), SpaceConfigSchema);
    if (!space?.repo_path || !fs.existsSync(space.repo_path)) {
      continue;
    }

    let porcelain: string;
    try {
      porcelain = await execGit(["-C", space.repo_path, "worktree", "list", "--porcelain"]);
    } catch {
      continue;
    }

    const canonicalRepo = safeRealpath(space.repo_path);
    const blocks = parseGitWorktreePorcelain(porcelain);

    for (const block of blocks) {
      const canonicalWorktree = safeRealpath(block.worktreePath);
      if (canonicalWorktree === canonicalRepo) {
        continue;
      }

      const managedByPath = isInsideDirectory(block.worktreePath, paths.workspacesDir);
      const managedByBranch =
        block.branch !== null &&
        (block.branch.startsWith("refs/heads/kiln/") || block.branch.startsWith("kiln/"));

      if (!managedByPath && !managedByBranch) {
        continue;
      }

      const missing = !fs.existsSync(block.worktreePath);
      let dirty = false;
      if (!missing) {
        try {
          const statusOut = await execGit(["-C", block.worktreePath, "status", "--porcelain=v1"]);
          dirty = statusOut.trim().length > 0;
        } catch {
          dirty = true;
        }
      }

      detected.push({
        spaceId,
        repoPath: space.repo_path,
        worktreePath: block.worktreePath,
        branch: block.branch,
        dirty,
        missing,
      });
    }
  }

  return detected;
}

/**
 * Cleanly uninstalls Kiln runtime artifacts:
 * 1. Stops the managed `kilnd` process (if running);
 * 2. Removes the platform startup descriptor (`LaunchAgent` / `systemd`);
 * 3. Inspects Kiln-managed git worktrees: removes clean worktrees while preserving
 *    any worktree containing uncommitted changes, and prunes stale/missing refs;
 * 4. Preserves `<kilnHome>` ledger & data by default unless `purgeData === true`.
 */
export async function runUninstall(options: UninstallOptions = {}): Promise<UninstallResult> {
  const kilnHome = resolveCliKilnHome(options);
  const execGit = options.execGit ?? defaultExecGit;

  const stopRes = await stopManagedDaemon({
    kilnHome,
    platform: options.platform,
    socketPath: options.socketPath,
    stopDaemon: options.stopDaemon,
    requestGracefulShutdown: options.requestGracefulShutdown,
    signalProcess: options.signalProcess,
    killProcessTree: options.killProcessTree,
    waitTimeoutMs: options.waitTimeoutMs,
  });

  const serviceRes = await uninstallService(options);
  const worktrees = await inspectSpaceWorktrees(kilnHome, execGit);
  const reposToPrune = new Set<string>();

  for (const wt of worktrees) {
    if (!wt.dirty && !wt.missing) {
      try {
        await execGit(["-C", wt.repoPath, "worktree", "remove", wt.worktreePath]);
        wt.removed = true;
        reposToPrune.add(wt.repoPath);
      } catch {
        // Leave intact if git worktree remove fails unexpectedly.
      }
    } else if (wt.missing) {
      reposToPrune.add(wt.repoPath);
    }
  }

  const purgeData = options.purgeData === true;
  if (purgeData) {
    for (const wt of worktrees) {
      reposToPrune.add(wt.repoPath);
    }
    fs.rmSync(kilnHome, { recursive: true, force: true });
  }

  for (const repoPath of reposToPrune) {
    if (fs.existsSync(repoPath)) {
      await execGit(["-C", repoPath, "worktree", "prune"]).catch(() => {});
    }
  }

  return {
    stoppedDaemon: stopRes.stopped,
    daemonPid: stopRes.pid,
    removedStalePid: stopRes.removedStalePid,
    serviceRemoved: serviceRes.removed,
    servicePath: serviceRes.servicePath,
    platform: serviceRes.platform,
    worktrees,
    dataPurged: purgeData,
    kilnHome,
  };
}
