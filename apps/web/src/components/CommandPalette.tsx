import { Dialog } from "radix-ui";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useKilnStore, type MvpView, type SettingsTab } from "../state/store";

interface PaletteAction {
  label: string;
  run: () => void;
}

export function CommandPalette() {
  const { store, state } = useKilnStore();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (state.paletteOpen) {
      setQuery("");
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [state.paletteOpen]);

  useEffect(() => {
    if (!state.paletteOpen) {
      return;
    }
    itemRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, query, state.paletteOpen]);

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
  const items = [
    ...filteredActions.map((a, idx) => ({
      id: `palette-action-${idx}`,
      key: `action:${a.label}`,
      primary: a.label,
      secondary: "跳转",
      secondaryClass: "muted",
      run: a.run,
    })),
    ...filteredTasks.map((t) => ({
      id: `palette-task-${t.id}`,
      key: `task:${t.id}`,
      primary: t.title,
      secondary: t.id,
      secondaryClass: "mono muted",
      run: () => {
        store.setPaletteOpen(false);
        store.openTask(t.id);
      },
    })),
  ];
  const resolvedActiveIndex =
    items.length === 0 ? -1 : Math.min(Math.max(activeIndex, 0), items.length - 1);
  const activeItem = resolvedActiveIndex >= 0 ? items[resolvedActiveIndex] : undefined;
  itemRefs.current.length = items.length;

  const handleInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (items.length === 0) {
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => {
        const cur = Math.min(Math.max(prev, 0), items.length - 1);
        return (cur + 1) % items.length;
      });
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => {
        const cur = Math.min(Math.max(prev, 0), items.length - 1);
        return (cur - 1 + items.length) % items.length;
      });
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(items.length - 1);
      return;
    }
    if (e.key === "Enter" && activeItem) {
      e.preventDefault();
      activeItem.run();
    }
  };

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
              aria-activedescendant={activeItem?.id}
              value={query}
              onChange={(e) => {
                setQuery((e.currentTarget as HTMLInputElement).value);
                setActiveIndex(0);
              }}
              onKeyDown={handleInputKeyDown}
            />
            <div className="palette-list" id="paletteList" role="listbox" aria-label="命令与任务">
              {items.map((item, idx) => {
                const isActive = idx === resolvedActiveIndex;
                return (
                  <button
                    key={item.key}
                    id={item.id}
                    ref={(el) => {
                      itemRefs.current[idx] = el;
                    }}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    className={isActive ? "p-item is-active" : "p-item"}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={item.run}
                  >
                    <span>{item.primary}</span>
                    <span className={item.secondaryClass}>{item.secondary}</span>
                  </button>
                );
              })}
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
