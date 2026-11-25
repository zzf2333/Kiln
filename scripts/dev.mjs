import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const CLI_BIN_PATH = path.join(ROOT_DIR, "packages", "cli", "dist", "bin.js");
const PNPM_CMD = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const DEV_STATE_FILENAME = "kiln-dev-state.json";

const WORKSPACE_BUILD_GRAPH = [
  {
    filter: "@kiln/protocol",
    dir: "packages/protocol",
    output: "dist/index.js",
    deps: [],
    buildArgs: ["--filter", "@kiln/protocol", "exec", "vp", "pack"],
  },
  {
    filter: "@kiln/kernel",
    dir: "packages/kernel",
    output: "dist/index.js",
    deps: ["@kiln/protocol"],
    buildArgs: ["--filter", "@kiln/kernel", "exec", "vp", "pack"],
  },
  {
    filter: "@kiln/mcp",
    dir: "packages/mcp",
    output: "dist/bin.js",
    deps: ["@kiln/protocol"],
    buildArgs: ["--filter", "@kiln/mcp", "exec", "vp", "pack"],
  },
  {
    filter: "@zzf2333/kiln",
    dir: "packages/cli",
    output: "dist/bin.js",
    deps: ["@kiln/protocol", "@kiln/kernel", "@kiln/mcp"],
    buildArgs: ["--filter", "@zzf2333/kiln", "exec", "vp", "pack"],
  },
  {
    filter: "@kiln/desktop",
    dir: "apps/desktop",
    output: "dist/main.js",
    deps: ["@kiln/protocol"],
    buildArgs: ["--filter", "@kiln/desktop", "exec", "vp", "pack"],
    desktopOnly: true,
  },
];

export function parseArgs(argv) {
  let mode = "desktop";
  let kilndUrlRaw = process.env.KILND_URL?.trim() || "http://127.0.0.1:4310";
  let preferredPort = Number(process.env.KILN_UI_DEV_PORT) || 5173;
  let reuseKilnd = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") {
      mode = argv[i + 1] ?? mode;
      i += 1;
    } else if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length);
    } else if (arg === "--kilnd-url") {
      kilndUrlRaw = argv[i + 1] ?? kilndUrlRaw;
      i += 1;
    } else if (arg.startsWith("--kilnd-url=")) {
      kilndUrlRaw = arg.slice("--kilnd-url=".length);
    } else if (arg === "--port") {
      preferredPort = Number(argv[i + 1]) || preferredPort;
      i += 1;
    } else if (arg.startsWith("--port=")) {
      preferredPort = Number(arg.slice("--port=".length)) || preferredPort;
    } else if (arg === "--reuse-kilnd") {
      reuseKilnd = true;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "Usage: node scripts/dev.mjs [--mode desktop|web] [--kilnd-url http://127.0.0.1:4310] [--port 5173] [--reuse-kilnd]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (mode !== "desktop" && mode !== "web") {
    throw new Error(`Invalid --mode "${mode}" (expected "desktop" or "web")`);
  }

  const parsed = new URL(kilndUrlRaw);
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "http:" || (host !== "127.0.0.1" && host !== "localhost")) {
    throw new Error(`--kilnd-url must be a loopback http:// URL, got "${kilndUrlRaw}"`);
  }
  const kilndPort = parsed.port ? Number(parsed.port) : 4310;
  const kilndUrl = `http://${host}:${kilndPort}`;
  return { mode, kilndUrl, kilndPort, preferredPort, reuseKilnd };
}

export function resolveKilnHomeDir(env = process.env) {
  const override = env.KILN_HOME?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".kiln");
}

function newestMtimeMs(dir) {
  if (!fs.existsSync(dir)) return 0;
  let latest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, newestMtimeMs(fullPath));
    } else if (
      /\.(ts|tsx|mjs|js)$/.test(entry.name) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx") &&
      !entry.name.endsWith(".socket.test.ts")
    ) {
      latest = Math.max(latest, fs.statSync(fullPath).mtimeMs);
    }
  }
  return latest;
}

function fileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export function detectStaleWorkspacePackages(rootDir = ROOT_DIR, mode = "desktop") {
  const staleFilters = new Set();
  const staleList = [];
  const outputMtimes = new Map();

  for (const pkg of WORKSPACE_BUILD_GRAPH) {
    if (pkg.desktopOnly && mode !== "desktop") {
      continue;
    }
    const pkgDir = path.join(rootDir, pkg.dir);
    const outPath = path.join(pkgDir, pkg.output);
    const outMtime = fileMtimeMs(outPath);
    outputMtimes.set(pkg.filter, outMtime);

    const srcMtime = Math.max(
      newestMtimeMs(path.join(pkgDir, "src")),
      fileMtimeMs(path.join(pkgDir, "package.json")),
    );
    const hasStaleDep = pkg.deps.some(
      (dep) => staleFilters.has(dep) || (outputMtimes.get(dep) ?? 0) > outMtime,
    );

    if (outMtime === 0 || srcMtime > outMtime || hasStaleDep) {
      staleFilters.add(pkg.filter);
      staleList.push(pkg.filter);
    }
  }

  return staleList;
}

export function collectStaleDevPids(state, currentPid = process.pid) {
  if (!state || typeof state !== "object") {
    return [];
  }
  const candidates = [state.electronPid, state.vitePid, state.kilndPid, state.devPid];
  const seen = new Set();
  const out = [];
  for (const raw of candidates) {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(n) || n <= 0 || n === currentPid || seen.has(n)) {
      continue;
    }
    seen.add(n);
    out.push(n);
  }
  return out;
}

function runPnpmSync(args, extraEnv = {}) {
  const res = spawnSync(PNPM_CMD, args, {
    cwd: ROOT_DIR,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...extraEnv },
  });
  if (res.status !== 0) {
    throw new Error(`Command "${PNPM_CMD} ${args.join(" ")}" exited with code ${res.status ?? 1}`);
  }
}

function ensureBuildArtifacts(mode) {
  const staleFilters = detectStaleWorkspacePackages(ROOT_DIR, mode);
  if (staleFilters.length === 0) {
    return;
  }

  process.stdout.write(`[dev] Rebuilding stale packages: ${staleFilters.join(", ")}...\n`);
  for (const filter of staleFilters) {
    const pkg = WORKSPACE_BUILD_GRAPH.find((item) => item.filter === filter);
    if (pkg) {
      runPnpmSync(pkg.buildArgs);
    }
  }
}

async function fetchHealthInfo(url, timeoutMs = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return {
      ok: true,
      pid: typeof data?.pid === "number" && Number.isInteger(data.pid) ? data.pid : null,
      version: typeof data?.version === "string" ? data.version : null,
    };
  } catch {
    return null;
  }
}

async function isHttpOk(url, timeoutMs = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHttpOk(url, timeoutMs, proc, name) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc && proc.exitCode !== null) {
      throw new Error(`${name} exited early with code ${proc.exitCode}`);
    }
    if (await isHttpOk(url, 1500)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${name} at ${url}`);
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(startPort, maxAttempts = 20) {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = startPort + offset;
    if (candidate <= 65535 && (await isPortAvailable(candidate))) {
      return candidate;
    }
  }
  throw new Error(`No free port found near 127.0.0.1:${startPort}`);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && typeof err === "object" && err.code === "EPERM";
  }
}

async function terminatePid(pid, { graceMs = 2000, platform = process.platform } = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !isPidAlive(pid)) {
    return false;
  }

  if (platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5000,
      });
    } catch {
      // Ignore taskkill errors
    }
    return true;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (isPidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      // Ignore kill errors
    }
  }
  return true;
}

function listListeningPidsPosix(port, spawnSyncFn = spawnSync) {
  if (process.platform === "win32") return [];
  try {
    const res = spawnSyncFn("lsof", ["-nP", "-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (res.status !== 0 || typeof res.stdout !== "string") {
      return [];
    }
    const out = [];
    for (const line of res.stdout.split(/\s+/)) {
      const n = Number(line.trim());
      if (Number.isInteger(n) && n > 0 && n !== process.pid && !out.includes(n)) {
        out.push(n);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function readPidFileNumber(pidFilePath) {
  try {
    const raw = fs.readFileSync(pidFilePath, "utf8").trim();
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function readDevStateFile(stateFilePath) {
  try {
    const raw = fs.readFileSync(stateFilePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeDevStateFile(stateFilePath, state) {
  try {
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFilePath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // Non-fatal dev bookkeeping write failure
  }
}

export async function cleanupExistingDevAndKilnd({
  rootDir = ROOT_DIR,
  kilnHome = resolveKilnHomeDir(),
  kilndUrl,
  kilndPort,
  reuseKilnd = false,
  cliBinPath = CLI_BIN_PATH,
  spawnSyncFn = spawnSync,
} = {}) {
  const runDir = path.join(kilnHome, "run");
  const stateFilePath = path.join(runDir, DEV_STATE_FILENAME);
  const pidFilePath = path.join(runDir, "kilnd.pid");
  const sockFilePath = path.join(runDir, "kilnd.sock");
  const healthUrl = `${kilndUrl}/api/health`;
  const stoppedPids = [];

  if (reuseKilnd) {
    const health = await fetchHealthInfo(healthUrl);
    return { stoppedPids, kilndWasRunning: Boolean(health?.ok) };
  }

  // 1. Clean up any stale processes tracked by the previous dev session (Electron, Vite, kilnd, dev).
  const prevState = readDevStateFile(stateFilePath);
  const trackedPids = collectStaleDevPids(prevState, process.pid);
  if (trackedPids.length > 0) {
    process.stdout.write(
      `[dev] Cleaning up previous dev session PID(s): ${trackedPids.join(", ")}...\n`,
    );
    for (const pid of trackedPids) {
      if (await terminatePid(pid, { graceMs: 2000 })) {
        stoppedPids.push(pid);
      }
    }
  }
  fs.rmSync(stateFilePath, { force: true });

  // 2. Gracefully shut down any running kilnd (including older installed versions) so child agent threads flush & release locks.
  const health = await fetchHealthInfo(healthUrl);
  const filePid = readPidFileNumber(pidFilePath);
  const portPids = listListeningPidsPosix(kilndPort, spawnSyncFn);
  const needsDaemonStop =
    Boolean(health?.ok) ||
    (filePid !== null && isPidAlive(filePid)) ||
    portPids.length > 0 ||
    !(await isPortAvailable(kilndPort));

  if (needsDaemonStop) {
    process.stdout.write(
      `[dev] Stopping existing kilnd on ${kilndUrl}${health?.version ? ` (v${health.version})` : ""}...\n`,
    );
    if (fs.existsSync(cliBinPath)) {
      try {
        spawnSyncFn(process.execPath, [cliBinPath, "down", "--kiln-home", kilnHome], {
          cwd: rootDir,
          encoding: "utf8",
          timeout: 10_000,
          env: { ...process.env, KILN_HOME: kilnHome },
        });
      } catch {
        // Fallback to direct PID termination below
      }
    }

    const residualPids = collectStaleDevPids(
      {
        electronPid: health?.pid ?? null,
        vitePid: filePid,
        kilndPid: portPids[0] ?? null,
      },
      process.pid,
    );
    for (const extraPid of portPids.slice(1)) {
      if (!residualPids.includes(extraPid) && extraPid !== process.pid) {
        residualPids.push(extraPid);
      }
    }

    for (const pid of residualPids) {
      if (await terminatePid(pid, { graceMs: 2500 })) {
        stoppedPids.push(pid);
      }
    }

    const freeDeadline = Date.now() + 5000;
    while (Date.now() < freeDeadline) {
      if (await isPortAvailable(kilndPort)) {
        break;
      }
      for (const listenerPid of listListeningPidsPosix(kilndPort, spawnSyncFn)) {
        if (await terminatePid(listenerPid, { graceMs: 1000 })) {
          if (!stoppedPids.includes(listenerPid)) stoppedPids.push(listenerPid);
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    if (!(await isPortAvailable(kilndPort))) {
      throw new Error(
        `Port 127.0.0.1:${kilndPort} is still occupied after cleanup; stop the conflicting process manually`,
      );
    }

    fs.rmSync(pidFilePath, { force: true });
    if (process.platform !== "win32") {
      fs.rmSync(sockFilePath, { force: true });
    }
  }

  return { stoppedPids, kilndWasRunning: needsDaemonStop };
}

function terminateChild(child, graceMs = 2000) {
  if (!child || child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve();
    }, graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function main() {
  const { mode, kilndUrl, kilndPort, preferredPort, reuseKilnd } = parseArgs(process.argv.slice(2));
  const kilnHome = resolveKilnHomeDir();
  const stateFilePath = path.join(kilnHome, "run", DEV_STATE_FILENAME);

  ensureBuildArtifacts(mode);
  await cleanupExistingDevAndKilnd({
    rootDir: ROOT_DIR,
    kilnHome,
    kilndUrl,
    kilndPort,
    reuseKilnd,
  });

  const managedChildren = [];
  let shuttingDown = false;
  const devState = {
    devPid: process.pid,
    kilndPid: null,
    vitePid: null,
    electronPid: null,
    kilndUrl,
    viteUrl: null,
    startedAt: new Date().toISOString(),
  };

  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.all(
      [...managedChildren].reverse().map(({ child, graceMs }) => terminateChild(child, graceMs)),
    );
    fs.rmSync(stateFilePath, { force: true });
    process.exit(code);
  };

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  const healthUrl = `${kilndUrl}/api/health`;
  const kilndAlreadyRunning = reuseKilnd && (await isHttpOk(healthUrl));
  if (kilndAlreadyRunning) {
    process.stdout.write(`[dev] Reusing running kilnd at ${kilndUrl} (--reuse-kilnd)\n`);
  } else {
    process.stdout.write(`[dev] Starting fresh kilnd on ${kilndUrl}...\n`);
    const kilndArgs = [CLI_BIN_PATH, "up", "--port", String(kilndPort), "--foreground"];
    if (process.env.KILN_HOME) {
      kilndArgs.push("--kiln-home", process.env.KILN_HOME);
    }
    const kilndChild = spawn(process.execPath, kilndArgs, {
      cwd: ROOT_DIR,
      stdio: "inherit",
      env: process.env,
    });
    devState.kilndPid = kilndChild.pid ?? null;
    managedChildren.push({ child: kilndChild, graceMs: 5000 });
    await waitForHttpOk(healthUrl, 30_000, kilndChild, "kilnd");
    const liveHealth = await fetchHealthInfo(healthUrl);
    process.stdout.write(
      `[dev] Fresh kilnd ready: v${liveHealth?.version ?? "unknown"} (PID ${liveHealth?.pid ?? kilndChild.pid ?? "?"})\n`,
    );
  }

  const vitePort = await findAvailablePort(preferredPort);
  const viteUrl = `http://127.0.0.1:${vitePort}`;
  devState.viteUrl = viteUrl;
  process.stdout.write(`[dev] Starting Vite HMR server at ${viteUrl}...\n`);

  const viteChild = spawn(
    PNPM_CMD,
    [
      "--filter",
      "@kiln/web",
      "exec",
      "vp",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(vitePort),
      "--strictPort",
    ],
    {
      cwd: ROOT_DIR,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        KILND_URL: kilndUrl,
        KILN_UI_DEV_PORT: String(vitePort),
      },
    },
  );
  devState.vitePid = viteChild.pid ?? null;
  managedChildren.push({ child: viteChild, graceMs: 2000 });
  viteChild.on("exit", (code) => {
    if (!shuttingDown) {
      void shutdown(code ?? 1);
    }
  });

  await waitForHttpOk(viteUrl, 30_000, viteChild, "Vite dev server");

  process.stdout.write(`[dev] Ready (${mode}) · UI (HMR): ${viteUrl} · kilnd: ${kilndUrl}\n`);

  if (mode === "desktop") {
    const electronChild = spawn(PNPM_CMD, ["--filter", "@kiln/desktop", "exec", "electron", "."], {
      cwd: ROOT_DIR,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        KILND_URL: kilndUrl,
        KILN_UI_DEV_URL: viteUrl,
      },
    });
    devState.electronPid = electronChild.pid ?? null;
    managedChildren.push({ child: electronChild, graceMs: 2000 });
    electronChild.on("exit", (code) => {
      if (!shuttingDown) {
        void shutdown(code ?? 0);
      }
    });
  }

  writeDevStateFile(stateFilePath, devState);
}

function isDirectExecution() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const realEntry = fs.realpathSync(entry);
    const realSelf = fs.realpathSync(new URL(import.meta.url));
    return realEntry === realSelf;
  } catch {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url;
  }
}

if (isDirectExecution()) {
  main().catch((err) => {
    process.stderr.write(`[dev] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
