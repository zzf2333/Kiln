import { useState } from "preact/hooks";
import { ViewFrame } from "../components/ViewFrame";
import { fmtTokens, fmtUsd } from "../state/format";
import {
  computeAgentCostUsd,
  computeBucketCostUsd,
  computeGrandSavedUsd,
  computeGrandTotalCostUsd,
  computeTaskCostUsd,
  extractAgentQuotas,
  quotaClassName,
} from "../state/pricing";
import { useKilnStore } from "../state/store";

type UsagePeriod = "day" | "week" | "month" | "all";

const USAGE_PERIODS: ReadonlyArray<[UsagePeriod, string]> = [
  ["day", "今日"],
  ["week", "本周"],
  ["month", "本月"],
  ["all", "全部"],
];

function matchUsagePeriod(iso: string, period: UsagePeriod): boolean {
  if (period === "all") return true;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return true;
  const diffDays = (Date.now() - ts) / 86_400_000;
  if (period === "day") return diffDays <= 1;
  if (period === "week") return diffDays <= 7;
  return diffDays <= 31;
}

export function UsageView() {
  const { store, state } = useKilnStore();
  const [usagePeriod, setUsagePeriod] = useState<UsagePeriod>("all");

  const {
    usage,
    pricing,
    providerUsage,
    ratesByTask,
    liveTotals,
    tasks,
  } = state;

  const parentIds = new Set<string>();
  for (const t of tasks) {
    if (t.parent_id) parentIds.add(t.parent_id);
  }

  const totalCostUsd =
    Object.keys(usage.byModel).length > 0
      ? computeGrandTotalCostUsd(usage, pricing)
      : (liveTotals?.costUsd ?? usage.costUsd);
  const savedUsd = computeGrandSavedUsd(usage, pricing);
  const cacheHitRate =
    usage.inputTokens > 0
      ? Math.round((usage.cachedInputTokens / usage.inputTokens) * 100)
      : 0;

  const runningLeaves = tasks.filter(
    (t) => t.status === "running" && !parentIds.has(t.id) && t.kind !== "epic",
  );
  const ratesSum = Object.values(ratesByTask).reduce(
    (sum, r) => sum + (Number.isFinite(r) ? r : 0),
    0,
  );
  const totalRate = Math.round(
    Object.keys(ratesByTask).length > 0 ? ratesSum : (liveTotals?.tokPerSec ?? 0),
  );

  const liveRateByAgent: Record<string, number> = {};
  for (const t of runningLeaves) {
    const r = ratesByTask[t.id] ?? 0;
    if (r > 0 && t.agent) {
      liveRateByAgent[t.agent] = (liveRateByAgent[t.agent] ?? 0) + r;
    }
  }

  const quotas = extractAgentQuotas(providerUsage);
  const agentNames = Array.from(
    new Set([...Object.keys(usage.byAgent), ...Object.keys(quotas)]),
  );

  const rankedTasks = tasks
    .filter(
      (t) =>
        t.status !== "cancelled" &&
        !parentIds.has(t.id) &&
        t.kind !== "epic" &&
        t.tokens.total_tokens > 0 &&
        matchUsagePeriod(t.updated_at || t.created_at, usagePeriod),
    )
    .map((t) => ({
      task: t,
      cost: computeTaskCostUsd(t, pricing),
    }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 10);

  const maxRankedCost = rankedTasks.length
    ? Math.max(rankedTasks[0]!.cost, 0.01)
    : 1;

  return (
    <ViewFrame
      left={
        <>
          <h1 class="tb-title">用量与费用</h1>
          <span class="tb-sub">
            按 Agent 和模型拆分，费用一律按 API 标价折算
          </span>
        </>
      }
      right={
        <div class="seg" role="group" aria-label="统计区间">
          {USAGE_PERIODS.map(([k, label]) => (
            <button
              key={k}
              type="button"
              class={usagePeriod === k ? "on" : ""}
              onClick={() => setUsagePeriod(k)}
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      <div class="page">
        <dl class="stats">
          <div class="stat">
            <dt>折算总费用</dt>
            <dd>{fmtUsd(totalCostUsd)}</dd>
            <p>按 API 标价折算</p>
          </div>
          <div class="stat">
            <dt>Token 合计</dt>
            <dd>{fmtTokens(usage.totalTokens)}</dd>
            <p>
              输入 {fmtTokens(usage.inputTokens)} · 输出{" "}
              {fmtTokens(usage.outputTokens)}
            </p>
          </div>
          <div class="stat">
            <dt>缓存命中率</dt>
            <dd>{cacheHitRate}%</dd>
            <p>缓存省下约 {fmtUsd(savedUsd)}</p>
          </div>
          <div class="stat">
            <dt>当前输出</dt>
            <dd>
              {totalRate}{" "}
              <span style={{ fontSize: "13px", color: "var(--t3)" }}>
                tok/s
              </span>
            </dd>
            <p>{runningLeaves.length} 个任务在跑</p>
          </div>
        </dl>

        <section class="u-section">
          <h3>按 Agent 与模型</h3>
          {agentNames.length === 0 && Object.keys(usage.byModel).length === 0 ? (
            <p class="empty">暂无已记录的回合用量</p>
          ) : (
            <table class="ut">
              <thead>
                <tr>
                  <th>Agent / 模型</th>
                  <th>实时</th>
                  <th>输入</th>
                  <th>其中缓存</th>
                  <th>输出</th>
                  <th>命中率</th>
                  <th>费用</th>
                  <th>额度 / 单价（每百万：输入 / 缓存 / 输出）</th>
                </tr>
              </thead>
              <tbody>
                {agentNames.map((agent) => {
                  const bucket = usage.byAgent[agent] ?? {
                    inputTokens: 0,
                    cachedInputTokens: 0,
                    outputTokens: 0,
                    totalTokens: 0,
                    costUsd: 0,
                  };
                  const agentCost = computeAgentCostUsd(agent, usage, pricing);
                  const agentHit =
                    bucket.inputTokens > 0
                      ? `${Math.round((bucket.cachedInputTokens / bucket.inputTokens) * 100)}%`
                      : "—";
                  const liveRate = Math.round(liveRateByAgent[agent] ?? 0);
                  const quota = quotas[agent];
                  const modelMap = usage.byAgentModel?.[agent] ?? {};

                  return (
                    <>
                      <tr key={`agent-${agent}`} class="agent">
                        <td>
                          {agent}
                          {quota?.note ? (
                            <span
                              class="muted"
                              style={{ marginLeft: "8px", fontSize: "12px" }}
                            >
                              {quota.note}
                            </span>
                          ) : null}
                        </td>
                        <td class={liveRate > 0 ? "live" : ""}>
                          {liveRate > 0 ? `${liveRate} tok/s` : "—"}
                        </td>
                        <td>{fmtTokens(bucket.inputTokens)}</td>
                        <td>{fmtTokens(bucket.cachedInputTokens)}</td>
                        <td>{fmtTokens(bucket.outputTokens)}</td>
                        <td>{agentHit}</td>
                        <td>{fmtUsd(agentCost)}</td>
                        <td>
                          {quota ? (
                            <div class="quota-cell">
                              <span class="muted" style={{ fontSize: "11.5px" }}>
                                {quota.label}
                                {quota.resetAt ? ` · ${quota.resetAt} 重置` : ""}
                              </span>
                              <div class="quota">
                                <i
                                  class={quotaClassName(quota.usedRatio)}
                                  style={{
                                    width: `${Math.round(quota.usedRatio * 100)}%`,
                                  }}
                                />
                              </div>
                              <span>{Math.round(quota.usedRatio * 100)}%</span>
                            </div>
                          ) : (
                            <span class="muted" style={{ fontSize: "11.5px" }}>
                              无订阅窗口数据
                            </span>
                          )}
                        </td>
                      </tr>
                      {Object.entries(modelMap).map(([mName, mBucket]) => {
                        const p = pricing.models[mName];
                        const mHit =
                          mBucket.inputTokens > 0
                            ? `${Math.round((mBucket.cachedInputTokens / mBucket.inputTokens) * 100)}%`
                            : "—";
                        return (
                          <tr key={`am-${agent}-${mName}`} class="model">
                            <td>{mName}</td>
                            <td>—</td>
                            <td>{fmtTokens(mBucket.inputTokens)}</td>
                            <td>{fmtTokens(mBucket.cachedInputTokens)}</td>
                            <td>{fmtTokens(mBucket.outputTokens)}</td>
                            <td>{mHit}</td>
                            <td>{fmtUsd(computeBucketCostUsd(mName, mBucket, pricing))}</td>
                            <td class="muted" style={{ fontSize: "11.5px" }}>
                              {p ? `$${p.in} / $${p.cached} / $${p.out}` : "未配置单价"}
                            </td>
                          </tr>
                        );
                      })}
                    </>
                  );
                })}

                {!usage.byAgentModel &&
                  Object.entries(usage.byModel).map(([mName, mBucket]) => {
                    const p = pricing.models[mName];
                    const mHit =
                      mBucket.inputTokens > 0
                        ? `${Math.round((mBucket.cachedInputTokens / mBucket.inputTokens) * 100)}%`
                        : "—";
                    return (
                      <tr key={`model-${mName}`} class="model">
                        <td>{mName}</td>
                        <td>—</td>
                        <td>{fmtTokens(mBucket.inputTokens)}</td>
                        <td>{fmtTokens(mBucket.cachedInputTokens)}</td>
                        <td>{fmtTokens(mBucket.outputTokens)}</td>
                        <td>{mHit}</td>
                        <td>{fmtUsd(computeBucketCostUsd(mName, mBucket, pricing))}</td>
                        <td class="muted" style={{ fontSize: "11.5px" }}>
                          {p ? `$${p.in} / $${p.cached} / $${p.out}` : "未配置单价"}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          )}
        </section>

        <section class="u-section">
          <h3>按任务（本卡真实累计消耗，与任务详情一致）</h3>
          {rankedTasks.length > 0 ? (
            rankedTasks.map(({ task, cost }) => (
              <div
                key={task.id}
                class="rank-row"
                onClick={() => store.openTask(task.id)}
              >
                <span>
                  {task.title}{" "}
                  <span class="muted mono" style={{ fontSize: "11.5px" }}>
                    {task.id}
                  </span>
                </span>
                <div class="rank-bar">
                  <i
                    style={{
                      width: `${Math.min(100, Math.round((cost / maxRankedCost) * 100))}%`,
                    }}
                  />
                </div>
                <span class="mono">{fmtTokens(task.tokens.total_tokens)}</span>
                <span class="mono">{fmtUsd(cost)}</span>
              </div>
            ))
          ) : (
            <p class="muted" style={{ fontSize: "12.5px" }}>
              当前时间区间暂无任务消耗记录
            </p>
          )}
          <p class="muted" style={{ fontSize: "12px", marginTop: "10px" }}>
            模型单价可在{" "}
            <button
              type="button"
              class="link"
              onClick={() =>
                store.go("settings", { settingsTab: "pricing" })
              }
            >
              设置 → 模型单价
            </button>{" "}
            中修改。
          </p>
        </section>

        <p class="footnote">
          所有费用一律按 API 标价折算：（输入 − 缓存）× 输入单价 + 缓存 × 缓存单价 +
          输出 × 输出单价。若后端未提供订阅额度窗口数据，仅显示 API 折算费用。
        </p>
      </div>
    </ViewFrame>
  );
}
