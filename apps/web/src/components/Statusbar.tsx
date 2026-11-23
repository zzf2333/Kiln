import { useKilnStore } from "../state/store";
import { SidebarToggleIcon } from "./Icons";

export function Statusbar() {
  const { store, state } = useKilnStore();
  const {
    tasks,
    limits,
    ratesByTask,
    liveTotals,
    sseStatus,
    networkOffline,
    authMode,
    providerStatuses,
    themePreference,
    resolvedTheme,
    daemonVersion,
    sidebarCollapsed,
  } = state;

  const parentIds = new Set<string>();
  for (const t of tasks) {
    if (t.parent_id) parentIds.add(t.parent_id);
  }
  const runningCount = tasks.filter(
    (t) => t.status === "running" && !parentIds.has(t.id) && t.kind !== "epic",
  ).length;
  const waitingCount = tasks.filter((t) => t.status === "waiting").length;

  const ratesSum = Object.values(ratesByTask).reduce(
    (sum, r) => sum + (Number.isFinite(r) ? r : 0),
    0,
  );
  const totalRate = Math.round(
    Object.keys(ratesByTask).length > 0 ? ratesSum : (liveTotals?.tokPerSec ?? 0),
  );
  const heatPct = totalRate > 0 ? Math.min(100, Math.max(8, Math.round((totalRate / 600) * 100))) : 0;

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
        className="sb-item"
        onClick={() =>
          store.go("settings", {
            settingsTab: authMode === "remote" ? "remote" : "conn",
          })
        }
        title="查看连接与底座状态"
      >
        <span
          className={`dot ${isOffline ? "dot-ask" : sseStatus === "connected" ? "dot-ok" : ""}`}
        />
        <span>
          kilnd {isOffline ? "重连中" : authMode === "remote" ? "远程" : "本机"}
        </span>
      </button>

      <span className="sb-sep" aria-hidden="true" />

      <button
        type="button"
        className="sb-item"
        onClick={() => store.go("board")}
        title="查看看板任务"
      >
        <span>执行槽</span>
        <b>
          {runningCount}/{limits.max_concurrent_slots}
        </b>
      </button>

      <button
        type="button"
        className="sb-item"
        onClick={() => store.go("usage")}
        title="查看用量与速率详情"
      >
        <span className="furnace" aria-hidden="true">
          <span className="furnace-bar" style={{ width: `${heatPct}%` }} />
        </span>
        <b>{totalRate} tok/s</b>
      </button>

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
          title="查看限流冷却中的订阅"
        >
          <span className="dot dot-ask" />
          <span>
            {cooldownProviders.map((p) => p.label || p.provider_id).join("·")} 429 冷却
          </span>
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

      <button
        type="button"
        className="sb-item"
        onClick={cycleTheme}
        title="切换外观主题"
      >
        <span>{themeText}</span>
      </button>

      {daemonVersion ? (
        <span className="sb-item mono">v{daemonVersion}</span>
      ) : null}
    </footer>
  );
}
