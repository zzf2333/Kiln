import { PRIORITY_RANK, type Priority } from "@kiln/protocol/web";
import type { BootstrapTask } from "../api/types";
import { MiniRail } from "../components/MiniRail";
import { PrioritySelect } from "../components/PrioritySelect";
import { ViewFrame } from "../components/ViewFrame";
import {
  TRACK_LABEL,
  fmtDateShort,
  fmtRelativeSince,
  fmtTokens,
  fmtUsd,
  stageMeta,
} from "../state/format";
import { computeTaskCostUsd } from "../state/pricing";
import { useKilnStore, type PeriodFilter } from "../state/store";

const PERIOD_OPTIONS: ReadonlyArray<[PeriodFilter, string]> = [
  ["week", "本周"],
  ["month", "本月"],
  ["year", "今年"],
  ["all", "全部"],
];

function isInPeriod(iso: string, period: PeriodFilter): boolean {
  if (period === "all") return true;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return true;
  const diffDays = (Date.now() - ts) / 86_400_000;
  if (period === "week") return diffDays <= 7;
  if (period === "month") return diffDays <= 31;
  return diffDays <= 366;
}

export function BoardView() {
  const { store, state } = useKilnStore();
  const {
    tasks,
    pendingDecisions,
    spaces,
    spaceFilter,
    periodFilter,
    priorityFilter,
    showParentSlices,
    ratesByTask,
    pricing,
  } = state;

  const parentIds = new Set<string>();
  for (const t of tasks) {
    if (t.parent_id) parentIds.add(t.parent_id);
  }
  for (const t of tasks) {
    if (t.kind === "epic") parentIds.add(t.id);
  }

  const decisionByTask = new Map(pendingDecisions.map((d) => [d.task_id, d]));

  const visibleAll = tasks
    .filter(
      (t) =>
        t.status !== "cancelled" &&
        (spaceFilter === "all" || t.space === spaceFilter) &&
        isInPeriod(t.updated_at || t.created_at, periodFilter) &&
        (priorityFilter === "all" ||
          t.effective_priority === priorityFilter ||
          t.priority === priorityFilter),
    )
    .sort((a, b) => {
      const pa = PRIORITY_RANK[a.effective_priority];
      const pb = PRIORITY_RANK[b.effective_priority];
      if (pa !== pb) return pa - pb;
      return b.updated_at.localeCompare(a.updated_at);
    });

  const visibleParentIds = new Set(
    visibleAll.filter((t) => parentIds.has(t.id)).map((t) => t.id),
  );

  // Parent collapse rule: hide child slices under visible parent by default, EXCEPT waiting child slices always float out
  const boardItems = visibleAll.filter(
    (t) =>
      !(
        t.parent_id &&
        visibleParentIds.has(t.parent_id) &&
        !showParentSlices &&
        t.status !== "waiting"
      ),
  );

  const waitingCol = boardItems.filter((t) => t.status === "waiting");
  const activeCol = boardItems.filter(
    (t) => t.status === "running" || t.status === "queued" || t.status === "paused",
  );
  const externalCol = boardItems.filter((t) => t.status === "external");
  const doneCol = boardItems.filter((t) => t.status === "done");

  const runningLeafCount = visibleAll.filter(
    (t) => t.status === "running" && !parentIds.has(t.id),
  ).length;
  const pausedLeafCount = visibleAll.filter(
    (t) => t.status === "paused" && !parentIds.has(t.id),
  ).length;
  const waitingTotal = waitingCol.length;

  const cols: Array<{
    name: string;
    hint: string;
    color: string;
    items: BootstrapTask[];
  }> = [
    {
      name: "等你决定",
      hint: "拍板后自动继续",
      color: "var(--ask)",
      items: waitingCol,
    },
    {
      name: "进行中",
      hint: "运行中 · 排队 · 手动暂停",
      color: "var(--ember-2)",
      items: activeCol,
    },
    {
      name: "外部等待",
      hint: "上游有回应时唤醒",
      color: "var(--s-intake)",
      items: externalCol,
    },
    {
      name: "已完成",
      hint: "已到达交付终点",
      color: "var(--ok)",
      items: doneCol,
    },
  ];

  const renderCard = (t: BootstrapTask) => {
    const spaceName = spaces[t.space]?.name ?? t.space;
    const isParent = parentIds.has(t.id);
    const p0Class = t.effective_priority === "P0" ? " is-p0" : "";

    if (isParent) {
      const children = tasks.filter(
        (c) => c.parent_id === t.id && c.status !== "cancelled",
      );
      const cnt = (st: string) => children.filter((c) => c.status === st).length;
      return (
        <article
          key={t.id}
          className={`card${p0Class}`}
          onClick={() => store.openTask(t.id)}
        >
          <div className="card-meta">
            <span>
              <PrioritySelect
                value={t.priority}
                onChange={(next) => void store.updatePriority(t.id, next)}
              />
              <span>{spaceName} · 父任务</span>
            </span>
            <span className="mono">{children.length} 切片</span>
          </div>
          <h3 className="card-title">{t.title}</h3>
          {t.summary ? <p className="card-desc">{t.summary}</p> : null}
          <div className="card-foot">
            <span>
              {cnt("done")} 完成 · {cnt("running")} 在跑 · {cnt("queued")} 排队
              {cnt("waiting") > 0 ? ` · ${cnt("waiting")} 待决` : ""}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                store.toggleParentSlices();
              }}
            >
              {showParentSlices ? "收拢切片" : "展开切片"}
            </button>
          </div>
        </article>
      );
    }

    if (t.status === "waiting") {
      const dec = decisionByTask.get(t.id);
      const recOpt =
        dec?.options.find((o) => o.recommended) ?? dec?.options[0];
      return (
        <article
          key={t.id}
          className={`card${p0Class}`}
          onClick={() => store.openTask(t.id)}
        >
          <div className="card-meta">
            <span>
              <PrioritySelect
                value={t.priority}
                onChange={(next) => void store.updatePriority(t.id, next)}
              />
              <span>{spaceName}</span>
              {t.parent_id ? <span className="mono">· {t.parent_id}</span> : null}
            </span>
            <span>
              等了 {fmtRelativeSince(dec?.created_at ?? t.waiting_since ?? t.updated_at)}
            </span>
          </div>
          <h3 className="card-title">{t.title}</h3>
          {dec ? (
            <div className="ask-box">
              <div className="ask-q">{dec.question}</div>
              {recOpt ? (
                <div className="ask-rec">
                  <span className="rec">推荐</span>
                  {recOpt.label}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="ask-box">
              <div className="ask-q">{t.waiting_reason ?? "等待人工裁决"}</div>
            </div>
          )}
          <MiniRail track={t.track} workflow={t.workflow} status={t.status} activeStage={t.stage} />
          <div className="card-actions">
            {dec && recOpt ? (
              <button
                type="button"
                className="btn btn-sm btn-light"
                onClick={(e) => {
                  e.stopPropagation();
                  void store.submitDecision(t.id, {
                    decision_id: dec.id,
                    option_id: recOpt.id,
                    action: recOpt.action,
                    apply_ledger_rule: false,
                  });
                }}
              >
                采纳推荐
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                if (dec) {
                  store.openResolve(t.id);
                } else {
                  store.openTask(t.id);
                }
              }}
            >
              讨论
            </button>
          </div>
        </article>
      );
    }

    if (t.status === "running") {
      const rate = Math.round(ratesByTask[t.id] ?? 0);
      const stMeta = stageMeta(t.stage ?? "implement");
      const stageTitle =
        stMeta.label + (t.round && t.round > 1 ? ` · 第 ${t.round} 轮` : "");
      const execLabel =
        t.executor ??
        (t.agent && t.model ? `${t.agent} · ${t.model}` : t.agent ?? "");

      return (
        <article
          key={t.id}
          className={`card${p0Class}`}
          onClick={() => store.openTask(t.id)}
        >
          <div className="card-meta">
            <span>
              <PrioritySelect
                value={t.priority}
                onChange={(next) => void store.updatePriority(t.id, next)}
              />
              <span>
                {spaceName} · {TRACK_LABEL[t.track]}
              </span>
              {t.parent_id ? <span className="mono">· {t.parent_id}</span> : null}
            </span>
            <span className="mono">{t.id}</span>
          </div>
          <h3 className="card-title">{t.title}</h3>
          {t.summary ? <p className="card-desc">{t.summary}</p> : null}
          <div className="live-row">
            <span className="live-stage">
              <span className="dot live-dot" />
              {stageTitle}
            </span>
            <span className="mono muted" data-rate={t.id}>
              {rate} tok/s
            </span>
          </div>
          <MiniRail
            track={t.track}
            workflow={t.workflow}
            status={t.status}
            activeStage={t.stage}
            rate={rate}
          />
          <div className="card-foot">
            <span>{execLabel}</span>
            <span className="mono">{fmtTokens(t.tokens.total_tokens)}</span>
          </div>
        </article>
      );
    }

    if (t.status === "paused") {
      const stMeta = stageMeta(t.stage);
      return (
        <article
          key={t.id}
          className={`card${p0Class}`}
          onClick={() => store.openTask(t.id)}
        >
          <div className="card-meta">
            <span>
              <PrioritySelect
                value={t.priority}
                onChange={(next) => void store.updatePriority(t.id, next)}
              />
              <span>
                {spaceName} · {TRACK_LABEL[t.track]}
              </span>
              {t.parent_id ? <span className="mono">· {t.parent_id}</span> : null}
            </span>
            <span className="chip chip-paused" style={{ height: "20px" }}>
              已暂停
            </span>
          </div>
          <h3 className="card-title">{t.title}</h3>
          {t.summary ? <p className="card-desc">{t.summary}</p> : null}
          <MiniRail track={t.track} workflow={t.workflow} status={t.status} activeStage={t.stage} />
          <div
            className="card-actions"
            style={{ justifyContent: "space-between", alignItems: "center" }}
          >
            <span className="muted" style={{ fontSize: "12px" }}>
              {t.stage ? `${stMeta.label} · 现场已保留` : "已暂停 · 现场已保留"}
            </span>
            <button
              type="button"
              className="btn btn-sm btn-light"
              onClick={(e) => {
                e.stopPropagation();
                void store.resumeTask(t.id);
              }}
            >
              继续推进
            </button>
          </div>
        </article>
      );
    }

    if (t.status === "queued") {
      return (
        <article
          key={t.id}
          className={`card${p0Class}`}
          onClick={() => store.openTask(t.id)}
        >
          <div className="card-meta">
            <span>
              <PrioritySelect
                value={t.priority}
                onChange={(next) => void store.updatePriority(t.id, next)}
              />
              <span>
                {spaceName} · {TRACK_LABEL[t.track]}
              </span>
              {t.parent_id ? <span className="mono">· {t.parent_id}</span> : null}
            </span>
            <span>排队</span>
          </div>
          <h3 className="card-title">{t.title}</h3>
          {t.summary ? <p className="card-desc">{t.summary}</p> : null}
          <MiniRail track={t.track} workflow={t.workflow} status={t.status} activeStage={t.stage} />
          <div className="card-foot">
            <span>
              {t.depends_on.length > 0
                ? `等 ${t.depends_on.join("、")} 完成后开始`
                : "等执行槽位"}
            </span>
          </div>
        </article>
      );
    }

    if (t.status === "external") {
      return (
        <article
          key={t.id}
          className={`card${p0Class}`}
          onClick={() => store.openTask(t.id)}
        >
          <div className="card-meta">
            <span>
              <PrioritySelect
                value={t.priority}
                onChange={(next) => void store.updatePriority(t.id, next)}
              />
              <span>{spaceName}</span>
            </span>
            <span>{fmtRelativeSince(t.updated_at)}</span>
          </div>
          <h3 className="card-title">{t.title}</h3>
          <p className="card-desc">{t.summary ?? "等待外部回应"}</p>
          <MiniRail track={t.track} workflow={t.workflow} status={t.status} activeStage={t.stage} />
          <div className="card-foot">
            <span className="mono">{t.id}</span>
            <span>外部等待</span>
          </div>
        </article>
      );
    }

    const taskCost = computeTaskCostUsd(t, pricing);
    return (
      <article
        key={t.id}
        className="card card-done"
        onClick={() => store.openTask(t.id)}
      >
        <h3 className="card-title">{t.title}</h3>
        <div className="card-foot">
          <span className="mono">
            {t.delivered_ref ??
              (t.tokens.total_tokens > 0
                ? `${fmtTokens(t.tokens.total_tokens)} · ${fmtUsd(taskCost)}`
                : t.id)}
          </span>
          <span>{fmtDateShort(t.updated_at)}</span>
        </div>
      </article>
    );
  };

  return (
    <ViewFrame
      isBoard
      left={
        <>
          <h1 className="tb-title">总览</h1>
          <span className="tb-sub">
            {runningLeafCount} 个任务在跑
            {pausedLeafCount > 0 ? `，${pausedLeafCount} 个已暂停` : ""}
            {waitingTotal > 0 ? `，${waitingTotal} 件事等你决定` : ""}
          </span>
        </>
      }
      right={
        <>
          <select
            className="select"
            aria-label="筛选优先级"
            style={{ width: "120px", height: "30px" }}
            value={priorityFilter}
            onChange={(e) =>
              store.setPriorityFilter(
                (e.currentTarget as HTMLSelectElement).value as "all" | Priority,
              )
            }
          >
            <option value="all">全部优先级</option>
            <option value="P0">P0 紧急</option>
            <option value="P1">P1 重要</option>
            <option value="P2">P2 普通</option>
            <option value="P3">P3 有空再做</option>
          </select>
          <div className="seg" role="group" aria-label="时间范围">
            {PERIOD_OPTIONS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={periodFilter === key ? "on" : ""}
                onClick={() => store.setPeriodFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      }
    >
      {state.bootstrapError && !state.bootstrapLoaded ? (
        <div className="page">
          <div className="conflict-box">
            <div className="conflict-head">
              <span>无法连接 Kiln 内核</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void store.retryConnection()}
              >
                重试
              </button>
            </div>
            <p>{state.bootstrapError}</p>
          </div>
        </div>
      ) : (
        <div className="board">
          {cols.map((col) => (
            <section key={col.name} className="col">
              <div className="col-head">
                <div className="col-name">
                  <span className="dot" style={{ background: col.color }} />
                  <span>{col.name}</span>
                  <span className="nav-count">{col.items.length}</span>
                </div>
                <div className="col-hint">{col.hint}</div>
              </div>
              <div className="col-body">
                {col.items.length > 0 ? (
                  col.items.map(renderCard)
                ) : (
                  <div className="col-empty">这一列现在是空的</div>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </ViewFrame>
  );
}
