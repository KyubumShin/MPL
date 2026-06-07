# Over-Enforcement Audit

**Date**: 2026-05-29
**Source**: companion to the prompt → gate → restore divergence audit (`docs/findings/2026-05-28-*`)
**Trigger**: user follow-up — "너무 과도한 조건으로 인하여 오히려 다양한 가능성을 막는 장애물이 되는지 mpl 전반적으로 전수 검토"

## Permanent rule (re-affirmed)

3-tier — **prompt 권고 → gate hard blocking → restore** — stays. The audit below is NOT about loosening this principle. It's about cases where the *current implementation* of the gate layer is binary (block / off) where it should be 3-mode (warn / block / off + config-driven thresholds), or hard-codes a single algorithm where multiple legitimate alternatives exist.

Existing infrastructure already supports 3-mode:
- `hooks/lib/mpl-config.mjs::ENFORCEMENT_DEFAULTS` — per-rule `warn` / `block` / `off`.
- `strict: false` global elevation switch.
- Per-hook boolean toggles (`*_required: false`) for full opt-out.
- Per-hook dedicated config files (e.g. #225 brief enforcement).

**The audit's relaxation work = migrating binary-block hooks to the existing 3-mode infrastructure + adding config knobs for hard-coded thresholds. NOT removing the gates.**

## Audit method

Three parallel `general-purpose` agent reads on 2026-05-29 scoped to:
1. Hook-layer hard blocks (no config, no override).
2. Prompt / schema over-prescription (single forced algorithm).
3. Lifecycle + parallelism over-constraint.

Findings cross-checked against `hooks/lib/mpl-config.mjs`, existing `*_required` toggles, and the recover-skill routing table.

## Findings — grouped by relaxation pattern

### A. Hard-coded threshold / allowlist needing config knob

| # | Where | What's hard-coded | Blocks legitimate workflow | Severity |
|---|---|---|---|---|
| **A1** | `hooks/lib/mpl-phase0-artifacts.mjs:37-74` + I13 | required artifacts list (raw-scan.md, design-intent.yaml, contracts/*.json) | README typo fix through MPL forces all 3 artifacts. Only `_no-boundaries.json` carve-out for contracts. | HIGH |
| **A2** | `hooks/mpl-require-test-agent.mjs:454` | default `test_agent_required !== false` (absence = required per AD-0007) | Every legacy / hand-written decomposition trips it; no project-wide opt-out | HIGH |
| **A3** | `hooks/mpl-phase-controller.mjs:360-378, 391-410` | ambiguity threshold = literal `0.2` | Score 0.21 stays in ambiguity-resolve forever; no force-proceed path | HIGH |
| **A4** | `hooks/lib/mpl-gate-classify.mjs:150-163` STRICT_GATE_HEAD_ALLOWLIST | 10-head allowlist (tsc/eslint/ruff/mypy/vitest/jest/pytest/mocha/playwright/cypress/wdio/npm/pnpm/yarn/npx/cargo/go) | deno/bun/biome/phpunit/rspec/swift/dotnet/gradle/mvn/tox/nox/mix all rejected; locks manual recovery to a JS/Python/Rust/Go monoculture | HIGH |
| **A5** | `hooks/lib/bash-timeout-categories.mjs:22-61` | vitest/jest 300_000ms ceiling, build 180_000ms | monorepo Nx/Turborepo full-test, `cargo build --release` exceed; no per-project override | MED |
| **A6** | `hooks/mpl-require-e2e-authenticity.mjs:40` MOCK_PATTERN | `/\b(mock|stub|fake|msw|...)\b/i` matched anywhere in command | `playwright test --grep "mockable-payment-fallback"`, `cargo test fake_clock_integration`, `pytest -k "not stubbed"` false-positive | MED |
| **A7** | `hooks/mpl-require-e2e-authenticity.mjs:42, 204-209, 257-267` | Tauri-specific FAKE_RUNTIME_E2E_PATTERN applied to all `real_desktop` | Electron / Qt / wxWidgets / native macOS with comments about other runtimes hit it; scratch tauri.conf.json triggers tauri_capabilities_missing | LOW-MED |

**Relaxation pattern**: extract literals into `.mpl/config.json` (e.g. `phase0_artifacts_required`, `ambiguity_threshold`, `gate_classify.allowed_heads`, `bash_timeout.{category}.max_ms`). Default values stay at current hard-coded ones — config only enables override.

### B. Lifecycle / state transition forcing single path

| # | Where | What's forced | Blocks legitimate workflow | Severity |
|---|---|---|---|---|
| **B1** | `hooks/mpl-require-completed-phase-immutability.mjs:80-99` + `hooks/lib/mpl-completed-phase-immutability.mjs:69-94` | byte-for-byte equality on entire phase YAML block | comment fix, whitespace, anchor addition all block; only `completed_phase_immutability_required: false` (binary off) | MED |
| **B2** | `hooks/mpl-phase-controller.mjs:964-984` | active cohort → forced revert to phase2-sprint | user with PASS gate evidence + stale `current_cut_id` can't proceed to phase3-gate | MED |
| **B3** | `hooks/mpl-phase-controller.mjs:1068-1086` | first-detected stagnation → auto-finalize phase4-fix | brief plateau mid-bug → forced partial completion; `stagnation_window: 3` exists but decision fires on first detection | MED |
| **B4** | `hooks/mpl-require-whole-goal-closure.mjs:51-93` | every contract AC + AX covered for `finalize_done=true` | intentional partial-MVP after release-finalize blocked; only binary off | MED |
| **B5** | `hooks/mpl-baseline-guard.mjs:91-127` | renewal sentinel is touch-and-pray, unscoped | new PP discovery in Phase 2 forces full baseline reset; no per-field renewal | MED |
| **B6** | `hooks/mpl-phase-controller.mjs:544-554` | PLAN.md `[FAILED]` → stays in phase2-sprint | deferred-by-decision TODO has no honest marker; user must lie with `[x]` | LOW-MED |
| **B7** | `hooks/mpl-require-decomposition-delta.mjs:131-134` | `newCount !== oldCount + 1` rejects monotonic > +1 | forward consolidation after corrupted state recovery blocked even when intermediate deltas exist on disk | LOW |

**Relaxation pattern**: scope immutability to load-bearing fields (B1), accept advisory stopReason instead of forced transition (B2/B3), recognize partial / deferred markers as first-class (B4/B6), per-field renewal manifest (B5), allow forward consolidation when delta files exist (B7).

### C. Prompt / schema over-prescription

| # | Where | What's prescribed | Alternative blocked | Severity |
|---|---|---|---|---|
| **C1** | `agents/mpl-test-agent.md:60-68, 192` | per-domain min test count floor (5 per function, 4 CRUD + migration, etc.) | contract-derived test counts (one assertion per `produces[].params/returns` key), property-based testing (1 generator → many cases), proportional coverage | HIGH |
| **C2** | `commands/mpl-run-execute.md:871-912` + dispatch loop | `mpl-adversarial-reviewer` required per phase | low-risk infra/docs phases (no `reviewer_required: bool` mirror of `test_agent_required`); doubles token cost | HIGH |
| **C3** | `commands/mpl-run-execute.md:460` Rule 4 | per-TODO test (no batching) | refactor (rename type + update callers + fix interface) — can't compile until all land; broken intermediate states forced | MED |
| **C4** | `agents/mpl-decomposer.md:487-508`, AP-DECOMP-05 (line 638) | `type_policy` / `error_spec` with `applies: false` MUST be emitted for every phase | "absence = N/A" convention; output budget directly contradicts "Phase 5 diet" line 14 | MED |
| **C5** | `agents/mpl-test-agent.md:32` + `mpl-run-execute.md:686-707` | "Write tests in the project's existing test framework" + `commands_run[].exit_code == 0` | ad-hoc verification scripts, shell contract probes, framework-introduction for phases lacking test infra | MED |
| **C6** | `commands/mpl-run-execute-gates.md:138-146` | Hard 1 demands lint+type+build, ≥1 must run, else FAIL | docs-only repos, prompt-only projects, research scratchpads; `evidence_required: [goal_trace]` legal but Hard 1 still demands tooling | MED |
| **C7** | `agents/mpl-decomposer.md:606-611`, line 50 | `go_no_go` closed enum (READY/READY_WITH_CAVEATS/NOT_READY/RE_INTERVIEW) | free-form risk note; no executor branches on READY_WITH_CAVEATS vs READY | LOW-MED |
| **C8** | `agents/mpl-test-agent.md:87-92` | "Final assistant message MUST start with ```json fence" — prose forbidden even after the fence | human-readable preamble before JSON block (natural shape when bugs found and context matters) | LOW |

**Relaxation pattern**: replace count floors with derive-from-contract rules (C1), add `*_required: bool` mirrors (C2), seed-declared batch mode (C3), drop forced-emit-absent (C4/C7), allow shell evidence shape (C5), per-evidence-type Hard 1 opt-out (C6), allow surrounding prose (C8).

## Cross-cutting themes

1. **Binary block/off is the dominant shape.** Only `bash_timeout_violation`, `direct_source_edit`, `phase_scope_violation`, etc. (~8 rules) use the 3-mode `warn`/`block`/`off` policy. ~20+ blocks are binary. The infrastructure exists; the wire-up is missing.

2. **Hard-coded literals masquerade as policy.** `0.2` ambiguity threshold, `300_000` test timeout, 5-test floor — all should be config knobs with current value as default.

3. **Allowlists drift behind language ecosystem.** STRICT_GATE_HEAD_ALLOWLIST covers TypeScript/Python/Rust/Go. Bun/Deno/PHP/Swift/.NET/Elixir users hit walls.

4. **Lifecycle assumes single forward path.** No "I know what I'm doing" override. Cohort revert, stagnation auto-finalize, ambiguity threshold — all are decisions a sufficiently sophisticated operator should be able to override with an explicit flag.

5. **Schema prescription duplicates gate enforcement.** Many prompt MUSTs (e.g. test count floor, type_policy emission) restate what gates already check, removing the prompt → gate gradient.

## Recommended new issues (over and above #234–#238)

Per the user's standing "scope expansion → split" rule:

- **(NEW1) Hard-coded threshold → config-driven**: A1 (phase0 artifacts), A2 (test_agent default), A3 (ambiguity threshold), A4 (STRICT_GATE_HEAD_ALLOWLIST), A5 (bash_timeout ceilings). All same mechanical pattern (extract literal → config).
- **(NEW2) Lifecycle binary → 3-mode migration**: B1 (completed-phase immutability scope), B2 (phase3 revert advisory), B3 (phase4 convergence threshold), B4 (whole-goal cohort closure), B6 (deferred TODO marker).
- **(NEW3) Prompt over-prescription cleanup**: C1 (test count floor → contract-derived), C2 (reviewer_required opt-out), C3 (batch_test seed flag), C4 (type_policy optional), C6 (Hard 1 evidence_required honors).

## Review of pending issues #234–#238 against this lens

| Issue | 3-tier alignment | Over-enforcement risk | Reshape? |
|---|---|---|---|
| #234 (mpl-recover routing) | ✓ clean — restore enhancement, no new constraint | None | proceed as-is |
| #235 (envelope wiring) | ✓ aligned — wires hand-rolled blocks to existing config | I13 must stay hard-block (single stopgap); document this | proceed, note I13 exception |
| #236 (write-guard tightening) | ⚠ adds new hard blocks | A1 (decomposition.yaml writer): PreToolUse cannot identify calling agent identity for Write/Edit. A3 (protected-path rm): needs override mechanism. | RESHAPE — A1 to telemetry (content-marker check only), A3 with explicit override flag |
| #237 (trace diagnostic) | ✓ clean | D2 endsWith tightening may affect PR #228 tests | proceed, pre-verify |
| #238 (telemetry surface) | ✓ aligned — mostly warn/telemetry | A5 finalize-time elevation is new constraint; new file may duplicate existing telemetry | RESHAPE — integrate vs new-file decision; A5 elevation behind config flag |

## Non-goals (deferred)

- This audit does NOT propose removing any gate. Every finding is a relaxation of *how* the gate fires (config knob / warn tier / override path), not whether it fires.
- Tightening under-enforcement (the prior 2026-05-28 audit) is orthogonal and continues per issues #234-238.
- Issues #230 / #232 (Exp22 follow-up scope expansions) are separate concerns.
