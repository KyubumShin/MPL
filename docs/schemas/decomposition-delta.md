# Decomposition Delta Schema

File: `.mpl/mpl/decomposition-deltas/recompose-N.yaml`

Existing decomposition graphs are immutable by default. Any change after the
initial `recompose_count: 0` write must leave a delta artifact before the full
graph is rewritten.

## Required Fields

```yaml
delta_version: 1
generated_by: mpl-decomposer
base_recompose_count: 0
target_recompose_count: 1
reason: "why the decomposition graph must change"
change_policy: decomposition_delta_then_recompose
operations:
  - op: append_phase
    target_phase: phase-3b
    rationale: "what this operation preserves or fixes"
    goal_trace:
      acceptance_criteria: [AC-1]
      variation_axes: [AX-1]
```

Allowed `operations[].op` values:

- `append_phase`
- `split_phase`
- `modify_phase`
- `retire_phase`
- `reorder_phase`
- `update_dependency`
- `update_evidence`

## Runtime Enforcement

- `hooks/mpl-require-decomposition-delta.mjs` blocks partial
  `Edit`/`MultiEdit` writes to an existing `.mpl/mpl/decomposition.yaml`.
- Rewriting an existing decomposition requires:
  - `new.recompose_count == old.recompose_count + 1`
  - a matching `.mpl/mpl/decomposition-deltas/recompose-N.yaml`
  - a valid delta whose `base_recompose_count` and `target_recompose_count`
    match the old and new graph counts
- Completed phase blocks remain immutable even during a valid recomposition.
  Append or change incomplete phases instead of editing completed contracts.
- Delta writes are also validated against the current graph count.
- `.mpl/config.json { "decomposition_delta_required": false }` is an explicit
  migration opt-out.
