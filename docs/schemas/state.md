# `.mpl/state.json` Schema (H1, frozen v0.18.0)

> **Status**: Frozen — H1 (#108) freezes the sprint-vs-phase split so the
> G3 invariant checker (`hooks/lib/mpl-state-invariant.mjs`) has a stable
> reference. Changes that break these invariants must bump
> `schema_version` and add a migration in `hooks/lib/mpl-state.mjs`.
>
> **Source-of-truth**: runtime `DEFAULT_STATE` in `hooks/lib/mpl-state.mjs`.
> This document mirrors that shape and adds the unit semantics that the
> code itself can't carry inline.

## Unit semantics (sprint vs phase)

| Field path | Unit | Notes |
|---|---|---|
| `current_phase` | lifecycle marker (string enum) | Not a phase id. Values: `phase1-plan`, `phase1a-research`, `phase1b-plan`, `mpl-decompose`, `mpl-ambiguity-resolve`, `phase2-sprint`, `phase3-gate`, `phase4-fix`, `phase5-finalize`, `completed`, `cancelled`, or a concrete `phase-N` id while inside the sprint. |
| `execution.phases.*` | per-phase | One entry per phase-runner invocation. `completed` count must match the number of `.mpl/mpl/phases/phase-*/` directories that carry a `state-summary.md` finalize artifact (G3 invariant I4). Empty pre-created directories from `mpl-run-decompose.md` Step 4 do NOT count. |
| `execution.phase_details[]` | per-phase | Status/retries/pass_rate per phase id. |
| `sprint_status.total_todos` | sprint-aggregated | Sum of TODO counts across all phases of the active sprint (typically all of phase2-sprint). |
| `sprint_status.completed_todos` | sprint-aggregated | Number of TODOs marked complete. |
| `gate_results.hard{1,2,3}_{baseline,coverage,resilience}` | per-pipeline | Structured machine evidence. P0-1 (#102) requires `{command, exit_code, stdout_tail, timestamp}`. |
| `fix_loop_count` | sprint-aggregated | Total fix-loop iterations across the active sprint. Equal to `sum(fix_loop_history[].count)` (G3 I5; writers populate via `writeState` mirror in `mpl-state.mjs#recordFixLoopHistory`). |
| `fix_loop_history[]` | per-phase | `{phase, count, started_at, ended_at?, root_cause_summary?}` entries. Populated by `writeState` whenever `fix_loop_count` increases (G5 / #114). |
| `user_intervention_count` | per-pipeline | Honest auto-mode telemetry. `mpl-keyword-detector` (UserPromptSubmit) increments by 1 on every prompt while pipeline is active and `run_mode === 'auto'` (G6 / #114). Surfaces in `/mpl-status` once G2 / #113 lands. |
| `session_status` | per-session | `null \| active \| paused_budget \| paused_checkpoint \| verification_hang \| cancelled`. Single-valued — pause / hang / cancel states are mutually exclusive (G3 I9). |
| `last_tool_at` | per-session | ISO-8601 stamp from `mpl-tool-tracker.mjs`. Powers G4 (#109). |
| `enforcement.*` | per-pipeline override | P0-2 (#110) per-rule policy. Top of the precedence chain. |

## Invariants enforced (G3 / #108)

The G3 hook (`mpl-state-invariant.mjs`) checks the table below at four
trigger points. Action policy comes from
`enforcement.state_invariant_violation` (P0-2) — `off | warn | block`,
strict mode elevates `warn → block`.

| ID | Description | Triggers | Notes |
|---|---|---|---|
| I1 | `session_status='paused_budget' AND finalize_done=true` is impossible | all | Mutual contradiction. |
| I2 | `current_phase='completed' AND finalize_done=false` is impossible | all | Completion requires finalize. |
| I3 | `paused_*` or `verification_hang` AND new Task/Agent dispatch | task-dispatch | Resume the pipeline (`/mpl:mpl-resume`) before dispatching. |
| I4 | `execution.phases.completed != count(phase-N/state-summary.md)` | all | Disk truth = number of phase directories carrying the `state-summary.md` finalize artifact. Declared count must match. Empty `phase-N/` directories pre-created by `mpl-run-decompose.md` Step 4 do NOT count. |
| I5 | `fix_loop_count != sum(fix_loop_history)` | all | G5 (#114) writes history; counter must agree. |
| I6 | phase3-gate state-write missing structured gate evidence | state-write | P0-1 (#102) requirement. |
| I7 | `current_phase='phase-N' AND .mpl/mpl/phases/phase-N/` absent | all | Lifecycle marker vs disk drift. |
| I8 | `schema_version > CURRENT_SCHEMA_VERSION` | all | Hook is older than writer; upgrade plugin. |
| I9 | `session_status` outside the allowed enum | all | Forward-compat with G4 / #109 future fields. |

## Trigger registration

| Hook event | Matcher | Trigger constant |
|---|---|---|
| PreToolUse | `Task\|Agent` | `task-dispatch` |
| PreToolUse | `Edit\|Write\|MultiEdit` (with `.mpl/state.json` target filter) | `state-write` |
| Stop | (none) | `stop` |
| PreCompact | (none) | `pre-compact` (planned) |

## Schema version

- `CURRENT_SCHEMA_VERSION = 3` (G5+G6 / #114 — additive backfill: `fix_loop_history`, `user_intervention_count`).
  - v2 (P2-6 / #84) — unified state, `execution` subtree absorbs the legacy `.mpl/mpl/state.json`.
  - v3 (G5+G6 / #114) — telemetry hygiene fields.
- The migration registry (`hooks/lib/migrations/`) walks any older state up to current on `readState`. Newer-than-supported writes are **fail-closed** by `readState` (returns `null` + diagnostic stderr) and additionally surfaced by G3 I8.
- `writeState` also fail-closes (throws `UnsupportedSchemaVersionError`) when on-disk `schema_version > CURRENT` so a stale plugin can't downgrade a fresher state.
- Bump policy and authoring workflow: `docs/schemas/migration-policy.md`.

## See also

- `hooks/lib/mpl-state.mjs` — runtime schema + `readState` fail-closed guard.
- `hooks/lib/migrations/` — versioned migration registry (H8 / #116).
- `docs/schemas/migration-policy.md` — bump policy + authoring workflow.
- `hooks/lib/mpl-state-invariant.mjs` — invariant checker (this document's mechanical mirror).
- `commands/mpl-run.md` §"MPL State" — orchestrator protocol view.
- `docs/config-schema.md` §Enforcement — `state_invariant_violation` policy.
