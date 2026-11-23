import { useState } from "react";
import type { TaskDetailResponse } from "../api/types";
import { ChatComposer } from "../components/ChatComposer";
import { ChatTimeline } from "../components/ChatTimeline";
import { DecisionBox } from "../components/DecisionBox";
import { ViewFrame } from "../components/ViewFrame";
import { isProjectSpace, useKilnStore } from "../state/store";

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
    <section className="staged-diffs" aria-label="待落盘暂存 Diff">
      <div className="staged-diffs-head">
        <h4>待落盘暂存 Diff</h4>
        <span className="muted mono">{diffs.length} 个文件待写入</span>
      </div>
      <div className="staged-diffs-list">
        {diffs.map((entry, idx) => (
          <div key={`${entry.targetPath}-${idx}`} className="staged-diff-file">
            <div className="staged-diff-file-head">
              <span className={`staged-tag ${entry.existedBefore ? "is-mod" : "is-add"}`}>
                {entry.existedBefore ? "修改" : "新增"}
              </span>
              <span className="staged-diff-path mono" title={entry.targetPath}>
                {entry.targetPath}
              </span>
              {entry.truncated ? (
                <span className="staged-tag is-trunc">内容已截断</span>
              ) : null}
            </div>
            <pre className="mono staged-diff-pre">{entry.diff}</pre>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ResolveView() {
  const { store, state } = useKilnStore();
  const [chatInput, setChatInput] = useState("");

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

  if (!taskId || !taskSummary || !pendingDecision) {
    return (
      <ViewFrame
        left={
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => store.go("board")}
          >
            返回总览
          </button>
        }
      >
        <div className="page">
          <p className="empty">当前任务没有待决事项，已返回总览。</p>
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
        <div className="crumbs">
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
        <>
          <button
            type="button"
            className="btn btn-ghost desktop-panel-toggle"
            aria-pressed={state.desktopDraftCollapsed}
            onClick={() => store.toggleDesktopDraftCollapsed()}
          >
            {state.desktopDraftCollapsed ? "展开拍板栏" : "收起侧栏"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => store.openTask(taskId)}
          >
            返回详情
          </button>
        </>
      }
    >
      <div className={`converse ${state.desktopDraftCollapsed ? "is-panel-collapsed" : ""}`}>
        <div className="chat">
          <ChatTimeline
            messages={messages}
            busy={state.resolveBusy}
            busyLabel="正在整理上下文并思考回应…"
            roleLabel="讨论助手"
            defaultAgentName="resolver"
          />

          <ChatComposer
            role="resolver"
            spaceId={taskSummary.space}
            isProjectSpace={isProjectSpace(state.spaces[taskSummary.space])}
            taskId={taskId}
            value={chatInput}
            disabled={state.resolveBusy}
            placeholder="说说你的想法（/ 调用指令或技能，@ 选择文件、MCP 或任务）"
            onChange={setChatInput}
            onSend={() => void handleSend()}
          />
        </div>

        <aside className={`draft ${state.draftOpen ? "open" : ""}`}>
          <div className="draft-head">
            <h3>拍板与契约</h3>
            <button
              type="button"
              className="btn btn-sm draft-toggle"
              id="btnDraftToggle"
              onClick={() => store.toggleDraftOpen()}
            >
              {state.draftOpen ? "收起面板" : "展开拍板"}
            </button>
          </div>
          <div className="resolve-panel" style={{ paddingTop: "12px" }}>
            <DecisionBox
              decision={pendingDecision}
              onSubmit={(payload) => store.submitDecision(taskId, payload)}
            />
            <HostStagedDiffSection detail={detail} />
            {detail?.card && detail?.state ? (
              <div className="ctx" style={{ border: "none", padding: "0 0 20px" }}>
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
                      <dd className="mono">{detail.card.contract.accept_cmd}</dd>
                    </div>
                    <div>
                      <dt>可改范围</dt>
                      <dd className="mono">
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
