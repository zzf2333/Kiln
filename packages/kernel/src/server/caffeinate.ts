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

export type KeepAwakeMode = "off" | "active_tasks" | "remote_ac_standby";

export interface CaffeinateControllerOptions {
  spawnProcess?: CaffeinateSpawnFn;
  platform?: NodeJS.Platform;
  existsSync?: (filePath: string) => boolean;
  pid?: number;
  caffeinatePath?: string;
}

/**
 * Dynamic sleep prevention controller (`AGENTS.md §4.6`):
 * - When `runningCount > 0`, holds active-task assertion (`/usr/bin/caffeinate -i -w <pid>` on macOS).
 * - When `runningCount === 0` and `remoteKeepAwakeOnAc === true`, holds AC-only standby assertion
 *   (`/usr/bin/caffeinate -s -w <pid>` on macOS; `-s` applies only on AC power so battery sleep is preserved).
 * - When `runningCount === 0` and `remoteKeepAwakeOnAc === false`, terminates the child immediately.
 * - Idempotent across repeated updates; cleanly structured for cross-platform extension.
 */
export class CaffeinateController {
  private readonly spawnProcess: CaffeinateSpawnFn;
  private readonly platform: NodeJS.Platform;
  private readonly existsSync: (filePath: string) => boolean;
  private readonly pid: number;
  private readonly caffeinatePath: string;

  private runningCount = 0;
  private remoteKeepAwakeOnAcEnabled = false;
  private activeMode: KeepAwakeMode = "off";
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

  get remoteKeepAwakeOnAc(): boolean {
    return this.remoteKeepAwakeOnAcEnabled;
  }

  get mode(): KeepAwakeMode {
    return this.activeMode;
  }

  /**
   * Synchronizes the active assertion with the current running leaf task count.
   */
  syncRunningCount(runningCount: number): void {
    if (!Number.isInteger(runningCount) || runningCount < 0) {
      throw new RangeError(
        `runningCount must be a non-negative integer, got: ${String(runningCount)}`,
      );
    }

    this.runningCount = runningCount;
    this.reconcile();
  }

  /**
   * Toggles opt-in AC-only standby sleep prevention for remote mobile access.
   */
  setRemoteKeepAwakeOnAc(enabled: boolean): void {
    this.remoteKeepAwakeOnAcEnabled = Boolean(enabled);
    this.reconcile();
  }

  /**
   * Stops any active sleep-prevention process immediately during daemon shutdown.
   */
  stop(): void {
    this.runningCount = 0;
    this.remoteKeepAwakeOnAcEnabled = false;
    this.reconcile();
  }

  private computeDesiredMode(): KeepAwakeMode {
    if (this.runningCount > 0) {
      return "active_tasks";
    }
    if (this.remoteKeepAwakeOnAcEnabled) {
      return "remote_ac_standby";
    }
    return "off";
  }

  private argsForDarwinMode(mode: Exclude<KeepAwakeMode, "off">): readonly string[] {
    if (mode === "remote_ac_standby") {
      // `-s` prevents system sleep ONLY on AC power; omitting `-i` ensures battery idle sleep still works.
      return ["-s", "-w", String(this.pid)];
    }
    return ["-i", "-w", String(this.pid)];
  }

  private terminateActiveChild(): void {
    if (this.child !== null) {
      const activeChild = this.child;
      this.child = null;
      this.activeMode = "off";
      activeChild.kill("SIGTERM");
    } else {
      this.activeMode = "off";
    }
  }

  private reconcile(): void {
    const desired = this.computeDesiredMode();

    if (desired === "off") {
      this.terminateActiveChild();
      return;
    }

    if (this.child !== null && this.activeMode === desired) {
      return;
    }

    if (this.child !== null) {
      this.terminateActiveChild();
    }

    if (this.platform !== "darwin" || !this.existsSync(this.caffeinatePath)) {
      return;
    }

    const spawned = this.spawnProcess(
      this.caffeinatePath,
      this.argsForDarwinMode(desired),
      { stdio: "ignore" },
    );
    this.child = spawned;
    this.activeMode = desired;

    const clearIfCurrent = (): void => {
      if (this.child === spawned) {
        this.child = null;
        this.activeMode = "off";
      }
    };

    spawned.once("exit", clearIfCurrent);
    spawned.once("error", clearIfCurrent);
    spawned.unref?.();
  }
}
