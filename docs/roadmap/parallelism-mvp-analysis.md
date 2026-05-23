# MPL Pipeline: Parallelism & Time-to-MVP Analysis

**Date:** 2026-05-23
**Status:** Analysis / Pre-RFC
**Scope:** Diagnose two felt pain points (low parallelism, slow time-to-MVP), evaluate four proposed structural improvements, and record a review rebaseline for a safer implementation path.

---

## 0. TL;DR

Both complaints are **factually confirmed**. The pipeline already has the right primitives (typed `interface_contract`, `execution_tiers`, parallel exec mode, TODO-level concurrency), but defaults are conservative and **all hard gates run after every phase completes**, so no partial artifact is ever user-visible.

Initial conclusion, refined after codebase review and two follow-up rebaselines:

- **Stage A (low cost, high impact):** introduce a **user-declared `mvp`** as a first-class concept (separate from cuts), add the release path `release-gate(cut_id) → release-finalize(cut_id)` as two new states (scoped Hard 1/2/3 + release manifest), make code-bearing `export-manifest.json` mandatory (block from Stage A), and split gates by a resource-aware DAG rather than a blind Hard 1/2/3 fan-out. MVP executes **sequentially** in Stage A — safety first. `phase3-gate` and `phase5-finalize` retain whole-pipeline semantics.
- **Stage B (structural):** add a `contract_skeleton` execution mode for MVP that runs phases in parallel after a skeleton phase freezes the contract surface, with **1-pass reconcile + fixup queue**. Also add frontier-aware extension scheduling and continuous contract diff. Module grouping deferred to Stage C unless cuts prove insufficient.

**Review rebaseline (2026-05-23):** the original direction is right, but several proposed implementation details should change before RFC:

- Do not add `tier: mvp | extension` on phases; `execution_tiers[].tier` already uses `tier` as a numeric scheduler field.
- Do not base MVP/extension routing on `pp_proximity`; v0.17 removed PP-proximity routing. MVP scope must be **user-declared** at interview time via a new `mvp_scope` field on Goal Contract; decomposer maps it to phases but never infers it.
- **MVP and release_cut are different first-class concepts**, not the same primitive. MVP = user-declared, exactly one, must-ship-first, declarative. Release cut = decomposer-proposed, 0..N, delivery grouping, advisory. Treating MVP as a cut conflates two different epistemics.
- Do not replace file-overlap blocking with symbol-overlap as the first step. Same-file parallel edits are still high-risk under worktree merge.
- Treat `export-manifest.json` as a missing mandatory contract today: S1 validates it when present, but Phase Runner output does not currently require it.
- MVP parallel execution is **opt-in, Stage B only**, requires a contract-skeleton phase + 1-pass reconcile + file-overlap guardrails. Reconcile failure does NOT deliver a partial MVP cut; it queues fixup phases and surfaces to the user.
- Do not reuse `phase5-finalize` for MVP/cut checkpoints. Add a separate release path `release-gate(cut_id) → release-finalize(cut_id)` (two states) for partial release checkpoints. `phase3-gate` and `phase5-finalize` retain their whole-pipeline semantics — they are not shrunk, repeated, or called from the release path.

---

## 1. Confirmed Pain Points

### 1.1 Low parallelism — CONFIRMED

| Layer | Status | Note |
|---|---|---|
| Phase-level parallel | Available but conservatively gated | Executor consumes `execution_tiers[]`, but parallel tiers still require no file overlap, no resource-lock overlap, and dependency-frontier safety. |
| Worker pool | Max 2 default, hard cap 3 | Conservative; modern dev machine may tolerate more, but UI/tooling stability was the reason for the cap. |
| TODO-level concurrency | Active (max 3) | Works **within** a phase only; no cross-phase. |
| Test Agent pipelining | Feature-flagged | `config.test_wait.pipelining_enabled` can pipeline behind dependency frontiers, but default adoption is conservative. |

**Root cause:** parallelism opportunities are gated on coarse file/resource conflict checks. That is safe, but it leaves throughput on the table. The first fix should improve frontier scheduling and observability before relaxing same-file conflict rules.

### 1.2 Slow to MVP — CONFIRMED

**Pre-execution (sequential, blocks first line of code):**

| Stage | Source | Est. duration |
|---|---|---|
| Interview / PP discovery | `commands/mpl-run-phase0.md` | 30–60 min |
| Ambiguity resolution | `commands/mpl-run-phase0.md` | 10–20 min |
| Codebase analysis | `commands/mpl-run-phase0-analysis.md` | 20–40 min |
| Decomposition | `commands/mpl-run-decompose.md` | 20–40 min |
| **Total** | — | **80–160 min before any code** |

**Execution gates (block all visibility until full pass):**

`Hard 1` (build/lint/type) -> `Hard 2` (tests + regression + invariants) -> `Hard 3` (contract verification). All three run **after all phases complete**. Floor is mandatory and not lowered by PP-proximity.

**Reference baseline (5-phase, 45 min/phase):**

| Mode | Wall time | Notes |
|---|---|---|
| Sequential | ~425 min | Pre-exec 100m + 5x45m + gates 20m |
| Parallel, if tiers are usable | ~265 min | Potentially faster, but actual gain depends on gates, retries, Test Agent, and merge reconciliation. |

**Critical property:** there is **no first-class partial feature visibility**. Either the whole pipeline passes Hard 3, or the user sees only informal intermediate artifacts.

---

## 2. Existing Primitives (do not rebuild these)

- `interface_contract.requires/produces/contract_files` per phase (v0.13.0, AD-01) — required schema field.
- `phase-seed.yaml` — formal seed contract.
- `state-summary.md`, `verification.md` — mandatory phase exit artifacts.
- `export-manifest.json` — SNT-S1 validates it when present, but it is not yet required by `agents/mpl-phase-runner.md` output schema. Making it mandatory is prerequisite work for manifest-driven scheduling.
- `execution_tiers[]` with `parallel: true/false` — decomposer output and executor scheduler contract.
- Worktree pool for parallel phase execution.
- `resource_locks` — phase/TODO mutex vocabulary for `package_manager`, `dev_server`, `db_migration`, etc.

The architecture **can** express modularity and parallelism. The gap is in **delivery boundaries**, **manifest guarantees**, **conflict-detection granularity**, and **gate placement**.

---

## 3. Evaluation of Proposed Improvements

### Proposal 1 — Pipeline modularization (always extensible)

**Status:** partially present.

**Gap:** no concept of a shippable subset. Today all phases are flat from the user's delivery perspective; "ship this subset first" is not expressible.

**Review adjustment:** do not start with `module_groups[]`. Add two smaller, complementary primitives instead:

1. `mvp` — a single, user-declared, must-ship-first subset. First-class top-level field on `decomposition.yaml`, derived from a new `mvp_scope` field on `goal-contract.yaml`.
2. `release_cuts[]` — zero or more decomposer-proposed extension delivery groups, advisory.

`mvp` and cuts are different concepts (declared vs inferred, must-ship vs convenience, exactly-1 vs N). Treating MVP as a cut conflates these. Module groups remain a Stage C option if cuts cannot express extension delivery.

**Action:** add `mvp` (single object) and `release_cuts[]` (array) above `phases[]`. Keep `execution_tiers[]` as the scheduler contract.

### Proposal 2 — Parallel per-module development with recorded in-out

**Status:** schema exists; scheduling is conservative.

**Gaps:**

- `export-manifest.json` is validated by SNT-S1 when present, but Phase Runner output does not currently require it. The protocol references it as a channel, not as a guaranteed phase artifact.
- Wave conflict detection uses raw file/resource overlap. That is coarse, but safer than symbol-only conflict detection.

**Actions:**

- Require code-bearing phases to emit `export-manifest.json` before phase completion is counted.
- Keep same-file write overlap blocked in Stage A. Only loosen this later for append-only files or machine-proven non-overlapping AST ranges.
- Use manifests/contracts for dependency frontier decisions, not as a blanket permission to merge same-file parallel edits.

### Proposal 3 — Use in-out records to reconcile mismatches in later verification

**Status:** verification is too late (Hard 3 only).

**Gap:** contract mismatches surface only after all phases are done, so the fix loop often has to retest too much.

**Action (Stage B only — not Stage A):** run a cheap contract diff (`export-manifest` vs declared contract) at every phase exit. Split reconcile policy by execution context:

- **MVP cohort under `contract_skeleton` mode (Stage B):** **1-pass reconcile** only. Mismatches enqueue fixup phases; the reconcile loop does NOT retry beyond one pass — this prevents cascade divergence that would make MVP slower than sequential. MVP cut does not deliver if reconcile leaves unresolved mismatches.
- **Extension waves (Stage B):** mismatch blocks only the dependent subtree that consumes the broken contract; unrelated frontier branches continue.

Whole-pipeline `phase3-gate` (Hard 1/2/3) stays as the final integration check after all phases complete and should rarely find new contract gaps. Stage A does not introduce continuous contract diff; it only runs scoped Hard 1/2/3 inside `release-gate(cut_id)`.

### Proposal 4 — MVP-first, then per-module parallel extension

**Status:** not expressible today; all phases carry equal delivery weight.

**Gap:** PP-proximity tag is no longer a reliable routing input. v0.17 removed PP-proximity state routing; new decompositions may set it uniformly. Additionally, letting decomposer **infer** MVP scope risks repeating the same epistemic mistake v0.17 corrected. MVP scope must be a **user declaration**, not a system inference.

**Action (split by execution layer):**

**Layer 1 — MVP scope (Stage A):**

- Interview adds one new question: "What is the smallest must-ship subset for this work? (AC/AX ids)" Response stored as `mvp_scope` on `.mpl/goal-contract.yaml`.
- Decomposer reads `mvp_scope` and derives top-level `mvp` (single object) on `decomposition.yaml`. Decomposer does NOT infer MVP scope — it maps user declaration to phases.
- `release_cuts[]` is a separate, optional, decomposer-proposed array for extension delivery grouping.
- MVP phases run first → `release-gate(mvp)` (scoped Hard 1/2/3) → `release-finalize(mvp)` (manifest + optional artifact) → **MVP cut**: user-visible artifact handed off.
- Extension phases then run through existing `execution_tiers[]` and frontier scheduling; each approved extension cut runs the same `release-gate(cut-id)` → `release-finalize(cut-id)` pair after its cohort completes.
- After all cohorts complete, whole-pipeline `phase3-gate` (full Hard 1/2/3) still runs as the regression safety net, then `phase5-finalize` performs whole-goal closure (sets `finalize_done=true`).
- **Sprint completion must be cohort-aware** (RFC §5.2): `phase2-sprint` checks completion against the active cohort (`mvp.phases` or active cut's phases) rather than all phases, so MVP completion routes to `release-gate(mvp)` instead of `phase3-gate`.

**Layer 2 — MVP execution mode (Stage B, opt-in):**

- `mvp.execution_mode` field: `sequential` (default, Stage A) or `contract_skeleton` (Stage B opt-in).
- `contract_skeleton` mode: first phase in MVP is a skeleton phase (`kind: skeleton`) that freezes `interface_contract.produces` for the entire MVP cohort (types, signatures, file layout). Subsequent MVP phases run in parallel worktrees against the frozen skeleton, under the existing same-file conflict rules.
- Termination: 1-pass contract reconcile → if clean, MVP cut delivers; if mismatch, fixup phases queued and MVP cut withheld.

This is the highest-leverage proposal: it converts the all-or-nothing gate model into MVP-then-continuous delivery without replacing the existing scheduler, AND lets the most-critical cohort optionally parallelize when contracts are freezable.

---

## 4. Additional Items Worth Surfacing

- **Pre-exec is itself the largest MVP delay** (80–160 min). For small tasks, a fast path would help, but v0.17 removed triage/interview-depth because complexity outweighed measured value. Any lite mode should be cache/freshness driven, not a rollback to heuristic triage.
- **Hard 1 / 2 / 3 run sequentially** but the three are only partially independent. Contract diff and static checks are good fan-out candidates; full tests may contend on build output, DB, dev server, coverage, or cache. Gate parallelism should be a resource-lock-aware DAG.
- **Worker pool max 2 (hard cap 3)** is conservative. Raising it should wait for telemetry showing slot starvation and acceptable UI/tool stability.
- **Small pipeline already exists in the phase controller**, but it is not the same as an MVP cut. It completes a lightweight pipeline; it does not create a first-class shippable subset inside a larger full pipeline.
- **Release path is separate from whole-pipeline finalize.** `release-gate(cut_id) → release-finalize(cut_id)` is a partial checkpoint pair for created scope only; the existing `phase3-gate → phase5-finalize` keeps the current whole-pipeline / whole-goal closure semantics and runs once at the end. The release path never writes to `state.gate_results.hard{1,2,3}_*` (those fields are reserved for final `phase3-gate`) and never sets `finalize_done=true`.

---

## 5. Review Rebaseline

The best path is not to add a large new module scheduler first. MPL already has:

- `execution_tiers[]` for phase ordering and parallel waves.
- `goal_trace` and `covers` for user-visible scope.
- `interface_contract` and `contract_files` for dependency edges.
- `resource_locks` for known conflict domains.

The missing primitive is a **delivery boundary**, not a second scheduler.

### Proposed Shape

```yaml
# .mpl/goal-contract.yaml — user declaration at interview
mvp_scope:
  acceptance_criteria: [AC-1, AC-2]
  variation_axes: [AX-1]
  artifact: draft_pr                  # draft_pr | branch | tag | release_manifest

# .mpl/mpl/decomposition.yaml — decomposer output
mvp:
  derived_from: goal_contract.mvp_scope
  phases: [phase-1, phase-2, phase-4] # SSOT for MVP membership
  execution_mode: sequential          # sequential (Stage A) | contract_skeleton (Stage B opt-in)
  # skeleton_phase: phase-0           # REQUIRED iff execution_mode == contract_skeleton
  artifact: draft_pr

release_cuts:                          # zero or more, advisory grouping for extension
  - id: cut-ext-a
    phases: [phase-5, phase-6]
    proposed_by: decomposer
    user_approved: false               # decomposer-proposed cuts may need HITL
```

Semantics:

- `mvp` is a single first-class object, derived from `goal_contract.mvp_scope`. Exactly one per pipeline. Must-ship-first. Decomposer maps declared AC/AX ids to phase membership; it does NOT infer scope.
- `release_cuts[]` is zero or more decomposer-proposed extension delivery groups. Advisory, optionally user-approved.
- Every phase listed in `mvp.phases` or in a cut must appear exactly once in `execution_tiers[]`. Membership is single-direction (cut/mvp → phases); phases do NOT cross-reference their cut/mvp to keep SSOT clean.
- MVP passes only when `release-gate(mvp)` runs scoped Hard 1/2/3 to PASS and `release-finalize(mvp)` then writes manifest and (optionally) creates the user-visible artifact. Failure at either step withholds the MVP cut artifact.
- `release-gate(cut_id)` writes scoped results into `.mpl/mpl/releases/{cut_id}/gate-results.json` — never into `state.gate_results.hard{1,2,3}_*` (those are reserved for final `phase3-gate`).
- `release-finalize(cut_id)` reads the scoped gate results, writes the release manifest and evidence summary, and (optionally) creates the user-visible artifact. It does **not** set `state.finalize_done=true`, does **not** transition `current_phase` to `completed`, and does **not** require whole-goal closure.
- Sprint completion is **cohort-aware**: `phase2-sprint` evaluates completion against the active cohort (MVP or current cut), not all phases. Only after all phases complete does sprint transition to whole-pipeline `phase3-gate`.
- `mvp.execution_mode`:
  - `sequential` — default. MVP phases run via normal `execution_tiers[]`.
  - `contract_skeleton` — requires a `skeleton_phase` whose `interface_contract.produces` covers the MVP surface. Subsequent MVP phases run in parallel worktrees against the frozen skeleton; finished phases emit `export-manifest.json`; orchestrator runs **1-pass reconcile** at MVP cohort end. Mismatches → fixup phases queued, MVP cut withheld.
- Extension cuts/phases keep using normal `execution_tiers[]` scheduling after the MVP cut.

### Why This Is Better Than `module_groups[]` First

`module_groups[]` answers "which phases belong together architecturally." The immediate user pain is "when can I see a runnable subset?" That is a release question, not necessarily a module question. A release cut can span multiple modules for one vertical slice, and it can be implemented without replacing the current scheduler.

### Why MVP and Release Cut Are Separated

Conflating them as a single `release_cuts[]` array (with one entry tagged "mvp") would force the system to either infer which cut is MVP, or to over-rely on naming conventions. Two different epistemics get mixed:

- MVP is a **user declaration**: authoritative, exactly one, must-ship-first.
- Release cut is a **decomposer proposal**: advisory, 0..N, delivery grouping convenience.

Keeping them as separate top-level fields (`mvp` object, `release_cuts[]` array) makes the type system carry the semantic difference: required vs optional, single vs many. This also matches the v0.17 lesson — do not let the system infer scope decisions the user can declare cheaply.

### Why MVP Parallel Is Gated Behind `contract_skeleton` Mode

Naive MVP parallelism would couple the system's highest-stakes cohort with the riskiest scheduling pattern. Two specific risks:

1. **Cascade reconcile divergence**: without a 1-pass cap, a reconcile loop can become slower than sequential while introducing churn in critical-path code.
2. **Contract drift**: parallel phases producing conflicting symbol exports is harder to recover from in MVP than in extension, because MVP failure withholds the entire user-visible cut.

`contract_skeleton` mode mitigates both by (a) freezing the contract surface in a sequential prefix phase before fan-out and (b) capping reconcile to one pass with fixup-queue fallback. If a project cannot express a skeleton phase, the mode is not selectable and `sequential` is used.

**Skeleton verification (DECIDED):** reuse the existing manifest channel rather than adding a new hook. The skeleton phase emits `export-manifest.json` with `frozen: true` on its declared surface (types, signatures, file layout). SNT-S1 treats `frozen: true` as a baseline: subsequent MVP phases' manifests must be a **subset** of the frozen surface — declared symbols may be implemented, but new exports outside the frozen set are rejected at phase exit. This costs zero new infrastructure beyond a `frozen` boolean on the manifest schema and a SNT-S1 comparison branch.

**Reconcile failure policy (DECIDED):** **fail-and-surface**, not hold-and-wait. When 1-pass reconcile produces unresolved mismatches:

1. `release-finalize(mvp)` is **not** invoked. MVP cut is withheld.
2. Queued fixup phases are written to `.mpl/mpl/releases/mvp/pending-fixups.yaml` and surfaced to the user with a one-shot decision: approve fixup execution, or abort MVP cut.
3. On user approval, fixup phases execute sequentially (not in parallel — they are off the critical-skeleton path). After fixups, `release-finalize(mvp)` retries once.
4. Hybrid auto-resolution of "trivial" mismatches is explicitly NOT done — the classification surface adds complexity without removing the user-visible decision point that contract drift represents.

This is the worst-case path: a project that selects `contract_skeleton` and hits reconcile failure ends up slower than `sequential` would have been. That cost is intentional — it is the price of pushing the most-critical cohort into parallel execution, and the policy makes the cost visible rather than hiding it in retry loops.


### Release Path vs Whole-Pipeline Finalize

Do not shrink `phase3-gate` or `phase5-finalize` to serve as partial checkpoints. Their current meaning is whole-pipeline gate / whole-goal closure, and existing hooks (`mpl-require-whole-goal-closure.mjs`) treat `finalize_done=true` as a whole-goal closure claim.

Add a **separate release path** as two states:

```text
release-gate(cut_id)        # scoped Hard 1/2/3 over active cohort
release-finalize(cut_id)    # manifest + optional artifact, no state.gate_results write
```

`release-gate(cut_id)` responsibilities:

- Run Hard 1 (full project build/lint/type — broken file breaks everything regardless), Hard 2 (affected tests for cohort, fallback to full project tests if affected scope cannot be resolved), Hard 3 (active cohort's `interface_contract` only).
- Write results to `.mpl/mpl/releases/{cut_id}/gate-results.json`.
- **Never** write to `state.gate_results.hard{1,2,3}_*` — those fields are reserved for final `phase3-gate` and cross-contamination would break whole-pipeline gate semantics.

`release-finalize(cut_id)` responsibilities:

- Read `.mpl/mpl/releases/{cut_id}/gate-results.json`.
- Verify phase evidence, `export-manifest.json`, Test Agent evidence where required.
- Write `.mpl/mpl/releases/{cut_id}/release-manifest.json` and `evidence-summary.md`.
- Attempt optional artifact creation (`draft_pr`, `branch`, `tag`) when requested by `mvp.artifact` or `release_cut.artifact`; on failure, write `artifact_creation_failed` with reason into the release manifest and surface to user.
- **Never** set `finalize_done=true`, never transition `current_phase` to `completed`, never run whole-goal closure.

Keep existing end-of-run behavior unchanged:

```text
phase3-gate     # whole-pipeline Hard 1/2/3, runs once after all phases complete
phase5-finalize # whole-goal closure, the only path that sets finalize_done=true
```

(Some prior drafts of this doc referred to the whole-pipeline finalize as `pipeline_finalize(all)` — that was a conceptual alias for the existing `phase5-finalize` state, not a new state. The implementation uses `phase5-finalize`.)

Resulting flow:

```text
Phase 0
-> Decompose
-> phase2-sprint              # cohort = mvp (cohort-aware completion)
-> release-gate(mvp)          # scoped Hard 1/2/3
-> release-finalize(mvp)      # MVP cut artifact handed off
-> phase2-sprint              # cohort = extension cut A
-> release-gate(cut-a)
-> release-finalize(cut-a)
-> ... (further approved cuts)
-> phase2-sprint              # cohort = remaining phases (if any)
-> phase3-gate                # whole-pipeline gate, regression safety net
-> phase5-finalize            # whole-goal closure, sets finalize_done=true
-> completed
```

This preserves the user's desired repeated checkpoint cadence without weakening the meaning of whole-pipeline gate or whole-goal closure.

### Safer Conflict Rule

Stage A should keep the current conservative conflict rule:

- no overlapping `impact.create`
- no overlapping `impact.modify`
- no overlapping `impact.affected_tests`
- no shared `resource_locks`
- dependency frontier respected

Later, conflict detection can be relaxed only for narrower proven cases:

- append-only generated registries
- disjoint AST ranges with stable formatter behavior
- files explicitly marked as merge-safe by a mechanical checker

Declared symbol overlap is useful telemetry, but it is not enough by itself to allow same-file parallel writes.

---

## 6. Recommended Path

Sequenced to avoid touching too many subsystems at once.

### Stage A — User-Declared MVP, Sequential Execution

1. **Interview captures `mvp_scope`.** New interview question elicits the user-declared MVP as AC/AX ids; stored on `.mpl/goal-contract.yaml`.
2. **Add `mvp` and `release_cuts[]` to decomposition output.** Decomposer derives `mvp.phases` from `mvp_scope` (no inference) and optionally proposes `release_cuts[]` for extension grouping. `mvp.execution_mode` defaults to `sequential`. Planning-stage HITL confirms cut structure once before execute.
3. **Add `release-gate(cut_id)` and `release-finalize(cut_id)` as two new states.** Release-gate runs scoped Hard 1/2/3 and writes results to `.mpl/mpl/releases/{cut_id}/gate-results.json` (never to `state.gate_results.hard{1,2,3}_*`). Release-finalize reads the scoped gate results, writes `release-manifest.json` and `evidence-summary.md`, and optionally creates the user-visible artifact. Neither sets `finalize_done=true`.
4. **Cohort-aware `phase2-sprint` completion.** Sprint evaluates completion against the active cohort (`state.release.current_cut_id`) — MVP phases for MVP cohort, cut's phases for an extension cut — not against all phases. MVP completion routes to `release-gate(mvp)`, not `phase3-gate`. Only after all phases of all cohorts complete does sprint transition to whole-pipeline `phase3-gate`.
5. **Mandatory manifest for code-bearing phases — block from Stage A.** Phase Runner output schema includes `export_manifest`; missing manifest on a code-bearing phase blocks completion (not warn-only). Enforcement via evidence latch token or a new `mpl-require-export-manifest.mjs` hook.
6. **Whole-pipeline `phase3-gate` + `phase5-finalize` unchanged.** Final whole-pipeline gate still runs after all phases complete; final whole-goal closure still runs once and is the only path setting `finalize_done=true`.

### Stage B — Frontier Scheduling + Optional MVP Parallel

7. **Continuous contract diff.** Run cheap manifest-vs-contract checks at every phase exit.
8. **Dependent-subtree blocking for extensions.** Contract mismatches block only phases that require the broken producer; unrelated frontier branches continue.
9. **`contract_skeleton` execution mode for MVP.** Decomposer may emit `mvp.execution_mode: contract_skeleton` with a `kind: skeleton` first phase that freezes the MVP contract surface. MVP phases after the skeleton run in parallel worktrees under the existing same-file conflict rules.
10. **1-pass reconcile + fixup queue.** At MVP cohort end, run one contract reconcile pass. Mismatches enqueue fixup phases and withhold the MVP cut; do NOT loop. This is the explicit anti-cascade guardrail.
11. **Extension waves + release path.** After the MVP cut, run extension phases using existing `execution_tiers[]`, worktree isolation, and resource locks. When an approved cut completes, run `release-gate(cut-id)` → `release-finalize(cut-id)` for that created scope only (same release path as MVP, parameterized on `cut_id`).
12. **Whole-pipeline finalize remains final-only.** After all phases/cuts complete, whole-pipeline `phase3-gate` runs (full Hard 1/2/3 regression safety net), then `phase5-finalize` runs once; this is the only path that performs whole-goal closure and sets `finalize_done=true`. Never call `release-finalize(cut_id)` from `phase5-finalize`.
13. **Measure before loosening conflicts.** Record blocked reasons, merge conflicts, fixup rate, reconcile-pass outcomes, release-finalize duration, and critical-path impact.

### Stage C — Structural Modules If Still Needed

14. Add `module_groups[]` only if release cuts plus tiers cannot express repeated extension delivery.
15. Consider symbol/AST-level conflict relaxation only after Stage B telemetry proves file-overlap is the dominant bottleneck and merge failures are low.
16. Revisit Pre-exec lite only as a cache/freshness fast path, not as a rollback to pre-v0.17 triage complexity.

---

## 7. Open Questions

- What is the minimum acceptable MVP artifact: draft PR, branch/tag, release manifest, or all of them?
- Exact interview question wording for `mvp_scope`. Does the user respond in AC/AX ids, in prose later mapped to ids, or in a guided checklist?
- Should `release_cuts[]` be auto-emitted by decomposer or only on user request? If auto, how much HITL approval is required?
- ~~Which gates are valid for `release-finalize(cut_id)` when extension phases are still pending, and which checks must remain global sanity checks?~~ → **Decided (RFC §5.3 / D-Q3):** Hard 1 full project, Hard 2 affected scope with documented fallback, Hard 3 active cut's interface_contract. Whole-pipeline `phase3-gate` remains as the final regression net.
- What manifest schema is required for Phase Runner output without making small phases too heavy?
- ~~For `contract_skeleton` mode: what mechanical check verifies the skeleton phase actually froze the surface?~~ → **Decided (§5):** `export-manifest.json` with `frozen: true` baseline, SNT-S1 subset-check on subsequent MVP phases.
- ~~For 1-pass reconcile failure: does MVP cut wait for queued fixup phases or fail-and-surface?~~ → **Decided (§5):** fail-and-surface; user gets a one-shot approve/abort decision, fixups run sequentially off the skeleton path.
- How does `mvp.execution_mode: contract_skeleton` interact with the existing small-pipeline mode in `hooks/mpl-phase-controller.mjs`? Mutually exclusive (small bypasses MVP-cut entirely) or compatible?
- Where exactly does `state.release.current_cut_id` live in the state schema, and how is it reset between cohorts? Cohort-aware sprint completion (§5/§6 Stage A #4) needs a single SSOT field; the schema location is deferred to the RFC (§4) but the lifecycle (set at cohort start, cleared at release-finalize exit, never re-entered for the same cut) is fixed here.
- For projects with no `mvp_scope`: is the release path skipped entirely (current state machine runs unchanged), or does the orchestrator still create a degenerate single-cut covering all phases? Default proposal: skip entirely — backward compatibility wins, no release-path overhead for non-opted-in projects.
- Can a mechanical checker prove append-only or AST-disjoint same-file edits strongly enough to permit limited same-file parallelism?
- How aggressively should Pre-exec lite strip the interview? Given v0.17 removed triage for complexity reasons, this should probably be cache/freshness driven, not heuristic-only.

---

## 8. Source References

All findings traced to live files in this repo. Key citations:

- `commands/mpl-run.md:20-36` — state machine
- `commands/mpl-run-execute.md:18-92` — `execution_tiers` scheduler contract, conflict-free waves, worktree pool, join reconciliation
- `commands/mpl-run-execute.md:602-760` — phase result processing, evidence latch, reviewer pipelining, gate entry
- `commands/mpl-run-execute.md:524-557` — test-agent pipelining flag and dependency frontier
- `commands/mpl-run-execute-parallel.md:20-99` — TODO-level concurrency (`MAX_CONCURRENT_TODOS=3`)
- `commands/mpl-run-execute-gates.md:14-17` — Floor mandatory for all phases
- `commands/mpl-run-execute-gates.md:25-400+` — Hard 1/2/3 sequential gate protocol
- `commands/mpl-run-phase0.md:87-221` — Interview block
- `commands/mpl-run-phase0.md:443-531` — Ambiguity resolution
- `agents/mpl-phase-runner.md:139-190` — Phase Runner output schema currently lacks `export_manifest`
- `hooks/mpl-sentinel-s1.mjs` — validates `export-manifest.json` when present
- `hooks/mpl-phase-controller.mjs:554-632` — existing small pipeline states
- `hooks/mpl-require-whole-goal-closure.mjs:1-90` — `finalize_done=true` is whole-goal closure, not a partial release checkpoint
- `docs/design.md:683-712` — v0.17 removal of triage / interview-depth / PP-proximity routing
- `docs/decisions/AD-01-*` — `interface_contract` requirement (v0.13.0)
