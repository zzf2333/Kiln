import {
  validateSplitCardsDag,
  type Priority,
  type RosterConfig,
  type Track,
} from "@kiln/protocol/web";
import type { SplitCardPlanItem } from "../api/types";
import { GitPrIcon, PlusIcon, TrashIcon } from "./Icons";

export interface SplitCardsPanelProps {
  cards: SplitCardPlanItem[];
  roster: RosterConfig;
  busy: boolean;
  onUpdateCard: (index: number, patch: Partial<SplitCardPlanItem>) => void;
  onAddCard: () => void;
  onRemoveCard: (index: number) => void;
  onCommit: () => void;
  onCancel: () => void;
}

const PRIORITY_OPTS: Priority[] = ["P0", "P1", "P2", "P3"];
const TRACK_OPTS: Array<Exclude<Track, "L3">> = ["L1", "L2"];

function getCardRosterRole(card: SplitCardPlanItem): string | undefined {
  for (const step of card.workflow?.steps ?? []) {
    if (step.kind === "agent" && step.stage === "implement" && step.roster_role) {
      return step.roster_role;
    }
    if (step.kind === "loop") {
      const inner = step.steps.find(
        (n) => n.kind === "agent" && n.stage === "implement" && n.roster_role,
      );
      if (inner && inner.kind === "agent") return inner.roster_role;
    }
  }
  return undefined;
}

export function SplitCardsPanel({
  cards,
  roster,
  busy,
  onUpdateCard,
  onAddCard,
  onRemoveCard,
  onCommit,
  onCancel,
}: SplitCardsPanelProps) {
  const dag = validateSplitCardsDag(cards);
  const countValid = cards.length >= 2 && cards.length <= 12;
  const allFieldsValid = cards.every(
    (c) =>
      (c.temp_id ?? "").trim().length > 0 &&
      (c.title ?? "").trim().length > 0 &&
      (c.contract?.end ?? "").trim().length > 0 &&
      (c.contract?.accept_cmd ?? "").trim().length > 0 &&
      (c.contract?.scope?.length ?? 0) > 0 &&
      (c.brief_markdown ?? "").trim().length > 0,
  );
  const canCommit = countValid && dag.ok && allFieldsValid && !busy;
  const byTempId = new Map(cards.map((c) => [(c.temp_id ?? "").trim(), c]));

  const toggleDep = (cardIndex: number, depTempId: string): void => {
    const target = cards[cardIndex];
    if (!target) return;
    const currentDeps = Array.isArray(target.depends_on_temp_ids)
      ? target.depends_on_temp_ids
      : [];
    const exists = currentDeps.includes(depTempId);
    const nextDeps = exists
      ? currentDeps.filter((d) => d !== depTempId)
      : [...currentDeps, depTempId];
    onUpdateCard(cardIndex, { depends_on_temp_ids: nextDeps });
  };

  return (
    <section className="split-panel" aria-label="多卡拆片 DAG 预览">
      <div className="split-panel-head">
        <div className="split-panel-title">
          <GitPrIcon />
          <b>拆卡 DAG 依赖编排（{cards.length} / 12）</b>
        </div>
        <div className="split-panel-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={cards.length >= 12 || busy}
            onClick={onAddCard}
          >
            <PlusIcon />
            <span>添加切片</span>
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={busy}
            onClick={onCancel}
          >
            返回单卡
          </button>
        </div>
      </div>

      {!countValid ? (
        <div className="note note-bad">
          批量拆卡数量须为 2–12 张（当前 {cards.length} 张）
        </div>
      ) : null}

      {dag.ok ? (
        <div className="dag-flow" aria-label="拓扑执行顺序">
          <span className="muted">拓扑顺序：</span>
          {dag.order.map((tid, idx) => {
            const item = byTempId.get(tid);
            return (
              <span key={tid} className="dag-node">
                {idx > 0 ? <span className="dag-arrow">→</span> : null}
                <span className="dag-pill">
                  <span className="mono">{tid}</span>
                  {item?.title ? ` · ${item.title}` : ""}
                </span>
              </span>
            );
          })}
        </div>
      ) : (
        <div className="note note-bad" role="alert">
          DAG 依赖校验失败：{dag.errors.join("；")}
        </div>
      )}

      <div className="split-cards-list">
        {cards.map((card, index) => {
          const roleId = getCardRosterRole(card);
          const roleEntry = roleId ? roster.roster[roleId] : undefined;
          const selfTempId = (card.temp_id ?? "").trim();
          const otherTempIds = Array.from(
            new Set(
              cards
                .map((c) => (c.temp_id ?? "").trim())
                .filter((tid) => tid.length > 0 && tid !== selfTempId),
            ),
          );

          return (
            <div key={`${card.temp_id}-${index}`} className="split-card">
              <div className="split-card-head">
                <span className="mono chip">{card.temp_id}</span>
                {roleEntry ? <span className="chip">{roleEntry.name}</span> : null}
                <div className="seg" role="group" aria-label={`切片 ${card.temp_id} 优先级`}>
                  {PRIORITY_OPTS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={card.priority === p ? "on" : ""}
                      onClick={() => onUpdateCard(index, { priority: p })}
                    >
                      {p}
                    </button>
                  ))}
                </div>
                <div className="seg" role="group" aria-label={`切片 ${card.temp_id} 轨道`}>
                  {TRACK_OPTS.map((tr) => (
                    <button
                      key={tr}
                      type="button"
                      className={card.track === tr ? "on" : ""}
                      onClick={() => onUpdateCard(index, { track: tr })}
                    >
                      {tr}
                    </button>
                  ))}
                </div>
                <span className="sp" />
                <button
                  type="button"
                  className="icon-btn"
                  title="删除切片"
                  aria-label={`删除切片 ${card.temp_id}`}
                  disabled={cards.length <= 2 || busy}
                  onClick={() => onRemoveCard(index)}
                >
                  <TrashIcon />
                </button>
              </div>

              <div className="split-card-grid">
                <label className="modal-field">
                  <span>切片标题</span>
                  <input
                    aria-label={`切片 ${card.temp_id} 标题`}
                    className="input"
                    value={card.title}
                    onChange={(e) => {
                      const title = e.currentTarget.value;
                      onUpdateCard(index, {
                        title,
                        contract: { ...card.contract, goal: title || card.contract.goal },
                      });
                    }}
                  />
                </label>
                <label className="modal-field">
                  <span>可改范围 (逗号分隔)</span>
                  <input
                    aria-label={`切片 ${card.temp_id} 范围`}
                    className="input mono"
                    value={(card.contract?.scope ?? []).join(", ")}
                    onChange={(e) => {
                      const nextScope = e.currentTarget.value
                        .split(/[\n,]+/)
                        .map((s) => s.trim())
                        .filter(Boolean);
                      onUpdateCard(index, {
                        contract: { ...card.contract, scope: nextScope },
                      });
                    }}
                  />
                </label>
                <label className="modal-field">
                  <span>验收命令</span>
                  <input
                    aria-label={`切片 ${card.temp_id} 验收命令`}
                    className="input mono"
                    value={card.contract?.accept_cmd ?? ""}
                    onChange={(e) =>
                      onUpdateCard(index, {
                        contract: { ...card.contract, accept_cmd: e.currentTarget.value },
                      })
                    }
                  />
                </label>
                <label className="modal-field">
                  <span>交付终点</span>
                  <input
                    aria-label={`切片 ${card.temp_id} 交付终点`}
                    className="input"
                    value={card.contract?.end ?? ""}
                    onChange={(e) =>
                      onUpdateCard(index, {
                        contract: { ...card.contract, end: e.currentTarget.value },
                      })
                    }
                  />
                </label>
              </div>

              {otherTempIds.length > 0 ? (
                <div className="split-deps-row">
                  <span className="muted">前置依赖：</span>
                  <div className="split-dep-chips" role="group" aria-label={`切片 ${card.temp_id} 前置依赖`}>
                    {otherTempIds.map((depId) => {
                      const active = Array.isArray(card.depends_on_temp_ids)
                        ? card.depends_on_temp_ids.includes(depId)
                        : false;
                      return (
                        <button
                          key={depId}
                          type="button"
                          aria-pressed={active}
                          className={`chip-tab ${active ? "on" : ""}`}
                          onClick={() => toggleDep(index, depId)}
                        >
                          {depId}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="split-panel-foot">
        <button
          type="button"
          className="btn btn-light"
          disabled={!canCommit}
          onClick={onCommit}
        >
          {busy ? "正在批量建卡…" : `批量立项（${cards.length} 张卡）`}
        </button>
      </div>
    </section>
  );
}
