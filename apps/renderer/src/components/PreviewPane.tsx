import { useCallback, useEffect, useRef, useState } from "react";
import {
  PREVIEW_VIEWPORTS,
  buildPreviewSetupRequest,
  createEmptyPreviewStatus,
  fitPreviewViewport,
  formatElementReference,
  type PreviewRect,
  type PreviewStatus,
  type PreviewViewportId,
} from "@ai-ide/shared";

type ElectronWebview = HTMLElement & {
  src: string;
};
import { getBridge } from "../bridge";
import { useNativeOverlayBlocked } from "../hooks/useNativeOverlay";
import { sendToComposer } from "../lib/composerInbox";
import { PreviewCropOverlay } from "./PreviewCropOverlay";
import { PreviewSetupBanner } from "./PreviewSetupBanner";
import { modShiftHint } from "./ArchitecturePane";

function stamp(): string {
  return new Date().toISOString().slice(11, 19).replace(/:/g, "");
}

function modHint(key: string): string {
  const isApple =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  return isApple ? `⌘${key}` : `Ctrl+${key}`;
}

/** getBoundingClientRect drifts by sub-pixels; don't burn IPC on that. */
function sameRect(a: PreviewRect | null, b: PreviewRect | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

const PHASE_LABEL: Record<PreviewStatus["phase"], string> = {
  off: "Off",
  needs_command: "Setup",
  needs_confirm: "Waiting for your OK",
  starting: "Starting dev server",
  waiting: "Waiting for the server",
  ready: "Live",
  error: "Problem",
};

/** How often the pane re-reads ARCHITECTURE.md while waiting for the agent. */
const SETUP_POLL_MS = 2_000;

type Capture = {
  dataBase64: string;
  mime: string;
  rect: PreviewRect;
};

/**
 * Live preview surface. The page is an Electron `<webview>` inside the hole —
 * a guest with its own partition and no IDE preload. Main still owns the
 * allowlist, DevTools, capture and the element picker.
 *
 * Mounting starts the dev services and unmounting stops them, so the preview
 * switch in the workspace bar is the single control for the whole feature.
 */
export function PreviewPane(props: {
  onClose: () => void;
  onFocusComposer: () => void;
  busy: boolean;
}) {
  const { onClose, onFocusComposer, busy } = props;
  const bridge = getBridge();
  const preview = bridge?.preview ?? null;
  const [status, setStatus] = useState<PreviewStatus>(() =>
    createEmptyPreviewStatus(),
  );
  const [address, setAddress] = useState("");
  const [addressDirty, setAddressDirty] = useState(false);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [snipError, setSnipError] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const holeRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<ElectronWebview | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const lastRect = useRef<PreviewRect | null>(null);
  const [holeSize, setHoleSize] = useState({ width: 0, height: 0 });
  const [guestTick, setGuestTick] = useState(0);
  const overlayBlocked = useNativeOverlayBlocked();

  useEffect(() => {
    if (!preview) return;
    const unsubscribe = preview.subscribe(setStatus);
    void preview.status().then((result) => setStatus(result.status));
    void preview.start().then((result) => setStatus(result.status));
    return unsubscribe;
  }, [preview]);

  useEffect(() => {
    if (addressDirty) return;
    setAddress(status.url ?? "");
  }, [status.url, addressDirty]);

  const inSetup =
    status.phase === "needs_command" || status.phase === "needs_confirm";

  /** The agent writes ARCHITECTURE.md with its own tool; this is how we notice. */
  useEffect(() => {
    if (!preview?.refreshSetup || !inSetup) return;
    const timer = window.setInterval(() => {
      void preview.refreshSetup?.().then((result) => setStatus(result.status));
    }, SETUP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [preview, inSetup]);

  const askAgentForSetup = useCallback(() => {
    if (busy) return;
    void bridge?.session.sendMessage(buildPreviewSetupRequest(status.setup));
    onFocusComposer();
  }, [bridge, busy, onFocusComposer, status.setup]);

  const confirmSetup = useCallback(() => {
    void preview?.confirmSetup?.().then((result) => setStatus(result.status));
  }, [preview]);

  /**
   * Crop / viewport math still uses the hole rect. The guest is a DOM node, so
   * we no longer have to chase the window with a native view.
   */
  useEffect(() => {
    if (!preview) return;
    const push = () => {
      // Measure the stage, never the hole: the guest lives in the hole and
      // Electron reports a ~50px intrinsic height that would collapse it.
      const node = stageRef.current;
      if (!node) return;
      const box = node.getBoundingClientRect();
      const rect: PreviewRect = {
        x: Math.round(box.left),
        y: Math.round(box.top),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
      setHoleSize((prev) =>
        prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height },
      );
      if (sameRect(rect, lastRect.current)) return;
      lastRect.current = rect;
      preview.setBounds(rect);
    };
    push();
    const observer = new ResizeObserver(push);
    if (stageRef.current) observer.observe(stageRef.current);
    window.addEventListener("resize", push);
    const timer = window.setInterval(push, 250);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", push);
      window.clearInterval(timer);
      lastRect.current = null;
      preview.setBounds(null);
    };
  }, [preview]);

  useEffect(() => {
    preview?.setVisible(!overlayBlocked);
    const wv = webviewRef.current;
    if (wv) wv.style.visibility = overlayBlocked ? "hidden" : "visible";
  }, [preview, overlayBlocked]);

  /**
   * Create the guest once the partition is named. `src` is set only here —
   * React must not own it, or a re-render would reset the page to about:blank.
   */
  useEffect(() => {
    const hole = holeRef.current;
    const stage = stageRef.current;
    if (!hole || !stage || !status.partition || !status.enabled || inSetup)
      return;
    const box = stage.getBoundingClientRect();
    if (box.width < 8 || box.height < 8) return;
    const wv = document.createElement("webview") as ElectronWebview;
    wv.setAttribute("partition", status.partition);
    wv.setAttribute(
      "webpreferences",
      "contextIsolation=yes, nodeIntegration=no",
    );
    wv.className = "preview-guest";
    wv.style.width = `${Math.round(box.width)}px`;
    wv.style.height = `${Math.round(box.height)}px`;
    hole.appendChild(wv);
    wv.src = "about:blank";
    webviewRef.current = wv;
    wv.style.visibility = overlayBlocked ? "hidden" : "visible";
    setGuestTick((n) => n + 1);
    return () => {
      wv.remove();
      if (webviewRef.current === wv) webviewRef.current = null;
    };
    // overlayBlocked is applied in the effect above; remounting on every
    // dialog would drop the page. holeReady only flips once the hole exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    status.partition,
    status.enabled,
    inSetup,
    holeSize.width >= 8 && holeSize.height >= 8,
  ]);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv || holeSize.width < 8 || holeSize.height < 8) return;
    const fitted = fitPreviewViewport(
      { x: 0, y: 0, width: holeSize.width, height: holeSize.height },
      status.viewport,
    );
    wv.style.left = `${fitted.x}px`;
    wv.style.top = `${fitted.y}px`;
    wv.style.width = `${fitted.width}px`;
    wv.style.height = `${fitted.height}px`;
    wv.style.right = "auto";
    wv.style.bottom = "auto";
  }, [guestTick, holeSize, status.viewport]);

  const snip = useCallback(async () => {
    if (!preview) return;
    setSnipError(null);
    const result = await preview.capture();
    if (!result.ok || !result.image) {
      setSnipError(result.error ?? "Nothing to capture yet.");
      return;
    }
    const rect = result.image.viewRect ?? lastRect.current;
    if (!rect) {
      setSnipError("The preview is not on screen.");
      return;
    }
    setCapture({
      dataBase64: result.image.dataBase64,
      mime: result.image.mime,
      rect,
    });
  }, [preview]);

  const shoot = useCallback(async () => {
    if (!preview) return;
    setSnipError(null);
    const result = await preview.capture();
    if (!result.ok || !result.image) {
      setSnipError(result.error ?? "Nothing to capture yet.");
      return;
    }
    sendToComposer({
      id: `preview-${Date.now()}`,
      image: {
        name: `preview-${stamp()}.png`,
        mime: result.image.mime,
        dataBase64: result.image.dataBase64,
      },
    });
  }, [preview]);

  const onCropped = useCallback((dataUrl: string) => {
    setCapture(null);
    const comma = dataUrl.indexOf(",");
    const dataBase64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    sendToComposer({
      id: `crop-${Date.now()}`,
      image: {
        name: `crop-${stamp()}.png`,
        mime: "image/png",
        dataBase64,
        previewDataUrl: dataUrl,
      },
      annotate: true,
    });
  }, []);

  /**
   * A picked element arrives as a reference line the agent can grep plus a tight
   * shot of the element, and the focus lands in the composer so the human only
   * has to say what should change.
   */
  useEffect(() => {
    if (!preview?.onElement) return;
    return preview.onElement((hit) => {
      sendToComposer({
        id: `element-${Date.now()}`,
        text: formatElementReference(hit),
        ...(hit.image
          ? {
              image: {
                name: `element-${hit.tagName}-${stamp()}.png`,
                mime: hit.image.mime,
                dataBase64: hit.image.dataBase64,
              },
            }
          : {}),
      });
    });
  }, [preview]);

  const go = useCallback(() => {
    if (!preview) return;
    const target = address.trim();
    if (!target) return;
    setAddressDirty(false);
    void preview.navigate(target);
  }, [address, preview]);

  const setViewport = useCallback(
    (viewport: PreviewViewportId) => {
      preview?.setViewport(viewport);
    },
    [preview],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) {
        if (e.key === "Escape" && status.picking) {
          e.preventDefault();
          void preview?.cancelPick();
          return;
        }
        if (e.altKey || isTypingTarget(e.target)) return;
        // Enter drives the setup banner, but never while the composer has focus:
        // there Enter means "send", and stealing it would be maddening.
        if (e.key === "Enter" && inSetup) {
          e.preventDefault();
          if (status.phase === "needs_confirm") confirmSetup();
          else askAgentForSetup();
          return;
        }
        const preset = PREVIEW_VIEWPORTS.find((v) => v.shortcut === e.key);
        if (!preset) return;
        e.preventDefault();
        setViewport(preset.id);
        return;
      }
      const key = e.key.toLowerCase();
      if (e.shiftKey) {
        if (key === "e") {
          e.preventDefault();
          void preview?.pickElement();
        } else if (key === "s") {
          e.preventDefault();
          void snip();
        } else if (key === "f") {
          e.preventDefault();
          void shoot();
        } else if (key === "r") {
          e.preventDefault();
          void preview?.act("reload");
        } else if (key === "i") {
          e.preventDefault();
          void preview?.toggleDevTools();
        } else if (key === "backspace" || e.key === "Backspace") {
          e.preventDefault();
          void preview?.clearData();
        }
        return;
      }
      if (key === "e" && inSetup) {
        e.preventDefault();
        onFocusComposer();
      } else if (key === "l") {
        e.preventDefault();
        addressRef.current?.select();
      } else if (e.key === "[") {
        e.preventDefault();
        void preview?.act("back");
      } else if (e.key === "]") {
        e.preventDefault();
        void preview?.act("forward");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    askAgentForSetup,
    confirmSetup,
    inSetup,
    onFocusComposer,
    preview,
    setViewport,
    shoot,
    snip,
    status.phase,
    status.picking,
  ]);

  const support = status.services.filter((s) => s.role === "support");
  const web = status.services.find((s) => s.role === "web") ?? null;
  /** Nothing is loaded, so anything that acts on the page would be a no-op. */
  const pageless = status.phase !== "ready";

  return (
    <section className="pane preview-pane" aria-label="Live preview">
      <div className="preview-toolbar">
        <div className="preview-toolbar-row">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!status.canGoBack}
            title={`Back (${modHint("[")})`}
            onClick={() => void preview?.act("back")}
          >
            ← Back · {modHint("[")}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!status.canGoForward}
            title={`Forward (${modHint("]")})`}
            onClick={() => void preview?.act("forward")}
          >
            → Fwd · {modHint("]")}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={pageless}
            title={`Reload (${modShiftHint("R")})`}
            onClick={() =>
              void preview?.act(status.loading ? "stop" : "reload")
            }
          >
            {status.loading ? "Stop" : "Reload"} · {modShiftHint("R")}
          </button>
          <form
            className="preview-address"
            onSubmit={(e) => {
              e.preventDefault();
              go();
            }}
          >
            <input
              ref={addressRef}
              className="input preview-address-input"
              value={address}
              spellCheck={false}
              disabled={inSetup}
              placeholder="http://localhost:3000"
              aria-label="Preview address"
              onChange={(e) => {
                setAddress(e.target.value);
                setAddressDirty(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setAddressDirty(false);
                  setAddress(status.url ?? "");
                  e.currentTarget.blur();
                }
              }}
            />
            <button
              type="submit"
              className="btn btn-secondary btn-sm"
              disabled={inSetup}
            >
              Go · Enter
            </button>
          </form>
        </div>
        <div className="preview-toolbar-row">
          <div className="preview-viewports" role="group" aria-label="Viewport">
            {PREVIEW_VIEWPORTS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`btn btn-sm ${
                  status.viewport === preset.id
                    ? "btn-primary"
                    : "btn-secondary"
                }`}
                aria-pressed={status.viewport === preset.id}
                title={`${preset.label} viewport (${preset.shortcut})`}
                onClick={() => setViewport(preset.id)}
              >
                {preset.label} · {preset.shortcut}
              </button>
            ))}
          </div>
          <div className="preview-toolbar-spacer" />
          <button
            type="button"
            className={`btn btn-sm ${status.picking ? "btn-primary" : "btn-secondary"}`}
            aria-pressed={status.picking}
            disabled={pageless}
            title={`Pick a DOM element and attach it to the chat (${modShiftHint("E")})`}
            onClick={() =>
              void (status.picking
                ? preview?.cancelPick()
                : preview?.pickElement())
            }
          >
            {status.picking ? "Picking · Esc" : `Pick · ${modShiftHint("E")}`}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={pageless}
            title={`Select an area and attach it to the chat (${modShiftHint("S")})`}
            onClick={() => void snip()}
          >
            Snip · {modShiftHint("S")}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={pageless}
            title={`Attach the whole view to the chat (${modShiftHint("F")})`}
            onClick={() => void shoot()}
          >
            Shot · {modShiftHint("F")}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-pressed={status.devtoolsOpen}
            disabled={pageless}
            title={`Chrome DevTools (${modShiftHint("I")})`}
            onClick={() => void preview?.toggleDevTools()}
          >
            DevTools · {modShiftHint("I")}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={inSetup}
            title={`Clear cookies and storage for this preview (${modShiftHint("⌫")})`}
            onClick={() => void preview?.clearData()}
          >
            Clear data · {modShiftHint("⌫")}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            title={`Close the preview and stop the dev services (${modShiftHint("P")})`}
            onClick={onClose}
          >
            Close · {modShiftHint("P")}
          </button>
        </div>
      </div>

      <div className="preview-statusline" role="status">
        <span className={`preview-phase preview-phase-${status.phase}`}>
          {PHASE_LABEL[status.phase]}
        </span>
        {web ? (
          <span className="preview-service">
            {web.name}
            {web.url ? ` · ${web.url}` : ""}
          </span>
        ) : null}
        {support.length ? (
          <span className="preview-service preview-service-muted">
            +{support.length} support{" "}
            {support.length === 1 ? "process" : "processes"}
          </span>
        ) : null}
        {status.consoleErrorCount > 0 ? (
          <span className="preview-console-badge">
            {status.consoleErrorCount} console{" "}
            {status.consoleErrorCount === 1 ? "error" : "errors"}
          </span>
        ) : null}
        {status.picking ? (
          <span className="preview-warning">
            Click an element in the page · Esc to cancel
          </span>
        ) : null}
        {status.devtoolsOpen ? (
          <span className="preview-warning">
            DevTools attached — element picking is paused
          </span>
        ) : null}
      </div>

      {status.error || snipError ? (
        <p className="preview-error" role="alert">
          {snipError ?? status.error}
        </p>
      ) : null}

      <div ref={stageRef} className="preview-stage">
        <div ref={holeRef} className="preview-hole" aria-hidden />
        {inSetup ? (
          <PreviewSetupBanner
            phase={
              status.phase === "needs_confirm"
                ? "needs_confirm"
                : "needs_command"
            }
            setup={status.setup}
            busy={busy}
            onAsk={askAgentForSetup}
            onConfirm={confirmSetup}
            onChange={onFocusComposer}
          />
        ) : pageless ? (
          <div className="preview-placeholder">
            {status.phase === "error"
              ? "The preview could not start. Check the dev terminal."
              : status.phase === "waiting"
                ? "Waiting for the server to accept connections."
                : "Starting the dev server — the page appears as soon as it answers."}
          </div>
        ) : overlayBlocked ? (
          <div className="preview-placeholder">
            A dialog is open — the live page is hidden until you close it.
          </div>
        ) : null}
      </div>

      {capture ? (
        <PreviewCropOverlay
          image={{ dataBase64: capture.dataBase64, mime: capture.mime }}
          rect={capture.rect}
          onCancel={() => setCapture(null)}
          onCrop={onCropped}
        />
      ) : null}
    </section>
  );
}
