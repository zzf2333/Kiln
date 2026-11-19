import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";

export const CAFFEINATE_BIN_PATH = "/usr/bin/caffeinate";

export interface CaffeinateChildProcess {
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (err: Error) => void): unknown;
  unref?: () => unknown;
}

export type CaffeinateSpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => CaffeinateChildProcess;

export interface CaffeinateControllerOptions {
  spawnProcess?: CaffeinateSpawnFn;
  platform?: NodeJS.Platform;
  existsSync?: (filePath: string) => boolean;
  pid?: number;
  caffeinatePath?: string;
}

/**
 * Dynamic macOS sleep prevention controller (`AGENTS.md §4.6`):
 * - Spawns `/usr/bin/caffeinate -i -w <pid>` only on `0 -> >=1` running task transition.
 * - Immediately terminates the child via `SIGTERM` when running task count returns to `0`.
 * - Idempotent across concurrent/repeated `syncRunningCount` calls.
 */
export class CaffeinateController {
  private readonly spawnProcess: CaffeinateSpawnFn;
  private readonly platform: NodeJS.Platform;
  private readonly existsSync: (filePath: string) => boolean;
  private readonly pid: number;
  private readonly caffeinatePath: string;

  private runningCount = 0;
  private child: CaffeinateChildProcess | null = null;

  constructor(options: CaffeinateControllerOptions = {}) {
    this.spawnProcess =
      options.spawnProcess ??
      ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
    this.platform = options.platform ?? process.platform;
    this.existsSync = options.existsSync ?? fs.existsSync;
    this.pid = options.pid ?? process.pid;
    this.caffeinatePath = options.caffeinatePath ?? CAFFEINATE_BIN_PATH;
  }

  get isActive(): boolean {
    return this.child !== null;
  }

  get currentRunningCount(): number {
    return this.runningCount;
  }

  /**
   * Synchronizes the active `caffeinate` child with the current running leaf task count.
   */
  syncRunningCount(runningCount: number): void {
    if (!Number.isInteger(runningCount) || runningCount < 0) {
      throw new RangeError(
        `runningCount must be a non-negative integer, got: ${String(runningCount)}`,
      );
    }

    this.runningCount = runningCount;

    if (runningCount === 0) {
      if (this.child !== null) {
        const activeChild = this.child;
        this.child = null;
        activeChild.kill("SIGTERM");
      }
      return;
    }

    if (this.child !== null) {
      return;
    }

    if (this.platform !== "darwin" || !this.existsSync(this.caffeinatePath)) {
      return;
    }

    const spawned = this.spawnProcess(
      this.caffeinatePath,
      ["-i", "-w", String(this.pid)],
      { stdio: "ignore" },
    );
    this.child = spawned;

    const clearIfCurrent = (): void => {
      if (this.child === spawned) {
        this.child = null;
      }
    };

    spawned.once("exit", clearIfCurrent);
    spawned.once("error", clearIfCurrent);
    spawned.unref?.();
  }

  /**
   * Stops any active `caffeinate` process immediately during daemon shutdown.
   */
  stop(): void {
    this.syncRunningCount(0);
  }
}
