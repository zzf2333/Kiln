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
    <nav class="tabbar" aria-label="底部导航">
      <button
        type="button"
        data-tab="board"
        class={view === "board" ? "on" : ""}
        onClick={() => store.go("board")}
      >
        <BoardIcon />
        <span>总览</span>
      </button>

      <button
        type="button"
        data-tab="inbox"
        class={view === "inbox" || view === "resolve" ? "on" : ""}
        onClick={() => store.go("inbox")}
      >
        <InboxIcon />
        <span>等你决定</span>
        <b class="tab-badge" id="tabInbox">
          {waitingCount || ""}
        </b>
      </button>

      <button
        type="button"
        data-tab="intake"
        class={`tab-new ${view === "intake" ? "on" : ""}`}
        onClick={() => store.go("intake")}
      >
        <PlusIcon />
        <span>新需求</span>
      </button>

      <button
        type="button"
        data-tab="ledger"
        class={view === "ledger" ? "on" : ""}
        onClick={() => store.go("ledger")}
      >
        <LedgerIcon />
        <span>账本</span>
      </button>

      <button
        type="button"
        data-tab="usage"
        class={view === "usage" ? "on" : ""}
        onClick={() => store.go("usage")}
      >
        <UsageIcon />
        <span>用量</span>
      </button>
    </nav>
  );
}
