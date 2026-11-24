import { Fragment, useState } from "react";
import { RefreshIcon } from "../components/Icons";
import { ProviderAvatar } from "../components/ProviderAvatar";
import { ViewFrame } from "../components/ViewFrame";
import { fmtTokens, fmtUsd } from "../state/format";
import {
  computeAgentCostUsd,
  computeBucketCostUsd,
  computeBucketSavedUsd,
  computeGrandSavedUsd,
  computeGrandTotalCostUsd,
  computeTaskCostUsd,
  extractEffectiveQuotas,
  formatModelPricingSummary,
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
    budget,
    pricing,
    pricingSyncBusy,
    providerUsage,
    providerStatuses,
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
  const totalCacheWrite = usage.cacheWriteTokens ?? 0;
  const totalUncachedIn = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cacheHitRate =
    usage.inputTokens > 0 ? Math.round((usage.cachedInputTokens / usage.inputTokens) * 100) : 0;

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

  const statusByProvider = new Map(providerStatuses.map((p) => [p.provider_id, p]));
  const quotas = extractEffectiveQuotas(providerStatuses, providerUsage);
  const agentNames = Array.from(new Set([...Object.keys(usage.byAgent), ...Object.keys(quotas)]));

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

  const maxRankedCost = rankedTasks.length ? Math.max(rankedTasks[0]!.cost, 0.01) : 1;

  return (
    <ViewFrame
      left={
        <>
          <h1 className="tb-title">用量与费用</h1>
          <span className="tb-sub">按 API 标价折算（入·读·写·出）· 不伪造官方余额</span>
        </>
      }
      right={
        <>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={pricingSyncBusy}
            onClick={() => void store.syncPricing({ force: true })}
          >
            <RefreshIcon />
            <span>{pricingSyncBusy ? "同步中…" : "同步单价"}</span>
          </button>
          <div className="seg" role="group" aria-label="统计区间">
            {USAGE_PERIODS.map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={usagePeriod === k ? "on" : ""}
                onClick={() => setUsagePeriod(k)}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      }
    >
      <div className="page">
        <dl className="stats">
          <div className="stat">
            <dt>折算总费用</dt>
            <dd>{fmtUsd(totalCostUsd)}</dd>
            <p>按 API 标价折算（含缓存写溢价）</p>
          </div>
          <div className="stat">
            <dt>Token 合计</dt>
            <dd>{fmtTokens(usage.totalTokens)}</dd>
            <p>
              新 {fmtTokens(totalUncachedIn)} · 读 {fmtTokens(usage.cachedInputTokens)} · 写{" "}
              {fmtTokens(totalCacheWrite)} · 出 {fmtTokens(usage.outputTokens)}
            </p>
          </div>
          <div className="stat">
            <dt>缓存命中率</dt>
            <dd>{cacheHitRate}%</dd>
            <p>缓存省下约 {fmtUsd(savedUsd)}（已扣写溢价）</p>
          </div>
          <div className="stat">
            <dt>当前输出</dt>
            <dd>
              {totalRate} <span style={{ fontSize: "13px", color: "var(--t3)" }}>tok/s</span>
            </dd>
            <p>{runningLeaves.length} 个任务在跑</p>
          </div>
        </dl>

        <section className="budget-card" aria-label="USD 预算水位">
          <div className="budget-card-head">
            <div>
              <h3>USD 预算水位与熔断</h3>
              <p className="muted" style={{ fontSize: "12px" }}>
                基于已落盘 usage_turns 账本折算（软预警{" "}
                {Math.round((budget?.soft_warning_ratio ?? 0.8) * 100)}%，
                {budget?.exclude_subscription_providers
                  ? "已排除包月订阅 Provider"
                  : "含全部已计价 Provider"}
                ）
              </p>
            </div>
          </div>
          {budget && (budget.daily.limit_usd !== null || budget.monthly.limit_usd !== null) ? (
            <div className="budget-grid">
              {[
                { key: "daily", label: "当日预算", item: budget.daily },
                { key: "monthly", label: "当月预算", item: budget.monthly },
              ].map(({ key, label, item }) => {
                const pct = item.ratio !== null ? Math.min(100, Math.round(item.ratio * 100)) : 0;
                const badgeText =
                  item.level === "exceeded" ? "已熔断" : item.level === "warning" ? "预警" : "正常";
                const meterClass =
                  item.level === "exceeded" ? "bad" : item.level === "warning" ? "warn" : "ok";
                return (
                  <div key={key} className="budget-item">
                    <div className="budget-item-row">
                      <strong>{label}</strong>
                      <span className={`chip budget-badge budget-${item.level}`}>
                        {item.limit_usd !== null ? badgeText : "未设上限"}
                      </span>
                    </div>
                    <div className="budget-item-row mono" style={{ fontSize: "12.5px" }}>
                      <span>{fmtUsd(item.spent_usd)}</span>
                      <span className="muted">
                        {item.limit_usd !== null
                          ? `/ ${fmtUsd(item.limit_usd)} (${pct}%)`
                          : "/ 不限制"}
                      </span>
                    </div>
                    {item.limit_usd !== null ? (
                      <div className="meter">
                        <i className={meterClass} style={{ width: `${pct}%` }} />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted" style={{ fontSize: "12.5px" }}>
              尚未配置全局每日或每月 USD 上限；可在「系统设置 →
              限额与熔断」开启金额级软预警与硬熔断。
            </p>
          )}
        </section>

        <section className="u-section">
          <h3>按 Agent 与模型</h3>
          {agentNames.length === 0 && Object.keys(usage.byModel).length === 0 ? (
            <p className="empty">暂无已记录的回合用量</p>
          ) : (
            <table className="ut">
              <thead>
                <tr>
                  <th>Agent / 模型</th>
                  <th>实时</th>
                  <th>新输入</th>
                  <th>缓存读</th>
                  <th>缓存写</th>
                  <th>输出</th>
                  <th>命中 · 净省</th>
                  <th>费用</th>
                  <th>额度 / 单价（入·读·写·出）</th>
                </tr>
              </thead>
              <tbody>
                {agentNames.map((agent) => {
                  const bucket = usage.byAgent[agent] ?? {
                    inputTokens: 0,
                    cachedInputTokens: 0,
                    cacheWriteTokens: 0,
                    outputTokens: 0,
                    totalTokens: 0,
                    costUsd: 0,
                  };
                  const uncached = Math.max(0, bucket.inputTokens - bucket.cachedInputTokens);
                  const cacheWrite = bucket.cacheWriteTokens ?? 0;
                  const agentCost = computeAgentCostUsd(agent, usage, pricing);
                  const agentHit =
                    bucket.inputTokens > 0
                      ? `${Math.round((bucket.cachedInputTokens / bucket.inputTokens) * 100)}%`
                      : "—";
                  const liveRate = Math.round(liveRateByAgent[agent] ?? 0);
                  const quota = quotas[agent];
                  const provStatus = statusByProvider.get(agent);
                  const isCooldown = provStatus?.status === "cooldown";
                  const modelMap = usage.byAgentModel?.[agent] ?? {};

                  return (
                    <Fragment key={`agent-group-${agent}`}>
                      <tr key={`agent-${agent}`} className="agent">
                        <td>
                          <span
                            style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}
                          >
                            <ProviderAvatar providerId={agent} />
                            <span>{agent}</span>
                            {quota?.note ? (
                              <span className="muted" style={{ fontSize: "12px" }}>
                                {quota.note}
                              </span>
                            ) : null}
                          </span>
                        </td>
                        <td className={liveRate > 0 ? "live" : ""}>
                          {liveRate > 0 ? `${liveRate} tok/s` : "—"}
                        </td>
                        <td>{fmtTokens(uncached)}</td>
                        <td>{fmtTokens(bucket.cachedInputTokens)}</td>
                        <td>{fmtTokens(cacheWrite)}</td>
                        <td>{fmtTokens(bucket.outputTokens)}</td>
                        <td>{agentHit}</td>
                        <td>{fmtUsd(agentCost)}</td>
                        <td>
                          {isCooldown ? (
                            <span className="chip chip-ask">
                              429 冷却中
                              {provStatus?.cooldown_until ? ` · ${provStatus.cooldown_until}` : ""}
                            </span>
                          ) : quota ? (
                            <div className="quota-cell">
                              <span className="muted" style={{ fontSize: "11.5px" }}>
                                {quota.label}
                                {quota.resetAt ? ` · ${quota.resetAt} 重置` : ""}
                              </span>
                              <div className="quota">
                                <i
                                  className={quotaClassName(quota.usedRatio)}
                                  style={{
                                    width: `${Math.round(quota.usedRatio * 100)}%`,
                                  }}
                                />
                              </div>
                              <span>{Math.round(quota.usedRatio * 100)}%</span>
                            </div>
                          ) : (
                            <span className="muted" style={{ fontSize: "11.5px" }}>
                              无订阅窗口数据
                            </span>
                          )}
                        </td>
                      </tr>
                      {Object.entries(modelMap).map(([mName, mBucket]) => {
                        const p = pricing.models[mName];
                        const mUncached = Math.max(
                          0,
                          mBucket.inputTokens - mBucket.cachedInputTokens,
                        );
                        const mWrite = mBucket.cacheWriteTokens ?? 0;
                        const mHit =
                          mBucket.inputTokens > 0
                            ? `${Math.round((mBucket.cachedInputTokens / mBucket.inputTokens) * 100)}%`
                            : "—";
                        const mSaved = p ? computeBucketSavedUsd(mName, mBucket, pricing) : null;
                        return (
                          <tr key={`am-${agent}-${mName}`} className="model">
                            <td>{mName}</td>
                            <td>—</td>
                            <td>{fmtTokens(mUncached)}</td>
                            <td>{fmtTokens(mBucket.cachedInputTokens)}</td>
                            <td>{fmtTokens(mWrite)}</td>
                            <td>{fmtTokens(mBucket.outputTokens)}</td>
                            <td>{mSaved !== null ? `${mHit} · ${fmtUsd(mSaved)}` : mHit}</td>
                            <td>{fmtUsd(computeBucketCostUsd(mName, mBucket, pricing))}</td>
                            <td className="muted" style={{ fontSize: "11.5px" }}>
                              {p ? (
                                formatModelPricingSummary(mName, p)
                              ) : (
                                <button
                                  type="button"
                                  className="link"
                                  onClick={() => store.go("settings", { settingsTab: "pricing" })}
                                >
                                  未配置单价 · 补录
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  );
                })}

                {!usage.byAgentModel &&
                  Object.entries(usage.byModel).map(([mName, mBucket]) => {
                    const p = pricing.models[mName];
                    const mUncached = Math.max(0, mBucket.inputTokens - mBucket.cachedInputTokens);
                    const mWrite = mBucket.cacheWriteTokens ?? 0;
                    const mHit =
                      mBucket.inputTokens > 0
                        ? `${Math.round((mBucket.cachedInputTokens / mBucket.inputTokens) * 100)}%`
                        : "—";
                    const mSaved = p ? computeBucketSavedUsd(mName, mBucket, pricing) : null;
                    return (
                      <tr key={`model-${mName}`} className="model">
                        <td>{mName}</td>
                        <td>—</td>
                        <td>{fmtTokens(mUncached)}</td>
                        <td>{fmtTokens(mBucket.cachedInputTokens)}</td>
                        <td>{fmtTokens(mWrite)}</td>
                        <td>{fmtTokens(mBucket.outputTokens)}</td>
                        <td>{mSaved !== null ? `${mHit} · ${fmtUsd(mSaved)}` : mHit}</td>
                        <td>{fmtUsd(computeBucketCostUsd(mName, mBucket, pricing))}</td>
                        <td className="muted" style={{ fontSize: "11.5px" }}>
                          {p ? (
                            formatModelPricingSummary(mName, p)
                          ) : (
                            <button
                              type="button"
                              className="link"
                              onClick={() => store.go("settings", { settingsTab: "pricing" })}
                            >
                              未配置单价 · 补录
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          )}
        </section>

        <section className="u-section">
          <h3>阶段缓存与热复用效率</h3>
          {usage.warmSessionStats && usage.warmSessionStats.totalImplementRuns > 0 && (
            <p className="muted" style={{ fontSize: "12.5px", marginBottom: "8px" }}>
              implement 热复用 {usage.warmSessionStats.reusedImplementRuns}/
              {usage.warmSessionStats.totalImplementRuns} 次 · 热命中{" "}
              {usage.warmSessionStats.warmCacheHitRate}% vs 冷命中{" "}
              {usage.warmSessionStats.coldCacheHitRate}%
            </p>
          )}
          {usage.byStage && Object.keys(usage.byStage).length > 0 ? (
            <table className="u-table">
              <thead>
                <tr>
                  <th>阶段</th>
                  <th>Run 数</th>
                  <th>热复用</th>
                  <th>缓存命中率</th>
                  <th>缓存净省</th>
                  <th>费用</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(usage.byStage).map(([stageName, bucket]) => {
                  const hitPct =
                    bucket.inputTokens > 0
                      ? `${Math.round((bucket.cachedInputTokens / bucket.inputTokens) * 100)}%`
                      : "—";
                  return (
                    <tr key={`stage-${stageName}`}>
                      <td className="mono">{stageName}</td>
                      <td>{bucket.runCount}</td>
                      <td>{bucket.reusedRunCount > 0 ? bucket.reusedRunCount : "—"}</td>
                      <td>{hitPct}</td>
                      <td>
                        {(bucket.cacheNetSavedUsd ?? 0) > 0
                          ? fmtUsd(bucket.cacheNetSavedUsd ?? 0)
                          : "—"}
                      </td>
                      <td>{fmtUsd(bucket.costUsd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="muted" style={{ fontSize: "12.5px" }}>
              尚无分阶段缓存观测数据（执行新 Run 后自动记录）
            </p>
          )}
        </section>

        <section className="u-section">
          <h3>按任务（本卡真实累计消耗，与任务详情一致）</h3>
          {rankedTasks.length > 0 ? (
            rankedTasks.map(({ task, cost }) => (
              <div key={task.id} className="rank-row" onClick={() => store.openTask(task.id)}>
                <span>
                  {task.title}{" "}
                  <span className="muted mono" style={{ fontSize: "11.5px" }}>
                    {task.id}
                  </span>
                </span>
                <div className="rank-bar">
                  <i
                    style={{
                      width: `${Math.min(100, Math.round((cost / maxRankedCost) * 100))}%`,
                    }}
                  />
                </div>
                <span className="mono">{fmtTokens(task.tokens.total_tokens)}</span>
                <span className="mono">{fmtUsd(cost)}</span>
              </div>
            ))
          ) : (
            <p className="muted" style={{ fontSize: "12.5px" }}>
              当前时间区间暂无任务消耗记录
            </p>
          )}
          <p className="muted" style={{ fontSize: "12px", marginTop: "10px" }}>
            模型单价可在{" "}
            <button
              type="button"
              className="link"
              onClick={() => store.go("settings", { settingsTab: "pricing" })}
            >
              设置 → 模型单价
            </button>{" "}
            中修改。
          </p>
        </section>

        <p className="footnote">
          所有费用一律按 API 标价折算：新输入 × 输入单价 + 缓存读 × 缓存单价 + 缓存写 ×
          写缓存单价（Claude 默认 1.25×） + 输出 × 输出单价。若后端未提供订阅额度窗口数据，仅显示
          API 折算费用。
        </p>
      </div>
    </ViewFrame>
  );
}
