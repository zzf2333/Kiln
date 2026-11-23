import { useEffect, useState } from "react";
import type { DecisionAction, PendingDecision } from "@kiln/protocol/web";
import type { SubmitDecisionPayload } from "../api/types";
import { fmtTime } from "../state/format";
import { WarnCircleIcon } from "./Icons";
import { MarkdownContent } from "./MarkdownContent";

const ACTION_DESC: Record<DecisionAction, string> = {
  resume: "确认后继续推进",
  return_external: "挂起等待外部（不会自动执行）",
  finish: "直接标记完成",
  cancel: "取消任务",
};

export interface DecisionBoxProps {
  decision: PendingDecision;
  onSubmit: (payload: SubmitDecisionPayload) => Promise<boolean>;
  onOpenResolve?: () => void;
}

export function DecisionBox({
  decision,
  onSubmit,
  onOpenResolve,
}: DecisionBoxProps) {
  const defaultOptId =
    decision.options.find((o) => o.recommended)?.id ??
    decision.options[0]?.id ??
    "";

  const [selectedOptionId, setSelectedOptionId] = useState<string>(defaultOptId);
  const [applyLedgerRule, setApplyLedgerRule] = useState<boolean>(false);
  const [rationale, setRationale] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);

  useEffect(() => {
    setSelectedOptionId(
      decision.options.find((o) => o.recommended)?.id ??
        decision.options[0]?.id ??
        "",
    );
    setApplyLedgerRule(false);
    setRationale("");
  }, [decision.id]);

  const selectedOption =
    decision.options.find((o) => o.id === selectedOptionId) ?? decision.options[0];
  const ledgerRuleText = selectedOption?.ledger_rule?.trim() ?? "";
  const hasLedgerRule = ledgerRuleText.length > 0;

  const handleSelectOption = (optionId: string): void => {
    setSelectedOptionId(optionId);
    setApplyLedgerRule(false);
  };

  const handleConfirm = async (): Promise<void> => {
    if (!selectedOption || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit({
        decision_id: decision.id,
        option_id: selectedOption.id,
        action: selectedOption.action,
        ...(rationale.trim() ? { rationale: rationale.trim() } : {}),
        apply_ledger_rule: hasLedgerRule ? applyLedgerRule : false,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="decision">
      <div className="decision-head">
        <span className="ico-chip ask">
          <WarnCircleIcon />
        </span>
        <div className="decision-head-t">
          <b>需要你决定</b>
          <span className="muted">
            {decision.category} · {fmtTime(decision.created_at)} · {decision.reason}
          </span>
        </div>
      </div>
      <div className="decision-q">
        <MarkdownContent text={decision.question} />
      </div>
      <div className="options">
        {decision.options.map((opt) => {
          const checked = opt.id === selectedOption?.id;
          return (
            <label key={opt.id} className="option">
              <input
                type="radio"
                name={`opt-${decision.id}`}
                value={opt.id}
                checked={checked}
                onChange={() => handleSelectOption(opt.id)}
              />
              <div>
                <div className="opt-label">
                  {opt.recommended ? <span className="rec">推荐</span> : null}
                  <span>{opt.label}</span>
                  <span
                    className={opt.action === "return_external" ? "opt-act is-warn" : "opt-act"}
                    data-action={opt.action}
                    title={ACTION_DESC[opt.action]}
                  >
                    {opt.action}
                  </span>
                  <span
                    className={
                      opt.action === "return_external"
                        ? "opt-act-desc is-warn"
                        : "opt-act-desc"
                    }
                  >
                    {ACTION_DESC[opt.action]}
                  </span>
                </div>
                {opt.cost_note ? (
                  <div className="opt-effect">{opt.cost_note}</div>
                ) : null}
                {opt.ledger_rule ? (
                  <div className="opt-effect muted">
                    可选账本规则：{opt.ledger_rule}
                  </div>
                ) : null}
              </div>
            </label>
          );
        })}
      </div>

      {hasLedgerRule ? (
        <label className="ledger-check">
          <input
            type="checkbox"
            checked={applyLedgerRule}
            onChange={(e) =>
              setApplyLedgerRule((e.currentTarget as HTMLInputElement).checked)
            }
          />
          <span>同时将长期规则「{ledgerRuleText}」写入决策账本（ledger）</span>
        </label>
      ) : null}

      <div style={{ marginTop: "10px" }}>
        <input
          type="text"
          className="input"
          aria-label="补充说明（可选）"
          placeholder="补充拍板理由（选填）"
          value={rationale}
          onChange={(e) =>
            setRationale((e.currentTarget as HTMLInputElement).value)
          }
        />
      </div>

      <div className="decision-actions">
        <button
          type="button"
          className="btn btn-light"
          disabled={!selectedOption || submitting}
          onClick={() => void handleConfirm()}
        >
          {submitting ? "提交中..." : "确认执行"}
        </button>
        {onOpenResolve ? (
          <button type="button" className="btn" onClick={onOpenResolve}>
            开对话讨论
          </button>
        ) : null}
      </div>
    </section>
  );
}
