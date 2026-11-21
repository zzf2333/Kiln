import { useEffect, useMemo } from "preact/hooks";
import { CommandPalette } from "./components/CommandPalette";
import { IntakeDock } from "./components/IntakeDock";
import { Sidebar } from "./components/Sidebar";
import { SpaceModal } from "./components/SpaceModal";
import { Tabbar } from "./components/Tabbar";
import { KilnWebStore, StoreContext, useKilnStore } from "./state/store";
import { BoardView } from "./views/BoardView";
import { DetailView } from "./views/DetailView";
import { InboxView } from "./views/InboxView";
import { IntakeView } from "./views/IntakeView";
import { LedgerView } from "./views/LedgerView";
import { RemoteAuthView } from "./views/RemoteAuthView";
import { ResolveView } from "./views/ResolveView";
import { SettingsView } from "./views/SettingsView";
import { UsageView } from "./views/UsageView";

function AppShell() {
  const { store, state } = useKilnStore();

  useEffect(() => {
    document.body.classList.toggle("nav-open", state.navOpen);
  }, [state.navOpen]);

  useEffect(() => {
    document.body.classList.toggle(
      "in-converse",
      state.authChecked &&
        state.authAuthenticated &&
        (state.view === "intake" || state.view === "resolve"),
    );
  }, [state.authChecked, state.authAuthenticated, state.view]);

  useEffect(() => {
    let blurTimer: ReturnType<typeof setTimeout> | null = null;

    const onFocusIn = (e: FocusEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        if (blurTimer) {
          clearTimeout(blurTimer);
          blurTimer = null;
        }
        document.body.classList.add("kb-open");
      }
    };

    const onFocusOut = (): void => {
      blurTimer = setTimeout(() => {
        const active = document.activeElement as HTMLElement | null;
        if (
          !active ||
          (active.tagName !== "INPUT" && active.tagName !== "TEXTAREA")
        ) {
          document.body.classList.remove("kb-open");
        }
      }, 80);
    };

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);

    return () => {
      if (blurTimer) clearTimeout(blurTimer);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.body.classList.remove("nav-open", "in-converse", "kb-open");
    };
  }, []);

  const renderView = () => {
    switch (state.view) {
      case "detail":
        return <DetailView />;
      case "inbox":
        return <InboxView />;
      case "intake":
        return <IntakeView />;
      case "resolve":
        return <ResolveView />;
      case "usage":
        return <UsageView />;
      case "ledger":
        return <LedgerView />;
      case "settings":
        return <SettingsView />;
      case "board":
      default:
        return <BoardView />;
    }
  };

  const renderToast = () => (
    <div
      class={`toast ${state.toastMessage ? "show" : ""}`}
      id="toast"
      role="status"
      aria-live="polite"
    >
      {state.toastMessage ?? ""}
    </div>
  );

  if (!state.authChecked) {
    return (
      <>
        <main class="auth-gate" aria-label="正在连接 Kiln">
          <div class="auth-loading">正在连接 Kiln…</div>
        </main>
        {renderToast()}
      </>
    );
  }

  if (state.authMode === "remote" && !state.authAuthenticated) {
    return (
      <>
        <RemoteAuthView />
        {renderToast()}
      </>
    );
  }

  return (
    <>
      <div class="app">
        <Sidebar />
        {renderView()}
      </div>
      <div
        class="nav-mask"
        onClick={() => store.setNavOpen(false)}
      />
      <Tabbar />
      <IntakeDock />
      <CommandPalette />
      <SpaceModal />
      {renderToast()}
    </>
  );
}

export function App() {
  const store = useMemo(() => new KilnWebStore(), []);

  useEffect(() => {
    return store.start();
  }, [store]);

  return (
    <StoreContext.Provider value={store}>
      <AppShell />
    </StoreContext.Provider>
  );
}
