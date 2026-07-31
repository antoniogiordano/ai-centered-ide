import { useId, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const USER_COLLAPSE_CHARS = 160;

export function CollapsibleUserText(props: { content: string }) {
  const { content } = props;
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const needsCollapse = content.trim().length > USER_COLLAPSE_CHARS;

  if (!needsCollapse) {
    return <div className="transcript-text transcript-user-text">{content}</div>;
  }

  return (
    <button
      type="button"
      className={`transcript-user-bubble ${expanded ? "is-expanded" : "is-collapsed"}`}
      aria-expanded={expanded}
      aria-controls={panelId}
      onClick={() => setExpanded((v) => !v)}
    >
      <div id={panelId} className="transcript-text transcript-user-text">
        {content}
      </div>
      <span className="transcript-user-expand-hint">
        {expanded ? "Show less" : "Show more"}
      </span>
    </button>
  );
}

export function MarkdownMessage(props: { content: string; streaming?: boolean }) {
  return (
    <div
      className={`transcript-markdown ${props.streaming ? "streaming" : ""}`}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{props.content}</ReactMarkdown>
      {props.streaming ? <span className="stream-caret" aria-hidden /> : null}
    </div>
  );
}

export function TranscriptLabel(props: { children: ReactNode; tone: "user" | "agent" }) {
  return (
    <div className={`transcript-label transcript-label-${props.tone}`}>
      {props.children}
    </div>
  );
}
