import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import {
  DEFAULT_REMOTE_PORT,
  TailscaleStatusResponseSchema,
  type TailscaleStatusResponse,
} from "@kiln/protocol";
import { buildSanitizedEnv } from "../gate/command-runner.js";

const execFileAsync = promisify(execFile);
const TAILSCALE_TIMEOUT_MS = 3_000;
const MACOS_TAILSCALE_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export type TailscaleExecFileFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface InspectTailscaleOptions {
  remotePort?: number;
  execFileImpl?: TailscaleExecFileFn;
  platform?: NodeJS.Platform;
  existsSync?: (filePath: string) => boolean;
}

async function defaultExecFile(
  file: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  const res = await execFileAsync(file, [...args], {
    env: buildSanitizedEnv(),
    encoding: "utf8",
    timeout: TAILSCALE_TIMEOUT_MS,
  });
  return { stdout: res.stdout, stderr: res.stderr };
}

function isCommandNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function extractServeTargets(rawServeJson: unknown): string[] {
  if (rawServeJson === null || typeof rawServeJson !== "object") {
    return [];
  }
  const web = (rawServeJson as { Web?: unknown }).Web;
  if (web === null || typeof web !== "object") {
    return [];
  }

  const targets: string[] = [];
  for (const hostEntry of Object.values(web as Record<string, unknown>)) {
    if (hostEntry === null || typeof hostEntry !== "object") {
      continue;
    }
    const handlers = (hostEntry as { Handlers?: unknown }).Handlers;
    if (handlers === null || typeof handlers !== "object") {
      continue;
    }
    for (const handler of Object.values(handlers as Record<string, unknown>)) {
      if (handler === null || typeof handler !== "object") {
        continue;
      }
      const proxy = (handler as { Proxy?: unknown }).Proxy;
      if (typeof proxy === "string" && proxy.trim().length > 0) {
        targets.push(proxy.trim());
      }
    }
  }
  return targets;
}

function targetMatchesRemotePort(target: string, remotePort: number): boolean {
  try {
    const normalized = target.includes("://") ? target : `http://${target}`;
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.toLowerCase();
    const isLoopback =
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "[::1]";
    if (!isLoopback) {
      return false;
    }
    const effectivePort =
      parsed.port.length > 0 ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    return effectivePort === remotePort;
  } catch {
    return false;
  }
}

/**
 * Safely inspects Tailscale CLI and `tailscale serve` state using read-only commands.
 * Never mutates Tailscale state and gracefully degrades when `tailscale` is absent or stopped.
 */
export async function inspectTailscaleStatus(
  options: InspectTailscaleOptions = {},
): Promise<TailscaleStatusResponse> {
  const remotePort = options.remotePort ?? DEFAULT_REMOTE_PORT;
  const recommendedCommand = `tailscale serve --bg http://127.0.0.1:${remotePort}`;
  const execImpl = options.execFileImpl ?? defaultExecFile;
  const platform = options.platform ?? process.platform;
  const existsSync = options.existsSync ?? fs.existsSync;

  let binary = "tailscale";
  let statusRaw: string;
  try {
    const res = await execImpl(binary, ["status", "--json"]);
    statusRaw = res.stdout;
  } catch (err) {
    if (
      isCommandNotFoundError(err) &&
      platform === "darwin" &&
      existsSync(MACOS_TAILSCALE_APP_CLI)
    ) {
      binary = MACOS_TAILSCALE_APP_CLI;
      try {
        const fallbackRes = await execImpl(binary, ["status", "--json"]);
        statusRaw = fallbackRes.stdout;
      } catch (fallbackErr) {
        return TailscaleStatusResponseSchema.parse({
          ok: true,
          installed: !isCommandNotFoundError(fallbackErr),
          running: false,
          backendState: null,
          dnsName: null,
          magicDnsUrl: null,
          serveActive: false,
          serveConfiguredForPort: false,
          serveTargets: [],
          remotePort,
          recommendedCommand,
          detail: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
      }
    } else if (isCommandNotFoundError(err)) {
      return TailscaleStatusResponseSchema.parse({
        ok: true,
        installed: false,
        running: false,
        backendState: null,
        dnsName: null,
        magicDnsUrl: null,
        serveActive: false,
        serveConfiguredForPort: false,
        serveTargets: [],
        remotePort,
        recommendedCommand,
        detail: "tailscale CLI is not installed or not in PATH",
      });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      return TailscaleStatusResponseSchema.parse({
        ok: true,
        installed: true,
        running: false,
        backendState: null,
        dnsName: null,
        magicDnsUrl: null,
        serveActive: false,
        serveConfiguredForPort: false,
        serveTargets: [],
        remotePort,
        recommendedCommand,
        detail: `tailscale status failed: ${msg}`,
      });
    }
  }

  let backendState: string | null = null;
  let dnsName: string | null = null;
  let detail: string | undefined;
  try {
    const parsed = JSON.parse(statusRaw) as {
      BackendState?: unknown;
      Self?: { DNSName?: unknown } | null;
    };
    if (typeof parsed.BackendState === "string" && parsed.BackendState.length > 0) {
      backendState = parsed.BackendState;
    }
    const rawDns = parsed.Self?.DNSName;
    if (typeof rawDns === "string" && rawDns.trim().length > 0) {
      const cleaned = rawDns.trim().replace(/\.+$/, "");
      if (cleaned.length > 0) {
        dnsName = cleaned;
      }
    }
  } catch {
    detail = "Unable to parse JSON output from tailscale status --json";
  }

  const running = backendState === "Running";
  const magicDnsUrl = dnsName ? `https://${dnsName}` : null;

  let serveTargets: string[] = [];
  if (running) {
    try {
      const serveRes = await execImpl(binary, ["serve", "status", "--json"]);
      const trimmed = serveRes.stdout.trim();
      if (trimmed.length > 0) {
        const parsedServe: unknown = JSON.parse(trimmed);
        serveTargets = extractServeTargets(parsedServe);
      }
    } catch (err) {
      const serveErrMsg = err instanceof Error ? err.message : String(err);
      detail = detail
        ? `${detail}; tailscale serve status failed: ${serveErrMsg}`
        : `tailscale serve status unavailable: ${serveErrMsg}`;
    }
  }

  const serveActive = serveTargets.length > 0;
  const serveConfiguredForPort = serveTargets.some((t) => targetMatchesRemotePort(t, remotePort));

  return TailscaleStatusResponseSchema.parse({
    ok: true,
    installed: true,
    running,
    backendState,
    dnsName,
    magicDnsUrl,
    serveActive,
    serveConfiguredForPort,
    serveTargets,
    remotePort,
    recommendedCommand,
    ...(detail !== undefined ? { detail } : {}),
  });
}
