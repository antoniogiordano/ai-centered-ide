# Agent tools by product phase

Source of truth: `packages/tools` (`createDefaultRegistry`, `ToolDefinition.phases`) and gating in `packages/agent` (`buildModelToolDefs` → `listForPhase(productPhaseForState(...))` via `deriveProductPhase`).

## How gating works

| Product phase (UI) | When | Tool registry phase |
| --- | --- | --- |
| **Plan** | `mode === "plan"` or `planStatus === "drafting"` | `planning` |
| **Build** | After Start Build, checklist still open | `building` |
| **Test** | Checklist complete until commit/PR offer (await confirm, gate running, or fix loop) | `testing` |

Notes:

- Registry phases are `planning` | `building` | `testing`.
- CBM / graph tools are registered for all three phases, but **omitted from the model** until the workspace is indexed.
- Execution still goes through the Tool Gateway + risk policy.

---

## Plan (`planning`)

Explore + draft the delivery plan. No file writes, git, shell, terminals, or test-report tools.

### Filesystem & search

| Tool | Risk | Role |
| --- | --- | --- |
| `list_dir` | safe | List a workspace directory |
| `read_file` | safe | Read a line window of a text file |
| `search_text` | safe | Grep-like text search (prefer CBM when indexed) |

### Architecture

| Tool | Risk | Role |
| --- | --- | --- |
| `read_architecture` | safe | Effective stack: detection ⊕ `.aici/ARCHITECTURE.md` |
| `upsert_architecture` | safe | Sparse overrides into `.aici/ARCHITECTURE.md` |

### Plan CRUD

| Tool | Risk | Role |
| --- | --- | --- |
| `read_plan` | safe | Current phases, checklist, questions, ready proposal |
| `upsert_plan` | safe | Full-replace plan (prefer micro tools for small edits) |
| `add_phase` | safe | Add one phase |
| `replace_phase` | safe | Replace a phase |
| `delete_phase` | safe | Delete a phase |
| `add_check` | safe | Add one checklist item |
| `replace_check` | safe | Replace one checklist item |
| `delete_check` | safe | Delete one checklist item |
| `set_questions` | safe | Replace Plan Q&A questions (`[]` clears) |
| `propose_plan_ready` | safe | Ask user to confirm Start Build |

### Attachments

| Tool | Risk | Role |
| --- | --- | --- |
| `import_attachment` | safe | Copy a chat attachment into the workspace |

### Codebase graph (when indexed)

| Tool | Risk | Role |
| --- | --- | --- |
| `search_graph` | safe | Primary symbol/route discovery |
| `trace_path` | safe | Callers / callees BFS |
| `get_code_snippet` | safe | Source for a `qualified_name` |
| `get_architecture` | safe | Indexed architecture overview |
| `search_code` | safe | Indexed text search |
| `get_graph_schema` | safe | Labels / relationship schema |
| `detect_changes` | safe | Git diff → impacted symbols |

**Not exposed in Plan:** `write_file`, `replace_in_file`, git_*, `run_command`, `terminal_*`, `checkpoint_restore`, `propose_testing_ready`, `get_test_report`, `list_failed_tests`, `read_test_log`.

---

## Build (`building`)

Implement the agreed checklist. Structure of the plan is locked; progress via `upsert_plan` (`done` sticky). Hand off with `propose_testing_ready`.

### Still available (shared with Plan)

`list_dir`, `read_file`, `search_text`, `read_architecture`, `upsert_architecture`, `read_plan`, `upsert_plan` (progress only), `import_attachment`, plus CBM tools when indexed.

### Implementation

| Tool | Risk | Role |
| --- | --- | --- |
| `replace_in_file` | reversible | **Preferred** edit: exact `search` → `replace` |
| `write_file` | reversible | Create a **new** file, or intentionally **overwrite** an entire existing file |

### Git / shell / terminals / checkpoint

| Tool | Risk | Role |
| --- | --- | --- |
| `git_status` / `git_diff` / `git_commit` | safe / safe / sensitive | Git |
| `run_command` | sensitive | One-shot shell |
| `terminal_*` | safe / reversible | Persistent PTY |
| `checkpoint_restore` | reversible | Restore checkpoint |

### Hand-off to Test

| Tool | Risk | Role |
| --- | --- | --- |
| `propose_testing_ready` | safe | Checklist done → IDE runs Test gate |

**Not exposed in Build:** Plan micro-CRUD, `propose_plan_ready`, and test-report tools (`get_test_report`, `list_failed_tests`, `read_test_log`).

---

## Test (`testing`)

Entered when the checklist is complete and there is no commit/PR offer yet. **Plan is frozen** — `read_plan` only. Bug-fix against the IDE Test gate.

### Test gate (Testing only)

| Tool | Risk | Role |
| --- | --- | --- |
| `get_test_report` | safe | Suite status, platform, pass/fail counts |
| `list_failed_tests` | safe | Failed test titles (optional `suiteId`) |
| `read_test_log` | safe | Raw log chunk for a suite |

### Bug-fix still available

Explore/read tools, CBM (if indexed), `replace_in_file` / `write_file`, git_*, `run_command`, `terminal_*`, `import_attachment`, architecture read/upsert.

### Explicitly removed in Testing

- All plan mutation: `upsert_plan`, `add_phase`, `replace_phase`, `delete_phase`, `add_check`, `replace_check`, `delete_check`, `set_questions`, `propose_plan_ready`
- `propose_testing_ready` (already confirmed)
- `checkpoint_restore`

Do **not** re-launch full lint/test suites via `run_command` / `terminal_*` — the IDE re-runs the gate after fixes.

---

## Quick matrix

| Tool | Plan | Build | Test |
| --- | --- | --- | --- |
| `list_dir` / `read_file` / `search_text` | ✓ | ✓ | ✓ |
| CBM graph tools (if indexed) | ✓ | ✓ | ✓ |
| `read_architecture` / `upsert_architecture` | ✓ | ✓ | ✓ |
| `read_plan` | ✓ | ✓ | ✓ (read-only) |
| `upsert_plan` | ✓ | ✓ (progress) | — |
| Plan micro-CRUD + `set_questions` + `propose_plan_ready` | ✓ | — | — |
| `import_attachment` | ✓ | ✓ | ✓ |
| `write_file` | — | ✓ (new / full rewrite) | ✓ |
| `replace_in_file` | — | ✓ (preferred edits) | ✓ |
| `git_*` / `run_command` / `terminal_*` | — | ✓ | ✓ |
| `checkpoint_restore` | — | ✓ | — |
| `propose_testing_ready` | — | ✓ | — |
| `get_test_report` / `list_failed_tests` / `read_test_log` | — | — | ✓ |

---

## Related code

- Registry + phase filter: `packages/tools/src/registry.ts`
- Builtins: `packages/tools/src/builtins.ts`
- CBM tools: `packages/tools/src/cbm-builtins.ts`
- Model exposure: `packages/agent/src/loop.ts` (`buildModelToolDefs`)
- Product phase: `packages/shared/src/domain.ts` (`deriveProductPhase`), `packages/agent/src/state.ts` (`productPhaseForState`)
- Phase gating tests: `packages/tools/src/index.test.ts` (`phase tool gating`)
