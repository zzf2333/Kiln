import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { fetchChatCommands, fetchSpaceFiles } from "../api/client";
import type { ChatCommandAction, ChatCommandItem, SpaceFileEntry } from "../api/types";
import { useKilnStore } from "../state/store";

export interface ComposerTrigger {
  kind: "/" | "@";
  start: number;
  end: number;
  query: string;
}

export function detectComposerTrigger(
  text: string,
  rawCaret: number,
): ComposerTrigger | null {
  const caret = Math.max(0, Math.min(text.length, rawCaret));
  let tokenStart = caret;
  while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1]!)) {
    tokenStart -= 1;
  }
  const token = text.slice(tokenStart, caret);
  if (token.startsWith("/")) {
    // Slash commands only trigger when "/" starts the first non-whitespace token of the message.
    if (text.slice(0, tokenStart).trim().length === 0) {
      return {
        kind: "/",
        start: tokenStart,
        end: caret,
        query: token.slice(1),
      };
    }
    return null;
  }
  if (token.startsWith("@")) {
    if (tokenStart === 0 || /\s/.test(text[tokenStart - 1]!)) {
      return {
        kind: "@",
        start: tokenStart,
        end: caret,
        query: token.slice(1),
      };
    }
    return null;
  }
  return null;
}

const FALLBACK_KILN_COMMANDS: Record<"intake" | "resolver", ChatCommandItem[]> = {
  intake: [
    {
      name: "brief",
      description: "生成或更新右侧《产品方案 (BRIEF.md)》并同步立项契约",
      argumentHint: "[补充说明]",
      kind: "command",
      source: "kiln",
      action: "generate_brief",
    },
    {
      name: "fill",
      description: "让立项助手自动补全剩余缺失的立项字段",
      argumentHint: "[补充要求]",
      kind: "command",
      source: "kiln",
      action: "fill_draft",
    },
    {
      name: "split",
      description: "评估需求体量并建议垂直 MVP 切片拆分方案",
      argumentHint: "[拆分偏好]",
      kind: "command",
      source: "kiln",
      action: "split_slices",
    },
    {
      name: "new",
      description: "清空当前立项对话并开始新草稿（本地操作，不消耗 Token）",
      argumentHint: "",
      kind: "command",
      source: "kiln",
      action: "new_draft",
    },
  ],
  resolver: [
    {
      name: "summary",
      description: "梳理当前待决分歧、备选方案利弊与推荐决策",
      argumentHint: "",
      kind: "command",
      source: "kiln",
    },
    {
      name: "contract",
      description: "基于当前讨论生成需要修订的契约字段方案",
      argumentHint: "[修订说明]",
      kind: "command",
      source: "kiln",
    },
  ],
};

interface MentionPopupItem {
  key: string;
  insertValue: string;
  displayLabel: string;
  category: "file" | "dir" | "task" | "ledger";
  meta: string;
  badge: string;
}

type PopupEntry =
  | {
      type: "command";
      key: string;
      item: ChatCommandItem;
    }
  | {
      type: "mention";
      key: string;
      item: MentionPopupItem;
    };

function scoreFuzzyMatch(candidate: string, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const target = candidate.toLowerCase();
  if (target === q) return 0;
  if (target.startsWith(q)) return 10 + target.length * 0.001;
  const idx = target.indexOf(q);
  if (idx !== -1) return 20 + idx * 0.01 + target.length * 0.001;
  let qi = 0;
  let gap = 0;
  for (let ti = 0; ti < target.length && qi < q.length; ti += 1) {
    if (target[ti] === q[qi]) {
      qi += 1;
    } else if (qi > 0) {
      gap += 1;
    }
  }
  if (qi === q.length) {
    return 100 + gap + target.length * 0.001;
  }
  return null;
}

export interface ChatComposerProps {
  id?: string;
  role: "intake" | "resolver";
  spaceId: string;
  isProjectSpace: boolean;
  draftId?: string | null;
  taskId?: string | null;
  value: string;
  disabled: boolean;
  placeholder: string;
  onChange: (nextValue: string) => void;
  onSend: (textToSend?: string) => void;
  onClientCommand?: (action: ChatCommandAction) => boolean;
}

export function ChatComposer({
  id = "chatIn",
  role,
  spaceId,
  isProjectSpace,
  draftId,
  taskId,
  value,
  disabled,
  placeholder,
  onChange,
  onSend,
  onClientCommand,
}: ChatComposerProps) {
  const { state } = useKilnStore();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const popupListRef = useRef<HTMLDivElement | null>(null);
  const commandsCacheRef = useRef<Map<string, ChatCommandItem[]>>(new Map());
  const fileReqSeqRef = useRef(0);
  const composingRef = useRef(false);

  const [caretPos, setCaretPos] = useState(value.length);
  const [dismissedAnchor, setDismissedAnchor] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const activeRoleAssignment = state.roles.roles[role];
  const activeAgent = activeRoleAssignment?.agent ?? "";
  const activeModel = activeRoleAssignment?.model ?? "";

  const [commands, setCommands] = useState<ChatCommandItem[]>(
    () => FALLBACK_KILN_COMMANDS[role],
  );
  const [commandsAgent, setCommandsAgent] = useState<string | null>(
    activeAgent || null,
  );
  const [commandsLoading, setCommandsLoading] = useState(false);

  const [spaceFiles, setSpaceFiles] = useState<SpaceFileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

  const commandCacheKey = `${role}|${spaceId}|${draftId ?? ""}|${taskId ?? ""}|${activeAgent}|${activeModel}`;

  useEffect(() => {
    const cached = commandsCacheRef.current.get(commandCacheKey);
    if (cached) {
      setCommands(cached);
      setCommandsAgent(activeAgent || null);
      return;
    }

    let cancelled = false;
    setCommands(FALLBACK_KILN_COMMANDS[role]);
    setCommandsLoading(true);
    void fetchChatCommands({
      role,
      ...(spaceId ? { spaceId } : {}),
      ...(draftId ? { draftId } : {}),
      ...(taskId ? { taskId } : {}),
    })
      .then((res) => {
        if (cancelled) return;
        const list =
          Array.isArray(res.commands) && res.commands.length > 0
            ? res.commands
            : FALLBACK_KILN_COMMANDS[role];
        commandsCacheRef.current.set(commandCacheKey, list);
        setCommands(list);
        setCommandsAgent(res.agent ?? (activeAgent || null));
      })
      .catch(() => {
        if (cancelled) return;
        setCommands(FALLBACK_KILN_COMMANDS[role]);
      })
      .finally(() => {
        if (!cancelled) {
          setCommandsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [commandCacheKey, role, spaceId, draftId, taskId, activeAgent]);

  const rawTrigger = useMemo(
    () => detectComposerTrigger(value, caretPos),
    [value, caretPos],
  );
  const currentAnchor = rawTrigger ? `${rawTrigger.kind}:${rawTrigger.start}` : null;
  const trigger =
    rawTrigger && currentAnchor !== dismissedAnchor ? rawTrigger : null;

  useEffect(() => {
    if (!rawTrigger || currentAnchor !== dismissedAnchor) {
      if (dismissedAnchor !== null && currentAnchor !== dismissedAnchor) {
        setDismissedAnchor(null);
      }
    }
  }, [rawTrigger, currentAnchor, dismissedAnchor]);

  const mentionQuery = trigger?.kind === "@" ? trigger.query : "";
  const isMentionActive = trigger?.kind === "@";

  useEffect(() => {
    if (!isMentionActive || !isProjectSpace || !spaceId || spaceId === "local") {
      setSpaceFiles([]);
      setFilesLoading(false);
      return;
    }

    const seq = ++fileReqSeqRef.current;
    setFilesLoading(true);
    const timer = setTimeout(() => {
      void fetchSpaceFiles(spaceId, mentionQuery, 24)
        .then((res) => {
          if (seq !== fileReqSeqRef.current) return;
          setSpaceFiles(Array.isArray(res.files) ? res.files : []);
        })
        .catch(() => {
          if (seq !== fileReqSeqRef.current) return;
          setSpaceFiles([]);
        })
        .finally(() => {
          if (seq === fileReqSeqRef.current) {
            setFilesLoading(false);
          }
        });
    }, 120);

    return () => {
      clearTimeout(timer);
    };
  }, [isMentionActive, isProjectSpace, spaceId, mentionQuery]);

  const filteredCommands = useMemo<ChatCommandItem[]>(() => {
    if (!trigger || trigger.kind !== "/") return [];
    const q = trigger.query.trim();
    if (!q) {
      return [
        ...commands.filter((c) => c.source === "kiln"),
        ...commands.filter((c) => c.source === "agent"),
      ];
    }
    const scored: Array<{ score: number; cmd: ChatCommandItem }> = [];
    for (const cmd of commands) {
      const nameScore = scoreFuzzyMatch(cmd.name, q);
      const descScore = scoreFuzzyMatch(cmd.description, q);
      const best =
        nameScore !== null
          ? nameScore
          : descScore !== null
            ? descScore + 200
            : null;
      if (best !== null) {
        scored.push({ score: best, cmd });
      }
    }
    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.cmd.source !== b.cmd.source) {
        return a.cmd.source === "kiln" ? -1 : 1;
      }
      return a.cmd.name.localeCompare(b.cmd.name);
    });
    return scored.slice(0, 32).map((s) => s.cmd);
  }, [trigger, commands]);

  const filteredMentions = useMemo<MentionPopupItem[]>(() => {
    if (!trigger || trigger.kind !== "@") return [];
    const q = trigger.query.trim();

    const fileEntries: MentionPopupItem[] = spaceFiles.map((f) => ({
      key: `${f.kind}:${f.path}`,
      insertValue: f.path,
      displayLabel: f.path,
      category: f.kind,
      meta: f.kind === "dir" ? "目录" : "文件",
      badge: f.kind === "dir" ? "DIR" : "FILE",
    }));

    const taskEntries: MentionPopupItem[] = state.tasks
      .filter((t) => t.status !== "cancelled")
      .slice(0, 40)
      .map((t) => ({
        key: `task:${t.id}`,
        insertValue: `task:${t.id}`,
        displayLabel: `@task:${t.id}`,
        category: "task",
        meta: `${t.title} · ${t.status}`,
        badge: "TASK",
      }));

    const ledgerEntries: MentionPopupItem[] = Object.entries(state.ledgers)
      .filter(([, entries]) => entries.length > 0)
      .map(([spId, entries]) => ({
        key: `ledger:${spId}`,
        insertValue: `ledger:${spId}`,
        displayLabel: `@ledger:${spId}`,
        category: "ledger",
        meta: `${state.spaces[spId]?.name ?? spId} · ${entries.length} 条约束`,
        badge: "RULE",
      }));

    const combined = [...fileEntries, ...taskEntries, ...ledgerEntries];
    if (!q) {
      return combined.slice(0, 28);
    }

    const scored: Array<{ score: number; item: MentionPopupItem }> = [];
    for (const item of combined) {
      const s1 = scoreFuzzyMatch(item.insertValue, q);
      const s2 = scoreFuzzyMatch(item.meta, q);
      const best =
        s1 !== null ? s1 : s2 !== null ? s2 + 120 : null;
      if (best !== null) {
        scored.push({ score: best, item });
      }
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, 28).map((s) => s.item);
  }, [trigger, spaceFiles, state.tasks, state.ledgers, state.spaces]);

  const entries = useMemo<PopupEntry[]>(() => {
    if (!trigger) return [];
    if (trigger.kind === "/") {
      return filteredCommands.map((item) => ({
        type: "command",
        key: `${item.source}:${item.name}`,
        item,
      }));
    }
    return filteredMentions.map((item) => ({
      type: "mention",
      key: item.key,
      item,
    }));
  }, [trigger, filteredCommands, filteredMentions]);

  useEffect(() => {
    setActiveIndex(0);
  }, [trigger?.kind, trigger?.start, trigger?.query, entries.length]);

  useEffect(() => {
    const listEl = popupListRef.current;
    if (!listEl) return;
    const activeEl = listEl.querySelector<HTMLElement>(
      `[data-popup-idx="${activeIndex}"]`,
    );
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const syncCaretFromTarget = (el: HTMLTextAreaElement): void => {
    setCaretPos(el.selectionStart ?? el.value.length);
  };

  const applySelection = (entry: PopupEntry): void => {
    if (!trigger) return;
    if (entry.type === "command" && entry.item.action === "new_draft") {
      if (onClientCommand?.("new_draft")) {
        onChange("");
        setCaretPos(0);
        setDismissedAnchor(null);
        return;
      }
    }

    const insertText =
      entry.type === "command"
        ? `/${entry.item.name} `
        : `@${entry.item.insertValue} `;

    const before = value.slice(0, trigger.start);
    const after = value.slice(trigger.end).replace(/^\s/, "");
    const nextValue = `${before}${insertText}${after}`;
    const nextCaret = before.length + insertText.length;

    onChange(nextValue);
    setCaretPos(nextCaret);
    setDismissedAnchor(null);

    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange?.(nextCaret, nextCaret);
        }
      });
    }
  };

  const showPopup =
    !disabled &&
    trigger !== null &&
    (entries.length > 0 ||
      (trigger.kind === "@" && (filesLoading || !isProjectSpace || trigger.query.length > 0)) ||
      (trigger.kind === "/" && (commandsLoading || trigger.query.length > 0)));

  const kilnCommandEntries = useMemo(
    () =>
      entries
        .map((e, idx) => ({ e, idx }))
        .filter((x) => x.e.type === "command" && x.e.item.source === "kiln"),
    [entries],
  );
  const agentCommandEntries = useMemo(
    () =>
      entries
        .map((e, idx) => ({ e, idx }))
        .filter((x) => x.e.type === "command" && x.e.item.source === "agent"),
    [entries],
  );

  const renderCommandRow = (entry: PopupEntry & { type: "command" }, idx: number) => {
    const isSelected = idx === activeIndex;
    const badgeLabel =
      entry.item.source === "kiln"
        ? "Kiln"
        : entry.item.kind === "skill"
          ? "技能"
          : "命令";
    const badgeClass =
      entry.item.source === "kiln"
        ? "is-kiln"
        : entry.item.kind === "skill"
          ? "is-skill"
          : "is-cmd";
    return (
      <button
        key={entry.key}
        type="button"
        role="option"
        aria-selected={isSelected}
        data-popup-idx={idx}
        class={`composer-popup-item ${isSelected ? "is-active" : ""}`}
        title={entry.item.description}
        onMouseEnter={() => setActiveIndex(idx)}
        onMouseDown={(e) => {
          e.preventDefault();
          applySelection(entry);
        }}
      >
        <div class="composer-popup-main">
          <span class="composer-popup-name mono">/{entry.item.name}</span>
          {entry.item.argumentHint ? (
            <span class="composer-popup-hint mono">{entry.item.argumentHint}</span>
          ) : null}
          <span class={`composer-popup-badge ${badgeClass}`}>{badgeLabel}</span>
        </div>
        <div class="composer-popup-desc">{entry.item.description}</div>
      </button>
    );
  };

  return (
    <div class="composer">
      <div class="composer-stack">
        <div class="composer-inner">
          {showPopup ? (
            <div
              class="composer-popup"
              role="listbox"
              aria-label={
                trigger?.kind === "/" ? "命令与技能补全" : "引用文件、任务或账本"
              }
            >
              <div class="composer-popup-head">
                <span>
                  {trigger?.kind === "/"
                    ? `斜杠命令与技能${commandsAgent ? ` · ${commandsAgent}` : ""}`
                    : "引用上下文 (@文件 / @task / @ledger)"}
                </span>
                <span class="mono muted">
                  ↑↓ 选择 · Tab/Enter 插入 · Esc 关闭
                </span>
              </div>

              <div class="composer-popup-list" ref={popupListRef}>
                {trigger?.kind === "/" ? (
                  entries.length > 0 ? (
                    trigger.query.trim().length > 0 ? (
                      entries.map((entry, idx) =>
                        entry.type === "command" ? renderCommandRow(entry, idx) : null,
                      )
                    ) : (
                      <>
                        {kilnCommandEntries.length > 0 ? (
                          <>
                            <div class="composer-popup-group">Kiln 快捷指令</div>
                            {kilnCommandEntries.map(({ e, idx }) =>
                              renderCommandRow(
                                e as PopupEntry & { type: "command" },
                                idx,
                              ),
                            )}
                          </>
                        ) : null}
                        {agentCommandEntries.length > 0 ? (
                          <>
                            <div class="composer-popup-group">Agent 命令与技能</div>
                            {agentCommandEntries.map(({ e, idx }) =>
                              renderCommandRow(
                                e as PopupEntry & { type: "command" },
                                idx,
                              ),
                            )}
                          </>
                        ) : null}
                      </>
                    )
                  ) : (
                    <div class="composer-popup-empty">
                      {commandsLoading
                        ? "正在读取可用命令与技能…"
                        : "未找到匹配的斜杠命令，继续回车将原样发送"}
                    </div>
                  )
                ) : entries.length > 0 ? (
                  entries.map((entry, idx) => {
                    if (entry.type !== "mention") return null;
                    const isSelected = idx === activeIndex;
                    return (
                      <button
                        key={entry.key}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        data-popup-idx={idx}
                        class={`composer-popup-item ${isSelected ? "is-active" : ""}`}
                        title={`${entry.item.displayLabel} · ${entry.item.meta}`}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          applySelection(entry);
                        }}
                      >
                        <div class="composer-popup-main">
                          <span class="composer-popup-badge is-ref">
                            {entry.item.badge}
                          </span>
                          <span class="composer-popup-name mono">
                            {entry.item.displayLabel}
                          </span>
                        </div>
                        <div class="composer-popup-desc">{entry.item.meta}</div>
                      </button>
                    );
                  })
                ) : (
                  <div class="composer-popup-empty">
                    {filesLoading
                      ? "正在搜索项目文件…"
                      : !isProjectSpace
                        ? "本机模式无项目仓库文件索引，当前暂无可引用的在途任务或账本"
                        : "未找到匹配的文件、任务或账本"}
                  </div>
                )}
              </div>
            </div>
          ) : null}

          <textarea
            ref={textareaRef}
            id={id}
            class="input"
            rows={2}
            placeholder={placeholder}
            value={value}
            disabled={disabled}
            aria-autocomplete={showPopup ? "list" : "none"}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              composingRef.current = false;
              syncCaretFromTarget(e.currentTarget as HTMLTextAreaElement);
            }}
            onInput={(e) => {
              const target = e.currentTarget as HTMLTextAreaElement;
              setDismissedAnchor(null);
              setCaretPos(target.selectionStart ?? target.value.length);
              onChange(target.value);
            }}
            onClick={(e) => syncCaretFromTarget(e.currentTarget as HTMLTextAreaElement)}
            onKeyUp={(e) => {
              if (
                e.key === "ArrowUp" ||
                e.key === "ArrowDown" ||
                e.key === "Enter" ||
                e.key === "Tab" ||
                e.key === "Escape"
              ) {
                return;
              }
              syncCaretFromTarget(e.currentTarget as HTMLTextAreaElement);
            }}
            onKeyDown={(e) => {
              if (composingRef.current || e.isComposing) {
                return;
              }

              if (showPopup && e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setDismissedAnchor(currentAnchor);
                return;
              }

              if (trigger !== null && entries.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveIndex((prev) => (prev + 1) % entries.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveIndex((prev) => (prev - 1 + entries.length) % entries.length);
                  return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                  e.preventDefault();
                  const chosen = entries[activeIndex] ?? entries[0];
                  if (chosen) {
                    applySelection(chosen);
                  }
                  return;
                }
              }

              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
          />
          <button
            type="button"
            class="btn btn-light"
            disabled={disabled || !value.trim()}
            onClick={() => onSend()}
          >
            发送
          </button>
        </div>
        <div class="composer-hint">
          输入 <span class="mono">/</span> 调用命令或技能 ·{" "}
          <span class="mono">@</span> 引用文件、任务或账本 · Enter 发送，Shift+Enter 换行
        </div>
      </div>
    </div>
  );
}
