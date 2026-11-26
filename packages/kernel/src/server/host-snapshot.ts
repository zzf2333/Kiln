import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_CAPTURE_TIMEOUT_MS = 3_000;
const MAX_PROCESS_ITEMS = 500;
const MAX_APP_ITEMS = 500;

export interface HostSnapshotProcessEntry {
  name: string;
  path?: string;
}

export interface HostSnapshotAppEntry {
  name: string;
  path: string;
  bundle_id?: string;
}

export interface HostEnvironmentSnapshot {
  schema_version: 1;
  captured_at: string;
  platform: NodeJS.Platform;
  running_processes: {
    status: "ok" | "unavailable";
    count: number;
    items: HostSnapshotProcessEntry[];
    error?: string;
  };
  installed_apps: {
    status: "ok" | "unavailable" | "skipped";
    count: number;
    items: HostSnapshotAppEntry[];
    scanned_roots: string[];
    error?: string;
  };
}

function parsePosixPsCommOutput(stdout: string): HostSnapshotProcessEntry[] {
  const seen = new Set<string>();
  const items: HostSnapshotProcessEntry[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const isAbsPath = trimmed.startsWith("/");
    const name = isAbsPath ? path.posix.basename(trimmed) : trimmed;
    if (!name) continue;
    const key = isAbsPath ? trimmed : name;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(isAbsPath ? { name, path: trimmed } : { name });
    if (items.length >= MAX_PROCESS_ITEMS) break;
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

function parseWindowsTasklistOutput(stdout: string): HostSnapshotProcessEntry[] {
  const seen = new Set<string>();
  const items: HostSnapshotProcessEntry[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('"')) continue;
    const endQuote = trimmed.indexOf('"', 1);
    if (endQuote <= 1) continue;
    const name = trimmed.slice(1, endQuote).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    items.push({ name });
    if (items.length >= MAX_PROCESS_ITEMS) break;
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

async function captureRunningProcesses(
  timeoutMs: number,
  platform: NodeJS.Platform,
): Promise<HostEnvironmentSnapshot["running_processes"]> {
  try {
    if (platform === "win32") {
      const { stdout } = await execFileAsync("tasklist", ["/FO", "CSV", "/NH"], {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      });
      const items = parseWindowsTasklistOutput(stdout);
      return { status: "ok", count: items.length, items };
    }
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "comm="], {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    const items = parsePosixPsCommOutput(stdout);
    return { status: "ok", count: items.length, items };
  } catch (err) {
    return {
      status: "unavailable",
      count: 0,
      items: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function collectAppPathsShallow(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(rootDir, entry.name);
    if (entry.name.endsWith(".app")) {
      results.push(full);
    } else if (!entry.name.startsWith(".")) {
      try {
        for (const sub of fs.readdirSync(full, { withFileTypes: true })) {
          if (sub.isDirectory() && sub.name.endsWith(".app")) {
            results.push(path.join(full, sub.name));
          }
        }
      } catch {
        // Skip unreadable subdirectory
      }
    }
    if (results.length >= MAX_APP_ITEMS) break;
  }
  return results;
}

function extractXmlBundleId(plistPath: string): string | undefined {
  try {
    const raw = fs.readFileSync(plistPath, "utf8");
    const m = /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>\s*([^<\s][^<]*)\s*<\/string>/i.exec(
      raw,
    );
    return m?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function readBundleIdsViaPython(
  appPaths: readonly string[],
  timeoutMs: number,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (appPaths.length === 0 || !fs.existsSync("/usr/bin/python3")) {
    return out;
  }
  const pyScript = [
    "import json, pathlib, plistlib, sys",
    "res = {}",
    "for raw in json.loads(sys.argv[1]):",
    "    p = pathlib.Path(raw) / 'Contents' / 'Info.plist'",
    "    try:",
    "        with p.open('rb') as fh:",
    "            bid = plistlib.load(fh).get('CFBundleIdentifier')",
    "        if isinstance(bid, str) and bid.strip():",
    "            res[raw] = bid.strip()",
    "    except Exception:",
    "        pass",
    "print(json.dumps(res))",
  ].join("\n");

  const { stdout } = await execFileAsync(
    "/usr/bin/python3",
    ["-I", "-B", "-c", pyScript, JSON.stringify(appPaths)],
    {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string" && v.trim()) {
      out.set(k, v.trim());
    }
  }
  return out;
}

async function captureInstalledMacApps(
  timeoutMs: number,
  homeDir: string,
): Promise<HostEnvironmentSnapshot["installed_apps"]> {
  const roots = [
    "/Applications",
    path.join(homeDir, "Applications"),
    "/System/Applications",
    "/System/Applications/Utilities",
    "/Library/Input Methods",
    path.join(homeDir, "Library", "Input Methods"),
  ];
  const scannedRoots = roots.filter((r) => fs.existsSync(r));
  try {
    const seen = new Set<string>();
    const appPaths: string[] = [];
    for (const root of scannedRoots) {
      for (const appPath of collectAppPathsShallow(root)) {
        if (!seen.has(appPath)) {
          seen.add(appPath);
          appPaths.push(appPath);
          if (appPaths.length >= MAX_APP_ITEMS) break;
        }
      }
      if (appPaths.length >= MAX_APP_ITEMS) break;
    }

    let bundleIds = new Map<string, string>();
    try {
      bundleIds = await readBundleIdsViaPython(appPaths, timeoutMs);
    } catch {
      // Fallback to XML plist scan if python3 helper fails
    }

    const items: HostSnapshotAppEntry[] = appPaths.map((appPath) => {
      const name = path.posix.basename(appPath).replace(/\.app$/i, "");
      const bundleId =
        bundleIds.get(appPath) ?? extractXmlBundleId(path.join(appPath, "Contents", "Info.plist"));
      return {
        name,
        path: appPath,
        ...(bundleId !== undefined ? { bundle_id: bundleId } : {}),
      };
    });
    items.sort((a, b) => a.path.localeCompare(b.path));
    return {
      status: "ok",
      count: items.length,
      items,
      scanned_roots: scannedRoots,
    };
  } catch (err) {
    return {
      status: "unavailable",
      count: 0,
      items: [],
      scanned_roots: scannedRoots,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Captures a strictly read-only, sanitized host snapshot (process executable names
 * without CLI arguments/env, plus installed `.app` bundle IDs on macOS) from the
 * unsandboxed `kilnd` process so `host_scoped` workers inside tighter sandboxes do not
 * fall back to empty plans when `/bin/ps` is blocked. Never throws.
 */
export async function captureHostEnvironmentSnapshot(options?: {
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  homeDir?: string;
}): Promise<HostEnvironmentSnapshot> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  const platform = options?.platform ?? process.platform;
  const homeDir = options?.homeDir ?? os.homedir();

  const [running_processes, installed_apps] = await Promise.all([
    captureRunningProcesses(timeoutMs, platform),
    platform === "darwin"
      ? captureInstalledMacApps(timeoutMs, homeDir)
      : Promise.resolve({
          status: "skipped" as const,
          count: 0,
          items: [],
          scanned_roots: [],
        }),
  ]);

  return {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    platform,
    running_processes,
    installed_apps,
  };
}
