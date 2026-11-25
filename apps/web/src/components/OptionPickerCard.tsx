import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatSelectedOptionsReply, type ParsedQuestion } from "../state/clarification-parser";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  SendIcon,
  SparkleIcon,
} from "./Icons";

export interface OptionPickerCardProps {
  questions: readonly ParsedQuestion[];
  disabled: boolean;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  onSubmit: (replyText: string) => void;
  onFill: (replyText: string) => void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function OptionPickerCard({
  questions,
  disabled,
  collapsed,
  onCollapsedChange,
  onSubmit,
  onFill,
}: OptionPickerCardProps) {
  const sig = useMemo(
    () =>
      questions
        .map((q) => `${q.number}:${q.title}:${q.options.map((o) => o.key).join(",")}`)
        .join("|"),
    [questions],
  );

  const [step, setStep] = useState(0);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({});
  const [internalCollapsed, setInternalCollapsed] = useState(false);

  const noteInputRef = useRef<HTMLInputElement | null>(null);
  const wizardRef = useRef<HTMLDivElement | null>(null);
  const stepperRef = useRef<HTMLDivElement | null>(null);

  const isControlled = collapsed !== undefined;
  const isCollapsed = collapsed ?? internalCollapsed;
  const onCollapsedChangeRef = useRef(onCollapsedChange);
  onCollapsedChangeRef.current = onCollapsedChange;

  const setCollapsed = useCallback(
    (next: boolean): void => {
      if (!isControlled) {
        setInternalCollapsed(next);
      }
      onCollapsedChangeRef.current?.(next);
    },
    [isControlled],
  );

  useEffect(() => {
    setStep(0);
    setSelections({});
    setNotes({});
    setOpenNotes({});
    setCollapsed(false);
  }, [sig, setCollapsed]);

  const totalSteps = questions.length;
  const clampedStep = Math.max(0, Math.min(totalSteps, step));
  const isSummary = clampedStep >= totalSteps;

  useEffect(() => {
    if (isCollapsed) return;
    const activeTab = stepperRef.current?.querySelector<HTMLElement>(".opt-step-pill.is-current");
    if (activeTab && typeof activeTab.scrollIntoView === "function") {
      activeTab.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [clampedStep, isCollapsed]);
  const currentQuestion = !isSummary ? questions[clampedStep] : undefined;

  const hasAnyRecommended = questions.some((q) => q.options.some((o) => o.recommended));
  const selectedCount = questions.filter((q) => Boolean(selections[q.number])).length;
  const replyText = useMemo(
    () => formatSelectedOptionsReply(questions, selections, notes),
    [questions, selections, notes],
  );

  const pickOption = useCallback(
    (qNumber: string, optKey: string, needsInput: boolean): void => {
      setSelections((prev) => ({ ...prev, [qNumber]: optKey }));
      const noteAlreadyOpen = Boolean(openNotes[qNumber]) || Boolean(notes[qNumber]?.trim());
      if (needsInput) {
        setOpenNotes((prev) => ({ ...prev, [qNumber]: true }));
        requestAnimationFrame(() => noteInputRef.current?.focus());
        return;
      }
      if (!noteAlreadyOpen) {
        setStep((cur) => Math.min(totalSteps, cur + 1));
      }
    },
    [openNotes, notes, totalSteps],
  );

  const pickAllRecommended = useCallback((): void => {
    setSelections((prev) => {
      const next: Record<string, string> = {};
      for (const q of questions) {
        const rec = q.options.find((o) => o.recommended);
        if (rec) {
          next[q.number] = rec.key;
        } else if (prev[q.number]) {
          next[q.number] = prev[q.number]!;
        }
      }
      return next;
    });
    setStep(totalSteps);
  }, [questions, totalSteps]);

  useEffect(() => {
    if (isCollapsed || disabled || totalSteps === 0) return;

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;
      if (document.querySelector(".palette-bg, .modal-bg, .composer-popup")) return;

      if (e.key === "Escape") {
        e.preventDefault();
        setCollapsed(true);
        return;
      }

      if ((e.key === "ArrowLeft" || e.key === "Backspace") && clampedStep > 0) {
        e.preventDefault();
        setStep((cur) => Math.max(0, cur - 1));
        return;
      }

      if (e.key === "ArrowRight" && !isSummary) {
        e.preventDefault();
        setStep((cur) => Math.min(totalSteps, cur + 1));
        return;
      }

      if (e.key === "Enter" && isSummary && selectedCount > 0) {
        if (e.target instanceof HTMLButtonElement) return;
        e.preventDefault();
        onSubmit(replyText);
        return;
      }

      if (!isSummary && currentQuestion && /^[a-fA-F]$/.test(e.key)) {
        const keyUpper = e.key.toUpperCase();
        const opt = currentQuestion.options.find((o) => o.key === keyUpper);
        if (opt) {
          e.preventDefault();
          pickOption(currentQuestion.number, opt.key, opt.needsInput);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    isCollapsed,
    disabled,
    totalSteps,
    clampedStep,
    isSummary,
    currentQuestion,
    selectedCount,
    replyText,
    pickOption,
    onSubmit,
    setCollapsed,
  ]);

  if (totalSteps === 0) return null;

  if (isCollapsed) {
    return (
      <div className="opt-wizard-dock is-collapsed">
        <div className="opt-wizard-pill" role="region" aria-label="快捷方案选择向导（已收起）">
          <div className="opt-wizard-pill-l">
            <SparkleIcon />
            <span className="opt-title">方案向导</span>
            <span className="opt-progress mono">
              {isSummary ? "汇总确认" : `第 ${clampedStep + 1} / ${totalSteps} 步`}
            </span>
            <span className="muted" style={{ fontSize: "11.5px" }}>
              已选 {selectedCount}/{totalSteps}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-sm opt-pill-open-btn"
            onClick={() => setCollapsed(false)}
          >
            <ChevronUpIcon />
            <span>展开继续</span>
          </button>
        </div>
      </div>
    );
  }

  const pickedCurrent = currentQuestion ? selections[currentQuestion.number] : undefined;
  const noteOpen = currentQuestion
    ? Boolean(openNotes[currentQuestion.number]) || Boolean(notes[currentQuestion.number]?.trim())
    : false;

  return (
    <div className="opt-wizard-dock is-open">
      <div ref={wizardRef} className="opt-wizard" role="region" aria-label="快捷方案选择向导">
        <div className="opt-wiz-head">
          <div className="opt-wiz-head-l">
            <span className="opt-wiz-brand">
              <SparkleIcon />
              <span>方案向导</span>
            </span>
            <div ref={stepperRef} className="opt-stepper" role="tablist" aria-label="向导步骤">
              {questions.map((q, idx) => {
                const picked = selections[q.number];
                const isCurr = clampedStep === idx;
                return (
                  <button
                    key={q.number}
                    type="button"
                    role="tab"
                    aria-selected={isCurr}
                    aria-current={isCurr ? "step" : undefined}
                    className={`opt-step-pill ${isCurr ? "is-current" : ""} ${picked ? "is-done" : ""}`}
                    onClick={() => setStep(idx)}
                    title={`${q.number}. ${q.title}`}
                  >
                    <span className="opt-step-pill-label">
                      {q.number}. {q.title}
                    </span>
                    {picked ? <span className="opt-step-pick mono">✓ {picked}</span> : null}
                  </button>
                );
              })}
              <button
                type="button"
                role="tab"
                aria-selected={isSummary}
                aria-current={isSummary ? "step" : undefined}
                className={`opt-step-pill is-summary ${isSummary ? "is-current" : ""}`}
                onClick={() => setStep(totalSteps)}
              >
                <span className="opt-step-pill-label">汇总确认</span>
              </button>
            </div>
          </div>

          <div className="opt-wiz-head-r">
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
            <button
              type="button"
              className="btn btn-ghost btn-sm opt-wiz-collapse-btn"
              aria-label="收起向导"
              title="收起向导 (Esc)"
              onClick={() => setCollapsed(true)}
            >
              <ChevronDownIcon />
              <span>收起</span>
            </button>
          </div>
        </div>

        <div className="opt-wiz-body">
          <div key={clampedStep} className="opt-step-pane">
            {!isSummary && currentQuestion ? (
              <>
                <div className="opt-step-meta">
                  <div className="opt-step-meta-l">
                    <span className="opt-step-badge mono">
                      STEP {String(clampedStep + 1).padStart(2, "0")} /{" "}
                      {String(totalSteps).padStart(2, "0")}
                    </span>
                    <h4 className="opt-step-qtitle">{currentQuestion.title}</h4>
                  </div>
                  <button
                    type="button"
                    className={`opt-note-toggle ${noteOpen ? "on" : ""}`}
                    disabled={disabled}
                    onClick={() =>
                      setOpenNotes((prev) => ({
                        ...prev,
                        [currentQuestion.number]: !prev[currentQuestion.number],
                      }))
                    }
                  >
                    {noteOpen ? "收起补充" : "+ 补充说明"}
                  </button>
                </div>

                <div className="opt-tui-list" role="radiogroup" aria-label={currentQuestion.title}>
                  {currentQuestion.options.map((opt) => {
                    const isOn = pickedCurrent === opt.key;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        role="radio"
                        aria-checked={isOn}
                        disabled={disabled}
                        className={`opt-tui-row ${isOn ? "on" : ""} ${opt.recommended ? "is-rec" : ""}`}
                        onClick={() => pickOption(currentQuestion.number, opt.key, opt.needsInput)}
                      >
                        <span className="opt-tui-cursor mono" aria-hidden="true">
                          {isOn ? "›" : " "}
                        </span>
                        <span className="opt-key mono">{opt.key}</span>
                        <div className="opt-tui-main">
                          <div className="opt-tui-top">
                            <span className="opt-card-label">{opt.label}</span>
                            {opt.recommended ? <span className="opt-rec-tag">推荐</span> : null}
                          </div>
                          {opt.detail ? <div className="opt-card-detail">{opt.detail}</div> : null}
                        </div>
                        <span className="opt-tui-check" aria-hidden="true">
                          {isOn ? <CheckIcon /> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {noteOpen ? (
                  <div className="opt-note-row">
                    <input
                      ref={noteInputRef}
                      type="text"
                      className="input input-sm opt-note-input"
                      disabled={disabled}
                      placeholder={`为第 ${currentQuestion.number} 题补充具体名称、范围或条件（按 Enter 进入下一步）`}
                      aria-label={`第 ${currentQuestion.number} 题补充说明`}
                      value={notes[currentQuestion.number] ?? ""}
                      onChange={(e) => {
                        const val = (e.currentTarget as HTMLInputElement).value;
                        setNotes((prev) => ({ ...prev, [currentQuestion.number]: val }));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          setStep((cur) => Math.min(totalSteps, cur + 1));
                        }
                      }}
                    />
                  </div>
                ) : null}
              </>
            ) : (
              <div className="opt-summary">
                <div className="opt-summary-head">
                  <div className="opt-summary-head-l">
                    <h4>汇总确认</h4>
                    <span className="opt-progress mono">
                      {selectedCount} / {totalSteps} 已选
                    </span>
                  </div>
                  <span className="muted" style={{ fontSize: "11.5px" }}>
                    确认无误后发送，点击任意项可返回修改
                  </span>
                </div>

                <div className="opt-summary-list">
                  {questions.map((q, idx) => {
                    const pickedKey = selections[q.number];
                    const pickedOpt = pickedKey
                      ? q.options.find((o) => o.key === pickedKey)
                      : undefined;
                    const noteText = (notes[q.number] ?? "").trim();
                    return (
                      <button
                        key={q.number}
                        type="button"
                        className={`opt-summary-row ${pickedOpt ? "" : "is-missing"}`}
                        disabled={disabled}
                        onClick={() => setStep(idx)}
                      >
                        <span className="opt-q-num mono">{q.number}</span>
                        <div className="opt-summary-content">
                          <div className="opt-summary-q">{q.title}</div>
                          <div className="opt-summary-a">
                            {pickedOpt ? (
                              <>
                                <span className="opt-key mono">{pickedOpt.key}</span>
                                <span>{pickedOpt.label}</span>
                              </>
                            ) : (
                              <span className="opt-summary-empty">未选择</span>
                            )}
                          </div>
                          {noteText ? (
                            <div className="opt-summary-note">补充：{noteText}</div>
                          ) : null}
                        </div>
                        <span className="opt-summary-edit">{pickedOpt ? "修改" : "去选择"}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="opt-wiz-foot">
          <div className="opt-wiz-foot-l">
            {clampedStep > 0 ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled={disabled}
                onClick={() => setStep((cur) => Math.max(0, cur - 1))}
              >
                <ChevronLeftIcon />
                <span>上一步</span>
              </button>
            ) : (
              <span className="opt-kbd-hint mono">A–F 选择 · ←/→ 切步 · Esc 收起</span>
            )}
          </div>

          <div className="opt-wiz-foot-r">
            {!isSummary ? (
              <button
                type="button"
                className={`btn btn-sm ${pickedCurrent ? "btn-light" : ""}`}
                disabled={disabled}
                onClick={() => setStep((cur) => Math.min(totalSteps, cur + 1))}
              >
                <span>
                  {clampedStep === totalSteps - 1
                    ? "查看汇总"
                    : pickedCurrent
                      ? "下一步"
                      : "跳过此题"}
                </span>
                <ChevronRightIcon />
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={disabled}
                  onClick={() => {
                    setSelections({});
                    setNotes({});
                    setOpenNotes({});
                    setStep(0);
                  }}
                >
                  清空重选
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={disabled || selectedCount === 0}
                  onClick={() => {
                    onFill(replyText);
                    setCollapsed(true);
                  }}
                >
                  填入输入框
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-light"
                  disabled={disabled || selectedCount === 0}
                  onClick={() => onSubmit(replyText)}
                >
                  <SendIcon />
                  <span>确认并发送</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
