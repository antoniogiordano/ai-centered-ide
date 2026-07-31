# Vertical slice checklist (Phase 10.7)

Manual acceptance against `fixtures/demo-project`. Mark when verified on each OS.

| # | Step | macOS | Windows | Linux |
| --- | --- | --- | --- | --- |
| 1 | Onboarding: Base URL, key, verify, model | | | |
| 2 | Open demo; agent proposes manifest if missing | | | |
| 3 | Start environment / healthchecks | | | |
| 4 | Missing env key: gitignore gate, write key, restart service | | | |
| 5 | Functional change + diff | | | |
| 6 | Browser QA on changed flow | | | |
| 7 | Record flow → Cypress file as diff | | | |
| 8 | Agent refines test + seed link | | | |
| 9 | Two green Cypress runs | | | |
| 10 | Inject regression → diagnose → fix | | | |
| 11 | Restore checkpoint | | | |
| 12 | Human-confirmed commit | | | |
| 13 | Clean quit; restore session on reopen | | | |

Cross-checks: zero secrets in logs/export; zero writes outside workspace; audit complete; no orphan processes.

Automated coverage today: perimeter/threat tests in `packages/workspace`, `packages/tools`, `packages/provider`; agent loop vs mock; CI lint/typecheck/test/build.
