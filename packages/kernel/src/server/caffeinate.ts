import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import {
  WindowsPowerController,
  type WindowsPowerApi,
} from "./windows-power.js";

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
  windowsPower?: WindowsPowerController;
  windowsPowerApi?: WindowsPowerApi | null;
}

/**
 * Dynamic cross-platform sleep prevention controller (`AGENTS.md §4.6`):
 * - macOS (`darwin`): spawns `/usr/bin/caffeinate -i -w <pid>` on `0 -> >=1` running tasks,
 *   terminates immediately via `SIGTERM` when count returns to `0`.
 * - Windows (`win32`): acquires/releases Win32 `SetThreadExecutionState` via `WindowsPowerController`.
 * - Idempotent across concurrent/repeated `syncRunningCount` calls.
 */
export class CaffeinateController {
  private readonly spawnProcess: CaffeinateSpawnFn;
  private readonly platform: NodeJS.Platform;
  private readonly existsSync: (filePath: string) => boolean;
  private readonly pid: number;
  private readonly caffeinatePath: string;
  private readonly windowsPower: WindowsPowerController;

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
    this.windowsPower =
      options.windowsPower ??
      new WindowsPowerController(
        options.windowsPowerApi !== undefined
          ? { powerApi: options.windowsPowerApi }
          : this.platform === "win32"
            ? {}
            : { powerApi: null },
      );
  }

  get isActive(): boolean {
    return this.child !== null || this.windowsPower.isActive;
  }

  get currentRunningCount(): number {
    return this.runningCount;
  }

  /**
   * Synchronizes active OS sleep prevention with the current running leaf task count.
   */
  syncRunningCount(runningCount: number): void {
    if (!Number.isInteger(runningCount) || runningCount < 0) {
      throw new RangeError(
        `runningCount must be a non-negative integer, got: ${String(runningCount)}`,
      );
    }

    this.runningCount = runningCount;

    if (this.platform === "win32") {
      if (runningCount === 0) {
        this.windowsPower.release();
      } else {
        this.windowsPower.acquire({ requireAc: false });
      }
      return;
    }

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
   * Stops any active sleep prevention process or assertion immediately during daemon shutdown.
   */
  stop(): void {
    this.syncRunningCount(0);
    this.windowsPower.release();
  }
}
