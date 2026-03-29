# Phase 2: Incremental - Incremental Implementation/Testing Design

> **Implementation Status**: Fully implemented in v3.0. The Build-Test-Fix micro-cycle has been integrated as the standard behavior of the Phase Runner (`mpl-run.md` Step 4.2). v3.0 additionally introduced Test Agent (independent verification), 3-Gate quality system, and Convergence Detection, completing a quality assurance framework that surpasses the original design.

## Goal

Combine the key insights from Exp 5 (test stubs) and Exp 6 (incremental testing) to make the **per-module implementation → immediate testing → immediate fix on failure** pattern the standard behavior of the MPL pipeline.

## Core Principle

### "Build-Test-Fix" Micro-Cycle

> ✓ Implemented in v3.0. Phase Runner Rule 4: "After each TODO (or parallel group), immediately test the affected module. Fix failures before moving to the next TODO."

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   Implement TODO ──→ Test module ──→ Pass? ──→ Next TODO  │
│                                    │                │
│                                    ↓ Fail            │
│                               Immediate fix ──┘     │
│                          (max 2 retries)             │
│                                                     │
└─────────────────────────────────────────────────────┘
```

The previous MPL v1.0 tested all modules at once in Phase 4 after all implementation. This caused errors to accumulate, making debugging complex. In v3.0, tests for each module are run immediately after implementing each TODO, and failures are fixed by referencing Phase 0 artifacts (error-spec, type-policy, api-contracts).

**v3.0 implementation details**:
- Maximum retries per TODO: **2** (adjusted from 3 in original design)
- At phase end: **Cumulative execution of all tests** from current + previous phases to prevent regressions
- Phase Runner Rule 10: Referencing Phase 0 artifacts is required on failure

## Incremental Testing Design Based on Exp 6

### Test Stage Definitions

> ✓ Implemented in v3.0. In the micro-phase structure, each phase operates as an independent test unit.

Standardized the 5-stage incremental testing structure verified in Exp 6:

| Stage | Target | Test Count (example) | Cumulative Verification |
|------|------|----------------|----------|
| Stage 1 | Data models | 11 | 11 |
| Stage 2 | Core logic (DAG, etc.) | 19 | 30 |
| Stage 3 | I/O (loader, parser) | 15 | 45 |
| Stage 4 | Execution/orchestration | 14 | 59 |
| Stage 5 | Integration + hidden tests | 18 | 77 |

### Experimental Rationale

Exp 6 results:
- Phase 1 (Models): 11/11 (100%) - 0.01s
- Phase 2 (DAG): 19/19 (100%) - 0.02s
- Phase 3 (Loader): 15/15 (100%) - 0.01s
- Phase 4 (Executor): 14/14 (100%) - 2.05s
- Phase 5 (Full): 77/77 (100%) - 2.10s

**Key finding**: Zero fixes were needed at any stage. This demonstrates the synergy between Phase 0 reinforcement (Exp 1~4, 7) and incremental testing.

## Stub-First Development Integration Based on Exp 5

### TDD Flow

> ✓ Implemented in v3.0. Phase 0 artifacts are automatically injected into the Phase Runner's context, enabling interface contract-based implementation.

Combined the test stub generation approach from Exp 5 with Phase 0 artifacts:

```
Phase 0 Artifacts       Phase Context           Phase Runner Execution
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ API contracts│───→│ Interface    │───→│ Per-TODO impl │
│ Example pats │    │ contract-    │    │ + immediate   │
│ Type policy  │    │ based context│    │   test        │
│ Error spec   │    │              │    │ + immediate   │
└──────────────┘    └──────────────┘    │   fix         │
                                        └──────────────┘
```

## v3.0 Addition: Test Agent (Independent Verification)

> This feature was not in the original Phase 2 design but was added in v3.0.

`mpl-test-agent` (sonnet) independently writes and runs tests after Phase Runner completion. By separating the code author (Phase Runner) from the test author (mpl-test-agent), it catches assumption mismatches, interface contract violations, and edge cases.

```
Phase Runner complete ──→ Test Agent runs ──→ Results merged
     (mpl-phase-runner        (mpl-test-agent       (compare pass_rates,
      writes code)             writes independent     flag mismatches)
                               tests)
```

- Test Agent pass_rate < Phase Runner pass_rate → mismatch flag raised
- Tests written based on A/S-items from verification plan
- Based on interface contracts (not implementation details)

## Phase Runner Changes

### Incremental Verification Mode — Implemented

> ✓ In v3.0, the Phase Runner defaults to incremental mode (`mpl_state.verification_mode: "incremental"`).

The Build-Test-Fix micro-cycle is the standard behavior of the Phase Runner:

```
Implement TODO 1
  → Run tests for the affected module
  → On failure: Reference Phase 0 artifacts and fix immediately (max 2 times)
  → On pass: Proceed to TODO 2

Implement TODO 2
  → Include tests from previous module (regression prevention)
  → On failure: Fix immediately
  → On pass: Proceed to TODO 3

All TODOs complete
  → Cumulative testing (current + all previous phases)
  → Record pass_rate
```

### Failure Handling Policy — v3.0 Reflected

| Failure Type | Handling Method | Max Retries |
|----------|----------|-----------|
| Current TODO test failure | Reference Phase 0 artifacts and fix immediately | 2 times (per TODO) |
| Previous module regression | Analyze regression cause and fix | Included in Phase Runner's 3 retries |
| Entire phase failure | Phase Runner internal retry | 3 times (per phase) |
| 3 retry failures | circuit_break → re-decompose | Max 2 re-decompositions |

## Phase 5 Entry Condition Tightening → Evolved into 3-Gate Quality System

### Original Design (v2.0)

```
Phase 4 complete
  → pass_rate >= 95%? → Done (skip Phase 5)
  → pass_rate < 95%?  → Enter Phase 5 (minimum fixes only)
```

### v3.0 Implementation: 3-Gate Quality System

The concept of tightening Phase 5 entry conditions evolved into the **3-Gate quality system** in v3.0:

| Gate | Name | Pass Criteria | On Failure |
|------|------|----------|--------|
| Gate 1 | Automated tests | pass_rate ≥ 95% | Fix Loop |
| Gate 2 | Code review (mpl-code-reviewer) | PASS verdict | Fix Loop or mpl-failed |
| Gate 3 | Agent-as-User (S-items) | All pass + no PP violations | Fix Loop |

In the Fix Loop, **Convergence Detection** operates to monitor the real progress of fixes:
- `improving`: Continue fixing
- `stagnating`: Change strategy; circuit break if still stagnating
- `regressing`: Immediate circuit break

## Auto Complexity Detector — Implementation Complete

> ✓ Implemented in v3.0's Step 2.5.1 (Complexity Detection).

### Analysis Items

| Item | Weight | v3.0 Measurement Method |
|------|--------|---------------|
| Module count | ×10 | Number of directories containing source files in codebase_analysis.directories |
| External dependencies | ×5 | codebase_analysis.external_deps.length |
| Test files | ×2 | codebase_analysis.test_infrastructure.test_files.length |
| Async functions | ×8 | ast_grep_search("async function/def") count |

### Output

`.mpl/mpl/phase0/complexity-report.json`:
```json
{
  "score": 85,
  "grade": "Complex",
  "breakdown": {
    "modules": 6, "external_deps": 4, "test_files": 8, "async_functions": 3
  },
  "selected_steps": [1, 3, 4],
  "token_budget": 18000
}
```

## Achieved Effects

### Quantitative Effects

| Metric | v1.0 | v3.0 (achieved) | Improvement |
|------|------|-----------|------|
| Debugging cycles | 3~5 times | Max 2 immediate fixes per TODO | Switched to immediate fixes |
| Phase 5 entry rate | 100% | Replaced by 3-Gate system | Structural change |
| Error detection timing | Phase 4 (late) | Immediately after implementation (early) | Early detection |
| Context switching cost | High | Low (focused per TODO) | Maintained focus |

### Qualitative Effects

1. **Fast feedback**: Verify test results immediately after implementation and fix while memory is fresh
2. **Regression prevention**: Cumulative tests continuously ensure normal operation of previous modules
3. **Independent verification**: Test Agent separated from code author to catch assumption mismatches (v3.0 addition)
4. **Convergence guarantee**: Convergence Detection monitors real progress of Fix Loop (v3.0 addition)
5. **Multi-layer quality**: 3-Gate system combines automated testing, code review, and user perspective verification (v3.0 addition)
