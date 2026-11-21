import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatMessage } from "../api/types";
import { fmtTime } from "../state/format";
import type { IntakeProgressItem } from "../state/store";
import { MarkdownContent } from "./MarkdownContent";

export interface ChatTimelineProps {
  messages: ReadonlyArray<ChatMessage>;
  busy: boolean;
  busyLabel: string;
  progressLogs?: ReadonlyArray<IntakeProgressItem>;
  roleLabel: string;
  defaultAgentName: string;
  emptySlot?: ComponentChildren;
}

interface ParsedToolStep {
  id: string;
  toolName: string;
  verb: string;
  preview: string;
  fullDetail: string;
  expandable: boolean;
  count: number;
  status: "ok" | "warn" | "neutral";
  at?: string;
}

type TimelineSegment =
  | { kind: "message"; who: "me" | "agent"; msg: ChatMessage }
  | { kind: "worklog"; key: string; steps: ParsedToolStep[]; rawCount: number };

const PREVIEW_MAX_CHARS = 96;

function toolVerbOf(toolName: string): string {
  switch (toolName) {
    case "run_command":
    case "execute_command":
      return "运行命令";
    case "read_file":
    case "view_file":
      return "读取文件";
    case "grep_search":
    case "find_by_name":
    case "list_dir":
    case "search_web":
      return "检索查阅";
    case "draft_patch":
    case "wb_plan":
      return "同步草稿";
    case "contract_patch":
      return "更新契约";
    case "manage_task":
      return "后台任务";
    default:
      return toolName || "工具调用";
  }
}

function parseToolMessage(msg: ChatMessage, idx: number): ParsedToolStep {
  const rawText = (msg.text ?? "").trim();
  let toolName = (msg.toolName ?? "").trim();
  let rawArg = "";

  if (toolName && rawText.startsWith(`${toolName} · `)) {
    rawArg = rawText.slice(toolName.length + 3).trim();
  } else if (toolName && rawText === toolName) {
    rawArg = "";
  } else {
    const sepIdx = rawText.indexOf(" · ");
    if (sepIdx > 0) {
      if (!toolName) toolName = rawText.slice(0, sepIdx).trim();
      rawArg = rawText.slice(sepIdx + 3).trim();
    } else {
      if (!toolName) toolName = rawText || "tool";
      if (rawText !== toolName) rawArg = rawText;
    }
  }

  let status: "ok" | "warn" | "neutral" = "neutral";
  if (toolName === "draft_patch" || toolName === "contract_patch" || toolName === "wb_plan") {
    status = /失败|未通过|错误/.test(rawArg) ? "warn" : "ok";
  }

  const singleLine = rawArg.replace(/\s+/g, " ").trim();
  const expandable = rawArg.includes("\n") || singleLine.length > PREVIEW_MAX_CHARS;
  const preview =
    singleLine.length > PREVIEW_MAX_CHARS
      ? `${singleLine.slice(0, PREVIEW_MAX_CHARS - 1)}…`
      : singleLine;

  return {
    id: msg.id ?? `tool-${idx}`,
    toolName,
    verb: toolVerbOf(toolName),
    preview,
    fullDetail: rawArg,
    expandable,
    count: 1,
    status,
    ...(msg.at ? { at: msg.at } : {}),
  };
}

function buildWorkLogSteps(rawTools: ReadonlyArray<ChatMessage>): ParsedToolStep[] {
  const steps: ParsedToolStep[] = [];
  rawTools.forEach((m, i) => {
    const parsed = parseToolMessage(m, i);
    const prev = steps[steps.length - 1];
    if (
      prev &&
      parsed.fullDetail === "" &&
      prev.fullDetail === "" &&
      parsed.toolName === prev.toolName &&
      parsed.status === prev.status
    ) {
      prev.count += 1;
      if (parsed.at) prev.at = parsed.at;
      return;
    }
    steps.push(parsed);
  });
  return steps;
}

function groupTimelineSegments(messages: ReadonlyArray<ChatMessage>): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let toolBuf: ChatMessage[] = [];
  let toolGroupSeq = 0;

  const flushTools = (): void => {
    if (toolBuf.length === 0) return;
    const steps = buildWorkLogSteps(toolBuf);
    const firstId = toolBuf[0]?.id ?? `grp-${toolGroupSeq}`;
    segments.push({
      kind: "worklog",
      key: `wl-${toolGroupSeq}-${firstId}`,
      steps,
      rawCount: toolBuf.length,
    });
    toolBuf = [];
    toolGroupSeq += 1;
  };

  for (const m of messages) {
    const who =
      m.who ??
      (m.role === "user" ? "me" : m.role === "tool" ? "tool" : "agent");
    if (who === "tool") {
      toolBuf.push(m);
      continue;
    }
    flushTools();
    segments.push({ kind: "message", who, msg: m });
  }
  flushTools();
  return segments;
}

function summarizeWorkLog(steps: ReadonlyArray<ParsedToolStep>, rawCount: number): string {
  const countsByVerb = new Map<string, number>();
  for (const s of steps) {
    countsByVerb.set(s.verb, (countsByVerb.get(s.verb) ?? 0) + s.count);
  }
  const parts = Array.from(countsByVerb.entries())
    .slice(0, 3)
    .map(([verb, cnt]) => `${verb} ×${cnt}`);
  const breakdown = parts.length > 0 ? `（${parts.join(" · ")}）` : "";
  return `探索与操作 · ${rawCount} 步${breakdown}`;
}

function WorkLogGroupCard({
  steps,
  rawCount,
}: {
  steps: ParsedToolStep[];
  rawCount: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openStepIds, setOpenStepIds] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const hasWarn = steps.some((s) => s.status === "warn");

  const toggleStepDetail = (id: string): void => {
    setOpenStepIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const copyCommand = async (id: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1400);
    } catch {
      // Clipboard unavailable
    }
  };

  return (
    <div class={`worklog ${hasWarn ? "has-warn" : ""}`} aria-label="探索与操作记录">
      <button
        type="button"
        class="worklog-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span class="worklog-toggle-l">
          <span class={`worklog-chevron ${expanded ? "is-open" : ""}`} aria-hidden="true">
            ▸
          </span>
          <span class={`worklog-dot ${hasWarn ? "is-warn" : ""}`} />
          <span class="worklog-summary">{summarizeWorkLog(steps, rawCount)}</span>
          {hasWarn ? <span class="worklog-warn-badge">含提示</span> : null}
        </span>
        <span class="worklog-toggle-r">{expanded ? "收起" : "展开详情"}</span>
      </button>

      {expanded ? (
        <ul class="worklog-rail">
          {steps.map((step) => {
            const detailOpen = Boolean(openStepIds[step.id]);
            return (
              <li key={step.id} class={`worklog-item is-${step.status}`}>
                <span class="worklog-node" aria-hidden="true" />
                <div class="worklog-body">
                  <div class="worklog-row">
                    <span class="worklog-verb">{step.verb}</span>
                    {step.count > 1 ? (
                      <span class="worklog-count mono">×{step.count}</span>
                    ) : null}
                    {step.preview ? (
                      <span class="worklog-detail mono">{step.preview}</span>
                    ) : null}
                    {step.expandable ? (
                      <button
                        type="button"
                        class="worklog-more"
                        onClick={() => toggleStepDetail(step.id)}
                      >
                        {detailOpen ? "收起" : "完整内容"}
                      </button>
                    ) : null}
                  </div>
                  {detailOpen && step.fullDetail ? (
                    <div class="worklog-cmd-wrap">
                      <pre class="worklog-cmd mono">{step.fullDetail}</pre>
                      <button
                        type="button"
                        class="btn btn-ghost btn-sm md-copy-btn worklog-cmd-copy"
                        onClick={() => void copyCommand(step.id, step.fullDetail)}
                      >
                        {copiedId === step.id ? "已复制" : "复制"}
                      </button>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function AgentMessageCard({
  msg,
  roleLabel,
  defaultAgentName,
}: {
  msg: ChatMessage;
  roleLabel: string;
  defaultAgentName: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(msg.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard unavailable
    }
  };

  return (
    <article class="msg agent">
      <header class="msg-head">
        <div class="msg-head-l">
          <span class="msg-role-dot" aria-hidden="true" />
          <span class="msg-who">{roleLabel}</span>
          <span class="msg-agent mono">{msg.name ?? defaultAgentName}</span>
          {msg.at ? (
            <span class="msg-time mono">{fmtTime(msg.at)}</span>
          ) : null}
        </div>
        <button
          type="button"
          class="btn btn-ghost btn-sm msg-copy-btn"
          aria-label="复制消息正文"
          onClick={() => void handleCopy()}
        >
          {copied ? "已复制" : "复制"}
        </button>
      </header>
      <MarkdownContent text={msg.text} className="msg-md" />
    </article>
  );
}

export function ChatTimeline({
  messages,
  busy,
  busyLabel,
  progressLogs = [],
  roleLabel,
  defaultAgentName,
  emptySlot,
}: ChatTimelineProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const liveRailRef = useRef<HTMLUListElement | null>(null);
  const stickBottomRef = useRef(true);
  const [showJumpBottom, setShowJumpBottom] = useState(false);

  const scrollToBottom = (smooth = false): void => {
    const el = scrollerRef.current;
    if (!el) return;
    stickBottomRef.current = true;
    setShowJumpBottom(false);
    if (smooth && typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  };

  const handleScroll = (): void => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distance <= 120;
    stickBottomRef.current = nearBottom;
    setShowJumpBottom(!nearBottom);
  };

  useEffect(() => {
    if (stickBottomRef.current && scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [messages.length, busy, progressLogs.length]);

  useEffect(() => {
    if (busy && liveRailRef.current) {
      liveRailRef.current.scrollTop = liveRailRef.current.scrollHeight;
    }
  }, [busy, progressLogs.length]);

  const segments = groupTimelineSegments(messages);

  return (
    <div class="msgs-wrap">
      <div class="msgs" id="msgs" ref={scrollerRef} onScroll={handleScroll}>
        <div class="msgs-track">
          {emptySlot}

          {segments.map((seg, idx) => {
            if (seg.kind === "worklog") {
              return (
                <WorkLogGroupCard
                  key={seg.key}
                  steps={seg.steps}
                  rawCount={seg.rawCount}
                />
              );
            }
            if (seg.who === "me") {
              return (
                <div key={seg.msg.id ?? `me-${idx}`} class="msg me">
                  <div class="msg-text">{seg.msg.text}</div>
                </div>
              );
            }
            return (
              <AgentMessageCard
                key={seg.msg.id ?? `ag-${idx}`}
                msg={seg.msg}
                roleLabel={roleLabel}
                defaultAgentName={defaultAgentName}
              />
            );
          })}

          {busy ? (
            <div class="msg msg-thinking">
              <div class="msg-head">
                <div class="msg-head-l">
                  <span class="msg-role-dot is-busy" aria-hidden="true" />
                  <span class="msg-who">{roleLabel}</span>
                </div>
              </div>
              <div class="worklog is-live">
                <div class="worklog-live-head">
                  <span>{busyLabel}</span>
                  {progressLogs.length > 0 ? (
                    <span class="worklog-toggle-r mono">{progressLogs.length} 步</span>
                  ) : null}
                </div>
                {progressLogs.length > 0 ? (
                  <ul
                    class="worklog-rail"
                    aria-label="立项探索进度"
                    ref={liveRailRef}
                  >
                    {progressLogs.map((step, idx) => (
                      <li
                        key={`${step.at}-${idx}`}
                        class={`worklog-item ${
                          step.kind === "draft_updated" ? "is-ok" : "is-neutral"
                        }`}
                      >
                        <span class="worklog-node" aria-hidden="true" />
                        <div class="worklog-body">
                          <div class="worklog-row">
                            <span class="worklog-detail mono" title={step.text}>
                              {step.text}
                            </span>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {showJumpBottom ? (
        <button
          type="button"
          class="scroll-bottom-btn"
          onClick={() => scrollToBottom(true)}
        >
          ↓ 回到底部
        </button>
      ) : null}
    </div>
  );
}
