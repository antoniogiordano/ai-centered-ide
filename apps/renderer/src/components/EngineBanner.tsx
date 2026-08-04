import { useEffect, useMemo, useState } from "react";
import type { EngineStatus } from "@ai-ide/shared";
import { getBridge } from "../bridge";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function EngineBanner(props: { hasWorkspace: boolean }) {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge?.engine) return;
    void bridge.engine.status().then(setStatus);
    return bridge.engine.subscribe(setStatus);
  }, []);

  useEffect(() => {
    if (!status || dismissed || status.phase === "indexed") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (status.phase === "indexing") {
          e.preventDefault();
          void getBridge()?.engine?.indexCancel();
          return;
        }
        setDismissed(true);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        ) {
          return;
        }
        if (
          status.phase === "missing" ||
          status.phase === "error" ||
          (status.phase === "ready" && !status.binaryReady)
        ) {
          e.preventDefault();
          setBusy(true);
          void getBridge()
            ?.engine?.ensure()
            .finally(() => setBusy(false));
          return;
        }
        if (
          props.hasWorkspace &&
          status.binaryReady &&
          status.phase === "ready" &&
          !status.indexed
        ) {
          e.preventDefault();
          setBusy(true);
          void getBridge()
            ?.engine?.index("fast")
            .finally(() => setBusy(false));
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [status, dismissed, props.hasWorkspace]);

  const progress = useMemo(() => {
    if (!status || status.phase !== "downloading") return null;
    if (!status.downloadTotal || status.downloadTotal <= 0) {
      return formatBytes(status.downloadReceived);
    }
    const pct = Math.min(
      100,
      Math.round((status.downloadReceived / status.downloadTotal) * 100),
    );
    return `${pct}% · ${formatBytes(status.downloadReceived)} / ${formatBytes(status.downloadTotal)}`;
  }, [status]);

  if (!status || dismissed) return null;
  if (status.phase === "unsupported") {
    return (
      <div className="engine-banner engine-banner-muted" role="status">
        <div>
          <strong>Codebase engine unavailable</strong>
          <p>{status.error ?? "This platform is not supported."}</p>
        </div>
        <button type="button" className="ghost-btn" onClick={() => setDismissed(true)}>
          Dismiss · Esc
        </button>
      </div>
    );
  }

  if (status.phase === "indexed") return null;

  const showDownload =
    status.phase === "missing" ||
    status.phase === "downloading" ||
    status.phase === "error";
  const showIndex =
    props.hasWorkspace &&
    status.binaryReady &&
    (status.phase === "ready" ||
      status.phase === "starting" ||
      status.phase === "indexing" ||
      (status.phase === "error" && !status.indexed));

  if (!showDownload && !showIndex) return null;

  return (
    <div className="engine-banner" role="status">
      <div className="engine-banner-body">
        {showDownload ? (
          <>
            <strong>Codebase memory engine ({status.version})</strong>
            <p>
              {status.phase === "downloading"
                ? `Downloading… ${progress ?? ""}`
                : status.error
                  ? status.error
                  : "Download the local indexing engine (~36 MB) to enable graph-based code reading."}
            </p>
            {status.phase === "downloading" && status.downloadTotal ? (
              <div className="engine-banner-progress" aria-hidden>
                <div
                  className="engine-banner-progress-fill"
                  style={{
                    width: `${Math.min(
                      100,
                      (status.downloadReceived / status.downloadTotal) * 100,
                    )}%`,
                  }}
                />
              </div>
            ) : null}
          </>
        ) : (
          <>
            <strong>Index this project</strong>
            <p>
              {status.phase === "indexing"
                ? status.indexMessage ?? "Indexing…"
                : "Build a local code graph so the agent can search symbols, call paths, and snippets."}
            </p>
          </>
        )}
      </div>
      <div className="engine-banner-actions">
        {showDownload ? (
          <button
            type="button"
            className="primary-btn"
            disabled={busy || status.phase === "downloading"}
            onClick={() => {
              setBusy(true);
              void getBridge()
                ?.engine?.ensure()
                .finally(() => setBusy(false));
            }}
          >
            {status.phase === "error" ? "Retry · Enter" : "Download · Enter"}
          </button>
        ) : null}
        {showIndex ? (
          <>
            {status.phase === "indexing" ? (
              <button
                type="button"
                className="ghost-btn"
                onClick={() => void getBridge()?.engine?.indexCancel()}
              >
                Cancel · Esc
              </button>
            ) : (
              <button
                type="button"
                className="primary-btn"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void getBridge()
                    ?.engine?.index("fast")
                    .finally(() => setBusy(false));
                }}
              >
                Index project · Enter
              </button>
            )}
          </>
        ) : null}
        <button
          type="button"
          className="ghost-btn"
          onClick={() => setDismissed(true)}
        >
          Later
        </button>
      </div>
    </div>
  );
}
