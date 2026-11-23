import { useKilnStore } from "../state/store";
import {
  BoardIcon,
  InboxIcon,
  LedgerIcon,
  PlusIcon,
  UsageIcon,
} from "./Icons";

export function Tabbar() {
  const { store, state } = useKilnStore();
  const { view, tasks } = state;
  const waitingCount = tasks.filter((t) => t.status === "waiting").length;

  return (
    <nav className="tabbar" aria-label="底部导航">
      <button
        type="button"
        data-tab="board"
        className={view === "board" ? "on" : ""}
        onClick={() => store.go("board")}
      >
        <BoardIcon />
        <span>总览</span>
      </button>

      <button
        type="button"
        data-tab="inbox"
        className={view === "inbox" || view === "resolve" ? "on" : ""}
        onClick={() => store.go("inbox")}
      >
        <InboxIcon />
        <span>等你决定</span>
        <b className="tab-badge" id="tabInbox">
          {waitingCount || ""}
        </b>
      </button>

      <button
        type="button"
        data-tab="intake"
        className={`tab-new ${view === "intake" ? "on" : ""}`}
        onClick={() => store.go("intake")}
      >
        <PlusIcon />
        <span>新需求</span>
      </button>

      <button
        type="button"
        data-tab="ledger"
        className={view === "ledger" ? "on" : ""}
        onClick={() => store.go("ledger")}
      >
        <LedgerIcon />
        <span>账本</span>
      </button>

      <button
        type="button"
        data-tab="usage"
        className={view === "usage" ? "on" : ""}
        onClick={() => store.go("usage")}
      >
        <UsageIcon />
        <span>用量</span>
      </button>
    </nav>
  );
}
