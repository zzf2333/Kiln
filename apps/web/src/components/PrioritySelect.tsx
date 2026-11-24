import { PRIORITIES, type Priority } from "@kiln/protocol/web";
import { KilnSelect } from "./KilnSelect";

export interface PrioritySelectProps {
  value: Priority;
  disabled?: boolean;
  onChange: (next: Priority) => void;
}

const PRIORITY_OPTIONS = PRIORITIES.map((p) => ({ value: p, label: p }));

export function PrioritySelect({ value, disabled, onChange }: PrioritySelectProps) {
  return (
    <KilnSelect
      ariaLabel="优先级"
      className={`pri-select pri-${value}`}
      value={value}
      disabled={disabled}
      stopPropagation
      align="start"
      options={PRIORITY_OPTIONS}
      onChange={(next) => onChange(next as Priority)}
    />
  );
}
