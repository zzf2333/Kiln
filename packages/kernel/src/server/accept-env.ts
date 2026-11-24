import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type {
  AcceptEntryConfig,
  AcceptEntryKind,
  AcceptReadyProbe,
  AcceptServiceSpec,
  AcceptServiceStatus,
  AcceptTrafficErrorResponse,
  AcceptTrafficSummary,
} from "@kiln/protocol";
import {
  buildSanitizedEnv,
  runIsolatedCommand,
  terminateProcessTree,
} from "../gate/command-runner.js";
import { realpathCanonical } from "../store/fs-atomic.js";
import { ensureDir } from "../store/fs-atomic.js";

const MAX_TAIL_CHARS = 4_000;
const MAX_UNIQUE_PATHS = 50;
const MAX_ERROR_RESPONSES = 20;
const HEALTH_POLL_INTERVAL_MS = 100;

export interface AcceptEnvLiveSnapshot {
  entryKind: AcceptEntryKind;
  primaryUrl?: string;
  services: AcceptServiceStatus[];
  traffic: AcceptTrafficSummary;
}

export interface AcceptEnvStartResult extends AcceptEnvLiveSnapshot {
  ok: boolean;
  prepareError?: string;
  errorMessage?: string;
}

export interface AcceptEnvSession {
  readonly entryKind: AcceptEntryKind;
  readonly primaryUrl?: string;
  getLiveSnapshot(): AcceptEnvLiveSnapshot;
  stop(): Promise<void>;
}

export interface StartAcceptEnvOptions {
  cwd: string;
  acceptEnvDir: string;
  entry: AcceptEntryConfig;
  signal?: AbortSignal;
}

export type AcceptEnvStarterFn = (
  options: StartAcceptEnvOptions,
) => Promise<AcceptEnvStartResult & { session?: AcceptEnvSession }>;

interface LoopbackObserverProxy {
  proxyPort: number;
  getStats(): {
    totalRequests: number;
    uniquePaths: string[];
    errorResponses: AcceptTrafficErrorResponse[];
  };
  close(): Promise<void>;
}

interface ManagedServiceRuntime {
  spec: AcceptServiceSpec;
  status: AcceptServiceStatus["status"] | "starting";
  port?: number;
  proxyPort?: number;
  url?: string;
  exitCode: number | null;
  logFile: string;
  logStream: fs.WriteStream | null;
  tailLog: string;
  child: ChildProcess | null;
  proxy: LoopbackObserverProxy | null;
  stoppedByOwner: boolean;
}

function appendTail(current: string, chunk: string): string {
  const combined = current + chunk;
  if (combined.length <= MAX_TAIL_CHARS) {
    return combined;
  }
  return combined.slice(combined.length - MAX_TAIL_CHARS);
}

/**
 * Reserves an ephemeral free TCP port on loopback `127.0.0.1`.
 */
export async function allocateLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        if (port <= 0) {
          reject(new Error("Failed to allocate loopback ephemeral port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

function extractPathname(rawUrl: string | undefined): string {
  if (!rawUrl || rawUrl.length === 0) return "/";
  const qIdx = rawUrl.indexOf("?");
  return qIdx >= 0 ? rawUrl.slice(0, qIdx) || "/" : rawUrl;
}

/**
 * Creates a lightweight zero-dependency loopback HTTP + WebSocket observer proxy
 * forwarding `127.0.0.1:<proxyPort>` -> `127.0.0.1:<targetPort>`.
 * Health probes bypass the proxy by connecting directly to `targetPort`, so
 * `totalRequests` strictly counts external client / verifier traffic.
 */
export async function createLoopbackHttpObserverProxy(input: {
  serviceName: string;
  targetPort: number;
  proxyPort: number;
}): Promise<LoopbackObserverProxy> {
  let totalRequests = 0;
  const uniquePaths: string[] = [];
  const uniquePathSet = new Set<string>();
  const errorResponses: AcceptTrafficErrorResponse[] = [];
  const activeSockets = new Set<net.Socket>();
  let closed = false;

  const recordPath = (pathname: string): void => {
    if (!uniquePathSet.has(pathname) && uniquePaths.length < MAX_UNIQUE_PATHS) {
      uniquePathSet.add(pathname);
      uniquePaths.push(pathname);
    }
  };

  const server = http.createServer((req, res) => {
    totalRequests += 1;
    const reqPath = extractPathname(req.url);
    recordPath(reqPath);
    const method = (req.method ?? "GET").toUpperCase();

    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    headers.host = `127.0.0.1:${input.targetPort}`;

    const upstreamReq = http.request(
      {
        hostname: "127.0.0.1",
        port: input.targetPort,
        method,
        path: req.url ?? "/",
        headers,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        if (status >= 400 && errorResponses.length < MAX_ERROR_RESPONSES) {
          errorResponses.push({
            method,
            path: reqPath,
            status,
            service: input.serviceName,
          });
        }
        res.writeHead(status, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on("error", () => {
      if (errorResponses.length < MAX_ERROR_RESPONSES) {
        errorResponses.push({
          method,
          path: reqPath,
          status: 502,
          service: input.serviceName,
        });
      }
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end("Upstream accept service unavailable");
    });

    req.pipe(upstreamReq);
  });

  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
  });

  server.on("upgrade", (req, clientSocket, head) => {
    totalRequests += 1;
    const reqPath = extractPathname(req.url);
    recordPath(reqPath);
    activeSockets.add(clientSocket as net.Socket);
    clientSocket.once("close", () => activeSockets.delete(clientSocket as net.Socket));

    const upstreamSocket = net.connect(input.targetPort, "127.0.0.1", () => {
      const headerLines: string[] = [
        `${(req.method ?? "GET").toUpperCase()} ${req.url ?? "/"} HTTP/${req.httpVersion}`,
      ];
      const rawHeaders = req.rawHeaders;
      for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
        const k = rawHeaders[i]!;
        const v = rawHeaders[i + 1]!;
        if (k.toLowerCase() === "host") {
          headerLines.push(`Host: 127.0.0.1:${input.targetPort}`);
        } else {
          headerLines.push(`${k}: ${v}`);
        }
      }
      headerLines.push("", "");
      upstreamSocket.write(headerLines.join("\r\n"));
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });

    activeSockets.add(upstreamSocket);
    upstreamSocket.once("close", () => activeSockets.delete(upstreamSocket));
    upstreamSocket.on("error", () => {
      clientSocket.destroy();
    });
    clientSocket.on("error", () => {
      upstreamSocket.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.proxyPort, "127.0.0.1", () => resolve());
  });

  return {
    proxyPort: input.proxyPort,
    getStats() {
      return {
        totalRequests,
        uniquePaths: [...uniquePaths],
        errorResponses: [...errorResponses],
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const sock of activeSockets) {
        sock.destroy();
      }
      activeSockets.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/**
 * Topologically orders accept services by `depends_on`, preserving declaration order.
 */
export function toposortAcceptServices(
  services: readonly AcceptServiceSpec[],
): AcceptServiceSpec[] {
  const byName = new Map(services.map((s) => [s.name, s]));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const s of services) {
    inDegree.set(s.name, 0);
    dependents.set(s.name, []);
  }
  for (const s of services) {
    for (const dep of s.depends_on) {
      if (!byName.has(dep)) continue;
      inDegree.set(s.name, (inDegree.get(s.name) ?? 0) + 1);
      dependents.get(dep)!.push(s.name);
    }
  }

  const ordered: AcceptServiceSpec[] = [];
  const remaining = new Set(services.map((s) => s.name));
  while (remaining.size > 0) {
    let picked: string | null = null;
    for (const s of services) {
      if (remaining.has(s.name) && (inDegree.get(s.name) ?? 0) === 0) {
        picked = s.name;
        break;
      }
    }
    if (picked === null) {
      for (const s of services) {
        if (remaining.has(s.name)) {
          ordered.push(s);
          remaining.delete(s.name);
        }
      }
      break;
    }
    remaining.delete(picked);
    ordered.push(byName.get(picked)!);
    for (const childName of dependents.get(picked) ?? []) {
      inDegree.set(childName, Math.max(0, (inDegree.get(childName) ?? 1) - 1));
    }
  }
  return ordered;
}

function expandAcceptTemplate(
  raw: string,
  selfPort: number | undefined,
  exposedPortMap: ReadonlyMap<string, number>,
  tmpdir: string,
): string {
  return raw
    .replace(/\{\{port\}\}/g, selfPort !== undefined ? String(selfPort) : "")
    .replace(/\{\{tmpdir\}\}/g, tmpdir)
    .replace(/\{\{ports\.([a-z0-9][a-z0-9_-]*)\}\}/gi, (_match, svcName: string) => {
      const p = exposedPortMap.get(svcName);
      return p !== undefined ? String(p) : "";
    });
}

function resolveContainedServiceCwd(worktreeRoot: string, relCwd?: string): string {
  const canonicalRoot = realpathCanonical(worktreeRoot);
  if (!relCwd || relCwd.trim().length === 0) {
    return canonicalRoot;
  }
  const candidate = path.resolve(canonicalRoot, relCwd.trim());
  const canonicalCandidate = fs.existsSync(candidate) ? realpathCanonical(candidate) : candidate;
  const prefix = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep;
  if (canonicalCandidate !== canonicalRoot && !canonicalCandidate.startsWith(prefix)) {
    throw new Error(`Service cwd "${relCwd}" escapes workspace root "${canonicalRoot}"`);
  }
  return canonicalCandidate;
}

async function probeHttpOnce(
  port: number,
  probePath: string,
  expectedStatus?: number,
): Promise<boolean> {
  const normalizedPath = probePath.startsWith("/") ? probePath : `/${probePath}`;
  return new Promise<boolean>((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: normalizedPath,
        timeout: 1500,
      },
      (res) => {
        res.resume();
        const code = res.statusCode ?? 0;
        if (expectedStatus !== undefined) {
          resolve(code === expectedStatus);
        } else {
          resolve(code >= 200 && code < 400);
        }
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function probeTcpOnce(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function waitForServiceReady(input: {
  runtime: ManagedServiceRuntime;
  probe: AcceptReadyProbe;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { runtime, probe, timeoutMs, signal } = input;
  if (probe.kind === "delay") {
    const deadline = Math.min(probe.ms, timeoutMs);
    const start = Date.now();
    while (Date.now() - start < deadline) {
      if (signal?.aborted) {
        return { ok: false, reason: `Service "${runtime.spec.name}" startup aborted` };
      }
      if (runtime.status === "crashed" || runtime.status === "failed") {
        return {
          ok: false,
          reason: `Service "${runtime.spec.name}" exited prematurely (exit=${String(runtime.exitCode)})`,
        };
      }
      await new Promise((r) => setTimeout(r, Math.min(50, deadline)));
    }
    return { ok: true };
  }

  let regex: RegExp | null = null;
  if (probe.kind === "stdout_regex") {
    regex = new RegExp(probe.pattern);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      return { ok: false, reason: `Service "${runtime.spec.name}" startup aborted` };
    }
    if (runtime.status === "crashed" || runtime.status === "failed") {
      return {
        ok: false,
        reason: `Service "${runtime.spec.name}" exited before becoming ready (exit=${String(runtime.exitCode)})`,
      };
    }

    if (probe.kind === "stdout_regex" && regex) {
      if (regex.test(runtime.tailLog)) {
        return { ok: true };
      }
    } else if (probe.kind === "http") {
      if (runtime.port === undefined) {
        return {
          ok: false,
          reason: `HTTP probe requires needs_port=true on "${runtime.spec.name}"`,
        };
      }
      const ready = await probeHttpOnce(runtime.port, probe.path, probe.expected_status);
      if (ready) {
        return { ok: true };
      }
    } else if (probe.kind === "tcp") {
      if (runtime.port === undefined) {
        return {
          ok: false,
          reason: `TCP probe requires needs_port=true on "${runtime.spec.name}"`,
        };
      }
      const ready = await probeTcpOnce(runtime.port);
      if (ready) {
        return { ok: true };
      }
    }

    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }

  return {
    ok: false,
    reason: `Service "${runtime.spec.name}" timed out after ${timeoutMs}ms waiting for ${probe.kind} readiness`,
  };
}

function toSafeEnvSuffix(serviceName: string): string {
  return serviceName.replace(/[^a-z0-9]/gi, "_").toUpperCase();
}

function aggregateTrafficSummary(
  observeHttp: boolean,
  runtimes: readonly ManagedServiceRuntime[],
): AcceptTrafficSummary {
  let totalRequests = 0;
  const uniquePaths: string[] = [];
  const pathSet = new Set<string>();
  const errorResponses: AcceptTrafficErrorResponse[] = [];

  for (const rt of runtimes) {
    if (!rt.proxy) continue;
    const stats = rt.proxy.getStats();
    totalRequests += stats.totalRequests;
    for (const p of stats.uniquePaths) {
      if (!pathSet.has(p) && uniquePaths.length < MAX_UNIQUE_PATHS) {
        pathSet.add(p);
        uniquePaths.push(p);
      }
    }
    for (const err of stats.errorResponses) {
      if (errorResponses.length < MAX_ERROR_RESPONSES) {
        errorResponses.push(err);
      }
    }
  }

  return {
    observed: observeHttp && runtimes.some((r) => r.proxy !== null),
    total_requests: totalRequests,
    unique_paths: uniquePaths,
    error_responses: errorResponses,
  };
}

function toServiceStatuses(runtimes: readonly ManagedServiceRuntime[]): AcceptServiceStatus[] {
  return runtimes.map((rt) => {
    const publicStatus: AcceptServiceStatus["status"] =
      rt.status === "starting" ? "failed" : rt.status;
    return {
      name: rt.spec.name,
      status: publicStatus,
      ...(rt.port !== undefined ? { port: rt.port } : {}),
      ...(rt.proxyPort !== undefined ? { proxy_port: rt.proxyPort } : {}),
      ...(rt.url !== undefined ? { url: rt.url } : {}),
      ...(publicStatus === "crashed" || publicStatus === "failed"
        ? { exit_code: rt.exitCode }
        : {}),
      log_file: rt.logFile,
      ...(rt.tailLog.trim().length > 0 ? { tail_log: rt.tailLog.trim() } : {}),
    };
  });
}

/**
 * Starts and supervises an isolated `accept_entry` target environment for `accept` runs:
 * - Runs optional `prepare_cmd` synchronously first with credential stripping.
 * - Allocates dynamic loopback ports (`{{port}}` & cross-service `{{ports.<name>}}`) + `KILN_ACCEPT_TMPDIR`.
 * - Optionally mounts zero-dependency loopback HTTP/WS observer proxies so health probes bypass traffic counting.
 * - Captures per-service logs and mid-run crashes, and guarantees full process-tree cleanup on `stop()`.
 */
export async function startAcceptEnvSession(
  options: StartAcceptEnvOptions,
): Promise<AcceptEnvStartResult & { session?: AcceptEnvSession }> {
  const { entry, cwd, acceptEnvDir, signal } = options;

  if (entry.kind === "none" || entry.kind === "cli_binary") {
    if (entry.kind === "cli_binary" && entry.prepare_cmd) {
      ensureDir(acceptEnvDir);
      const prep = await runIsolatedCommand(entry.prepare_cmd, {
        cwd,
        timeoutMs: 120_000,
        ...(signal ? { signal } : {}),
      });
      if (prep.exitCode !== 0) {
        const msg = [prep.stderr, prep.stdout]
          .filter(Boolean)
          .join("\n")
          .trim()
          .slice(-MAX_TAIL_CHARS);
        return {
          ok: false,
          entryKind: entry.kind,
          services: [],
          traffic: { observed: false, total_requests: 0, unique_paths: [], error_responses: [] },
          prepareError: msg || `prepare_cmd exited with code ${prep.exitCode}`,
          errorMessage: `accept_entry prepare_cmd failed (exit=${prep.exitCode})`,
        };
      }
    }
    return {
      ok: true,
      entryKind: entry.kind,
      services: [],
      traffic: { observed: false, total_requests: 0, unique_paths: [], error_responses: [] },
    };
  }

  ensureDir(acceptEnvDir);
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "kiln-accept-"));
  const observeHttp = entry.kind === "http_server" && entry.observe_http !== false;
  const runtimes: ManagedServiceRuntime[] = [];
  let tornDown = false;

  const stopAll = async (): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    for (const rt of [...runtimes].reverse()) {
      rt.stoppedByOwner = true;
      if (rt.child?.pid) {
        await terminateProcessTree(rt.child.pid).catch(() => false);
      }
      if (rt.proxy) {
        await rt.proxy.close().catch(() => {});
      }
      if (rt.logStream) {
        await new Promise<void>((resolve) => {
          rt.logStream!.end(() => resolve());
        }).catch(() => {});
        rt.logStream = null;
      }
      if (rt.status === "ready") {
        rt.status = "stopped";
      }
    }
    fs.rmSync(tmpdir, { recursive: true, force: true });
  };

  try {
    if (entry.prepare_cmd) {
      const prep = await runIsolatedCommand(entry.prepare_cmd, {
        cwd,
        timeoutMs: 120_000,
        extraSafeEnv: { KILN_ACCEPT_TMPDIR: tmpdir },
        ...(signal ? { signal } : {}),
      });
      if (prep.exitCode !== 0) {
        const msg = [prep.stderr, prep.stdout]
          .filter(Boolean)
          .join("\n")
          .trim()
          .slice(-MAX_TAIL_CHARS);
        await stopAll();
        return {
          ok: false,
          entryKind: entry.kind,
          services: [],
          traffic: { observed: false, total_requests: 0, unique_paths: [], error_responses: [] },
          prepareError: msg || `prepare_cmd exited with code ${prep.exitCode}`,
          errorMessage: `accept_entry prepare_cmd failed (exit=${prep.exitCode})`,
        };
      }
    }

    const orderedSpecs = toposortAcceptServices(entry.services);
    const targetPortMap = new Map<string, number>();
    const exposedPortMap = new Map<string, number>();
    const proxyPortMap = new Map<string, number>();
    const urlMap = new Map<string, string>();

    for (const svc of orderedSpecs) {
      if (svc.needs_port) {
        const targetPort = await allocateLoopbackPort();
        targetPortMap.set(svc.name, targetPort);
        if (observeHttp) {
          const proxyPort = await allocateLoopbackPort();
          proxyPortMap.set(svc.name, proxyPort);
          exposedPortMap.set(svc.name, proxyPort);
          urlMap.set(svc.name, `http://127.0.0.1:${proxyPort}`);
        } else {
          exposedPortMap.set(svc.name, targetPort);
          if (entry.kind === "http_server") {
            urlMap.set(svc.name, `http://127.0.0.1:${targetPort}`);
          }
        }
      }
    }

    const primarySpec =
      orderedSpecs.find((s) => s.primary) ??
      orderedSpecs.find((s) => urlMap.has(s.name)) ??
      orderedSpecs[0];
    const primaryUrl = primarySpec ? urlMap.get(primarySpec.name) : undefined;

    for (const svc of orderedSpecs) {
      const targetPort = targetPortMap.get(svc.name);
      const proxyPort = proxyPortMap.get(svc.name);
      const svcUrl = urlMap.get(svc.name);
      const logFile = path.join(acceptEnvDir, `${svc.name}.log`);
      const logStream = fs.createWriteStream(logFile, { flags: "a" });
      const runtime: ManagedServiceRuntime = {
        spec: svc,
        status: "starting",
        ...(targetPort !== undefined ? { port: targetPort } : {}),
        ...(proxyPort !== undefined ? { proxyPort } : {}),
        ...(svcUrl !== undefined ? { url: svcUrl } : {}),
        exitCode: null,
        logFile,
        logStream,
        tailLog: "",
        child: null,
        proxy: null,
        stoppedByOwner: false,
      };
      runtimes.push(runtime);

      if (observeHttp && targetPort !== undefined && proxyPort !== undefined) {
        runtime.proxy = await createLoopbackHttpObserverProxy({
          serviceName: svc.name,
          targetPort,
          proxyPort,
        });
      }

      const svcCwd = resolveContainedServiceCwd(cwd, svc.cwd);
      const expandedCmd = expandAcceptTemplate(svc.cmd, targetPort, exposedPortMap, tmpdir);
      const extraEnv: Record<string, string> = {
        KILN_ACCEPT_TMPDIR: tmpdir,
      };
      if (targetPort !== undefined) {
        extraEnv.PORT = String(targetPort);
        extraEnv.KILN_ACCEPT_PORT = String(targetPort);
      }
      for (const [name, exposedPort] of exposedPortMap.entries()) {
        extraEnv[`KILN_PORT_${toSafeEnvSuffix(name)}`] = String(exposedPort);
      }
      if (svc.env) {
        for (const [k, v] of Object.entries(svc.env)) {
          extraEnv[k] = expandAcceptTemplate(v, targetPort, exposedPortMap, tmpdir);
        }
      }

      const sanitizedEnv = buildSanitizedEnv(process.env, extraEnv);
      const isWindows = process.platform === "win32";
      const child = spawn(expandedCmd, {
        cwd: svcCwd,
        env: sanitizedEnv,
        shell: true,
        detached: !isWindows,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      runtime.child = child;

      const onOutput = (buf: Buffer) => {
        const text = buf.toString("utf8");
        runtime.tailLog = appendTail(runtime.tailLog, text);
        runtime.logStream?.write(buf);
      };
      child.stdout?.on("data", onOutput);
      child.stderr?.on("data", onOutput);

      child.once("error", (err) => {
        runtime.tailLog = appendTail(runtime.tailLog, `\n[spawn error] ${err.message}\n`);
        runtime.status = "failed";
      });
      child.once("exit", (code) => {
        runtime.exitCode = code ?? 1;
        if (!runtime.stoppedByOwner) {
          runtime.status = runtime.status === "ready" ? "crashed" : "failed";
        }
      });

      const defaultProbe: AcceptReadyProbe =
        svc.ready ??
        (entry.kind === "http_server" && svc.needs_port
          ? { kind: "http", path: "/" }
          : { kind: "delay", ms: 500 });

      const readyRes = await waitForServiceReady({
        runtime,
        probe: defaultProbe,
        timeoutMs: svc.ready_timeout_ms,
        signal,
      });

      if (!readyRes.ok) {
        runtime.status = "failed";
        const failedStatuses = toServiceStatuses(runtimes);
        const traffic = aggregateTrafficSummary(observeHttp, runtimes);
        await stopAll();
        return {
          ok: false,
          entryKind: entry.kind,
          ...(primaryUrl !== undefined ? { primaryUrl } : {}),
          services: failedStatuses,
          traffic,
          errorMessage: readyRes.reason,
        };
      }

      runtime.status = "ready";
    }

    const session: AcceptEnvSession = {
      entryKind: entry.kind,
      ...(primaryUrl !== undefined ? { primaryUrl } : {}),
      getLiveSnapshot(): AcceptEnvLiveSnapshot {
        return {
          entryKind: entry.kind,
          ...(primaryUrl !== undefined ? { primaryUrl } : {}),
          services: toServiceStatuses(runtimes),
          traffic: aggregateTrafficSummary(observeHttp, runtimes),
        };
      },
      stop: stopAll,
    };

    return {
      ok: true,
      ...session.getLiveSnapshot(),
      session,
    };
  } catch (err) {
    const failedStatuses = toServiceStatuses(runtimes);
    const traffic = aggregateTrafficSummary(observeHttp, runtimes);
    await stopAll();
    return {
      ok: false,
      entryKind: entry.kind,
      services: failedStatuses,
      traffic,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
