# Whole Goal Closure

File: `.mpl/state.json` (`finalize_done: true` write)

Finalization must prove that completed phase evidence closes the frozen Goal
Contract. Artifact existence alone is not enough.

## Closure Rules

Before `finalize_done=true` is accepted:

- `.mpl/mpl/decomposition.yaml` must exist and contain phases.
- Every phase in the decomposition must be completed.
- `state.execution.phases.completed` must equal the decomposition phase count
  when the count is present.
- Every completed phase must have a valid `verification.md` Evidence Latch.
- Completed phases' `goal_trace.acceptance_criteria` union must cover every
  `acceptance_criteria[].id` in `.mpl/goal-contract.yaml`.
- Completed phases' `goal_trace.variation_axes` union must cover every
  `variation_axes[].id` in `.mpl/goal-contract.yaml`.

## Runtime Enforcement

- `hooks/mpl-require-whole-goal-closure.mjs` blocks `finalize_done=true`
  writes when any closure rule is missing.
- It reuses `hooks/lib/mpl-phase-evidence.mjs` to validate each phase's
  `verification.md` latch.
- `.mpl/config.json { "whole_goal_closure_required": false }` is an explicit
  migration opt-out.
