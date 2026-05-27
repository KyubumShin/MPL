# Stage A — Phase 1.6c Resume Brief

**Date:** 2026-05-24
**Status:** Pre-implementation. Branch staged, no commits yet beyond this doc.
**Branch:** `impl/stage-a-release-gate-scoped-gates`
**Base:** `main` @ `6275fd4` (immediately after PR #185 merge)
**Source RFC:** `docs/roadmap/stage-a-mvp-cuts-rfc.md`
**Analysis doc:** `docs/roadmap/parallelism-mvp-analysis.md`

This brief is **self-contained**. A new session should be able to checkout the branch, read this file, and pick up implementation without re-reading the prior 9-PR session's context.

---

## 1. Stage A Cumulative Progress (9 PRs merged into `main`)

| # | PR | Phase | Commit | One-line summary |
|---|---|---|---|---|
| #177 | RFC | — | `da62b06` | Stage A MVP/release-cuts analysis + RFC |
| #178 | 1.1 mvp_scope parser | goal-contract layer | `0ce39c4` | parser + validator + `MVP_SCOPE_ARTIFACTS` constant |
| #179 | 1.5 Rule 9 immutability | decomposer prompt | `d71fba6` | recompose treats released cut's phases as immutable |
| #180 | 1.4a schema validators | hook (lib + tests) | `d53c1f0` | mvp + release_cuts schema integrity + cross-cut overlap |
| #181 | 1.3 interview checklist | phase0 protocol | `d1576c5` | Stage 1.4.5 guided AC/AX checklist + opt-out |
| #182 | 1.2 decomposer derivation | decomposer prompt | `29fa769` | Step 12 mechanical mvp.phases from mvp_scope (no inference) |
| #183 | 1.4b dep-closure + D-Q6 | hook + require + tests | `7e35a3c` | dependency-closure rule + released-cut immutability hook |
| #184 | 1.6a state.release + D-Q7 | state schema + guard | `04827f3` | `state.release` subtree + v4→v5 migration + small-pipeline guard |
| #185 | 1.6b release-path handlers | orchestrator + tests | `6275fd4` | release-gate / release-finalize handlers + cohort-aware sprint routing |

**End-to-end Stage A flow (single-cohort, mvp-only) is now wired and tested.** Test suite at `main`: **974/974 hook tests pass**.

What works today on `main`:
1. User opts into MVP via the Stage 1.4.5 guided checklist (#181)
2. Goal-contract parser stores `mvp_scope` (#178)
3. Decomposition post-processing derives `mvp.phases` via mechanical id-set mapping (#182, Phase 5 moved it out of the LLM output path)
4. Contract-graph validator + hook reject malformed mvp/release_cuts and mutated released cuts (#180, #183)
5. Orchestrator routes phase2-sprint → release-gate (cohort active) or phase3-gate (no cohort) (#185)
6. release-finalize appends cohort to `completed_cut_ids`, clears `current_cut_id`, routes to phase3-gate (#185)

What does **not** yet exist:
- release-gate currently passes through unconditionally — no scoped Hard 1/2/3 execution
- release-finalize currently writes no release-manifest, creates no snapshot ref, no git/GitHub artifact
- Therefore `completed_cut_ids` fills purely from the stub flow; D-Q6 immutability hook is active but exercised only by the test fixture

---

## 2. Phase 1.6c — Goals (one-line)

Make release-gate actually gate, and release-finalize actually finalize.

After 1.6c, a single-cohort Stage A run for a project that declared `mvp_scope` will:
- Run scoped Hard 1 (full project) + Hard 2 (affected) + Hard 3 (cut interface_contract) at release-gate
- Block transition to release-finalize on any failure; mirror phase3-gate→phase4-fix loop
- Write `.mpl/mpl/releases/mvp/release-manifest.json` + `evidence-summary.md` + `gate-results.json`
- Create the requested user-visible artifact (draft_pr | branch | tag | release_manifest) with graceful fallback on failure
- D-Q6 immutability hook (PR #183) automatically activates against the populated `completed_cut_ids`

---

## 3. Recommended Sub-split — 1.6c-i / 1.6c-ii / 1.6c-iii

The three sub-phases touch independent surfaces. Splitting them keeps each PR review-friendly.

### 1.6c-i — release-gate scoped Hard 1/2/3 evidence routing

**Scope:** wire release-gate to *consume* release-scoped gate evidence and route on it. Evidence *production* (running scoped commands and writing the json) is mpl-gate-recorder's job and lives outside this PR.

**Files:**
- `hooks/lib/mpl-state.mjs` — add `state.release.gate_results` (similar shape to top-level `gate_results`); bump `CURRENT_SCHEMA_VERSION` 5 → 6 + add `hooks/lib/migrations/v5-to-v6.mjs` (additive backfill). This matches the pattern PR #184 established for `state.release` and codex flagged on PR #184.
- `hooks/mpl-phase-controller.mjs` `case 'release-gate'`:
  - Read `state.release.gate_results` (or fall back to checking `.mpl/mpl/releases/{cut_id}/gate-results.json` on disk — pick **one** SSOT; recommend the in-state field for consistency with phase3-gate's pattern).
  - **PASS** (all 3 hard gates structured-PASS) → transition to release-finalize.
  - **FAIL** (any hard gate structured-FAIL) → increment `state.release.fix_loop_count`, transition back to `phase2-sprint`, **PRESERVE** `state.release.current_cut_id`. On `fix_loop_count >= max_fix_loops` (config-driven, default 3), circuit-break: pin `current_cut_id` and surface a user-actionable message; do NOT transition (RFC §5.3.1).
  - **MISSING** → continue + `stopReason` "[MPL] release-gate(cut_id): awaiting scoped Hard 1/2/3 evidence. Run scoped commands; mpl-gate-recorder will populate state.release.gate_results."
- `hooks/__tests__/mpl-phase-controller.test.mjs` — tests for PASS / FAIL / MISSING / circuit-break paths.

**Invariant**: release-gate evidence MUST NOT touch `state.gate_results.hard{1,2,3}_*` (those are reserved for whole-pipeline phase3-gate per RFC §5.5). Use a parallel `state.release.gate_results` subtree.

**Gate scope decisions (already pinned in RFC §5.3 / §10 D-Q3):**
- Hard 1 (build/lint/type): full project scope.
- Hard 2 (tests): `impact.affected_tests[]` from cut phases; fallback to `.mpl/config.json` `test_command`; write `hard2_fallback: full_project` with reason if used (silent fallback FORBIDDEN).
- Hard 3 (contracts): cut scope — declared `interface_contract.produces` for phases in `state.release.current_cut_id`.

### 1.6c-ii — release-finalize manifest write + evidence-summary

**Scope:** when release-gate passes (cohort moves to release-finalize), write the release-scoped artifacts before clearing `current_cut_id`.

**Files:**
- `hooks/mpl-phase-controller.mjs` `case 'release-finalize'`:
  - After completing the existing append+clear logic, write:
    - `.mpl/mpl/releases/{cut_id}/release-manifest.json` — contains: `cut_id`, `phases[]`, `goal_trace.acceptance_criteria/variation_axes`, `commit_sha`, `tree_sha`, `snapshot_ref` (placeholder until 1.6c-iii), `gate-results-summary`, `created_at`, `artifact` (from mvp/release_cut.artifact)
    - `.mpl/mpl/releases/{cut_id}/evidence-summary.md` — human-readable summary of phase evidence + test-agent dispatches + goal_trace coverage
    - `.mpl/mpl/releases/{cut_id}/gate-results.json` — copy of `state.release.gate_results` for archival
- New library `hooks/lib/mpl-release-manifest.mjs` for serialization (testable in isolation).
- `hooks/__tests__/mpl-release-manifest.test.mjs` — unit tests.
- `hooks/__tests__/mpl-phase-controller.test.mjs` — integration test: release-finalize writes all 3 files with correct content.

**Invariant**: release-finalize MUST NOT set `state.finalize_done=true` and MUST NOT transition `current_phase` to `completed`. Both remain exclusive to phase5-finalize (RFC §5.5). The PR #185 implementation already honors this; preserve it.

### 1.6c-iii — Snapshot ref + git/GitHub artifact creation (RFC §5.4.1)

**Scope:** the optional, externally-visible artifact. This is the highest-risk sub-PR (touches git refs and gh CLI).

**Files:**
- New `hooks/lib/mpl-release-artifact.mjs` — pure helpers for snapshot ref creation, draft_pr / branch / tag invocation, graceful failure handling.
- `hooks/mpl-phase-controller.mjs` `case 'release-finalize'`:
  - After manifest write (1.6c-ii), if `mvp.artifact` / `release_cut.artifact` is one of `draft_pr | branch | tag`, attempt the corresponding action.
  - On failure: write `artifact_creation_failed` with reason into `release-manifest.json` and surface to user. Continue the lifecycle exit (do NOT block).
  - `release_manifest` artifact = no-op here (already covered in 1.6c-ii).
- Snapshot ref: `refs/mpl/releases/{cut_id}` via `git update-ref` (pure git, no remote required for the ref itself).
- Tag: `git tag mpl-release-{cut_id} {commit_sha}` + `git push origin refs/tags/...` if remote configured.
- Branch: `git branch mpl/release/{cut_id} {commit_sha}` + push.
- draft_pr: `gh pr create --draft --base main --head mpl/release/{cut_id}` (requires branch already pushed).

**Critical safety**: every git/gh invocation must be wrapped to never leave the working tree in a partial state. If `git push` fails, the local ref is preserved; user can retry manually.

**Tests**: integration tests with a temporary git repo + mocked gh CLI. See `hooks/__tests__/mpl-phase-controller.test.mjs` `runStopHook` pattern.

---

## 4. Invariants — Do Not Violate

The 9 prior PRs locked down these invariants. Subsequent PRs MUST preserve them:

1. **D-Q6 released-cut immutability**: `completed_cut_ids` is the SSOT for "released" status. Once a cut id is appended, recompose cannot mutate that cut's `phases`. The hook (`hooks/mpl-require-phase-contract-graph.mjs`) enforces this from PR #183. Adding entries here is one-way; never remove from `completed_cut_ids`.

2. **RFC §4.5 lifecycle — never re-enter same cut_id**: phase2-sprint init guard checks `completed_cut_ids.includes('mvp')` before re-setting `current_cut_id`. Do not loosen.

3. **RFC §5.5 whole-pipeline isolation**:
   - release-gate / release-finalize MUST NOT set `state.finalize_done=true`.
   - release-gate evidence MUST NOT write `state.gate_results.hard{1,2,3}_*` (reserved for final phase3-gate).
   - Use `state.release.gate_results` as the parallel release-scoped subtree.
   - phase3-gate has a defensive guard (PR #185) that reverts to phase2-sprint when an active cohort exists; preserve.

4. **RFC §5.3.1 fix loop scope**: `state.release.fix_loop_count` is separate from top-level `fix_loop_count` (which stays for phase3-gate→phase4-fix). Do not unify.

5. **Stage A single-cohort scope**: decomposer emits `release_cuts: []` (PR #182 per RFC §10 D-Q2). Multi-cohort cut chaining is Stage B. Do not auto-propose extension cuts.

6. **Failed-cohort guard**: sprint with `cohort && failed > 0` stays in phase2-sprint (PR #185 round-2 fix). Routing to phase3-gate would let existing all-PASS gate evidence skip release-finalize.

7. **D-Q7 small-pipeline mutual exclusion**: when `goal_contract.mvp_scope` is present, small-plan entry is blocked (PR #184). Preserve.

---

## 5. Key File Pointers (current `main`)

| Path | Role |
|---|---|
| `docs/roadmap/stage-a-mvp-cuts-rfc.md` | Source of truth for all Stage A decisions (D-Q1..D-Q7, §5.3.1 failure path, §5.4.1 snapshot, §5.4.2 cut activation) |
| `hooks/lib/mpl-state.mjs` | `state.release` subtree + CURRENT_SCHEMA_VERSION=5 (bump to 6 for 1.6c-i) |
| `hooks/lib/migrations/v4-to-v5.mjs` | Reference for migration shape; add `v5-to-v6.mjs` similarly |
| `hooks/lib/mpl-goal-contract.mjs` | mvp_scope parser; exports MVP_SCOPE_ARTIFACTS |
| `hooks/lib/mpl-phase-contract-graph.mjs` | mvp/release_cuts validators + dep-closure + ALLOWED_RELEASE_ARTIFACTS (re-exports MVP_SCOPE_ARTIFACTS) |
| `hooks/mpl-require-phase-contract-graph.mjs` | D-Q6 immutability hook + SHAPE COMMITMENT block for `completed_cut_ids: string[]` |
| `hooks/mpl-phase-controller.mjs` | release-gate / release-finalize handlers (stubs today); add evidence read in 1.6c-i, manifest write in 1.6c-ii, artifact creation in 1.6c-iii |
| `hooks/mpl-gate-recorder.mjs` | Where scoped gate evidence WRITER would live (1.6c-i companion — likely needs a parallel branch for release-scoped recording) |
| `agents/mpl-decomposer.md` | Rule 9 immutability + Step 12 mvp derivation + `release_cuts: []` Stage A emit |
| `commands/mpl-run-phase0.md` | Stage 1.4.5 MVP scope checklist |

---

## 6. Next Session Quickstart

```bash
# Sync local main
git fetch origin
git checkout main
git reset --hard origin/main

# Resume on the staged 1.6c branch
git checkout impl/stage-a-release-gate-scoped-gates

# Read this brief
cat docs/roadmap/stage-a-resume-1.6c.md

# Start with 1.6c-i (smallest, most reusable)
# Edits go in:
#   hooks/lib/mpl-state.mjs                 (CURRENT_SCHEMA_VERSION bump + state.release.gate_results default)
#   hooks/lib/migrations/v5-to-v6.mjs       (new file, follows v4-to-v5 template)
#   hooks/lib/migrations/index.mjs          (register v5ToV6)
#   hooks/mpl-phase-controller.mjs          (case 'release-gate' read+route logic)
#   hooks/__tests__/mpl-state.test.mjs      (migration backfill test)
#   hooks/__tests__/mpl-phase-controller.test.mjs (PASS / FAIL / MISSING / circuit-break)

# After 1.6c-i lands, repeat workflow for 1.6c-ii and 1.6c-iii.
```

---

## 7. Open Questions to Settle Early in 1.6c-i

These were not closed in the prior 9 PRs and will surface when actual evidence routing lands:

1. **Single SSOT for release-scoped gate evidence**: `state.release.gate_results` (state.json) **or** `.mpl/mpl/releases/{cut_id}/gate-results.json` (file)? Recommend state.json for read-side parity with `state.gate_results`, write-side parity at file in 1.6c-ii. **Decide before authoring 1.6c-i**.

2. **mpl-gate-recorder release-scope routing**: which mechanism tells the recorder "this Bash command's exit code goes into release-scoped evidence, not whole-pipeline"? Options:
   - (a) recorder inspects `state.release.current_cut_id` and dual-writes if non-null
   - (b) caller decorates commands with a marker
   - (c) recorder only routes to release-scoped when `current_phase == 'release-gate'`
   Recommend (c) as the simplest; document in 1.6c-i PR body.

3. **`max_fix_loops` for release-scoped fix loop**: reuse top-level `state.max_fix_loops` (10) or add `state.release.max_fix_loops` (RFC §5.3.1 suggested 3)? Recommend separate field with default 3; bump to schema v6 alongside `gate_results`.

4. **Hard 2 affected-tests resolution**: who computes the affected set from `impact.affected_tests[]`? Probably the orchestrator / mpl-gate-recorder, NOT the phase-controller. 1.6c-i may need a small helper `hooks/lib/mpl-release-affected.mjs` to expose the logic.

Defer these to in-PR discussion; do not block this resume brief on them.

---

## 8. Risk Note for the New Session

This branch is staged but has no commits yet. The new session can:
- Either commit this resume brief and use the branch as a 1.6c container (then push to remote for visibility)
- Or treat the brief as ephemeral context and start 1.6c-i in a fresh branch

Recommend: commit this brief on `impl/stage-a-release-gate-scoped-gates` as the first commit, push, and use the branch for 1.6c-i. Subsequent sub-phases (1.6c-ii, 1.6c-iii) get their own branches off `main` after 1.6c-i merges.
