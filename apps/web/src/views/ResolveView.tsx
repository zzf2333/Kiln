import { useEffect, useRef, useState } from "preact/hooks";
import type { TaskDetailResponse } from "../api/types";
import { DecisionBox } from "../components/DecisionBox";
import { MarkdownContent } from "../components/MarkdownContent";
import { ViewFrame } from "../components/ViewFrame";
import { useKilnStore } from "../state/store";

export function HostStagedDiffSection({
  detail,
}: {
  detail: TaskDetailResponse | undefined;
}) {
  const diffs = detail?.hostStagedDiffs;
  if (
    detail?.hostBackup?.status !== "staged_awaiting_approval" ||
    !diffs ||
    diffs.length === 0
  ) {
    return null;
  }

  return (
    <section class="staged-diffs" aria-label="待落盘暂存 Diff">
      <div class="staged-diffs-head">
        <h4>待落盘暂存 Diff</h4>
        <span class="muted mono">{diffs.length} 个文件待写入</span>
      </div>
      <div class="staged-diffs-list">
        {diffs.map((entry, idx) => (
          <div key={`${entry.targetPath}-${idx}`} class="staged-diff-file">
            <div class="staged-diff-file-head">
              <span class={`staged-tag ${entry.existedBefore ? "is-mod" : "is-add"}`}>
                {entry.existedBefore ? "修改" : "新增"}
              </span>
              <span class="staged-diff-path mono" title={entry.targetPath}>
                {entry.targetPath}
              </span>
              {entry.truncated ? (
                <span class="staged-tag is-trunc">内容已截断</span>
              ) : null}
            </div>
            <pre class="mono staged-diff-pre">{entry.diff}</pre>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ResolveView() {
  const { store, state } = useKilnStore();
  const [chatInput, setChatInput] = useState("");
  const msgsRef = useRef<HTMLDivElement | null>(null);

  const taskId = state.taskId;
  const taskSummary = taskId
    ? state.tasks.find((t) => t.id === taskId)
    : undefined;
  const detail = taskId ? state.taskDetails[taskId] : undefined;
  const pendingDecision =
    detail?.pendingDecision ??
    (taskId
      ? state.pendingDecisions.find((d) => d.task_id === taskId) ?? null
      : null);

  const customMessages = taskId ? state.resolveMessagesByTask[taskId] : undefined;
  const messages =
    customMessages && customMessages.length > 0
      ? customMessages
      : pendingDecision && taskSummary
        ? [
            {
              who: "agent" as const,
              name: "resolver",
              text: `已载入「${taskSummary.title}」（契约 v${taskSummary.contract_version}）。\n待决问题：${pendingDecision.question}\n你可以在左侧与我讨论方案或修改契约口径，也可以直接在右侧选择选项拍板。`,
            },
          ]
        : [];

  useEffect(() => {
    if (msgsRef.current) {
      msgsRef.current.scrollTop = msgsRef.current.scrollHeight;
    }
  }, [messages.length]);

  if (!taskId || !taskSummary || !pendingDecision) {
    return (
      <ViewFrame
        left={
          <button
            type="button"
            class="btn btn-ghost"
            onClick={() => store.go("board")}
          >
            返回总览
          </button>
        }
      >
        <div class="page">
          <p class="empty">当前任务没有待决事项，已返回总览。</p>
        </div>
      </ViewFrame>
    );
  }

  const handleSend = async (): Promise<void> => {
    const val = chatInput.trim();
    if (!val || state.resolveBusy) return;
    setChatInput("");
    await store.sendResolveChat(taskId, val);
  };

  return (
    <ViewFrame
      left={
        <div class="crumbs">
          <button type="button" onClick={() => store.go("board")}>
            总览
          </button>
          <span>/</span>
          <button type="button" onClick={() => store.openTask(taskId)}>
            {taskSummary.title}
          </button>
          <span>/</span>
          <span>讨论</span>
        </div>
      }
      right={
        <button
          type="button"
          class="btn btn-ghost"
          onClick={() => store.openTask(taskId)}
        >
          返回详情
        </button>
      }
    >
      <div class="converse">
        <div class="chat">
          <div class="msgs" id="msgs" ref={msgsRef}>
            {messages.map((m, idx) => {
              const who =
                m.who ??
                (m.role === "user" ? "me" : m.role === "tool" ? "tool" : "agent");
              if (who === "tool") {
                return (
                  <div key={idx} class="msg tool">
                    <span class="dot" style={{ background: "var(--t3)" }} />
                    <span>{m.text}</span>
                  </div>
                );
              }
              return (
                <div key={idx} class={`msg ${who === "me" ? "me" : "agent"}`}>
                  {who !== "me" ? (
                    <div class="msg-who">{m.name ?? "resolver"}</div>
                  ) : null}
                  {who === "me" ? (
                    <div class="msg-text">{m.text}</div>
                  ) : (
                    <MarkdownContent text={m.text} className="msg-md" />
                  )}
                </div>
              );
            })}
            {state.resolveBusy ? (
              <div class="msg agent msg-thinking">
                <div class="msg-who">resolver</div>
                <div class="msg-text muted">正在整理上下文并思考回应…</div>
              </div>
            ) : null}
          </div>

          <div class="composer">
            <textarea
              id="chatIn"
              class="input"
              rows={2}
              placeholder="说说你的想法（Enter 发送，Shift+Enter 换行）"
              value={chatInput}
              disabled={state.resolveBusy}
              onInput={(e) =>
                setChatInput((e.currentTarget as HTMLTextAreaElement).value)
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
            />
            <button
              type="button"
              class="btn btn-light"
              disabled={state.resolveBusy || !chatInput.trim()}
              onClick={() => void handleSend()}
            >
              发送
            </button>
          </div>
        </div>

        <aside class={`draft ${state.draftOpen ? "open" : ""}`}>
          <div class="draft-head">
            <h3>拍板与契约</h3>
            <button
              type="button"
              class="btn btn-sm draft-toggle"
              id="btnDraftToggle"
              onClick={() => store.toggleDraftOpen()}
            >
              {state.draftOpen ? "收起面板" : "展开拍板"}
            </button>
          </div>
          <div class="resolve-panel" style={{ paddingTop: "12px" }}>
            <DecisionBox
              decision={pendingDecision}
              onSubmit={(payload) => store.submitDecision(taskId, payload)}
            />
            <HostStagedDiffSection detail={detail} />
            {detail?.card && detail?.state ? (
              <div class="ctx" style={{ border: "none", padding: "0 0 20px" }}>
                <section>
                  <h3>当前契约 · v{detail.state.contractVersion}</h3>
                  <dl>
                    <div>
                      <dt>目标</dt>
                      <dd>{detail.card.contract.goal}</dd>
                    </div>
                    <div>
                      <dt>交付终点</dt>
                      <dd>{detail.card.contract.end}</dd>
                    </div>
                    <div>
                      <dt>验收命令</dt>
                      <dd class="mono">{detail.card.contract.accept_cmd}</dd>
                    </div>
                    <div>
                      <dt>可改范围</dt>
                      <dd class="mono">
                        {detail.card.contract.scope.join("\n")}
                      </dd>
                    </div>
                  </dl>
                </section>
              </div>
            ) : null}
          </div>
        </aside>
      </div>
    </ViewFrame>
  );
}
