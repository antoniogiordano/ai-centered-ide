import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { PlanQuestion } from "@ai-ide/shared";

export type PlanQaAnswer = {
  questionId: string;
  answer: string;
  selectedOptionIds?: string[];
};

type DraftAnswer = {
  selectedIds: string[];
  freeText: string;
};

type Step = number | "recap";

function composerShortcutHint(): string {
  const isApple =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  return isApple ? "⌘I" : "Ctrl+I";
}

function letterForIndex(index: number): string {
  return String.fromCharCode(65 + index);
}

function optionKeyLabel(question: PlanQuestion, index: number): string {
  if (question.selection === "multiple") return String(index + 1);
  return letterForIndex(index);
}

function formatAnswerLabel(
  question: PlanQuestion,
  draft: DraftAnswer,
): string {
  const selectedLabels = draft.selectedIds
    .map((id) => question.options.find((o) => o.id === id)?.label)
    .filter((label): label is string => Boolean(label));
  const text = draft.freeText.trim();
  if (selectedLabels.length && text) {
    return `${selectedLabels.join(", ")} · ${text}`;
  }
  if (selectedLabels.length) return selectedLabels.join(", ");
  return text;
}

function canAdvance(question: PlanQuestion, draft: DraftAnswer): boolean {
  if (draft.freeText.trim()) return true;
  if (question.selection === "single") return draft.selectedIds.length === 1;
  return draft.selectedIds.length > 0;
}

function emptyDraft(): DraftAnswer {
  return { selectedIds: [], freeText: "" };
}

export function formatPlanAnswersMessage(
  questions: PlanQuestion[],
  answers: PlanQaAnswer[],
): string {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const lines = ["Q&A answers from the planning dialog:"];
  questions.forEach((q, index) => {
    const a = byId.get(q.id);
    if (!a) return;
    lines.push(`${index + 1}. ${q.text}`);
    lines.push(`   → ${a.answer}`);
  });
  lines.push("");
  lines.push("Please update the plan with these answers and continue.");
  return lines.join("\n");
}

export function PlanQaDialog(props: {
  open: boolean;
  questions: PlanQuestion[];
  onClose: () => void;
  onSubmit: (answers: PlanQaAnswer[]) => void | Promise<void>;
  focusRequestId?: number;
}) {
  const { open, questions, onClose, onSubmit, focusRequestId = 0 } = props;
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [step, setStep] = useState<Step>(0);
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openQuestions = useMemo(
    () => questions.filter((q) => q.status === "open"),
    [questions],
  );

  const questionIds = openQuestions.map((q) => q.id).join("|");

  const latest = useRef({
    step,
    drafts,
    openQuestions,
    submitting,
    onClose,
    onSubmit,
  });
  latest.current = {
    step,
    drafts,
    openQuestions,
    submitting,
    onClose,
    onSubmit,
  };

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setSubmitting(false);
    setError(null);
    const next: Record<string, DraftAnswer> = {};
    for (const q of openQuestions) next[q.id] = emptyDraft();
    setDrafts(next);
  }, [open, questionIds]);

  const focusText = useCallback(() => {
    const el = textRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }, []);

  useEffect(() => {
    if (!open || focusRequestId <= 0) return;
    requestAnimationFrame(() => focusText());
  }, [open, focusRequestId, focusText]);

  const current =
    typeof step === "number" ? openQuestions[step] : undefined;
  const draft = current ? drafts[current.id] ?? emptyDraft() : emptyDraft();
  const progressLabel =
    typeof step === "number"
      ? `Question ${step + 1} of ${openQuestions.length}`
      : "Review answers";

  function updateDraft(
    questionId: string,
    updater: (prev: DraftAnswer) => DraftAnswer,
  ) {
    setDrafts((prev) => ({
      ...prev,
      [questionId]: updater(prev[questionId] ?? emptyDraft()),
    }));
  }

  function goNextFrom(
    question: PlanQuestion,
    d: DraftAnswer,
    index: number,
  ): boolean {
    if (!canAdvance(question, d)) {
      setError(
        question.selection === "single"
          ? "Pick a letter (A–Z) or write a custom answer."
          : "Select at least one option (1–9) or write a custom answer.",
      );
      return false;
    }
    setError(null);
    if (index >= openQuestions.length - 1) {
      setStep("recap");
    } else {
      setStep(index + 1);
    }
    return true;
  }

  function goNext() {
    if (!current || typeof step !== "number") return;
    goNextFrom(current, draft, step);
  }

  function goBack() {
    setError(null);
    if (step === "recap") {
      setStep(Math.max(0, openQuestions.length - 1));
      return;
    }
    if (typeof step === "number" && step > 0) setStep(step - 1);
  }

  function selectSingle(optionId: string) {
    if (!current || current.selection !== "single" || typeof step !== "number") {
      return;
    }
    const index = step;
    const question = current;
    const nextDraft: DraftAnswer = {
      ...draft,
      selectedIds: [optionId],
    };
    updateDraft(question.id, () => nextDraft);
    setError(null);
    if (index >= openQuestions.length - 1) {
      setStep("recap");
    } else {
      setStep(index + 1);
    }
  }

  function toggleMultiple(optionId: string) {
    if (!current || current.selection !== "multiple") return;
    updateDraft(current.id, (prev) => {
      const has = prev.selectedIds.includes(optionId);
      return {
        ...prev,
        selectedIds: has
          ? prev.selectedIds.filter((id) => id !== optionId)
          : [...prev.selectedIds, optionId],
      };
    });
    setError(null);
  }

  async function confirmRecap() {
    const ctx = latest.current;
    if (ctx.submitting) return;
    const answers: PlanQaAnswer[] = [];
    for (const q of ctx.openQuestions) {
      const d = ctx.drafts[q.id] ?? emptyDraft();
      if (!canAdvance(q, d)) {
        setError("Some answers are incomplete. Go back and finish them.");
        setStep(ctx.openQuestions.findIndex((item) => item.id === q.id));
        return;
      }
      answers.push({
        questionId: q.id,
        answer: formatAnswerLabel(q, d),
        ...(d.selectedIds.length
          ? { selectedOptionIds: d.selectedIds }
          : {}),
      });
    }
    setSubmitting(true);
    setError(null);
    try {
      await ctx.onSubmit(answers);
    } catch (err) {
      setSubmitting(false);
      setError(err instanceof Error ? err.message : "Could not submit answers");
    }
  }

  useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      const ctx = latest.current;

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        ctx.onClose();
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        e.stopPropagation();
        focusText();
        return;
      }

      const target = e.target as HTMLElement | null;
      const typingInField =
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "INPUT" ||
        Boolean(target?.isContentEditable);

      if (ctx.step === "recap") {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          void confirmRecap();
        } else if (e.key === "Backspace" && !typingInField) {
          e.preventDefault();
          setError(null);
          setStep(Math.max(0, ctx.openQuestions.length - 1));
        }
        return;
      }

      if (typeof ctx.step !== "number") return;
      const question = ctx.openQuestions[ctx.step];
      if (!question) return;
      const d = ctx.drafts[question.id] ?? emptyDraft();

      if (e.key === "Backspace" && !typingInField && !d.freeText) {
        e.preventDefault();
        setError(null);
        if (ctx.step > 0) setStep(ctx.step - 1);
        return;
      }

      if (typingInField) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          goNextFrom(question, d, ctx.step);
        }
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        goNextFrom(question, d, ctx.step);
        return;
      }

      if (question.selection === "single") {
        const letter = e.key.toUpperCase();
        if (/^[A-Z]$/.test(letter)) {
          const index = letter.charCodeAt(0) - 65;
          const option = question.options[index];
          if (!option) return;
          e.preventDefault();
          e.stopPropagation();
          const nextDraft: DraftAnswer = { ...d, selectedIds: [option.id] };
          setDrafts((prev) => ({ ...prev, [question.id]: nextDraft }));
          setError(null);
          if (ctx.step >= ctx.openQuestions.length - 1) setStep("recap");
          else setStep(ctx.step + 1);
        }
        return;
      }

      if (/^[1-9]$/.test(e.key)) {
        const index = Number(e.key) - 1;
        const option = question.options[index];
        if (!option) return;
        e.preventDefault();
        e.stopPropagation();
        setDrafts((prev) => {
          const cur = prev[question.id] ?? emptyDraft();
          const has = cur.selectedIds.includes(option.id);
          return {
            ...prev,
            [question.id]: {
              ...cur,
              selectedIds: has
                ? cur.selectedIds.filter((id) => id !== option.id)
                : [...cur.selectedIds, option.id],
            },
          };
        });
        setError(null);
      }
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, focusText]);

  if (!open || openQuestions.length === 0) return null;

  return (
    <div
      className="palette-overlay qa-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="qa-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="qa-dialog-title"
      >
        <header className="qa-dialog-header">
          <div>
            <div className="qa-dialog-kicker">Planning Q&A</div>
            <h2 id="qa-dialog-title" className="qa-dialog-title">
              {progressLabel}
            </h2>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            title="Close (Esc)"
          >
            Esc
          </button>
        </header>

        {step === "recap" ? (
          <div className="qa-dialog-body">
            <p className="qa-dialog-lead">
              Review your answers, then press Enter to send them to the agent.
            </p>
            <ul className="qa-recap-list">
              {openQuestions.map((q, index) => {
                const d = drafts[q.id] ?? emptyDraft();
                return (
                  <li key={q.id} className="qa-recap-item">
                    <div className="qa-recap-q">
                      <span className="qa-recap-index">Q{index + 1}</span>
                      <span>{q.text}</span>
                    </div>
                    <div className="qa-recap-a">{formatAnswerLabel(q, d)}</div>
                  </li>
                );
              })}
            </ul>
            {error ? (
              <div className="qa-dialog-error" role="alert">
                {error}
              </div>
            ) : null}
            <div className="qa-dialog-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={goBack}
                disabled={submitting}
              >
                ← Back
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void confirmRecap()}
                disabled={submitting}
              >
                {submitting ? "Sending…" : "Confirm · Enter"}
              </button>
            </div>
            <div className="qa-dialog-hints">
              <span>
                <kbd>Enter</kbd> send to agent
              </span>
              <span>
                <kbd>Backspace</kbd> edit last
              </span>
              <span>
                <kbd>Esc</kbd> close
              </span>
            </div>
          </div>
        ) : current ? (
          <div className="qa-dialog-body">
            <div
              className={`qa-selection-badge qa-selection-${current.selection}`}
            >
              {current.selection === "single"
                ? "Single choice · A–Z"
                : "Multiple choice · 1–9, then Enter"}
            </div>
            <p className="qa-question-text">{current.text}</p>

            {current.options.length > 0 ? (
              <ul className="qa-options">
                {current.options.map((option, index) => {
                  const key = optionKeyLabel(current, index);
                  const selected = draft.selectedIds.includes(option.id);
                  return (
                    <li key={option.id}>
                      <button
                        type="button"
                        className={`qa-option ${selected ? "is-selected" : ""}`}
                        onClick={() => {
                          if (current.selection === "single") {
                            selectSingle(option.id);
                          } else {
                            toggleMultiple(option.id);
                          }
                        }}
                      >
                        <span className="qa-option-key">{key}</span>
                        <span className="qa-option-label">{option.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="qa-dialog-lead muted">
                No options provided — use a custom answer below.
              </p>
            )}

            <label className="qa-freetext-label" htmlFor="qa-freetext">
              Custom answer
              <span className="qa-freetext-hint">
                Focus with {composerShortcutHint()} · Enter to continue
              </span>
            </label>
            <textarea
              id="qa-freetext"
              ref={textRef}
              className="qa-freetext"
              rows={3}
              placeholder="Type an alternative answer…"
              value={draft.freeText}
              onChange={(e) =>
                updateDraft(current.id, (prev) => ({
                  ...prev,
                  freeText: e.target.value,
                }))
              }
              onKeyDown={(e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  goNext();
                }
              }}
            />

            {error ? (
              <div className="qa-dialog-error" role="alert">
                {error}
              </div>
            ) : null}

            <div className="qa-dialog-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={goBack}
                disabled={typeof step === "number" && step === 0}
              >
                ← Back
              </button>
              <button type="button" className="btn" onClick={goNext}>
                Next · Enter
              </button>
            </div>

            <div className="qa-dialog-hints">
              {current.selection === "single" ? (
                <span>
                  <kbd>A</kbd>–<kbd>Z</kbd> pick &amp; advance
                </span>
              ) : (
                <span>
                  <kbd>1</kbd>–<kbd>9</kbd> toggle · <kbd>Enter</kbd> next
                </span>
              )}
              <span>
                <kbd>{composerShortcutHint()}</kbd> free text
              </span>
              <span>
                <kbd>Esc</kbd> close
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
