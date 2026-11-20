import { ViewFrame } from "../components/ViewFrame";
import { fmtDateShort } from "../state/format";
import { useKilnStore } from "../state/store";

export function LedgerView() {
  const { state } = useKilnStore();
  const { ledgers, spaces } = state;

  const groups = Object.entries(ledgers).filter(
    ([, entries]) => entries.length > 0,
  );

  return (
    <ViewFrame
      left={
        <>
          <h1 class="tb-title">决策账本</h1>
          <span class="tb-sub">
            仅沉淀跨任务复用的长期工程约束，单次放行审批不入账
          </span>
        </>
      }
    >
      <div class="page">
        <div class="page-inner">
          {groups.length > 0 ? (
            groups.map(([spaceId, entries]) => {
              const spaceName = spaces[spaceId]?.name ?? spaceId;
              return (
                <section key={spaceId} class="ledger-group">
                  <h3>{spaceName}</h3>
                  {entries.map((entry) => (
                    <div key={entry.id} class="ledger-row">
                      <span>{entry.rule}</span>
                      <span class="src">
                        {entry.source_task_id} · {fmtDateShort(entry.created_at)}
                      </span>
                    </div>
                  ))}
                </section>
              );
            })
          ) : (
            <p class="empty">
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
