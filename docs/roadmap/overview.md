# MPL Roadmap: Evolution and Remaining Plans

> **Version notation (v0.9.4)**: This file uses legacy major-version notation (v1.0, v3.0, v4.0) from the original roadmap. Actual release versions follow the `v0.x.y` semver series. Mapping: v1.0 = initial design, v3.x ≈ v0.3.x, v4.x ≈ v0.4.x. See `design.md` for the canonical version reference.
>
> **Currency note (2026-05-02)**: Plugin version is `0.17.2` (v0.17.0 released 2026-04-26; v0.17.1 patch 2026-05-02 added `.mpl/metrics/e2e-recovery.jsonl` emission + design.md cleanup; v0.17.2 patch 2026-05-02 moves `.mpl/mpl/decomposition.yaml` Write authority to the `mpl-decomposer` agent — orchestrator can no longer fabricate decomposition in main context). The roadmap-level summary for v0.15.x → v0.16.0 → v0.17 is the first release section below. Per-version detail for v0.15.x → v0.17.2 lives in `docs/design.md` §9 to avoid duplication.

## Vision: "Phase 0 Enhanced + Phase 5 Minimized"

MPL's core philosophy is **strengthening pre-specification (Phase 0) to make post-correction (Phase 5) unnecessary**. Through 7 experiments (Exp 1~8, excluding Exp 2), it was empirically verified that tokens invested in Phase 0 can completely eliminate the debugging/correction cost of Phase 5.

In v3.0, this vision has been **fully implemented**, and additionally, features not in the roadmap (Pre-Execution Analysis, 5-Gate (v1) quality, Convergence Detection, etc.) were also introduced. In v2 (v0.11.0+), the 5-Gate system was restructured to **3 Hard + 1 Advisory (3H+1A) Gate**.

---

## 3-Stage Implementation Roadmap — Achievement Status

| Stage | Name | Core Goal | Status | Detailed Docs |
|-------|------|-----------|--------|--------------|
| Phase 1 | Foundation | Phase 0 Enhanced: complexity-adaptive 4-step analysis | **v3.0 fully implemented** | [phase1-foundation.md](./phase1-foundation.md) |
| Phase 2 | Incremental | Build-Test-Fix micro cycle, stricter Phase 5 entry conditions | **v3.0 fully implemented** | [phase2-incremental.md](./phase2-incremental.md) |
| Phase 3 | Automation | Token profiling, Phase 0 caching, automatic API extraction, automatic pattern analysis | **fully implemented** (4/4) | [phase3-automation.md](./phase3-automation.md) |

---

## Key Numeric Goals — Achievement Status

| Metric | v1.0 baseline | v2.0 target | v3.0 achieved | Status |
|--------|--------------|------------|--------------|--------|
| Total token usage | ~81K | 50~55K | Adaptive (variable by complexity) | ✓ Complexity-based optimization |
| Phase 4 pass rate | 66~83% | 95%+ | Replaced by 5-Gate (v1) → 3H+1A Gate (v2) system | ✓ 95%+ required |
| Phase 5 dependency | High (required) | Minimal (conditional) | Replaced by Fix Loop + Convergence Detection | ✓ Effectively eliminated |
| Phase 0 tokens | ~5K | 8~25K (by complexity) | 8~25K (4-grade adaptive) | ✓ Goal achieved |
| Debugging cycle count | 3~5 | 0~1 | Build-Test-Fix (max 2 per TODO) | ✓ Switched to immediate correction |

---

## Implementation Status Matrix

### Phase 1: Foundation — Fully Implemented

| Feature | Design | Implementation | Notes |
|---------|--------|---------------|-------|
| Complexity detector (4 grades) | ✓ | ✓ | Simple/Medium/Complex/Enterprise |
| Phase 0 4-step process | ✓ | ✓ | Step 1~4, selectively applied by complexity |
| API Contract Extraction | ✓ | ✓ | ast_grep_search + lsp based |
| Example Pattern Analysis | ✓ | ✓ | 7 pattern categories |
| Type Policy Definition | ✓ | ✓ | Type hint rules |
| Error Specification | ✓ | ✓ | Required at all complexity levels |
| Artifact verification checklist | - | ✓ | Added in v3.0 |
| Phase 0 summary generation | - | ✓ | Added in v3.0 |

### Phase 2: Incremental — Fully Implemented

| Feature | Design | Implementation | Notes |
|---------|--------|---------------|-------|
| Build-Test-Fix micro cycle | ✓ | ✓ | Max 2 retries per TODO |
| Cumulative testing (regression prevention) | ✓ | ✓ | Full execution at phase end |
| Stricter Phase 5 entry conditions | ✓ | ✓ | Evolved into 5-Gate (v1) → 3H+1A Gate (v2) system |
| Automatic complexity detector | ✓ | ✓ | Integrated at Step 2.5 |
| Test Agent (independent verification) | - | ✓ | Added in v3.0: separated from code author |
| Convergence Detection | - | ✓ | Added in v3.0: improving/stagnating/regressing |

### Phase 3: Automation — Fully Implemented

| Feature | Design | Implementation | Notes |
|---------|--------|---------------|-------|
| Token profiling | ✓ | ✓ | phases.jsonl + run-summary.json |
| Phase 0 caching | ✓ | ✓ | .mpl/cache/phase0/ |
| Automatic API extraction (AST parser) | ✓ | ✓ | hooks/lib/mpl-test-analyzer.mjs implemented |
| Automatic pattern analysis (pattern detector) | ✓ | ✓ | hooks/lib/mpl-pattern-detector.mjs implemented |

---

## Features Added Beyond Roadmap in v3.0

Features newly introduced in v3.0 that were not planned in the roadmap:

| Feature | Description | Related Agent |
|---------|-------------|--------------|
| **Triage** | Automatic interview depth decision based on information_density (light/full, skip removed) | (orchestrator) |
| **Pre-Execution Analysis** | Gap/Tradeoff integration + Verification 2-stage pre-analysis | mpl-interviewer *(was mpl-pre-execution-analyzer + mpl-verification-planner, removed v0.11.0)* |
| **3H+1A Gate quality system** | Hard 1 (auto tests) + Hard 2 (inline review) + Hard 3 (PP compliance) + Advisory (type check). *(v1: 5-Gate → v2: 3H+1A)* | mpl-phase-runner *(was mpl-code-reviewer, removed v0.11.0)* |
| **A/S/H verification classification** | Agent/Sandbox/Human verification item classification | mpl-decomposer *(was mpl-verification-planner, removed v0.11.0)* |
| **Test Agent** | Test integrated into Phase Runner Build-Test-Fix | mpl-phase-runner *(was mpl-test-agent, removed v0.11.0)* |
| **Convergence Detection** | Detecting improving/stagnating/regressing in Fix Loop | (orchestrator) |
| **Side Interview** | User confirmation only for CRITICAL discovery + PP conflicts (non-blocking items logged to deferred-items.md) | (orchestrator) |
| **Resume protocol** | Continue based on per-phase state persistence | (orchestrator) |
| **Context cleanup** | Orchestrator memory cleanup after phase completion | (orchestrator) |

---

## Experiment Achievement Matrix

All 7 experiments achieved 77/77 = 100% (based on final test suite). These experiment results became the basis for the Phase 0 Enhanced design in v3.0.

| Experiment | Phase 0 technique | Cumulative score progress | v3.0 reflection |
|------------|------------------|--------------------------|----------------|
| Exp 1 | API contract extraction | 34/89 (38%) → 77/77 (100%) | Step 1: API Contract Extraction |
| Exp 3 | Example pattern analysis | 52/89 (58%) → 77/77 (100%) | Step 2: Example Pattern Analysis |
| Exp 4 | Type policy definition | 58/89 (65%) → 77/77 (100%) | Step 3: Type Policy Definition |
| Exp 5 | Test stub generation | 69/89 (77%) → 77/77 (100%) | Build-Test-Fix micro cycle |
| Exp 6 | Incremental testing | 74/89 (83%) → 77/77 (100%) | Incremental Verification |
| Exp 7 | Error specification | 77/77 (100%) | Step 4: Error Specification |
| Exp 8 | Hybrid verification | 77/77 (100%) | 5-Gate (v1) → 3H+1A Gate (v2) quality system |

> **Key finding**: The cumulative score progression (38% → 58% → 65% → 77% → 83% → 100%) shows that scores monotonically increase as Phase 0 techniques are added. This finding became the basis for the complexity-adaptive Phase 0 design.

## Phase 0 Enhanced: 4-Step Process

Synthesizing experiment results, a complete Phase 0 consists of 4 steps. **Fully implemented** in v3.0:

```
Step 1: API Contract Extraction (Exp 1) ─── function signatures, parameter order
Step 2: Example Pattern Analysis (Exp 3) ── usage patterns, defaults, edge cases
Step 3: Type Policy Definition (Exp 4) ──── type hints, collection type rules
Step 4: Error Specification (Exp 7) ──────── standard exceptions, message patterns
```

Each step improves scores independently, but synergy is maximized when combined. Applied steps are automatically selected based on complexity.

## Token Budget Reallocation

Token budget changes from v1.0 to v3.0. v3.0 changed structure by replacing Phase 5 with Fix Loop + 5-Gate (v1; v2에서 3H+1A Gate로 재편):

```
v1.0 (original)                     v3.0 (achieved)
┌──────────────────────────┐        ┌──────────────────────────┐
│ Phase 0:  ~5K  ( 6%)     │        │ Phase 0: 8~25K (adaptive) │
│ Phase 1: ~15K (19%)      │        │ Phase execution: adaptive  │
│ Phase 2: ~15K (19%)      │        │ 5-Gate (v1→3H+1A): ~2K  │
│ Phase 3: ~15K (19%)      │        │ Fix Loop: 0~10K (conditional) │
│ Phase 4: ~15K (19%)      │        │ Finalize: ~2K            │
│ Phase 5: ~16K (20%)      │        │                          │
│ ─────────────────────    │        │ Phase 0 cache hit: ~0K   │
│ Total:   ~81K            │        │ Total: variable by complexity │
└──────────────────────────┘        └──────────────────────────┘
```

## Remaining Plans and Known Issues

> Final audit date: 2026-03-05. For full list, refer to [design.md §9](../design.md#9-known-issues-and-remaining-work).

### ~~CRITICAL (2 items) — Consistency impact~~ **Resolved** (2026-03-05)

| ID | Item | Status |
|----|------|--------|
| I-01 | ~~Ghost agent `mpl-research-synthesizer`~~ | **Resolved** — Removed from VALIDATE_AGENTS and EXPECTED_SECTIONS |
| I-02 | ~~mpl-run.md Related Skills duplication~~ | **Resolved** — Duplicate rows removed, consolidated to single registration |

### ~~HIGH (5 items) — Missing features~~ **Resolved** (2026-03-05)

| ID | Item | Status |
|----|------|--------|
| I-03 | ~~Skill `/mpl:mpl-bugfix` not implemented~~ | **Resolved** — `skills/mpl-bugfix/SKILL.md` created |
| I-04 | ~~Skill `/mpl:mpl-small` not implemented~~ | **Resolved** — `skills/mpl-small/SKILL.md` created |
| I-05 | ~~Skill `/mpl:mpl-compound` wrapper missing~~ | **Resolved** — skill created *(agent removed v0.11.0, finalize에 통합)* |
| I-06 | ~~Skill `/mpl:mpl-gap-analysis` wrapper missing~~ | **Resolved** — `skills/mpl-gap-analysis/SKILL.md` created |
| I-07 | ~~`mpl-validate-output` agent list incomplete~~ | **Resolved** — `mpl-decomposer`, `mpl-git-master` added *(mpl-compound removed v0.11.0)* |

### ~~MEDIUM (2 items) — Unimplemented roadmap~~ **Resolved** (2026-03-05)

| ID | Item | Status |
|----|------|--------|
| I-08 | ~~Automatic API extraction (AST parser)~~ | **Resolved** — `hooks/lib/mpl-test-analyzer.mjs` implemented |
| I-09 | ~~Automatic pattern analysis (pattern detector)~~ | **Resolved** — `hooks/lib/mpl-pattern-detector.mjs` implemented |

### ~~LOW (4 items) — Improvements~~ **Resolved** (2026-03-05)

| ID | Item | Status |
|----|------|--------|
| I-10 | ~~Convergence state naming inconsistency~~ | **Resolved** — Unified to `stagnating`/`regressing` |
| I-11 | ~~Phase 0 cache validation utility code missing~~ | **Resolved** — `hooks/lib/mpl-cache.mjs` implemented |
| I-12 | ~~Token profiling aggregation/visualization tool missing~~ | **Resolved** — `hooks/lib/mpl-profile.mjs` implemented |
| I-13 | ~~Triage logic not enforced by hook~~ | **Resolved** — Triage guard added to phase-controller |

---

## v3.1 Audit and Improvements (2026-03-07)

### Completed Items

| # | Item | Type | Change content |
|---|------|------|---------------|
| 1 | Critic → Decomposer absorption | Removal | `mpl-critic` deleted, risk_assessment embedded in decomposer output |
| 2 | Phase 0 complexity formula simplification | Improvement | async_functions removed, 4 grades→3 grades, no additional tool calls needed |
| 3 | Gap + Tradeoff integration | Merge | `mpl-pre-execution-analyzer`(sonnet) created, 2 calls→1 call |
| 4 | Fast-Fail Path | Addition | bugfix/small/full 3-way pipeline mode classification |
| 5 | Phase Runner progress reporting | Addition | Real-time status reporting protocol for 10 milestones |
| 6 | Circuit break partial rollback | Addition | PASS TODO preservation, FAIL TODO file rollback, recovery context creation |
| 7 | Worker file conflict detection | Addition | Automatic sequential enforcement when files overlap among parallel TODOs |
| 9 | Decomposer read tool permission | Improvement | Read/Glob/Grep allowed for improved decomposition accuracy |
| 10 | State Summary section name unification | Improvement | Mixed Korean/English→consistent English section names |
| 11 | Worker PLAN.md reference fix | Bug | "PLAN.md"→"mini-plan" |
| 12 | Gate 3 redefinition | Improvement | Agent-as-User (S-items duplicate)→PP Compliance + H-items resolution |

Agent count: 12→10 (critic absorbed + gap/tradeoff integrated, deprecated files deleted) → 12 in v3.2 → **7 in v0.12.2** (mpl-scout, mpl-compound 등 8개 에이전트 통합/삭제)

### Future Roadmap (original — pre v3.1)

| ID | Item | Priority | Status | Description |
|----|------|----------|--------|-------------|
| F-03 | Enhanced per-language LSP integration | MED | **Complete** | Added Step -1 LSP Warm-up (mpl-run-phase0.md). Auto-detect language → eliminate cold start → ast_grep fallback |
| F-04 | Standalone independent operation | **HIGH** | Not implemented | Remove OMC dependency. Auto-configure LSP·MCP via `/mpl:mpl-setup`, diagnose with `mpl-doctor` agent. Grep/Glob fallback if OMC tools (lsp_*, ast_grep) unavailable |
| F-05 | Phase 0 cache partial invalidation | LOW | Not implemented | Re-analyze only changed modules instead of full invalidation |
| F-06 | Multi-project support | LOW | Not implemented | Independent pipeline per project in monorepo environment |

---

## v0.6.7 — 1M Context Parameter Tuning (2026-03-24)

### Summary

v0.6.7 adapts MPL parameters to the Claude Opus 4.6 1M context window (5× increase from ~200K). The micro-phase structure is preserved for its structural benefits (functional isolation, worker consistency, parallel execution, failure containment). Only constants and token budgets are tuned; protocol-level structural changes are deferred to v0.7.0.

### Changes

| ID | Feature | Type | Description |
|----|---------|------|-------------|
| C-01 | **max_total_tokens 900K** | Config | Raise default from 500K to 900K (1M minus ~100K system overhead). Tier-based limits also raised proportionally. |
| C-02 | **Impact file cap 2,000 lines** | Prompt | Raise from 500 to 2,000 lines per file in context assembly. Reduces worker errors from truncated files. |
| C-03 | **Phase 0 token budget increase** | Design guidance | Simple 10K, Medium 18K, Complex 30K (from 8K/12K/20K). More Phase 0 investment = less downstream debugging. |
| C-04 | **Episodic memory 5 phases** | Code | Keep last 5 phases in detail (from 2). Better cross-phase knowledge retention. |

### Affected Files

| File | Change |
|------|--------|
| `mcp-server/src/lib/state-manager.ts` | max_total_tokens: 500000 → 900000 |
| `hooks/lib/mpl-config.mjs` | max_total_tokens: 500000 → 900000 |
| `hooks/lib/mpl-state.mjs` | max_total_tokens defaults + tier-based limits |
| `skills/mpl-setup/SKILL.md` | Config template max_total_tokens |
| `hooks/lib/mpl-memory.mjs` | compressEpisodic default 2→5, loadRelevantMemory slice(-2)→slice(-5) |
| `commands/mpl-run-execute-context.md` | "cap at 500 lines" → "cap at 2000 lines" |
| `docs/design.md` | Version bump, Phase 0 budgets, §8 config, §9 version history |

### v0.7.0 — 1M Context Protocol Restructuring (2026-03-24)

Structural protocol changes leveraging 1M context for richer cross-phase information flow.

| ID | Feature | Type | Description |
|----|---------|------|-------------|
| C-05 | **PD 2-Tier Classification** | Protocol | 3-Tier→2-Tier: Archived tier removed, all PDs kept as Active or Summary. Classification logic rewritten. |
| C-06 | **Sliding Window Cleanup** | Protocol | Immediate release → sliding window (N=3). Last 3 phases retain detailed data (~60-90K tokens). |
| C-07 | **N-1 Phase Context Transfer** | Protocol | Previous phase verification.md + changes.diff forwarded to next phase. Diff capped at 3K tokens. |
| C-08 | **Budget Predictor 1M** | Code | Fallback 200K→1M, safety margin 1.15→1.10. |

### Affected Files

| File | Change |
|------|--------|
| `commands/mpl-run-execute-context.md` | PD 2-Tier logic, N-1 diff/verification context, load_prev_phase_diff |
| `commands/mpl-run-execute.md` | Archived removed, diff saving step 2.5, N-1 context template |
| `commands/mpl-run-execute-parallel.md` | §4.3.7 sliding window cleanup |
| `commands/mpl-run-decompose.md` | PD init Active/Summary only |
| `hooks/lib/mpl-budget-predictor.mjs` | fallback 1M, margin 1.10 |
| `skills/mpl/SKILL.md` | 2-Tier |
| `README.md` | 2-Tier (2 locations) |
| `README_ko.md` | 2-Tier (2 locations) |
| `docs/design.md` | v0.7.0 version bump, all planned notes resolved |

Full analysis: `analysis/mpl-1m-context-impact-analysis.md`

---

## v0.17.0 — Simplification + P1/P2 Hardening Stream (2026-04-21 ~ 2026-04-26)

> Per-version detail lives in `docs/design.md` Section 9. This block is the roadmap-level summary for v0.15.x → v0.16.0 → v0.17 simplification + the merged P1/P2 follow-ups (#80, #82, #84, #87, #88). Released as plugin `0.17.0` on 2026-04-26.

### v0.15.x → v0.16.0 — Documented in design.md

| Release | Theme | design.md anchor |
|---|---|---|
| v0.15.0 (2026-04-19) | Measurement Integrity (AD-0006): gate-recorder + RUNBOOK self-report removal + launch smoke deterministic detection + Anti-rationalization guardrails | `### v0.15.0` |
| v0.15.1 (2026-04-19) | Test-Agent Enforcement (AD-0007): `test_agent_required` field + `mpl-require-test-agent.mjs` hook | `### v0.15.1` |
| v0.15.2 (2026-04-19) | E2E Scenario Enforcement (AD-0008): two-layer scenario design + `mpl-require-e2e.mjs` hook | `### v0.15.2` |
| v0.15.3 (2026-04-19) | QMD Removal Actual Completion: 121 references / 14 files, 2 file deletions, .mcp.json qmd entry removed | `### v0.15.3` |
| v0.16.0 (2026-04-20) | 3-Tier User Contract Architecture: Tier A' UC spec + `mpl_classify_feature_scope` MCP tool + Tier B `covers:[UC-NN]` decomposer field + `mpl-require-covers.mjs` hook + Tier C `@contract(UC-NN)` E2E annotation + `mpl-validate-pp-schema.mjs` hook + `mpl_diagnose_e2e_failure` MCP tool. Zero new agent files. | `### v0.16.0` |

### v0.17 Simplification (#55, ~2026-04-21)

> Pivot from instrumentation accretion back to mechanical minimalism. Removes legacy concepts that empirical runs (ygg-exp10/11) showed had zero downstream effect.

| Concept removed | Replacement / fate |
|---|---|
| Step -1 LSP Warm-up (orchestrator-driven) | Moved to `hooks/mpl-lsp-warmup.mjs` (UserPromptSubmit hook) — out of orchestrator turn |
| Step 0.0.5 Artifact Freshness + Field Classification | REMOVED entirely. `.mpl/manifest.json` no longer generated. |
| Step 0 Triage | REMOVED. `interview_depth` and `pp_proximity` no longer computed. Stage 1 interview always runs to PP completion. |
| Step 1-D PP Confirmation (separate step) | Absorbed into Stage 1.9 (single confirmation gate inside the interview) |
| Step 1-E Interview Snapshot Save | Renumbered to Stage 1.9 (`.mpl/mpl/interview-snapshot.md`) |
| Routing pattern recall (F-22) | DROPPED. `routing-patterns.jsonl` no longer consulted at start. |
| Hat model PP-proximity tier branching | DROPPED. Pipeline depth no longer routes on PP-proximity score. |

Cross-reference: `docs/design.md` §3.2 Flow table carries v0.17 markers row-by-row; `docs/design.md` §9 v0.8.5 entry has a REMOVED banner.

### Post-v0.17 — P1/P2 Hardening Stream (#80, #82, #84, #87, #88) (2026-04-23 ~ 2026-04-26)

5 PRs merged on top of the v0.16.0 baseline + v0.17 simplification. All issue-driven, scoped to specific defects/duplications discovered during v0.16/v0.17 settling.

| PR | Issue | Theme | Impact |
|---|---|---|---|
| #80 | #79 | **P1-3 — MCP session robustness** | 4-in-1 hardening: `MAX_AMBIGUITY_HISTORY=10` ring buffer + per-project TTL override (`session_cache.ttl_minutes`) + 404 auto-invalidate on session expiry + `degraded` flag escalation to user. New tests: state-manager ring buffer (3), TTL override (6), scorer detector + recovery + degraded (11). |
| #82 | #81 | **P1-4d — AP-CHAIN-01 machine enforcement** | New `hooks/mpl-require-chain-assignment.mjs` PreToolUse hook (matcher: Task\|Agent, subagent_type=mpl-seed-generator). Denies dispatch when `chain_seed.enabled=true` ∧ `chain-assignment.yaml` absent. Inline-mode escapes via "AP-SEED-01 exempt per #58" message. 17 tests (helper unit + spawnSync integration). |
| #84 | #83 | **P2-6 — `state.json` schema v2 unification** | Single source: `.mpl/state.json` → `execution` subtree (was split with `.mpl/mpl/state.json`). `CURRENT_SCHEMA_VERSION=2` + auto v1→v2 migration on first read + `detectStateDrift()`. Legacy `.mpl/mpl/state.json` preserved at `.mpl/archive/{pipeline_id}-legacy-execution-state.json`. Ring buffer cap defense-in-depth in `writeState`. 13 tests (migration + drift). |
| #87 | #85 | **P2-7 — Generic cross-project session cache** | New `mcp-server/src/lib/agent-sdk-query.ts` extracts `runCachedQuery<T>` + `isSessionExpiredError` helpers. `feature-classifier.ts` and `e2e-diagnoser.ts` reuse the same cache (`~/.mpl/cache/sessions.json`) — module-level `cachedSessionId` removed in 3 callers. Net code: −187 lines. 11 tests (helper + classifier/diagnoser integration). **Side effect**: P2-8 (separate cache-manager abstraction) is now naturally absorbed; no separate work needed. |
| #88 | — | **docs drift audit** | Manifest.json schema removed from `docs/config-schema.md`. `session_cache.ttl_minutes` added. `docs/design.md` Section 3.2 carries v0.17 marker; v0.8.5 history entry gets REMOVED banner. |

**Test totals at end of stream:**
- Hooks: 287 → 317 pass (+30)
- MCP server: 42 → 73 pass (+31)

**Issues closed this stream:** 4 (#79, #81, #83, #85). #88 is chore-only.

### Decision boundaries (open)

- **Plugin version bump**: ✅ released as `0.17.0` (2026-04-26). 0.18.0 reserved for the next stream (post-exp12 F-25/F-28/F-39 reductions if measurement justifies them).
- **F-25 / F-28 / F-39 future**: 4-Tier Memory + `phase_domain` + `phase_subdomain`/`task_type`/`lang` reduction decisions remain blocked on exp12 measurement (`docs/roadmap/0.16-exp12-plan.md`). Not in scope of this release.

---

## v0.14.2 — QMD Reference Removal (2026-04-15)

4/11 제거 결정에 따라 MPL 전체에서 QMD 참조를 완전히 제거. 17개 파일 편집 + 2개 파일 삭제.

- **Doctor**: Category 11 (QMD Search Engine) 제거, 12→11 카테고리
- **Setup**: Step 3g (QMD 설치/등록), Step 7 (QMD 설정 위저드) 제거
- **Protocol**: `qmd_verified` 성공 기준 타입, Phase 0 QMD 모드 감지, Scout QMD-First 분기 제거
- **삭제**: `hooks/lib/mpl-qmd-verifier.mjs`, `skills/mpl-setup/references/qmd-setup.md`
- **런타임 영향**: 없음 (QMD는 optional이었고 grep fallback이 기본)

---

## v0.13.1 — Post-Smoke-Test Hotfixes: Gate Enforcement + Ambiguity Retry + F-40 Dispatch (2026-04-12)

Patch release capturing 4 bug fixes discovered during the first live pipeline smoke test on specpill (Far/non_pp, 5 UI phases). All fixes address flow control bugs where the orchestrator bypassed or skipped mandatory pipeline stages.

### Fix 1 — Ambiguity Gate Retry Protocol (`ac0a371`)

- Decomposer blocked by ambiguity gate but no auto re-entry to Stage 2. Added Step 3.0 retry protocol: 3 retries with score re-evaluation + force-pass on exhaustion. Prevents permanent stall at `mpl-ambiguity-resolve`.

### Fix 2 — MCP Scoring Session Reuse + Model Upgrade (`b2e6ef2`)

- `mpl_score_ambiguity` created a new MCP session per call (no `sessionId` reuse), causing unnecessary overhead. Added `sessionId` cache. Also upgraded scoring model from haiku to opus for accuracy.

### Fix 3 — Mandatory Gate System Entry (`73a6dca`)

- Gate System (Hard 1/2/3) skipped entirely for Far/non_pp — orchestrator ran manual `npm run build` instead of loading `commands/mpl-run-execute-gates.md`. Added mandatory gate entry with explicit state write + ⚠️ framing after all phases complete.

### Fix 4 — Hard 1 Zero-Check + F-40 Test Agent Dispatch (`8b8833f`)

- Hard 1 auto-passed with zero lint/build tools detected (should FAIL). Added zero-check defensive FAIL.
- F-40 Test Agent dispatched 0 times across 5 UI phases despite being mandatory. Added "NEVER SKIP" enforcement in execute protocol.

---

## v0.13.0 — Complete v0.13.0 Feature Set: AD Chain + E2E Awareness + Strategy Generation (2026-04-12)

Minor version bump consolidating the full v0.13.0 feature set from the 2026-04-12 session. Includes 3 post-v0.12.4 features that complete the v0.13.0 roadmap targets.

### Post-v0.12.4 additions (AD-03 / AD-04 / AD-07 / HA-06)

- **AD-03** (`9fdfff7`): Fix Loop reflection tag harvesting — `commands/mpl-run-finalize.md` Step 5.2.6 item 4a globs `attempt-*.md` reflection files, extracts pattern classification tags, appends to `procedural.jsonl`. Mechanical regex extraction, no LLM. Closes #17.
- **AD-04** (`0ad09d8`): PP-file modification sentinel hook — new `hooks/mpl-sentinel-pp-file.mjs` PostToolUse hook watches Edit/Write against `pivot-points.md` file references. Non-blocking additionalContext injection. Session-cached PP list. 6 tests. Closes #18.
- **AD-07** (`e288cad`): Fix Loop strategy generation on stagnation — new Step 4.6.2 in execute-gates. Orchestrator reads prior reflections + phase0 artifacts → synthesizes `strategy_override` JSON (alternative_approach + must_not_do + phase0_hint). Replaces hardcoded generic suggestions. Closes #21.
- **HA-06** (`c4c6bcc`): Interview-driven E2E awareness (tool-agnostic) — Phase 0 detects E2E infra (playwright/cypress/custom/puppeteer/selenium), orchestrator asks user if E2E needed (only when detected, zero overhead otherwise), decomposer generates E2E S-items. No Playwright dependency. Closes #23.

### v0.13.0 complete feature list

All v0.13.0 targets resolved:
- #14 AD-01 Contract Coverage ✅ (v0.12.4)
- #15 AD-02 Hard 3 Auto-Pass Removal ✅ (v0.12.4)
- #17 AD-03 Reflection Tag Harvest ✅
- #18 AD-04 PP-File Sentinel ✅
- #19 AD-05 L2 Value-Path Verification ✅ (v0.12.4)
- #21 AD-07 Fix Loop Strategy ✅
- #23 HA-06 E2E Awareness ✅

**Open issues: 5** (all backlog: #2, #3, #5, #12, #22).

---

## v0.12.4 — Contract Coverage + AD-05 L2 Verification + Pattern Detection (2026-04-12)

Feature release that closes the Hard 3 structural gap identified by cb-phase-a1 (37% D2 leak at M1=1/M2=ON) and introduces the first EXPERIMENTAL pattern detection pipeline. Also completes Advisory Gate vestigial cleanup and resolves the PR-02/03/04 architectural deadlock via 3-agent debate.

### Part 1 — AD-01/AD-02: Contract Coverage Mandatory + Hard 3 Fail-on-Missing (`35bf332`)

- **`contract_files` required** in decomposer schema (`agents/mpl-decomposer.md` Rule 5a, Step 6.5). Every phase must enumerate cross-layer boundaries.
- Orchestrator Writes contract JSON to `.mpl/contracts/` during decomposition post-processing (`commands/mpl-run-decompose.md` Step 3 item 2a).
- **Hard 3 auto-pass removed** — missing `.mpl/contracts/` directory is now a FAIL, not a silent pass. This was the exact chain that let C2 (0/15) and C3 (0/13) shared omission defects through.
- Closes #14, #15.

### Part 2 — AD-05: L2 Parameter Value-Path Verification (`ae9e019`)

- Hard 3 extended from L1 key-set diff to L1 + L2 value-path check (`commands/mpl-run-execute-gates.md` Step 5).
- For each contract param, grep verifies the param name appears at the caller's actual call site (±3 lines of callee invocation).
- Targets the 37% D2 leak: contract key exists on both sides (L1 passes) but caller never passes the parameter.
- Violation types: `l2_param_not_passed`, `l2_callee_not_invoked`.
- Closes #19 (priority elevated from cb-phase-a1 empirical evidence).

### Part 3 — AD-0005: PR-02/03/04 Pattern Placement Decision (`000e24e`)

- 3-agent debate (Pro/Con/Mutant) converged 3:0 after 2 rounds.
- **PR-02 Security Pattern → EXPERIMENTAL**: decomposition-time artifact (Step 9.6.1 `risk_patterns[]`) + Hard 1 Step 0 cross-check. Non-blocking metric recording. HARD promotion gated on CB testbed ≥3/5 detection.
- **PR-03 UI Hardcoding → DROP**: count-based threshold incompatible with binary 3H architecture.
- **PR-04 Resource Lifecycle → LOST**: pair detection needs separate AD for `pair_pattern` mechanism.
- Mutant reframing: "which gate?" → "which pipeline stage?" — decomposition-time artifact following AD-01 `contract_files` precedent.

### Part 4 — PR-02 EXPERIMENTAL Implementation (`db6d37d`)

- `agents/mpl-decomposer.md` Step 9.6.1 + `risk_patterns[]` schema field.
- `commands/mpl-run-decompose.md` Step 3 item 2b: `default_risk_patterns` (5 security rules: eval, API keys, SQL concat, innerHTML, weak crypto).
- `commands/mpl-run-execute-gates.md` Hard 1 Step 0 "Pattern Risk Check" (non-blocking, metrics to `.mpl/mpl/pattern-metrics.jsonl`).
- Closes #27.

### Part 5 — Advisory Gate Vestigial Cleanup (`f5709f0`)

- Removed `advisory_result`/`advisory_passed` from runtime state, MCP schema, phase-controller HUD, execute-gates protocol.
- "3H+1A" → "3H" everywhere in current-state docs. Historical changelog entries preserved.
- Closes #25.

### Part 6 — Cleanup + Corrections

- `2d78c07`: Removed `coverage_thresholds`/`cluster_ralph` phantom validation from `agents/mpl-doctor.md` Category 8 (closes #10, #11).
- `443be37`: Corrected HA-05 status from "✅ Implemented" to "⚠ Partial" in v0.12.0 version history row.
- #23 (HA-06): Re-homed from Advisory Gate to finalize Step 5.0 E2E Test after #25 removed the gate. Issue body + labels updated.

### Commits (7 + version bump)

```
f5709f0  cleanup(gates): remove vestigial advisory_result / advisory_passed fields
443be37  docs(roadmap): correct HA-05 status to PARTIAL in v0.12.0 version history
2d78c07  cleanup(doctor): remove unused cluster_ralph / coverage_thresholds validation
35bf332  feat(contracts): mandatory contract_files + Hard 3 fail-on-missing (AD-01/AD-02)
000e24e  docs: add AD-0005 — PR-02/03/04 mechanical pattern placement (3-agent debate)
db6d37d  feat(patterns): PR-02 EXPERIMENTAL security pattern detection (AD-0005)
ae9e019  feat(hard3): L2 parameter value-path verification — closes 37% D2 leak (#19)
```

### Issues closed this release

| # | Title | Commit |
|---|---|---|
| #10 | coverage_thresholds cleanup | `2d78c07` |
| #11 | cluster_ralph cleanup | `2d78c07` |
| #14 | AD-01 Contract Coverage Mandatory | `35bf332` |
| #15 | AD-02 Hard 3 Auto-Pass Removal | `35bf332` |
| #19 | AD-05 Hard 3 parameter-level verification | `ae9e019` |
| #25 | Advisory vestigial field removal | `f5709f0` |
| #27 | PR-02 EXPERIMENTAL pattern detection | `db6d37d` |

**Breaking changes:** Hard 3 no longer auto-passes on missing `.mpl/contracts/`. Existing projects must have the decomposer generate `contract_files` for each phase (AD-01). Projects with zero boundaries get a `_no-boundaries.json` placeholder.

---

## v0.12.3 — Forensic Repair + HA-03 Restoration + ADR Batch (2026-04-11~12)

Cleanup + restoration release that repairs the structural damage from v0.12.2's incomplete cleanup commit (`4903a8d`) while ratifying three key architectural decisions as Accepted ADRs and producing the first full 4-dimension reconciliation audit of MPL's codebase.

**This release ships no new user-facing features.** It is a structural repair release plus decision-record consolidation, produced after a session audit found that v0.12.2's "stale agent cleanup" left the F-40 Mandatory Independent Verification dispatch path *active-broken* (runtime probe confirmed hard error: `Agent type 'mpl-test-agent' not found`).

### Part 1 — AD-0003 partial revert + dispatch graph cleanup

- **Restored `agents/mpl-test-agent.md`** (155 lines including 28 lines of HA-02 Adversarial Verification content) via `git checkout 4903a8d^ -- agents/mpl-test-agent.md`. Targeted restore — does NOT undo the legitimate doc updates from `4903a8d`, does NOT re-introduce `mpl-ambiguity-resolver.md` (valid MCP migration stands).
- **F-40 dispatch graph is now clean**. Both dispatch sites (`commands/mpl-run-execute.md:511`, `commands/mpl-run-execute-gates.md:154`) resolve to the restored agent.
- **Legacy ambiguity-resolver dispatch hints** at `hooks/mpl-phase-controller.mjs:130,141-142,150-151,181` and `hooks/mpl-ambiguity-gate.mjs:6,82,94` and `commands/mpl-run-phase0.md:485-495` rewritten to reference the `mpl_score_ambiguity` MCP-tool inline loop directly, matching runtime reality. Zero functional change.
- **Validator schema drift** in `hooks/mpl-validate-output.mjs:35,59-64` cleaned up — `mpl-ambiguity-resolver` moved from `VALIDATE_AGENTS` expected list to the deleted-agent negative-assertion set. 16/16 validate-output tests pass post-refactor.
- **Stale comment** at `hooks/lib/mpl-state.mjs:87` rewritten from "written by orchestrator after mpl-ambiguity-resolver completes" to "written via `mpl_state_write` after the inline `mpl_score_ambiguity` MCP tool loop reaches `threshold_met`".

### Part 2 — HA-03 Probing Hints producer restoration

- **Producer re-homed** to `agents/mpl-decomposer.md` Step 9.5 (new reasoning step). Content restored verbatim from git archaeology at `agents/mpl-phase-seed-generator.md` commit `a60320e^` (v0.12.1 pre-deletion):
  - Phase domain → hint table (api/db, algorithm, ui-WebView, ui-SSR, infra, general)
  - Platform constraint table (tauri.conf.json, electron-builder.json, next.config.js)
  - Fallback rule (omit field when no hints determinable)
- **Output schema** in decomposer extended with `probing_hints:` array field in the `phases:` block.
- **HA-03 is now FULLY ACTIVE**. Consumer at `agents/mpl-test-agent.md:140-142` was a silent dead-check before this release — it read a field that no active agent wrote. Producer + consumer are now synchronized.

### Part 3 — HA-02 canonical extraction

- **New file**: `prompts/modules/adversarial-verification-ha02.md` (60 lines) — canonical source for the HA-02 Adversarial Verification prompt block (5 self-rationalization anti-patterns + structured Test/Expected/Actual/Verdict output format + Probing Hints directive).
- **Synchronized copy** at `agents/mpl-test-agent.md:118-152` now wrapped in `<!-- HA-02 BEGIN v0.12.0 -->` / `<!-- HA-02 END v0.12.0 -->` markers with a sync-rule HTML comment.
- **Sync discipline**: both copies must change in lockstep. Single-file edits are a policy violation (grep-detectable via the markers).
- **Purpose**: prepares HA-02 for mechanical inlining into `mpl-phase-runner` if AD-0004 Gate 1 Option B experiment authorizes it — prevents copy-paste drift across future consumers.

### Part 4 — ADR batch (AD-0002, AD-0003, AD-0004 accepted)

Three Accepted ADRs landed:

| ID | Title | Purpose |
|---|---|---|
| **AD-0002** | CB cross-boundary features are bound to the cb-testbed ablation experiment | Codifies "experiment beats debate" for CB family. Permanently rejects CB-02/03 restoration on experimental grounds; defers CB-04 pending M3 re-measurement; ratifies #19 AD-05 priority elevation with empirical backing (37% D2 leak at M1=1 M2=ON). |
| **AD-0003** | v0.12.2 accidental agent deletion — partial revert for mpl-test-agent | Forensic evidence chain for `4903a8d` incomplete cleanup. Decides partial revert for `mpl-test-agent.md` only; ambiguity-resolver deletion ratified as valid MCP migration. Architectural path (Options A/B/C/D) deferred to AD-0004. |
| **AD-0004** | Test Agent long-term architecture — Option A baseline with conditional Option B experiment | Recommended path: keep Option A (status quo post-revert) as operational baseline, with a single decision gate (Option B empirical test) that can promote B if inline role-switching recovers L2/L3 detection. Options C and D explicitly deferred as premature. |

AD-0005 slot reserved for PR-02/03/04 architectural deadlock (requires separate debate session).

### Part 5 — 4-dimension reconciliation audit

- **`~/project/wiki/scratch/2026-04-12/mpl-reconciliation-audit.md`** (635 lines) — produced via 4 sequential Explore agent dispatches with `file:line` evidence for every claim. No `docs/*.md` or `wiki/**/*.md` cited as authority.
- **Dimension 1** (Agent Registry): 8 active agents, 11 dispatch sites all valid, 3 MCP tools, zero dangling runtime refs post-repair.
- **Dimension 2** (Feature × Implementation Matrix): 24 features verdicted. HA-03 ACTIVE after restoration, HA-05 upgraded NEVER MERGED → PARTIAL after unlabeled survivor at `agents/mpl-phase0-analyzer.md:280-326` was found. PR-02/PR-04 remain LOST (AD-0005 reserved).
- **Dimension 3** (Experimental Evidence Integration): cb-phase-a1 findings mapped per feature. M2 dominance (Δ=-2.17) validates CB-06. C2/C3 = 0 structural blindness validates HA-02/HA-03 restoration. 37% leak → AD-05 priority elevation confirmed. Load-bearing caveat: F-40 runtime effectiveness unmeasured (macOS `timeout` bug in cb-testbed).
- **Dimension 4** (Architecture + Phase Internal Structure): triangulation collapse analysis (3 intended observers → 2 current), 4 restoration paths evaluated, Option A + conditional B recommended.
- **Decision matrix §8** with 4 action classes; 5 items executed in v0.12.3, others tracked as next-session work (fresh-session F-40 probe, #25 advisory cleanup, AD-0005 debate, Option B experiment).

### Part 6 — GitHub backlog infrastructure

- **qmd MCP server** added to `.mcp.json` — second MCP server alongside `mpl-server`, provides local markdown search over 162 documents across 11 collections. Closes #24.
- **Issue #26 created and closed**: HA-03 producer restoration tracker.
- **Issue #25 created (open)**: advisory_result / advisory_passed vestigial field removal — implementation follow-up to #13 Option B resolution.
- **Issue #19 priority ELEVATED** with empirical evidence (37% D2 leak table, L1/L2/L3 hierarchy, cb-phase-a1 report citation). Title rewritten to `[feature] AD-05: Hard 3 parameter-level verification — closes 37% M2 leak`.
- **Issue #13 closed** (Option B: remove advisory vestigial fields).
- **Issue #20 closed won't-fix** (AD-06 feedback loop rejected on same empirical grounds as #13).

### Files changed (primary)

| Category | Files |
|---|---|
| Restored | `agents/mpl-test-agent.md` (155 lines via targeted git checkout) |
| Modified | `agents/mpl-decomposer.md` (+35 lines HA-03 Step 9.5), `agents/mpl-test-agent.md` (sync markers), `hooks/mpl-phase-controller.mjs`, `hooks/mpl-ambiguity-gate.mjs`, `hooks/mpl-validate-output.mjs`, `hooks/__tests__/mpl-validate-output.test.mjs`, `hooks/lib/mpl-state.mjs`, `commands/mpl-run-phase0.md`, `docs/design.md` (§4 footnote), `.mcp.json` |
| New ADRs | `docs/decisions/AD-0002-cb-features-bound-to-ablation-experiment.md`, `docs/decisions/AD-0003-v012.2-accidental-agent-deletion.md`, `docs/decisions/AD-0004-test-agent-long-term-architecture.md` |
| New module | `prompts/modules/adversarial-verification-ha02.md` |
| Version bump | `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `mcp-server/package.json`, `mcp-server/package-lock.json`, `README.md`, `README_ko.md`, `docs/design.md` title, `docs/config-schema.md` version field |

**Breaking changes**: NONE. The partial revert re-enables a previously active-broken code path; the cleanup commits are zero-functional-change refactors; the ADRs are documentation.

**Known carry-over work to v0.12.4 or later**:
- Fresh-session F-40 runtime probe (cannot be verified from the same session that performed the revert)
- `#25` advisory_result vestigial field removal (implementation of #13 Option B decision)
- `AD-0005` PR-02/03/04 architectural deadlock (requires separate Pro/Con/Mutant debate session)
- `AD-0004` Gate 1 Option B experiment (requires cb-testbed-equivalent environment + M3 macOS `timeout` fix)
- `#19` AD-05 Hard 3 parameter-level verification implementation (blocked on #14 AD-01 + #15 AD-02 prerequisites)
- HA-05 auto-injection half restoration (conditional on AD-0004 path decision)

---

## v0.12.2 — Docs Consistency + MCP Server First-Install Hotfix (2026-04-10~11)

Two-part release. Part 1 (2026-04-10) cleans up stale v2 agent references. Part 2 (2026-04-11) ships a first-install hotfix so the `mpl-server` MCP tools work out of the box on fresh plugin installs.

### Part 1 — Docs Consistency + Stale Agent Cleanup

- 2 stale agent files deleted: `mpl-ambiguity-resolver`, `mpl-test-agent`
- Agent count corrected 8→7 in `docs/design.md`
- Deleted-agent references updated across 8 doc files
- Version bump 0.12.1 → 0.12.2 across `plugin.json`, `marketplace.json`, READMEs, `docs/config-schema.md`
- `docs/config-schema.md` added to `skills/mpl-version-bump/SKILL.md` checklist

### Part 2 — MCP Server First-Install Hotfix

**Problem**: On fresh plugin install the cached plugin directory (`~/.claude/plugins/cache/mpl/mpl/<version>/`) contains `mcp-server/src/` but not `dist/` or `node_modules/`. The `.mcp.json` declares `${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js`, which resolves correctly but the file does not exist — so `/mcp` reports "Failed to reconnect to mpl-server" and agents lose `mpl_score_ambiguity`, `mpl_state_read`, `mpl_state_write`.

**Fix**: `hooks/mpl-session-init.mjs` now runs `ensureMcpServerBuilt()` on every SessionStart. When `dist/index.js` or `node_modules/@modelcontextprotocol` are missing, it spawns a **detached** `npm install && npm run build` inside the plugin's `mcp-server/` directory, writes a `.build-lock` to prevent re-entry (5-min TTL), streams progress to `.build.log`, and emits a one-time `systemMessage` telling the user to reconnect via `/mcp` once the background build finishes. The already-built path is a true no-op — zero filesystem touches.

| File | Change |
|------|--------|
| `hooks/mpl-session-init.mjs` | +62 lines: `ensureMcpServerBuilt()`, wired into both the no-rotation and rotation-resume return paths |
| `hooks/hooks.json` | SessionStart timeout `5s` → `10s` (spawn + lock write headroom) |

**Resolution path for plugin-root**: `PLUGIN_ROOT` is resolved from `import.meta.url` (`dirname(fileURLToPath(...))`), not env var — works identically whether the hook runs from the dev repo (`/Users/.../project/MPL/`) or the marketplace cache (`~/.claude/plugins/cache/mpl/mpl/<version>/`).

---

## v0.12.1 — v2 Completion: Agent Deletion + Terminology Cleanup (2026-04-04)

Completes the v2 structural transition started in v0.11.0:

- **7 agent files deleted**: mpl-code-reviewer, mpl-compound, mpl-phase-seed-generator, mpl-pre-execution-analyzer, mpl-qa-agent, mpl-scout, mpl-verification-planner
- **v1→v2 terminology migration** across 38 files: `gate1/2/3` → `hard1/2/3`, `pipeline_tier` → `pp_proximity`, `5-Gate` → `3H+1A Gate`
- **routing-patterns backward compat**: `p.proximity || p.tier` fallback
- **MCP dist rebuild**: TypeScript schema aligned with v2 state (ambiguity_score, advisory_result)
- **Version history annotations**: Deleted agent paths marked *(removed in v0.11.0)*

---

## v0.12.0 — Harness Analysis Adoption: Adversarial Verification + Platform Safety (2026-03-31)

### Summary

v0.12.0 adopts 5 features from cross-analysis of Claude Code's Coordinator architecture (instructkr/claude-code) and Anthropic's "Harness Design for Long-Running Apps" blog post. All changes are prompt/schema-level — no structural changes to the pipeline. Key theme: preventing the self-evaluation failure pattern (exp5 B-1~B-3) through adversarial verification and platform-aware MND generation.

### Changes

| ID | Feature | Type | Description |
|----|---------|------|-------------|
| HA-01 | **Synthesis-First Delegation** | Prompt | Core Rule #5 in orchestrator: 4 lazy delegation anti-patterns prohibited |
| HA-02 | **Adversarial Verification Prompt** | Prompt | Test Agent: 5 self-rationalization anti-patterns + structured output (Test/Expected/Actual/Verdict) + probing hints processing |
| HA-03 | **Seed Probing Hints** | Schema | `probing_hints` optional field in phase_seed.yaml — domain-specific + platform constraint adversarial testing hints |
| HA-04 | **Export Manifest Warnings** | Schema | `warnings` field in Phase Runner output + State Summary section + orchestrator Step 5.5 processing |
| HA-05 | **Seed Self-Verification + Platform MND** | Prompt | 5-item self-verification checklist + auto-injection of platform-specific MND from config file detection (Tauri, Electron, Next.js) |

### Source Analysis

- `analysis/instructkr-claude-code-analysis.md` — Claude Code Coordinator deep-dive
- `analysis/anthropic-harness-design-longrunning.md` — Anthropic blog analysis
- `analysis/mpl-adoption-candidates-debate.md` — 10 candidates, 2-phase debate per candidate

---

## v0.11.0 — Gate 3H+1A + Hat Model + Agent Consolidation (2026-03-31)

### Summary

v0.11.0 is the v2 Phase 2 release: restructures gates to 3 Hard + 1 Advisory, replaces the pipeline tier system (frugal/standard/frontier) with the Hat model (PP-proximity), removes Cluster Ralph, and consolidates agents from 17 to 8.

### Changes

| ID | Feature | Type | Description |
|----|---------|------|-------------|
| GATE-01 | **3 Hard + 1 Advisory Gates** | Structural | Gate 0.5 (types) demoted to Advisory. Gate 1 (tests), Gate 2 (review), Gate 3 (PP) are Hard (blocking). Gate 1.5 (coverage) and Gate 1.7 (browser QA) removed. |
| HAT-01 | **Hat Model (PP-proximity)** | Structural | Replaces frugal/standard/frontier tiers with Light/Standard/Full hats. Pipeline depth determined by PP-proximity score instead of file-count-based pipeline_score. |
| HAT-02 | **PP Classification** | Enhancement | Pivot Points classified by proximity impact to determine hat level. |
| HAT-03 | **Floor Guarantee** | Enhancement | Each Hat level has a minimum gate guarantee (Floor). Light: Gate 1, Standard: Gate 1+2, Full: all 3 Hard Gates. |
| CLUST-01 | **Cluster Ralph Removal** | Removal | Cluster Ralph feature-scoped verify-fix loop removed. Config section deleted. |
| AGT-02 | **Agent Deletion (8 agents)** | Removal | Removed: Ambiguity Resolver, Phase 0 Analyzer, Pre-Execution Analyzer, Verification Planner, Test Agent, Git Master, QA Agent, Phase Seed Generator. |
| AGT-03 | **Phase Runner Consolidation** | Merge | Phase Runner absorbs Test Agent responsibilities (code author + test writer in single agent). |
| AGT-04 | **Decomposer Consolidation** | Merge | Decomposer absorbs Phase Seed Generator responsibilities. |
| AGT-05 | **Interviewer Consolidation** | Merge | Interviewer absorbs Ambiguity Resolver responsibilities. |
| - | **Maturity Mode Removal** | Removal | `maturity_mode` config option removed. Gate thresholds are now fixed. |

### Agent Count: 17 → 8

| Remaining | Absorbed Into | Removed |
|-----------|--------------|---------|
| Interviewer (+ Ambiguity Resolver) | — | Ambiguity Resolver |
| Codebase Analyzer | — | Phase 0 Analyzer |
| Decomposer (+ Phase Seed Generator) | — | Pre-Execution Analyzer |
| Phase Runner (+ Test Agent) | — | Verification Planner |
| Code Reviewer | — | Test Agent |
| Scout | — | Git Master |
| Compound | — | QA Agent |
| Doctor | — | Phase Seed Generator |

---

## v0.10.0 — Mechanical Boundary Foundation (2026-03-29)

| ID | Item | Status | Description |
|----|------|--------|-------------|
| KT-01 | **Channel Registry** | ✅ **v0.10.0 complete** | 9 registered knowledge channels in Principle 5. Unregistered channels prohibited. decomposition.yaml, phase-decisions.md, contracts/*.json, phase-seed.yaml, pivot-points.md, state-summary.md, regression-suite.json, phase0/*.md, export-manifest.json |
| CB-L0 | **Adjacent Contracts** | ✅ **v0.10.0 complete** | Decomposer interface_contract includes adjacent_contracts field (inbound/outbound references to N-1/N+1 phase contracts) |
| SEED-01 | **Seed Input Extension** | ✅ **v0.10.0 complete** | Seed Generator receives .mpl/contracts/*.json for current + adjacent phases |
| SEED-02 | **Seed Output Extension** | ✅ **v0.10.0 complete** | contract_snippet field in phase-seed.yaml with inbound/outbound key-type pairs |
| SEED-03 | **Seed Schema Validation** | ✅ **v0.10.0 complete** | mpl-validate-seed.mjs hook validates required fields + contract_snippet structure |
| SNT-S0 | **Seed Fact-Check** | ✅ **v0.10.0 complete** | mpl-sentinel-s0.mjs verifies contract_snippet keys ⊆ contracts/*.json. Catches LLM hallucination |
| SNT-S1 | **Runner Manifest Validation** | ✅ **v0.10.0 complete** | mpl-sentinel-s1.mjs validates export-manifest.json symbols exist in generated files |
| SNT-S3 | **Test Import Validation** | ✅ **v0.10.0 complete** | mpl-sentinel-s3.mjs validates Test Agent import paths resolve to actual files |
| CB-L1 | **L1 Hard Gate** | ✅ **v0.10.0 complete** | L1 Diff Guard upgraded from advisory to Hard Gate. Boundary mismatches block Phase completion |

---

## v0.9.4 — Pre-v2 Cleanup (2026-03-29)

| ID | Item | Status | Description |
|----|------|--------|-------------|
| - | **Worker Agent Removal** | ✅ **v0.9.4 complete** | mpl-worker.md deleted. All references updated to mpl-phase-runner. Worker unused since v0.6.0 |
| - | **Principle 1 Rename** | ✅ **v0.9.4 complete** | "Orchestrator-Worker Separation" → "Orchestrator–Phase Runner Separation" |
| - | **Principle 5 Update** | ✅ **v0.9.4 complete** | "Knowledge Accumulation" → "Knowledge Accumulation via Channel Registry" |
| - | **Version Notation** | ✅ **v0.9.4 complete** | Added v3.x ≈ v0.3.x mapping note. design.md uses v0.x.y exclusively |

---

## v0.6.6 — Integration Checkpoints + Agent Model Optimization (2026-03-23)

### Summary

v0.6.6 adds intermediate E2E verification at feature group boundaries, preventing accumulated errors across many phases.

### Changes

| ID | Feature | Type | Description |
|----|---------|------|-------------|
| B-04 | **Integration Checkpoints** | Decomposer + Phase Runner | Decomposer inserts checkpoint phases at feature boundaries (every 3 vertical slices, CORE→EXTENSION transition). Checkpoints run full build + test suite + smoke test + feature-specific integration scenarios. Non-blocking skip for Frugal/Standard tiers. |

### Affected Files

| File | Change |
|------|--------|
| `agents/mpl-decomposer.md` | Rule 12: checkpoint insertion + schema + integration_tests |
| `commands/mpl-run-execute.md` | Checkpoint phase handling (skip Seed, direct execution) |
| `agents/mpl-phase-runner.md` | Checkpoint mode: execute integration_tests instead of TODO plan |

---

## v0.6.5 — Vertical Slice Decomposition + Cross-Layer Contracts (2026-03-23)

### Summary

v0.6.5 switches multi-layer projects from horizontal decomposition to vertical slice decomposition, preventing cross-layer contract failures.

### Changes

| ID | Feature | Type | Description |
|----|---------|------|-------------|
| B-03 | **Vertical Slice Decomposition** | Decomposer rule | Multi-layer projects (2+ layers) decompose by feature/vertical slice, not by layer. Each phase implements one feature across all layers. Contract-first architecture decision added to Phase 0. 5-Level success criteria (Static→Build→Unit→Contract→Runtime). |

### Affected Files

| File | Change |
|------|--------|
| `agents/mpl-decomposer.md` | Vertical slice rule + 5-Level criteria + multi-layer detection |
| `agents/mpl-phase-seed-generator.md` | Vertical slice TODO structure + cross-layer acceptance_link |
| `commands/mpl-run-phase0-analysis.md` | Architecture Decision: cross-layer contract strategy |
| `agents/mpl-phase-runner.md` | Cross-layer verification in Step 4 |

---

## v0.6.4 — Protocol File Split (2026-03-23)

### Summary

v0.6.4 splits oversized protocol files to reduce per-step token consumption. Pure refactoring — no behavioral changes.

### Changes

| ID | Feature | Type | Description |
|----|---------|------|-------------|
| R-01 | **Protocol File Split** | Refactor | `mpl-run-execute.md` (1,663→4 files), `mpl-run-phase0.md` (1,337→3 files), `mpl-run-finalize.md` (538→2 files). Max file size reduced from 1,663 to ~500 lines. |

---

## v0.6.3 — Build & Runtime Verification Hardening (2026-03-23)

### Summary

v0.6.3 addresses 5 verification gaps discovered in Yggdrasil 27-phase test: build tool failures, cross-layer mismatches, deferred architecture decisions, missing runtime checks, and stub code acceptance.

### Changes

| ID | Feature | Type | Description |
|----|---------|------|-------------|
| B-02 | **Multi-Stack Build Verification** | Gate 0.5 (v1) enhancement. *v2: Advisory Gate* | Auto-detect and run ALL project build tools (npm, cargo, go, python, etc.). |
| B-02 | **Cross-Layer Contract Test** | New verification type | Validate IPC/API type alignment between frontend and backend layers. |
| B-02 | **Architecture Decision Enforcement** | Phase 0 extension | Mandatory architecture decisions for detected patterns (DB path, IPC protocol, auth). |
| B-02 | **Runtime Verification** | Phase Runner extension | Dev server startup check after static verification passes. |
| B-02 | **Anti-Stub Criteria** | Decomposer + Phase Runner | Success criteria must verify behavioral output, not just file existence. |

---

## v0.6.2 — Zero-Test Gate Enforcement (2026-03-23)

### Summary

v0.6.2 fixes the blind spot where Gate 1 reported 100% pass rate with 0 tests. Mandatory test enforcement for core domains.

### Changes

| ID | Feature | Type | Description |
|----|---------|------|-------------|
| B-01 | **Zero-Test Detection** | Gate 1 enhancement | Gate 1 detects and rejects 0-test scenarios for mandatory domains (ui, api, algorithm, db, ai). |
| B-01 | **Test Agent Dispatch Enforcement** | Orchestrator checkpoint | Mandatory check after Phase Runner returns — forces Test Agent dispatch if no tests exist. |
| B-01 | **Phase Runner Self-Test** | Phase Runner extension | Write basic tests before returning "complete" if no tests exist for mandatory domains. |

---

## v0.6.1 — Nested Agent Limitation Fix (2026-03-23)

### Summary

v0.6.1 resolves the nested agent limitation where Phase Runner could not spawn worker subagents. Phase Runner now implements directly as full executor.

---

## v0.6.0 — 2-Pass Decomposition + Phase Seed + 2-Level Parallelism (2026-03-22)

### Summary

v0.6.0 introduces Phase Seeds — per-phase immutable specifications generated just-in-time. This is the largest structural change since v3.0, replacing ad-hoc mini-plan generation with deterministic, auditable execution specifications.

### Changes

| ID | Feature | Type | Description |
|----|---------|------|-------------|
| D-01a | **2-Pass Decomposition** | Structural | Decomposer Pass 1 produces skeleton (order + deps + scope). New `mpl-phase-seed-generator` (sonnet) produces per-phase Seeds just-in-time with concrete TODO structure, acceptance mapping, embedded Phase 0 context, and formal exit conditions. |
| D-01b | **TODO Parallel Graph** | Enhancement | Seed's `depends_on` + `files_to_modify` enable pre-planned Worker parallelism. F-13 runtime detection → Seed-based pre-planning. |
| D-01c | **Phase Parallel Execution** | Structural | CORE phases: always sequential. EXTENSION/SUPPORT phases: parallel in worktree isolation when no file overlap. Decomposer outputs `execution_tiers` with parallel flags. |

### New Agent

| Agent | Role | Model |
|-------|------|-------|
| `mpl-phase-seed-generator` | Generate immutable Phase Seed per phase with TODO structure + acceptance mapping | sonnet |

### New Steps

| Step | Name | When |
|------|------|------|
| 4.0 | Execution Tier Dispatch | Before phase loop — routes to parallel or sequential |
| 4.0.5 | JIT Phase Seed Generation | Before each Phase Runner — generates Seed |

### Affected Files

| File | Change |
|------|--------|
| `agents/mpl-phase-seed-generator.md` | NEW — Phase Seed generation agent |
| `agents/mpl-decomposer.md` | execution_tiers + Step 11 + failure mode |
| `agents/mpl-phase-runner.md` | Layer 3.5 + Step 2 dual mode + exit condition evaluation |
| `commands/mpl-run-execute.md` | Step 4.0 tier dispatch + Step 4.0.5 JIT seed + context + prompt |

### Migration (0.5.1 → 0.6.0)

Breaking changes: NONE. Phase Runner has Legacy fallback when Seed absent. Rollback: `phase_seed: { enabled: false }` in config.json.

---

## v4.1 — MCP Server Tier 1: Deterministic Scoring + Active State (2026-03-22)

### Summary

v4.1 introduces the MPL MCP Server, eliminating LLM scoring variance and enabling agents to actively query pipeline state.

### Changes

| ID | Feature | Type | Description |
|----|---------|------|-------------|
| M-01 | **MCP Server Tier 1** | New server | 3 MCP tools: `mpl_score_ambiguity` (5D scoring via haiku API temp 0.1 + code computation), `mpl_state_read` (active state query for agents), `mpl_state_write` (atomic state update). TypeScript + @modelcontextprotocol/sdk, stdio transport. All tools have graceful fallback when server unavailable. |

### Architecture

```
MPL/mcp-server/
├── src/index.ts              # Server entry + tool registration
├── src/tools/scoring.ts      # mpl_score_ambiguity
├── src/tools/state.ts        # mpl_state_read + mpl_state_write
├── src/lib/state-manager.ts  # Ported from hooks/lib/mpl-state.mjs
└── src/lib/llm-scorer.ts     # Anthropic API scoring (haiku, temp 0.1)
```

### New Files

| File | Purpose |
|------|---------|
| `mcp-server/` | Complete MCP server (TypeScript, compiled to dist/) |
| `.mcp.json` | MCP server registration for Claude Code |

### Key Design Decisions

- **haiku for scoring**: ~$0.001/call, sufficient accuracy at temp 0.1, 10x cheaper than sonnet
- **Code-computed weighted sum**: LLM scores dimensions, but weighted average is deterministic code
- **Graceful fallback**: All tools degrade to existing behavior when MCP unavailable
- **State port**: `state-manager.ts` is a TypeScript port of `hooks/lib/mpl-state.mjs` with identical schema

---

## v4.0 — Feasibility Defense, Browser QA, PR Creation (2026-03-22)

### Summary

v4.0 adds verification depth: catching infeasible specs earlier, validating UI in real browsers, and automating PR creation.

### Changes

| ID | Feature | Type | Description |
|----|---------|------|-------------|
| T-11 | **Feasibility 2-Layer Defense** | Agent extension | **Layer 1**: Stage 2 PP Conformance Check extended with `INFEASIBLE` classification. Checks API availability, constraint compatibility, tech viability, scope via Grep/Glob on codebase — catches ~80% of feasibility issues during interview at zero additional cost. **Layer 2**: Decomposer `go_no_go` extended with `RE_INTERVIEW` signal + `re_interview_questions` field. Safety net for Phase 0-dependent issues. |
| T-03 | **Browser QA (Gate 1.7)** (v1) | New agent + Gate | New `mpl-qa-agent` validates UI via Chrome MCP tools. Gate 1.7 inserted between Gate 1.5 and Gate 2. **Non-blocking** — issues defer to Step 5.5. Graceful skip when Chrome MCP unavailable. *v2: Gate 1.5/1.7 제거됨. Advisory Gate로 이동 가능.* |
| T-04 | **PR Creation (Step 5.4b)** | Agent extension + Step | `mpl-git-master` extended with PR creation mode (`pr_creation: true`). Creates feature branch, pushes, opens PR via `gh pr create` with Gate evidence + deferred items in body. Optional, activated by config or prompt keywords. |

### New Agent

| Agent | Role | Model |
|-------|------|-------|
| `mpl-qa-agent` | Browser QA — validates UI via Chrome MCP, reports console errors, accessibility, element presence | sonnet |

### Affected Files

| File | Change |
|------|--------|
| `agents/mpl-ambiguity-resolver.md` | INFEASIBLE classification + feasibility scan + question template |
| `agents/mpl-decomposer.md` | RE_INTERVIEW go_no_go + re_interview_questions + Step 10.5 |
| `commands/mpl-run-decompose.md` | RE_INTERVIEW handling |
| `agents/mpl-qa-agent.md` | NEW — Browser QA agent |
| `commands/mpl-run-execute.md` | Gate 1.7 Browser QA |
| `agents/mpl-git-master.md` | PR creation mode |
| `commands/mpl-run-finalize.md` | Step 5.4b PR Creation |

---

## v3.9 — Autonomous Execution, Phase Lock, Budget Pause (2026-03-22)

### Summary

v3.9 focuses on autonomous execution — reducing mid-pipeline human interruptions and improving session resilience.

### Changes

| ID | Feature | Type | Description |
|----|---------|------|-------------|
| T-10 | **Post-Execution Review (Step 5.5)** | Protocol extension | H-items now have severity (HIGH/MED/LOW). Gate 3 only blocks on HIGH H-items; MED/LOW are deferred to Step 5.5 post-execution review report. Step 5.0 Final Side Interview removed (absorbed into 5.5). Users review deferred items once at the end, not mid-pipeline. |
| T-01 P2 | **Phase-Scoped File Lock** | Hook + new parser | New `mpl-decomposition-parser.mjs` extracts per-phase file scopes from decomposition.yaml. `mpl-write-guard` checks if Edit/Write targets are within the current phase's declared scope. Soft warning (non-blocking) on out-of-scope writes. |
| F-33 | **Session Budget Prediction** | Predictor + protocol | `writeSessionHandoff()` added to budget predictor. Step 4.8 Graceful Pause Protocol: calls predictBudget() after each phase, writes handoff signal on "pause_now". Watcher docs added. Completes the predict→pause→signal→resume loop. |

### Affected Files

| File | Change |
|------|--------|
| `agents/mpl-verification-planner.md` | H-item severity field (HIGH/MED/LOW) + criteria table |
| `commands/mpl-run-execute.md` | Gate 3 severity filter + Step 4.8 Graceful Pause |
| `commands/mpl-run-finalize.md` | Step 5.5 Post-Execution Review + watcher docs |
| `hooks/lib/mpl-decomposition-parser.mjs` | NEW — YAML parser for phase scope extraction |
| `hooks/mpl-write-guard.mjs` | Phase-scoped file lock check |
| `hooks/lib/mpl-budget-predictor.mjs` | writeSessionHandoff() function |

---

## v3.8 — Safety, Core-First Ordering, Compaction Recovery (2026-03-22)

### Summary

v3.8 adds three low-risk, high-value improvements focused on safety, decomposition quality, and session resilience.

### Changes

| ID | Feature | Type | Description |
|----|---------|------|-------------|
| T-01 | **Dangerous Command Detection** | Hook extension | `mpl-write-guard` now intercepts Bash tool calls containing dangerous patterns (rm -rf, git push --force, DROP TABLE, kubectl delete, etc.). Safe cleanup patterns (rm -rf node_modules) are allowlisted. Soft warning (same as Edit/Write guard). |
| T-12 | **Core-First Phase Ordering** | Decomposer prompt | New Step 4.5 in decomposer: classify phases as CORE/EXTENSION/SUPPORT based on PP connection. Within dependency-equivalent tiers, sort CORE → EXTENSION → SUPPORT. Ensures core functionality is verified first; sub-feature failures don't affect core. |
| F-31 | **Compaction Recovery Read-Side** | Protocol extension | Compaction checkpoints (created by PreCompact hook since v3.2) are now loaded during context assembly (Case 2: after compaction) and injected into Phase Runner context. Resume protocol also checks for checkpoints. Completes the write→read loop. |

### Stage 2 Redesign (PP-Aligned Spec Resolution)

Also included in this release: Stage 2 (Ambiguity Resolver) redesigned to treat PPs as immutable inputs.

| Change | Before | After |
|--------|--------|-------|
| PP mutability | Stage 2 could update PP.judgment_criteria | **PPs are never modified by Stage 2** |
| Pre-resolution | Jump straight to Socratic questions | **PP Conformance Check**: auto-resolve items derivable from PP + context |
| Scoring dimensions | 4D (Spec/Edge/Tech/Testability) | **5D** (+PP Conformance: detects choices conflicting with PPs) |
| PP conflicts | Not tracked | **PP_CONFLICT** items raise ambiguity score; user chooses PP-first or exception |
| Output | Updated PPs + requirements | **PP-aligned spec** (PPs unchanged) + requirements |

### Affected Files

| File | Change |
|------|--------|
| `hooks/mpl-write-guard.mjs` | Added Bash dangerous command detection (9 patterns + 8 safe allowlist) |
| `hooks/hooks.json` | PreToolUse matcher: `Edit\|Write` → `Edit\|Write\|Bash` |
| `agents/mpl-decomposer.md` | Step 4.5 (feature priority), `feature_priority` output field, failure mode |
| `agents/mpl-ambiguity-resolver.md` | Full rewrite: PP immutability, PP Conformance Check, 5D scoring |
| `commands/mpl-run-execute.md` | Checkpoint loading in Case 2 + Phase Runner recovery context section |
| `commands/mpl-run-finalize.md` | Checkpoint-aware resume in Step 6 |
| `docs/design.md` | Version bump, Stage 2 description + agent catalog updated |

---

## v3.7 — 2-Stage Interview Redesign (2026-03-15)

### Design Direction

v3.7 fundamentally redesigns the interview pipeline. It transitions from the existing "4 rounds for PP confirmation → PP dimension re-measurement" structure to "value-centered PP discovery → metrics-based ambiguity resolution loop".

> Inspired by Ouroboros's AmbiguityScorer: metrics, not structure (rounds), determine questions.
> Ambiguity is re-measured after each response, and the weakest dimension is automatically targeted.

### Key Changes

| Change | Before (v3.6) | After (v3.7) |
|--------|--------------|-------------|
| **Stage 1 question framing** | Technical category classification ("What is the core identity?") | User value/scenario centered ("What can the user do?") |
| **Stage 2 agent** | `mpl-weak-interviewer` (PP 5-dimension re-measurement) | `mpl-ambiguity-resolver` (PP orthogonal 4-dimension metrics loop) |
| **Stage 2 dimensions** | Goal/Boundary/Priority/Criteria/Context (PP redundant) | Spec Completeness/Edge Case/Technical Decision/Acceptance Testability (PP orthogonal) |
| **Termination condition** | Question count soft limit | `ambiguity <= 0.2` (80% clarity) quantitative threshold |
| **AskUserQuestion options** | Word/short description | Contrast-Based: gain/sacrifice + concrete scenario examples |
| **Technical choice questions** | Present options immediately | Pre-Research Protocol: present comparison table first, then ask |

### New Protocols

- **Pre-Research Protocol**: Before questions with technology selection trade-offs, collect comparison materials via WebFetch/Read → present comparison table → ask. Applied in both Stage 1 and Stage 2.
- **Contrast-Based Options**: All AskUserQuestion options must include "what do you gain and what do you sacrifice" + concrete examples.
- **Spec Reading Step**: At start of Stage 2, compare provided spec/documents with PP to identify gap/conflict/hidden constraints.

### Affected Files

| File | Change |
|------|--------|
| `agents/mpl-interviewer.md` | Rewrite 4 rounds as value-centered + Pre-Research Protocol |
| `agents/mpl-ambiguity-resolver.md` | New (replaces mpl-weak-interviewer) |
| `agents/mpl-weak-interviewer.md` | Deleted |
| `commands/mpl-run-phase0.md` | Update Stage 2 reference |
| `docs/design.md` | Update agent catalog |
| `hooks/mpl-validate-output.mjs` | Update agent name + verification keywords |

---

## Planned Versions (revised 2026-03-29)

> **Note**: v0.6.7/v0.7.0은 1M context adaptation으로 구현 완료. 원래 해당 버전에 계획되었던 미구현 기능들은 v0.8.0 이후로 재배정.

| Version | Features | Type |
|---------|----------|------|
| ~~**0.8.0**~~ | ~~V-01 Cluster Ralph + V-02 Lint Gate + V-03 TSConfig Strict + V-04 Config Schema + V-05 Scope Drift Report~~ | ✅ **Implemented** |
| ~~**0.8.1**~~ | ~~#1 alt Ref files + TS-03 Regression + Round 1-T Test Strategy + Step 8.6 E2E framework~~ | ✅ **Implemented** |
| ~~**0.9.0**~~ | ~~PR-01~05 Prompt Reinforcement + F-E2E-1/1b/1c E2E Fallback~~ | ✅ **Implemented** |
| ~~**0.9.1**~~ | ~~CB-01~04 Cross-Boundary Detection (Boundary Pair Scan + Rule 8 + Gate 0.7 + Mock Gap)~~ | ✅ **Implemented** |
| ~~**0.9.2**~~ | ~~CB-05~07 Cross-Boundary Enforcement (boundary_check output + Contract Snippet + Post-Join Reconciliation)~~ | ✅ **Implemented** |
| **0.9.3** | LT-01 Contract Changes + LT-03a Contract Verification Gate + LT-04 Multi-Resolution Summary | Feature: contract & summary |
| ~~**0.9.4**~~ | ~~Pre-v2 Cleanup: Worker Agent Removal + Principle 1/5 Rename + Version Notation~~ | ✅ **Implemented** |
| ~~**0.9.5**~~ | ~~T-05 Design Contract + T-06 Doc Sync~~ | T-05 Dropped (Seed 대체), T-06 → v1.0.1 |
| ~~**Experiment**~~ | ~~T-02 Same-model dual review~~ | Dropped (Always-On Judge 흡수, codex-plugin-cc) |
| ~~**0.10.0**~~ | ~~Mechanical Boundary Foundation: Channel Registry + Adjacent Contracts + Seed Extension + Sentinels + L1 Hard Gate~~ | ✅ **Implemented** |
| ~~**0.10.1**~~ | ~~MCP Path Fix: .mcp.json args `${CLAUDE_PLUGIN_ROOT}` prefix~~ | ✅ **Implemented** |
| ~~**0.10.2**~~ | ~~T-11 Skill Quality Polish: Description trigger hints (3-tier) + deprecated stub + setup split~~ | ✅ **Implemented** |
| ~~**v0.11.1**~~ | ~~MCP Server dependency recovery in mpl-setup~~ | ✅ **Implemented** |
| ~~**v0.11.0**~~ | ~~v2 Phase 2: Gate 3H+1A + Hat+Floor + Agent 17→8~~ | ✅ **Implemented** |
| ~~**v0.12.0**~~ | ~~HA-01~05: Adversarial Verification + Platform MND + Probing Hints + Warnings + Synthesis-First~~ | ⚠ **Partial** (HA-01/02/03/04 ACTIVE; HA-05 PARTIAL — platform detection survives at `agents/mpl-phase0-analyzer.md:280-326`, auto-injection of `phase_seed.yaml constraints` field + 5-item self-verification checklist LOST. Gated on AD-0004 path per 2026-04-12 audit §8.B #3.) |
| ~~**v0.12.4**~~ | ~~Contract Coverage + AD-05 L2 Verification + PR-02 EXPERIMENTAL + Advisory Cleanup + AD-0005 Debate~~ | ✅ **Implemented** |
| ~~**v0.13.0**~~ | ~~AD-03/04/07 + HA-06 E2E Awareness + Full v0.13.0 feature set~~ | ✅ **Implemented** |
| ~~**v0.13.1**~~ | ~~Post-smoke-test hotfixes: ambiguity retry, gate enforcement, F-40 dispatch, Hard 1 zero-check~~ | ✅ **Implemented** |
| **v1.0.0** | v2 Phase 3: Always-On Judge (codex-plugin-cc) + Runner/Test 분리 + L2 | 🟠 Planned |
| **v1.0.1** | T-06 Doc Sync (Finalize 확장) | 🟡 Post-v2 |
| **v1.1.0** | T-08 Trend Retro + P-04 Skill Audit | 🟡 Post-v2 |
| **Dropped** | T-05, TS-01/02, BM-04, F-269, T-09, F-06 | v2 대체 또는 수요 부재 |

---

## v3.2 Roadmap — "Documents as Memory + Adaptive Routing" (2026-03-07)

### Design Direction

v3.2 evolves along two axes:

**Axis 1: Documents as Memory** — Continuity between sessions and executions

> The success of long-running agents comes not from model intelligence but from **operational structure**.
> — [Run long-horizon tasks with Codex](https://www.linkedin.com/posts/gb-jeong_run-long-horizon-tasks-with-codex-activity-7435825294554484736-hBEX)

**Axis 2: Adaptive Pipeline Routing** — Users don't judge complexity

> Resolves the paradox where lightweight task entry barriers increase as MPL grows more complex.
> Inspired by Ouroboros's PAL Router (Progressive Adaptive LLM Router),
> integrates 3 skills (mpl/mpl-small/mpl-bugfix) into **single entry point + automatic tier classification + dynamic escalation**.
> — [Ouroboros](https://github.com/Q00/ouroboros) analysis (2026-03-07)

#### 4-Document Mapping (Axis 1)

| Reference document | Role | MPL equivalent | Status |
|-------------------|------|---------------|--------|
| `docs/prompt.md` | Goal/non-goal, freeze completion criteria | `pivot-points.md` | ✅ Present |
| `docs/plans.md` | Acceptance criteria + verification commands per milestone | `decomposition.yaml` | ✅ Present |
| `docs/implement.md` | plans as SSOT, scope expansion prohibited | `mpl-run.md` (orchestrator protocol) | ✅ Present |
| `docs/documentation.md` | Audit log, continuity between sessions | **Missing** → newly created as `RUNBOOK.md` | ❌ Not implemented |

MPL already has strong documents 1~3, but is lacking 4 — "audit log combined with shared memory". Current State Summary is fragmented per phase, and there is no integrated document for humans or next-session agents to grasp at a glance "how far we've come and why these decisions were made".

#### Adaptive Pipeline Router (Axis 2) — Problem and Solution

**Current problem**: 3 skill branches depend on user keywords.

```
"mpl bugfix" → mpl-bugfix (minimal pipeline)
"mpl small"  → mpl-small  (3-Phase lightweight)
"mpl"        → mpl full   (9+ step full)
```

| Problem | Detail |
|---------|--------|
| User judgment dependency | Must decide in advance "is this small or full?" |
| Duplication with Triage | full's Triage (Step 0) already analyzes information density, but small bypasses it |
| No escalation | Start small → complex → circuit break → user must re-run full |
| No downgrade | Start full → actually simple → full 9+ step overhead |
| Token gap | No optimal path between bugfix (~5-10K) ↔ small (~15-25K) ↔ full (~50-100K+) |

**Solution**: Adapt Ouroboros PAL Router approach to MPL.

```
Before: User selects from 3
  "mpl bugfix: fix login error"         → mpl-bugfix
  "mpl small: add validation"           → mpl-small
  "mpl: refactor auth system"           → mpl full

After: System auto-determines + dynamic switching
  "mpl fix login error"                 → Triage → Frugal (≈bugfix)
  "mpl add validation"                  → Triage → Standard (≈small extended)
  "mpl refactor auth system"            → Triage → Frontier (≈full)
  (automatic escalation on circuit break during execution)
```

---

### All Items

#### HIGH — Core Architecture

| ID | Item | Status | Description |
|----|------|--------|-------------|
| F-20 | **Adaptive Pipeline Router — Single Entry Point** (v1) | ✅ **S1 complete** | Extend Triage (Step 0) to auto-calculate `pipeline_tier` (v1; v2: `pp_proximity`로 대체) (frugal/standard/frontier). Measure affected file count, test presence, import depth via Quick Scope Scan. Determine tier via `pipeline_score` formula. *v2: Hat model(pp_proximity)로 대체. frugal/standard/frontier → Light/Standard/Full hat.* **Ouroboros PAL Router reference** |
| F-21 | **Dynamic Escalation/Downgrade** (v1) | ✅ **S1 complete** | Automatic tier switching during execution. *v2: escalateTier 제거됨. Hat model에서 escalation 구조 변경.* |
| F-10 | **RUNBOOK.md — Integrated Execution Log** | ✅ **S1 complete** | Introduce `docs/documentation.md` concept to MPL. Auto-update Current Status, Milestone Progress, Key Decisions, Known Issues, How to Resume sections in `.mpl/mpl/RUNBOOK.md` during pipeline execution. Anyone — human or agent — can grasp current status and resume immediately from this single file |
| F-11 | **Run-to-Run Learning Accumulation** | ✅ **S2 complete** | RUNBOOK decisions/issues distilled via orchestrator finalize *(was mpl-compound, removed v0.11.0)* to `.mpl/memory/learnings.md` on execution completion. Auto-loaded in next execution Phase 0. Accumulates failure patterns (type confusion, error mismatch), success patterns, project conventions (discovered). **Flow**: Record in RUNBOOK during execution → finalize distillation → next Phase 0 reference |
| F-12 | **In-session Context Persistence** | ✅ **S2 complete** | Orchestrator marks key state (current phase, PP summary, last failure cause) with `<remember priority>` tags at each phase transition. Dual safety net of RUNBOOK.md (file-based) and `<remember>` (tag-based) to handle context compression during long executions |
| F-04 | Standalone independent operation | ✅ **S4 complete** | (existing) OMC dependency removed. Grep/Glob fallback |

#### MEDIUM — Execution Efficiency and UX

| ID | Item | Status | Description |
|----|------|--------|-------------|
| F-22 | **Routing Pattern Learning** | ✅ **S2 complete** | Append execution results (task description, tier, success, token usage) to `.mpl/memory/routing-patterns.jsonl`. Recommend initial tier in next execution Triage by comparing against previous patterns via Jaccard similarity (≥0.8). Separate file from F-11 learnings.md — learnings is technical lessons, routing-patterns is cost optimization data. **Ouroboros DowngradeManager reference** |
| F-13 | **Background Execution** | ✅ **S3 complete** | Parallel execution of workers for independent TODOs without file conflicts using `run_in_background: true` within Phase Runner. Combined with v3.1 file conflict detection to auto-enforce sequential execution on conflicts |
| F-14 | **AskUserQuestion HITL** | ✅ **existing implementation** | `AskUserQuestion` tool used in `mpl-interviewer` PP interview + Side Interview. Clickable options improve HITL response speed |
| F-15 | **Worktree Isolated Execution** | ✅ **S5 complete** | Execute phases with risk=HIGH in Pre-Execution Analysis with `isolation: "worktree"`. Merge on success, auto-cleanup on failure. Partial rollback not needed on circuit break. Activated only in Frontier tier |
| F-16 | **~~mpl-scout agent~~** *(removed v0.11.0, absorbed by orchestrator)* | ✅ **S4 complete** | Haiku-based lightweight codebase exploration — functionality absorbed by orchestrator direct search. Originally: Phase 0 structure analysis, Fix Loop root cause exploration, Phase Runner context assistance. **"Seeing like an Agent" Progressive Disclosure reference** |
| F-17 | **lsp_diagnostics_directory integration** | ✅ **S4 complete** | Project-wide type check before Gate 1 auto tests. Active when tool_mode=full, fallback to `tsc --noEmit` / `python -m py_compile` in standalone |
| F-23 | **Phase Runner Task-based TODO management** | ✅ **S3 complete** | Phase Runner manages TODOs via Task tool instead of mini-plan.md checkboxes. Cross-worker dependency tracking, automatic parallel execution state sync. Current mini-plan.md pattern has same limitation as Claude Code's early TodoWrite — model gets trapped in list and inter-agent communication is impossible. Synergy with F-13 (Background Execution): dispatch independent TODOs as parallel Tasks. **"Seeing like an Agent" TodoWrite→Task lesson reference** |
| F-24 | **Phase Runner Self-Directed Context** | ✅ **S3 complete** | Allow Phase Runner scope-bounded search to directly explore needed context. Current: orchestrator assembles context then injects ("given context"). Improvement: provide only impact files list, Phase Runner directly Read/Grep actual content. Scope-bounded search within that phase's impact range to maintain isolation principle. **"Seeing like an Agent" RAG→self-directed search lesson reference** |
| F-25 | **4-Tier Adaptive Memory** | ✅ **S5 complete** | Synthesis of RUC DeepAgent Memory Folding + Letta (MemGPT) OS paradigm + latest memory research ("Memory in the Age of AI Agents", 2025.12). Expand State Summary to 4-tier memory: `.mpl/memory/episodic.md` (completed Phase summary, time-based compression — recent 2 phases detailed, earlier in 1-2 lines), `semantic.md` (project knowledge generalizing 3+ repeated patterns), `procedural.jsonl` (tool usage patterns, with classification tags), `working.md` (current Phase TODOs). Auto-integration episodic→semantic: on repeated pattern detection, abbreviate in episodic + save generalization in semantic. Selective Phase 0 loading: similarity-based filtering of relevant memory only, not entire files. 70%+ token savings + additional 20-30% Phase 0 time reduction for repeated projects. Synergy with F-11 (learnings.md): auto-distill procedural.jsonl → learnings.md. Complement with F-24 (Self-Directed Context): prioritize effective tools via procedural.jsonl reference. **DeepAgent comparison + Letta + "Memory in the Age of AI Agents" reference** |

#### MEDIUM — Research-Based New (2026-03-13)

| ID | Item | Status | Description |
|----|------|--------|-------------|
| F-26 | **mpl-interviewer v2: Socratic integrated interview** | ✅ **S6 complete** | Extend existing mpl-interviewer to **integrate PP discovery + requirements structuring into a single interview**. Auto-adjust PM role scope by `interview_depth` (skip/light/full). **skip**: direct PP extraction + **Uncertainty Scan** (5-dimension uncertainty check → targeted questions for HIGH items only). **light**: Round 1-2 + lightweight requirements. **full**: Socratic 6 types + solution options 3+ + JUSF. Question limit is **soft limit** — at limit, user chooses continue/stop via **Continue Gate**. On stop, remaining uncertainty tagged as **Deferred Uncertainties** with PP PROVISIONAL + registered for Side Interview for just-in-time resolution during execution. AI_PM Socratic approach adapted. Dual-Layer output (YAML+Markdown). MoSCoW + sequence_score. self-improvement via good/bad examples. **Ouroboros "From Wonder to Ontology" inspiration: uncertainty exists even in detailed documents** — pm-design.md, mpl-interviewer.md reference |
| F-27 | **Reflexion-based Fix Loop learning** | ✅ **S6 complete** | Add structured self-reflection step when entering Fix Loop. Reflexion (NeurIPS 2023) + MAR (Multi-Agent Reflexion) patterns applied. **Reflection Template**: failed TODO → symptom → root cause → first deviation point → correction strategy → learning extraction. Classify reflection results by pattern (type_mismatch, dependency_conflict, test_flake, etc.) and store in procedural.jsonl. Selectively load only relevant patterns in next execution Phase 0 based on task description similarity. Integrate mpl-code-reviewer feedback into reflection on Gate 2 failure (MAR pattern). HumanEval pass@1 +8.1% improvement record (Reflexion). Direct synergy with F-25 (procedural.jsonl). **Reflexion + MAR paper reference** |
| F-28 | **Per-phase dynamic agent routing** | ✅ **S6 complete** | Dynamically adjust worker prompt/model based on Phase characteristics. Currently same agent assigned to all Phases → auto-select domain-specialized prompts per Phase. TDAG (Task Decomposition and Agent Generation) pattern reference. Example: DB schema Phase → DB-specialized prompt, UI Phase → design-aware prompt, complex algorithm Phase → opus model. Add `phase_domain` tag to Decomposer output → Phase Runner selects matching prompt. **TDAG + Anthropic model routing recommendations reference** |

#### Full Scope Implementation (2026-03-14)

| ID | Item | Status | Description |
|----|------|--------|-------------|
| F-35 | **Full Scope Implementation** | ✅ **complete** | Ensure MPL implements the full scope of a given spec. **4 core changes**: (1) Remove Decomposer's Max Phases hard cap → change to Typical Phases guideline, remove "core function" scoping. (2) Mandatory interview — remove `skip` interview_depth, guarantee minimum `light` (Round 1+2). High-density prompts (density ≥8) also run light + Uncertainty Scan. (3) Side Interview triggered only for CRITICAL + PP conflicts. H-items, AD markers and other non-blocking items logged to `deferred-items.md`. (4) Add insight to Interviewer: interview quality = reduced Side Interview frequency. **Changed files**: `mpl-decomposer.md`, `mpl-run-decompose.md`, `mpl-run-execute.md`, `mpl-run-phase0.md`, `mpl-interviewer.md` |

#### Plan-Phase Compaction Prevention (2026-03-14)

| ID | Item | Status | Description |
|----|------|--------|-------------|
| F-36 | **Plan-Phase Context Offloading** | ✅ **complete** | Prevent compaction in Plan stage (Step 0~3B). **3 changes**: (1) Delegate Step 2 Codebase Analysis to `mpl-codebase-analyzer`(sonnet) subagent (~5-10K savings). (2) Delegate Step 2.5 Phase 0 Enhanced to `mpl-phase0-analyzer`(sonnet) subagent (~8-25K savings). (3) Step 1-E Interview Snapshot — backup key results to `.mpl/mpl/interview-snapshot.md` after interview completion for restoration after compaction. Orchestrator Plan stage tokens: ~29-65K → ~11-16K. **Changed files**: `mpl-run-phase0.md`, new agents `mpl-codebase-analyzer.md`, `mpl-phase0-analyzer.md` |

#### 2-Phase Interview (2026-03-14)

| ID | Item | Status | Description |
|----|------|--------|-------------|
| F-37 | **Clarity Reinforcement (2-Phase Interview)** | ✅ **complete** | Add weak dimension reinforcement (Phase 2) after PP-based interview (Phase 1). Apply OMC Deep Interview's mathematical ambiguity score concept to MPL PP framework. **Core**: 5-Dimension Clarity Scoring (Goal/Boundary/Priority/Criteria/Context, weighted sum) → targeted reinforcement questions for dimensions below 0.6 → PP update. Differentiated Greenfield/Brownfield weights. Infer unrun light rounds from responses. Question limit: 2 for light, 4 for full. **Changed files**: `mpl-interviewer.md`, `mpl-run-phase0.md` |

#### Auto Context Rotation (2026-03-14)

| ID | Item | Status | Description |
|----|------|--------|-------------|
| F-38 | **Auto Context Rotation** | ✅ **complete** | Automatic session rotation when context window is nearly full. Detect compaction event → write handoff signal → send `/clear` via terminal backend (kitty/tmux/osascript) → auto-resume pipeline. Configurable via `mpl-setup`. **Files**: `hooks/lib/rotation-backends.mjs` (terminal backend abstraction), `hooks/lib/mpl-rotator.mjs` (background watcher), `hooks/mpl-session-init.mjs` (SessionStart hook), `hooks/mpl-compaction-tracker.mjs` (modified: write handoff signal), `hooks/hooks.json` (modified: SessionStart registration). **Config**: `.mpl/config.json` → `context_rotation.backend` |

#### Semi-TDAG 4-Layer Template (2026-03-15)

| ID | Item | Status | Description |
|----|------|--------|-------------|
| F-39 | **Semi-TDAG 4-Layer Template Composition** | ✅ **complete** | Extend F-28 domain routing to 4 layers. Decomposer outputs 3 additional optional fields: `phase_subdomain` (tech stack), `phase_task_type` (work type), `phase_lang` (language). Phase Runner combines `domains/` + `subdomains/{domain}/` + `tasks/` + `langs/` 4-Layer prompts and injects into worker context. Total 38 predefined templates: 8 domains + 19 subdomains (react, nextjs, vue, svelte, graphql, websocket, trpc, nosql, orm-prisma, orm-drizzle, langchain, vercel-ai, raw-sdk, optimization, data-structure, docker, cicd, e2e, unit) + 6 task types (greenfield, refactor, migration, bugfix, performance, security) + 5 languages (rust, go, python, typescript, java). Balance stability and flexibility with "dynamic prompt template composition" instead of TDAG pattern's "dynamic agent generation". Each layer is optional — skip that layer if file is missing (F-28 backward compatible). |

#### Compaction Resilience (based on 2026-03-12 experiments)

| ID | Item | Status | Description |
|----|------|--------|-------------|
| F-30 | **Error Context File Preservation** | ✅ **S5 complete** | Preserve full error text in `.mpl/mpl/phases/phase-N/errors/` file on Worker failure. Fix loop converges with accurate error info even after compaction. Phase Runner writes error file, orchestrator receives only the path |
| F-31 | **Compaction-Aware Context Recovery** | ✅ **v3.8 complete** | Create `.mpl/mpl/checkpoints/compaction-{N}.md` checkpoint in PreCompact hook. Warn at 3 compaction_count, recommend session reset at 4+. Write-side (PreCompact hook) + Read-side (Context Assembly Case 2 + Phase Runner injection + Step 6 resume). Full write→read loop complete |
| F-32 | **Adaptive Context Loading** | ✅ **S5 complete** | Assess context state at phase transition and 3-way branch load amount: same session (minimal load) / after compaction (selective load+checkpoint) / new session (full load). Compaction detection via `last_phase_compaction_count` field |
| F-33 | **Session Budget Prediction & Auto-Continue** | ✅ **v3.9 complete** | Predict remaining Phase budget based on HUD context_window data at Phase completion. Graceful pause when insufficient → create `.mpl/signals/session-handoff.json`. predictBudget + writeSessionHandoff + Step 4.8 Graceful Pause + watcher docs. Full predict→pause→signal→resume loop complete |

#### Sprint 5-6 New Features

| ID | Item | Related files | Sprint |
|----|------|--------------|--------|
| F-34 | Auto-Permission Learning | `mpl-auto-permit.mjs`, `mpl-permit-learner.mjs` | Sprint 5 |
| F-40 | Test Agent Mandatory | Gate 1 requires mpl-test-agent | Sprint 6 |
| F-50 | ~~Gate 1.5 Coverage~~ (v1) | Coverage threshold gate. *v2: Gate 1.5 제거됨* | Sprint 6 |

#### LOW — Maintenance

| ID | Item | Status | Description |
|----|------|--------|-------------|
| F-05 | Phase 0 cache partial invalidation | ✅ **S5 complete** | Re-analyze only changed modules based on git diff. `analyzePartialInvalidation()` + `partialCacheSave()` implemented |
| F-06 | Multi-project support | Not implemented | Independent pipeline per project in monorepo environment |

---

### Adaptive Pipeline Router Detailed Design (F-20, F-21, F-22) — (v1)

> **⚠ v2 이후 Deprecated**: Hat model(pp_proximity)로 대체됨. pipeline_tier → pp_proximity, frugal/standard/frontier → Light/Standard/Full hat, escalateTier 제거. 역사적 참조용.

#### Pipeline Score Formula (v1)

Calculated after Quick Scope Scan in Triage (Step 0):

```
pipeline_score = (file_scope × 0.35) + (test_complexity × 0.25)
               + (dependency_depth × 0.25) + (risk_signal × 0.15)

file_scope:       min(affected_files / 10, 1.0)
test_complexity:  min(test_scenarios / 8, 1.0)
dependency_depth: min(import_chain_depth / 5, 1.0)
risk_signal:      keyword_hint or prompt analysis (0.0~1.0)
```

Quick Scope Scan completes in ~1-2K tokens using only Glob/Grep. A lightweight version of the existing Step 2 codebase analysis.

#### 3-Tier Pipeline Mapping (v1; v2: Hat model)

| Tier | Score | Execution steps | Skipped | Expected tokens |
|------|-------|----------------|---------|----------------|
| **Frugal** (< 0.3) | Simple bug fix, 1-2 files | Bug Analysis → Fix → Gate 1 → Commit | Triage, PP, Phase 0, Decomposition, Gate 2/3 | ~5-15K |
| **Standard** (0.3~0.65) | Small feature, 3-5 files | Triage(skip) → PP(light) → Phase 0(Error Spec) → single Phase → Gate 1 → Commit | Full PP, Phase 0 Step 1-3, Decomposition (multi-phase), Gate 2/3 | ~20-40K |
| **Frontier** (> 0.65) | Complex task, 6+ files | Full 9+ step pipeline | None | ~50-100K+ |

User hint override: `"mpl bugfix"` → force tier to frugal, `"mpl small"` → force standard. Auto-calculated if no hint.

#### Dynamic Escalation Protocol (v1; v2: escalateTier 제거)

```
[Frugal] ──circuit break──→ [Standard] ──circuit break──→ [Frontier]
                              │                              │
                              ├─ Preserve completed TODOs    ├─ Preserve completed phases
                              ├─ Restructure failed TODOs    ├─ Failed phase → phase5-finalize
                              │  as single Phase             │
                              └─ PP extraction (light)       └─ Full PP + Phase 0
```

Record `escalation_history` in state.json on escalation:

```json
{
  "pipeline_tier": "standard",  // v1; v2: pp_proximity로 대체
  "escalation_history": [       // v1; v2: escalateTier 제거
    {"from": "frugal", "to": "standard", "reason": "circuit_break", "preserved_todos": 3}
  ]
}
```

#### Routing Pattern File Format (F-22)

```jsonl
{"ts":"2026-03-07T10:00:00Z","desc":"add validation to endpoint","tier":"standard","result":"success","tokens":32400,"files":4}
{"ts":"2026-03-07T11:30:00Z","desc":"fix typo in error message","tier":"frugal","result":"success","tokens":8200,"files":1}
{"ts":"2026-03-07T14:00:00Z","desc":"refactor auth module","tier":"frontier","result":"success","tokens":87000,"files":12}
{"ts":"2026-03-07T15:00:00Z","desc":"add input sanitization","tier":"frugal","escalated":"standard","result":"success","tokens":28000,"files":3}
```

Matching via Jaccard similarity (tokenized intersection/union, threshold 0.8):

```
new_task: "add email validation to signup endpoint"
match:    "add validation to endpoint" (similarity=0.83) → tier=standard recommended
```

---

### Full Flow Diagram

```
Entry (keyword-detector)
├── "mpl" detected → single skill entry                      [F-20]
└── hint extraction (bugfix→frugal, small→standard, none→auto)

Triage (Step 0) — extended
├── Information density analysis → interview_depth
├── Quick Scope Scan (Glob/Grep, ~1-2K tokens)               [F-20]
│   ├── affected file count
│   ├── test presence check
│   └── import depth sampling
├── routing-patterns.jsonl matching (previous pattern reference) [F-22]
├── pipeline_score calculation → pipeline_tier (v1→pp_proximity) [F-20]
└── .mpl/memory/learnings.md load                            [F-11]

PP + Requirements Integrated Interview (Step 1) — mpl-interviewer v2  [F-26, F-35]
├── Interview always runs (skip removed, minimum light)       [F-35]
├── Auto scope adjustment by interview_depth
│   ├── light (density ≥ 8): Round 1-2 (PP) + Uncertainty Scan (target questions for HIGH only)
│   ├── light (density 4-7): Round 1-2 (PP) + lightweight requirements structuring
│   └── full: Socratic questions + 3+ options + PP + JUSF output
├── Continue Gate: user choice (continue/stop) when soft limit reached
├── Deferred Uncertainties: PP PROVISIONAL + Side Interview registration on stop
├── Dual-Layer output: YAML frontmatter + Markdown body
├── Gherkin AC → Test Agent input
└── Self-improvement via good/bad examples archive

Pre-Execution (Phase 0) — branch by tier
├── Frugal:  Error Spec only → single Fix Cycle
├── Standard: Error Spec + light PP → single Phase
├── Frontier: Full Phase 0 → multi-Phase
├── Structure analysis via orchestrator search (was mpl-scout) [F-16]
├── lsp_diagnostics_directory type check                      [F-17]
├── 4-Tier Memory selective load                              [F-25]
│   ├── semantic.md (project knowledge)
│   ├── procedural.jsonl (relevant patterns only, similarity filter)
│   └── episodic.md (previous execution summary)
└── prompt selection based on phase_domain tag                [F-28]

During Execution (Phase 1~N)
├── RUNBOOK.md real-time update                               [F-10]
├── <remember priority> tags for compaction resilience        [F-12]
├── Background Execution (parallel independent TODOs)         [F-13]
├── AskUserQuestion (Side Interview HITL)                     [F-14]
├── Worktree isolation (HIGH risk phases)                     [F-15]
├── Automatic escalation on circuit break                     [F-21]
│   └── Frugal→Standard→Frontier (completed work preserved)
├── Orchestrator search (Fix Loop root cause exploration)      [F-16]
└── Reflection Template execution on Fix Loop entry           [F-27]
    ├── failure cause → root cause → correction strategy → learning extraction
    └── pattern classification → procedural.jsonl storage

Post-Execution (Finalize)
├── Append execution result to routing-patterns.jsonl         [F-22]
├── RUNBOOK decisions/issues → memory/learnings.md distillation [F-11]
├── episodic.md update → promote to semantic.md after 3+ repetitions [F-25]
├── procedural.jsonl → learnings.md auto-distillation         [F-25]
└── 4-tier memory + patterns auto-referenced in next execution Phase 0
```

### RUNBOOK.md Format (F-10)

```markdown
# RUNBOOK — {task description}
Started: 2026-03-07T10:00:00Z

## Current Status
- Phase: 3/5 (phase-3: Add validation layer)
- Pipeline Mode: full
- ~~Maturity: standard~~ (v1; v2: maturity_mode 제거)

## Milestone Progress
- [x] Phase 1: DB schema migration — PASS (4/4 criteria)
- [x] Phase 2: API endpoints — PASS (6/6 criteria)
- [ ] Phase 3: Validation layer — IN PROGRESS (2/5 criteria)
- [ ] Phase 4: Error handling
- [ ] Phase 5: Integration tests

## Key Decisions
- PD-001: chose Zod over Joi for validation (PP-02 type safety)
- PD-003: split user/admin routes (decomposer recommendation)

## Known Issues
- ISS-001: rate limiter not tested under load (H-item, deferred)

## Blockers
(none)

## How to Resume
Load: pivot-points.md + decomposition.yaml + this file
Next: Phase 3 TODO #3 — email format validator
```

### learnings.md Format (F-11)

```markdown
# MPL Learnings (auto-accumulated)
Last updated: 2026-03-07

## Failure Patterns
- [2026-03-05] Type mismatch: Python dict vs TypedDict — always use TypedDict
- [2026-03-07] pytest fixture scope confusion — default to "function" scope

## Success Patterns
- [2026-03-05] Zod schema shared between frontend/backend validation
- [2026-03-07] Error spec from Phase 0 eliminated all debugging

## Project Conventions (discovered)
- Import order: stdlib > third-party > local (enforced by ruff)
- Test naming: test_{module}_{scenario}_{expected}
```

---

## Conclusion

Through the v1.0→v3.0 evolution, MPL has grown into a pipeline that backs the principle "prevention is better than cure" with empirical data. v3.2 adds two more principles:

1. **"Documents are memory"** — ensuring continuity not only within a single execution but also between sessions and executions
2. **"Don't ask users to judge complexity"** — adaptive pipeline routing inspired by Ouroboros PAL Router, eliminating entry barriers for lightweight tasks through single entry point + automatic tier classification + dynamic escalation

Refer to each document for detailed design:

- [Phase 1: Foundation - Phase 0 Enhanced](./phase1-foundation.md) — **implementation complete**
- [Phase 2: Incremental - incremental implementation/testing](./phase2-incremental.md) — **implementation complete**
- [Phase 3: Automation - automation and optimization](./phase3-automation.md) — **fully implemented**
- [Adaptive Pipeline Router implementation plan](./adaptive-router-plan.md) — **v3.2 new**
- [Experiment results summary](./experiments-summary.md)
- [v3.0 design document](../design.md)
