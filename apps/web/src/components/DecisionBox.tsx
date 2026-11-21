import { useEffect, useState } from "preact/hooks";
import type { DecisionAction, PendingDecision } from "@kiln/protocol/web";
import type { SubmitDecisionPayload } from "../api/types";
import { fmtTime } from "../state/format";
import { WarnCircleIcon } from "./Icons";
import { MarkdownContent } from "./MarkdownContent";

const ACTION_DESC: Record<DecisionAction, string> = {
  resume: "继续推进",
  return_external: "回到外部等待",
  finish: "直接结束",
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
    <section class="decision">
      <div class="decision-head">
        <WarnCircleIcon />
        <span>需要你决定</span>
        <span class="muted">
          {decision.category} · {fmtTime(decision.created_at)} · {decision.reason}
        </span>
      </div>
      <div class="decision-q">
        <MarkdownContent text={decision.question} />
      </div>
      <div class="options">
        {decision.options.map((opt) => {
          const checked = opt.id === selectedOption?.id;
          return (
            <label key={opt.id} class="option">
              <input
                type="radio"
                name={`opt-${decision.id}`}
                value={opt.id}
                checked={checked}
                onChange={() => handleSelectOption(opt.id)}
              />
              <div>
                <div class="opt-label">
                  {opt.recommended ? <span class="rec">推荐</span> : null}
                  <span>{opt.label}</span>
                  <span class="opt-act" title={ACTION_DESC[opt.action]}>
                    {opt.action}
                  </span>
                </div>
                {opt.cost_note ? (
                  <div class="opt-effect">{opt.cost_note}</div>
                ) : null}
                {opt.ledger_rule ? (
                  <div class="opt-effect muted">
                    可选账本规则：{opt.ledger_rule}
                  </div>
                ) : null}
              </div>
            </label>
          );
        })}
      </div>

      {hasLedgerRule ? (
        <label class="ledger-check">
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
          class="input"
          aria-label="补充说明（可选）"
          placeholder="补充拍板理由（选填）"
          value={rationale}
          onInput={(e) =>
            setRationale((e.currentTarget as HTMLInputElement).value)
          }
        />
      </div>

      <div class="decision-actions">
        <button
          type="button"
          class="btn btn-light"
          disabled={!selectedOption || submitting}
          onClick={() => void handleConfirm()}
        >
          {submitting ? "提交中..." : "确认执行"}
        </button>
        {onOpenResolve ? (
          <button type="button" class="btn" onClick={onOpenResolve}>
            开对话讨论
          </button>
        ) : null}
      </div>
    </section>
  );
}
