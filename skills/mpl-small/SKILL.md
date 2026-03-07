---
description: 3-Phase lightweight pipeline - simplified MPL for small features and refactors
---

# MPL Small

3-Phase lightweight pipeline for small-scope tasks that don't warrant the full 9+ step MPL.

## When to Use

- Small feature additions (1-3 files)
- Localized refactoring
- Simple configuration changes with tests
- Tasks where full Pre-Execution Analysis is overkill

## Protocol

### Phase A: Analyze (Phase 0 Simple)

1. Complexity is fixed to `Simple` grade (Step 4: Error Spec only)
2. Skip Triage (interview_depth = `skip`)
3. Extract Pivot Points directly from user prompt (no interview)
4. Run codebase analysis (structure + test infrastructure only)
5. Generate error specification: `.mpl/mpl/phase0/error-spec.md`

### Phase B: Execute (Single Phase)

1. Create a mini-plan with TODOs from user request
2. Delegate each TODO to `mpl-worker` via Task tool
3. Apply Build-Test-Fix micro-cycle per TODO:
   - Implement TODO
   - Run affected module tests immediately
   - Fix on failure (max 2 retries per TODO)
4. Run cumulative test suite after all TODOs complete
5. Generate state summary

### Phase C: Finalize

1. **Gate 1 only**: Automated test pass rate >= 95%
   - If fail: single Fix Loop attempt, then circuit break
   - Gate 2 (code review) and Gate 3 (Agent-as-User) are skipped
2. Delegate atomic commit to `mpl-git-master`
3. Brief completion report: changes made, tests passed, key decisions

## Constraints

- No PP interview (PPs extracted from prompt)
- No Pre-Execution Analysis (gap/tradeoff/critic skipped)
- No decomposition into multiple phases (single execution phase)
- Gate 1 only (no code review or Agent-as-User gates)
- Orchestrator MUST NOT edit source files directly (delegate to mpl-worker)
- Max 1 redecomposition attempt on circuit break

## Related

- `/mpl:mpl` for full pipeline (complex tasks)
- `/mpl:mpl-bugfix` for targeted bug fixes
