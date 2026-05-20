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
| `completed_at` / `finalized_at` | per-pipeline | Finalize timestamps required by Goal Contract completion evidence when `require_finalize_timestamps: true`. |
| `goal_contract_set` / `goal_contract_path` / `goal_contract_hash` | per-pipeline | Goal Contract readiness mirror for `.mpl/goal-contract.yaml`; disk artifact remains the source of truth. |
| `security_results.*` | per-pipeline | Structured security gate evidence consumed by `mpl-require-finalize-artifacts.mjs`. |
| `session_status` | per-session | `null \| active \| paused_budget \| paused_checkpoint \| verification_hang \| blocked_hook \| cancelled`. Single-valued — pause / hang / explicit hook block / cancel states are mutually exclusive (G3 I9). |
| `blocked_by_hook` / `blocked_phase` / `block_reason` / `resume_instruction` / `blocked_at` | per-session | Required companion fields while `session_status='blocked_hook'`. Phase routing is paused until the originating hook's missing evidence is restored. `writeState` clears all five when the blocked status clears so stale half-blocked state cannot survive. |
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
| I3 | `paused_*` or `verification_hang` AND new Task/Agent dispatch | task-dispatch | Resume the pipeline (`/mpl:mpl-resume`) before dispatching. `blocked_hook` is visible state but does not block dispatch globally; the originating hook remains responsible for the specific blocked action. |
| I4 | `execution.phases.completed != count(phase-N/state-summary.md)` | all | Disk truth = number of phase directories carrying the `state-summary.md` finalize artifact. Declared count must match. Empty `phase-N/` directories pre-created by `mpl-run-decompose.md` Step 4 do NOT count. Phase 5 additionally requires a valid `verification.md` Evidence Latch before state-summary or completion state writes. |
| I5 | `fix_loop_count != sum(fix_loop_history)` | all | G5 (#114) writes history; counter must agree. |
| I6 | phase3-gate state-write missing structured gate evidence | state-write | P0-1 (#102) requirement. |
| I7 | `current_phase='phase-N' AND .mpl/mpl/phases/phase-N/` absent | all | Lifecycle marker vs disk drift. |
| I8 | `schema_version > CURRENT_SCHEMA_VERSION` | all | Hook is older than writer; upgrade plugin. |
| I9 | `session_status` outside the allowed enum | all | Forward-compat with G4 / #109 future fields. |
| I10 | completion/finalize state with stale `execution.phases` accounting | all | At `finalize_done=true` or `current_phase='completed'`, `execution.status` must be completed, `total/completed` must be positive, `completed <= total`, and `current` must be null. |
| I11 | `session_status='blocked_hook'` without all companion fields | all | A visible hook block must keep hook id, phase, reason, resume instruction, and timestamp together. |

## Test-Agent Evidence

`state.test_agent_dispatched[phase_id]` is a structured evidence record, not just
a dispatch timestamp. PASS evidence requires:

- `valid_json: true`
- `verdict: "PASS"`
- `tests_total > 0`
- `tests_failed == 0`
- `tests_skipped == 0`
- `test_files_created_count > 0` (or legacy `test_files_created[]` length > 0)
- `command_exit_codes_count > 0` and `command_exit_codes_nonzero_count == 0`
  (or legacy `command_exit_codes[]` length > 0, all `0`)
- `bugs_found_count == 0`

`test_files_created[]` and `command_exit_codes[]` are bounded previews to keep
`.mpl/state.json` small. The scalar count fields are the lossless gate inputs:
large responses retain total counts and nonzero command-exit counts even when
the preview is truncated.

Legacy timestamp-only records are treated as non-PASS and cannot satisfy Hard 2
or a phase `evidence_required: [test_agent]` latch. Records missing an explicit
`verdict` are `INVALID`; a PASS-shaped partial state object is not enough.

## Trigger registration

| Hook event | Matcher | Trigger constant |
|---|---|---|
| PreToolUse | `Task\|Agent` | `task-dispatch` |
| PreToolUse | `Edit\|Write\|MultiEdit` (with `.mpl/state.json` target filter) | `state-write` |
| Stop | (none) | `stop` |
| PreCompact | (none) | `pre-compact` (planned) |

## Schema version

- `CURRENT_SCHEMA_VERSION = 4` (Goal Contract / finalize evidence — additive backfill: `completed_at`, `finalized_at`, `goal_contract_*`, `security_results`).
  - v2 (P2-6 / #84) — unified state, `execution` subtree absorbs the legacy `.mpl/mpl/state.json`.
  - v3 (G5+G6 / #114) — telemetry hygiene fields.
  - v4 — Goal Contract readiness + finalize/security evidence fields.
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
