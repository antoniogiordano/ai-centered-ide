import { useCallback, useEffect, useState } from "react";
import type { SessionState } from "@ai-ide/shared";
import { getBridge } from "../bridge";
import { modShiftHint } from "./ArchitecturePane";

function isBusy(status: SessionState["status"] | undefined): boolean {
  return (
    status === "thinking" ||
    status === "streaming" ||
    status === "tool" ||
    status === "running" ||
    status === "awaiting_approval"
  );
}

/**
 * End of the local commit flow (commit + merge/PR settled): offer to archive
 * this chat and start a fresh one in Plan mode. Pinned at the foot of the chat.
 */
export function ArchiveChatBanner(props: { state: SessionState | null }) {
  const state = props.state;
  const show =
    Boolean(state?.buildFlowCompletedAt) &&
    !state?.buildCommitOffer &&
    !state?.buildIntegrateOffer &&
    !isBusy(state?.status);
  const sessionId = state?.sessionId ?? null;
  const [busy, setBusy] = useState(false);

  const archive = useCallback(async () => {
    if (busy || !sessionId) return;
    setBusy(true);
    try {
      const bridge = getBridge();
      // New chat first (becomes active, Plan mode), then drop the old one.
      await bridge?.session.create();
      await bridge?.session.close(sessionId);
    } finally {
      setBusy(false);
    }
  }, [busy, sessionId]);

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "e"
      ) {
        e.preventDefault();
        e.stopPropagation();
        void archive();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [show, archive]);

  if (!show || !state) return null;

  return (
    <div
      className="build-continue-banner archive-chat-banner"
      role="region"
      aria-label="Archive chat"
    >
      <div className="build-continue-copy">
        <strong>Delivery complete</strong>
        <span>
          Commit flow finished. Archive this chat and start a new one in Plan
          mode.
        </span>
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={() => void archive()}
      >
        Archive chat · {modShiftHint("E")}
      </button>
    </div>
  );
}
