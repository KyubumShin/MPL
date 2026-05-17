# Phase Contract Graph Schema

File: `.mpl/mpl/decomposition.yaml`

The decomposition is a contract graph, not just a task list. Each phase must
carry the evidence and change policy needed for later phase completion and
controlled recomposition.

## Required Top-Level Metadata

```yaml
graph_version: 1
generated_by: mpl-decomposer
recompose_count: 0
completed_phase_policy: immutable_by_default
goal_contract_hash: "<sha256 .mpl/goal-contract.yaml>"
```

## Required Per-Phase Surface

```yaml
phases:
  - id: phase-1
    evidence_required:
      - command
      - test_agent
      - goal_trace
    change_policy: append_delta_only
    goal_trace:
      acceptance_criteria: [AC-1]
      variation_axes: [AX-1]
      ontology_entities: [entity]
    interface_contract:
      requires:
        - type: artifact
          name: previous_output
          from_phase: phase-0
      produces:
        - type: artifact
          name: current_output
```

## Runtime Enforcement

- `hooks/mpl-require-phase-contract-graph.mjs` blocks
  `decomposition.yaml` writes when:
  - top-level graph metadata is missing
  - `generated_by` is not `mpl-decomposer`
  - any phase lacks non-empty `evidence_required`
  - any phase lacks non-empty `change_policy`
  - `interface_contract.requires[].from_phase` points to the same phase or an
    unknown phase
- `.mpl/config.json { "phase_contract_graph_required": false }` is an explicit
  migration opt-out.
- `hooks/mpl-require-decomposition-delta.mjs` blocks changes to an existing
  graph unless a valid `decomposition-deltas/recompose-N.yaml` exists and
  `recompose_count` advances by exactly one.
- `hooks/mpl-require-phase-evidence.mjs` consumes each phase's
  `evidence_required` list and blocks phase completion artifacts/state until
  `verification.md` contains a matching Evidence Latch.

## Notes

`contract_hash` is reserved for a later post-processing phase that can compute a
real hash from canonical phase content. Do not ask the decomposer to fabricate a
cryptographic value. Use `recompose_count` plus decomposition deltas for graph
change history until canonical phase hashes exist.
