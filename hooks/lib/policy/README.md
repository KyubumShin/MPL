# hooks/lib/policy/ — L2 policy modules

## Purpose
Per the v2 redesign proposal (`docs/redesign-proposal.html` L264-275), policy
modules read L1 subsystems (`state/`, config) and produce decisions
(contracts, evidence, gates, permits, source-edit guards, channel registry,
schemas, audit). They are leaf nodes in the dependency graph: each policy is
independent.

## Status
Seven policy modules populated (Moves #6-#11):

- `source-edit.mjs`       — Move #6
- `contracts.mjs`         — Move #8
- `evidence.mjs`          — Move #7
- `gates.mjs`             — Move #9 (narrow exception → `contracts.mjs`)
- `permit.mjs`            — Move #10 (narrow exception → `source-edit.mjs` pure helpers)
- `channel-registry.mjs`  — earlier move
- `schemas.mjs`           — Move #11 (zero cross-policy imports)

Other candidates identified by the lib scout (not yet moved):

- `mpl-enforcement.mjs` → `policy/enforcement.mjs`
- `mpl-gate-classify.mjs` → `policy/gate-classify.mjs`
- `mpl-goal-contract.mjs` → `policy/goal-contract.mjs`
- `mpl-artifact-schema.mjs` → `policy/artifact-schema.mjs` (future move could
  fold pivot-points presence-check into the artifact-schema registry)

## Forbidden imports
`policy/X` may NOT import `policy/Y`. Cross-policy coupling defeats the
purpose of L2 isolation. Policies may import from L1 (`state/`, config) and
from pure utilities only.

### Narrow exception — `gates.mjs` → `contracts.mjs`
Move #9 introduces a single, documented narrow exception: `policy/gates.mjs`
MAY import the four finalize-child handlers from `policy/contracts.mjs`
(`handleE2eGate`, `handleE2eAuthenticity`, `handleFinalizeArtifacts`,
`handleWholeGoalClosure`) for use inside `handleFinalize`. Rationale:
`contracts.mjs` is already the SSOT for those four rules; re-implementing
them in `gates.mjs` would clone code with no compensating benefit. This is
one of two permitted cross-policy imports. `gates.mjs` MUST NOT import
`policy/evidence.mjs`, `policy/channel-registry.mjs`, or
`policy/source-edit.mjs`. All other forbidden-import rules unchanged.

### Narrow exception — `permit.mjs` → `source-edit.mjs` (pure helpers only)
Move #10 introduces a second, equally narrow exception: `policy/permit.mjs`
MAY import a small set of pure helpers and regex constants from
`policy/source-edit.mjs` to fix the eval-finding-#1c fail-open default in
`handleAutoPermit`'s Bash branch. The permitted symbols are limited to:

- `normalizeShellCommand`
- `extractBashWriteTargets`
- `matchesProtectedDelete`
- `isAllowedPath`
- `isSourceFile`
- `isDangerousBashCommand`
- `isDogfoodMode`
- `DANGEROUS_BASH_PATTERNS` (re-exported as `SOURCE_DANGEROUS_PATTERNS`)
- `PROTECTED_DELETE_TARGETS`
- `DECOMPOSITION_FILE_REGEX`
- `STATE_FILE_REGEX`

Rationale: these are pure functions / regex constants — no I/O, no mutable
state, no event entrypoint. Re-implementing them in `permit.mjs` would clone
Move #6's classifier (the root cause of the original asymmetry). `permit.mjs`
MUST NOT import `handle` / `handleBash` from `source-edit.mjs`, nor any other
non-source-edit policy module. The shared `classifyBashCommand()` SSOT inside
`permit.mjs` is reused by both `handleAutoPermit` and `handlePermitLearner`
so vetoes cannot drift between PreToolUse and PostToolUse.
