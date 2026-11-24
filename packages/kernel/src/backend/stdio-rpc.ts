import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { RunEventSchema, type RunEvent } from "@kiln/protocol";
import { terminateProcessTree } from "../gate/command-runner.js";

const execFileAsync = promisify(execFile);

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_LINES = 100;
const MAX_STDERR_LINE_CHARS = 4096;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const RATE_LIMIT_RE = /\b429\b|rate[_ -]?limit|too many requests|quota exceeded|retry[_ -]?after/i;

export type SpawnProcessFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type ExecFileProbeFn = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv; windowsHide?: boolean },
) => Promise<{ stdout: string; stderr: string }>;

export interface ResolveCliBinaryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
}

export interface ProbeCliBinaryOptions extends ResolveCliBinaryOptions {
  versionArgs?: readonly string[];
  timeoutMs?: number;
  execFileFn?: ExecFileProbeFn;
}

export interface CliBinaryProbeResult {
  available: boolean;
  resolvedPath: string | null;
  version: string | null;
  detail?: string;
}

/**
 * Pull-based async event queue guaranteeing a single terminal `exit` RunEvent
 * and immediate wakeup for concurrent waiters/iterators.
 */
export class TurnEventQueue {
  private readonly events: RunEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private finished = false;
  private readonly completionPromise: Promise<void>;
  private resolveCompletion!: () => void;

  constructor() {
    this.completionPromise = new Promise<void>((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  push(event: RunEvent): void {
    const validated = RunEventSchema.parse(event);
    if (validated.kind === "exit") {
      if (this.finished) {
        return;
      }
      this.finished = true;
      this.events.push(validated);
      this.wakeAll();
      this.resolveCompletion();
      return;
    }

    if (this.finished) {
      return;
    }
    this.events.push(validated);
    this.wakeAll();
  }

  emitExit(reason: "completed" | "cancelled" | "failed", detail?: string): void {
    this.push({
      kind: "exit",
      at: new Date().toISOString(),
      reason,
      ...(detail !== undefined && detail.length > 0 ? { detail } : {}),
    });
  }

  isFinished(): boolean {
    return this.finished;
  }

  waitForFinish(): Promise<void> {
    return this.completionPromise;
  }

  async *iterate(): AsyncIterable<RunEvent> {
    let index = 0;
    while (true) {
      while (index < this.events.length) {
        const ev = this.events[index]!;
        index += 1;
        yield ev;
        if (ev.kind === "exit") {
          return;
        }
      }
      if (this.finished) {
        return;
      }
      let wake: (() => void) | undefined;
      try {
        await new Promise<void>((resolve) => {
          wake = resolve;
          this.waiters.add(resolve);
        });
      } finally {
        if (wake) {
          this.waiters.delete(wake);
        }
      }
    }
  }

  private wakeAll(): void {
    const callbacks = Array.from(this.waiters);
    this.waiters.clear();
    for (const cb of callbacks) {
      cb();
    }
  }
}

export function isRateLimitMessage(text: string): boolean {
  return RATE_LIMIT_RE.test(text);
}

/**
 * Builds subprocess environment variables for interactive Agent CLIs/ACP servers:
 * merges base env with provider/run overrides (preserving API keys/auth tokens),
 * strips `KILN_RUN_TOKEN` so it is ONLY mounted on the `kiln __mcp` stdio child,
 * and disables interactive git terminal prompts.
 */
export function buildAgentCliEnv(
  providerEnv?: Record<string, string>,
  runEnv?: Record<string, string>,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...(providerEnv ?? {}),
    ...(runEnv ?? {}),
  };
  delete merged.KILN_RUN_TOKEN;
  merged.GIT_TERMINAL_PROMPT = "0";
  return merged;
}

export function extractRetryAfterSec(text: string): number | undefined {
  const m = /retry[_ -]?after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?)?/i.exec(text);
  if (!m) {
    return undefined;
  }
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num <= 0) {
    return undefined;
  }
  if (m[2]?.toLowerCase() === "ms") {
    return Math.max(1, Math.ceil(num / 1000));
  }
  return Math.ceil(num);
}

function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      return false;
    }
    if (platform === "win32") {
      return true;
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expandPathCandidates(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homedir: string,
): string[] {
  const trimmed = command.trim();
  if (!trimmed) {
    return [];
  }

  const pathext =
    platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .map((e) => e.trim())
          .filter((e) => e.length > 0)
      : [""];

  const hasSeparator = trimmed.includes("/") || trimmed.includes("\\");
  if (hasSeparator) {
    const resolved = path.resolve(trimmed);
    const results = [resolved];
    if (platform === "win32" && !path.extname(resolved)) {
      for (const ext of pathext) {
        results.push(`${resolved}${ext}`);
      }
    }
    return results;
  }

  const rawPath = env.PATH ?? env.Path ?? "";
  const extraDirs =
    platform === "win32"
      ? [path.join(homedir, ".local", "bin")]
      : [
          path.join(homedir, ".local", "bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
          path.join(homedir, ".local", "share", "mise", "shims"),
        ];

  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const dir of [...rawPath.split(path.delimiter), ...extraDirs]) {
    const clean = dir.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    dirs.push(clean);
  }

  const candidates: string[] = [];
  for (const dir of dirs) {
    const base = path.join(dir, trimmed);
    if (platform === "win32") {
      if (path.extname(trimmed)) {
        candidates.push(base);
      } else {
        for (const ext of pathext) {
          candidates.push(`${base}${ext}`);
        }
        candidates.push(base);
      }
    } else {
      candidates.push(base);
    }
  }
  return candidates;
}

/**
 * Resolves a CLI binary across PATH and common user/Homebrew tool directories.
 */
export function resolveCliBinary(
  command: string,
  options: ResolveCliBinaryOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? os.homedir();
  for (const candidate of expandPathCandidates(command, env, platform, homedir)) {
    if (isExecutableFile(candidate, platform)) {
      return candidate;
    }
  }
  return null;
}

function buildProbeEnv(baseEnv: NodeJS.ProcessEnv, resolvedPath: string): NodeJS.ProcessEnv {
  const dir = path.dirname(resolvedPath);
  const currentPath = baseEnv.PATH ?? baseEnv.Path ?? "";
  const nextPath = currentPath.includes(dir)
    ? currentPath
    : currentPath
      ? `${dir}${path.delimiter}${currentPath}`
      : dir;
  return {
    ...baseEnv,
    PATH: nextPath,
  };
}

/**
 * Safely probes whether `command` exists and optionally extracts `--version` without throwing.
 */
export async function probeCliBinary(
  command: string,
  options: ProbeCliBinaryOptions = {},
): Promise<CliBinaryProbeResult> {
  const env = options.env ?? process.env;
  const resolved = resolveCliBinary(command, {
    env,
    platform: options.platform,
    homedir: options.homedir,
  });
  if (!resolved) {
    return {
      available: false,
      resolvedPath: null,
      version: null,
      detail: `Command "${command}" not found on PATH`,
    };
  }

  const versionArgs = options.versionArgs ?? ["--version"];
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const execFn: ExecFileProbeFn =
    options.execFileFn ??
    (async (file, args, opts) => {
      const res = await execFileAsync(file, [...args], {
        encoding: "utf8",
        timeout: opts.timeout,
        env: opts.env,
        windowsHide: opts.windowsHide ?? true,
      });
      return {
        stdout: String(res.stdout ?? ""),
        stderr: String(res.stderr ?? ""),
      };
    });

  try {
    const out = await execFn(resolved, versionArgs, {
      timeout: timeoutMs,
      env: buildProbeEnv(env, resolved),
      windowsHide: true,
    });
    const rawLine = (out.stdout || out.stderr || "").trim().split(/\r?\n/)[0]?.trim() ?? "";
    const semverMatch = /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/.exec(rawLine);
    const version = semverMatch ? semverMatch[0] : rawLine ? rawLine.slice(0, 64) : null;
    return {
      available: true,
      resolvedPath: resolved,
      version,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      available: true,
      resolvedPath: resolved,
      version: null,
      detail: msg,
    };
  }
}

export interface StdioRpcProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: SpawnProcessFn;
  onMessage?: (msg: Record<string, unknown>) => void;
  onNonJsonLine?: (line: string) => void;
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => void;
}

interface PendingRpcCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Line-buffered UTF-8 JSONL subprocess transport for `codex app-server`, `pi --mode rpc`,
 * and `claude --output-format stream-json`. Enforces `shell: false`, `windowsHide: true`,
 * bounded buffering, immediate pending-call rejection on exit, and OS process-tree cleanup.
 */
export class StdioRpcProcess {
  readonly child: ChildProcess;
  private readonly onMessage: ((msg: Record<string, unknown>) => void) | undefined;
  private readonly onNonJsonLine: ((line: string) => void) | undefined;
  private readonly onExit:
    | ((info: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => void)
    | undefined;
  private readonly pending = new Map<string | number, PendingRpcCall>();
  private readonly stderrBuffer: string[] = [];
  private stdoutBuffer = "";
  private stdoutBytes = 0;
  private nextId = 1;
  private exited = false;
  private closing = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null; error?: Error } | null =
    null;
  private closePromise: Promise<void> | null = null;
  private readonly waitClosedPromise: Promise<void>;
  private resolveWaitClosed!: () => void;

  constructor(options: StdioRpcProcessOptions) {
    this.onMessage = options.onMessage;
    this.onNonJsonLine = options.onNonJsonLine;
    this.onExit = options.onExit;
    this.waitClosedPromise = new Promise<void>((resolve) => {
      this.resolveWaitClosed = resolve;
    });

    const spawnImpl = options.spawnFn ?? spawn;
    this.child = spawnImpl(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      this.handleStdoutChunk(chunk);
    });

    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.pushStderr(chunk);
    });

    this.child.once("error", (err) => {
      const normalized = err instanceof Error ? err : new Error(String(err));
      this.handleTermination(null, null, normalized);
    });

    this.child.once("close", (code, signal) => {
      this.handleTermination(code, signal);
    });

    // Prevent unhandled EPIPE/broken-pipe errors from crashing the daemon when a child exits mid-write.
    this.child.stdin?.on("error", (err) => {
      const normalized = err instanceof Error ? err : new Error(String(err));
      if (!this.exited && !this.closing) {
        this.handleTermination(null, null, normalized);
      }
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get isAlive(): boolean {
    return !this.exited;
  }

  getStderrSummary(): string {
    return this.stderrBuffer.join("\n").trim();
  }

  send(payload: Record<string, unknown>): void {
    if (
      this.exited ||
      !this.child.stdin ||
      this.child.stdin.destroyed ||
      this.child.stdin.writableEnded
    ) {
      throw new Error("Cannot write to closed StdioRpcProcess stdin");
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  respond(id: string | number, result: unknown, opts?: { includeJsonRpcField?: boolean }): void {
    const includeJsonRpc = opts?.includeJsonRpcField ?? true;
    this.send({
      ...(includeJsonRpc ? { jsonrpc: "2.0" } : {}),
      id,
      result,
    });
  }

  request(
    methodOrPayload: string | Record<string, unknown>,
    params?: unknown,
    opts?: {
      id?: string | number;
      timeoutMs?: number;
      includeJsonRpcField?: boolean;
      piEnvelope?: boolean;
    },
  ): Promise<unknown> {
    if (this.exited) {
      return Promise.reject(new Error("StdioRpcProcess has already exited"));
    }

    const id = opts?.id ?? this.nextId++;
    const timeoutMs = opts?.timeoutMs ?? 30_000;

    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const entry = this.pending.get(id);
          if (entry) {
            this.pending.delete(id);
            reject(
              new Error(
                `RPC request (${typeof methodOrPayload === "string" ? methodOrPayload : String(methodOrPayload.type ?? id)}) timed out after ${timeoutMs}ms`,
              ),
            );
          }
        }, timeoutMs);
        timer.unref?.();
      }

      this.pending.set(id, { resolve, reject, timer });

      try {
        if (typeof methodOrPayload === "string") {
          const includeJsonRpc = opts?.includeJsonRpcField ?? true;
          this.send({
            ...(includeJsonRpc ? { jsonrpc: "2.0" } : {}),
            id,
            method: methodOrPayload,
            ...(params !== undefined ? { params } : {}),
          });
        } else {
          this.send({
            ...methodOrPayload,
            id,
          });
        }
      } catch (err) {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          if (entry.timer !== null) {
            clearTimeout(entry.timer);
          }
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  async close(graceMs = 150): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = this.performClose(graceMs);
    return this.closePromise;
  }

  private async performClose(graceMs: number): Promise<void> {
    this.closing = true;
    if (this.exited) {
      await this.waitClosedPromise;
      return;
    }

    try {
      this.child.stdin?.end();
    } catch {
      // Ignore stdin end failures during shutdown.
    }

    if (!this.exited && graceMs > 0) {
      await Promise.race([
        this.waitClosedPromise,
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, graceMs);
          t.unref?.();
        }),
      ]);
    }

    if (!this.exited && this.child.pid) {
      await terminateProcessTree(this.child.pid).catch(() => false);
      await Promise.race([
        this.waitClosedPromise,
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1_500);
          t.unref?.();
        }),
      ]);
    }

    if (!this.exited) {
      this.handleTermination(null, "SIGKILL");
    }
  }

  private pushStderr(chunk: string): void {
    for (const rawLine of chunk.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      this.stderrBuffer.push(trimmed.slice(0, MAX_STDERR_LINE_CHARS));
      if (this.stderrBuffer.length > MAX_STDERR_LINES) {
        this.stderrBuffer.shift();
      }
    }
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    this.stdoutBytes += Buffer.byteLength(chunk, "utf8");
    if (this.stdoutBytes > MAX_LINE_BYTES && !this.stdoutBuffer.includes("\n")) {
      this.stdoutBuffer = "";
      this.stdoutBytes = 0;
      this.handleTermination(
        null,
        null,
        new Error("StdioRpcProcess stdout line exceeded 16 MiB cap"),
      );
      void terminateProcessTree(this.child.pid).catch(() => false);
      return;
    }

    while (true) {
      const nlIndex = this.stdoutBuffer.indexOf("\n");
      if (nlIndex === -1) {
        break;
      }
      const line = this.stdoutBuffer.slice(0, nlIndex).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(nlIndex + 1);
      this.stdoutBytes = Buffer.byteLength(this.stdoutBuffer, "utf8");

      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        this.onNonJsonLine?.(trimmed);
        continue;
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        this.onNonJsonLine?.(trimmed);
        continue;
      }

      const msg = parsed as Record<string, unknown>;
      if (this.tryResolvePending(msg)) {
        continue;
      }

      this.onMessage?.(msg);
    }
  }

  private tryResolvePending(msg: Record<string, unknown>): boolean {
    // Pi RPC response envelope: { id, type: "response", success: boolean, data?, error? }
    if (msg.type === "response" && (typeof msg.id === "string" || typeof msg.id === "number")) {
      const entry = this.pending.get(msg.id);
      if (!entry) {
        return false;
      }
      this.pending.delete(msg.id);
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
      }
      if (msg.success === false) {
        const errMsg =
          typeof msg.error === "string" && msg.error.trim().length > 0
            ? msg.error
            : JSON.stringify(msg.error ?? msg);
        entry.reject(new Error(errMsg));
      } else {
        entry.resolve(msg.data ?? msg);
      }
      return true;
    }

    // Standard JSON-RPC 2.0 or headerless response: { id, result?, error? } (without `method`)
    if (
      (typeof msg.id === "string" || typeof msg.id === "number") &&
      msg.method === undefined &&
      ("result" in msg || "error" in msg)
    ) {
      const entry = this.pending.get(msg.id);
      if (!entry) {
        return false;
      }
      this.pending.delete(msg.id);
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
      }
      if (msg.error !== undefined) {
        const errObj = msg.error as { message?: unknown };
        const errMsg =
          typeof errObj?.message === "string" ? errObj.message : JSON.stringify(msg.error);
        entry.reject(new Error(errMsg));
      } else {
        entry.resolve(msg.result);
      }
      return true;
    }

    return false;
  }

  private handleTermination(
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: Error,
  ): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.exitInfo = { code, signal, ...(error ? { error } : {}) };

    const detail = error
      ? error.message
      : `StdioRpcProcess exited (code=${code ?? "null"}, signal=${signal ?? "null"})${this.stderrBuffer.length > 0 ? `: ${this.stderrBuffer.slice(-3).join(" | ")}` : ""}`;

    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
      }
      entry.reject(new Error(detail));
    }

    this.onExit?.(this.exitInfo);
    this.resolveWaitClosed();
  }
}
