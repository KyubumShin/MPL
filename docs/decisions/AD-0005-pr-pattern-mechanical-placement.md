---
id: AD-0005
title: PR-02/03/04 mechanical pattern placement — EXPERIMENTAL + DROP + LOST
status: accepted
date: 2026-04-12
related: ["#14", "#15", "#19", "AD-0001", "AD-0002", "AD-0003", "AD-0004"]
---

## Context

PR-02 (Security Pattern Grep), PR-03 (UI Hardcoding), and PR-04 (Resource Lifecycle Pair) all lived in the deleted `agents/mpl-code-reviewer.md` before v0.11.0 consolidation. All three were classified as **LOST** in the 2026-04-12 4-dimension reconciliation audit — no active implementation anywhere in the tree.

The question "where should they live?" deadlocked during the 2026-04-11 session because all 5 candidate options (extend Hard 1, extend Hard 3, new Hard 4, domain prompts only, sentinel hook) had structural dealbreakers. A formal 3-agent debate (Pro/Con/Mutant) was required to break the deadlock.

### Debate outcome

**Converged 3:0 (unanimous) after 2 rounds** (max 7, early exit). The Mutant reframed the question from "which gate holds the patterns?" to "at what pipeline stage are patterns detected?" — shifting from gate-time checking to decomposition-time artifact generation, following the same L0→L1→L2 pattern as AD-01's `contract_files` (landed in `35bf332`).

Key position changes:
- **Mutant** accepted Con's AD-0002 experimental standard: `severity:EXPERIMENTAL` first, HARD promotion only after benchmark data.
- **Pro** accepted Mutant's decomposition-time framing: dual defense (Phase-time a_items + Gate-time cross-check) instead of Hard 1 only.
- **Con** accepted the EXPERIMENTAL approach: non-blocking measurement satisfies the "experiment before enforcement" principle.

Full debate record: `~/project/decision/2026-04-12-ad0005-pr-pattern-placement.md`.

### Evidence

- cb-phase-a1 §5: contract presence dominance (Δ = -2.17) as strongest L2 defense — validates the "decomposition-time artifact" pattern.
- cb-phase-a1: C2 = 0, C3 = 0 across all runs — prompts alone (Option D) cannot close mechanical detection gaps.
- cb-phase-a1: 37% D2 residual at M1=1/M2=ON — some portion is security-pattern-detectable, but the exact proportion is unmeasured for PR-02/04 failure class.
- AD-0002: experimental evidence standard is binding — no feature restoration without data or explicit deferral pending data.
- Wiki precedents: [[gate-consolidation-6-to-3]] ("verifiable → Hard, subjective → Advisory"), [[mechanical-verification]] (L0/L1/L2 artifact hierarchy), [[hook-enforcement]] (soft vs hard enforcement).

## Decision

### PR-02 Security Pattern Grep → EXPERIMENTAL

Implement `default_risk_patterns` as a hardcoded security rule set in `commands/mpl-run-decompose.md` Step 3 post-processing. For each phase, inject matching patterns into `verification_plan.a_items[]` as `type: "grep"` entries. Phase Runner executes these as mechanical A-item verification (Bash grep, not LLM judgment). Additionally, add a Hard 1 Step 0 "Pattern Risk Check" in `commands/mpl-run-execute-gates.md` as an independent gate-time cross-check against the full `git diff` changeset.

During the EXPERIMENTAL phase:
- Hard 1 Step 0 exit code is **ignored** (metric recording only, no blocking).
- Pattern match data is recorded to `.mpl/mpl/pattern-metrics.jsonl`.
- Neither Phase-time nor Gate-time checks affect pipeline pass/fail.

**HARD promotion gate** (pre-registered, AD-0002 Phase B style):
- CB testbed benchmark: 5 injected security defects (eval injection, hardcoded API key, SQL string concat, innerHTML XSS, weak crypto).
- 5 MPL runs with EXPERIMENTAL instrumentation.
- **Promote**: ≥3/5 detection rate AND defects not caught by Hard 1/2/3 alone.
- **DROP**: 0/5 detection rate.
- **Inconclusive**: 1-2/5 → 5 additional runs, then re-evaluate.
- Threshold is pre-registered in this ADR. Post-hoc modification is a policy violation.

### PR-03 UI Hardcoding → DROP

Count-based soft threshold ("20+ raw hex colors → warn") is structurally incompatible with the binary 3 Hard Gate architecture. The Advisory Gate (the only channel that could express non-blocking graduated warnings) was removed in v0.12.3 per AD-0002/#13/#25. No legitimate channel remains for "warn but don't block."

Existing `prompts/domains/ui.md` guidance at line 13 ("No hardcoded strings") is the fallback. This is an enforcement downgrade, accepted as the cost of architectural consistency.

### PR-04 Resource Lifecycle Pair → LOST

Pair detection ("open() without close()", "setTimeout without clearTimeout") cannot be expressed as a single grep pattern. It requires either AST analysis, multi-grep with file-level state tracking, or a purpose-built pair matcher — all of which exceed the scope of this ADR and the `default_risk_patterns` mechanism.

PR-04 remains LOST. If PR-02's EXPERIMENTAL phase succeeds and the team decides to invest further in pattern detection infrastructure, a separate AD should design the `pair_pattern` mechanism.

## Alternatives Considered

### Option A: Extend Hard 1 lint chain (Pro's initial position)
Insert `mpl-pattern-lint.mjs` into `lint_commands[]` alongside eslint/ruff. **Dealbreaker**: PR-03's soft threshold maps poorly to binary exit code; Hard 1's lint tools are project-config-gated (eslint from `package.json`, ruff from `pyproject.toml`) while MPL patterns are MPL-intrinsic — mixing the two muddies gate identity. Partially adopted: Hard 1 Step 0 cross-check retained as the gate-time safety net, but not as the primary detection mechanism.

### Option B: Extend Hard 3 boundary contracts
Add `patterns[]` to `.mpl/contracts/*.json` schema. **Dealbreaker**: Hard 3 is specifically "contract diff guard" — pattern rules are file-global, not boundary-scoped. Cramming them into per-boundary contracts bloats decomposer burden (already expanded by AD-01) and muddies Hard 3's identity.

### Option C: New Hard 4 — Pattern Gate
Fourth Hard Gate (`hooks/mpl-hard4-patterns.mjs`). **Dealbreaker**: directly regresses the v0.11.0 6→3 gate consolidation (wiki [[gate-consolidation-6-to-3]]). Requires extraordinary evidence that "6→3 was wrong or Hard 4 is categorically different" — neither has been shown.

### Option D: Domain prompts only
Codify patterns as guidance in `prompts/domains/*.md`. **Dealbreaker**: cb-phase-a1 proved prompts alone fail (C2=0, C3=0 despite active HA-02 adversarial prompt). Violates AD-0002 experimental evidence standard. Downgrades enforcement from "gate fail" to "runner may ignore."

### Option E: Sentinel hook (PostToolUse)
`hooks/mpl-sentinel-patterns.mjs` fires after Write/Edit. **Dealbreaker**: sentinel warnings are non-blocking (`continue: true`). For security rules, non-blocking is the same class as the removed Advisory Gate. AD-0002:80 already rejected non-blocking observation layers on experimental grounds.

### Option F: Leave all LOST (Con's initial position)
No restoration, no implementation. v0.13.0 budget to #19 AD-05 only. **Dealbreaker**: the EXPERIMENTAL approach costs near-zero budget (hardcoded patterns, no new agent, no LLM calls) and produces measurement data. "Leave LOST" foregoes data collection that could inform future decisions. Con conceded when the EXPERIMENTAL framing preserved the AD-0002 standard.

## Consequences

### Code impact

**Files to create:**
- `.mpl/patterns/security.json` — default security rule set (eval, innerHTML, hardcoded secrets, SQL concat, weak crypto)
- `.mpl/mpl/pattern-metrics.jsonl` — EXPERIMENTAL metric output (created at runtime)

**Files to modify:**
- `agents/mpl-decomposer.md` — Step 9.6 `risk_patterns[]` field in schema + Reasoning_Steps
- `commands/mpl-run-decompose.md` — Step 3 post-processing: `default_risk_patterns` injection into a_items
- `commands/mpl-run-execute-gates.md` — Hard 1 Step 0 "Pattern Risk Check" (non-blocking during EXPERIMENTAL)
- `commands/mpl-run-execute.md` — Phase Runner context assembly: load risk_patterns into verification context

### Constraints on future work

- **PR-03 is permanently DROPPED** unless a new non-binary channel is created (which would require its own AD and experimental justification).
- **PR-04 requires a separate AD** for `pair_pattern` mechanism design. Do not attempt to extend `default_risk_patterns` with pair logic.
- **HARD promotion threshold is pre-registered**: ≥3/5 detection on CB testbed. Modifying this threshold after seeing data is a policy violation (AD-0002 pre-registration principle).
- **EXPERIMENTAL does not block**: during the EXPERIMENTAL phase, pattern checks must NOT affect Hard 1 exit code or pipeline pass/fail. Violation upgrades to HARD without data, which contradicts this ADR.

### What we are explicitly NOT solving

- PR-04 pair detection mechanism (separate AD)
- PR-03 count-based threshold in binary architecture (accepted as unsolvable; DROPPED)
- Rule management process for `default_risk_patterns` (defer to v0.13.1)
- Dual-check redundancy resolution (Phase-time + Gate-time — let EXPERIMENTAL data decide)

## References

- Debate record: `~/project/decision/2026-04-12-ad0005-pr-pattern-placement.md`
- Audit: `~/project/wiki/scratch/2026-04-12/mpl-reconciliation-audit.md` (§3.4 PR-02/03/04 LOST status)
- Session resume: `~/project/wiki/scratch/2026-04-12/mpl-session-resume.md` (§10, §17 Action 3)
- cb-phase-a1: `~/project/harness_lab/analysis/cb-phase-a1-n3-report.md`
- AD-0002: `docs/decisions/AD-0002-cb-features-bound-to-ablation-experiment.md`
- Wiki precedents: [[gate-consolidation-6-to-3]], [[mechanical-verification]], [[hook-enforcement]]
- Implementation prerequisite: AD-01/AD-02 (`35bf332`) — `contract_files` mandatory pattern is the design precedent for `risk_patterns`
