import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BootstrapTask, ProviderRuntimeStatus, UsageBucketSummary } from "../api/types";
import {
  fmtCooldownShort,
  fmtDateShort,
  fmtResetLocalExact,
  fmtResetShort,
  fmtTokens,
  fmtUsd,
  stageMeta,
} from "../state/format";
import {
  computeAgentCostUsd,
  computeBucketCostUsd,
  computeGrandSavedUsd,
  computeGrandTotalCostUsd,
  computeTaskCostUsd,
  extractEffectiveQuotas,
  formatModelPricingCompact,
  formatModelPricingSummary,
  quotaClassName,
} from "../state/pricing";
import { CloseIcon } from "./Icons";
import { ProviderAvatar, formatAdapterLabel } from "./ProviderAvatar";
import { useKilnStore } from "../state/store";

type L3Target = { kind: "task"; taskId: string } | { kind: "provider"; providerId: string } | null;

interface SubscriptionSummaryItem {
  id: string;
  label: string;
  runtime: ProviderRuntimeStatus | null;
  quota: ReturnType<typeof extractEffectiveQuotas>[string] | null;
  liveRate: number;
  todayCost: number;
  todayTokens: number;
}

const L2_WIDTH = 368;
const L3_WIDTH = 296;
const VIEWPORT_MARGIN = 12;

function clampUpwardPopoverCoords(
  panelRect: DOMRect | null,
  l2Rect: DOMRect | null,
): { l2Left: number; l2Bottom: number; l3Left: number; l3Bottom: number } {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 900;
  const anchorLeft = panelRect && panelRect.left > 0 ? panelRect.left : 96;
  const anchorTop = panelRect && panelRect.top > 0 ? panelRect.top : vh - 32;

  const l2Left = Math.max(VIEWPORT_MARGIN, Math.min(anchorLeft, vw - L2_WIDTH - VIEWPORT_MARGIN));
  const l2Bottom = Math.max(36, vh - anchorTop + 4);

  const l2RightEdge = l2Rect && l2Rect.width > 0 ? l2Rect.right : l2Left + L2_WIDTH;
  const l3Left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(l2RightEdge + 8, vw - L3_WIDTH - VIEWPORT_MARGIN),
  );
  return { l2Left, l2Bottom, l3Left, l3Bottom: l2Bottom };
}

function summarizeProviderModelBuckets(
  providerId: string,
  byAgentModel: Record<string, Record<string, UsageBucketSummary>> | undefined,
  tasks: readonly BootstrapTask[],
): Array<[string, UsageBucketSummary]> {
  const fromSnap = byAgentModel?.[providerId];
  if (fromSnap && Object.keys(fromSnap).length > 0) {
    return Object.entries(fromSnap).sort((a, b) => b[1].costUsd - a[1].costUsd);
  }
  const derived: Record<string, UsageBucketSummary> = {};
  for (const t of tasks) {
    if (t.agent !== providerId || !t.tokens_by_model) continue;
    for (const [model, bucket] of Object.entries(t.tokens_by_model)) {
      const prev = derived[model] ?? {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        cacheNetSavedUsd: 0,
      };
      prev.inputTokens += bucket.inputTokens;
      prev.cachedInputTokens += bucket.cachedInputTokens;
      prev.cacheWriteTokens = (prev.cacheWriteTokens ?? 0) + (bucket.cacheWriteTokens ?? 0);
      prev.outputTokens += bucket.outputTokens;
      prev.totalTokens += bucket.totalTokens;
      prev.costUsd += bucket.costUsd;
      prev.cacheNetSavedUsd = (prev.cacheNetSavedUsd ?? 0) + (bucket.cacheNetSavedUsd ?? 0);
      derived[model] = prev;
    }
  }
  return Object.entries(derived).sort((a, b) => b[1].costUsd - a[1].costUsd);
}

function renderProviderStatusText(runtime: ProviderRuntimeStatus | null): {
  text: string;
  tone: "ok" | "warn" | "bad" | "muted";
} {
  if (!runtime) return { text: "已记录", tone: "muted" };
  if (runtime.status === "cooldown") {
    return { text: fmtCooldownShort(runtime.cooldown_until), tone: "bad" };
  }
  if (runtime.status === "auth_required") {
    return { text: "需认证", tone: "warn" };
  }
  if (runtime.status === "unavailable") {
    return { text: "未就绪", tone: "muted" };
  }
  return { text: "就绪", tone: "ok" };
}

export function UsagePanel() {
  const { store, state } = useKilnStore();
  const {
    usage,
    todayUsage,
    budget,
    pricing,
    providerUsage,
    providerStatuses,
    ratesByTask,
    liveTotals,
    tasks,
    spaces,
    limits,
  } = state;

  const [hovered, setHovered] = useState(false);
  const [l3Target, setL3Target] = useState<L3Target>(null);
  const [coords, setCoords] = useState(() => clampUpwardPopoverCoords(null, null));

  const panelRef = useRef<HTMLDivElement | null>(null);
  const l2Ref = useRef<HTMLDivElement | null>(null);
  const l3Ref = useRef<HTMLDivElement | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const closeAll = useCallback(() => {
    clearTimers();
    setHovered(false);
    setL3Target(null);
  }, [clearTimers]);

  const scheduleHoverOpen = useCallback(() => {
    if (typeof window !== "undefined" && window.innerWidth <= 820) return;
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (hovered || openTimerRef.current !== null) return;
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      setHovered(true);
    }, 60);
  }, [hovered]);

  const scheduleHoverClose = useCallback(() => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setHovered(false);
      setL3Target(null);
    }, 240);
  }, []);

  const keepAliveEnter = useCallback(() => {
    clearTimers();
    if (!hovered) {
      setHovered(true);
    }
  }, [clearTimers, hovered]);

  useEffect(() => clearTimers, [clearTimers]);

  const syncCoords = useCallback(() => {
    setCoords(
      clampUpwardPopoverCoords(
        panelRef.current?.getBoundingClientRect() ?? null,
        l2Ref.current?.getBoundingClientRect() ?? null,
      ),
    );
  }, []);

  useEffect(() => {
    if (!hovered) return;
    syncCoords();
    const raf = requestAnimationFrame(syncCoords);
    window.addEventListener("resize", syncCoords);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", syncCoords);
    };
  }, [hovered, l3Target, syncCoords]);

  useEffect(() => {
    if (!hovered) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAll();
    };
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (
        panelRef.current?.contains(target) ||
        l2Ref.current?.contains(target) ||
        l3Ref.current?.contains(target)
      ) {
        return;
      }
      closeAll();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [hovered, closeAll]);

  const parentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of tasks) {
      if (t.parent_id) ids.add(t.parent_id);
    }
    return ids;
  }, [tasks]);

  const runningLeafTasks = useMemo(() => {
    return tasks
      .filter((t) => t.status === "running" && !parentIds.has(t.id) && t.kind !== "epic")
      .sort((a, b) => (ratesByTask[b.id] ?? 0) - (ratesByTask[a.id] ?? 0));
  }, [tasks, parentIds, ratesByTask]);

  const ratesSum = Object.values(ratesByTask).reduce(
    (sum, r) => sum + (Number.isFinite(r) ? r : 0),
    0,
  );
  const totalRate = Math.round(
    Object.keys(ratesByTask).length > 0 ? ratesSum : (liveTotals?.tokPerSec ?? 0),
  );
  const heatPct =
    totalRate > 0 ? Math.min(100, Math.max(8, Math.round((totalRate / 600) * 100))) : 0;

  // Use true local-day todayUsage whenever backend provides it; preserve usage fallback for mock tests.
  const todaySnap = todayUsage ?? usage;
  const hasTodayModelBuckets = Object.keys(todaySnap.byModel).length > 0;
  const computedCost = computeGrandTotalCostUsd(todaySnap, pricing);
  const displayCostUsd =
    todayUsage !== null
      ? computedCost
      : hasTodayModelBuckets
        ? computedCost
        : (liveTotals?.costUsd ?? computedCost);
  const todaySavedUsd = computeGrandSavedUsd(todaySnap, pricing);
  const todayHitRate =
    todaySnap.inputTokens > 0
      ? Math.round((todaySnap.cachedInputTokens / todaySnap.inputTokens) * 100)
      : 0;
  const todayUncachedIn = Math.max(0, todaySnap.inputTokens - todaySnap.cachedInputTokens);
  const todayCacheWrite = todaySnap.cacheWriteTokens ?? 0;

  const liveRateByAgent: Record<string, number> = {};
  for (const t of runningLeafTasks) {
    const rate = ratesByTask[t.id] ?? 0;
    if (rate > 0 && t.agent) {
      liveRateByAgent[t.agent] = (liveRateByAgent[t.agent] ?? 0) + rate;
    }
  }

  const quotas = extractEffectiveQuotas(providerStatuses, providerUsage);
  const statusById = new Map(providerStatuses.map((p) => [p.provider_id, p]));
  const allSubIds = Array.from(
    new Set([
      ...providerStatuses.map((p) => p.provider_id),
      ...Object.keys(quotas),
      ...Object.keys(todaySnap.byAgent),
    ]),
  );

  const subscriptions: SubscriptionSummaryItem[] = allSubIds
    .map((id) => {
      const runtime = statusById.get(id) ?? null;
      const quota = quotas[id] ?? null;
      const liveRate = Math.round(liveRateByAgent[id] ?? 0);
      const todayCost = computeAgentCostUsd(id, todaySnap, pricing);
      const todayTokens = todaySnap.byAgent[id]?.totalTokens ?? 0;
      return {
        id,
        label: runtime?.label ?? id,
        runtime,
        quota,
        liveRate,
        todayCost,
        todayTokens,
      };
    })
    .sort((a, b) => {
      const score = (x: SubscriptionSummaryItem): number =>
        (x.liveRate > 0 ? 100 : 0) +
        (x.quota ? 50 : 0) +
        (x.runtime?.status === "cooldown" ? 25 : x.runtime?.status === "ready" ? 15 : 0) +
        (x.todayCost > 0 ? 10 : 0);
      return score(b) - score(a);
    });

  const quotaSubs = subscriptions.filter((s) => s.quota !== null);
  const readyProvidersCount = providerStatuses.filter((p) => p.status === "ready").length;
  const totalSubsCount = providerStatuses.length || subscriptions.length;

  const dailyRatio = budget?.daily.ratio ?? null;
  const dailyPct = dailyRatio !== null ? Math.min(999, Math.round(dailyRatio * 100)) : null;

  const activeTaskForL3 =
    l3Target?.kind === "task"
      ? (runningLeafTasks.find((t) => t.id === l3Target.taskId) ?? null)
      : null;
  const activeProviderForL3 =
    l3Target?.kind === "provider"
      ? (subscriptions.find((s) => s.id === l3Target.providerId) ?? null)
      : null;

  const todayDateText = fmtDateShort(new Date().toISOString());

  return (
    <div
      id="usagePanel"
      ref={panelRef}
      className="sb-usage-anchor"
      onMouseEnter={scheduleHoverOpen}
      onMouseMove={scheduleHoverOpen}
      onMouseLeave={scheduleHoverClose}
    >
      <div
        role="button"
        tabIndex={0}
        className={`usage-panel sb-telemetry ${hovered ? "is-open" : ""}`}
        aria-expanded={hovered}
        title="悬停查看今日实时监控 · 点击进入用量与费用"
        onClick={() => {
          closeAll();
          store.go("usage");
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            closeAll();
            store.go("usage");
          }
        }}
      >
        <span className="sb-seg sb-seg-live">
          <span className={runningLeafTasks.length > 0 ? "dot live-dot" : "dot up-idle-dot"} />
          <span className="sb-seg-label">
            {runningLeafTasks.length > 0 ? `${runningLeafTasks.length} 运行` : "待机"}
          </span>
          <span className="sb-slot mono" id="upSessions">
            {runningLeafTasks.length}/{limits.max_concurrent_slots}
          </span>
          <span className="furnace" aria-hidden="true">
            <span className="furnace-bar" style={{ width: `${heatPct}%` }} />
          </span>
          <span className="sb-rate mono">
            <b id="upTotalRate">{totalRate}</b>
            <span>tok/s</span>
          </span>
          {runningLeafTasks.length > 0 ? (
            <span className="sb-active-models">
              {runningLeafTasks.slice(0, 2).map((t) => {
                const rate = Math.round(ratesByTask[t.id] ?? 0);
                const modelLabel =
                  t.model ?? (t.agent ? `${t.agent} · 运行中` : `${stageMeta(t.stage).label}中`);
                return (
                  <span key={t.id} className="sb-model-pill">
                    <ProviderAvatar providerId={t.agent ?? "pm"} size="xs" />
                    <span className="mono sb-model-name" title={modelLabel}>
                      {modelLabel}
                    </span>
                    {rate > 0 ? <span className="mono sb-model-rate">{rate}t/s</span> : null}
                  </span>
                );
              })}
              {runningLeafTasks.length > 2 ? (
                <span className="sb-more mono">+{runningLeafTasks.length - 2}</span>
              ) : null}
            </span>
          ) : null}
        </span>

        <span className="sb-sep" aria-hidden="true" />

        <span className="sb-seg sb-seg-today">
          <span className="sb-seg-muted">今日</span>
          <b className="mono" id="upTotalCost">
            {fmtUsd(displayCostUsd)}
          </b>
          <span className="sb-dot-sep" aria-hidden="true">
            ·
          </span>
          <span className="mono sb-tok">{fmtTokens(todaySnap.totalTokens)}</span>
          {dailyPct !== null ? <span className="sb-budget-tag mono">日限{dailyPct}%</span> : null}
        </span>

        {quotaSubs.length > 0 ? (
          <>
            <span className="sb-sep" aria-hidden="true" />
            <span className="sb-seg sb-seg-quotas">
              {quotaSubs.map((sub) => {
                const pct = Math.round(sub.quota!.usedRatio * 100);
                return (
                  <span key={sub.id} className="sb-quota-chip">
                    <ProviderAvatar providerId={sub.id} size="xs" />
                    <b className="mono">{pct}%</b>
                    <span className="quota sb-mini-quota">
                      <i
                        data-up-bar={sub.id}
                        className={quotaClassName(sub.quota!.usedRatio)}
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                    <span className="sb-qmeta" data-up-qtext={sub.id}>
                      {sub.quota!.label}
                    </span>
                    {sub.quota!.resetAt ? (
                      <span
                        className="sb-qreset mono"
                        data-up-reset={sub.id}
                        title={`重置时刻 ${fmtResetLocalExact(sub.quota!.resetAt)}`}
                      >
                        {fmtResetShort(sub.quota!.resetAt)}
                      </span>
                    ) : null}
                  </span>
                );
              })}
            </span>
          </>
        ) : null}

        {totalSubsCount > 0 ? (
          <span className="sb-seg sb-seg-ready mono">
            {readyProvidersCount > 0
              ? `${readyProvidersCount}/${totalSubsCount} 订阅`
              : `${totalSubsCount} 订阅`}
          </span>
        ) : null}
      </div>

      {hovered && typeof document !== "undefined"
        ? createPortal(
            <>
              <div
                ref={l2Ref}
                role="dialog"
                aria-label="今日实时监控浮层"
                className="up-pop"
                style={{ left: `${coords.l2Left}px`, bottom: `${coords.l2Bottom}px` }}
                onMouseEnter={keepAliveEnter}
                onMouseLeave={scheduleHoverClose}
              >
                <div className="up-pop-head">
                  <div className="up-pop-title-wrap">
                    <span className="up-pop-title">今日实时监控</span>
                    <span className="up-pop-date mono">{todayDateText}</span>
                  </div>
                  <div className="up-pop-head-acts">
                    <button
                      type="button"
                      className="up-pop-link"
                      onClick={() => {
                        closeAll();
                        store.go("usage");
                      }}
                    >
                      周 / 月 / 全部 →
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="关闭监控浮层"
                      onClick={closeAll}
                    >
                      <CloseIcon />
                    </button>
                  </div>
                </div>

                <div className="up-pop-sec">
                  <div className="up-pop-sec-h">
                    <span>运行中 Agent 与模型</span>
                    <span className="mono up-pop-sec-meta">
                      {runningLeafTasks.length}/{limits.max_concurrent_slots} · {totalRate} tok/s
                    </span>
                  </div>
                  {runningLeafTasks.length === 0 ? (
                    <div className="up-pop-empty">
                      当前空闲（{runningLeafTasks.length}/{limits.max_concurrent_slots}{" "}
                      并发槽位可用）
                    </div>
                  ) : (
                    <div className="up-pop-list">
                      {runningLeafTasks.map((t) => {
                        const rate = Math.round(ratesByTask[t.id] ?? 0);
                        const cost = computeTaskCostUsd(t, pricing);
                        const modelId = t.model ?? "默认模型";
                        const modelPrice = t.model ? pricing.models[t.model] : undefined;
                        const stMeta = stageMeta(t.stage);
                        const selected = l3Target?.kind === "task" && l3Target.taskId === t.id;
                        return (
                          <button
                            key={t.id}
                            type="button"
                            className={`up-pop-row ${selected ? "on" : ""}`}
                            onMouseEnter={() => setL3Target({ kind: "task", taskId: t.id })}
                            onClick={() => setL3Target({ kind: "task", taskId: t.id })}
                          >
                            <div className="up-pop-row-top">
                              <span
                                className="up-stage-pill"
                                style={{ color: `var(${stMeta.colorVar})` }}
                              >
                                {stMeta.label}
                              </span>
                              <span className="up-pop-row-title" title={t.title}>
                                {t.title}
                              </span>
                              <span className="mono up-pop-row-rate">
                                {rate > 0 ? `${rate} tok/s` : "运行中"}
                              </span>
                            </div>
                            <div className="up-pop-row-sub">
                              <span className="up-pop-row-model">
                                <ProviderAvatar providerId={t.agent ?? "pm"} size="xs" />
                                <span className="mono">{modelId}</span>
                              </span>
                              <span className="mono up-pop-row-price">
                                {formatModelPricingCompact(modelId, modelPrice)} · {fmtUsd(cost)}
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="up-pop-sec">
                  <div className="up-pop-sec-h">
                    <span>今日用量与缓存拆解</span>
                    <span className="mono up-pop-sec-meta">00:00 至今</span>
                  </div>
                  <div className="up-pop-kpis">
                    <div className="up-pop-kpi">
                      <span>今日标价</span>
                      <b className="mono">{fmtUsd(displayCostUsd)}</b>
                    </div>
                    <div className="up-pop-kpi">
                      <span>缓存净省</span>
                      <b className="mono ok">{fmtUsd(todaySavedUsd)}</b>
                    </div>
                    <div className="up-pop-kpi">
                      <span>今日 Token</span>
                      <b className="mono">{fmtTokens(todaySnap.totalTokens)}</b>
                    </div>
                    <div className="up-pop-kpi">
                      <span>缓存命中</span>
                      <b className="mono">{todayHitRate}%</b>
                    </div>
                  </div>
                  <div className="up-pop-tokens mono">
                    <span>入 {fmtTokens(todayUncachedIn)}</span>
                    <span>读 {fmtTokens(todaySnap.cachedInputTokens)}</span>
                    <span>写 {fmtTokens(todayCacheWrite)}</span>
                    <span>出 {fmtTokens(todaySnap.outputTokens)}</span>
                  </div>
                </div>

                <div className="up-pop-sec">
                  <div className="up-pop-sec-h">
                    <span>订阅额度与今日消耗</span>
                    <span className="mono up-pop-sec-meta">{subscriptions.length} 份</span>
                  </div>
                  {subscriptions.length === 0 ? (
                    <div className="up-pop-empty">暂无已启用订阅或调用记录</div>
                  ) : (
                    <div className="up-pop-list">
                      {subscriptions.map((sub) => {
                        const statusInfo = renderProviderStatusText(sub.runtime);
                        const selected =
                          l3Target?.kind === "provider" && l3Target.providerId === sub.id;
                        const pct = sub.quota ? Math.round(sub.quota.usedRatio * 100) : null;
                        return (
                          <button
                            key={sub.id}
                            type="button"
                            className={`up-pop-row ${selected ? "on" : ""}`}
                            onMouseEnter={() =>
                              setL3Target({ kind: "provider", providerId: sub.id })
                            }
                            onClick={() => setL3Target({ kind: "provider", providerId: sub.id })}
                          >
                            <div className="up-pop-row-top">
                              <ProviderAvatar providerId={sub.id} size="xs" />
                              <span className="up-pop-row-title">{sub.label}</span>
                              {sub.quota?.note ? (
                                <span className="up-plan-tag mono">{sub.quota.note}</span>
                              ) : null}
                              <span className={`up-pill ${statusInfo.tone}`}>
                                {statusInfo.text}
                              </span>
                              <span className="mono up-pop-row-cost">{fmtUsd(sub.todayCost)}</span>
                            </div>
                            {sub.quota ? (
                              <div className="up-pop-quota-wrap">
                                <div className="up-pop-qbar">
                                  <i
                                    className={quotaClassName(sub.quota.usedRatio)}
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                                <div className="up-pop-quota-meta">
                                  <span>
                                    {sub.quota.label} 已用 {pct}%
                                  </span>
                                  <span>
                                    {sub.quota.resetAt
                                      ? `${fmtResetLocalExact(sub.quota.resetAt)} 重置`
                                      : "官方窗口"}
                                  </span>
                                </div>
                              </div>
                            ) : (
                              <div className="up-pop-row-sub">
                                <span className="muted">无官方余额接口</span>
                                <span className="mono muted">
                                  今日 {fmtTokens(sub.todayTokens)} tok
                                </span>
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {activeTaskForL3 || activeProviderForL3 ? (
                <div
                  ref={l3Ref}
                  role="dialog"
                  aria-label="详细明细浮层"
                  className="up-pop-l3"
                  style={{ left: `${coords.l3Left}px`, bottom: `${coords.l3Bottom}px` }}
                  onMouseEnter={keepAliveEnter}
                  onMouseLeave={scheduleHoverClose}
                >
                  {activeTaskForL3 ? (
                    <TaskL3Content
                      task={activeTaskForL3}
                      spaceName={spaces[activeTaskForL3.space]?.name ?? activeTaskForL3.space}
                      rate={Math.round(ratesByTask[activeTaskForL3.id] ?? 0)}
                      costUsd={computeTaskCostUsd(activeTaskForL3, pricing)}
                      modelPrice={
                        activeTaskForL3.model ? pricing.models[activeTaskForL3.model] : undefined
                      }
                      onOpenTask={() => {
                        closeAll();
                        store.openTask(activeTaskForL3.id);
                      }}
                    />
                  ) : activeProviderForL3 ? (
                    <ProviderL3Content
                      item={activeProviderForL3}
                      modelBuckets={summarizeProviderModelBuckets(
                        activeProviderForL3.id,
                        todaySnap.byAgentModel,
                        tasks,
                      )}
                      pricing={pricing}
                    />
                  ) : null}
                </div>
              ) : null}
            </>,
            document.body,
          )
        : null}
    </div>
  );
}

function TaskL3Content({
  task,
  spaceName,
  rate,
  costUsd,
  modelPrice,
  onOpenTask,
}: {
  task: BootstrapTask;
  spaceName: string;
  rate: number;
  costUsd: number;
  modelPrice: ReturnType<typeof useKilnStore>["state"]["pricing"]["models"][string] | undefined;
  onOpenTask: () => void;
}) {
  const stMeta = stageMeta(task.stage);
  const modelId = task.model ?? "未知模型";
  const uncachedIn = Math.max(0, task.tokens.input_tokens - task.tokens.cached_input_tokens);
  const cacheWrite = task.tokens.cache_write_tokens ?? 0;

  return (
    <>
      <div className="up-l3-head">
        <span className="up-stage-pill" style={{ color: `var(${stMeta.colorVar})` }}>
          {stMeta.label}
          {task.round ? ` R${task.round}` : ""}
        </span>
        <span className="up-l3-space muted">{spaceName}</span>
      </div>
      <div className="up-l3-title">{task.title}</div>
      <div className="up-l3-model-bar">
        <ProviderAvatar providerId={task.agent ?? "pm"} size="xs" />
        <span className="mono">{modelId}</span>
      </div>

      <div className="up-l3-sec">
        <div className="up-l3-sec-h">模型标价（每百万 Token）</div>
        <div className="up-l3-price mono">{formatModelPricingSummary(modelId, modelPrice)}</div>
      </div>

      <div className="up-l3-sec">
        <div className="up-l3-sec-h">当前运行用量</div>
        <div className="up-l3-grid mono">
          <span>实时速度</span>
          <b>{rate > 0 ? `${rate} tok/s` : "活跃"}</b>
          <span>本任务标价</span>
          <b>{fmtUsd(costUsd)}</b>
          <span>未命中输入</span>
          <b>{fmtTokens(uncachedIn)}</b>
          <span>缓存读 / 写</span>
          <b>
            {fmtTokens(task.tokens.cached_input_tokens)} / {fmtTokens(cacheWrite)}
          </b>
          <span>输出 Token</span>
          <b>{fmtTokens(task.tokens.output_tokens)}</b>
        </div>
      </div>

      <button type="button" className="btn btn-sm up-l3-action" onClick={onOpenTask}>
        打开任务详情 →
      </button>
    </>
  );
}

function ProviderL3Content({
  item,
  modelBuckets,
  pricing,
}: {
  item: SubscriptionSummaryItem;
  modelBuckets: Array<[string, UsageBucketSummary]>;
  pricing: ReturnType<typeof useKilnStore>["state"]["pricing"];
}) {
  const statusInfo = renderProviderStatusText(item.runtime);
  return (
    <>
      <div className="up-l3-head">
        <ProviderAvatar providerId={item.id} size="xs" />
        <span className="up-l3-prov-name">{item.label}</span>
        <span className={`up-pill ${statusInfo.tone}`}>{statusInfo.text}</span>
      </div>
      {item.runtime ? (
        <div className="up-l3-meta muted">
          {formatAdapterLabel(item.runtime.adapter)}
          {item.runtime.version ? ` · v${item.runtime.version}` : ""}
        </div>
      ) : null}

      {item.quota ? (
        <div className="up-l3-sec">
          <div className="up-l3-sec-h">官方配额窗口</div>
          <div className="up-l3-grid mono">
            <span>窗口周期</span>
            <b>{item.quota.label}</b>
            <span>已用比例</span>
            <b>{Math.round(item.quota.usedRatio * 100)}%</b>
            {item.quota.resetAt ? (
              <>
                <span>重置时刻</span>
                <b>{fmtResetLocalExact(item.quota.resetAt)}</b>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="up-l3-sec">
        <div className="up-l3-sec-h">今日按模型消耗</div>
        {modelBuckets.length === 0 ? (
          <div className="up-pop-empty">今日尚无调用记录</div>
        ) : (
          <div className="up-l3-models">
            {modelBuckets.map(([model, bucket]) => {
              const cost = computeBucketCostUsd(model, bucket, pricing);
              const hit =
                bucket.inputTokens > 0
                  ? Math.round((bucket.cachedInputTokens / bucket.inputTokens) * 100)
                  : 0;
              return (
                <div key={model} className="up-l3-model-row">
                  <div className="up-l3-model-top">
                    <span className="mono up-l3-model-id" title={model}>
                      {model}
                    </span>
                    <span className="mono">{fmtUsd(cost)}</span>
                  </div>
                  <div className="up-l3-model-sub mono muted">
                    <span>{fmtTokens(bucket.totalTokens)} tok</span>
                    <span>命中 {hit}%</span>
                    <span>{formatModelPricingCompact(model, pricing.models[model])}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
