import { PRIORITY_RANK } from "@kiln/protocol/web";
import { DecisionBox } from "../components/DecisionBox";
import { PrioritySelect } from "../components/PrioritySelect";
import { ViewFrame } from "../components/ViewFrame";
import { fmtRelativeSince } from "../state/format";
import { useKilnStore } from "../state/store";

export function InboxView() {
  const { store, state } = useKilnStore();
  const { tasks, pendingDecisions, spaces } = state;

  const decisionByTask = new Map(pendingDecisions.map((d) => [d.task_id, d]));
  const waitingTasks = tasks
    .filter((t) => t.status === "waiting")
    .sort((a, b) => PRIORITY_RANK[a.effective_priority] - PRIORITY_RANK[b.effective_priority]);

  return (
    <ViewFrame
      left={
        <>
          <h1 className="tb-title">等你决定</h1>
          <span className="tb-sub">
            只有产品承诺、本机首次写入、外部动作、前置取消和熔断会来到这里（手动暂停不进此处）
          </span>
        </>
      }
    >
      <div className="page">
        <div className="page-inner">
          {waitingTasks.length > 0 ? (
            waitingTasks.map((t) => {
              const dec = decisionByTask.get(t.id);
              const spaceName = spaces[t.space]?.name ?? t.space;
              return (
                <div key={t.id} className="inbox-item">
                  <div className="inbox-task">
                    <button type="button" onClick={() => store.openTask(t.id)}>
                      {t.title}
                    </button>
                    <span className="muted">
                      <PrioritySelect
                        value={t.priority}
                        onChange={(next) => void store.updatePriority(t.id, next)}
                      />{" "}
                      {spaceName} · 等了{" "}
                      {fmtRelativeSince(dec?.created_at ?? t.waiting_since ?? t.updated_at)}
                    </span>
                  </div>
                  {dec ? (
                    <DecisionBox
                      decision={dec}
                      onSubmit={(payload) => store.submitDecision(t.id, payload)}
                      onOpenResolve={() => store.openResolve(t.id)}
                    />
                  ) : (
                    <div className="decision">
                      <p className="decision-q">{t.waiting_reason ?? "等待人工裁决"}</p>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => store.openTask(t.id)}
                      >
                        查看详情
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <p className="empty">
              没有等你决定的事
              <br />
              后台遇到只有你能拍板的问题时，会放到这里
            </p>
          )}
        </div>
      </div>
    </ViewFrame>
  );
}
