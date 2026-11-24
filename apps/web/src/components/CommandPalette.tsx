import { Dialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { useKilnStore, type MvpView, type SettingsTab } from "../state/store";

interface PaletteAction {
  label: string;
  run: () => void;
}

export function CommandPalette() {
  const { store, state } = useKilnStore();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (state.paletteOpen) {
      setQuery("");
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [state.paletteOpen]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName ?? "";
      const typing =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        Boolean(active?.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        store.setPaletteOpen(!store.getState().paletteOpen);
        return;
      }

      if (!typing && (e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        store.toggleSidebar();
        return;
      }

      if (e.key === "Escape") {
        if (e.defaultPrevented) {
          return;
        }
        const cur = store.getState();
        if (cur.spaceModalOpen) {
          e.preventDefault();
          store.closeSpaceModal();
          return;
        }
        if (cur.paletteOpen) {
          e.preventDefault();
          store.setPaletteOpen(false);
          return;
        }
        if (cur.navOpen) {
          e.preventDefault();
          store.setNavOpen(false);
          return;
        }
        if (cur.view === "resolve" && cur.taskId) {
          e.preventDefault();
          store.openTask(cur.taskId);
          return;
        }
        if (cur.view === "detail" || cur.view === "intake") {
          e.preventDefault();
          store.go("board");
          return;
        }
      }

      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        store.go("intake");
        return;
      }

      if (
        !typing &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        e.key.toLowerCase() === "j" &&
        store.getState().view === "detail"
      ) {
        e.preventDefault();
        store.toggleScriptDrawer();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [store]);

  if (!state.paletteOpen) {
    return null;
  }

  const nav = (view: MvpView, settingsTab?: SettingsTab) => () => {
    store.setPaletteOpen(false);
    store.go(view, settingsTab ? { settingsTab } : undefined);
  };

  const actions: PaletteAction[] = [
    ...(state.view === "detail" && state.taskId
      ? [
          {
            label: "当前任务：开关脚本输出 (J)",
            run: () => {
              store.setPaletteOpen(false);
              store.toggleScriptDrawer();
            },
          },
        ]
      : []),
    { label: "新需求", run: nav("intake") },
    { label: "总览", run: nav("board") },
    { label: "工作流", run: nav("lineup") },
    { label: "等你决定", run: nav("inbox") },
    { label: "用量与费用", run: nav("usage") },
    { label: "决策账本", run: nav("ledger") },
    { label: "设置 · Providers 订阅底座", run: nav("settings", "providers") },
    { label: "设置 · 项目空间", run: nav("settings", "spaces") },
    { label: "设置 · 模型单价", run: nav("settings", "pricing") },
    { label: "设置 · 远程访问", run: nav("settings", "remote") },
    {
      label: "主题 · 跟随系统",
      run: () => {
        store.setThemePreference("system");
        store.setPaletteOpen(false);
      },
    },
    {
      label: "主题 · 浅色模式",
      run: () => {
        store.setThemePreference("light");
        store.setPaletteOpen(false);
      },
    },
    {
      label: "主题 · 深色模式",
      run: () => {
        store.setThemePreference("dark");
        store.setPaletteOpen(false);
      },
    },
  ];

  const q = query.trim().toLowerCase();
  const filteredActions = actions.filter((a) => a.label.toLowerCase().includes(q));
  const filteredTasks = state.tasks.filter(
    (t) =>
      t.status !== "cancelled" &&
      (!q || t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)),
  );

  return (
    <Dialog.Root
      open={state.paletteOpen}
      onOpenChange={(open) => {
        if (!open) {
          store.setPaletteOpen(false);
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="palette-mask open"
          id="paletteMask"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              store.setPaletteOpen(false);
            }
          }}
        >
          <Dialog.Content
            className="palette"
            aria-label="命令面板"
            aria-describedby={undefined}
            onEscapeKeyDown={(e) => {
              e.preventDefault();
              store.setPaletteOpen(false);
            }}
          >
            <Dialog.Title className="sr-only">命令面板</Dialog.Title>
            <input
              ref={inputRef}
              id="paletteInput"
              placeholder="搜索任务或跳转"
              value={query}
              onChange={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
            />
            <div className="palette-list" id="paletteList">
              {filteredActions.map((a) => (
                <button key={a.label} type="button" className="p-item" onClick={a.run}>
                  <span>{a.label}</span>
                  <span className="muted">跳转</span>
                </button>
              ))}
              {filteredTasks.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="p-item"
                  onClick={() => {
                    store.setPaletteOpen(false);
                    store.openTask(t.id);
                  }}
                >
                  <span>{t.title}</span>
                  <span className="mono muted">{t.id}</span>
                </button>
              ))}
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
