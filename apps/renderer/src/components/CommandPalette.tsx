import { useEffect, useRef, useState } from "react";
import { getBridge } from "../bridge";
import type { VerifyTab } from "./Cockpit";

const VERIFY_TABS: { id: VerifyTab; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "browser", label: "Browser" },
  { id: "diff", label: "Diff" },
  { id: "files", label: "Files" },
  { id: "environment", label: "Environment" },
  { id: "tests", label: "Tests" },
  { id: "terminal", label: "Terminal" },
];

function modHint(key: string): string {
  const isApple =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  return isApple ? `⌘${key}` : `Ctrl+${key}`;
}

function modShiftHint(key: string): string {
  const isApple =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  return isApple ? `⌘⇧${key}` : `Ctrl+Shift+${key}`;
}

export function CommandPalette(props: {
  open: boolean;
  onClose: () => void;
  currentVerifyTab: VerifyTab;
  onOpenWorkspace: () => void;
  onNewProject?: () => void;
  onFocusComposer: () => void;
  onSetVerifyTab: (tab: VerifyTab) => void;
  onOpenProviderSettings?: () => void;
  onOpenArchitecture?: () => void;
  planning?: boolean;
}) {
  const {
    open,
    onClose,
    currentVerifyTab,
    onOpenWorkspace,
    onNewProject,
    onFocusComposer,
    onSetVerifyTab,
    onOpenProviderSettings,
    onOpenArchitecture,
    planning = false,
  } = props;

  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) {
      setQuery("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const q = query.trim().toLowerCase();

  type Action = { id: string; label: string; hint?: string | undefined; run: () => void };
  const actions: Action[] = [
    {
      id: "workspace",
      label: "Open workspace",
      hint: modHint("O"),
      run: () => {
        onOpenWorkspace();
        onClose();
      },
    },
    ...(onNewProject
      ? [
          {
            id: "new-project",
            label: "New project",
            hint: modShiftHint("N"),
            run: () => {
              onNewProject();
              onClose();
            },
          },
        ]
      : []),
    {
      id: "new-chat",
      label: "New chat",
      hint: modHint("N"),
      run: () => {
        void getBridge()?.session.create();
        onClose();
      },
    },
    {
      id: "copy-chat",
      label: "Copy open chat",
      hint: modShiftHint("C"),
      run: () => {
        window.dispatchEvent(new CustomEvent("aifi:copy-open-chat"));
        onClose();
      },
    },
    {
      id: "composer",
      label: "Focus composer",
      hint: modHint("I"),
      run: () => {
        onFocusComposer();
        onClose();
      },
    },
    ...(onOpenProviderSettings
      ? [
          {
            id: "provider",
            label: "Provider settings",
            hint: modHint("P"),
            run: () => {
              onOpenProviderSettings();
              onClose();
            },
          },
        ]
      : []),
    ...(onOpenArchitecture
      ? [
          {
            id: "architecture",
            label: "Architecture settings",
            hint: modShiftHint("A"),
            run: () => {
              onOpenArchitecture();
              onClose();
            },
          },
        ]
      : []),
    ...(planning
      ? []
      : VERIFY_TABS.map((tab) => ({
          id: `tab-${tab.id}`,
          label: `Open ${tab.label}`,
          ...(tab.id === currentVerifyTab
            ? { hint: "Current tab" as const }
            : {}),
          run: () => {
            onSetVerifyTab(tab.id);
            onClose();
          },
        }))),
  ];

  const filtered = q
    ? actions.filter(
        (a) =>
          a.label.toLowerCase().includes(q) ||
          (a.hint?.toLowerCase().includes(q) ?? false),
      )
    : actions;

  return (
    <div className="palette-overlay" role="presentation" onClick={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input input"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search commands"
        />
        <ul className="palette-list" role="listbox">
          {filtered.length === 0 ? (
            <li className="palette-empty">No matching commands</li>
          ) : (
            filtered.map((action) => (
              <li key={action.id}>
                <button
                  type="button"
                  className="palette-item"
                  onClick={action.run}
                  role="option"
                >
                  <span>{action.label}</span>
                  {action.hint ? (
                    <span className="palette-item-hint">{action.hint}</span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
