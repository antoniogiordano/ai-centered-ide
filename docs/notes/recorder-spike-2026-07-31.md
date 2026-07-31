# Recorder spike results

Date: 2026-07-31

## Approach

Injected IIFE in QA webContents: click / debounced input / select / checkbox / submit / hash navigate. Each event stores selector candidates: `data-testid`, role+name, id, name, visible text, structural CSS path.

## Verification

Automated ten-ish interactions on `fixture.html` produce `artifacts/trace.json` with temporal order. Manual replay: follow selectors in order against the fixture SPA.

## Limits

- Shadow DOM: not pierced — may miss targets inside closed shadow roots.
- Cross-origin iframes: inaccessible.
- Re-renders: prefer `data-testid`; structural paths are fragile (flagged in product).

## Product takeaway

Keep injection model; Phase 9 adds explicit assertions, semantic cleanup, and Cypress codegen with selector preference order from the master plan.
