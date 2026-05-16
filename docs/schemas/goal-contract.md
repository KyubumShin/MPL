# Goal Contract Schema

File: `.mpl/goal-contract.yaml`

The Goal Contract is the MPL pipeline constitution. Phase 0 freezes it before
decomposition, and hooks use it to decide whether a later completion claim is
admissible. It is the bridge from a Codex goal or raw user request to machine
evidence.

## Required Shape

```yaml
version: 1
source:
  codex_goal: "string or null"
  user_request: "string"
  user_request_hash: "sha256 of normalized user request"

mission:
  goal: "concrete project objective"
  project_pivot: "main importance / success pivot"
  non_goals:
    - "explicitly excluded scope"
  must_ship_outcomes:
    - "observable outcome the final product must satisfy"

ontology:
  entities:
    - "domain entity"
  relationships:
    - "entity relationship"
  state_transitions:
    - "important lifecycle transition"

variation_axes:
  - id: AX-1
    name: "runtime_mode"
    required_coverage: true
    values:
      - "desktop"
      - "web"

acceptance_criteria:
  - id: AC-1
    statement: "completion condition"
    evidence_required:
      - e2e
      - security

e2e_policy:
  real_runtime_required: true
  mock_allowed: false
  placeholder_assertions_allowed: false

security_policy:
  required: true
  checks:
    - dependency_audit
    - secret_scan
    - injection_review

completion_evidence:
  required_artifacts:
    - .mpl/mpl/audit-report.json
    - .mpl/mpl/profile/run-summary.json
    - .mpl/mpl/RUNBOOK.md
  require_commit: true
  require_finalize_timestamps: true

deferred_uncertainties: []
overrides: []
```

## Runtime Enforcement

- `hooks/mpl-ambiguity-gate.mjs` blocks `mpl-decomposer` dispatch when the
  contract is missing or incomplete, unless `.mpl/config.json` sets
  `goal_contract_required: false`.
- `hooks/mpl-require-e2e-authenticity.mjs` reads `e2e_policy` before allowing
  `finalize_done=true`.
- `hooks/mpl-require-finalize-artifacts.mjs` reads `security_policy` and
  `completion_evidence` before allowing `finalize_done=true`.
- `.mpl/mpl/baseline.yaml` snapshots the contract hash as Phase 0 ground truth.

## Minimum Readiness

The hook-level readiness check requires:

- source goal or user request plus `user_request_hash`
- `mission.goal`, `mission.project_pivot`, and at least one
  `must_ship_outcomes` entry
- at least one ontology entity
- at least one `variation_axes[].id`
- at least one `acceptance_criteria[].id`
- explicit booleans for the three `e2e_policy` fields
- explicit `security_policy.required`
- required completion artifacts and finalize timestamp policy
