import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, app, nativeImage } from "electron";
import {
  buildWorkbenchUrl,
  isAllowedNavigationUrl,
  validateKilndUrl,
  type NormalizedKilndUrl,
  type WorkbenchRoute,
} from "./model.js";

let mainWindow: BrowserWindow | null = null;
let dockIconApplied = false;

export function resolveAppIconPath(
  iconFile = process.platform === "win32" ? "icon.ico" : "icon.png",
): string | undefined {
  for (const rel of [`../assets/${iconFile}`, `../../assets/${iconFile}`]) {
    const candidate = path.resolve(import.meta.dirname, rel);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function applyMacDockIcon(): void {
  if (process.platform !== "darwin" || dockIconApplied) return;
  const iconPath = resolveAppIconPath("icon.png");
  if (!iconPath) return;
  const img = nativeImage.createFromPath(iconPath);
  if (!img.isEmpty()) {
    app.dock?.setIcon(img);
    dockIconApplied = true;
  }
}

export function hasMainWindow(): boolean {
  return mainWindow !== null && !mainWindow.isDestroyed();
}

export function openOrFocusMainWindow(
  kilndUrl: NormalizedKilndUrl,
  route?: WorkbenchRoute | null,
): void {
  const validated = validateKilndUrl(kilndUrl.baseUrl);
  const targetUrl = buildWorkbenchUrl(validated, route);

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (route) {
      void mainWindow.loadURL(targetUrl).catch((err) => {
        process.stderr.write(
          `kiln-desktop: failed to navigate main window: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    if (process.platform === "darwin") {
      applyMacDockIcon();
      void app.dock?.show();
    }
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const iconPath = resolveAppIconPath();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 390,
    minHeight: 600,
    title: "Kiln",
    show: false,
    center: true,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow = win;

  if (process.platform === "darwin") {
    applyMacDockIcon();
    void app.dock?.show();
  }

  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) {
      win.show();
      win.focus();
    }
  });

  win.webContents.on("will-navigate", (event, nextUrl) => {
    if (!isAllowedNavigationUrl(nextUrl, validated)) {
      event.preventDefault();
    }
  });

  win.webContents.on("will-redirect", (event, nextUrl) => {
    if (!isAllowedNavigationUrl(nextUrl, validated)) {
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
    if (process.platform === "darwin" && BrowserWindow.getAllWindows().length === 0) {
      app.dock?.hide();
    }
  });

  void win.loadURL(targetUrl).catch((err) => {
    process.stderr.write(
      `kiln-desktop: failed to load workbench URL: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  });
}

export function destroyMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
    mainWindow = null;
  }
}
