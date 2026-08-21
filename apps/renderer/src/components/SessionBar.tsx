import { useEffect, useMemo, useRef, useState } from "react";
import {
  deriveProductPhase,
  formatTokenCount,
  formatUsd,
  type SessionState,
  type SessionSummary,
} from "@ai-ide/shared";
import { getBridge } from "../bridge";
import { DiscardSessionDialog } from "./DiscardSessionDialog";
import { SessionsDialog } from "./SessionsDialog";

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

function phaseLetter(phase: string | undefined): string {
  if (phase === "checking") return "C";
  if (phase === "building") return "B";
  if (phase === "testing") return "T";
  return "P";
}

function phaseTitle(phase: string | undefined): string {
  if (phase === "checking") return "Check";
  if (phase === "building") return "Build";
  if (phase === "testing") return "Test";
  return "Plan";
}

export function SessionBar(props: {
  state: SessionState | null;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onAddSession: () => void;
  workspaceReady?: boolean;
  previewOpen?: boolean;
  planOpen?: boolean;
  onTogglePreview?: () => void;
  onTogglePlan?: () => void;
  onOpenStats?: () => void;
}) {
  const {
    state,
    sessions,
    activeSessionId,
    onAddSession,
    workspaceReady,
    previewOpen,
    planOpen,
    onTogglePreview,
    onTogglePlan,
    onOpenStats,
  } = props;
  const bridge = getBridge();
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [discardId, setDiscardId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [copyDeepState, setCopyDeepState] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyDeepResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tabSessions = useMemo(() => {
    if (sessions.length > 0) return sessions;
    if (!activeSessionId) return [];
    return [
      {
        id: activeSessionId,
        title: "New chat",
        updatedAt: new Date().toISOString(),
        workspaceName: state?.workspace?.name ?? null,
        phase: state ? deriveProductPhase(state) : ("planning" as const),
      },
    ];
  }, [sessions, activeSessionId, state]);

  const active = tabSessions.find((s) => s.id === activeSessionId) ?? null;
  const phase = active?.phase ?? (state ? deriveProductPhase(state) : "planning");
  const title = active?.title ?? "New chat";
  const otherCount = Math.max(0, tabSessions.length - 1);
  const turns = state?.turns ?? [];
  const modelUsage = state?.sessionModelUsage ?? [];

  function dispatchCopy(mode: "visible" | "deep") {
    window.dispatchEvent(
      new CustomEvent(
        mode === "deep" ? "aici:copy-open-chat-deep" : "aici:copy-open-chat",
      ),
    );
  }

  function markCopyFeedback(mode: "visible" | "deep", ok: boolean) {
    const setState = mode === "deep" ? setCopyDeepState : setCopyState;
    const resetRef = mode === "deep" ? copyDeepResetRef : copyResetRef;
    setState(ok ? "copied" : "failed");
    if (resetRef.current) clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => setState("idle"), 1600);
  }

  useEffect(() => {
    function onCopied(e: Event) {
      const detail = (e as CustomEvent<{ mode: "visible" | "deep"; ok: boolean }>)
        .detail;
      if (!detail) return;
      markCopyFeedback(detail.mode, detail.ok);
    }
    window.addEventListener("aici:copy-open-chat-result", onCopied);
    return () =>
      window.removeEventListener("aici:copy-open-chat-result", onCopied);
  }, []);

  useEffect(() => {
    return () => {
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
      if (copyDeepResetRef.current) clearTimeout(copyDeepResetRef.current);
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (sessionsOpen || discardId) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        Boolean((e.target as HTMLElement | null)?.isContentEditable);
      if (typing) return;
      if (e.key.toLowerCase() === "n" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onAddSession();
        return;
      }
      if (e.key === "ArrowDown" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setSessionsOpen(true);
        return;
      }
      if (e.key === "Backspace" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (activeSessionId) setDiscardId(activeSessionId);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [bridge, sessionsOpen, discardId, activeSessionId, onAddSession]);

  const copyLabel =
    copyState === "copied"
      ? "Copied"
      : copyState === "failed"
        ? "Copy failed"
        : `Copy · ${modShiftHint("C")}`;
  const copyDeepLabel =
    copyDeepState === "copied"
      ? "Copied deep"
      : copyDeepState === "failed"
        ? "Deep failed"
        : `Deep · ${modShiftHint("D")}`;

  return (
    <>
      <div
        className="session-bar"
        role="status"
        aria-label="Current chat session"
      >
        <div className="session-bar-label">Session</div>
        <div className="session-bar-main">
          <span
            className={`session-tab-phase session-tab-phase-${phase}`}
            title={phaseTitle(phase)}
            aria-label={phaseTitle(phase)}
          >
            {phaseLetter(phase)}
          </span>
          <div className="session-bar-title-wrap">
            <div className="session-bar-title">{title}</div>
            {modelUsage.length > 0 ? (
              <div className="session-bar-models" title="Models used in this chat">
                {modelUsage.map((row) => (
                  <span key={`${row.providerId ?? "x"}:${row.model}`} className="session-bar-model">
                    <span className="session-bar-model-name">{row.model}</span>
                    <span className="session-bar-model-meta">
                      in {formatTokenCount(row.usage.inputTokens)} · out{" "}
                      {formatTokenCount(row.usage.outputTokens)}
                      {row.paid && row.costUsd != null
                        ? ` · ${formatUsd(row.costUsd)}`
                        : row.paid
                          ? " · $"
                          : ""}
                    </span>
                  </span>
                ))}
              </div>
            ) : (
              <div className="session-bar-models muted">No model usage yet</div>
            )}
          </div>
        </div>
        <div className="session-bar-actions">
          {workspaceReady && onTogglePreview ? (
            <button
              type="button"
              className={`btn btn-secondary btn-sm session-bar-action ${
                previewOpen ? "workspace-bar-action-active" : ""
              }`}
              title={`Live preview of the running app (${modShiftHint("P")})`}
              aria-pressed={previewOpen}
              onClick={onTogglePreview}
            >
              Preview · {modShiftHint("P")}
            </button>
          ) : null}
          {workspaceReady && onTogglePlan ? (
            <button
              type="button"
              className={`btn btn-secondary btn-sm session-bar-action ${
                planOpen ? "workspace-bar-action-active" : ""
              }`}
              title={`Plan and checklist (${modShiftHint("L")})`}
              aria-pressed={planOpen}
              onClick={onTogglePlan}
            >
              Plan · {modShiftHint("L")}
            </button>
          ) : null}
          <div className="btn-group" role="group" aria-label="Copy chat">
            <button
              type="button"
              className="btn btn-outlined-accent btn-sm session-bar-action"
              title={`Copy visible chat (${modShiftHint("C")})`}
              disabled={turns.length === 0}
              onClick={() => dispatchCopy("visible")}
            >
              {copyLabel}
            </button>
            <button
              type="button"
              className="btn btn-outlined-accent btn-sm session-bar-action"
              title={`Copy deep — full tool args and output (${modShiftHint("D")})`}
              disabled={turns.length === 0}
              onClick={() => dispatchCopy("deep")}
            >
              {copyDeepLabel}
            </button>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm session-bar-action"
            title={`Discard session (${modHint("⌫")})`}
            onClick={() => {
              if (activeSessionId) setDiscardId(activeSessionId);
            }}
          >
            Discard · {modHint("⌫")}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm session-bar-action"
            title="Add session · N"
            onClick={onAddSession}
          >
            Add · N
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm session-bar-action session-bar-arrow"
            title="Other sessions · ↓"
            aria-label={`Open sessions dialog (${otherCount} other)`}
            aria-expanded={sessionsOpen}
            onClick={() => setSessionsOpen(true)}
          >
            ↓{otherCount > 0 ? ` ${otherCount}` : ""}
          </button>
        </div>
      </div>

      <SessionsDialog
        open={sessionsOpen}
        sessions={tabSessions}
        activeSessionId={activeSessionId}
        onClose={() => setSessionsOpen(false)}
        onDiscard={(id) => {
          setSessionsOpen(false);
          setDiscardId(id);
        }}
        {...(onOpenStats
          ? {
              onOpenStats: () => {
                setSessionsOpen(false);
                onOpenStats();
              },
            }
          : {})}
      />
      <DiscardSessionDialog
        open={Boolean(discardId)}
        sessionId={discardId}
        title={
          tabSessions.find((s) => s.id === discardId)?.title ?? title
        }
        featBranch={
          discardId === activeSessionId ? (state?.featBranch ?? null) : null
        }
        onClose={() => setDiscardId(null)}
        onDiscarded={() => setDiscardId(null)}
      />
    </>
  );
}
