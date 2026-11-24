import { useEffect, useState } from "react";
import type {
  ChecklistDisposition,
  ChecklistItem,
  ChecklistItemSeverity,
  StageId,
  TaskStatus,
} from "@kiln/protocol/web";
import { resolveTaskChecklist } from "../api/client";

export interface ReviewChecklistPanelProps {
  taskId: string;
  taskStatus: TaskStatus;
  taskStage: StageId | null;
  items: ChecklistItem[];
  onResolved: () => Promise<void> | void;
}

function isBlockingItem(item: ChecklistItem): boolean {
  if (item.source === "review") {
    return item.severity === "P0" || item.severity === "P1";
  }
  return item.severity === "fail";
}

function severityLabel(sev: ChecklistItemSeverity): string {
  if (sev === "pass") return "通过";
  if (sev === "fail") return "失败";
  if (sev === "skipped") return "跳过";
  return sev;
}

function severityBadgeClass(sev: ChecklistItemSeverity): string {
  if (sev === "P0" || sev === "fail") return "chip chip-bad";
  if (sev === "P1") return "chip chip-warn";
  if (sev === "pass") return "chip chip-ok";
  return "chip";
}

interface DraftChoice {
  disposition?: ChecklistDisposition;
  rationale: string;
}

export function ReviewChecklistPanel({
  taskId,
  taskStatus,
  taskStage,
  items,
  onResolved,
}: ReviewChecklistPanelProps) {
  const [drafts, setDrafts] = useState<Record<string, DraftChoice>>({});
  const [extraNote, setExtraNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    setDrafts({});
    setExtraNote("");
    setErrorMsg(null);
    setStatusMsg(null);
  }, [taskId]);

  if (items.length === 0) {
    return null;
  }

  const readOnly = taskStatus === "done" || taskStatus === "cancelled";
  const reviewItems = items.filter((item) => item.source === "review");
  const acceptItems = items.filter((item) => item.source === "accept");

  const selectedEntries = items
    .map((item) => ({
      item,
      choice: drafts[item.id],
    }))
    .filter(
      (entry): entry is {
        item: ChecklistItem;
        choice: { disposition: ChecklistDisposition; rationale: string };
      } => Boolean(entry.choice?.disposition),
    );

  const reworkCount = selectedEntries.filter(
    (entry) => entry.choice.disposition === "rework",
  ).length;
  const waiveCount = selectedEntries.filter(
    (entry) => entry.choice.disposition === "waive",
  ).length;

  const canAdvanceAfterWaive =
    !readOnly &&
    reworkCount === 0 &&
    waiveCount > 0 &&
    taskStatus === "waiting" &&
    (taskStage === "review" || taskStage === "accept") &&
    items.every((item) => {
      if (!isBlockingItem(item)) return true;
      const effective = drafts[item.id]?.disposition ?? item.disposition;
      return Boolean(effective);
    });

  const setItemDisposition = (
    itemId: string,
    disposition: ChecklistDisposition | undefined,
  ): void => {
    setErrorMsg(null);
    setStatusMsg(null);
    setDrafts((prev) => {
      const existing = prev[itemId];
      if (!disposition) {
        const next = { ...prev };
        delete next[itemId];
        return next;
      }
      return {
        ...prev,
        [itemId]: {
          disposition,
          rationale: existing?.rationale ?? "",
        },
      };
    });
  };

  const setItemRationale = (itemId: string, rationale: string): void => {
    setErrorMsg(null);
    setDrafts((prev) => {
      const existing = prev[itemId];
      if (!existing) return prev;
      return {
        ...prev,
        [itemId]: {
          ...existing,
          rationale,
        },
      };
    });
  };

  const submitResolution = async (advanceAfterWaive: boolean): Promise<void> => {
    if (submitting || selectedEntries.length === 0) return;

    const missingWaiveRationale = selectedEntries.find(
      (entry) =>
        entry.choice.disposition === "waive" &&
        entry.choice.rationale.trim().length === 0,
    );
    if (missingWaiveRationale) {
      setErrorMsg(
        `确认豁免「${missingWaiveRationale.item.title}」必须填写豁免理由`,
      );
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const res = await resolveTaskChecklist(taskId, {
        items: selectedEntries.map(({ item, choice }) => ({
          item_id: item.id,
          disposition: choice.disposition,
          ...(choice.rationale.trim().length > 0
            ? { rationale: choice.rationale.trim() }
            : {}),
        })),
        ...(extraNote.trim().length > 0 ? { extra_note: extraNote.trim() } : {}),
        interrupt: false,
        advance_after_waive: advanceAfterWaive,
      });

      setDrafts({});
      setExtraNote("");
      setStatusMsg(
        res.mode === "rework_queued"
          ? "已提交打回修复并重新入队 implement 阶段"
          : res.mode === "steered"
            ? "已将打回修复指令注入当前执行上下文"
            : res.mode === "waived_and_advanced"
              ? "已确认豁免并推进至下一阶段"
              : "已保存审查/验收清单裁决记录",
      );
      await onResolved();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const renderGroup = (title: string, groupItems: ChecklistItem[]) => {
    if (groupItems.length === 0) return null;
    return (
      <div className="checklist-group">
        <div className="checklist-group-title">{title}</div>
        {groupItems.map((item) => {
          const draft = drafts[item.id];
          const activeDisp = draft?.disposition;
          return (
            <div key={item.id} className="checklist-row">
              <div className="checklist-row-head">
                <div className="checklist-row-main">
                  <span className={severityBadgeClass(item.severity)}>
                    {severityLabel(item.severity)}
                  </span>
                  <strong className="checklist-row-title">{item.title}</strong>
                  {item.location ? (
                    <code className="session-path-chip mono">{item.location}</code>
                  ) : null}
                  {item.disposition ? (
                    <span
                      className={`chip ${
                        item.disposition === "rework" ? "chip-warn" : "chip-ok"
                      }`}
                    >
                      {item.disposition === "rework"
                        ? "已打回修复"
                        : `已豁免${item.rationale ? `：${item.rationale}` : ""}`}
                    </span>
                  ) : null}
                </div>

                {!readOnly ? (
                  <div
                    className="checklist-seg"
                    role="group"
                    aria-label={`处理条目 ${item.title}`}
                  >
                    <button
                      type="button"
                      className={`checklist-seg-btn${!activeDisp ? " is-active" : ""}`}
                      onClick={() => setItemDisposition(item.id, undefined)}
                    >
                      不处理
                    </button>
                    <button
                      type="button"
                      className={`checklist-seg-btn${
                        activeDisp === "rework" ? " is-active is-rework" : ""
                      }`}
                      onClick={() => setItemDisposition(item.id, "rework")}
                    >
                      打回修复
                    </button>
                    <button
                      type="button"
                      className={`checklist-seg-btn${
                        activeDisp === "waive" ? " is-active is-waive" : ""
                      }`}
                      onClick={() => setItemDisposition(item.id, "waive")}
                    >
                      确认豁免
                    </button>
                  </div>
                ) : null}
              </div>

              {item.detail ? (
                <div className="checklist-row-detail muted">{item.detail}</div>
              ) : null}

              {!readOnly && activeDisp ? (
                <input
                  type="text"
                  className="input input-sm checklist-input"
                  aria-label={
                    activeDisp === "waive"
                      ? `豁免理由：${item.title}`
                      : `修复批注：${item.title}`
                  }
                  placeholder={
                    activeDisp === "waive"
                      ? "填写确认豁免理由（必填）"
                      : "可选：填写给执行者的修复说明"
                  }
                  value={draft?.rationale ?? ""}
                  onChange={(e) => setItemRationale(item.id, e.currentTarget.value)}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <section className="checklist-panel" aria-label="审查与验收缺陷交互清单">
      <div className="checklist-head">
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <h4>审查与验收缺陷清单（{items.length}）</h4>
          <span className="muted" style={{ fontSize: "12px" }}>
            可逐条选择「打回修复」或「确认豁免（需附理由）」
          </span>
        </div>
      </div>

      {errorMsg ? (
        <div className="alert-err" role="alert">
          {errorMsg}
        </div>
      ) : null}
      {statusMsg ? <div className="chip chip-ok">{statusMsg}</div> : null}

      {renderGroup(`独立审查缺陷（Reviewer · ${reviewItems.length}）`, reviewItems)}
      {renderGroup(`真实验收场景（Verifier · ${acceptItems.length}）`, acceptItems)}

      {!readOnly && selectedEntries.length > 0 ? (
        <div className="checklist-foot">
          <input
            type="text"
            className="input input-sm"
            style={{ flex: 1, minWidth: "200px" }}
            aria-label="清单总补充说明（可选）"
            placeholder="可选：补充整体返工或豁免说明"
            value={extraNote}
            onChange={(e) => setExtraNote(e.currentTarget.value)}
          />
          {reworkCount > 0 ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={submitting}
              onClick={() => void submitResolution(false)}
            >
              {submitting
                ? "提交中..."
                : `提交并打回修复（${reworkCount} 修复${waiveCount > 0 ? ` / ${waiveCount} 豁免` : ""}）`}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-sm"
                disabled={submitting}
                onClick={() => void submitResolution(false)}
              >
                {submitting ? "保存中..." : `保存豁免记录（${waiveCount}）`}
              </button>
              {canAdvanceAfterWaive ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={submitting}
                  onClick={() => void submitResolution(true)}
                >
                  {submitting ? "推进中..." : "确认豁免并推进下一阶段"}
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
