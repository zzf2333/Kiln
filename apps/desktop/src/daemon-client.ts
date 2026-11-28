import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_KILND_URL,
  buildChildCommandPathDirs,
  parseBootstrapSummaryJson,
  parseHealthJson,
  parseSemverKey,
  parseSseEventBlock,
  pathContainsDir,
  platformKilnBinaryNames,
  renderPosixCliWrapper,
  renderWindowsCliShim,
  standardKilnSearchDirs,
  trayStateFromProbe,
  validateKilndUrl,
  windowsKilnSearchDirs,
  type KilnBootstrapSummary,
  type KilnHealth,
  type NormalizedKilndUrl,
  type SseEventFrame,
  type TrayDisplayState,
} from "./model.js";

const execFileAsync = promisify(execFile);

const DEFAULT_HEALTH_TIMEOUT_MS = 2_500;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10_000;
const DEFAULT_SSE_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_IO_TIMEOUT_MS = 5_000;
const MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface KilndClientTimeouts {
  healthTimeoutMs?: number;
  bootstrapTimeoutMs?: number;
  sseConnectTimeoutMs?: number;
  ioTimeoutMs?: number;
}

export interface KilnInvocation {
  command: string;
  prefixArgs: string[];
  electronAsNode: boolean;
  sourceKind: "override" | "bundled_runtime" | "path" | "standard_dir";
}

export interface CliInstallOutcome {
  binDir: string;
  displayBinDir: string;
  targetDescription: string;
  inPath: boolean;
}

export function resolveDesktopVersion(fallback = "0.0.8"): string {
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const candidate = path.resolve(import.meta.dirname, rel);
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as { version?: unknown };
        if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
          return parsed.version.trim();
        }
      }
    } catch {
      // Fall back safely
    }
  }
  return fallback;
}

export function resolveKilndUrl(): NormalizedKilndUrl {
  const rawEnv = process.env.KILND_URL;
  const raw = rawEnv && rawEnv.trim().length > 0 ? rawEnv.trim() : DEFAULT_KILND_URL;
  return validateKilndUrl(raw);
}

export function collectVersionedNodeBins(homeDir: string | null | undefined): string[] {
  if (!homeDir || homeDir.trim().length === 0) return [];
  const roots: ReadonlyArray<readonly [string, string]> = [
    [".local/share/mise/installs/node", "bin"],
    [".nvm/versions/node", "bin"],
    [".fnm/node-versions", "installation/bin"],
    ["Library/Application Support/fnm/node-versions", "installation/bin"],
  ];

  const versioned: Array<{ key: readonly [number, number, number]; binDir: string }> = [];
  for (const [rootRel, binRel] of roots) {
    const rootDir = path.join(homeDir, rootRel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const key = parseSemverKey(entry.name);
      if (!key) continue;
      const binDir = path.join(rootDir, entry.name, binRel);
      try {
        if (fs.statSync(binDir).isDirectory()) {
          versioned.push({ key, binDir });
        }
      } catch {
        // Ignore missing bin subdir
      }
    }
  }

  versioned.sort((a, b) => {
    if (b.key[0] !== a.key[0]) return b.key[0] - a.key[0];
    if (b.key[1] !== a.key[1]) return b.key[1] - a.key[1];
    if (b.key[2] !== a.key[2]) return b.key[2] - a.key[2];
    return a.binDir.localeCompare(b.binDir);
  });

  const out: string[] = [];
  for (const item of versioned) {
    if (!out.includes(item.binDir)) out.push(item.binDir);
  }
  return out;
}

export function resolveBundledRuntimeCliPath(options?: {
  resourcesPath?: string | null;
  moduleDir?: string;
}): string | null {
  const candidates: string[] = [];
  if (options?.resourcesPath) {
    candidates.push(path.join(options.resourcesPath, "kiln-runtime", "kiln-cli.mjs"));
  }
  const modDir = options?.moduleDir ?? import.meta.dirname;
  candidates.push(path.resolve(modDir, "../runtime/kiln-cli.mjs"));
  candidates.push(path.resolve(modDir, "../../runtime/kiln-cli.mjs"));

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Try next candidate
    }
  }
  return null;
}

export function resolveBundledUiBuildId(options?: {
  resourcesPath?: string | null;
  moduleDir?: string;
}): string | null {
  const candidates: string[] = [];
  if (options?.resourcesPath) {
    candidates.push(path.join(options.resourcesPath, "kiln-runtime", "public", "index.html"));
  }
  const modDir = options?.moduleDir ?? import.meta.dirname;
  candidates.push(path.resolve(modDir, "../runtime/public/index.html"));
  candidates.push(path.resolve(modDir, "../../runtime/public/index.html"));

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return createHash("sha256").update(fs.readFileSync(candidate)).digest("hex").slice(0, 16);
      }
    } catch {
      // Try next candidate
    }
  }
  return null;
}

export function resolveKilnInvocationForPlatform(options: {
  explicitKilnBin?: string | null;
  execPath?: string;
  resourcesPath?: string | null;
  moduleDir?: string;
  currentPath?: string | null;
  homeDir?: string | null;
  localAppData?: string | null;
  isWindows?: boolean;
}): KilnInvocation {
  const isWindows = options.isWindows ?? process.platform === "win32";
  const execPath = options.execPath ?? process.execPath;

  const rawExplicit = options.explicitKilnBin?.trim();
  if (rawExplicit) {
    if (!fs.existsSync(rawExplicit) || !fs.statSync(rawExplicit).isFile()) {
      throw new Error(`KILN_BIN points to missing file: ${rawExplicit}`);
    }
    return {
      command: rawExplicit,
      prefixArgs: [],
      electronAsNode: false,
      sourceKind: "override",
    };
  }

  const bundledCli = resolveBundledRuntimeCliPath({
    resourcesPath: options.resourcesPath,
    ...(options.moduleDir !== undefined ? { moduleDir: options.moduleDir } : {}),
  });
  if (bundledCli) {
    return {
      command: execPath,
      prefixArgs: [bundledCli],
      electronAsNode: true,
      sourceKind: "bundled_runtime",
    };
  }

  const binNames = platformKilnBinaryNames(isWindows);
  const pathSep = isWindows ? ";" : path.delimiter;
  if (options.currentPath) {
    for (const dir of options.currentPath.split(pathSep).filter(Boolean)) {
      for (const binName of binNames) {
        const candidate = path.join(dir, binName);
        try {
          if (fs.statSync(candidate).isFile()) {
            return {
              command: candidate,
              prefixArgs: [],
              electronAsNode: false,
              sourceKind: "path",
            };
          }
        } catch {
          // Continue
        }
      }
    }
  }

  const searchDirs = isWindows
    ? windowsKilnSearchDirs(options.localAppData, options.homeDir)
    : standardKilnSearchDirs(options.homeDir, collectVersionedNodeBins(options.homeDir));

  for (const dir of searchDirs) {
    for (const binName of binNames) {
      const candidate = path.join(dir, binName);
      try {
        if (fs.statSync(candidate).isFile()) {
          return {
            command: candidate,
            prefixArgs: [],
            electronAsNode: false,
            sourceKind: "standard_dir",
          };
        }
      } catch {
        // Continue
      }
    }
  }

  throw new Error("unable to locate `kiln` CLI binary in PATH or standard install directories");
}

export function resolveKilnInvocation(): KilnInvocation {
  const electronProc = process as NodeJS.Process & { resourcesPath?: string };
  return resolveKilnInvocationForPlatform({
    explicitKilnBin: process.env.KILN_BIN ?? null,
    execPath: process.execPath,
    resourcesPath: electronProc.resourcesPath ?? null,
    currentPath: process.env.PATH ?? null,
    homeDir: os.homedir() || null,
    localAppData: process.env.LOCALAPPDATA ?? null,
    isWindows: process.platform === "win32",
  });
}

export function buildKilnChildEnv(
  invocation: KilnInvocation,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...baseEnv };
  if (invocation.electronAsNode) {
    nextEnv.ELECTRON_RUN_AS_NODE = "1";
  }

  const homeDir = baseEnv.HOME || baseEnv.USERPROFILE || os.homedir() || null;
  const binDir = path.dirname(invocation.command);

  if (process.platform === "win32") {
    const dirs: string[] = [];
    const pushUnique = (d: string): void => {
      if (d && !dirs.includes(d)) dirs.push(d);
    };
    if (binDir) pushUnique(binDir);
    for (const d of windowsKilnSearchDirs(baseEnv.LOCALAPPDATA, homeDir)) {
      if (fs.existsSync(d)) pushUnique(d);
    }
    for (const d of (baseEnv.PATH ?? "").split(";").filter(Boolean)) {
      pushUnique(d);
    }
    if (dirs.length > 0) nextEnv.PATH = dirs.join(";");
    return nextEnv;
  }

  const versioned = collectVersionedNodeBins(homeDir);
  const candidateDirs = buildChildCommandPathDirs(binDir, baseEnv.PATH ?? null, homeDir, versioned);
  const existingSet = new Set((baseEnv.PATH ?? "").split(path.delimiter).filter(Boolean));
  const keepSystem = new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
  const filtered = candidateDirs.filter(
    (dir) => dir === binDir || existingSet.has(dir) || keepSystem.has(dir) || fs.existsSync(dir),
  );
  if (filtered.length > 0) {
    nextEnv.PATH = filtered.join(path.delimiter);
  }
  return nextEnv;
}

export async function spawnKilnUp(url: NormalizedKilndUrl): Promise<string> {
  const validated = validateKilndUrl(url.baseUrl);
  const invocation = resolveKilnInvocation();
  const args = [
    ...invocation.prefixArgs,
    "up",
    "--host",
    validated.host,
    "--port",
    String(validated.port),
  ];
  const env = buildKilnChildEnv(invocation);
  try {
    const { stdout } = await execFileAsync(invocation.command, args, {
      env,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    return stdout.trim();
  } catch (err) {
    const execErr = err as { stderr?: string; stdout?: string; message?: string };
    const detail =
      execErr.stderr?.trim() || execErr.stdout?.trim() || execErr.message || String(err);
    throw new Error(`kiln up failed: ${detail}`, { cause: err });
  }
}

export async function runKilnDown(): Promise<string> {
  const invocation = resolveKilnInvocation();
  const args = [...invocation.prefixArgs, "down"];
  const env = buildKilnChildEnv(invocation);
  try {
    const { stdout } = await execFileAsync(invocation.command, args, {
      env,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    return stdout.trim();
  } catch (err) {
    const execErr = err as { stderr?: string; stdout?: string; message?: string };
    const detail =
      execErr.stderr?.trim() || execErr.stdout?.trim() || execErr.message || String(err);
    throw new Error(`kiln down failed: ${detail}`, { cause: err });
  }
}

function atomicWriteFile(dest: string, content: string, mode?: number): void {
  const parent = path.dirname(dest);
  const base = path.basename(dest) || "kiln";
  const tmpPath = path.join(parent, `.${base}.kiln-tmp-${process.pid}`);
  fs.writeFileSync(tmpPath, content, { encoding: "utf8", ...(mode !== undefined ? { mode } : {}) });
  if (mode !== undefined && process.platform !== "win32") {
    fs.chmodSync(tmpPath, mode);
  }
  try {
    fs.renameSync(tmpPath, dest);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

function canonicalOrResolved(targetPath: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function isBundledLauncherPairedWithExe(bundledLauncher: string, targetExe: string): boolean {
  if (!fs.existsSync(bundledLauncher)) {
    return false;
  }
  const runtimeDir = path.dirname(path.dirname(canonicalOrResolved(bundledLauncher)));
  const bundleRoot = canonicalOrResolved(path.resolve(runtimeDir, "..", ".."));
  const macOsExe = path.join(bundleRoot, "MacOS", "Kiln");
  const linuxExe = path.join(bundleRoot, "Kiln");
  return (
    (fs.existsSync(macOsExe) && canonicalOrResolved(macOsExe) === targetExe) ||
    (fs.existsSync(linuxExe) && canonicalOrResolved(linuxExe) === targetExe)
  );
}

export function installPosixCliWrappers(
  invocation: KilnInvocation,
  binDir: string,
  currentPath: string | null | undefined,
): CliInstallOutcome {
  if (!fs.existsSync(invocation.command)) {
    throw new Error(`kiln executable does not exist: ${invocation.command}`);
  }
  const targetExe = canonicalOrResolved(invocation.command);
  const entrypoint = invocation.prefixArgs[0]
    ? canonicalOrResolved(invocation.prefixArgs[0])
    : null;
  fs.mkdirSync(binDir, { recursive: true });
  const canonicalBinDir = canonicalOrResolved(binDir);

  const body = renderPosixCliWrapper({
    executable: targetExe,
    entrypoint,
    electronAsNode: invocation.electronAsNode,
  });

  for (const name of ["kiln", "kl"]) {
    const linkPath = path.join(binDir, name);
    const canonicalDestPath = path.join(canonicalBinDir, name);
    const bundledLauncher =
      invocation.sourceKind === "bundled_runtime" && entrypoint
        ? path.join(path.dirname(entrypoint), "bin", name)
        : null;
    if (bundledLauncher && isBundledLauncherPairedWithExe(bundledLauncher, targetExe)) {
      const targetLauncher = canonicalOrResolved(bundledLauncher);
      if (canonicalDestPath === targetLauncher) {
        continue;
      }
      const tmpLink = path.join(binDir, `.${name}.kiln-tmp-${process.pid}`);
      fs.rmSync(tmpLink, { force: true });
      fs.symlinkSync(targetLauncher, tmpLink);
      try {
        fs.renameSync(tmpLink, linkPath);
      } catch (err) {
        fs.rmSync(tmpLink, { force: true });
        throw err;
      }
      continue;
    }
    // Skip replacing if targetExe itself is the same physical path
    if (
      (canonicalDestPath === targetExe || canonicalOrResolved(linkPath) === targetExe) &&
      !entrypoint
    ) {
      continue;
    }
    atomicWriteFile(linkPath, body, 0o755);
  }

  return {
    binDir,
    displayBinDir: "~/.local/bin",
    targetDescription: entrypoint ? `${targetExe} ${entrypoint}` : targetExe,
    inPath: pathContainsDir(currentPath, binDir, false),
  };
}

function normalizeWindowsIdentity(targetPath: string): string {
  return canonicalOrResolved(targetPath)
    .replace(/\//g, "\\")
    .replace(/^\\\\\?\\/, "")
    .toLowerCase();
}

export function installWindowsCliShims(
  invocation: KilnInvocation,
  binDir: string,
  currentPath: string | null | undefined,
): CliInstallOutcome {
  if (!fs.existsSync(invocation.command)) {
    throw new Error(`kiln executable does not exist: ${invocation.command}`);
  }
  const targetExe = canonicalOrResolved(invocation.command);
  const entrypoint = invocation.prefixArgs[0]
    ? canonicalOrResolved(invocation.prefixArgs[0])
    : null;
  fs.mkdirSync(binDir, { recursive: true });

  const shimBody = renderWindowsCliShim({
    executable: targetExe,
    entrypoint,
    electronAsNode: invocation.electronAsNode,
  });

  const kilnCmd = path.join(binDir, "kiln.cmd");
  const kilnExe = path.join(binDir, "kiln.exe");
  const klCmd = path.join(binDir, "kl.cmd");

  const normExe = normalizeWindowsIdentity(targetExe);
  const sameAsKilnCmd = normExe === normalizeWindowsIdentity(kilnCmd);
  const sameAsKilnExe = normExe === normalizeWindowsIdentity(kilnExe);
  const sameAsKlCmd = normExe === normalizeWindowsIdentity(klCmd);

  if (!sameAsKilnCmd && !sameAsKilnExe) {
    atomicWriteFile(kilnCmd, shimBody);
  }
  if (!sameAsKlCmd) {
    atomicWriteFile(klCmd, shimBody);
  }

  return {
    binDir,
    displayBinDir: "%LOCALAPPDATA%\\Kiln\\bin",
    targetDescription: entrypoint ? `${targetExe} ${entrypoint}` : targetExe,
    inPath: pathContainsDir(currentPath, binDir, true),
  };
}

export function installCliCommand(): CliInstallOutcome {
  const invocation = resolveKilnInvocation();
  const currentPath = process.env.PATH ?? null;

  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA?.trim() ||
      (os.homedir() ? path.join(os.homedir(), "AppData", "Local") : "");
    if (!localAppData) {
      throw new Error("unable to determine LOCALAPPDATA directory");
    }
    const binDir = path.join(localAppData, "Kiln", "bin");
    return installWindowsCliShims(invocation, binDir, currentPath);
  }

  const home = process.env.HOME?.trim() || os.homedir();
  if (!home) {
    throw new Error("unable to determine HOME directory");
  }
  const binDir = path.join(home, ".local", "bin");
  return installPosixCliWrappers(invocation, binDir, currentPath);
}

export class KilndClient {
  readonly url: NormalizedKilndUrl;
  private readonly timeouts: Required<KilndClientTimeouts>;

  constructor(url: NormalizedKilndUrl, timeouts: KilndClientTimeouts = {}) {
    this.url = validateKilndUrl(url.baseUrl);
    this.timeouts = {
      healthTimeoutMs: timeouts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
      bootstrapTimeoutMs: timeouts.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS,
      sseConnectTimeoutMs: timeouts.sseConnectTimeoutMs ?? DEFAULT_SSE_CONNECT_TIMEOUT_MS,
      ioTimeoutMs: timeouts.ioTimeoutMs ?? DEFAULT_IO_TIMEOUT_MS,
    };
  }

  private httpGetBody(reqPath: string, responseTimeoutMs: number): Promise<string> {
    const validated = validateKilndUrl(this.url.baseUrl);
    return new Promise((resolve, reject) => {
      let settled = false;
      let headerTimer: ReturnType<typeof setTimeout> | null = null;
      const clearHeaderTimer = (): void => {
        if (headerTimer !== null) {
          clearTimeout(headerTimer);
          headerTimer = null;
        }
      };
      const done = (fn: () => void): void => {
        if (!settled) {
          settled = true;
          clearHeaderTimer();
          fn();
        }
      };

      const req = http.request(
        {
          hostname: validated.host,
          port: validated.port,
          path: reqPath,
          method: "GET",
          headers: {
            Host: validated.hostHeader,
            Accept: "application/json",
            Connection: "close",
          },
        },
        (res) => {
          clearHeaderTimer();
          req.setTimeout(0);
          const status = res.statusCode ?? 0;
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          res.setTimeout(this.timeouts.ioTimeoutMs, () => {
            req.destroy(new Error(`GET ${reqPath} timed out`));
          });
          res.on("data", (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes > MAX_HTTP_RESPONSE_BYTES) {
              req.destroy(new Error(`GET ${reqPath} response exceeded size limit`));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            res.setTimeout(0);
            if (status < 200 || status >= 300) {
              done(() => reject(new Error(`GET ${reqPath} returned HTTP ${status}`)));
              return;
            }
            done(() => resolve(Buffer.concat(chunks).toString("utf8")));
          });
          res.on("error", (err) => {
            done(() => reject(new Error(`GET ${reqPath} failed: ${err.message}`)));
          });
        },
      );

      headerTimer = setTimeout(() => {
        req.destroy(new Error(`GET ${reqPath} timed out waiting for response`));
      }, responseTimeoutMs);
      req.on("error", (err) => {
        done(() => reject(new Error(`failed to connect to ${validated.baseUrl}: ${err.message}`)));
      });
      req.end();
    });
  }

  async fetchHealth(): Promise<KilnHealth> {
    const body = await this.httpGetBody("/api/health", this.timeouts.healthTimeoutMs);
    return parseHealthJson(body);
  }

  async fetchBootstrap(): Promise<KilnBootstrapSummary> {
    const body = await this.httpGetBody("/api/bootstrap", this.timeouts.bootstrapTimeoutMs);
    return parseBootstrapSummaryJson(body);
  }

  async probeTraySnapshot(): Promise<{
    state: TrayDisplayState;
    daemonVersion: string | null;
  }> {
    try {
      const health = await this.fetchHealth();
      if (!health.ok) {
        return {
          state: trayStateFromProbe({ ok: true, value: health }, null),
          daemonVersion: null,
        };
      }
      let summary: KilnBootstrapSummary | null = null;
      try {
        summary = await this.fetchBootstrap();
      } catch (err) {
        process.stderr.write(
          `kiln-desktop: /api/bootstrap probe failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      return {
        state: trayStateFromProbe({ ok: true, value: health }, summary),
        daemonVersion: health.version,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        state: trayStateFromProbe({ ok: false, reason }, null),
        daemonVersion: null,
      };
    }
  }

  openSseStream(options: {
    lastEventId: string | null;
    signal: AbortSignal;
    onEvent: (frame: SseEventFrame) => void;
    onClose: (reason: string) => void;
  }): void {
    const validated = validateKilndUrl(this.url.baseUrl);
    const headers: Record<string, string> = {
      Host: validated.hostHeader,
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
    if (
      options.lastEventId &&
      !options.lastEventId.includes("\r") &&
      !options.lastEventId.includes("\n")
    ) {
      headers["Last-Event-ID"] = options.lastEventId;
    }

    let closed = false;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    const clearConnectTimer = (): void => {
      if (connectTimer !== null) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
    };
    const finish = (reason: string): void => {
      if (!closed) {
        closed = true;
        clearConnectTimer();
        options.signal.removeEventListener("abort", onAbort);
        options.onClose(reason);
      }
    };

    const req = http.request(
      {
        hostname: validated.host,
        port: validated.port,
        path: "/api/events",
        method: "GET",
        headers,
      },
      (res) => {
        clearConnectTimer();
        // SSE stream stays open indefinitely across idle gaps; never apply socket idle timeout.
        req.setTimeout(0);
        res.setTimeout(0);
        res.socket?.setTimeout(0);

        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          finish(`GET /api/events returned HTTP ${status}`);
          return;
        }

        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          if (Buffer.byteLength(buffer, "utf8") > MAX_HTTP_RESPONSE_BYTES) {
            req.destroy(new Error("SSE buffer limit exceeded"));
            return;
          }
          while (true) {
            const lfIdx = buffer.indexOf("\n\n");
            const crlfIdx = buffer.indexOf("\r\n\r\n");
            let idx = -1;
            let sepLen = 0;
            if (lfIdx >= 0 && (crlfIdx < 0 || lfIdx < crlfIdx)) {
              idx = lfIdx;
              sepLen = 2;
            } else if (crlfIdx >= 0) {
              idx = crlfIdx;
              sepLen = 4;
            }
            if (idx < 0) break;
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + sepLen);
            const frame = parseSseEventBlock(block);
            if (frame) {
              options.onEvent(frame);
            }
          }
        });
        res.on("end", () => {
          if (buffer.length > 0) {
            const frame = parseSseEventBlock(buffer);
            if (frame) options.onEvent(frame);
          }
          finish("SSE connection closed");
        });
        res.on("error", (err) => {
          finish(`SSE read error: ${err.message}`);
        });
      },
    );

    const onAbort = (): void => {
      req.destroy();
      finish("aborted");
    };

    if (options.signal.aborted) {
      finish("aborted");
      return;
    }
    options.signal.addEventListener("abort", onAbort, { once: true });
    connectTimer = setTimeout(() => {
      req.destroy(new Error("SSE connect timeout"));
    }, this.timeouts.sseConnectTimeoutMs);
    req.on("error", (err) => {
      finish(`SSE connect error: ${err.message}`);
    });
    req.end();
  }
}
