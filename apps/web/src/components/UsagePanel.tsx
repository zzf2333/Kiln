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
import { ChevronRightIcon, CloseIcon, PinIcon } from "./Icons";
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

const L2_WIDTH = 356;
const L3_WIDTH = 296;
const VIEWPORT_MARGIN = 12;

function clampPopoverCoords(
  panelRect: DOMRect | null,
  l2Rect: DOMRect | null,
): { l2Left: number; l2Bottom: number; l3Left: number; l3Bottom: number } {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 900;
  const anchorRight = panelRect && panelRect.right > 0 ? panelRect.right : 220;
  const anchorBottom = panelRect && panelRect.bottom > 0 ? panelRect.bottom : vh - 16;

  const l2Left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(anchorRight + 10, vw - L2_WIDTH - VIEWPORT_MARGIN),
  );
  const l2Bottom = Math.max(VIEWPORT_MARGIN, Math.min(vh - anchorBottom, vh - 120));

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
    backends,
    sseStatus,
  } = state;

  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [l3Target, setL3Target] = useState<L3Target>(null);
  const [coords, setCoords] = useState(() => clampPopoverCoords(null, null));

  const panelRef = useRef<HTMLDivElement | null>(null);
  const l2Ref = useRef<HTMLDivElement | null>(null);
  const l3Ref = useRef<HTMLDivElement | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isL2Visible = pinned || hovered;

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
    setPinned(false);
    setHovered(false);
    setL3Target(null);
  }, [clearTimers]);

  const scheduleHoverOpen = useCallback(() => {
    if (typeof window !== "undefined" && window.innerWidth <= 820) return;
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (hovered || pinned) return;
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      setHovered(true);
    }, 110);
  }, [hovered, pinned]);

  const scheduleHoverClose = useCallback(() => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (pinned) return;
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setHovered(false);
      setL3Target(null);
    }, 200);
  }, [pinned]);

  const keepAliveEnter = useCallback(() => {
    clearTimers();
    if (!hovered && !pinned) {
      setHovered(true);
    }
  }, [clearTimers, hovered, pinned]);

  useEffect(() => clearTimers, [clearTimers]);

  const syncCoords = useCallback(() => {
    setCoords(
      clampPopoverCoords(
        panelRef.current?.getBoundingClientRect() ?? null,
        l2Ref.current?.getBoundingClientRect() ?? null,
      ),
    );
  }, []);

  useEffect(() => {
    if (!isL2Visible) return;
    syncCoords();
    const raf = requestAnimationFrame(syncCoords);
    window.addEventListener("resize", syncCoords);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", syncCoords);
    };
  }, [isL2Visible, l3Target, syncCoords]);

  useEffect(() => {
    if (!isL2Visible) return;
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
  }, [isL2Visible, closeAll]);

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

  const maxL1Subs = Math.max(3, subscriptions.filter((s) => s.quota !== null).length);
  const visibleL1Subs = subscriptions.slice(0, maxL1Subs);
  const hiddenL1SubCount = Math.max(0, subscriptions.length - visibleL1Subs.length);

  const dailyLimit = budget?.daily.limit_usd ?? null;
  const dailyRatio = budget?.daily.ratio ?? null;
  const dailyPct = dailyRatio !== null ? Math.min(999, Math.round(dailyRatio * 100)) : null;
  const softWarningRatio = budget?.soft_warning_ratio ?? 0.8;

  const readyProvidersCount = providerStatuses.filter((p) => p.status === "ready").length;
  const paseoConnected = backends.some(
    (b) => (b.backendId ?? b.id ?? "").toLowerCase().includes("paseo") && b.connected,
  );
  const connLabel =
    readyProvidersCount > 0
      ? providerStatuses.length > readyProvidersCount
        ? `${readyProvidersCount}/${providerStatuses.length} 订阅就绪`
        : `${readyProvidersCount} 份订阅就绪`
      : backends.length > 0
        ? paseoConnected
          ? "Paseo 已连接"
          : "底座离线"
        : sseStatus === "connected"
          ? "实时流已连接"
          : sseStatus === "reconnecting"
            ? "实时流重连中"
            : "本地工作台";

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
      className="side-bottom"
      onMouseEnter={scheduleHoverOpen}
      onMouseLeave={scheduleHoverClose}
    >
      <div
        role="button"
        tabIndex={0}
        className={`usage-panel ${isL2Visible ? "is-open" : ""}`}
        onClick={() => store.go("usage")}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            store.go("usage");
          }
        }}
      >
        <div className="up-live-head">
          <div className="up-live-status">
            <span className={runningLeafTasks.length > 0 ? "dot live-dot" : "dot up-idle-dot"} />
            <span className="up-live-title">
              {runningLeafTasks.length > 0 ? `${runningLeafTasks.length} 运行中` : "待机"}
            </span>
            <span className="up-slot-pill mono" id="upSessions">
              {runningLeafTasks.length}/{limits.max_concurrent_slots}
            </span>
          </div>
          <div className="up-total-rate mono">
            <b id="upTotalRate">{totalRate}</b>
            <span>tok/s</span>
          </div>
        </div>

        {runningLeafTasks.length > 0 ? (
          <div className="up-active-list">
            {runningLeafTasks.slice(0, 3).map((t) => {
              const rate = Math.round(ratesByTask[t.id] ?? 0);
              const cost = computeTaskCostUsd(t, pricing);
              const modelLabel =
                t.model ?? (t.agent ? `${t.agent} · 执行中` : `${stageMeta(t.stage).label}中`);
              return (
                <div key={t.id} className="up-active-row">
                  <ProviderAvatar providerId={t.agent ?? "pm"} size="xs" />
                  <span className="mono up-active-model" title={modelLabel}>
                    {modelLabel}
                  </span>
                  <span className="mono up-active-meta">
                    {rate > 0 ? `${rate}t/s` : fmtUsd(cost)}
                  </span>
                </div>
              );
            })}
            {runningLeafTasks.length > 3 ? (
              <div className="up-active-more">+{runningLeafTasks.length - 3} 个运行中</div>
            ) : null}
          </div>
        ) : null}

        <div className="up-today-grid">
          <div className="up-metric">
            <span className="up-metric-lbl">今日标价</span>
            <span className="mono up-metric-val" id="upTotalCost">
              {fmtUsd(displayCostUsd)}
            </span>
            <span className="up-metric-sub">
              {todaySavedUsd >= 0.01 ? `省 ${fmtUsd(todaySavedUsd)}` : "按 API 标价"}
            </span>
          </div>
          <div className="up-metric">
            <span className="up-metric-lbl">今日用量</span>
            <span className="mono up-metric-val">{fmtTokens(todaySnap.totalTokens)}</span>
            <span className="up-metric-sub">
              {dailyPct !== null
                ? `日限 ${dailyPct}%`
                : todayHitRate > 0
                  ? `命中 ${todayHitRate}%`
                  : "今日累计"}
            </span>
          </div>
        </div>

        {dailyLimit !== null && dailyRatio !== null ? (
          <div
            className="up-budget-bar"
            title={`今日预算 ${fmtUsd(displayCostUsd)} / ${fmtUsd(dailyLimit)}`}
          >
            <i
              className={dailyRatio >= 1 ? "bad" : dailyRatio >= softWarningRatio ? "warn" : ""}
              style={{ width: `${Math.min(100, Math.round(dailyRatio * 100))}%` }}
            />
          </div>
        ) : null}

        {visibleL1Subs.length > 0 ? (
          <div className="up-subs">
            {visibleL1Subs.map((sub) => {
              const statusBadge = renderProviderStatusText(sub.runtime);
              const pct = sub.quota ? Math.round(sub.quota.usedRatio * 100) : null;
              return (
                <div key={sub.id} className="up-agent">
                  <div className="up-row">
                    <span className="up-agent-left">
                      <ProviderAvatar providerId={sub.id} size="xs" />
                      <span className="up-agent-name" title={sub.label}>
                        {sub.label}
                      </span>
                      {sub.liveRate > 0 ? (
                        <span className="up-live" data-up-live={sub.id}>
                          {sub.liveRate}t/s
                        </span>
                      ) : null}
                    </span>
                    <span className="up-agent-right">
                      {sub.runtime?.status === "cooldown" ? (
                        <span className="up-pill bad">{statusBadge.text}</span>
                      ) : sub.runtime?.status === "auth_required" ||
                        sub.runtime?.status === "unavailable" ? (
                        <span className="up-pill muted">{statusBadge.text}</span>
                      ) : pct !== null ? (
                        <span className="mono up-pct-val" data-up-cost={sub.id}>
                          {pct}%
                        </span>
                      ) : (
                        <span className="mono up-cost-val" data-up-cost={sub.id}>
                          {fmtUsd(sub.todayCost)}
                        </span>
                      )}
                    </span>
                  </div>
                  {sub.quota ? (
                    <>
                      <div className="quota">
                        <i
                          data-up-bar={sub.id}
                          className={quotaClassName(sub.quota.usedRatio)}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="up-sub">
                        <span data-up-qtext={sub.id}>{sub.quota.label}</span>
                        <span
                          data-up-reset={sub.id}
                          title={
                            sub.quota.resetAt
                              ? `重置时刻 ${fmtResetLocalExact(sub.quota.resetAt)}`
                              : undefined
                          }
                        >
                          {fmtResetShort(sub.quota.resetAt)}
                        </span>
                      </div>
                    </>
                  ) : null}
                </div>
              );
            })}
            {hiddenL1SubCount > 0 ? (
              <div className="up-active-more">+{hiddenL1SubCount} 份订阅在浮层查看</div>
            ) : null}
          </div>
        ) : null}

        <div className="up-foot">
          <span className="up-conn">{connLabel}</span>
          <div className="up-foot-actions">
            <button
              type="button"
              className={`up-pop-toggle ${pinned ? "on" : ""}`}
              data-up-pop-toggle="true"
              aria-label={pinned ? "收起实时监控浮层" : "展开实时监控浮层"}
              aria-expanded={isL2Visible}
              title="展开/固定实时监控浮层"
              onClick={(e) => {
                e.stopPropagation();
                clearTimers();
                setPinned((prev) => {
                  const next = !prev;
                  setHovered(next);
                  if (!next) setL3Target(null);
                  return next;
                });
              }}
            >
              <ChevronRightIcon />
            </button>
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

      {isL2Visible && typeof document !== "undefined"
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
                      className={`icon-btn ${pinned ? "on" : ""}`}
                      aria-label={pinned ? "取消固定浮层" : "固定浮层"}
                      title={pinned ? "取消固定" : "固定面板"}
                      onClick={() => setPinned((p) => !p)}
                    >
                      <PinIcon />
                    </button>
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
                            onClick={() => {
                              setPinned(true);
                              setL3Target({ kind: "task", taskId: t.id });
                            }}
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
                            onClick={() => {
                              setPinned(true);
                              setL3Target({ kind: "provider", providerId: sub.id });
                            }}
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
