import { useEffect, useState } from "react";

type Props = {
  src: string;
  name: string;
};

/** Inline transcript image with click-to-expand so screenshots stay readable. */
export function TranscriptImageAttachment(props: Props) {
  const { src, name } = props;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="transcript-image-button"
        onClick={() => setOpen(true)}
        title={name}
        aria-label={`View ${name} · Enter`}
      >
        <img className="transcript-thumb" src={src} alt={name} />
        <span className="transcript-image-hint">View · Enter</span>
      </button>

      {open ? (
        <div
          className="overlay palette-overlay transcript-image-overlay"
          role="presentation"
          onClick={() => setOpen(false)}
        >
          <div
            className="transcript-image-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={name}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="transcript-image-dialog-header">
              <span className="transcript-image-dialog-title">{name}</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setOpen(false)}
              >
                Close · Esc
              </button>
            </header>
            <img
              className="transcript-image-full"
              src={src}
              alt={name}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
