# hooks/lib/policy/ — L2 policy modules

## Purpose
Per the v2 redesign proposal (`docs/redesign-proposal.html` L264-275), policy
modules read L1 subsystems (`state/`, config) and produce decisions
(contracts, evidence, gates, permits, source-edit guards, channel registry,
schemas, audit). They are leaf nodes in the dependency graph: each policy is
independent.

## Status
Empty in v2 commit #1 (this README only). Population order is TBD; candidates
identified by the lib scout include:

- `mpl-enforcement.mjs` → `policy/enforcement.mjs`
- `mpl-gate-classify.mjs` → `policy/gate-classify.mjs`
- `mpl-goal-contract.mjs` → `policy/goal-contract.mjs`
- `permit-store.mjs` → `policy/permit.mjs`
- `mpl-artifact-schema.mjs` → `policy/artifact-schema.mjs`

## Forbidden imports
`policy/X` may NOT import `policy/Y`. Cross-policy coupling defeats the
purpose of L2 isolation. Policies may import from L1 (`state/`, config) and
from pure utilities only.
