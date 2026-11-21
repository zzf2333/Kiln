import { useKilnStore } from "../state/store";
import {
  BoardIcon,
  BrandIcon,
  ConsoleIcon,
  FeedIcon,
  InboxIcon,
  LedgerIcon,
  SettingsIcon,
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
  ).sort();

  return (
    <aside class="side-nav" aria-label="主导航">
      <div class="side-scroll">
        <div class="brand">
          <span class="brand-mark">
            <BrandIcon />
          </span>
          <span class="brand-name">Kiln</span>
          {state.daemonVersion ? (
            <span class="brand-ver mono" title={`Kiln v${state.daemonVersion}`}>
              v{state.daemonVersion}
            </span>
          ) : null}
        </div>

        <button
          type="button"
          class="new-btn"
          onClick={() => store.go("intake")}
        >
          <span>
            新需求
            {state.intakeActiveOpen ? (
              <span
                class="side-live-dot"
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
          <span class="key">{state.intakeActiveOpen ? "进行中" : "N"}</span>
        </button>

        <div class="nav-label">视图</div>

        <button
          type="button"
          class={`nav-btn ${view === "board" ? "on" : ""}`}
          data-nav="board"
          onClick={() => store.go("board")}
        >
          <span class="nav-l">
            <BoardIcon />
            <span>总览</span>
          </span>
          <span class="nav-count" id="nBoard">
            {nonCancelledCount || ""}
          </span>
        </button>

        <button
          type="button"
          class="nav-btn is-disabled"
          disabled
          aria-disabled="true"
          title="Post-MVP 阶段扩展"
        >
          <span class="nav-l">
            <ConsoleIcon />
            <span>执行台</span>
            <span class="nav-tag">M2+</span>
          </span>
        </button>

        <button
          type="button"
          class={`nav-btn ${view === "inbox" || view === "resolve" ? "on" : ""}`}
          data-nav="inbox"
          onClick={() => store.go("inbox")}
        >
          <span class="nav-l">
            <InboxIcon />
            <span>等你决定</span>
          </span>
          <span class="nav-count ask" id="nInbox">
            {waitingCount || ""}
          </span>
        </button>

        <button
          type="button"
          class="nav-btn is-disabled"
          disabled
          aria-disabled="true"
          title="Post-MVP 阶段扩展"
        >
          <span class="nav-l">
            <FeedIcon />
            <span>动态</span>
            <span class="nav-tag">M2+</span>
          </span>
        </button>

        <button
          type="button"
          class={`nav-btn ${view === "usage" ? "on" : ""}`}
          data-nav="usage"
          onClick={() => store.go("usage")}
        >
          <span class="nav-l">
            <UsageIcon />
            <span>用量与费用</span>
          </span>
        </button>

        <button
          type="button"
          class={`nav-btn ${view === "ledger" ? "on" : ""}`}
          data-nav="ledger"
          onClick={() => store.go("ledger")}
        >
          <span class="nav-l">
            <LedgerIcon />
            <span>决策账本</span>
          </span>
        </button>

        <button
          type="button"
          class={`nav-btn ${view === "settings" ? "on" : ""}`}
          data-nav="settings"
          onClick={() => store.go("settings")}
        >
          <span class="nav-l">
            <SettingsIcon />
            <span>设置</span>
          </span>
        </button>

        <div class="side-label-row">
          <div class="nav-label">空间</div>
          <button
            type="button"
            class="side-add-btn"
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
            class={`nav-btn ${spaceFilter === "all" && view === "board" ? "on" : ""}`}
            onClick={() => store.go("board", { space: "all" })}
          >
            <span class="nav-l">
              <span
                class="dot"
                style={{ background: "var(--t3)", margin: "0 5px" }}
              />
              <span>全部</span>
            </span>
            <span class="nav-count" />
          </button>

          {spaceIds.map((spId) => {
            const label = spaces[spId]?.name ?? spId;
            const runCount = runningBySpace[spId] ?? 0;
            return (
              <button
                key={spId}
                type="button"
                class={`nav-btn ${spaceFilter === spId && view === "board" ? "on" : ""}`}
                onClick={() => store.go("board", { space: spId })}
              >
                <span class="nav-l">
                  <span
                    class="dot"
                    style={{
                      background: runCount ? "var(--ember-2)" : "var(--line-2)",
                      margin: "0 5px",
                    }}
                  />
                  <span>{label}</span>
                </span>
                <span class="nav-count">
                  {runCount > 0 ? `${runCount} 在跑` : ""}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <UsagePanel />
    </aside>
  );
}
