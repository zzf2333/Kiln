import { useEffect, useMemo, useState } from "react";
import { formatSelectedOptionsReply, type ParsedQuestion } from "../state/clarification-parser";
import { CheckIcon, SendIcon, SparkleIcon } from "./Icons";

export interface OptionPickerCardProps {
  questions: readonly ParsedQuestion[];
  disabled: boolean;
  onSubmit: (replyText: string) => void;
  onFill: (replyText: string) => void;
}

export function OptionPickerCard({ questions, disabled, onSubmit, onFill }: OptionPickerCardProps) {
  const sig = useMemo(
    () =>
      questions
        .map((q) => `${q.number}:${q.title}:${q.options.map((o) => o.key).join(",")}`)
        .join("|"),
    [questions],
  );

  const [selections, setSelections] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setSelections({});
    setNotes({});
    setOpenNotes({});
  }, [sig]);

  const hasAnyRecommended = questions.some((q) => q.options.some((o) => o.recommended));
  const selectedCount = questions.filter((q) => Boolean(selections[q.number])).length;
  const allSelected = selectedCount === questions.length && questions.length > 0;

  const pickOption = (qNumber: string, optKey: string, needsInput: boolean): void => {
    setSelections((prev) => ({ ...prev, [qNumber]: optKey }));
    if (needsInput) {
      setOpenNotes((prev) => ({ ...prev, [qNumber]: true }));
    }
  };

  const pickAllRecommended = (): void => {
    const next: Record<string, string> = {};
    for (const q of questions) {
      const rec = q.options.find((o) => o.recommended);
      if (rec) {
        next[q.number] = rec.key;
      } else if (selections[q.number]) {
        next[q.number] = selections[q.number]!;
      }
    }
    setSelections(next);
  };

  const replyText = formatSelectedOptionsReply(questions, selections, notes);

  return (
    <div className="opt-picker" role="region" aria-label="快捷方案选择">
      <div className="opt-head">
        <div className="opt-head-l">
          <SparkleIcon />
          <span className="opt-title">快速拍板 · 勾选方案直接回复</span>
          <span className="opt-progress mono">
            {selectedCount} / {questions.length}
          </span>
        </div>
        <div className="opt-head-r">
          {hasAnyRecommended ? (
            <button
              type="button"
              className="btn btn-sm opt-rec-all"
              disabled={disabled}
              onClick={pickAllRecommended}
            >
              <CheckIcon />
              <span>一键选推荐</span>
            </button>
          ) : null}
        </div>
      </div>

      <div className="opt-questions">
        {questions.map((q) => {
          const picked = selections[q.number];
          const noteOpen = Boolean(openNotes[q.number]) || Boolean(notes[q.number]?.trim());
          return (
            <div key={q.number} className="opt-q">
              <div className="opt-q-head">
                <span className="opt-q-num mono">{q.number}</span>
                <span className="opt-q-title">{q.title}</span>
                <button
                  type="button"
                  className={`opt-note-toggle ${noteOpen ? "on" : ""}`}
                  disabled={disabled}
                  onClick={() => setOpenNotes((prev) => ({ ...prev, [q.number]: !prev[q.number] }))}
                >
                  {noteOpen ? "收起补充" : "+ 补充说明"}
                </button>
              </div>

              <div className="opt-grid" role="radiogroup" aria-label={q.title}>
                {q.options.map((opt) => {
                  const isOn = picked === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      role="radio"
                      aria-checked={isOn}
                      disabled={disabled}
                      className={`opt-card ${isOn ? "on" : ""} ${opt.recommended ? "is-rec" : ""}`}
                      onClick={() => pickOption(q.number, opt.key, opt.needsInput)}
                    >
                      <div className="opt-card-top">
                        <span className="opt-key mono">{opt.key}</span>
                        <span className="opt-card-label">{opt.label}</span>
                        {opt.recommended ? <span className="opt-rec-tag">推荐</span> : null}
                      </div>
                      {opt.detail ? <div className="opt-card-detail">{opt.detail}</div> : null}
                    </button>
                  );
                })}
              </div>

              {noteOpen ? (
                <div className="opt-note-row">
                  <input
                    type="text"
                    className="input input-sm opt-note-input"
                    disabled={disabled}
                    placeholder={`为第 ${q.number} 题补充具体名称、范围或条件（可选）`}
                    aria-label={`第 ${q.number} 题补充说明`}
                    value={notes[q.number] ?? ""}
                    onChange={(e) => {
                      const val = (e.currentTarget as HTMLInputElement).value;
                      setNotes((prev) => ({ ...prev, [q.number]: val }));
                    }}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="opt-foot">
        <div className="opt-foot-l">
          {selectedCount > 0 ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={disabled}
              onClick={() => {
                setSelections({});
                setNotes({});
              }}
            >
              清空选择
            </button>
          ) : (
            <span className="muted" style={{ fontSize: "11.5px" }}>
              点选任意选项，或直接下方输入补充想法
            </span>
          )}
        </div>
        <div className="opt-foot-r">
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled || selectedCount === 0}
            onClick={() => onFill(replyText)}
          >
            填入输入框
          </button>
          <button
            type="button"
            className={`btn btn-sm ${allSelected ? "btn-light" : ""}`}
            disabled={disabled || selectedCount === 0}
            onClick={() => onSubmit(replyText)}
          >
            <SendIcon />
            <span>发送所选方案</span>
          </button>
        </div>
      </div>
    </div>
  );
}
