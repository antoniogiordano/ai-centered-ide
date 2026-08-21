import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Collapsible chain of thought for one assistant turn.
 *
 * The reasoning stream is verbose and rarely the thing a reader came for, so a
 * finished turn keeps it folded away behind a one-line summary. The turn in
 * flight is the exception: watching the model reason is the only signal there
 * is while it works, so the live block opens itself and follows the tail, then
 * disappears when the turn ends and the folded version takes its place.
 *
 * `T` is bound by whichever block is the newest one on screen — the live block
 * when a turn is running, otherwise the most recent finished turn. Older blocks
 * in the scrollback are reachable by Tab and activated with Enter, and their
 * labels say so rather than advertising a key that would toggle a different
 * block.
 */
export function ThinkingBlock(props: {
  text: string;
  /** The turn is still running: open by default and follow the tail. */
  live?: boolean;
  /** This block owns the `T` shortcut. */
  primary?: boolean;
}) {
  const { text, live = false, primary = false } = props;
  const [expanded, setExpanded] = useState(live);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!primary) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "t" && e.key !== "T") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      setExpanded((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [primary]);

  useLayoutEffect(() => {
    if (!live || !expanded) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [live, expanded, text]);

  if (!text.trim()) return null;

  const shortcut = primary ? "T" : "Enter";

  return (
    <div className={`thinking-block ${live ? "thinking-block-live" : ""}`}>
      <button
        type="button"
        className="thinking-block-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="thinking-block-caret" aria-hidden>
          {expanded ? "▾" : "▸"}
        </span>
        {expanded ? "Hide thinking" : "Thinking"} · {shortcut}
      </button>
      {expanded ? (
        <div className="thinking-block-body" ref={bodyRef}>
          {text}
        </div>
      ) : null}
    </div>
  );
}
