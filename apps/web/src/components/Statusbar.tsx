import { useKilnStore } from "../state/store";
import { BrandIcon, SidebarToggleIcon } from "./Icons";
import { UsagePanel } from "./UsagePanel";

export function Statusbar() {
  const { store, state } = useKilnStore();
  const {
    tasks,
    sseStatus,
    networkOffline,
    authMode,
    providerStatuses,
    themePreference,
    resolvedTheme,
    daemonVersion,
    sidebarCollapsed,
  } = state;

  const waitingCount = tasks.filter((t) => t.status === "waiting").length;

  const cooldownProviders = providerStatuses.filter((p) => p.status === "cooldown");
  const isOffline = sseStatus === "reconnecting" || networkOffline;

  const cycleTheme = (): void => {
    const next =
      themePreference === "system"
        ? resolvedTheme === "dark"
          ? "light"
          : "dark"
        : themePreference === "dark"
          ? "light"
          : "system";
    store.setThemePreference(next);
  };

  const themeText =
    themePreference === "system"
      ? `跟随系统(${resolvedTheme === "light" ? "浅" : "深"})`
      : themePreference === "light"
        ? "浅色"
        : "深色";

  return (
    <footer className="statusbar" aria-label="状态栏">
      <button
        type="button"
        className="sb-item sb-brand-btn"
        onClick={() =>
          store.go("settings", {
            settingsTab: authMode === "remote" ? "remote" : "conn",
          })
        }
        title={`后台连接状态：${isOffline ? "正在重连" : authMode === "remote" ? "远程已连接" : "本地已连接"}（点击查看连接与底座设置）`}
      >
        <span className="sb-brand-logo" aria-hidden="true">
          <BrandIcon />
        </span>
        <span
          className={`dot ${isOffline ? "dot-ask" : sseStatus === "connected" ? "dot-ok" : ""}`}
        />
        <span>{isOffline ? "重连中" : authMode === "remote" ? "Kiln 远程" : "Kiln"}</span>
      </button>

      <span className="sb-sep" aria-hidden="true" />

      <UsagePanel />

      {waitingCount > 0 ? (
        <button
          type="button"
          className="sb-item sb-ask"
          onClick={() => store.go("inbox")}
          title="前往待你决定的任务"
        >
          <span className="dot dot-ask" />
          <span>等你决定</span>
          <b>{waitingCount}</b>
        </button>
      ) : null}

      {cooldownProviders.length > 0 ? (
        <button
          type="button"
          className="sb-item sb-ask"
          onClick={() => store.go("lineup")}
          title="前往工作流查看限流冷却中的订阅"
        >
          <span className="dot dot-ask" />
          <span>{cooldownProviders.map((p) => p.label || p.provider_id).join("·")} 429 冷却</span>
        </button>
      ) : null}

      <span className="sb-spacer" />

      <button
        type="button"
        className="sb-item"
        aria-label={sidebarCollapsed ? "展开导航栏" : "收起导航栏"}
        title="切换导航侧栏 (⌘\)"
        onClick={() => store.toggleSidebar()}
      >
        <SidebarToggleIcon />
        <span>{sidebarCollapsed ? "展开导航" : "导航"}</span>
      </button>

      <button type="button" className="sb-item" onClick={cycleTheme} title="切换外观主题">
        <span>{themeText}</span>
      </button>

      {daemonVersion ? <span className="sb-item mono">v{daemonVersion}</span> : null}

      <button
        type="button"
        className="key key-dark sb-cmd-key"
        aria-label="打开命令面板"
        title="打开命令面板 (⌘K)"
        onClick={() => store.setPaletteOpen(true)}
      >
        ⌘K
      </button>
    </footer>
  );
}
