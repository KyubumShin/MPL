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
    user_approved: false              # planning-stage HITL flips to true; runtime never mutates
    artifact: release_manifest        # draft_pr | branch | tag | release_manifest (default)
```

Validation requirements:

- `mvp` is present iff `goal_contract.mvp_scope` is present.
- `mvp.execution_mode` must be `sequential` in Stage A.
- Every `mvp.phases[]` and `release_cuts[].phases[]` id exists in `phases[]`.
- Every listed phase appears exactly once in `execution_tiers[]`.
- No phase appears in both `mvp.phases[]` and any `release_cuts[].phases[]`, and no phase appears in multiple `release_cuts[]` entries.
- The union of `goal_trace` over `mvp.phases[]` covers every AC/AX id in `goal_contract.mvp_scope`.
- **Dependency-closure rule (B5).** For every phase in `mvp.phases[]`, every entry in `interface_contract.requires[]` MUST resolve to either (a) another phase in `mvp.phases[]`, or (b) baseline pre-existing code (no `from_phase`). For every phase in `release_cuts[N].phases[]`, every `requires[]` MUST resolve to (a) a phase in the same cut, (b) a phase in any **earlier** `release_cuts[]` entry, (c) `mvp.phases[]`, or (d) baseline. **A `requires` pointing forward (to a later cut) or upward (from MVP to extension) is invalid** — the validator rejects the decomposition and the user must either expand `mvp_scope` to cover the prerequisite, or shrink it so the dependency falls outside MVP.
- `release_cuts[]` may be empty or absent. Decomposer-proposed cuts require planning-stage HITL confirmation before execution.

`release_cuts[].artifact` semantics (B7):

- Per-cut artifact selection, same value set as `mvp.artifact`. Default `release_manifest` for extension cuts (most extension cohorts only need a manifest, not a PR/branch/tag).
- All artifact creation uses the snapshot-ref mechanism (§5.4.1) regardless of cut.

`release_cuts[].user_approved` semantics (B8):

- **Planning-stage HITL is the only writer.** During decompose, the HITL prompt flips `user_approved` to `true` for cuts the user accepts; declined cuts stay `false`.
- **Runtime never mutates `user_approved`.** Re-running, recompose, or reviewer feedback do not change this field at runtime. To approve a previously declined cut, the user must trigger RECOMPOSE-MODE and re-confirm at planning.
- **Runtime behavior of `user_approved: false`:** the cut's phases are not run through the release path. Instead, they are treated as **non-cut tail phases** (subject to normal `execution_tiers[]` scheduling, no `release-gate`/`release-finalize` invocation). They still execute, they just don't ship as a release.

### 4.3 `agents/mpl-phase-runner.md` - mandatory manifest output

Add mandatory `export_manifest` for code-bearing phases.

Stage A policy: **block missing manifests for code-bearing phases**. Do not ship Stage A as warn-only if the RFC calls the manifest mandatory.

**Migration scope (B4):** the new `mpl-require-export-manifest.mjs` hook is **gated on `goal_contract.mvp_scope` presence**. Projects without `mvp_scope` (mid-pipeline at Stage A landing, or any project that does not opt in to the MVP cut path) retain the current warn-only SNT-S1 behavior. Rationale:

- A project without `mvp_scope` never enters the release path; making manifest enforcement unconditional would block in-flight code-bearing phases that did not emit a manifest under the old protocol.
- Tying the enforcement scope to opt-in is consistent with the rest of Stage A (release path, cohort-aware sprint completion, all gated on `mvp_scope`).
- Once a project declares `mvp_scope`, all subsequent code-bearing phases (MVP cohort, extension cuts, non-cut tail) require the manifest — the gate is project-wide, not cohort-wide, to avoid two different completion contracts inside one pipeline.

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
- **Hard 2 (tests): affected scope.** Stage A uses `impact.affected_tests[]` declared by cut phases as the primary source. Import-graph derivation is deferred to Stage B (mechanical recipe is language-dependent and out of scope here). If `impact.affected_tests[]` is empty for a code-bearing cut, fall back to the project's normal test command read from `.mpl/config.json` (key `test_command`). If both `impact.affected_tests[]` and `test_command` are absent, **release-gate fails fast** rather than silently passing. **Fallback must surface to the user**: write `hard2_fallback: full_project` with the reason (e.g., `empty_affected_tests`, `no_test_command`) into `.mpl/mpl/releases/{cut_id}/gate-results.json`, and include the fallback reason in the user-visible release manifest. **A failed full-project fallback blocks release identically to a scoped Hard 2 failure**; the wider scope does not soften the verdict.
- **Hard 3 (contracts): cut scope.** Verify contract files and produced symbols declared by phases in the active cut.

### 5.3.1 `release-gate` failure path

When any of Hard 1/2/3 fails inside `release-gate`, the orchestrator does NOT transition to `release-finalize`. Failure routing mirrors the existing `phase3-gate → phase4-fix` pattern, scoped to the active cohort:

1. **Record failure** under `.mpl/mpl/releases/{cut_id}/gate-results.json` with `status: fail`, the failing gate(s), and evidence excerpts.
2. **Increment** `state.release.fix_loop_count` (a new field, parallel to the existing top-level `fix_loop_count` which remains reserved for `phase3-gate`). Do NOT touch the top-level `fix_loop_count`.
3. **Route back to `phase2-sprint` for the same cohort** — `state.release.current_cut_id` is **not** cleared. Sprint re-enters the cohort's phases for fixups, then returns to `release-gate(cut_id)` on completion.
4. **Circuit break** when `state.release.fix_loop_count` reaches `max_fix_loops` (config-driven, default 3). On circuit break:
   - `state.release.current_cut_id` stays pinned (so the user can see which cohort blocked).
   - Pipeline halts with a user-surfaced error: which cut, which gate, why.
   - User intervention required: fix manually + reset `state.release.fix_loop_count`, OR abort the cut (clears `current_cut_id` and routes the cohort's phases to non-cut tail status — they still run but without the release path).
5. **Never route a failed `release-gate` to `phase3-gate`.** The whole-pipeline gate is a final-only checkpoint; using it as a recovery sink would re-pollute `state.gate_results`.

### 5.4 `release-finalize(cut_id)`

Responsibilities:

- Read `.mpl/mpl/releases/{cut_id}/gate-results.json`.
- Verify phase evidence, manifest evidence, Test Agent evidence where required, and cut-scoped gate results.
- Write `.mpl/mpl/releases/{cut_id}/release-manifest.json` and `evidence-summary.md`. Release manifest **MUST include the immutable snapshot identifiers** (see §5.4.1 below): `commit_sha`, `tree_sha`, and `snapshot_ref` (the git ref pinning this cut's state).
- Attempt optional user-visible artifact creation (`draft_pr`, `branch`, `tag`) only when requested by `artifact`. Artifact creation always operates against the **snapshot ref**, not the current working branch (§5.4.1).
- On artifact creation failure, write `artifact_creation_failed` with reason into the release manifest, surface it to the user, and continue to the next cohort.
- **Append `cut_id` to `state.release.completed_cut_ids`** when gate PASS + release-manifest write + snapshot ref creation all succeed. Artifact creation is a best-effort post-step and does NOT block append — a cut with `artifact_creation_failed` is still `completed` for the purpose of D-Q6 immutability, because the snapshot ref already pins the cut's state and the manifest is shipped. (Rationale: artifact creation depends on external tools — gh CLI, remote permissions — that are out of MPL's control. Tying immutability to artifact delivery would create stuck states where the user cannot recover.)
- Reset `state.release.fix_loop_count` to 0.
- Advance `state.release.current_cut_id` to the next eligible cut per §5.4.2, or to `null` if no further cuts remain.
- Never set `state.finalize_done=true`.
- Never transition `current_phase` to `completed`.
- Never run whole-goal closure.

### 5.4.1 Snapshot ref and artifact immutability

A delivered release artifact (PR / branch / tag) is an external claim. Once shipped, its commit/tree contents must not silently change when subsequent cohorts make new commits.

**Snapshot ref creation:** at the start of `release-finalize(cut_id)`, before any artifact-creation attempt:

1. Read `HEAD` of the working branch — this is the cut's terminal commit.
2. Create a **snapshot ref**: `refs/mpl/releases/{cut_id}` (a non-branch ref under `refs/mpl/`, invisible to normal branch listings but persistent and pushable).
3. Capture `commit_sha = rev-parse HEAD` and `tree_sha = rev-parse HEAD^{tree}`.
4. Record `snapshot_ref`, `commit_sha`, `tree_sha` in `release-manifest.json`.

**Artifact behavior:**

- `release_manifest` artifact: snapshot ref + manifest only, no external push/PR. Always succeeds.
- `tag`: push `refs/tags/mpl-release-{cut_id}` pointing at `snapshot_ref`. Immutable by git semantics.
- `branch`: push `mpl/release/{cut_id}` (a normal branch ref) pointing at `snapshot_ref`. Subsequent cohort commits go to the working branch, not this one — the release branch stays frozen at the snapshot.
- `draft_pr`: open a draft PR with **head = the release branch** (the frozen one), **base = `main`** (or repo default). The PR body links the snapshot ref and warns "do not push to this branch; further work happens on the working branch." Subsequent cohort commits do NOT update this PR.

**Working branch behavior:** the user's working branch (e.g., `docs/stage-a-mvp-rfc`) continues accumulating cohort commits as before. Release artifacts diverge from the working branch at the snapshot point and are never updated.

### 5.4.2 Extension cut activation and ordering

After `release-finalize(cut_id)` exits, the orchestrator selects the next `current_cut_id`:

1. **Source of truth: `release_cuts[]` array order.** The decomposer-emitted order, confirmed by planning-stage HITL (D-Q2), is the SSOT for cut sequencing.
2. **Filter: `user_approved == true`** AND **`id ∉ state.release.completed_cut_ids`**. Cuts with `user_approved: false` are skipped — their phases run as non-cut tail phases under normal `execution_tiers[]` scheduling, with no `release-gate`/`release-finalize` invocation.
3. **Pick the first eligible cut**, set `current_cut_id = cut.id`, route to `phase2-sprint`.
4. **No eligible cut remains** → `current_cut_id = null`. The next `phase2-sprint` entry runs non-cut tail phases (any phase not in any cut). On their completion, sprint transitions to whole-pipeline `phase3-gate`.

**Interleaving is disallowed in Stage A.** Even when two extension cuts have disjoint phase sets, they execute sequentially through the release path. Parallel cuts are Stage B (frontier scheduling) territory.

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

Line numbers below are accurate as of HEAD at the time of writing but may drift before Stage A lands; prefer the symbol references when navigating.

| Area | Change |
|---|---|
| `hooks/lib/mpl-state.mjs` | Add `release-gate` and `release-finalize` to the `VALID_PHASES` Set. Add `release` subtree default to state init (`current_cut_id: null`, `completed_cut_ids: []`, `pending_artifact: null`, `fix_loop_count: 0`). |
| `docs/schemas/state.md` | Document new lifecycle markers and `state.release` subtree. No migration version bump required because fields are additive. Update the VALID_PHASES enum doc, lifecycle diagram, and phase-controller tests. (HUD/status renderer updates are tracked in §11 Out-of-Scope.) |
| `hooks/mpl-phase-controller.mjs` | (1) Add `case 'release-gate'` and `case 'release-finalize'` switch branches in the same style as the existing `small-sprint` / `small-verify` cases. (2) Modify the `phase2-sprint` completion check (the branch that today transitions to `phase3-gate` when remaining-TODO count drops to 0): read `state.release.current_cut_id`; if non-null, filter PLAN.md TODOs to the active cohort's phase set (`mvp.phases` or the matching `release_cuts[].phases`); on cohort complete, route to `release-gate`, not `phase3-gate`. Whole-pipeline `phase3-gate` is entered only when all cohorts are complete and `state.release.current_cut_id` is `null`. (3) **Owns `state.release.current_cut_id` lifecycle:** sets it to `"mvp"` on the `mpl-decompose → phase2-sprint` transition when `mvp_scope` is declared; advances or clears it on `release-finalize` exit per §5.4.2. |
| **NEW: small-pipeline guard** in `mpl-phase-controller.mjs` (D-Q7) | At the small-pipeline entry (before the `case 'small-plan'` branch), block entry when `goal_contract.mvp_scope` is present. Surface a hard block message — "MVP cut path must be used; small-pipeline not available with `mvp_scope`." Do not silently downgrade. |
| `hooks/lib/mpl-phase-contract-graph.mjs` | Extend the existing decomposition validator (currently covers phase ids, execution_tiers membership, dangling refs). Add validators for: (a) `mvp.phases[]` and `release_cuts[].phases[]` are subsets of `phases[]`, (b) no cross-cut phase overlap, (c) MVP `goal_trace` union covers every `mvp_scope` AC/AX id, (d) the **dependency-closure rule** in §4.2 (no forward or upward `requires`), (e) the **release-immutability rule** (D-Q6) — blocks any decomposition write that mutates `mvp.phases` or `release_cuts[id].phases` when the cut id is in `state.release.completed_cut_ids`, and rejects duplicate appends to `completed_cut_ids`. |
| `hooks/mpl-require-phase-contract-graph.mjs` | Update the require-hook wrapper to invoke the new lib validators added above. Validators live in `hooks/lib/mpl-phase-contract-graph.mjs`; the require hook is the entry point that calls them from the PostToolUse event. |
| `hooks/lib/mpl-goal-contract.mjs` | Parse and validate optional `mvp_scope`. Reject unknown AC/AX ids, unsupported `artifact` values, and `acceptance_criteria`/`variation_axes` not appearing in the contract. |
| **NEW: `hooks/mpl-require-export-manifest.mjs`** (D-Q5) | New hook. Blocks phase-completion state writes (`state-summary.md`, `current_phase` transition) when a code-bearing phase lacks `.mpl/mpl/phases/{phase_id}/export-manifest.json`. Code-bearing detection: any phase with non-empty `impact.create ∪ impact.modify`. **Activation is gated on `goal_contract.mvp_scope` presence (B4)** — projects without `mvp_scope` continue under SNT-S1 warn-only. |
| `hooks/mpl-sentinel-s1.mjs` | **No behavior change.** Continues content-only validation (declared symbols exist in actual files). Presence enforcement moved to `mpl-require-export-manifest.mjs`. |
| `agents/mpl-phase-runner.md` | Output schema: add `export_manifest` evidence token to `evidence_latch[]` for code-bearing phases. Update the `Output_Schema` example accordingly. |
| `agents/mpl-decomposer.md` | Extend Rule 9 ("completed phase block immutability"): in addition to keeping completed phase blocks intact, recompose MUST treat `mvp.phases` and `release_cuts[id].phases` as immutable when the cut id is in `state.release.completed_cut_ids`. New phases go to a new cut or to non-cut tail. |
| `hooks/mpl-require-whole-goal-closure.mjs` | **No semantic change.** Verified to inspect only `finalize_done=true` writes plus goal_trace coverage. Release path never triggers it (release-finalize never sets `finalize_done`). |

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

### D-Q5 - `export-manifest.json` enforcement location

**Decision:** new dedicated hook `hooks/mpl-require-export-manifest.mjs`. Do not extend SNT-S1.

- New hook performs **presence + minimal structural validity** check at phase exit. Blocks `state-summary.md` write / completed phase state transition when a code-bearing phase lacks the manifest.
- `mpl-sentinel-s1.mjs` stays focused on **content validity** (declared symbols exist in actual files); its scope and behavior are unchanged.
- Phase Runner output schema lists `export_manifest` as a required evidence token for code-bearing phases (added to evidence_latch alongside `command`, `test_agent`, `goal_trace`).

**Rejected alternative:** extend SNT-S1 to block on missing manifest. Mixes two concerns (presence vs content) in one hook; harder to reason about and to deactivate selectively.

**Rationale:** single-responsibility hooks compose better. New file cost is one ~80-line .mjs; benefit is clean separation of "manifest exists" from "manifest is correct."

### D-Q6 - RECOMPOSE-MODE / APPEND-MODE vs released cut immutability

**Decision:** **released cut phase membership is immutable.** Once `release-finalize(cut_id)` has shipped a release artifact, the corresponding `mvp.phases` or `release_cuts[id].phases` MUST NOT be modified by any subsequent RECOMPOSE-MODE or APPEND-MODE invocation.

- New phases introduced by recompose go to a **new** release cut, or to non-cut tail phases (extension work outside any cut).
- Decomposer rule 9 (`agents/mpl-decomposer.md:39`) is extended: in addition to keeping completed phase blocks byte-for-byte intact, recompose MUST treat `mvp.phases` and `release_cuts[id].phases` as immutable when `state.release.completed_cut_ids` contains the cut id.
- A new validation hook (or extension of `mpl-phase-contract-graph.mjs`) blocks any decomposition write that mutates a released cut's phase membership.

**Rejected alternatives:**
- *Append-only* — released `release-manifest.json` already lists the phase set; appending makes the shipped artifact a moving target.
- *User override via HITL* — opens a foot-gun that could only ever be a mistake post-release.

**Rationale:** the release artifact is an externalized claim. Modifying its underlying phase set after delivery breaks the artifact's truthfulness. Append work belongs in a new cut.

### D-Q7 - small-pipeline mode ↔ `mvp_scope` coexistence

**Decision:** **mutually exclusive.** When `goal_contract.mvp_scope` is present, the orchestrator MUST NOT enter `small-plan` / `small-sprint` / `small-verify`. Conversely, when small-pipeline is active, `mvp_scope` is treated as if absent.

- Router guard at the small-pipeline entry point (`hooks/mpl-phase-controller.mjs` around line 556, before `case 'small-plan'`): if `mvp_scope` is declared, refuse small-pipeline entry and surface "MVP cut path must be used; small-pipeline not available with mvp_scope."
- Pipeline selection precedence: explicit `mvp_scope` declaration → full MPL pipeline with release path. No declaration → existing behavior (small or full chosen by current heuristics).

**Rejected alternatives:**
- *small-pipeline as degenerate single-cut MVP* — conceptually conflates two different operating modes (whole-task-is-small vs subset-of-large-task-shippable-first); doubles state machine complexity for marginal gain.
- *User interview choice at runtime* — adds a new HITL decision surface; conflicts with the principle that planning-stage HITL is already where mode is determined.

**Rationale:** the two modes answer different questions. Small-pipeline = "the whole task is small, run a lightweight pipeline." MVP cut = "the task is large, ship a subset first." Conflating them would force every downstream hook to handle both shapes. Mutual exclusion at the router is the cheapest correct policy.

---

## 11. Out-of-Scope Follow-ups

These belong to Stage B or later:

- `mvp.execution_mode: contract_skeleton`.
- Skeleton phase + 1-pass reconcile + fail-and-surface.
- Continuous contract diff at every phase exit.
- Dependent-subtree blocking for extension waves.
- Frontier-aware worker pool sizing.
- `module_groups[]`.
- **Hard 1 caching/incrementalization across release-gates.** With many extension cuts, Stage A repeats the full-project Hard 1 build per `release-gate(cut_id)`. Acknowledged cost; deferred to Stage B if release-path telemetry shows Hard 1 dominates wall time.
- **Import-graph derivation for Hard 2 affected scope.** Stage A only consumes the decomposer-declared `impact.affected_tests[]` (with fallback to `.mpl/config.json` `test_command`). Mechanical import-graph derivation is language-dependent (JS/TS, Python, Rust each have different toolchains) and is deferred until the simpler scoping proves insufficient.
- **`/mpl:mpl-status` rendering for new release states.** `skills/mpl-status/SKILL.md` has phase-specific rendering branches; adding `release-gate` / `release-finalize` renderers (active cut id, scoped gate progress) is a follow-up after Stage A core lands.
- **Parallel extension cut interleaving.** Even when two cuts have disjoint phase sets, Stage A serializes them through the release path. Parallel cuts join the Stage B frontier scheduling agenda.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| `mvp.phases` becomes ambiguous when one phase advances multiple AC/AX ids partially in MVP | Decomposer treats phase as binary: in MVP or not. Partial-coverage phases are pulled fully into MVP and surfaced during decomposition review. |
| Release-time partial gates miss a regression that full Hard 2 would catch | Final `phase3-gate` still runs full pipeline verification. Release-time tests are fast feedback, not replacement. |
| Users skip declaring `mvp_scope`, defeating the feature | Interview prompts explicitly. If user says everything is MVP, store all AC/AX ids. If user declines, omit `mvp_scope` and keep current behavior. |
| Hook drift between release and pipeline finalization | Keep semantic flows separate. Share only lower-level helpers such as `run_gate_commands(scope)` and `write_evidence_summary(scope)`. |
| Release gate evidence pollutes final gate evidence | Store release gate results under `.mpl/mpl/releases/{cut_id}/`; do not write to `state.gate_results`. |
| RECOMPOSE-MODE mutates a released cut's phase membership, invalidating shipped release manifest (D-Q6) | Extend `mpl-phase-contract-graph.mjs` to block decomposition writes that mutate `mvp.phases` / `release_cuts[id].phases` when `state.release.completed_cut_ids` contains the cut id. Update `agents/mpl-decomposer.md` rule 9 to forbid the operation. |
| Small-pipeline mode silently bypasses MVP cut when `mvp_scope` is declared (D-Q7) | Router guard in `mpl-phase-controller.mjs` at small-pipeline entry rejects entry when `mvp_scope` is present; surfaces explicit "use MVP cut path" message rather than silent fall-through. |
| Missing `export-manifest.json` slips through SNT-S1 (warn-only today) and lands at final `phase3-gate`, far from root cause (D-Q5) | New `mpl-require-export-manifest.mjs` blocks phase completion at the source. SNT-S1 retains content validation separately for clean diagnostics. |
| `state.release.current_cut_id` becomes stale (set, but never cleared after a fault path) | Defined lifecycle (§4.5): cleared at every `release-finalize` exit; never re-entered for the same cut id. Add lifecycle assertion to `release-finalize` handler so a stale cut id is detected on entry. |
