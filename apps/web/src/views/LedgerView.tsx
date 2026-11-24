import { useCallback, useEffect, useState } from "react";
import type { ImprovementTargetKind } from "@kiln/protocol/web";
import {
  approveImprovementProposal,
  dismissImprovementProposal,
  fetchImprovementsSummary,
  rollbackPolicyChange,
  runImprovementsAnalyze,
} from "../api/client";
import type { ImprovementsSummaryResponse } from "../api/types";
import { LedgerIcon } from "../components/Icons";
import { ViewFrame } from "../components/ViewFrame";
import { fmtDateShort, fmtTime, fmtUsd } from "../state/format";
import { useKilnStore } from "../state/store";

type LedgerTab = "ledger" | "inbox" | "analytics";

const TARGET_KIND_LABELS: Record<ImprovementTargetKind, string> = {
  space_ledger: "空间账本新增",
  space_ledger_merge: "空间账本去重合并",
  space_ledger_archive: "空间账本归档剪枝",
  space_intake_checklist: "PM 立项追问清单",
  space_accept_scenario: "真实验收必测场景",
  roster_custom_instructions: "角色固定补充指令",
  roster_policy: "PM 编排路由策略",
  space_default_workflow: "空间默认工作流预设",
};

function fmtPct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function LedgerView() {
  const { store, state } = useKilnStore();
  const { ledgers, spaces, tasks } = state;

  const [tab, setTab] = useState<LedgerTab>("ledger");
  const [summary, setSummary] = useState<ImprovementsSummaryResponse | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadSummary = useCallback(async (showError: boolean) => {
    setLoadingSummary(true);
    try {
      const res = await fetchImprovementsSummary();
      setSummary(res);
      setActionError(null);
    } catch (err) {
      if (showError) {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoadingSummary(false);
    }
  }, []);

  useEffect(() => {
    void loadSummary(tab !== "ledger");
  }, [tab, loadSummary]);

  const groups = Object.entries(ledgers).filter(([, entries]) => entries.length > 0);
  const totalCount = groups.reduce((acc, [, entries]) => acc + entries.length, 0);
  const knownTaskIds = new Set(tasks.map((t) => t.id));

  const proposals = summary?.proposals ?? [];
  const pendingProposals = proposals.filter((p) => p.status === "pending");
  const sortedProposals = [...proposals].sort((a, b) => {
    const aPend = a.status === "pending" ? 0 : 1;
    const bPend = b.status === "pending" ? 0 : 1;
    if (aPend !== bPend) return aPend - bPend;
    return b.created_at.localeCompare(a.created_at);
  });

  const policyHistory = summary?.policyHistory ?? [];
  const activeAlerts = policyHistory.filter((h) => h.regression_alert && !h.rolled_back_at).length;
  const analytics = summary?.analytics ?? null;

  const handleAnalyze = async () => {
    setAnalyzing(true);
    setActionError(null);
    try {
      const res = await runImprovementsAnalyze();
      setSummary(res);
      store.showToast(
        res.createdCount > 0
          ? `已扫描生成 ${res.createdCount} 条改进提案`
          : "暂未发现新的待优化问题",
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  };

  const handleApprove = async (proposalId: string) => {
    setBusyId(proposalId);
    setActionError(null);
    try {
      await approveImprovementProposal(proposalId);
      await loadSummary(true);
      await store.bootstrap();
      store.showToast("提案已批准生效，并已记录政策变更快照");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleDismiss = async (proposalId: string) => {
    setBusyId(proposalId);
    setActionError(null);
    try {
      await dismissImprovementProposal(proposalId);
      await loadSummary(true);
      store.showToast("已驳回该改进提案");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleRollback = async (changeId: string) => {
    setBusyId(changeId);
    setActionError(null);
    try {
      await rollbackPolicyChange(changeId);
      await loadSummary(true);
      await store.bootstrap();
      store.showToast("已一键回滚该策略变更");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

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
      right={
        <div className="tabs" role="tablist" aria-label="复利治理标签页">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "ledger"}
            className={`tab${tab === "ledger" ? " on" : ""}`}
            onClick={() => setTab("ledger")}
          >
            决策账本
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "inbox"}
            className={`tab${tab === "inbox" ? " on" : ""}`}
            onClick={() => setTab("inbox")}
          >
            改进提案收件箱
            {pendingProposals.length > 0 ? ` (${pendingProposals.length})` : ""}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "analytics"}
            className={`tab${tab === "analytics" ? " on" : ""}`}
            onClick={() => setTab("analytics")}
          >
            编排效能与回滚
            {activeAlerts > 0 ? ` · ${activeAlerts} 告警` : ""}
          </button>
        </div>
      }
    >
      <div className="page">
        <div className="page-inner">
          {tab === "ledger" ? (
            <>
              <p className="page-lede">
                你在「等你决定」中明确勾选写入账本的规则会沉淀于此；后续立项与审查都会先读取，避免同一约束反复打断你（单空间注入上限
                20 条活跃规则）。
              </p>
              {groups.length > 0 ? (
                groups.map(([spaceId, entries]) => {
                  const spaceCfg = spaces[spaceId];
                  const spaceName = spaceCfg?.name ?? spaceId;
                  const checklist = spaceCfg?.intake_checklist ?? [];
                  const acceptScenarios = spaceCfg?.accept_scenarios ?? [];
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
                        const isArchived = entry.status === "archived";
                        return (
                          <div key={entry.id} className="ledger-row">
                            <div className="ledger-row-main">
                              <span>{entry.rule}</span>
                              {isArchived ? <span className="chip">已归档</span> : null}
                              {(entry.hit_count ?? 0) > 0 ? (
                                <span className="chip">命中 {entry.hit_count} 次</span>
                              ) : null}
                            </div>
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
                      {checklist.length > 0 ||
                      acceptScenarios.length > 0 ||
                      spaceCfg?.default_workflow_preset ? (
                        <div className="ledger-space-rules">
                          {spaceCfg?.default_workflow_preset ? (
                            <div>
                              <strong>默认工作流预设：</strong>
                              <span className="mono">{spaceCfg.default_workflow_preset}</span>
                            </div>
                          ) : null}
                          {checklist.length > 0 ? (
                            <div>
                              <strong>PM 立项必查项（{checklist.length}）：</strong>
                              {checklist.join("；")}
                            </div>
                          ) : null}
                          {acceptScenarios.length > 0 ? (
                            <div>
                              <strong>真实验收必测场景（{acceptScenarios.length}）：</strong>
                              {acceptScenarios.join("；")}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
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
            </>
          ) : null}

          {tab === "inbox" ? (
            <>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                  marginBottom: "14px",
                  flexWrap: "wrap",
                }}
              >
                <p className="page-lede" style={{ margin: 0 }}>
                  所有复盘归因、账本去重合并与统计路由建议都必须在此经你确认后才会生效；禁止绕过验收或削弱门禁。
                </p>
                <button
                  type="button"
                  className="btn btn-light"
                  disabled={analyzing}
                  onClick={() => void handleAnalyze()}
                >
                  {analyzing ? "扫描中…" : "重新扫描分析（0 Token）"}
                </button>
              </div>

              {actionError ? (
                <p className="retro-err" style={{ marginBottom: "10px" }}>
                  {actionError}
                </p>
              ) : null}

              {loadingSummary && !summary ? (
                <p className="muted">正在加载改进提案…</p>
              ) : sortedProposals.length > 0 ? (
                sortedProposals.map((prop) => {
                  const statusLabel =
                    prop.status === "pending"
                      ? "待审批"
                      : prop.status === "approved"
                        ? "已生效"
                        : "已驳回";
                  return (
                    <section key={prop.id} className="proposal-card">
                      <div className="proposal-card-head">
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            flexWrap: "wrap",
                          }}
                        >
                          <strong>{prop.title}</strong>
                          <span className="chip">{TARGET_KIND_LABELS[prop.target_kind]}</span>
                          {prop.space ? (
                            <span className="chip">{spaces[prop.space]?.name ?? prop.space}</span>
                          ) : null}
                          <span className={`chip${prop.status === "pending" ? " chip-warn" : ""}`}>
                            {statusLabel}
                          </span>
                        </div>
                        <span className="mono muted" style={{ fontSize: "11.5px" }}>
                          {fmtTime(prop.created_at)}
                        </span>
                      </div>
                      <p style={{ fontSize: "13px", color: "var(--t2)" }}>{prop.rationale}</p>
                      <p style={{ fontSize: "12px", color: "var(--t3)" }}>
                        预期效果：{prop.expected_impact}
                      </p>
                      {prop.evidence_task_ids.length > 0 ? (
                        <div
                          style={{
                            display: "flex",
                            gap: "6px",
                            flexWrap: "wrap",
                            alignItems: "center",
                          }}
                        >
                          <span className="muted" style={{ fontSize: "12px" }}>
                            证据任务：
                          </span>
                          {prop.evidence_task_ids.map((tid) =>
                            knownTaskIds.has(tid) ? (
                              <button
                                key={tid}
                                type="button"
                                className="src src-btn mono"
                                onClick={() => store.openTask(tid)}
                              >
                                {tid}
                              </button>
                            ) : (
                              <span key={tid} className="chip mono">
                                {tid}
                              </span>
                            ),
                          )}
                        </div>
                      ) : null}
                      {prop.status === "pending" ? (
                        <div className="proposal-actions">
                          <button
                            type="button"
                            className="btn btn-light btn-sm"
                            disabled={busyId === prop.id}
                            onClick={() => void handleApprove(prop.id)}
                          >
                            批准生效
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busyId === prop.id}
                            onClick={() => void handleDismiss(prop.id)}
                          >
                            驳回
                          </button>
                        </div>
                      ) : null}
                    </section>
                  );
                })
              ) : (
                <p className="empty">
                  暂无待处理改进提案
                  <br />
                  可点击「重新扫描分析（0 Token）」汇总已完成任务的执行与成本统计
                </p>
              )}
            </>
          ) : null}

          {tab === "analytics" ? (
            <>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                  marginBottom: "14px",
                  flexWrap: "wrap",
                }}
              >
                <p className="page-lede" style={{ margin: 0 }}>
                  0-Token
                  聚合统计各项目、角色/模型与预设效率；已批准的策略会持续比对变更前后窗口并支持一键回滚。
                </p>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={loadingSummary}
                  onClick={() => void loadSummary(true)}
                >
                  刷新统计
                </button>
              </div>

              {actionError ? (
                <p className="retro-err" style={{ marginBottom: "10px" }}>
                  {actionError}
                </p>
              ) : null}

              {analytics ? (
                <>
                  <div className="analytics-kpi-grid">
                    <div className="analytics-kpi">
                      <span>已终态任务数</span>
                      <strong className="mono">{analytics.overall.task_count}</strong>
                    </div>
                    <div className="analytics-kpi">
                      <span>一次通过率</span>
                      <strong className="mono">{fmtPct(analytics.overall.first_pass_rate)}</strong>
                    </div>
                    <div className="analytics-kpi">
                      <span>平均返工轮次</span>
                      <strong className="mono">
                        {analytics.overall.avg_rework_rounds.toFixed(2)}
                      </strong>
                    </div>
                    <div className="analytics-kpi">
                      <span>缓存命中率</span>
                      <strong className="mono">{fmtPct(analytics.overall.cache_hit_rate)}</strong>
                    </div>
                    <div className="analytics-kpi">
                      <span>中位单卡费用</span>
                      <strong className="mono">{fmtUsd(analytics.overall.median_cost_usd)}</strong>
                    </div>
                  </div>

                  {analytics.by_role_model.length > 0 ? (
                    <>
                      <h3 style={{ fontSize: "13px", marginBottom: "8px" }}>角色 / 模型效率分布</h3>
                      <table className="analytics-table">
                        <thead>
                          <tr>
                            <th>角色</th>
                            <th>Agent / 模型</th>
                            <th>Run 数</th>
                            <th>通过率</th>
                            <th>升级率</th>
                            <th>缓存命中</th>
                            <th>平均费用</th>
                          </tr>
                        </thead>
                        <tbody>
                          {analytics.by_role_model.map((row) => (
                            <tr key={`${row.roster_role}-${row.agent}-${row.model}`}>
                              <td className="mono">{row.roster_role}</td>
                              <td className="mono">
                                {row.agent} · {row.model}
                              </td>
                              <td className="mono">{row.run_count}</td>
                              <td className="mono">{fmtPct(row.pass_rate)}</td>
                              <td className="mono">{fmtPct(row.escalation_rate)}</td>
                              <td className="mono">{fmtPct(row.cache_hit_rate)}</td>
                              <td className="mono">{fmtUsd(row.avg_cost_usd)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  ) : null}

                  {analytics.by_workflow_preset.length > 0 ? (
                    <>
                      <h3 style={{ fontSize: "13px", marginBottom: "8px" }}>工作流预设表现</h3>
                      <table className="analytics-table">
                        <thead>
                          <tr>
                            <th>预设</th>
                            <th>任务数</th>
                            <th>一次通过率</th>
                            <th>平均返工</th>
                            <th>中位费用</th>
                          </tr>
                        </thead>
                        <tbody>
                          {analytics.by_workflow_preset.map((row) => (
                            <tr key={row.preset}>
                              <td className="mono">{row.preset}</td>
                              <td className="mono">{row.metrics.task_count}</td>
                              <td className="mono">{fmtPct(row.metrics.first_pass_rate)}</td>
                              <td className="mono">{row.metrics.avg_rework_rounds.toFixed(2)}</td>
                              <td className="mono">{fmtUsd(row.metrics.median_cost_usd)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  ) : null}
                </>
              ) : null}

              <h3 style={{ fontSize: "13px", marginBottom: "8px" }}>
                策略变更与 Before / After 回滚审计
              </h3>
              {policyHistory.length > 0 ? (
                policyHistory.map((rec) => (
                  <section key={rec.id} className="proposal-card">
                    <div className="proposal-card-head">
                      <div
                        style={{
                          display: "flex",
                          gap: "8px",
                          alignItems: "center",
                          flexWrap: "wrap",
                        }}
                      >
                        <strong>{rec.summary}</strong>
                        <span className="chip">{TARGET_KIND_LABELS[rec.target_kind]}</span>
                        <span className="chip mono">{rec.target_ref}</span>
                        {rec.rolled_back_at ? (
                          <span className="chip">已回滚</span>
                        ) : rec.regression_alert ? (
                          <span className="chip chip-warn">负优化告警</span>
                        ) : (
                          <span className="chip">生效中</span>
                        )}
                      </div>
                      <span className="mono muted" style={{ fontSize: "11.5px" }}>
                        {fmtTime(rec.applied_at)}
                      </span>
                    </div>

                    <div className="retro-metrics">
                      <span>
                        变更前（{rec.before_metrics.task_count} 卡）：通过率{" "}
                        <b className="mono">{fmtPct(rec.before_metrics.first_pass_rate)}</b>
                        ，平均返工{" "}
                        <b className="mono">{rec.before_metrics.avg_rework_rounds.toFixed(1)}</b>
                        ，中位费用{" "}
                        <b className="mono">{fmtUsd(rec.before_metrics.median_cost_usd)}</b>
                      </span>
                      <span>
                        变更后（{rec.after_metrics.task_count} 卡）：通过率{" "}
                        <b className="mono">{fmtPct(rec.after_metrics.first_pass_rate)}</b>
                        ，平均返工{" "}
                        <b className="mono">{rec.after_metrics.avg_rework_rounds.toFixed(1)}</b>
                        ，中位费用{" "}
                        <b className="mono">{fmtUsd(rec.after_metrics.median_cost_usd)}</b>
                      </span>
                    </div>

                    {rec.regression_alert ? (
                      <div className="policy-regression-alert">
                        检测到指标退化：{rec.regression_reasons.join("；")}
                      </div>
                    ) : null}

                    {!rec.rolled_back_at ? (
                      <div className="proposal-actions">
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busyId === rec.id}
                          onClick={() => void handleRollback(rec.id)}
                        >
                          一键回滚
                        </button>
                      </div>
                    ) : null}
                  </section>
                ))
              ) : (
                <p className="muted" style={{ fontSize: "12.5px" }}>
                  尚无已批准的策略变更记录。
                </p>
              )}
            </>
          ) : null}
        </div>
      </div>
    </ViewFrame>
  );
}
