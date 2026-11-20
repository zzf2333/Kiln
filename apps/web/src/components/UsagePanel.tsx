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
    <div id="usagePanel" class="side-bottom">
      <div
        role="button"
        tabIndex={0}
        class="usage-panel"
        onClick={() => store.go("usage")}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            store.go("usage");
          }
        }}
      >
        <div class="up-head">
          <span>今日费用 · API 标价</span>
          <span class="mono" id="upTotalCost">
            {fmtUsd(displayCostUsd)}
          </span>
        </div>
        <div class="up-rate">
          <span class="dot live-dot" />
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
            <div key={agent} class="up-agent">
              <div class="up-row">
                <span>
                  {agent}
                  <span class="up-live" data-up-live={agent}>
                    {agentLiveRate > 0 ? `${agentLiveRate} tok/s` : ""}
                  </span>
                </span>
                <span class="mono" data-up-cost={agent}>
                  {fmtUsd(agentCost)}
                </span>
              </div>
              {quota ? (
                <>
                  <div class="quota">
                    <i
                      data-up-bar={agent}
                      class={quotaClassName(quota.usedRatio)}
                      style={{ width: `${Math.round(quota.usedRatio * 100)}%` }}
                    />
                  </div>
                  <div class="up-sub">
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

        <div class="up-foot">
          <span>{connLabel}</span>
          <button
            type="button"
            class="key key-dark"
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
