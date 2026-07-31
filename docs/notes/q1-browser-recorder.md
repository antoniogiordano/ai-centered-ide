# Q1 — Browser QA surface & recorder

Date: 2026-07-31

## Decision

**Surface:** Electron `BrowserView` (upgrade path to `WebContentsView` when packaging) with a dedicated `session.fromPartition(...)`, no preload, `contextIsolation` + `sandbox`, zero access to IDE IPC.

**Recorder:** Content script injected into the QA webContents; emits a structured JSON trace with multi-candidate selectors and debounced input. Cypress is used only as the **generated test runtime**, not as the capture engine.

## Alternatives rejected

| Option | Why rejected |
| --- | --- |
| Playwright/Puppeteer as QA host | Extra browser process, weaker integration with Electron window chrome and session policy |
| `<webview>` tag | Deprecated patterns, harder CSP/isolation story |
| Cypress as live recorder | Cypress is a runner; driving it for interactive QA is heavy and couples product to Cypress internals |

## Limits observed (spike)

- Shadow DOM: composed path not fully resolved without `shadowRoot` piercing — document fragile selectors.
- Cross-origin iframes: not inspectable from parent injection.
- Portals: events still fire on the real target node; OK if `data-testid` present.

## Product implication

Phase 9 implements the same partition + injection model inside `packages/qa`, with URL allowlist and redaction before any observation reaches the model.
