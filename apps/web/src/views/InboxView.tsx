import { PRIORITY_RANK } from "@kiln/protocol/web";
import { useState } from "react";
import { DecisionBox } from "../components/DecisionBox";
import { InboxIcon } from "../components/Icons";
import { MiniRail } from "../components/MiniRail";
import { PrioritySelect } from "../components/PrioritySelect";
import { ViewFrame } from "../components/ViewFrame";
import { TRACK_LABEL, fmtRelativeSince } from "../state/format";
import { useKilnStore } from "../state/store";

export function InboxView() {
  const { store, state } = useKilnStore();
  const { tasks, pendingDecisions, spaces } = state;
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const decisionByTask = new Map(pendingDecisions.map((d) => [d.task_id, d]));
  const waitingTasks = tasks
    .filter((t) => t.status === "waiting")
    .sort((a, b) => PRIORITY_RANK[a.effective_priority] - PRIORITY_RANK[b.effective_priority]);

  const selectedTask =
    waitingTasks.find((t) => t.id === selectedTaskId) ?? waitingTasks[0] ?? null;
  const selectedDecision = selectedTask ? decisionByTask.get(selectedTask.id) : undefined;

  return (
    <ViewFrame
      left={
        <>
          <h1 className="tb-title">等你决定</h1>
          <span className="tb-sub">
            {waitingTasks.length} 件 · 只有产品承诺、本机首次写入、外部动作、前置取消和熔断会来到这里（手动暂停不进此处）
          </span>
        </>
      }
    >
      {selectedTask ? (
        <div className="inbox">
          <aside className="inbox-list" aria-label="待决定任务列表">
            {waitingTasks.map((t) => {
              const dec = decisionByTask.get(t.id);
              const spaceName = spaces[t.space]?.name ?? t.space;
              const pri = t.effective_priority || t.priority;
              const isSelected = t.id === selectedTask.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-current={isSelected ? "true" : undefined}
                  className={`ib-item ${isSelected ? "on" : ""}`}
                  onClick={() => setSelectedTaskId(t.id)}
                >
                  <span className="ib-top">
                    {pri === "P0" || pri === "P1" ? (
                      <span className={`ib-pri ${pri}`}>{pri}</span>
                    ) : null}
                    <span>{spaceName}</span>
                    <span className="mono muted" style={{ marginLeft: "auto" }}>
                      {fmtRelativeSince(dec?.created_at ?? t.waiting_since ?? t.updated_at)}
                    </span>
                  </span>
                  <b>{t.title}</b>
                  <p>
                    {t.summary ||
                      (dec ? `${dec.category} · ${dec.reason}` : null) ||
                      t.waiting_reason ||
                      "等待人工裁决"}
                  </p>
                </button>
              );
            })}
          </aside>

          <div className="ib-detail">
            <div className="ib-detail-in">
              <header className="ib-head">
                <span className="ico-chip ask lg">
                  <InboxIcon />
                </span>
                <div className="ib-head-main">
                  <h2>{selectedTask.title}</h2>
                  <div className="ib-meta">
                    <PrioritySelect
                      value={selectedTask.priority}
                      onChange={(next) => void store.updatePriority(selectedTask.id, next)}
                    />
                    <span>{spaces[selectedTask.space]?.name ?? selectedTask.space}</span>
                    <span>
                      等了{" "}
                      {fmtRelativeSince(
                        selectedDecision?.created_at ??
                          selectedTask.waiting_since ??
                          selectedTask.updated_at,
                      )}
                    </span>
                    <span>{TRACK_LABEL[selectedTask.track]}</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => store.openTask(selectedTask.id)}
                >
                  打开任务
                </button>
              </header>

              {selectedDecision ? (
                <DecisionBox
                  decision={selectedDecision}
                  onSubmit={(payload) => store.submitDecision(selectedTask.id, payload)}
                  onOpenResolve={() => store.openResolve(selectedTask.id)}
                />
              ) : (
                <div className="decision">
                  <p className="decision-q">
                    {selectedTask.waiting_reason ?? "等待人工裁决"}
                  </p>
                  <div className="decision-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-light"
                      onClick={() => store.openTask(selectedTask.id)}
                    >
                      查看详情
                    </button>
                  </div>
                </div>
              )}

              <section className="ib-foot-card" aria-label="任务进度摘要">
                {selectedTask.summary ? (
                  <p className="ib-summary">{selectedTask.summary}</p>
                ) : null}
                <MiniRail
                  track={selectedTask.track}
                  workflow={selectedTask.workflow}
                  status={selectedTask.status}
                  activeStage={selectedTask.stage}
                />
              </section>
            </div>
          </div>
        </div>
      ) : (
        <div className="page">
          <div className="page-inner">
            <p className="empty">
              没有等你决定的事
              <br />
              后台遇到只有你能拍板的问题时，会放到这里
            </p>
          </div>
        </div>
      )}
    </ViewFrame>
  );
}
