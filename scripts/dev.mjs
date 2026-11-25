import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const CLI_BIN_PATH = path.join(ROOT_DIR, "packages", "cli", "dist", "bin.js");
const DESKTOP_DIR = path.join(ROOT_DIR, "apps", "desktop");
const DESKTOP_MAIN_PATH = path.join(DESKTOP_DIR, "dist", "main.js");
const DESKTOP_SRC_DIR = path.join(DESKTOP_DIR, "src");
const PNPM_CMD = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function parseArgs(argv) {
  let mode = "desktop";
  let kilndUrlRaw = process.env.KILND_URL?.trim() || "http://127.0.0.1:4310";
  let preferredPort = Number(process.env.KILN_UI_DEV_PORT) || 5173;

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
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "Usage: node scripts/dev.mjs [--mode desktop|web] [--kilnd-url http://127.0.0.1:4310] [--port 5173]\n",
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
  return { mode, kilndUrl, kilndPort, preferredPort };
}

function newestMtimeMs(dir) {
  let latest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, newestMtimeMs(fullPath));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      latest = Math.max(latest, fs.statSync(fullPath).mtimeMs);
    }
  }
  return latest;
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
  if (!fs.existsSync(CLI_BIN_PATH)) {
    process.stdout.write("[dev] CLI build missing; running pnpm build...\n");
    runPnpmSync(["build"]);
    return;
  }

  if (mode === "desktop") {
    const distMissing = !fs.existsSync(DESKTOP_MAIN_PATH);
    const distStale =
      !distMissing && newestMtimeMs(DESKTOP_SRC_DIR) > fs.statSync(DESKTOP_MAIN_PATH).mtimeMs;
    if (distMissing || distStale) {
      process.stdout.write("[dev] Packing @kiln/desktop main process...\n");
      runPnpmSync(["--filter", "@kiln/desktop", "exec", "vp", "pack"]);
    }
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

function terminateChild(child) {
  if (!child || child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve();
    }, 1500);
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
  const { mode, kilndUrl, kilndPort, preferredPort } = parseArgs(process.argv.slice(2));
  ensureBuildArtifacts(mode);

  const managedChildren = [];
  let shuttingDown = false;

  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.all(managedChildren.reverse().map((child) => terminateChild(child)));
    process.exit(code);
  };

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  const healthUrl = `${kilndUrl}/api/health`;
  const kilndAlreadyRunning = await isHttpOk(healthUrl);
  if (kilndAlreadyRunning) {
    process.stdout.write(`[dev] Reusing running kilnd at ${kilndUrl}\n`);
  } else {
    process.stdout.write(`[dev] Starting kilnd on ${kilndUrl}...\n`);
    const kilndArgs = [CLI_BIN_PATH, "up", "--port", String(kilndPort), "--foreground"];
    if (process.env.KILN_HOME) {
      kilndArgs.push("--kiln-home", process.env.KILN_HOME);
    }
    const kilndChild = spawn(process.execPath, kilndArgs, {
      cwd: ROOT_DIR,
      stdio: "inherit",
      env: process.env,
    });
    managedChildren.push(kilndChild);
    await waitForHttpOk(healthUrl, 30_000, kilndChild, "kilnd");
  }

  const vitePort = await findAvailablePort(preferredPort);
  const viteUrl = `http://127.0.0.1:${vitePort}`;
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
  managedChildren.push(viteChild);
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
    managedChildren.push(electronChild);
    electronChild.on("exit", (code) => {
      if (!shuttingDown) {
        void shutdown(code ?? 0);
      }
    });
  }
}

main().catch((err) => {
  process.stderr.write(`[dev] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
