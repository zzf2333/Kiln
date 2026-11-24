import { Popover } from "radix-ui";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

export interface KilnSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface KilnSelectProps {
  value: string;
  options: readonly KilnSelectOption[];
  onChange: (nextValue: string) => void;
  ariaLabel: string;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  placeholder?: string;
  align?: "start" | "center" | "end";
  stopPropagation?: boolean;
}

function findNextEnabledIndex(
  options: readonly KilnSelectOption[],
  startIndex: number,
  step: 1 | -1,
): number {
  if (options.length === 0) return -1;
  let idx = startIndex;
  for (let i = 0; i < options.length; i += 1) {
    idx = (idx + step + options.length) % options.length;
    if (!options[idx]?.disabled) return idx;
  }
  return -1;
}

function findEdgeEnabledIndex(options: readonly KilnSelectOption[], fromEnd: boolean): number {
  if (fromEnd) {
    for (let i = options.length - 1; i >= 0; i -= 1) {
      if (!options[i]?.disabled) return i;
    }
    return -1;
  }
  for (let i = 0; i < options.length; i += 1) {
    if (!options[i]?.disabled) return i;
  }
  return -1;
}

/**
 * 通用 DOM 下拉选择器，避免 macOS Electron 原生 HTML select NSMenu 弹窗飘出窗口外。
 */
export function KilnSelect({
  value,
  options,
  onChange,
  ariaLabel,
  className = "select",
  style,
  disabled = false,
  placeholder,
  align = "start",
  stopPropagation = false,
}: KilnSelectProps) {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | undefined>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const displayLabel = selectedOption?.label ?? (value ? value : (placeholder ?? ""));

  const syncPortalContainer = () => {
    const dialogHost = triggerRef.current?.closest('[role="dialog"], [role="alertdialog"]');
    setPortalContainer(dialogHost instanceof HTMLElement ? dialogHost : undefined);
  };

  useEffect(() => {
    if (!open) return;
    const initial =
      selectedIndex >= 0 && !options[selectedIndex]?.disabled
        ? selectedIndex
        : findEdgeEnabledIndex(options, false);
    setHighlightedIndex(initial);
  }, [open, selectedIndex, options]);

  useEffect(() => {
    if (!open || highlightedIndex < 0) return;
    const activeEl = listRef.current?.querySelector(`[data-option-index="${highlightedIndex}"]`);
    if (activeEl && typeof (activeEl as HTMLElement).scrollIntoView === "function") {
      (activeEl as HTMLElement).scrollIntoView({ block: "nearest" });
    }
  }, [open, highlightedIndex]);

  const commitOption = (opt: KilnSelectOption | undefined) => {
    if (!opt || opt.disabled) return;
    if (opt.value !== value) {
      onChange(opt.value);
    }
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleTriggerClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (stopPropagation) e.stopPropagation();
    syncPortalContainer();
  };

  const handleTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (stopPropagation) e.stopPropagation();
      syncPortalContainer();
      setOpen(true);
    }
  };

  const handleListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (stopPropagation) e.stopPropagation();
    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const base = highlightedIndex >= 0 ? highlightedIndex : -1;
        setHighlightedIndex(findNextEnabledIndex(options, base, 1));
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        const base = highlightedIndex >= 0 ? highlightedIndex : 0;
        setHighlightedIndex(findNextEnabledIndex(options, base, -1));
        break;
      }
      case "Home": {
        e.preventDefault();
        setHighlightedIndex(findEdgeEnabledIndex(options, false));
        break;
      }
      case "End": {
        e.preventDefault();
        setHighlightedIndex(findEdgeEnabledIndex(options, true));
        break;
      }
      case "Enter":
      case " ": {
        e.preventDefault();
        if (highlightedIndex >= 0) {
          commitOption(options[highlightedIndex]);
        }
        break;
      }
      case "Escape": {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      }
    }
  };

  const isCompactPri = className.split(/\s+/).includes("pri-select");

  return (
    <Popover.Root
      open={open}
      modal={false}
      onOpenChange={(nextOpen) => {
        if (disabled && nextOpen) return;
        if (nextOpen) syncPortalContainer();
        setOpen(nextOpen);
      }}
    >
      <Popover.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? listboxId : undefined}
          aria-label={ariaLabel}
          data-value={value}
          className={`${className} kselect-trigger`}
          style={style}
          disabled={disabled}
          onClick={handleTriggerClick}
          onKeyDown={handleTriggerKeyDown}
        >
          <span className="kselect-label">{displayLabel}</span>
          <svg
            className="kselect-chev"
            width={isCompactPri ? 10 : 12}
            height={isCompactPri ? 10 : 12}
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M3 4.5L6 7.5L9 4.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </Popover.Trigger>
      <Popover.Portal container={portalContainer}>
        <Popover.Content
          className="kselect-pop"
          align={align}
          sideOffset={4}
          collisionPadding={8}
          onClick={(e) => {
            if (stopPropagation) e.stopPropagation();
          }}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            listRef.current?.focus();
          }}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            if (stopPropagation) e.stopPropagation();
            setOpen(false);
            triggerRef.current?.focus();
          }}
          onWheelCapture={(e) => e.stopPropagation()}
        >
          <div
            ref={listRef}
            id={listboxId}
            tabIndex={-1}
            className="kselect-list"
            role="listbox"
            aria-label={ariaLabel}
            onKeyDown={handleListKeyDown}
          >
            {options.map((opt, idx) => {
              const isSelected = opt.value === value;
              const isHighlighted = idx === highlightedIndex;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  data-option-index={idx}
                  data-value={opt.value}
                  aria-selected={isSelected}
                  disabled={opt.disabled}
                  className={`kselect-opt ${isSelected ? "is-sel" : ""} ${isHighlighted ? "is-hi" : ""}`}
                  onMouseEnter={() => {
                    if (!opt.disabled) setHighlightedIndex(idx);
                  }}
                  onClick={(e) => {
                    if (stopPropagation) e.stopPropagation();
                    commitOption(opt);
                  }}
                >
                  <span className="kselect-opt-label">{opt.label}</span>
                  {isSelected ? (
                    <svg
                      className="kselect-check"
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M2.5 6.2L5 8.6L9.5 3.6"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
