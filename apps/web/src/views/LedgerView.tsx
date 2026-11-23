import { LedgerIcon } from "../components/Icons";
import { ViewFrame } from "../components/ViewFrame";
import { fmtDateShort } from "../state/format";
import { useKilnStore } from "../state/store";

export function LedgerView() {
  const { store, state } = useKilnStore();
  const { ledgers, spaces, tasks } = state;

  const groups = Object.entries(ledgers).filter(
    ([, entries]) => entries.length > 0,
  );
  const totalCount = groups.reduce((acc, [, entries]) => acc + entries.length, 0);
  const knownTaskIds = new Set(tasks.map((t) => t.id));

  return (
    <ViewFrame
      left={
        <>
          <h1 className="tb-title">决策账本</h1>
          <span className="tb-sub">
            {totalCount} 条长期约束 · 仅沉淀跨任务复用的长期工程约束，单次放行审批不入账
          </span>
        </>
      }
    >
      <div className="page">
        <div className="page-inner">
          <p className="page-lede">
            你在「等你决定」中明确勾选写入账本的规则会沉淀于此；后续立项与审查都会先读取，避免同一约束反复打断你。
          </p>
          {groups.length > 0 ? (
            groups.map(([spaceId, entries]) => {
              const spaceName = spaces[spaceId]?.name ?? spaceId;
              return (
                <section key={spaceId} className="ledger-group">
                  <div className="ledger-gh">
                    <LedgerIcon />
                    <h3>{spaceName}</h3>
                    <span className="nav-count">{entries.length}</span>
                  </div>
                  {entries.map((entry) => {
                    const srcLabel = `${entry.source_task_id} · ${fmtDateShort(entry.created_at)}`;
                    const hasTask = knownTaskIds.has(entry.source_task_id);
                    return (
                      <div key={entry.id} className="ledger-row">
                        <span>{entry.rule}</span>
                        {hasTask ? (
                          <button
                            type="button"
                            className="src src-btn"
                            title={`打开来源任务 ${entry.source_task_id}`}
                            onClick={() => store.openTask(entry.source_task_id)}
                          >
                            {srcLabel}
                          </button>
                        ) : (
                          <span className="src">{srcLabel}</span>
                        )}
                      </div>
                    );
                  })}
                </section>
              );
            })
          ) : (
            <p className="empty">
              暂无已确认的长期工程约束
              <br />
              只有在你明确勾选写入账本后，规则才会进入 ledger/&lt;space&gt;.yaml
            </p>
          )}
        </div>
      </div>
    </ViewFrame>
  );
}
