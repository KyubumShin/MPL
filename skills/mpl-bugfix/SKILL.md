---
description: "[DEPRECATED] Standalone adaptive bug fixing — use /mpl:mpl instead (auto-routes to frugal tier via F-20)"
---

# MPL Bugfix (Deprecated)

> **Deprecated (v3.2)**: This skill is superseded by `/mpl:mpl` with Adaptive Pipeline Router (F-20).
> The unified `/mpl:mpl` entry point auto-detects task complexity and routes to the appropriate tier.
> Use `"mpl bugfix ..."` or `"mpl fix ..."` keyword to hint frugal tier, or let auto-scoring decide.
>
> This skill still works for backward compatibility but internally redirects to `/mpl:mpl` with `tier_hint: "frugal"`.

Lightweight bug fixing pipeline. Skips full decomposition and runs a single-phase fix cycle.

## When to Use

- Known bug with a specific symptom (test failure, error message, wrong behavior)
- Targeted fix that doesn't require architectural changes
- Quick turnaround without full pipeline overhead

## Protocol

### Step 1: Bug Analysis

1. Read the bug description from user input
2. Identify affected files using Glob/Grep/lsp tools
3. Run failing test(s) to confirm the bug and capture error output

### Step 2: Phase 0 Minimal (Error Spec Only)

Apply Phase 0 Step 4 (Error Specification) only:
1. Extract error patterns from failing tests (`pytest.raises`, `assert`, error messages)
2. Map expected vs actual behavior
3. Save to `.mpl/mpl/phase0/error-spec.md`

### Step 3: Fix Execution

Delegate to `mpl-phase-runner` via Task tool:

```
Task(subagent_type="mpl-phase-runner", prompt="""
Bug: {bug description}
Failing test: {test file and function}
Error output: {captured error}
Error spec: {phase0 error-spec content}

Fix the bug. Run the failing test after fix to confirm.
""")
```

### Step 4: Build-Test-Fix Cycle

1. Run the specific failing test(s)
2. If still failing: retry fix with additional context (max 2 retries)
3. Run full test suite to check for regressions
4. If regression found: fix regression (max 1 retry), else circuit break

### Step 5: Finalize

1. Verify: all originally failing tests now pass
2. Verify: no regressions (full suite pass rate unchanged or improved)
3. Delegate atomic commit to `mpl-git-master`
4. Report: bug description, root cause, fix summary, test evidence

## Constraints

- No Triage, no PP interview, no decomposition
- Single-phase execution only
- Max 3 total fix attempts before circuit break
- Orchestrator MUST NOT edit source files directly (delegate to mpl-phase-runner)

## Related

- `/mpl:mpl` for full pipeline
- `/mpl:mpl-small` for lightweight multi-phase work
