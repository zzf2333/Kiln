import { spawn } from "node:child_process";
import fs from "node:fs";

const EXPLICIT_SENSITIVE_ENV_VARS = new Set<string>([
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GCP_CREDENTIALS",
  "AZURE_CLIENT_SECRET",
  "DOCKER_PASSWORD",
  "PYPI_API_TOKEN",
  "CARGO_REGISTRY_TOKEN",
  "HOMEBREW_GITHUB_API_TOKEN",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "KILN_RUN_TOKEN",
]);

const SENSITIVE_ENV_NAME_PATTERN =
  /^(?:.*_)?(SECRET|TOKEN|API_KEY|PRIVATE_KEY|PASSWORD|ACCESS_KEY|CREDENTIALS)$/i;

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface RunIsolatedCommandOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  extraSafeEnv?: Record<string, string>;
  signal?: AbortSignal;
}

export interface IsolatedCommandResult {
  exitCode: number;
  timedOut: boolean;
  killedProcessGroup: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  aborted: boolean;
  truncated: boolean;
}

export function isSensitiveEnvVarName(name: string): boolean {
  const upper = name.toUpperCase();
  if (EXPLICIT_SENSITIVE_ENV_VARS.has(upper)) {
    return true;
  }
  return SENSITIVE_ENV_NAME_PATTERN.test(name);
}

/**
 * Produces a credential-stripped environment for isolated gate subprocesses.
 * Removes SSH agent sockets, GitHub/cloud/package tokens, and credential suffixes,
 * and forces `GIT_TERMINAL_PROMPT=0`.
 */
export function buildSanitizedEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  extraSafeEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined || isSensitiveEnvVarName(key)) {
      continue;
    }
    sanitized[key] = value;
  }

  if (extraSafeEnv) {
    for (const [key, value] of Object.entries(extraSafeEnv)) {
      if (isSensitiveEnvVarName(key)) {
        throw new Error(
          `Refusing to inject sensitive environment variable "${key}" via extraSafeEnv`,
        );
      }
      sanitized[key] = value;
    }
  }

  sanitized.GIT_TERMINAL_PROMPT = "0";
  return sanitized;
}

class CappedStreamCollector {
  private readonly stdoutChunks: Buffer[] = [];
  private readonly stderrChunks: Buffer[] = [];
  private totalBytes = 0;
  truncated = false;

  constructor(private readonly maxBytes: number) {}

  pushStdout(chunk: Buffer): void {
    this.pushChunk(this.stdoutChunks, chunk);
  }

  pushStderr(chunk: Buffer): void {
    this.pushChunk(this.stderrChunks, chunk);
  }

  private pushChunk(target: Buffer[], chunk: Buffer): void {
    if (this.totalBytes >= this.maxBytes) {
      if (chunk.length > 0) {
        this.truncated = true;
      }
      return;
    }
    const remaining = this.maxBytes - this.totalBytes;
    if (chunk.length <= remaining) {
      target.push(chunk);
      this.totalBytes += chunk.length;
    } else {
      target.push(chunk.subarray(0, remaining));
      this.totalBytes += remaining;
      this.truncated = true;
    }
  }

  readOutputs(): { stdout: string; stderr: string } {
    return {
      stdout: Buffer.concat(this.stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(this.stderrChunks).toString("utf8"),
    };
  }
}

function killChildProcessGroup(pid: number | undefined): boolean {
  if (pid === undefined || pid <= 0) {
    return false;
  }
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }
}

function resolveExitCode(
  code: number | null,
  signal: NodeJS.Signals | null,
  timedOut: boolean,
  aborted: boolean,
): number {
  if (code !== null) {
    return code;
  }
  if (signal === "SIGKILL") {
    return 137;
  }
  if (signal === "SIGTERM") {
    return 143;
  }
  if (timedOut) {
    return 124;
  }
  if (aborted) {
    return 130;
  }
  return 1;
}

/**
 * Runs a verification command in an isolated detached process group with stripped
 * credentials, bounded output collection, and `-pid` SIGKILL cleanup on timeout/abort.
 */
export function runIsolatedCommand(
  command: string,
  options: RunIsolatedCommandOptions,
): Promise<IsolatedCommandResult> {
  if (typeof command !== "string" || command.trim().length === 0) {
    return Promise.reject(new Error("Command must be a non-empty string"));
  }

  if (!fs.existsSync(options.cwd) || !fs.statSync(options.cwd).isDirectory()) {
    return Promise.reject(new Error(`Working directory does not exist: ${options.cwd}`));
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error(`timeoutMs must be > 0, got ${timeoutMs}`));
  }

  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 0) {
    return Promise.reject(
      new Error(`maxOutputBytes must be a non-negative integer, got ${maxOutputBytes}`),
    );
  }

  if (options.signal?.aborted) {
    return Promise.resolve({
      exitCode: 130,
      timedOut: false,
      killedProcessGroup: false,
      stdout: "",
      stderr: "",
      durationMs: 0,
      aborted: true,
      truncated: false,
    });
  }

  const sanitizedEnv = buildSanitizedEnv(options.env, options.extraSafeEnv);
  const collector = new CappedStreamCollector(maxOutputBytes);
  const startTime = Date.now();

  return new Promise<IsolatedCommandResult>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killedProcessGroup = false;
    let timer: NodeJS.Timeout | undefined;

    const child = spawn(command, {
      cwd: options.cwd,
      env: sanitizedEnv,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const cleanupListeners = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
    };

    const onAbort = (): void => {
      if (settled || aborted) {
        return;
      }
      aborted = true;
      if (killChildProcessGroup(child.pid)) {
        killedProcessGroup = true;
      }
    };

    timer = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      if (killChildProcessGroup(child.pid)) {
        killedProcessGroup = true;
      }
    }, timeoutMs);

    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      collector.pushStdout(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      collector.pushStderr(chunk);
    });

    child.once("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupListeners();
      reject(err);
    });

    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupListeners();
      const durationMs = Math.max(0, Date.now() - startTime);
      const { stdout, stderr } = collector.readOutputs();
      resolve({
        exitCode: resolveExitCode(code, signal, timedOut, aborted),
        timedOut,
        killedProcessGroup,
        stdout,
        stderr,
        durationMs,
        aborted,
        truncated: collector.truncated,
      });
    });
  });
}
