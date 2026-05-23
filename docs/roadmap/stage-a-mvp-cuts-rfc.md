# Stage A RFC - User-Declared MVP + Release Cuts (Sequential)

**Date:** 2026-05-23
**Status:** Implementation-ready after release-path rebaseline
**Source analysis:** `docs/roadmap/parallelism-mvp-analysis.md`
**Stage:** A of A/B/C (sequential execution only; parallel MVP deferred to Stage B)
**Estimated surface:** goal-contract schema/parser + decomposer schema/validators + phase controller release states + release finalize subroutine + mandatory manifest enforcement + state docs/tests.

---

## 1. Summary

Introduce a **user-declared `mvp`** and optional **`release_cuts[]`** as first-class concepts on `decomposition.yaml`, plus a new release path:

```text
release-gate(cut_id) -> release-finalize(cut_id)
```

This path delivers user-visible artifacts mid-pipeline without weakening the existing `phase3-gate` and `phase5-finalize` whole-pipeline semantics. MVP executes **sequentially** in Stage A. Parallel MVP via `contract_skeleton` is deferred to Stage B.

Core rule: **do not reuse or shrink `phase3-gate` / `phase5-finalize` for partial release checkpoints.** Stage A adds a separate release path.

---

## 2. Goals

1. User can declare MVP scope at interview time as AC/AX ids; decomposer maps it to phases and never infers it.
2. Orchestrator delivers a real, runnable artifact at the MVP boundary before extension phases start.
3. `phase3-gate` remains whole-pipeline gate entry after all phases complete.
4. `phase5-finalize` remains whole-goal closure; `finalize_done=true` is still set exactly once by final pipeline finalize.
5. Existing finalization hooks keep their semantics because the release path never writes `finalize_done=true`.
6. Projects without `mvp_scope` continue to run the current sequential pipeline.

---

## 3. Non-Goals (Stage A)

- MVP parallel execution (`contract_skeleton` mode) - Stage B.
- Continuous contract diff at every phase exit - Stage B.
- Dependent-subtree blocking for extension waves - Stage B.
- `module_groups[]` - Stage C.
- Pre-exec lite mode / interview compression - Stage C.
- Symbol/AST-level conflict relaxation - Stage C.

---

## 4. Schema Changes

### 4.1 `.mpl/goal-contract.yaml` - new optional field

```yaml
mvp_scope:                            # OPTIONAL - absent = current behavior, no MVP cut
  acceptance_criteria: [AC-1, AC-2]   # subset of goal-contract.acceptance_criteria
  variation_axes: [AX-1]              # subset of goal-contract.variation_axes
  artifact: draft_pr                  # draft_pr | branch | tag | release_manifest
```

Implementation requirements:

- `docs/schemas/goal-contract.md` documents `mvp_scope`.
- `hooks/lib/mpl-goal-contract.mjs` parses `mvp_scope`.
- Goal Contract readiness remains valid when `mvp_scope` is absent.
- When `mvp_scope` is present, parser/validator rejects unknown AC/AX ids and unsupported artifact values.
- Phase 0 interview presents a guided checklist of AC/AX ids and writes the selected subset.

### 4.2 `.mpl/mpl/decomposition.yaml` - new top-level fields

```yaml
mvp:                                  # REQUIRED iff goal_contract.mvp_scope present
  derived_from: goal_contract.mvp_scope
  phases: [phase-1, phase-2, phase-4] # SSOT for MVP membership
  execution_mode: sequential          # Stage A: always sequential
  artifact: draft_pr

release_cuts:                         # OPTIONAL, 0..N
  - id: cut-ext-a
    phases: [phase-5, phase-6]
    proposed_by: mpl-decomposer
    user_approved: false
```

Validation requirements:

- `mvp` is present iff `goal_contract.mvp_scope` is present.
- `mvp.execution_mode` must be `sequential` in Stage A.
- Every `mvp.phases[]` and `release_cuts[].phases[]` id exists in `phases[]`.
- Every listed phase appears exactly once in `execution_tiers[]`.
- The union of `goal_trace` over `mvp.phases[]` covers every AC/AX id in `goal_contract.mvp_scope`.
- `release_cuts[]` may be empty or absent. Decomposer-proposed cuts require planning-stage HITL confirmation before execution.

### 4.3 `agents/mpl-phase-runner.md` - mandatory manifest output

Add mandatory `export_manifest` for code-bearing phases.

Stage A policy: **block missing manifests for code-bearing phases**. Do not ship Stage A as warn-only if the RFC calls the manifest mandatory.

Implementation split:

- Phase Runner output schema includes `export_manifest` metadata.
- Phase Runner writes `.mpl/mpl/phases/{phase_id}/export-manifest.json` for code-bearing phases.
- Existing SNT-S1 validates manifest content when present.
- New or extended enforcement blocks phase completion when a code-bearing phase lacks the manifest.

Recommended enforcement shape:

- Add `export_manifest` to phase evidence latch tokens for code-bearing phases, or
- Add `hooks/mpl-require-export-manifest.mjs` that blocks `state-summary.md` / completed phase state writes until the manifest exists and SNT-S1 has no errors.

### 4.4 Release artifacts - new files

```text
.mpl/mpl/releases/{cut_id}/release-manifest.json
.mpl/mpl/releases/{cut_id}/gate-results.json
.mpl/mpl/releases/{cut_id}/evidence-summary.md
```

`cut_id` is `mvp` for the MVP cohort, or a user-approved release cut id for extension cohorts.

`release-manifest.json` is always written. PR/branch/tag creation is attempted only when `artifact` requests it.

### 4.5 `state.release` - new state subtree

Cohort-aware sprint completion (§5.2) and release-path routing (§5.1) require a single SSOT field on the state for the active cohort. Add a `release` subtree:

```yaml
state:
  release:
    current_cut_id: null | "mvp" | "<release_cut.id>"   # active cohort, or null when no MVP cut is configured
    completed_cut_ids: []                                # release path completions in order
    pending_artifact: null | {type: draft_pr|branch|tag, target: "<value>"}
```

Lifecycle:

- Set `current_cut_id = "mvp"` when entering the MVP cohort sprint.
- Cleared (set to next cut id, or to `null` when no further cuts remain) at the end of `release-finalize(cut_id)`.
- Appended to `completed_cut_ids` on successful `release-finalize`.
- Never re-entered for the same `cut_id` within a single pipeline run.
- For projects without `mvp_scope`: `current_cut_id` stays `null`; the release path is skipped entirely and the state machine runs as today.

This field is the SSOT for "which cohort is currently active." Hook code (e.g., `phase2-sprint` completion check) reads `current_cut_id` to determine cohort membership.

---

## 5. Orchestrator Changes

### 5.1 New release path states

Do not route MVP completion through `phase3-gate`. `phase3-gate` remains the final whole-pipeline gate.

State machine with MVP:

```text
mpl-init
-> mpl-decompose
-> phase2-sprint                     # execute MVP cohort only
-> release-gate                      # scoped to state.release.current_cut_id = "mvp"
-> release-finalize                  # release-finalize("mvp")
-> phase2-sprint                     # execute remaining extension phases/cuts
-> release-gate / release-finalize   # optional, for approved extension cuts
-> phase3-gate                       # whole-pipeline gate, after all phases complete
-> phase5-finalize                   # whole-goal finalize
-> completed
```

Projects without `mvp_scope` skip `release-gate` and `release-finalize` and follow the current path.

### 5.2 Cohort-aware sprint completion

Current `phase2-sprint` transitions to `phase3-gate` only when all PLAN TODOs are done. Stage A must add cohort awareness:

- While `state.release.current_cut_id = "mvp"`, sprint completion means all `mvp.phases[]` are complete.
- While inside an approved extension cut, sprint completion means that cut's phases are complete.
- When no active release cut remains, sprint completion falls back to whole-pipeline completion and transitions to `phase3-gate`.

This avoids treating MVP completion as whole-pipeline completion.

### 5.3 `release-gate(cut_id)`

Runs scoped gates and writes release gate evidence under `.mpl/mpl/releases/{cut_id}/gate-results.json`.

Do not write scoped release gate results into `state.gate_results.hard{1,2,3}_*`; those fields are consumed by final `phase3-gate` semantics.

Gate scope for Stage A:

- **Hard 1 (build/lint/type): full project scope.** A single broken file breaks the whole build, so partial Hard 1 is meaningless.
- **Hard 2 (tests): affected scope.** Use `impact.affected_tests[]` from cut phases, then augment with import-graph detection from files in `impact.create` and `impact.modify`. If source changes exist but no affected tests can be resolved, fall back to the project's normal test command for safety. **Fallback must surface to the user**: write `hard2_fallback: full_project` with the reason (e.g., `unresolved_affected_tests`, `import_graph_empty`) into `.mpl/mpl/releases/{cut_id}/gate-results.json`, and include the fallback reason in the user-visible release manifest. Silent fallback is forbidden — it would mask coverage regressions and pollute timing metrics.
- **Hard 3 (contracts): cut scope.** Verify contract files and produced symbols declared by phases in the active cut.

### 5.4 `release-finalize(cut_id)`

Responsibilities:

- Read `.mpl/mpl/releases/{cut_id}/gate-results.json`.
- Verify phase evidence, manifest evidence, Test Agent evidence where required, and cut-scoped gate results.
- Write `.mpl/mpl/releases/{cut_id}/release-manifest.json` and `evidence-summary.md`.
- Attempt optional user-visible artifact creation (`draft_pr`, `branch`, `tag`) only when requested by `artifact`.
- On artifact creation failure, write `artifact_creation_failed` with reason into the release manifest, surface it to the user, and continue to the next cohort.
- Never set `state.finalize_done=true`.
- Never transition `current_phase` to `completed`.
- Never run whole-goal closure.

### 5.5 `phase3-gate` and `phase5-finalize` remain final-only

`phase3-gate` still means whole-pipeline Hard 1/2/3 after all phases complete.

`phase5-finalize` still means whole-goal closure and remains the only path that sets `finalize_done=true`.

Shared implementation is allowed only below the semantic boundary. For example:

```text
run_gate_commands(scope)
write_evidence_summary(scope)
```

Do not call `release-finalize(cut_id)` from `phase5-finalize`. Whole-goal closure remains exclusive to `phase5-finalize`; the release path is a separate, repeatable subroutine and never sets `finalize_done=true`.

---

## 6. Hook / State Impact

| Area | Change |
|---|---|
| `hooks/lib/mpl-state.mjs` | Add `release-gate` and `release-finalize` to `VALID_PHASES`; optionally add a `release` subtree default for active cut metadata. |
| `docs/schemas/state.md` | Document new lifecycle markers and release-scoped metadata. No migration version bump required if fields are additive, but enum/docs/tests must update. |
| `mpl-phase-controller.mjs` | Add `release-gate` and `release-finalize` branches; make `phase2-sprint` cohort-aware. Do not route MVP completion through `phase3-gate`. |
| `mpl-require-phase-contract-graph.mjs` or new validator | Validate `mvp`, `release_cuts[]`, phase membership, execution tier membership, and MVP goal_trace coverage. |
| `hooks/lib/mpl-goal-contract.mjs` | Parse and validate optional `mvp_scope`. |
| `mpl-sentinel-s1.mjs` | Keep content validation; missing-manifest blocking belongs in evidence latch or a dedicated require hook. |
| New/extended manifest enforcement | Block code-bearing phase completion when `export-manifest.json` is missing. |
| `mpl-require-whole-goal-closure.mjs` | No semantic change. It remains tied to `finalize_done=true` only. |

---

## 7. Migration

- **Projects with no `mvp_scope`:** zero behavior change. New release states/subroutines are skipped.
- **Projects mid-pipeline at Stage A landing:** keep their current decomposition. New fields are absent; old path runs.
- **State schema:** no migration bump required if release fields are additive and optional. Still update `VALID_PHASES`, `docs/schemas/state.md`, HUD/status labels if needed, and phase-controller tests.
- **Goal Contract:** existing contracts without `mvp_scope` remain valid.

---

## 8. Verification Plan

1. **Goal Contract unit tests:** parse/validate `mvp_scope`; reject unknown AC/AX ids and unsupported artifact values; accept absent `mvp_scope`.
2. **Decomposition unit tests:** reject missing `mvp` when `mvp_scope` exists; reject `mvp.phases` or `release_cuts[].phases` not in `phases[]` or `execution_tiers[]`; reject MVP phase union that does not cover `mvp_scope` AC/AX ids.
3. **State/controller tests:** `phase2-sprint` with completed MVP cohort transitions to `release-gate`, not `phase3-gate`; final whole-pipeline completion still transitions to `phase3-gate`.
4. **Release gate tests:** release gate writes `.mpl/mpl/releases/mvp/gate-results.json` and does not mutate `state.gate_results` used by final `phase3-gate`.
5. **Release finalize tests:** `release-finalize` writes release artifacts and never sets `finalize_done=true` or `current_phase=completed`.
6. **Manifest enforcement tests:** code-bearing phase without `export-manifest.json` is blocked before completion; non-code phase is allowed.
7. **Integration:** fixture with `mvp_scope: [AC-1]` produces `.mpl/mpl/releases/mvp/release-manifest.json`, optionally attempts requested artifact, returns to extension sprint, and finishes through final `phase3-gate` / `phase5-finalize`.
8. **Regression:** fixture with no `mvp_scope` follows pre-RFC state transitions and final artifacts.

---

## 9. Decisions Already Made (from source analysis)

- MVP scope is user-declared, not decomposer-inferred.
- `mvp` and `release_cuts[]` are separate first-class concepts.
- Partial release checkpoints use `release-gate` / `release-finalize`; they do not reuse `phase3-gate` / `phase5-finalize`.
- Stage A manifest policy is mandatory/block for code-bearing phases.
- File-overlap blocking remains in Stage A; no symbol-overlap relaxation.
- Skeleton verification and reconcile-failure policy are Stage B concerns.

---

## 10. Resolved Decisions (Stage A Scope)

All Stage A open questions are resolved. RFC moves to implementation-ready state after the release-path rebaseline above.

### D-Q1 - `mvp_scope` interview wording

**Decision:** guided checklist. Interviewer presents all AC/AX ids from `goal-contract.yaml` with descriptions; user selects which subset constitutes MVP.

When total AC/AX count exceeds 10, group the checklist by `core_scenarios` to aid navigation. Group headers are display-only; the underlying selection unit remains individual AC/AX ids.

Rejected alternatives:

- `id-only`: cognitively hostile.
- `prose-mapped`: reintroduces inference from prose to ids and violates the v0.17 lesson.

### D-Q2 - `release_cuts[]` HITL gating

**Decision:** single HITL confirmation at the end of planning; no HITL during execution.

Form:

- Decomposer proposes `mvp.phases` and `release_cuts[]`.
- Existing decompose/planning HITL is extended with one cut-structure confirmation step.
- User may redirect cut split, order, or removal before execution.
- After confirmation, execution runs unattended. Release artifacts are surfaced, but execution-time HITL is not introduced.

### D-Q3 - `release-gate(mvp)` gate scope

**Decision:** scoped Hard 1/2/3 with full regression deferred to final `phase3-gate` / `phase5-finalize`.

- Hard 1: full project.
- Hard 2: affected tests from `impact.affected_tests[]` plus import-graph detection; fallback to full project test command when source changes exist but affected tests cannot be resolved.
- Hard 3: contracts and produced symbols for active cut phases.

### D-Q4 - MVP artifact creation

**Decision:** release manifest always; PR/branch/tag only when explicitly requested.

- Always write `.mpl/mpl/releases/mvp/release-manifest.json`.
- If `mvp.artifact` is `draft_pr`, `branch`, or `tag`, attempt the corresponding git/GitHub operation.
- On failure, write `artifact_creation_failed` with reason, surface it to the user, and continue to the extension cohort.

---

## 11. Out-of-Scope Follow-ups

These belong to Stage B or later:

- `mvp.execution_mode: contract_skeleton`.
- Skeleton phase + 1-pass reconcile + fail-and-surface.
- Continuous contract diff at every phase exit.
- Dependent-subtree blocking for extension waves.
- Frontier-aware worker pool sizing.
- `module_groups[]`.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| `mvp.phases` becomes ambiguous when one phase advances multiple AC/AX ids partially in MVP | Decomposer treats phase as binary: in MVP or not. Partial-coverage phases are pulled fully into MVP and surfaced during decomposition review. |
| Release-time partial gates miss a regression that full Hard 2 would catch | Final `phase3-gate` still runs full pipeline verification. Release-time tests are fast feedback, not replacement. |
| Users skip declaring `mvp_scope`, defeating the feature | Interview prompts explicitly. If user says everything is MVP, store all AC/AX ids. If user declines, omit `mvp_scope` and keep current behavior. |
| Hook drift between release and pipeline finalization | Keep semantic flows separate. Share only lower-level helpers such as `run_gate_commands(scope)` and `write_evidence_summary(scope)`. |
| Release gate evidence pollutes final gate evidence | Store release gate results under `.mpl/mpl/releases/{cut_id}/`; do not write to `state.gate_results`. |
