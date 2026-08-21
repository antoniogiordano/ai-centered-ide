import { useEffect, useRef } from "react";

export type HeaderSelectOption = {
  id: string;
  label: string;
  hint?: string;
};

/**
 * Compact chrome select: the trigger shows the current value and its shortcut.
 * Open with the trigger (or the wired chord); digits 1–9 pick; Esc closes.
 */
export function HeaderSelect(props: {
  value: string;
  hint: string;
  open: boolean;
  options: HeaderSelectOption[];
  disabled?: boolean;
  title?: string;
  empty?: string;
  onToggle: () => void;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const {
    value,
    hint,
    open,
    options,
    disabled,
    title,
    empty,
    onToggle,
    onClose,
    onPick,
  } = props;
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      const digit = e.code.startsWith("Digit")
        ? Number(e.code.slice(5))
        : Number.NaN;
      if (
        digit >= 1 &&
        digit <= 9 &&
        options[digit - 1] &&
        !e.metaKey &&
        !e.altKey &&
        !e.ctrlKey
      ) {
        e.preventDefault();
        onPick(options[digit - 1]!.id);
      }
    };
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onPointer, true);
    };
  }, [open, options, onClose, onPick]);

  return (
    <div className="header-select" ref={rootRef}>
      <button
        type="button"
        className={`btn btn-secondary btn-sm header-select-trigger ${
          open ? "workspace-bar-action-active" : ""
        }`}
        disabled={disabled}
        title={title}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={onToggle}
      >
        <span className="header-select-value">{value}</span>
        <span className="header-select-hint">· {hint}</span>
      </button>
      {open ? (
        <ul className="header-select-menu" role="listbox">
          {options.length === 0 ? (
            <li className="header-select-empty">{empty ?? "Nothing listed"}</li>
          ) : (
            options.map((option, index) => (
              <li key={option.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={option.id === value || option.label === value}
                  className={`btn btn-sm header-select-option ${
                    option.id === value || option.label === value
                      ? "btn-primary"
                      : "btn-secondary"
                  }`}
                  title={
                    index < 9 ? `${option.label} (${index + 1})` : option.label
                  }
                  onClick={() => onPick(option.id)}
                >
                  <span className="header-select-option-label">
                    {option.label}
                    {option.hint ? (
                      <span className="header-select-option-meta">
                        {option.hint}
                      </span>
                    ) : null}
                  </span>
                  {index < 9 ? ` · ${index + 1}` : ""}
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
