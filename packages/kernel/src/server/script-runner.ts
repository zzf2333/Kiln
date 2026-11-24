import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  RunSpaceScriptResponseSchema,
  extractLocalPreviewUrls,
  type RunSpaceScriptResponse,
} from "@kiln/protocol";

export type SpaceScriptKey = RunSpaceScriptResponse["script"];
import { buildSanitizedEnv, terminateProcessTree } from "../gate/command-runner.js";
import { assertSafeSegment, type KilnStore } from "../store/index.js";
import { ServerHttpError } from "./errors.js";
import type { SseHub } from "./sse.js";

export const MAX_CONCURRENT_SCRIPTS = 8;
export const MAX_RECENT_SCRIPTS = 50;
export const MAX_BUFFERED_LOG_BYTES = 256 * 1024;
export const DEFAULT_SCRIPT_TIMEOUT_MS = 10 * 60_000;
export const DEV_SCRIPT_TIMEOUT_MS = 30 * 60_000;

export interface ScriptCompletionResult {
  scriptRunId: string;
  exitCode: number | null;
  timedOut: boolean;
  stopped: boolean;
  tailOutput: string;
}

export interface ScriptRunSummary {
  scriptRunId: string;
  spaceId: string;
  taskId?: string;
  script: SpaceScriptKey;
  command: string;
  cwd: string;
  running: boolean;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  outputTail: string;
  detectedUrls: string[];
}

interface ActiveScriptEntry {
  summary: ScriptRunSummary;
  child: ChildProcess;
  tailChunks: Buffer[];
  tailBytes: number;
  timedOut: boolean;
  stopped: boolean;
  stopRequested: boolean;
  completion: Promise<ScriptCompletionResult>;
  stopFn: () => Promise<void>;
}

export interface KilnScriptRunnerOptions {
  store: KilnStore;
  sseHub: SseHub;
  defaultTimeoutMs?: number;
  maxConcurrent?: number;
}

/**
 * Zero-`node-pty` streaming runner for structured `space.yaml` scripts
 * (`setup` / `dev` / `test` / `lint` / `deliver`), stripping sensitive env vars,
 * streaming chunks onto `SseHub` (`script.output`), and cleaning up full OS
 * process trees on stop or timeout.
 */
export class KilnScriptRunner {
  private readonly store: KilnStore;
  private readonly sseHub: SseHub;
  private readonly defaultTimeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly active = new Map<string, ActiveScriptEntry>();
  private readonly recent: ScriptRunSummary[] = [];

  constructor(options: KilnScriptRunnerOptions) {
    this.store = options.store;
    this.sseHub = options.sseHub;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
    this.maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_SCRIPTS;
  }

  private resolveScriptTarget(input: {
    spaceId: string;
    scriptKey: SpaceScriptKey;
    taskId?: string;
  }): { command: string; cwd: string; safeSpaceId: string; safeTaskId?: string } {
    const safeSpaceId = assertSafeSegment(input.spaceId, "spaceId");
    const space = this.store.readSpace(safeSpaceId);
    if (!space) {
      throw new ServerHttpError(404, {
        error: "space_not_found",
        spaceId: safeSpaceId,
        message: `Space "${safeSpaceId}" was not found`,
      });
    }

    const command = space.scripts?.[input.scriptKey]?.trim();
    if (!command) {
      throw new ServerHttpError(400, {
        error: "script_not_configured",
        spaceId: safeSpaceId,
        script: input.scriptKey,
        message: `空间 "${safeSpaceId}" 未配置 "${input.scriptKey}" 脚本`,
      });
    }

    let safeTaskId: string | undefined;
    let cwdCandidate: string | undefined;

    if (input.taskId !== undefined) {
      safeTaskId = assertSafeSegment(input.taskId, "taskId");
      if (!fs.existsSync(this.store.paths.cardYaml(safeTaskId))) {
        throw new ServerHttpError(404, {
          error: "task_not_found",
          taskId: safeTaskId,
          message: `Task "${safeTaskId}" was not found`,
        });
      }
      const card = this.store.readTaskCard(safeTaskId);
      if (card.space !== safeSpaceId) {
        throw new ServerHttpError(400, {
          error: "space_mismatch",
          spaceId: safeSpaceId,
          taskId: safeTaskId,
          taskSpace: card.space,
          message: `Task "${safeTaskId}" belongs to space "${card.space}", not "${safeSpaceId}"`,
        });
      }
      const wsDir = this.store.paths.workspaceDir(safeTaskId);
      const worktreeDir = path.join(wsDir, "worktree");
      if (card.workspace_mode === "git_worktree") {
        cwdCandidate = fs.existsSync(worktreeDir) ? worktreeDir : space.repo_path;
      } else if (fs.existsSync(wsDir)) {
        cwdCandidate = wsDir;
      } else {
        cwdCandidate = space.repo_path;
      }
    } else {
      cwdCandidate = space.repo_path;
    }

    if (!cwdCandidate || !fs.existsSync(cwdCandidate) || !fs.statSync(cwdCandidate).isDirectory()) {
      throw new ServerHttpError(400, {
        error: "cwd_not_found",
        spaceId: safeSpaceId,
        cwd: cwdCandidate ?? null,
        message: `Script working directory does not exist: ${String(cwdCandidate ?? "")}`,
      });
    }

    return {
      command,
      cwd: path.resolve(cwdCandidate),
      safeSpaceId,
      ...(safeTaskId !== undefined ? { safeTaskId } : {}),
    };
  }

  private pushTailChunk(entry: ActiveScriptEntry, chunk: Buffer): void {
    entry.tailChunks.push(chunk);
    entry.tailBytes += chunk.length;
    while (entry.tailBytes > MAX_BUFFERED_LOG_BYTES && entry.tailChunks.length > 1) {
      const removed = entry.tailChunks.shift()!;
      entry.tailBytes -= removed.length;
    }
    if (entry.tailBytes > MAX_BUFFERED_LOG_BYTES && entry.tailChunks.length === 1) {
      const only = entry.tailChunks[0]!;
      const sliced = only.subarray(only.length - MAX_BUFFERED_LOG_BYTES);
      entry.tailChunks[0] = sliced;
      entry.tailBytes = sliced.length;
    }
    entry.summary.outputTail = Buffer.concat(entry.tailChunks).toString("utf8");
  }

  private recordRecent(summary: ScriptRunSummary): void {
    this.recent.unshift({ ...summary });
    if (this.recent.length > MAX_RECENT_SCRIPTS) {
      this.recent.length = MAX_RECENT_SCRIPTS;
    }
  }

  /**
   * Starts a configured project script asynchronously and streams output over SSE (`script.output`).
   */
  startScript(input: {
    spaceId: string;
    scriptKey: SpaceScriptKey;
    taskId?: string;
    timeoutMs?: number;
  }): {
    response: RunSpaceScriptResponse;
    completion: Promise<ScriptCompletionResult>;
  } {
    if (this.active.size >= this.maxConcurrent) {
      throw new ServerHttpError(429, {
        error: "too_many_scripts",
        activeCount: this.active.size,
        maxConcurrent: this.maxConcurrent,
        message: `同时运行的项目脚本数已达上限 (${this.maxConcurrent})`,
      });
    }

    const { command, cwd, safeSpaceId, safeTaskId } = this.resolveScriptTarget(input);
    const scriptRunId = `scr-${randomUUID().slice(0, 8)}`;
    const timeoutMs =
      input.timeoutMs ??
      (input.scriptKey === "dev" ? DEV_SCRIPT_TIMEOUT_MS : this.defaultTimeoutMs);
    const startedAt = new Date().toISOString();

    const child = spawn(command, {
      cwd,
      env: buildSanitizedEnv(),
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const summary: ScriptRunSummary = {
      scriptRunId,
      spaceId: safeSpaceId,
      ...(safeTaskId !== undefined ? { taskId: safeTaskId } : {}),
      script: input.scriptKey,
      command,
      cwd,
      running: true,
      exitCode: null,
      startedAt,
      endedAt: null,
      outputTail: "",
      detectedUrls: [],
    };

    let resolveCompletion!: (result: ScriptCompletionResult) => void;
    const completion = new Promise<ScriptCompletionResult>((resolve) => {
      resolveCompletion = resolve;
    });

    let settled = false;
    let killPromise: Promise<boolean> | null = null;
    let timer: NodeJS.Timeout | undefined;

    const triggerKill = (): Promise<boolean> => {
      if (killPromise !== null) {
        return killPromise;
      }
      killPromise = terminateProcessTree(child.pid).catch(() => false);
      return killPromise;
    };

    const entry: ActiveScriptEntry = {
      summary,
      child,
      tailChunks: [],
      tailBytes: 0,
      timedOut: false,
      stopped: false,
      stopRequested: false,
      completion,
      stopFn: async () => {
        if (settled) {
          return;
        }
        entry.stopped = true;
        entry.stopRequested = true;
        await triggerKill();
        await completion;
      },
    };
    this.active.set(scriptRunId, entry);

    const mergeDetectedUrls = (chunkText: string): void => {
      if (entry.summary.detectedUrls.length >= 6) return;
      const found = extractLocalPreviewUrls(chunkText, 6);
      for (const u of found) {
        if (!entry.summary.detectedUrls.includes(u)) {
          entry.summary.detectedUrls.push(u);
          if (entry.summary.detectedUrls.length >= 6) break;
        }
      }
    };

    const publishChunk = (
      stream: "stdout" | "stderr" | "system",
      chunk: string,
      opts: { done?: boolean; exitCode?: number | null } = {},
    ): void => {
      if (stream === "stdout" || stream === "stderr") {
        mergeDetectedUrls(chunk);
      }
      this.sseHub.publish({
        type: "script.output",
        spaceId: safeSpaceId,
        ...(safeTaskId !== undefined ? { taskId: safeTaskId } : {}),
        scriptRunId,
        scriptKey: input.scriptKey,
        stream,
        chunk,
        ...(opts.done !== undefined ? { done: opts.done } : {}),
        ...(opts.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
        ...(entry.summary.detectedUrls.length > 0
          ? { detectedUrls: [...entry.summary.detectedUrls] }
          : {}),
        at: new Date().toISOString(),
      });
    };

    const finalize = (rawExitCode: number | null, detailChunk?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      this.active.delete(scriptRunId);
      const effectiveExitCode =
        rawExitCode !== null ? rawExitCode : entry.timedOut ? 124 : entry.stopped ? 143 : 1;
      entry.summary.running = false;
      entry.summary.exitCode = effectiveExitCode;
      entry.summary.endedAt = new Date().toISOString();
      this.recordRecent(entry.summary);

      const finishMsg =
        detailChunk ??
        (entry.timedOut
          ? `[kiln] script timed out after ${timeoutMs}ms (exit=${effectiveExitCode})`
          : entry.stopped
            ? `[kiln] script stopped by user (exit=${effectiveExitCode})`
            : `[kiln] exited with code ${effectiveExitCode}`);

      publishChunk("system", finishMsg, {
        done: true,
        exitCode: effectiveExitCode,
      });

      resolveCompletion({
        scriptRunId,
        exitCode: effectiveExitCode,
        timedOut: entry.timedOut,
        stopped: entry.stopped,
        tailOutput: entry.summary.outputTail,
      });
    };

    timer = setTimeout(() => {
      if (settled) {
        return;
      }
      entry.timedOut = true;
      void triggerKill();
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (buf: Buffer) => {
      this.pushTailChunk(entry, buf);
      publishChunk("stdout", buf.toString("utf8"));
    });

    child.stderr?.on("data", (buf: Buffer) => {
      this.pushTailChunk(entry, buf);
      publishChunk("stderr", buf.toString("utf8"));
    });

    child.once("error", (err) => {
      const msg = `[kiln] failed to start script: ${err.message}`;
      this.pushTailChunk(entry, Buffer.from(`${msg}\n`, "utf8"));
      finalize(1, msg);
    });

    child.once("close", (code, signal) => {
      const finish = (): void => {
        const finalCode =
          code !== null
            ? code
            : signal === "SIGKILL"
              ? 137
              : signal === "SIGTERM"
                ? 143
                : null;
        finalize(finalCode);
      };
      if (killPromise !== null) {
        void killPromise.finally(finish);
      } else {
        finish();
      }
    });

    const response = RunSpaceScriptResponseSchema.parse({
      ok: true,
      scriptRunId,
      spaceId: safeSpaceId,
      script: input.scriptKey,
      command,
      cwd,
    });

    return { response, completion };
  }

  /**
   * Starts a script and waits for completion (used by orchestrator `setup` hook).
   */
  async runAndWait(input: {
    spaceId: string;
    scriptKey: SpaceScriptKey;
    taskId?: string;
    timeoutMs?: number;
  }): Promise<ScriptCompletionResult> {
    const { completion } = this.startScript(input);
    return await completion;
  }

  /**
   * Stops a running script and its entire child process tree. Returns false if not active.
   */
  async stop(scriptRunId: string): Promise<boolean> {
    const entry = this.active.get(scriptRunId);
    if (!entry) {
      return false;
    }
    await entry.stopFn();
    return true;
  }

  /**
   * Lists active and recently completed script runs, optionally filtered by `spaceId` / `taskId`.
   */
  listRuns(filter?: { spaceId?: string; taskId?: string }): ScriptRunSummary[] {
    const combined: ScriptRunSummary[] = [
      ...Array.from(this.active.values()).map((e) => ({ ...e.summary })),
      ...this.recent.map((r) => ({ ...r })),
    ];
    return combined.filter((item) => {
      if (filter?.spaceId !== undefined && item.spaceId !== filter.spaceId) {
        return false;
      }
      if (filter?.taskId !== undefined && item.taskId !== filter.taskId) {
        return false;
      }
      return true;
    });
  }

  /**
   * Terminates all active script process trees gracefully on daemon shutdown.
   */
  async stopAll(): Promise<void> {
    const entries = Array.from(this.active.values());
    await Promise.all(entries.map((entry) => entry.stopFn().catch(() => {})));
  }
}
