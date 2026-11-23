import { fmtUsd } from "../state/format";
import {
  computeAgentCostUsd,
  computeGrandTotalCostUsd,
  extractAgentQuotas,
  quotaClassName,
} from "../state/pricing";
import { useKilnStore } from "../state/store";

export function UsagePanel() {
  const { store, state } = useKilnStore();
  const {
    usage,
    pricing,
    providerUsage,
    ratesByTask,
    liveTotals,
    tasks,
    limits,
    backends,
    sseStatus,
  } = state;

  const parentIds = new Set<string>();
  for (const t of tasks) {
    if (t.parent_id) parentIds.add(t.parent_id);
  }
  const runningLeafTasks = tasks.filter(
    (t) => t.status === "running" && !parentIds.has(t.id) && t.kind !== "epic",
  );

  const ratesSum = Object.values(ratesByTask).reduce(
    (sum, r) => sum + (Number.isFinite(r) ? r : 0),
    0,
  );
  const totalRate = Math.round(
    Object.keys(ratesByTask).length > 0 ? ratesSum : (liveTotals?.tokPerSec ?? 0),
  );

  const hasModelBuckets = Object.keys(usage.byModel).length > 0;
  const computedCost = computeGrandTotalCostUsd(usage, pricing);
  const displayCostUsd = hasModelBuckets
    ? computedCost
    : (liveTotals?.costUsd ?? computedCost);

  const liveRateByAgent: Record<string, number> = {};
  for (const t of runningLeafTasks) {
    const rate = ratesByTask[t.id] ?? 0;
    if (rate > 0 && t.agent) {
      liveRateByAgent[t.agent] = (liveRateByAgent[t.agent] ?? 0) + rate;
    }
  }

  const quotas = extractAgentQuotas(providerUsage);
  const agentNames = Array.from(
    new Set([...Object.keys(usage.byAgent), ...Object.keys(quotas)]),
  );

  const paseoConnected = backends.some(
    (b) => (b.backendId ?? b.id ?? "").toLowerCase().includes("paseo") && b.connected,
  );
  const connLabel =
    backends.length > 0
      ? paseoConnected
        ? "Paseo 已连接"
        : "底座离线"
      : sseStatus === "connected"
        ? "实时流已连接"
        : sseStatus === "reconnecting"
          ? "实时流重连中"
          : "本地工作台";

  return (
    <div id="usagePanel" className="side-bottom">
      <div
        role="button"
        tabIndex={0}
        className="usage-panel"
        onClick={() => store.go("usage")}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            store.go("usage");
          }
        }}
      >
        <div className="up-head">
          <span>今日费用 · API 标价</span>
          <span className="mono" id="upTotalCost">
            {fmtUsd(displayCostUsd)}
          </span>
        </div>
        <div className="up-rate">
          <span className="dot live-dot" />
          <b id="upTotalRate">{totalRate}</b> tok/s ·{" "}
          <span id="upSessions">
            {runningLeafTasks.length} / {limits.max_concurrent_slots}
          </span>{" "}
          个任务
        </div>

        {agentNames.map((agent) => {
          const quota = quotas[agent];
          const agentCost = computeAgentCostUsd(agent, usage, pricing);
          const agentLiveRate = Math.round(liveRateByAgent[agent] ?? 0);
          return (
            <div key={agent} className="up-agent">
              <div className="up-row">
                <span>
                  {agent}
                  <span className="up-live" data-up-live={agent}>
                    {agentLiveRate > 0 ? `${agentLiveRate} tok/s` : ""}
                  </span>
                </span>
                <span className="mono" data-up-cost={agent}>
                  {fmtUsd(agentCost)}
                </span>
              </div>
              {quota ? (
                <>
                  <div className="quota">
                    <i
                      data-up-bar={agent}
                      className={quotaClassName(quota.usedRatio)}
                      style={{ width: `${Math.round(quota.usedRatio * 100)}%` }}
                    />
                  </div>
                  <div className="up-sub">
                    <span data-up-qtext={agent}>
                      {quota.label} {Math.round(quota.usedRatio * 100)}%
                    </span>
                    <span data-up-reset={agent}>
                      {quota.resetAt ? `${quota.resetAt} 重置` : ""}
                    </span>
                  </div>
                </>
              ) : null}
            </div>
          );
        })}

        <div className="up-foot">
          <span>{connLabel}</span>
          <button
            type="button"
            className="key key-dark"
            aria-label="打开命令面板"
            onClick={(e) => {
              e.stopPropagation();
              store.setPaletteOpen(true);
            }}
          >
            ⌘K
          </button>
        </div>
      </div>
    </div>
  );
}
