# Browser surface spike results

Date: 2026-07-31  
OS: macOS 14 arm64 (Electron 33). Windows/Linux: same Electron APIs expected; validate packaging of native deps in CI.

## Setup

`spikes/browser-surface` — `BrowserView` + `session.fromPartition('persist:qa-spike-isolated')`, no preload on QA view.

## Checks

| Capability | Result |
| --- | --- |
| Isolated session/cookies | Dedicated partition |
| No IDE API access from page | No preload / no nodeIntegration |
| Console messages | `webContents.on('console-message')` |
| Network | `session.webRequest.onCompleted` |
| Screenshot viewport | `capturePage` → PNG |
| Viewport change | `setBounds` + page resize |
| Clear session | `session.clearStorageData()` |

Artifacts under `spikes/browser-surface/artifacts/`.

## Product takeaway

Adopt partition-isolated BrowserView/WebContentsView for Phase 9; enforce URL allowlist in main before `loadURL`.
