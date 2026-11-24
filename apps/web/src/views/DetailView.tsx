import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import type { GateReport, StageId } from "@kiln/protocol/web";
import type { TaskAttachment, TaskRunDetail } from "../api/types";
import { AttachmentLightbox } from "../components/AttachmentLightbox";
import { CheckpointPopover } from "../components/CheckpointPopover";
import { DecisionBox } from "../components/DecisionBox";
import { DeliverPrModal } from "../components/DeliverPrModal";
import { FlameCanvas } from "../components/FlameCanvas";
import {
  CheckIcon,
  CloseIcon,
  FileTextIcon,
  GitPrIcon,
  ShieldIcon,
  TerminalIcon,
} from "../components/Icons";
import { MarkdownContent } from "../components/MarkdownContent";
import { PrioritySelect } from "../components/PrioritySelect";
import { ProviderAvatar } from "../components/ProviderAvatar";
import { ScriptDrawer } from "../components/ScriptDrawer";
import { ViewFrame } from "../components/ViewFrame";
import { HostStagedDiffSection } from "./ResolveView";
import {
  STATUS_CHIP,
  TRACK_LABEL,
  WORKFLOW_PRESET_LABEL,
  WORKSPACE_LABEL,
  fmtDurationMs,
  fmtTime,
  fmtTokens,
  fmtUsd,
  getPipelineStages,
  heatOf,
  isSafeHttpOrPaseoUrl,
  splitFrontmatter,
  stageMeta,
} from "../state/format";
import { computeGrandSavedUsd, computeTurnsCostUsd } from "../state/pricing";
import { isProjectSpace, useKilnStore } from "../state/store";

type RunVisualState = "active" | "paused" | "paused_manual" | "returned" | "done";

interface NormalizedRun {
  raw: TaskRunDetail;
  stage: StageId;
  round: number;
  startMs: number;
  endMs: number | null;
  visualState: RunVisualState;
  executorLabel: string;
  outLabel: string;
}

function parseStageFromDir(dirName: string): StageId {
  const parts = dirName.split("-");
  const candidate = parts.length > 1 ? parts.slice(1).join("-") : dirName;
  const known: StageId[] = [
    "intake",
    "plan",
    "implement",
    "research",
    "verify",
    "review",
    "accept",
    "triage",
    "advise",
    "deliver",
  ];
  return known.includes(candidate as StageId)
    ? (candidate as StageId)
    : "implement";
}

function isGatePassed(gate: GateReport): boolean {
  return (
    gate.schema_ok &&
    gate.scope_ok &&
    gate.artifacts_ok !== false &&
    gate.accept_exit_code === 0
  );
}

function verdictMeta(vs: RunVisualState, stage: StageId): [string, string] {
  if (vs === "active") return ["进行中", "live"];
  if (vs === "paused") return ["等你决定", "ask"];
  if (vs === "paused_manual") return ["已暂停", "paused"];
  if (vs === "returned") return ["退回", "bad"];
  return [
    stage === "verify" || stage === "review" || stage === "accept"
      ? "通过"
      : "完成",
    "ok",
  ];
}

export function DetailView() {
  const { store, state } = useKilnStore();
  const [showHandoff, setShowHandoff] = useState(false);
  const [showRawEvents, setShowRawEvents] = useState(false);
  const [deliverPrOpen, setDeliverPrOpen] = useState(false);
  const [briefModalOpen, setBriefModalOpen] = useState(false);
  const [steerOpen, setSteerOpen] = useState(false);
  const [steerText, setSteerText] = useState("");
  const [steerSubmitting, setSteerSubmitting] = useState(false);
  const [lightboxAttachment, setLightboxAttachment] =
    useState<TaskAttachment | null>(null);

  const taskId = state.taskId;
  const detail = taskId ? state.taskDetails[taskId] : undefined;
  const taskSummary = taskId
    ? state.tasks.find((t) => t.id === taskId)
    : undefined;

  useEffect(() => {
    setShowHandoff(false);
    setShowRawEvents(false);
    setDeliverPrOpen(false);
    setBriefModalOpen(false);
    setSteerOpen(false);
    setSteerText("");
    setSteerSubmitting(false);
    setLightboxAttachment(null);
  }, [taskId]);

  const detailSpaceId = detail?.card.space;
  const detailTaskId = detail?.card.id;
  useEffect(() => {
    if (!detailTaskId || !detailSpaceId) return;
    if (state.scriptDrawerOpen || isProjectSpace(state.spaces[detailSpaceId])) {
      void store.loadScriptRunsForTask(detailSpaceId, detailTaskId);
    }
  }, [detailTaskId, detailSpaceId, state.scriptDrawerOpen]);

  if (!taskId) {
    return null;
  }

  if (!detail) {
    return (
      <ViewFrame
        left={
          <div className="crumbs">
            <button type="button" onClick={() => store.go("board")}>
              总览
            </button>
            <span>/</span>
            <span className="mono">{taskId}</span>
          </div>
        }
      >
        <div className="page">
          {state.taskDetailError ? (
            <div className="conflict-box">
              <div className="conflict-head">
                <span>加载任务详情失败</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void store.loadTaskDetail(taskId)}
                >
                  重试
                </button>
              </div>
              <p>{state.taskDetailError}</p>
            </div>
          ) : (
            <p className="empty">
              {taskSummary ? `正在加载 ${taskSummary.title}...` : "正在加载任务详情..."}
            </p>
          )}
        </div>
      </ViewFrame>
    );
  }

  const { card, state: taskState, brief, decisions, pendingDecision, ledgerProposals } =
    detail;
  const spaceName = state.spaces[card.space]?.name ?? card.space;
  const statusChip = STATUS_CHIP[taskState.status];
  const nowMs = Date.now();

  const normalizedRuns: NormalizedRun[] = detail.runs.map((r, idx) => {
    const stage = r.meta?.stage ?? parseStageFromDir(r.dirName);
    const round = r.meta?.round ?? 1;
    const startIso =
      r.startedAt ??
      r.meta?.started_at ??
      r.events[0]?.at ??
      card.created_at;
    const startMs = Number.isFinite(new Date(startIso).getTime())
      ? new Date(startIso).getTime()
      : nowMs;

    const exitEvent = r.events.find((e) => e.kind === "exit");
    const lastEvent = r.events[r.events.length - 1];
    const isActiveRun =
      r.status === "active" ||
      (taskState.status === "running" &&
        r.meta?.run_id !== undefined &&
        r.meta.run_id === taskState.activeRunId);

    let endMs: number | null = null;
    if (!isActiveRun) {
      if (r.endedAt) {
        endMs = new Date(r.endedAt).getTime();
      } else if (exitEvent) {
        endMs = new Date(exitEvent.at).getTime();
      } else if (r.gate?.checked_at) {
        endMs = new Date(r.gate.checked_at).getTime();
      } else if (lastEvent) {
        endMs = new Date(lastEvent.at).getTime();
      } else {
        endMs = startMs + 60_000;
      }
      if (!Number.isFinite(endMs) || endMs < startMs) {
        endMs = startMs + 60_000;
      }
    }

    const isLastRun = idx === detail.runs.length - 1;
    const gateFailed = r.gate !== null && !isGatePassed(r.gate);
    const receiptReturned =
      r.receipt !== null &&
      /\bverdict:\s*(changes_requested|fail)\b/i.test(r.receipt);
    const exitFailed =
      exitEvent?.kind === "exit" && exitEvent.reason === "failed";

    let visualState: RunVisualState = "done";
    if (isActiveRun) {
      visualState = "active";
    } else if (taskState.status === "paused" && isLastRun) {
      visualState = "paused_manual";
    } else if (
      taskState.status === "waiting" &&
      ((pendingDecision?.run_id && r.meta?.run_id === pendingDecision.run_id) ||
        (!pendingDecision?.run_id && isLastRun))
    ) {
      visualState = "paused";
    } else if (gateFailed || receiptReturned || exitFailed) {
      visualState = "returned";
    }

    const executorLabel = r.meta
      ? `${r.meta.role} · ${r.meta.agent} / ${r.meta.model}`
      : "内核";
    const outLabel = r.gate
      ? `exit ${r.gate.accept_exit_code}`
      : r.receipt
        ? "RECEIPT.md"
        : isActiveRun
          ? "进行中"
          : r.dirName;

    return {
      raw: r,
      stage,
      round,
      startMs,
      endMs,
      visualState,
      executorLabel,
      outLabel,
    };
  });

  const defaultRunIdx = (() => {
    const liveIdx = normalizedRuns.findIndex(
      (r) =>
        r.visualState === "active" ||
        r.visualState === "paused" ||
        r.visualState === "paused_manual",
    );
    if (liveIdx >= 0) return liveIdx;
    return normalizedRuns.length > 0 ? normalizedRuns.length - 1 : -1;
  })();

  const selectedIdx =
    state.selectedRunIdx !== null &&
    state.selectedRunIdx >= 0 &&
    state.selectedRunIdx < normalizedRuns.length
      ? state.selectedRunIdx
      : defaultRunIdx;
  const selectedRun =
    selectedIdx >= 0 ? normalizedRuns[selectedIdx] : undefined;

  const pipelineStages = getPipelineStages(
    taskState.track,
    card.contract.human_accept,
    card.workflow,
  );
  if (
    taskState.stage &&
    !pipelineStages.includes(taskState.stage) &&
    (taskState.stage === "triage" || taskState.stage === "advise")
  ) {
    pipelineStages.splice(pipelineStages.length - 1, 0, taskState.stage);
  }

  const stationStatus = (
    st: StageId,
  ): { cls: string; sub: string } => {
    const matching = normalizedRuns.filter((r) => r.stage === st);
    if (matching.length === 0) {
      if (st === "intake") {
        return { cls: "done", sub: fmtTime(card.created_at) };
      }
      if (st === "verify") {
        if (taskState.status === "running" && taskState.stage === "verify") {
          return { cls: "live", sub: "进行中" };
        }
        for (let i = normalizedRuns.length - 1; i >= 0; i--) {
          const implRun = normalizedRuns[i]!;
          if (implRun.stage === "implement" && implRun.raw.gate != null) {
            return isGatePassed(implRun.raw.gate)
              ? { cls: "done", sub: "门禁通过" }
              : { cls: "returned", sub: "门禁未过" };
          }
        }
      }
      if (st === "deliver") {
        if (taskState.status === "done") {
          const doneEvent = detail.stateEvents
            ? [...detail.stateEvents].reverse().find((ev) => ev.type === "done")
            : undefined;
          return {
            cls: "done",
            sub: fmtTime(doneEvent?.at ?? card.updated_at),
          };
        }
        if (taskState.status === "running" && taskState.stage === "deliver") {
          return { cls: "live", sub: "进行中" };
        }
        if (taskState.status === "waiting" && taskState.stage === "deliver") {
          return { cls: "blocked", sub: "等你决定" };
        }
        if (taskState.status === "paused" && taskState.stage === "deliver") {
          return { cls: "paused-manual", sub: "已暂停" };
        }
        if (taskState.status === "external") {
          return { cls: "live", sub: "等待外部" };
        }
      }
      return { cls: "todo", sub: "—" };
    }
    const last = matching[matching.length - 1]!;
    if (last.visualState === "active") {
      return {
        cls: "live",
        sub: `进行中${last.round > 1 ? ` · 第 ${last.round} 轮` : ""}`,
      };
    }
    if (last.visualState === "paused") {
      return { cls: "blocked", sub: "等你决定" };
    }
    if (last.visualState === "paused_manual") {
      return { cls: "paused-manual", sub: "已暂停" };
    }
    if (last.visualState === "returned") {
      return { cls: "returned", sub: "已退回" };
    }
    const endIso = last.endMs ? new Date(last.endMs).toISOString() : null;
    return {
      cls: "done",
      sub: `${fmtTime(endIso)}${matching.length > 1 ? ` · ${matching.length} 轮` : ""}`,
    };
  };

  // Gantt bounds
  const ganttMin =
    normalizedRuns.length > 0
      ? Math.min(...normalizedRuns.map((r) => r.startMs))
      : nowMs;
  const ganttMax =
    normalizedRuns.length > 0
      ? Math.max(
          ...normalizedRuns.map((r) => (r.endMs === null ? nowMs : r.endMs)),
          ganttMin + 60_000,
        )
      : nowMs + 60_000;
  const ganttSpan = Math.max(ganttMax - ganttMin, 1);
  const pctAt = (ms: number): number =>
    Math.max(0, Math.min(100, ((ms - ganttMin) / ganttSpan) * 100));

  const ganttStages = Array.from(new Set(normalizedRuns.map((r) => r.stage)));
  const taskRate = Math.round(state.ratesByTask[card.id] ?? 0);

  const canShowRestore =
    card.workspace_mode === "host_scoped" && detail.hostBackup !== null;
  const returnedCount = normalizedRuns.filter(
    (r) => r.visualState === "returned",
  ).length;
  const taskCostUsd = computeTurnsCostUsd(
    detail.usageTurns,
    detail.usage.costUsd,
    state.pricing,
  );
  const taskSavedUsd = computeGrandSavedUsd(detail.usage, state.pricing);

  const spaceObj = state.spaces[card.space];
  const spaceScripts = spaceObj?.scripts;
  const hasConfiguredScripts = Boolean(
    spaceScripts &&
      Object.values(spaceScripts).some(
        (cmd) => typeof cmd === "string" && cmd.trim().length > 0,
      ),
  );
  const canToggleScriptDrawer = isProjectSpace(spaceObj) || hasConfiguredScripts;
  const hasRunningScript = Object.values(state.scriptRuns).some(
    (run) =>
      run.spaceId === card.space &&
      (run.taskId === card.id || !run.taskId) &&
      !run.done,
  );

  // Latest context window telemetry: prefer live SSE snapshot, fallback to run events.
  const contextWindowInfo = (() => {
    const live = state.contextWindowByTask[card.id];
    if (live) return live;
    for (let i = detail.runs.length - 1; i >= 0; i -= 1) {
      const evs = detail.runs[i]!.events;
      for (let j = evs.length - 1; j >= 0; j -= 1) {
        const ev = evs[j]!;
        if (ev.kind === "context_window") {
          const percent =
            ev.percent ??
            Math.min(
              100,
              Math.round((ev.usedTokens / Math.max(1, ev.contextWindowTokens)) * 100),
            );
          return {
            usedTokens: ev.usedTokens,
            contextWindowTokens: ev.contextWindowTokens,
            percent,
            at: ev.at,
          };
        }
      }
    }
    return null;
  })();

  // Derive 4-Gate Anti-Drift indicators cleanly from deterministic gate & run records.
  const latestGate = (() => {
    for (let i = detail.runs.length - 1; i >= 0; i -= 1) {
      if (detail.runs[i]!.gate) return detail.runs[i]!.gate!;
    }
    return null;
  })();
  const latestImplMeta = (() => {
    for (let i = normalizedRuns.length - 1; i >= 0; i -= 1) {
      if (normalizedRuns[i]!.stage === "implement" && normalizedRuns[i]!.raw.meta) {
        return normalizedRuns[i]!.raw.meta!;
      }
    }
    return null;
  })();
  const latestReviewMeta = (() => {
    for (let i = normalizedRuns.length - 1; i >= 0; i -= 1) {
      if (normalizedRuns[i]!.stage === "review" && normalizedRuns[i]!.raw.meta) {
        return normalizedRuns[i]!.raw.meta!;
      }
    }
    return null;
  })();

  const antiDriftGates: Array<{
    label: string;
    text: string;
    tone: "ok" | "warn" | "bad";
  }> = [
    latestGate
      ? {
          label: "范围门禁",
          text: latestGate.scope_ok
            ? "0 越界"
            : `${latestGate.out_of_scope_paths.length} 越界`,
          tone: latestGate.scope_ok ? "ok" : "bad",
        }
      : card.workspace_mode === "scratch_dir"
        ? { label: "沙盒隔离", text: "仅 scratch_dir", tone: "ok" }
        : {
            label: "范围门禁",
            text: `已锁 ${card.contract.scope.length} 项`,
            tone: "ok",
          },
    latestGate
      ? {
          label: "冻结测试",
          text:
            latestGate.frozen_files_changed.length === 0
              ? "SHA256 一致"
              : `${latestGate.frozen_files_changed.length} 处改动`,
          tone: latestGate.frozen_files_changed.length === 0 ? "ok" : "bad",
        }
      : {
          label: "冻结测试",
          text:
            card.contract.accept_files_hash === "pending"
              ? "待锁定"
              : "SHA256 就绪",
          tone: card.contract.accept_files_hash === "pending" ? "warn" : "ok",
        },
    latestImplMeta && latestReviewMeta
      ? {
          label: "异构审查",
          text: `${latestImplMeta.agent} ${
            latestImplMeta.agent === latestReviewMeta.agent &&
            latestImplMeta.model === latestReviewMeta.model
              ? "="
              : "≠"
          } ${latestReviewMeta.agent}`,
          tone:
            latestImplMeta.agent === latestReviewMeta.agent &&
            latestImplMeta.model === latestReviewMeta.model
              ? "bad"
              : "ok",
        }
      : !pipelineStages.includes("review")
        ? { label: "流程模式", text: "直出短链", tone: "ok" }
        : {
            label: "异构审查",
            text: state.roster.heterogeneous_review ? "异构开启" : "同家族允许",
            tone: state.roster.heterogeneous_review ? "ok" : "warn",
          },
    latestGate
      ? {
          label: "验收门禁",
          text: `exit ${latestGate.accept_exit_code}`,
          tone: latestGate.accept_exit_code === 0 ? "ok" : "bad",
        }
      : { label: "验收门禁", text: "待运行", tone: "warn" },
  ];

  const alignHeadline =
    normalizedRuns[normalizedRuns.length - 1]?.raw.antiDriftSummary?.output ??
    card.workflow?.pm_rationale ??
    card.contract.goal;

  const taskAttachmentUrl = (att: TaskAttachment): string =>
    `/api/tasks/${encodeURIComponent(card.id)}/attachments/${encodeURIComponent(att.id)}`;

  const handleExportHandoff = async (): Promise<void> => {
    const content = [
      `# ${card.id}: ${card.title}`,
      `space: ${card.space} | track: ${taskState.track} | contract_version: v${taskState.contractVersion}`,
      `goal: ${card.contract.goal}`,
      `accept_cmd: ${card.contract.accept_cmd}`,
      selectedRun?.raw.handoff ?? brief,
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
        store.showToast("已导出交接上下文到剪贴板");
      } else {
        setShowHandoff(true);
        store.showToast("已展开交接包全文");
      }
    } catch {
      setShowHandoff(true);
      store.showToast("已展开交接包全文");
    }
  };

  const restoreErr =
    state.restoreResult && !state.restoreResult.ok ? state.restoreResult : null;

  const latestExternalEvent =
    taskState.status === "external" && detail.stateEvents
      ? [...detail.stateEvents]
          .reverse()
          .find(
            (ev) =>
              ev.type === "external" ||
              (ev.type === "decided" && ev.action === "return_external"),
          )
      : undefined;

  return (
    <ViewFrame
      left={
        <div className="crumbs">
          <button type="button" onClick={() => store.go("board")}>
            总览
          </button>
          <span>/</span>
          <span>{spaceName}</span>
          <span>/</span>
          <span className="mono">{card.id}</span>
        </div>
      }
      right={
        <>
          {taskState.status === "running" ||
          taskState.status === "queued" ||
          taskState.status === "paused" ? (
            <button
              type="button"
              className={`btn ${steerOpen ? "btn-light" : ""}`}
              aria-expanded={steerOpen}
              onClick={() => setSteerOpen((v) => !v)}
            >
              补充纠偏
            </button>
          ) : null}
          {taskState.status === "running" || taskState.status === "queued" ? (
            <button
              type="button"
              className="btn"
              onClick={() => void store.pauseTask(card.id)}
            >
              暂停
            </button>
          ) : null}
          {taskState.status === "paused" || taskState.status === "external" ? (
            <button
              type="button"
              className="btn btn-light"
              onClick={() => void store.resumeTask(card.id)}
            >
              继续推进
            </button>
          ) : null}
          {taskState.status === "external" ? (
            <button
              type="button"
              className="btn"
              onClick={() => void store.completeTask(card.id)}
            >
              标记已完成
            </button>
          ) : null}
          {canShowRestore ? (
            <button
              type="button"
              className="btn"
              onClick={() => void store.restoreHostBackup(card.id)}
            >
              从备份恢复
            </button>
          ) : null}
          {isSafeHttpOrPaseoUrl(detail.liveViewUrl) ? (
            <a
              className="btn"
              href={detail.liveViewUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              在 Paseo 中打开
            </a>
          ) : null}
          {card.workspace_mode === "git_worktree" ? (
            <>
              <CheckpointPopover
                taskId={card.id}
                checkpoints={detail.checkpoints ?? []}
                isRunning={taskState.status === "running"}
              />
              <button
                type="button"
                className="btn"
                onClick={() => setDeliverPrOpen(true)}
              >
                <GitPrIcon />
                <span>提交 / PR</span>
              </button>
            </>
          ) : null}
          {canToggleScriptDrawer ? (
            <button
              type="button"
              className={`btn ${state.scriptDrawerOpen ? "btn-light" : ""}`}
              aria-pressed={state.scriptDrawerOpen}
              title="开关脚本输出 (J)"
              onClick={() => store.toggleScriptDrawer()}
            >
              <TerminalIcon />
              <span>脚本</span>
              {hasRunningScript ? <span className="dot dot-run" /> : null}
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            onClick={() => void handleExportHandoff()}
          >
            导出交接包
          </button>
          {taskState.status !== "done" && taskState.status !== "cancelled" ? (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void store.cancelTask(card.id, "用户在详情页取消")}
            >
              取消
            </button>
          ) : null}
        </>
      }
    >
      <div className="detail">
        <div className="d-head">
          <div className="d-title">
            <h1>{card.title}</h1>
            <span className={`chip ${statusChip[1]}`}>{statusChip[0]}</span>
          </div>
          <div className="d-sub">
            <PrioritySelect
              value={taskState.priority}
              disabled={
                taskState.status === "done" || taskState.status === "cancelled"
              }
              onChange={(next) => void store.updatePriority(card.id, next)}
            />
            <span>
              {card.workflow
                ? `${WORKFLOW_PRESET_LABEL[card.workflow.preset]} · `
                : ""}
              {TRACK_LABEL[taskState.track]} ·{" "}
              {WORKSPACE_LABEL[card.workspace_mode]} · 契约 v
              {taskState.contractVersion}
            </span>
            {card.parent ? (
              <span>
                · 属于父任务{" "}
                <button
                  type="button"
                  className="link mono"
                  onClick={() => store.openTask(card.parent!)}
                >
                  {card.parent}
                </button>
              </span>
            ) : null}
          </div>
        </div>

        <section className="align-panel" aria-label="防跑偏门禁状态">
          <div className="align-top">
            <span className="align-shield">
              <ShieldIcon />
            </span>
            <b>防跑偏对齐</b>
            <span className="align-txt" title={alignHeadline}>
              {alignHeadline}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setBriefModalOpen(true)}
            >
              <FileTextIcon />
              <span>BRIEF.md</span>
            </button>
          </div>
          <div className="align-gates">
            {antiDriftGates.map((g) => (
              <div key={g.label} className={`align-gate ${g.tone}`}>
                <span className="align-gate-l">
                  <span
                    className={`dot ${
                      g.tone === "ok"
                        ? "dot-ok"
                        : g.tone === "bad"
                          ? "dot-bad"
                          : "dot-ask"
                    }`}
                  />
                  <span>{g.label}</span>
                </span>
                <span className="align-gate-v" title={g.text}>
                  {g.text}
                </span>
              </div>
            ))}
          </div>
        </section>

        {steerOpen || (detail.steers && detail.steers.length > 0) ? (
          <section className="steer-panel" aria-label="运行中补充纠偏">
            <div className="steer-head">
              <b>运行中补充纠偏（不改动契约）</b>
              {taskState.status === "running" ||
              taskState.status === "queued" ||
              taskState.status === "paused" ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setSteerOpen((v) => !v)}
                >
                  {steerOpen ? "收起输入" : "追加提示"}
                </button>
              ) : null}
            </div>
            {steerOpen &&
            (taskState.status === "running" ||
              taskState.status === "queued" ||
              taskState.status === "paused") ? (
              <div className="steer-form">
                <textarea
                  className="steer-input"
                  rows={2}
                  aria-label="补充纠偏指令"
                  placeholder="在不修改目标与 scope 的前提下补充执行提示（如：优先复用现有 helper）"
                  value={steerText}
                  disabled={steerSubmitting}
                  onChange={(e) => setSteerText(e.target.value)}
                />
                <div className="steer-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-light"
                    disabled={steerSubmitting || steerText.trim().length === 0}
                    onClick={async () => {
                      setSteerSubmitting(true);
                      const ok = await store.steerTask(card.id, steerText, false);
                      setSteerSubmitting(false);
                      if (ok) {
                        setSteerText("");
                        setSteerOpen(false);
                      }
                    }}
                  >
                    下一棒生效
                  </button>
                  {taskState.status === "running" ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={steerSubmitting || steerText.trim().length === 0}
                      onClick={async () => {
                        setSteerSubmitting(true);
                        const ok = await store.steerTask(card.id, steerText, true);
                        setSteerSubmitting(false);
                        if (ok) {
                          setSteerText("");
                          setSteerOpen(false);
                        }
                      }}
                    >
                      中断当前棒并立即重跑
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {detail.steers && detail.steers.length > 0 ? (
              <ul className="steer-list">
                {detail.steers.map((s) => (
                  <li key={s.id} className="steer-item">
                    <span className="mono muted">{fmtTime(s.at)}</span>
                    <span className="chip">
                      {s.interrupt ? "中断重跑" : "下一棒生效"}
                    </span>
                    <span className="steer-msg">{s.message}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        <ol className="stations">
          {pipelineStages.map((st) => {
            const meta = stageMeta(st);
            const info = stationStatus(st);
            return (
              <li
                key={st}
                className={`station ${info.cls}`}
                style={{ "--c": `var(${meta.colorVar})` } as Record<string, string>}
              >
                <span className="st-mark" />
                <span className="st-name">{meta.label}</span>
                <span className="st-sub">{info.sub}</span>
              </li>
            );
          })}
        </ol>

        {normalizedRuns.length > 0 ? (
          <div className="gantt">
            <div className="g-axis">
              <span />
              <div className="g-ticks">
                {[0, 0.25, 0.5, 0.75].map((f) => (
                  <span key={f} style={{ left: `${f * 100}%` }}>
                    {fmtTime(new Date(ganttMin + ganttSpan * f).toISOString())}
                  </span>
                ))}
                <span className="now">
                  {taskState.status === "running"
                    ? `现在 ${fmtTime(new Date(ganttMax).toISOString())}`
                    : fmtTime(new Date(ganttMax).toISOString())}
                </span>
              </div>
            </div>
            {ganttStages.map((st) => {
              const meta = stageMeta(st);
              const stageRuns = normalizedRuns
                .map((r, i) => ({ r, i }))
                .filter((x) => x.r.stage === st);
              return (
                <div key={st} className="g-row">
                  <div className="g-label">
                    <span
                      className="dot"
                      style={{ background: `var(${meta.colorVar})` }}
                    />
                    <span>{meta.label}</span>
                    {stageRuns.length > 1 ? (
                      <span className="muted mono">×{stageRuns.length}</span>
                    ) : null}
                  </div>
                  <div className="g-track">
                    {stageRuns.map(({ r, i }) => {
                      const left = pctAt(r.startMs);
                      const right = pctAt(r.endMs === null ? ganttMax : r.endMs);
                      const width = Math.max(right - left, 1.2);
                      const selCls = i === selectedIdx ? " is-sel" : "";

                      if (r.visualState === "active") {
                        return (
                          <div
                            key={i}
                            className={`flame fire${selCls}`}
                            style={{
                              left: `${left}%`,
                              width: `${width}%`,
                              "--speed": `${(260 / (taskRate || 120)).toFixed(2)}s`,
                            } as Record<string, string>}
                            onClick={() => store.selectRun(i)}
                            title={`${meta.label} · 进行中`}
                          >
                            <div className="flame-bar" />
                            <span className="flame-head" />
                            <FlameCanvas heat={heatOf(taskRate)} />
                          </div>
                        );
                      }

                      return (
                        <div
                          key={i}
                          className={`bar is-${r.visualState}${selCls}`}
                          style={{
                            left: `${left}%`,
                            width: `${width}%`,
                            "--c": `var(${meta.colorVar})`,
                          } as Record<string, string>}
                          onClick={() => store.selectRun(i)}
                          title={`${meta.label} · 第 ${r.round} 轮`}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="d-body">
          <nav className="runs" aria-label="执行轮次">
            <div className="runs-title">{normalizedRuns.length} 次执行</div>
            {normalizedRuns.length > 0 ? (
              normalizedRuns.map((r, i) => {
                const meta = stageMeta(r.stage);
                const [vText, vTone] = verdictMeta(r.visualState, r.stage);
                const barCls =
                  r.visualState === "active"
                    ? "live"
                    : r.visualState === "paused"
                      ? "paused"
                      : r.visualState === "paused_manual"
                        ? "paused_manual"
                        : "";
                return (
                  <button
                    key={r.raw.dirName}
                    type="button"
                    className={`run ${i === selectedIdx ? "on" : ""}`}
                    onClick={() => store.selectRun(i)}
                  >
                    <span
                      className={`run-bar ${barCls}`}
                      style={{ "--c": `var(${meta.colorVar})` } as Record<string, string>}
                    />
                    <span>
                      <span className="run-top">
                        <span>
                          {meta.label}
                          {r.round > 1 ? ` · 第 ${r.round} 轮` : ""}
                        </span>
                        <span
                          className={`v v-${vTone === "paused" ? "muted" : vTone}`}
                        >
                          {vText}
                        </span>
                      </span>
                      <span className="run-meta">
                        {fmtTime(new Date(r.startMs).toISOString())}
                        {r.endMs
                          ? `–${fmtTime(new Date(r.endMs).toISOString())}`
                          : " 起"}{" "}
                        ·{" "}
                        {r.raw.meta
                          ? `${r.raw.meta.agent}${r.raw.session?.displaySessionId ? ` #${r.raw.session.displaySessionId}` : ""}${r.raw.meta.role ? ` (${r.raw.meta.role})` : ""}`
                          : "内核"}
                      </span>
                    </span>
                  </button>
                );
              })
            ) : (
              <p className="muted" style={{ padding: "8px", fontSize: "12px" }}>
                尚未派发执行轮次
              </p>
            )}
          </nav>

          <article className="reader">
            <div className="reader-inner">
              {restoreErr ? (
                <div className="conflict-box" role="alert">
                  <div className="conflict-head">
                    <span>
                      {restoreErr.code === "hash_mismatch"
                        ? "拦截恢复：目标文件已被后续修改（409 hash_mismatch）"
                        : restoreErr.message}
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => store.clearRestoreResult()}
                    >
                      关闭
                    </button>
                  </div>
                  {restoreErr.conflicts && restoreErr.conflicts.length > 0 ? (
                    restoreErr.conflicts.map((c, idx) => (
                      <div key={idx} style={{ marginTop: "8px" }}>
                        <div className="conflict-meta">
                          <div>冲突路径：{c.targetCanonicalPath}</div>
                          <div>期望 SHA256：{c.expectedPostSha256 ?? "<none>"}</div>
                          <div>实际 SHA256：{c.actualSha256 ?? "<missing>"}</div>
                        </div>
                        {c.diff ? <div className="code">{c.diff}</div> : null}
                      </div>
                    ))
                  ) : restoreErr.hashMismatch ? (
                    <div className="conflict-meta">
                      <div>冲突路径：{restoreErr.hashMismatch.path}</div>
                      <div>期望 SHA256：{restoreErr.hashMismatch.expectedSha256}</div>
                      <div>实际 SHA256：{restoreErr.hashMismatch.actualSha256}</div>
                      {restoreErr.hashMismatch.diff ? (
                        <div className="code">{restoreErr.hashMismatch.diff}</div>
                      ) : null}
                    </div>
                  ) : null}
                  {restoreErr.lockConflicts && restoreErr.lockConflicts.length > 0 ? (
                    <div className="conflict-meta">
                      {restoreErr.lockConflicts
                        .map((lc) => `${lc.path}（被 ${lc.heldByTaskId} 占用）`)
                        .join("；")}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {taskState.status === "waiting" && pendingDecision ? (
                <DecisionBox
                  decision={pendingDecision}
                  onSubmit={(payload) => store.submitDecision(card.id, payload)}
                  onOpenResolve={() => store.openResolve(card.id)}
                />
              ) : null}

              {taskState.status === "external" ? (
                <section className="external-box" role="status">
                  <div className="external-head">
                    <span>外部等待中（当前不会自动继续推进）</span>
                    {latestExternalEvent ? (
                      <span className="muted mono">{fmtTime(latestExternalEvent.at)}</span>
                    ) : null}
                  </div>
                  <p className="external-meta">
                    {latestExternalEvent?.type === "external" && latestExternalEvent.detail
                      ? `说明：${latestExternalEvent.detail}。`
                      : latestExternalEvent?.type === "decided"
                        ? `于 ${fmtTime(latestExternalEvent.at)} 经人工选择转入外部等待（decision ${latestExternalEvent.decision_id}）。`
                        : "当前任务处于外部等待挂起状态。"}
                    请确认外部前置条件已就绪后点「继续推进」，或直接点「标记已完成」结束任务。
                  </p>
                  <div className="external-actions">
                    <button
                      type="button"
                      className="btn btn-light"
                      onClick={() => void store.resumeTask(card.id)}
                    >
                      继续推进
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void store.completeTask(card.id)}
                    >
                      标记已完成
                    </button>
                  </div>
                </section>
              ) : null}

              <HostStagedDiffSection detail={detail} />

              {normalizedRuns.length > 0 ? (
                <section className="session-overview" aria-label="Agent Session 总览">
                  <div className="session-overview-head">
                    <h4>Agent · Session 执行总览（{normalizedRuns.length}）</h4>
                    <span className="muted">
                      {state.authMode === "remote"
                        ? "远程浏览仅展示输入与输出，打开原生 TUI 需在本机桌面端操作"
                        : "点击 Agent + Session 可直接拉起原生 TUI 查看完整执行过程"}
                    </span>
                  </div>
                  <div className="session-cards">
                    {normalizedRuns.map((r, i) => {
                      const meta = stageMeta(r.stage);
                      const [vText, vTone] = verdictMeta(r.visualState, r.stage);
                      const s = r.raw.session;
                      const io = r.raw.ioSummary;
                      const agentName = r.raw.meta?.agent ?? "内核";
                      const sessionBadge = s?.displaySessionId
                        ? `#${s.displaySessionId}`
                        : "无原生 Session";
                      const isRemote = state.authMode === "remote";
                      const canOpenTui = !isRemote && Boolean(s?.tuiSupported);
                      const tuiTooltip = isRemote
                        ? "仅本机端支持打开原生 Agent TUI"
                        : s?.tuiCommandPreview ??
                          s?.tuiUnavailableReason ??
                          "该执行轮次暂不支持打开原生 TUI";
                      const runDurMs = (r.endMs ?? nowMs) - r.startMs;

                      return (
                        <div
                          key={r.raw.dirName}
                          className={`session-card${i === selectedIdx ? " is-sel" : ""}`}
                        >
                          <div className="session-card-head">
                            <div className="session-card-title">
                              <span
                                className={`v v-${vTone === "paused" ? "muted" : vTone}`}
                              >
                                {io?.outputVerdict ?? vText}
                              </span>
                              <strong>
                                {meta.label}
                                {r.round > 1 ? ` · 第 ${r.round} 轮` : ""}
                              </strong>
                              {r.raw.meta?.roster_role ? (
                                <span className="chip">
                                  {state.roster.roster[r.raw.meta.roster_role]?.name ??
                                    r.raw.meta.roster_role}
                                </span>
                              ) : r.raw.meta?.role ? (
                                <span className="chip">{r.raw.meta.role}</span>
                              ) : null}
                              <button
                                type="button"
                                className="session-trigger"
                                disabled={!canOpenTui}
                                title={tuiTooltip}
                                onClick={() =>
                                  void store.openRunTui(card.id, r.raw.dirName)
                                }
                              >
                                <ProviderAvatar providerId={agentName} />
                                <span>{agentName}</span>
                                <span className="mono">{sessionBadge}</span>
                                {canOpenTui ? (
                                  <span className="session-open-hint">打开 TUI</span>
                                ) : null}
                              </button>
                              {r.raw.meta?.checkpoint_ref ? (
                                <span
                                  className="mono muted"
                                  style={{ fontSize: "11px" }}
                                  title={r.raw.meta.checkpoint_ref}
                                >
                                  快照:{r.raw.meta.checkpoint_ref.split("/").pop()}
                                </span>
                              ) : null}
                            </div>
                            <div className="session-card-meta">
                              <span className="mono">{fmtDurationMs(runDurMs)}</span>
                              {io && (io.costUsd > 0 || io.totalTokens > 0) ? (
                                <span className="mono">
                                  {fmtTokens(io.totalTokens)} tok ·{" "}
                                  {fmtUsd(io.costUsd)}
                                </span>
                              ) : null}
                            </div>
                          </div>

                          <div className="session-io">
                            <div className="session-io-row">
                              <span className="session-io-label">输入</span>
                              <span className="session-io-val">
                                {io?.inputTitle ?? card.contract.goal}
                                {io?.inputRef ? (
                                  <span className="mono muted"> · {io.inputRef}</span>
                                ) : null}
                              </span>
                            </div>
                            <div className="session-io-row">
                              <span className="session-io-label">输出</span>
                              <div className="session-io-val">
                                <span>
                                  {io?.outputSummary ?? "已完成本轮动作"}
                                </span>
                                {io && io.gatePassed !== null ? (
                                  <span
                                    className={`chip ${io.gatePassed ? "is-ok" : "is-bad"}`}
                                  >
                                    {io.gatePassed ? "门禁通过" : "门禁未过"}
                                  </span>
                                ) : null}
                                {io && io.changedPaths.length > 0 ? (
                                  <span className="session-paths">
                                    {io.changedPaths.slice(0, 3).map((p) => (
                                      <code key={p} className="session-path-chip">
                                        {p}
                                      </code>
                                    ))}
                                    {io.changedPaths.length > 3 ? (
                                      <span className="muted">
                                        +{io.changedPaths.length - 3}
                                      </span>
                                    ) : null}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          </div>

                          {r.raw.antiDriftSummary ? (
                            <div className="anti-drift-box">
                              <div className="anti-drift-head">
                                <b>防跑偏对齐</b>
                                <div className="gate-proof-row">
                                  <span
                                    className={`gate-proof-pill ${
                                      r.raw.antiDriftSummary.gate_proof.schema_ok
                                        ? "is-ok"
                                        : "is-bad"
                                    }`}
                                  >
                                    Schema
                                  </span>
                                  <span
                                    className={`gate-proof-pill ${
                                      r.raw.antiDriftSummary.gate_proof.scope_ok
                                        ? "is-ok"
                                        : "is-bad"
                                    }`}
                                  >
                                    范围
                                  </span>
                                  <span
                                    className={`gate-proof-pill ${
                                      r.raw.antiDriftSummary.gate_proof.frozen_ok
                                        ? "is-ok"
                                        : "is-bad"
                                    }`}
                                  >
                                    冻结
                                  </span>
                                  <span
                                    className={`gate-proof-pill ${
                                      r.raw.antiDriftSummary.gate_proof.accept_ok
                                        ? "is-ok"
                                        : "is-bad"
                                    }`}
                                  >
                                    验收
                                  </span>
                                </div>
                              </div>
                              {r.raw.antiDriftSummary.alignment_points.length > 0 ? (
                                <ul className="anti-drift-points">
                                  {r.raw.antiDriftSummary.alignment_points.map(
                                    (pt, ptIdx) => (
                                      <li key={ptIdx}>{pt}</li>
                                    ),
                                  )}
                                </ul>
                              ) : null}
                            </div>
                          ) : null}

                          <div className="session-card-foot">
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => store.selectRun(i)}
                            >
                              {i === selectedIdx ? "正在查看产物" : "查看产物"}
                            </button>
                            {s?.cwd ? (
                              <span className="session-cwd mono muted" title={s.cwd}>
                                cwd: {s.cwd}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {selectedRun ? (
                <>
                  {(() => {
                    const meta = stageMeta(selectedRun.stage);
                    const [vText, vTone] = verdictMeta(
                      selectedRun.visualState,
                      selectedRun.stage,
                    );
                    const durationMs =
                      (selectedRun.endMs ?? nowMs) - selectedRun.startMs;

                    return (
                      <>
                        <header className="art-head">
                          <div>
                            <div className="art-kicker">
                              {meta.label}
                              {selectedRun.round > 1
                                ? ` · 第 ${selectedRun.round} 轮`
                                : ""}
                            </div>
                            <h2>{selectedRun.raw.dirName}</h2>
                          </div>
                          <span
                            className={`chip chip-${vTone === "ask" ? "ask" : vTone}`}
                          >
                            {vText}
                          </span>
                        </header>

                        <dl className="art-meta">
                          <div>
                            <dt>执行者</dt>
                            <dd>{selectedRun.executorLabel}</dd>
                          </div>
                          <div>
                            <dt>开始</dt>
                            <dd>
                              {fmtTime(new Date(selectedRun.startMs).toISOString())}
                            </dd>
                          </div>
                          <div>
                            <dt>耗时</dt>
                            <dd>{fmtDurationMs(durationMs)}</dd>
                          </div>
                          <div>
                            <dt>产出</dt>
                            <dd>{selectedRun.outLabel}</dd>
                          </div>
                        </dl>

                        {selectedRun.raw.gate ? (
                          <div className="block">
                            <h4>确定性门禁报告（GATE.yaml）</h4>
                            <div className="checks">
                              <div className="check">
                                <CheckIcon />
                                <span>Schema 与租约校验</span>
                                <span className="r">
                                  {selectedRun.raw.gate.schema_ok ? "通过" : "失败"}
                                </span>
                              </div>
                              <div className="check">
                                <CheckIcon />
                                <span>可改范围检查</span>
                                <span className="r">
                                  {selectedRun.raw.gate.scope_ok
                                    ? "0 个越界"
                                    : `${selectedRun.raw.gate.out_of_scope_paths.length} 个越界`}
                                </span>
                              </div>
                              <div className="check">
                                <CheckIcon />
                                <span>冻结测试文件哈希</span>
                                <span className="r">
                                  {selectedRun.raw.gate.frozen_files_changed
                                    .length === 0
                                    ? "一致"
                                    : `${selectedRun.raw.gate.frozen_files_changed.length} 处变更${selectedRun.raw.gate.escalated_to_l2 ? "（已升轨 L2）" : ""}`}
                                </span>
                              </div>
                              <div className="check">
                                <CheckIcon />
                                <span>隔离环境验收命令</span>
                                <span className="r">
                                  exit {selectedRun.raw.gate.accept_exit_code} ·{" "}
                                  {selectedRun.raw.gate.accept_duration_ms}ms
                                </span>
                              </div>
                            </div>
                          </div>
                        ) : null}

                        {selectedRun.raw.receipt ? (
                          (() => {
                            const { metaLines, body } = splitFrontmatter(
                              selectedRun.raw.receipt,
                            );
                            return (
                              <div className="block">
                                <h4>阶段回执（RECEIPT.md）</h4>
                                {metaLines.length > 0 ? (
                                  <div
                                    className="code"
                                    style={{ marginBottom: "12px" }}
                                  >
                                    {metaLines
                                      .map(([k, v]) => `${k}: ${v}`)
                                      .join("\n")}
                                  </div>
                                ) : null}
                                <MarkdownContent text={body} />
                              </div>
                            );
                          })()
                        ) : null}

                        {selectedRun.raw.events.length > 0 ? (
                          <div className="block">
                            <div className="events-toggle-row">
                              <h4>执行事件流（{selectedRun.raw.events.length}）</h4>
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => setShowRawEvents((prev) => !prev)}
                              >
                                {showRawEvents
                                  ? "收起原始执行事件"
                                  : `展开原始执行事件（${selectedRun.raw.events.length}）`}
                              </button>
                            </div>
                            {!showRawEvents ? (
                              <p className="muted events-collapsed-hint">
                                完整步骤细节默认折叠；可点击上方「Agent + Session」直接打开原生 TUI，或按需展开原始事件流。
                              </p>
                            ) : (
                              <div className="code">
                                {selectedRun.raw.events
                                  .map((ev) => {
                                    if (ev.kind === "message") return ev.text;
                                    if (ev.kind === "session_bound") {
                                      return `[session] ${ev.providerSessionId}${ev.providerSessionPath ? ` (${ev.providerSessionPath})` : ""}`;
                                    }
                                    if (ev.kind === "tool") {
                                      return `[tool] ${ev.name}${ev.target ? ` -> ${ev.target}` : ""}`;
                                    }
                                    if (ev.kind === "file_write") {
                                      return `[write] ${ev.path}`;
                                    }
                                    if (ev.kind === "approval") {
                                      return `[approval] ${ev.action}: ${ev.detail}`;
                                    }
                                    if (ev.kind === "usage") {
                                      return `[usage] ${ev.agent}/${ev.model} in=${ev.inputTokens} cached=${ev.cachedInputTokens} out=${ev.outputTokens}`;
                                    }
                                    if (ev.kind === "exit") {
                                      return `[exit] ${ev.reason}${ev.detail ? ` (${ev.detail})` : ""}`;
                                    }
                                    return "[thinking]";
                                  })
                                  .join("\n")}
                              </div>
                            )}
                          </div>
                        ) : null}

                        {(showHandoff || !selectedRun.raw.receipt) &&
                        selectedRun.raw.handoff ? (
                          <div className="block">
                            <h4>交接包（HANDOFF.md）</h4>
                            <MarkdownContent text={selectedRun.raw.handoff} />
                          </div>
                        ) : null}
                      </>
                    );
                  })()}
                </>
              ) : (
                <div className="block">
                  <h4>立项说明（BRIEF.md）</h4>
                  <MarkdownContent text={brief || card.contract.goal} />
                </div>
              )}
            </div>
          </article>

          <aside className="ctx">
            <section>
              <h3>交付契约 · v{taskState.contractVersion}</h3>
              <dl>
                <div>
                  <dt>目标</dt>
                  <dd>{card.contract.goal}</dd>
                </div>
                <div>
                  <dt>交付终点与动作</dt>
                  <dd>
                    {card.contract.end}（{card.contract.deliver.mode}
                    {card.contract.deliver.cmd
                      ? `: ${card.contract.deliver.cmd}`
                      : ""}
                    ）
                  </dd>
                </div>
                <div>
                  <dt>验收命令</dt>
                  <dd className="mono">{card.contract.accept_cmd}</dd>
                </div>
                <div>
                  <dt>
                    {card.workspace_mode === "host_scoped"
                      ? "本机白名单路径"
                      : "可改范围"}
                  </dt>
                  <dd className="mono">{card.contract.scope.join("\n")}</dd>
                </div>
                {card.contract.non_goals && card.contract.non_goals.length > 0 ? (
                  <div>
                    <dt>明确不做</dt>
                    <dd>{card.contract.non_goals.join("；")}</dd>
                  </div>
                ) : null}
                {card.workflow?.pm_rationale ? (
                  <div>
                    <dt>PM 排兵理由</dt>
                    <dd>{card.workflow.pm_rationale}</dd>
                  </div>
                ) : null}
              </dl>
            </section>

            {detail.research && detail.research.trim().length > 0 ? (
              <section>
                <h3>技术调研报告（RESEARCH.md）</h3>
                <div style={{ maxHeight: "240px", overflowY: "auto" }}>
                  <MarkdownContent text={detail.research} />
                </div>
              </section>
            ) : null}

            {detail.plan && detail.plan.trim().length > 0 ? (
              <section>
                <h3>技术实施方案（PLAN.md）</h3>
                <div style={{ maxHeight: "260px", overflowY: "auto" }}>
                  <MarkdownContent text={detail.plan} />
                </div>
              </section>
            ) : null}

            {detail.attachments && detail.attachments.length > 0 ? (
              <section aria-label="任务附件截图">
                <h3>附件截图（{detail.attachments.length}）</h3>
                <div className="att-grid">
                  {detail.attachments.map((att) => (
                    <button
                      key={att.id}
                      type="button"
                      className="att-thumb"
                      title={`点击预览 ${att.filename}`}
                      onClick={() => setLightboxAttachment(att)}
                    >
                      <img src={taskAttachmentUrl(att)} alt={att.filename} />
                      <span>{att.filename}</span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {decisions || (detail.stateEvents && detail.stateEvents.length > 0) ? (
              <section>
                <h3>决定与流转记录</h3>
                {detail.stateEvents && detail.stateEvents.length > 0 ? (
                  <div className="log" style={{ marginBottom: decisions ? "12px" : "0" }}>
                    {detail.stateEvents
                      .slice()
                      .reverse()
                      .slice(0, 8)
                      .map((ev, idx) => (
                        <div key={idx} className="log-item">
                          <span className="mono">{fmtTime(ev.at)}</span>
                          <span>
                            <b>{ev.type}</b>
                            {"reason" in ev && ev.reason ? ` · ${ev.reason}` : ""}
                            {"stage" in ev && ev.stage
                              ? ` · ${stageMeta(ev.stage).label}`
                              : ""}
                          </span>
                        </div>
                      ))}
                  </div>
                ) : null}
                {decisions ? (
                  <div className="code" style={{ maxHeight: "220px", overflowY: "auto" }}>
                    {decisions}
                  </div>
                ) : null}
              </section>
            ) : null}

            {ledgerProposals.length > 0 ? (
              <section>
                <h3>待确认账本提议（未入账）</h3>
                <div className="log">
                  {ledgerProposals.map((p) => (
                    <div key={p.id} className="log-item">
                      <span className="mono">{p.role}</span>
                      <span>{p.rule}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section>
              <h3>本卡消耗</h3>
              <dl className="usage">
                <div>
                  <dt>Token</dt>
                  <dd>{fmtTokens(detail.usage.totalTokens)}</dd>
                </div>
                <div>
                  <dt>费用</dt>
                  <dd>{fmtUsd(taskCostUsd)}</dd>
                </div>
                <div>
                  <dt>执行</dt>
                  <dd>{normalizedRuns.length} 次</dd>
                </div>
                <div>
                  <dt>返工</dt>
                  <dd>
                    {returnedCount} / {card.limits.review_rounds}
                  </dd>
                </div>
              </dl>
              <div className="ctx-meter" aria-label="上下文窗口水位">
                {contextWindowInfo ? (
                  <>
                    <div className="ctx-row">
                      <span>上下文水位</span>
                      <span className="mono">
                        {fmtTokens(contextWindowInfo.usedTokens)} /{" "}
                        {fmtTokens(contextWindowInfo.contextWindowTokens)}（
                        {contextWindowInfo.percent}%）
                      </span>
                    </div>
                    <div className="meter">
                      <i
                        className={
                          contextWindowInfo.percent >= 85
                            ? "bad"
                            : contextWindowInfo.percent >= 70
                              ? "warn"
                              : "ok"
                        }
                        style={{ width: `${contextWindowInfo.percent}%` }}
                      />
                    </div>
                  </>
                ) : (
                  <div className="ctx-row">
                    <span>上下文水位</span>
                    <span className="muted">等待执行器上报上下文水位</span>
                  </div>
                )}
                <div className="ctx-row">
                  <span className="muted">
                    缓存读 {fmtTokens(detail.usage.cachedInputTokens)} · 写{" "}
                    {fmtTokens(detail.usage.cacheWriteTokens ?? 0)}
                  </span>
                  <span className="mono ctx-ok-val">
                    净省 {fmtUsd(taskSavedUsd)}
                  </span>
                </div>
              </div>
            </section>
          </aside>
        </div>

        <ScriptDrawer
          spaceId={card.space}
          taskId={card.id}
          scripts={spaceScripts}
        />
      </div>

      <DeliverPrModal
        taskId={card.id}
        taskStatus={taskState.status}
        open={deliverPrOpen}
        onOpenChange={setDeliverPrOpen}
      />

      <AttachmentLightbox
        attachment={lightboxAttachment}
        imageUrl={
          lightboxAttachment ? taskAttachmentUrl(lightboxAttachment) : null
        }
        onClose={() => setLightboxAttachment(null)}
      />

      {briefModalOpen ? (
        <Dialog.Root open={briefModalOpen} onOpenChange={setBriefModalOpen}>
          <Dialog.Portal>
            <Dialog.Overlay
              className="palette-mask open"
              onClick={(e) => {
                if (e.target === e.currentTarget) setBriefModalOpen(false);
              }}
            >
              <Dialog.Content
                className="modal-card modal-card-wide"
                aria-describedby={undefined}
                onEscapeKeyDown={(e) => {
                  e.preventDefault();
                  setBriefModalOpen(false);
                }}
              >
                <div className="modal-head">
                  <Dialog.Title>立项方案原文（BRIEF.md）</Dialog.Title>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="关闭 BRIEF 弹窗"
                    onClick={() => setBriefModalOpen(false)}
                  >
                    <CloseIcon />
                  </button>
                </div>
                <div className="modal-body">
                  <MarkdownContent text={brief || card.contract.goal} />
                </div>
              </Dialog.Content>
            </Dialog.Overlay>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </ViewFrame>
  );
}
