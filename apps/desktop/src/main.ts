import { app, globalShortcut } from "electron";
import {
  KilndClient,
  resolveBundledUiBuildId,
  resolveDesktopVersion,
  resolveKilndUrl,
  runKilnDown,
  spawnKilnUp,
} from "./daemon-client.js";
import {
  REQUIRED_KILND_API_REVISION,
  applyStartAction,
  decideStartupWindowAction,
  isTrayStateOnline,
  resolveWorkbenchOrigin,
  shouldRestartStaleDaemon,
  type KilnHealth,
  type NormalizedKilndUrl,
  type StartActionState,
  type TrayDisplayState,
  type WorkbenchRoute,
} from "./model.js";
import { DesktopTrayController, setupMacApplicationMenu, type TrayCoordinator } from "./tray.js";
import {
  applyMacDockIcon,
  destroyMainWindow,
  hasMainWindow,
  openOrFocusMainWindow,
  resolveAppIconPath,
} from "./window-manager.js";

app.setName("Kiln");

// Chromium 132+ / Electron 45+ enables SkiaGraphite (Dawn/Metal) on macOS by default,
// which can cause hover repaint flickering and misplaced compositor surfaces on recent macOS releases.
if (process.platform === "darwin" && process.env.KILN_ELECTRON_KEEP_GRAPHITE !== "1") {
  app.commandLine.appendSwitch("disable-features", "SkiaGraphite");
}

const OFFLINE_POLL_INTERVAL_MS = 3_000;
const SSE_DEBOUNCE_MS = 250;
const SSE_HEARTBEAT_INTERVAL_MS = 10_000;
const GLOBAL_WORKBENCH_SHORTCUT = "CommandOrControl+Shift+K";

let kilndUrl: NormalizedKilndUrl;
try {
  kilndUrl = resolveKilndUrl();
} catch (err) {
  process.stderr.write(`kiln-desktop: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}

let workbenchUrl: NormalizedKilndUrl;
try {
  workbenchUrl = resolveWorkbenchOrigin({
    kilndUrl,
    uiDevUrlRaw: process.env.KILN_UI_DEV_URL,
    isPackaged: app.isPackaged,
  });
} catch (err) {
  process.stderr.write(
    `kiln-desktop: invalid KILN_UI_DEV_URL (${err instanceof Error ? err.message : String(err)})\n`,
  );
  process.exit(2);
}
const isUiDevMode = workbenchUrl.baseUrl !== kilndUrl.baseUrl;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.exit(0);
}

class KilnDesktopApp implements TrayCoordinator {
  private readonly client = new KilndClient(kilndUrl);
  private trayController: DesktopTrayController | null = null;
  private startAction: StartActionState = { kind: "idle" };
  private lastEventId: string | null = null;
  private sseAbort: AbortController | null = null;
  private offlineTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private shutdownRequested = false;
  private isOpeningWindow = false;
  private refreshInFlight = false;
  private refreshQueued = false;

  async start(): Promise<void> {
    if (process.platform === "darwin") {
      applyMacDockIcon();
      const aboutIcon = resolveAppIconPath("icon.png");
      app.setAboutPanelOptions({
        applicationName: "Kiln",
        applicationVersion: resolveDesktopVersion(),
        ...(aboutIcon ? { iconPath: aboutIcon } : {}),
      });
      app.dock?.hide();
    }

    this.trayController = new DesktopTrayController(kilndUrl, this);
    setupMacApplicationMenu(kilndUrl, this);

    if (!globalShortcut.register(GLOBAL_WORKBENCH_SHORTCUT, () => this.openWorkbench(null))) {
      process.stderr.write(
        `kiln-desktop: failed to register global shortcut ${GLOBAL_WORKBENCH_SHORTCUT}\n`,
      );
    }

    await this.refreshNow();
    this.openWorkbench(null);
  }

  triggerRefresh(): void {
    this.closeSse();
    if (this.offlineTimer) {
      clearTimeout(this.offlineTimer);
      this.offlineTimer = null;
    }
    void this.refreshNow();
  }

  beginStartKilnd(): boolean {
    if (this.startAction.kind === "starting") return false;
    this.startAction = { kind: "starting" };
    void this.refreshNow();
    return true;
  }

  finishStartKilnd(error: string | null): void {
    this.startAction = error ? { kind: "failed", error } : { kind: "idle" };
    this.triggerRefresh();
  }

  requestShutdown(): void {
    this.shutdownRequested = true;
    this.closeSse();
    if (this.offlineTimer) {
      clearTimeout(this.offlineTimer);
      this.offlineTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  openWorkbench(route?: WorkbenchRoute | null): void {
    if (hasMainWindow()) {
      openOrFocusMainWindow(workbenchUrl, route);
      return;
    }
    if (this.isOpeningWindow) return;
    this.isOpeningWindow = true;

    void this.ensureKilndAndOpen(route).finally(() => {
      this.isOpeningWindow = false;
    });
  }

  async quitApp(stopDaemon: boolean): Promise<void> {
    destroyMainWindow();
    if (stopDaemon) {
      try {
        await runKilnDown();
      } catch (err) {
        process.stderr.write(`kiln-desktop: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    this.requestShutdown();
    this.trayController?.destroy();
    app.exit(0);
  }

  private async ensureKilndAndOpen(route?: WorkbenchRoute | null): Promise<void> {
    let health: KilnHealth | null = null;
    try {
      health = await this.client.fetchHealth();
    } catch {
      health = null;
    }

    let online = health?.ok === true;
    const electronProc = process as NodeJS.Process & { resourcesPath?: string };
    const expectedUiBuildId = isUiDevMode
      ? null
      : resolveBundledUiBuildId({
          resourcesPath: electronProc.resourcesPath ?? null,
        });
    const needsUpgrade =
      health?.ok === true &&
      ((health.apiRevision ?? 0) < REQUIRED_KILND_API_REVISION ||
        (expectedUiBuildId !== null && health.uiBuildId !== expectedUiBuildId));

    if (health?.ok && needsUpgrade) {
      let runningCount = 0;
      try {
        const summary = await this.client.fetchBootstrap();
        runningCount = summary.runningCount;
      } catch {
        runningCount = 0;
      }
      if (
        shouldRestartStaleDaemon(
          health,
          REQUIRED_KILND_API_REVISION,
          runningCount,
          expectedUiBuildId,
        )
      ) {
        process.stderr.write(
          `kiln-desktop: restarting stale kilnd (api_revision=${health.apiRevision ?? 0}, ui_build_id=${health.uiBuildId ?? "none"} -> ${expectedUiBuildId ?? "any"}, runningCount=0)\n`,
        );
        try {
          await runKilnDown();
          online = false;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`kiln-desktop: failed to stop stale kilnd: ${msg}\n`);
        }
      } else {
        process.stderr.write(
          `kiln-desktop: stale kilnd kept running because ${runningCount} task(s) active\n`,
        );
      }
    }

    const action = decideStartupWindowAction(online);
    if (action === "open_immediately") {
      openOrFocusMainWindow(workbenchUrl, route);
      return;
    }

    if (!this.beginStartKilnd()) return;
    try {
      await spawnKilnUp(kilndUrl);
      this.finishStartKilnd(null);
      openOrFocusMainWindow(workbenchUrl, route);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`kiln-desktop: ${msg}\n`);
      this.finishStartKilnd(msg);
    }
  }

  private async refreshNow(): Promise<void> {
    if (this.shutdownRequested) return;
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return;
    }
    this.refreshInFlight = true;
    try {
      const { state: rawState, daemonVersion } = await this.client.probeTraySnapshot();
      if (this.shutdownRequested) return;

      let displayState: TrayDisplayState = rawState;
      if (isTrayStateOnline(rawState)) {
        this.startAction = { kind: "idle" };
      } else {
        displayState = applyStartAction(rawState, this.startAction);
      }

      this.trayController?.updateDisplay(displayState, daemonVersion);

      if (isTrayStateOnline(displayState)) {
        this.ensureSseConnected();
      } else {
        this.closeSse();
        this.scheduleOfflinePoll();
      }
    } finally {
      this.refreshInFlight = false;
      if (this.refreshQueued && !this.shutdownRequested) {
        this.refreshQueued = false;
        void this.refreshNow();
      }
    }
  }

  private scheduleOfflinePoll(): void {
    if (this.shutdownRequested || this.offlineTimer) return;
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = null;
      void this.refreshNow();
    }, OFFLINE_POLL_INTERVAL_MS);
  }

  private ensureSseConnected(): void {
    if (this.shutdownRequested || this.sseAbort) return;
    const ac = new AbortController();
    this.sseAbort = ac;

    this.heartbeatTimer = setInterval(() => {
      void this.client.fetchHealth().catch(() => {
        this.closeSse();
        void this.refreshNow();
      });
    }, SSE_HEARTBEAT_INTERVAL_MS);

    this.client.openSseStream({
      lastEventId: this.lastEventId,
      signal: ac.signal,
      onEvent: (frame) => {
        if (frame.id) this.lastEventId = frame.id;
        if (!this.debounceTimer) {
          this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            void this.refreshNow();
          }, SSE_DEBOUNCE_MS);
        }
      },
      onClose: (reason) => {
        if (this.sseAbort === ac) {
          this.sseAbort = null;
        }
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        if (!this.shutdownRequested && reason !== "aborted") {
          process.stderr.write(`kiln-desktop: ${reason}\n`);
          this.scheduleOfflinePoll();
        }
      },
    });
  }

  private closeSse(): void {
    if (this.sseAbort) {
      this.sseAbort.abort();
      this.sseAbort = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

const desktopApp = new KilnDesktopApp();

app.on("second-instance", () => {
  desktopApp.openWorkbench(null);
});

app.on("window-all-closed", () => {
  // Keep tray/menu-bar shell alive when workbench window is destroyed
});

app.on("activate", () => {
  desktopApp.openWorkbench(null);
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  desktopApp.requestShutdown();
});

void app.whenReady().then(() => desktopApp.start());
