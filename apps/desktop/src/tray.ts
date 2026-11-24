import fs from "node:fs";
import path from "node:path";
import { Menu, Tray, nativeImage, shell, type MenuItemConstructorOptions } from "electron";
import {
  installCliCommand,
  resolveDesktopVersion,
  runKilnDown,
  spawnKilnUp,
} from "./daemon-client.js";
import {
  formatEngineSubmenuLabel,
  formatInboxMenuLabel,
  formatInstallCliMenuLabel,
  formatStartMenuLabel,
  formatTrayHeader,
  formatTrayMenuStatus,
  formatTrayTitle,
  formatTrayTooltipWithVersion,
  isStartMenuEnabled,
  isTrayStateOnline,
  validateKilndUrl,
  type CliInstallActionState,
  type NormalizedKilndUrl,
  type StartActionState,
  type TrayDisplayState,
  type WorkbenchRoute,
} from "./model.js";
import { destroyMainWindow } from "./window-manager.js";

export interface TrayCoordinator {
  triggerRefresh(): void;
  beginStartKilnd(): boolean;
  finishStartKilnd(error: string | null): void;
  requestShutdown(): void;
  openWorkbench(route?: WorkbenchRoute | null): void;
  quitApp(stopDaemon: boolean): Promise<void>;
}

function resolveTrayIcon(): Electron.NativeImage {
  for (const rel of ["../assets/tray.png", "../../assets/tray.png"]) {
    const candidate = path.resolve(import.meta.dirname, rel);
    if (fs.existsSync(candidate)) {
      const img = nativeImage.createFromPath(candidate);
      if (process.platform === "darwin") {
        img.setTemplateImage(true);
      }
      return img;
    }
  }
  return nativeImage.createEmpty();
}

export class DesktopTrayController {
  private readonly tray: Tray;
  private readonly kilndUrl: NormalizedKilndUrl;
  private readonly appVersion: string;
  private readonly coordinator: TrayCoordinator;
  private currentState: TrayDisplayState = { kind: "offline", reason: null };
  private currentDaemonVersion: string | null = null;
  private installCliState: CliInstallActionState = { kind: "idle" };

  constructor(kilndUrl: NormalizedKilndUrl, coordinator: TrayCoordinator) {
    this.kilndUrl = kilndUrl;
    this.appVersion = resolveDesktopVersion();
    this.coordinator = coordinator;
    this.tray = new Tray(resolveTrayIcon());
    this.render();
  }

  updateDisplay(state: TrayDisplayState, daemonVersion: string | null): void {
    this.currentState = state;
    this.currentDaemonVersion = daemonVersion;
    this.render();
  }

  destroy(): void {
    this.tray.destroy();
  }

  private render(): void {
    const state = this.currentState;
    const online = isTrayStateOnline(state);

    if (process.platform === "darwin") {
      const title = formatTrayTitle(state);
      this.tray.setTitle(title ? ` ${title}` : "");
    }
    this.tray.setToolTip(
      formatTrayTooltipWithVersion(
        state,
        this.kilndUrl.baseUrl,
        this.appVersion,
        this.currentDaemonVersion,
      ),
    );

    const template: MenuItemConstructorOptions[] = [
      {
        label: formatTrayHeader(this.appVersion, this.currentDaemonVersion),
        enabled: false,
      },
      {
        label: formatTrayMenuStatus(state),
        enabled: false,
      },
      { type: "separator" },
      {
        label: "打开工作台",
        accelerator: "CommandOrControl+Shift+K",
        click: () => this.coordinator.openWorkbench(null),
      },
      {
        label: "新建需求",
        click: () => this.coordinator.openWorkbench("intake"),
      },
      {
        label: formatInboxMenuLabel(state),
        click: () => this.coordinator.openWorkbench("inbox"),
      },
      {
        label: "编排与阵容",
        click: () => this.coordinator.openWorkbench("lineup"),
      },
      {
        label: "用量与费用",
        click: () => this.coordinator.openWorkbench("usage"),
      },
      {
        label: "设置…",
        click: () => this.coordinator.openWorkbench("settings"),
      },
      { type: "separator" },
      {
        label: formatEngineSubmenuLabel(state),
        submenu: [
          {
            label: `节点：${this.kilndUrl.host}:${this.kilndUrl.port}`,
            enabled: false,
          },
          {
            label: "刷新状态",
            click: () => this.coordinator.triggerRefresh(),
          },
          {
            label: formatStartMenuLabel(state),
            enabled: isStartMenuEnabled(state),
            click: () => this.handleStartKilnd(),
          },
          {
            label: "重启 kilnd",
            enabled: online,
            click: () => this.handleRestartKilnd(),
          },
          { type: "separator" },
          {
            label: "在默认浏览器打开",
            click: () => this.handleOpenBrowser(),
          },
          {
            label: formatInstallCliMenuLabel(this.installCliState),
            click: () => this.handleInstallCli(),
          },
        ],
      },
      { type: "separator" },
      {
        label: "退出桌面端（保持后台推进）",
        click: () => {
          void this.coordinator.quitApp(false);
        },
      },
      {
        label: "停止后台引擎并完全退出",
        enabled: online,
        click: () => {
          void this.coordinator.quitApp(true);
        },
      },
    ];

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  private handleStartKilnd(): void {
    if (!this.coordinator.beginStartKilnd()) return;
    void spawnKilnUp(this.kilndUrl)
      .then(() => {
        this.coordinator.finishStartKilnd(null);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`kiln-desktop: ${msg}\n`);
        this.coordinator.finishStartKilnd(msg);
      });
  }

  private handleRestartKilnd(): void {
    if (!this.coordinator.beginStartKilnd()) return;
    void runKilnDown()
      .catch((err) => {
        process.stderr.write(
          `kiln-desktop: warning during restart stop: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      })
      .then(() => spawnKilnUp(this.kilndUrl))
      .then(() => {
        this.coordinator.finishStartKilnd(null);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`kiln-desktop: ${msg}\n`);
        this.coordinator.finishStartKilnd(msg);
      });
  }

  private handleOpenBrowser(): void {
    try {
      const validated = validateKilndUrl(this.kilndUrl.baseUrl);
      void shell.openExternal(validated.baseUrl);
    } catch (err) {
      process.stderr.write(
        `kiln-desktop: failed to open browser: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  private handleInstallCli(): void {
    try {
      const outcome = installCliCommand();
      process.stderr.write(
        `kiln-desktop: installed kiln/kl commands into ${outcome.binDir} -> ${outcome.targetDescription} (in_path=${outcome.inPath})\n`,
      );
      this.installCliState = {
        kind: "installed",
        binDir: outcome.displayBinDir,
        inPath: outcome.inPath,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`kiln-desktop: install CLI command failed: ${msg}\n`);
      this.installCliState = { kind: "failed", error: msg };
    }
    this.render();
  }
}

export function setupMacApplicationMenu(
  kilndUrl: NormalizedKilndUrl,
  coordinator: TrayCoordinator,
): void {
  if (process.platform !== "darwin") return;

  const template: MenuItemConstructorOptions[] = [
    {
      label: "Kiln",
      submenu: [
        { role: "about", label: "关于 Kiln" },
        { type: "separator" },
        {
          label: "设置…",
          accelerator: "CommandOrControl+,",
          click: () => coordinator.openWorkbench("settings"),
        },
        { type: "separator" },
        { role: "hide", label: "隐藏 Kiln" },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "全部显示" },
        { type: "separator" },
        {
          label: "退出 Kiln",
          accelerator: "CommandOrControl+Q",
          click: () => {
            void coordinator.quitApp(false);
          },
        },
        {
          label: "停止后台引擎并完全退出",
          accelerator: "Alt+CommandOrControl+Q",
          click: () => {
            void coordinator.quitApp(true);
          },
        },
      ],
    },
    {
      label: "工作台",
      submenu: [
        {
          label: "新建需求",
          accelerator: "CommandOrControl+N",
          click: () => coordinator.openWorkbench("intake"),
        },
        { type: "separator" },
        {
          label: "总览看板",
          accelerator: "CommandOrControl+1",
          click: () => coordinator.openWorkbench("board"),
        },
        {
          label: "编排与阵容",
          accelerator: "CommandOrControl+2",
          click: () => coordinator.openWorkbench("lineup"),
        },
        {
          label: "等你决定",
          accelerator: "CommandOrControl+3",
          click: () => coordinator.openWorkbench("inbox"),
        },
        {
          label: "决策账本",
          accelerator: "CommandOrControl+4",
          click: () => coordinator.openWorkbench("ledger"),
        },
        {
          label: "用量与费用",
          accelerator: "CommandOrControl+5",
          click: () => coordinator.openWorkbench("usage"),
        },
        { type: "separator" },
        {
          label: "在默认浏览器打开",
          click: () => {
            try {
              const validated = validateKilndUrl(kilndUrl.baseUrl);
              void shell.openExternal(validated.baseUrl);
            } catch {
              // Validated at startup
            }
          },
        },
        { role: "close", label: "关闭窗口" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "拷贝" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        { type: "separator" },
        { role: "togglefullscreen", label: "进入全屏幕" },
        { type: "separator" },
        { role: "front", label: "前置全部窗口" },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export { destroyMainWindow };
export type { StartActionState };
