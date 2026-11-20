import { PRIORITIES, type Priority } from "@kiln/protocol/web";

export interface PrioritySelectProps {
  value: Priority;
  disabled?: boolean;
  onChange: (next: Priority) => void;
}

export function PrioritySelect({ value, disabled, onChange }: PrioritySelectProps) {
  return (
    <select
      aria-label="优先级"
      class={`pri-select pri-${value}`}
      value={value}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        e.stopPropagation();
        onChange((e.currentTarget as HTMLSelectElement).value as Priority);
      }}
    >
      {PRIORITIES.map((p) => (
        <option key={p} value={p}>
          {p}
        </option>
      ))}
    </select>
  );
}
