import { isProjectSpace, useKilnStore } from "../state/store";
import {
  BoardIcon,
  BrandIcon,
  ConsoleIcon,
  FeedIcon,
  InboxIcon,
  LedgerIcon,
  LineupIcon,
  MoonIcon,
  PinIcon,
  SettingsIcon,
  SunIcon,
  SystemThemeIcon,
  UsageIcon,
} from "./Icons";
import { UsagePanel } from "./UsagePanel";

export function Sidebar() {
  const { store, state } = useKilnStore();
  const { view, tasks, spaces, spaceFilter } = state;

  const parentIds = new Set<string>();
  for (const t of tasks) {
    if (t.parent_id) parentIds.add(t.parent_id);
  }

  const nonCancelledCount = tasks.filter(
    (t) => t.status !== "cancelled" && !parentIds.has(t.id) && t.kind !== "epic",
  ).length;
  const waitingCount = tasks.filter((t) => t.status === "waiting").length;

  const runningBySpace: Record<string, number> = {};
  for (const t of tasks) {
    if (t.status === "running" && !parentIds.has(t.id) && t.kind !== "epic") {
      runningBySpace[t.space] = (runningBySpace[t.space] ?? 0) + 1;
    }
  }

  const spaceIds = Array.from(
    new Set([
      ...Object.keys(spaces),
      ...tasks.map((t) => t.space),
    ]),
  ).sort((a, b) => {
    const pinA = Boolean(spaces[a]?.pinned);
    const pinB = Boolean(spaces[b]?.pinned);
    if (pinA !== pinB) return pinA ? -1 : 1;
    if (a === "local" && b !== "local") return 1;
    if (b === "local" && a !== "local") return -1;
    return a.localeCompare(b);
  });

  return (
    <aside className="side-nav" aria-label="主导航">
      <div className="side-scroll">
        <div className="brand">
          <span className="brand-mark">
            <BrandIcon />
          </span>
          <span className="brand-name">Kiln</span>
          {state.daemonVersion ? (
            <span className="brand-ver mono" title={`Kiln v${state.daemonVersion}`}>
              v{state.daemonVersion}
            </span>
          ) : null}
          <div className="theme-switch" role="radiogroup" aria-label="外观主题">
            <button
              type="button"
              role="radio"
              aria-checked={state.themePreference === "system"}
              aria-label="跟随系统"
              title={`跟随系统（当前：${state.resolvedTheme === "light" ? "浅色" : "深色"}）`}
              className={state.themePreference === "system" ? "on" : ""}
              onClick={() => store.setThemePreference("system")}
            >
              <SystemThemeIcon />
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={state.themePreference === "light"}
              aria-label="浅色主题"
              title="浅色主题"
              className={state.themePreference === "light" ? "on" : ""}
              onClick={() => store.setThemePreference("light")}
            >
              <SunIcon />
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={state.themePreference === "dark"}
              aria-label="深色主题"
              title="深色主题"
              className={state.themePreference === "dark" ? "on" : ""}
              onClick={() => store.setThemePreference("dark")}
            >
              <MoonIcon />
            </button>
          </div>
        </div>

        <button
          type="button"
          className="new-btn"
          onClick={() => store.go("intake")}
        >
          <span>
            新需求
            {state.intakeActiveOpen ? (
              <span
                className="side-live-dot"
                title={
                  state.intakeBusy
                    ? "AI 正在回复"
                    : state.intakeHasUnreadReply
                      ? "有未读立项回复"
                      : "有未完成的立项对话"
                }
              />
            ) : null}
          </span>
          <span className="key">{state.intakeActiveOpen ? "进行中" : "N"}</span>
        </button>

        <div className="nav-label">视图</div>

        <button
          type="button"
          className={`nav-btn ${view === "board" ? "on" : ""}`}
          data-nav="board"
          onClick={() => store.go("board")}
        >
          <span className="nav-l">
            <BoardIcon />
            <span>总览</span>
          </span>
          <span className="nav-count" id="nBoard">
            {nonCancelledCount || ""}
          </span>
        </button>

        <button
          type="button"
          className={`nav-btn ${view === "lineup" ? "on" : ""}`}
          data-nav="lineup"
          onClick={() => store.go("lineup")}
        >
          <span className="nav-l">
            <LineupIcon />
            <span>编排与阵容</span>
          </span>
        </button>

        <button
          type="button"
          className="nav-btn is-disabled"
          disabled
          aria-disabled="true"
          title="Post-MVP 阶段扩展"
        >
          <span className="nav-l">
            <ConsoleIcon />
            <span>执行台</span>
            <span className="nav-tag">M2+</span>
          </span>
        </button>

        <button
          type="button"
          className={`nav-btn ${view === "inbox" || view === "resolve" ? "on" : ""}`}
          data-nav="inbox"
          onClick={() => store.go("inbox")}
        >
          <span className="nav-l">
            <InboxIcon />
            <span>等你决定</span>
          </span>
          <span className="nav-count ask" id="nInbox">
            {waitingCount || ""}
          </span>
        </button>

        <button
          type="button"
          className="nav-btn is-disabled"
          disabled
          aria-disabled="true"
          title="Post-MVP 阶段扩展"
        >
          <span className="nav-l">
            <FeedIcon />
            <span>动态</span>
            <span className="nav-tag">M2+</span>
          </span>
        </button>

        <button
          type="button"
          className={`nav-btn ${view === "usage" ? "on" : ""}`}
          data-nav="usage"
          onClick={() => store.go("usage")}
        >
          <span className="nav-l">
            <UsageIcon />
            <span>用量与费用</span>
          </span>
        </button>

        <button
          type="button"
          className={`nav-btn ${view === "ledger" ? "on" : ""}`}
          data-nav="ledger"
          onClick={() => store.go("ledger")}
        >
          <span className="nav-l">
            <LedgerIcon />
            <span>决策账本</span>
          </span>
        </button>

        <button
          type="button"
          className={`nav-btn ${view === "settings" ? "on" : ""}`}
          data-nav="settings"
          onClick={() => store.go("settings")}
        >
          <span className="nav-l">
            <SettingsIcon />
            <span>设置</span>
          </span>
        </button>

        <div className="side-label-row">
          <div className="nav-label">空间</div>
          <button
            type="button"
            className="side-add-btn"
            aria-label="添加项目空间"
            title="添加项目空间"
            onClick={() => store.openAddSpaceModal(false)}
          >
            +
          </button>
        </div>
        <div id="spaceNav">
          <button
            type="button"
            className={`nav-btn ${spaceFilter === "all" && view === "board" ? "on" : ""}`}
            onClick={() => store.go("board", { space: "all" })}
          >
            <span className="nav-l">
              <span
                className="dot"
                style={{ background: "var(--t3)", margin: "0 5px" }}
              />
              <span>全部</span>
            </span>
            <span className="nav-count" />
          </button>

          {spaceIds.map((spId) => {
            const sp = spaces[spId];
            const label = sp?.name ?? spId;
            const runCount = runningBySpace[spId] ?? 0;
            const canPin = isProjectSpace(sp);
            const isPinned = Boolean(sp?.pinned);
            const isActive = spaceFilter === spId && view === "board";

            return (
              <div
                key={spId}
                className={`space-row ${isActive ? "on" : ""}`}
                data-space-row={spId}
              >
                <button
                  type="button"
                  className="space-main"
                  onClick={() => store.go("board", { space: spId })}
                >
                  <span className="space-glyph" aria-hidden="true">
                    {label.slice(0, 1).toUpperCase()}
                  </span>
                  <span>{label}</span>
                </button>
                {runCount > 0 ? (
                  <span className="space-live">{runCount} 在跑</span>
                ) : null}
                {canPin ? (
                  <button
                    type="button"
                    className={`space-pin ${isPinned ? "pinned" : ""}`}
                    data-space-pin={spId}
                    aria-label={isPinned ? "取消置顶项目" : "置顶项目"}
                    title={isPinned ? "取消置顶" : "置顶项目"}
                    onClick={() => void store.toggleSpacePin(spId)}
                  >
                    <PinIcon />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <UsagePanel />
    </aside>
  );
}
