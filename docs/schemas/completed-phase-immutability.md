# Completed Phase Immutability

File: `.mpl/mpl/decomposition.yaml`

Completed phases are immutable contract blocks. A recomposition may append new
phases or modify incomplete phases, but it may not modify or remove a phase
that already has completion evidence.

## Completion Sources

A phase is treated as completed when either source says so:

- `.mpl/mpl/phases/{phase_id}/state-summary.md` exists
- `.mpl/state.json.execution.phase_details[]` has
  `{ id: phase_id, status: "completed" }`

## Runtime Enforcement

- `hooks/mpl-require-completed-phase-immutability.mjs` blocks writes to
  `.mpl/mpl/decomposition.yaml` when a completed phase block is changed or
  removed.
- Partial `Edit`/`MultiEdit` changes to `decomposition.yaml` are blocked when
  completed phases exist. Recomposition must use the full graph rewrite path.
- `.mpl/config.json { "completed_phase_immutability_required": false }` is an
  explicit migration opt-out.

## Allowed Recomposition

- Append new phases after completed phases.
- Modify incomplete phase blocks.
- Update top-level graph metadata such as `recompose_count`.
- Update dependency declarations on incomplete/new phases that reference
  completed phase outputs.
