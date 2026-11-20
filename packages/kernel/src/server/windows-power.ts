import { createRequire } from "node:module";

/**
 * Win32 `SetThreadExecutionState` flags (`kernel32.dll`).
 * Display sleep is intentionally NOT blocked (no `ES_DISPLAY_REQUIRED`).
 */
export const ES_CONTINUOUS = 0x80000000;
export const ES_SYSTEM_REQUIRED = 0x00000001;

export type AcPowerStatus = "ac" | "battery" | "unknown";

export interface WindowsPowerApi {
  /**
   * Calls Win32 `SetThreadExecutionState(flags)` on the calling persistent thread.
   * Returns previous execution state flags (non-zero on success, 0 on failure).
   */
  setThreadExecutionState(flags: number): number;
  /**
   * Calls Win32 `GetSystemPowerStatus` and maps `ACLineStatus` (`1` -> `"ac"`, `0` -> `"battery"`, else `"unknown"`).
   */
  getAcPowerStatus(): AcPowerStatus;
}

export interface WindowsPowerTimerHandle {
  unref?: () => unknown;
}

export interface WindowsPowerControllerOptions {
  /**
   * Injectable Win32 power API. Defaults to `createDefaultWindowsPowerApi()` on Windows.
   */
  powerApi?: WindowsPowerApi | null;
  /**
   * Polling interval for verifying AC line power when `requireAc` mode is active.
   */
  acPollIntervalMs?: number;
  setIntervalFn?: (cb: () => void, ms: number) => WindowsPowerTimerHandle;
  clearIntervalFn?: (handle: WindowsPowerTimerHandle) => void;
}

export interface WindowsPowerAcquireOptions {
  /**
   * When true, only asserts sleep prevention while AC power is confirmed (`ACLineStatus === 1`).
   * Battery or unknown power status fails closed and immediately releases any assertion.
   */
  requireAc?: boolean;
}

interface BunFfiModule {
  dlopen: (
    path: string,
    symbols: Record<string, { args: readonly string[]; returns: string }>,
  ) => {
    symbols: {
      SetThreadExecutionState: (flags: number) => number;
      GetSystemPowerStatus: (bufPtr: unknown) => number;
    };
  };
  ptr: (buf: Uint8Array) => unknown;
}

const DEFAULT_AC_POLL_INTERVAL_MS = 20_000;
const runtimeRequire = createRequire(import.meta.url);

/**
 * Creates a zero-native Win32 `kernel32.dll` power API using `bun:ffi` directly on the
 * persistent JS main thread (preserving thread affinity with zero child processes or temp DLLs).
 * Returns `null` on non-Windows hosts or runtimes without `bun:ffi`.
 */
export function createDefaultWindowsPowerApi(
  platform: NodeJS.Platform = process.platform,
): WindowsPowerApi | null {
  if (platform !== "win32") {
    return null;
  }
  if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
    return null;
  }

  try {
    const ffi = runtimeRequire("bun:ffi") as BunFfiModule;
    const kernel32 = ffi.dlopen("kernel32.dll", {
      SetThreadExecutionState: { args: ["u32"], returns: "u32" },
      GetSystemPowerStatus: { args: ["ptr"], returns: "i32" },
    });

    return {
      setThreadExecutionState(flags: number): number {
        return Number(kernel32.symbols.SetThreadExecutionState(flags >>> 0));
      },
      getAcPowerStatus(): AcPowerStatus {
        // Win32 SYSTEM_POWER_STATUS is 12 bytes: 4 BYTE fields + 2 DWORD fields.
        const statusBuf = new Uint8Array(12);
        const ok = kernel32.symbols.GetSystemPowerStatus(ffi.ptr(statusBuf));
        if (!ok) {
          return "unknown";
        }
        const acLineStatus = statusBuf[0];
        if (acLineStatus === 1) {
          return "ac";
        }
        if (acLineStatus === 0) {
          return "battery";
        }
        return "unknown";
      },
    };
  } catch {
    return null;
  }
}

/**
 * Thread-affine Windows idle-sleep prevention controller backed by `SetThreadExecutionState`
 * and optional AC-only `GetSystemPowerStatus` gating.
 */
export class WindowsPowerController {
  private readonly powerApi: WindowsPowerApi | null;
  private readonly acPollIntervalMs: number;
  private readonly setIntervalFn: (cb: () => void, ms: number) => WindowsPowerTimerHandle;
  private readonly clearIntervalFn: (handle: WindowsPowerTimerHandle) => void;

  private active = false;
  private requireAcMode = false;
  private acPollTimer: WindowsPowerTimerHandle | null = null;

  constructor(options: WindowsPowerControllerOptions = {}) {
    this.powerApi =
      options.powerApi !== undefined ? options.powerApi : createDefaultWindowsPowerApi();
    this.acPollIntervalMs = options.acPollIntervalMs ?? DEFAULT_AC_POLL_INTERVAL_MS;
    this.setIntervalFn =
      options.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn =
      options.clearIntervalFn ??
      ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  get isActive(): boolean {
    return this.active;
  }

  get isRequireAcMode(): boolean {
    return this.requireAcMode;
  }

  private clearAcPoll(): void {
    if (this.acPollTimer !== null) {
      this.clearIntervalFn(this.acPollTimer);
      this.acPollTimer = null;
    }
  }

  private ensureAcPoll(): void {
    if (this.acPollTimer !== null || !this.powerApi) {
      return;
    }
    const handle = this.setIntervalFn(() => {
      this.refreshAcState();
    }, this.acPollIntervalMs);
    handle.unref?.();
    this.acPollTimer = handle;
  }

  private assertSystemRequired(): boolean {
    if (!this.powerApi) {
      return false;
    }
    if (this.active) {
      return true;
    }
    try {
      const prev = this.powerApi.setThreadExecutionState(
        (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0,
      );
      if (prev !== 0) {
        this.active = true;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private clearAssertionOnly(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    try {
      this.powerApi?.setThreadExecutionState(ES_CONTINUOUS >>> 0);
    } catch {
      // Best-effort release on same thread; OS also clears on process/thread exit.
    }
  }

  /**
   * Acquires Windows idle-sleep prevention (`ES_CONTINUOUS | ES_SYSTEM_REQUIRED`).
   * In `requireAc: true` mode, checks AC status immediately (failing closed on battery/unknown)
   * and monitors AC status periodically to release immediately if unplugged.
   */
  acquire(options: WindowsPowerAcquireOptions = {}): boolean {
    const requireAc = options.requireAc === true;
    this.requireAcMode = requireAc;

    if (!this.powerApi) {
      return false;
    }

    if (!requireAc) {
      this.clearAcPoll();
      return this.assertSystemRequired();
    }

    this.ensureAcPoll();
    return this.refreshAcState();
  }

  /**
   * Re-checks AC power status while in AC-only standby mode.
   */
  refreshAcState(): boolean {
    if (!this.requireAcMode || !this.powerApi) {
      return this.active;
    }

    let powerStatus: AcPowerStatus = "unknown";
    try {
      powerStatus = this.powerApi.getAcPowerStatus();
    } catch {
      powerStatus = "unknown";
    }

    if (powerStatus === "ac") {
      return this.assertSystemRequired();
    }

    this.clearAssertionOnly();
    return false;
  }

  /**
   * Releases any active Windows power assertion (`ES_CONTINUOUS`) and stops AC polling.
   */
  release(): void {
    this.requireAcMode = false;
    this.clearAcPoll();
    this.clearAssertionOnly();
  }
}
