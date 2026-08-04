import { useEffect, useState } from "react";
import {
  dismissUiError,
  subscribeUiError,
  type UiErrorReport,
} from "../lib/uiErrors";

export function ErrorDialog() {
  const [error, setError] = useState<UiErrorReport | null>(null);

  useEffect(() => subscribeUiError(setError), []);

  useEffect(() => {
    if (!error) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dismissUiError();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [error]);

  if (!error) return null;

  return (
    <div
      className="overlay palette-overlay qa-overlay error-dialog-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismissUiError();
      }}
    >
      <div
        className="qa-dialog error-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="error-dialog-title"
        aria-describedby="error-dialog-message"
      >
        <div className="qa-dialog-header">
          <div>
            <div className="qa-dialog-kicker">Error</div>
            <h2 id="error-dialog-title" className="qa-dialog-title">
              {error.title}
            </h2>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => dismissUiError()}
          >
            Dismiss · Esc
          </button>
        </div>
        <div className="qa-dialog-body">
          <p id="error-dialog-message" className="qa-dialog-lead">
            {error.message}
          </p>
          {error.source ? (
            <p className="error-dialog-source">{error.source}</p>
          ) : null}
          {error.detail ? (
            <pre className="error-dialog-detail">{error.detail}</pre>
          ) : null}
          <div className="qa-dialog-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => dismissUiError()}
            >
              OK · Esc
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
