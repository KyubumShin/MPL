---
description: MPL Execute Protocol - 5-Gate Quality System, Fix Loop, Convergence Detection
---

# MPL Execution: 5-Gate Quality System (Steps 4.5-4.8)

This file contains the 5-Gate Quality system, Fix Loop with Convergence Detection,
Partial Rollback, and Graceful Pause protocol.
Load this when entering Step 4.5 (after all phases complete) or when a gate fails.

See also: `mpl-run-execute.md` (core loop), `mpl-run-execute-context.md` (context assembly), `mpl-run-execute-parallel.md` (parallel dispatch).

---

### 4.5: 5-Gate Quality

After all phases complete, apply the 5-Gate Quality system before finalization.

#### Gate 0.5: Lint + Type Check (F-17, V-02 v0.8.0)

Before running tests, perform lint detection and project-level type checking.

**Step 1: Lint Auto-Detection and Execution (V-02, v0.8.0)**

```
lint_commands = []

// Auto-detect lint tools
if exists("package.json"):
  pkg = Read("package.json")
  if "eslint" in pkg.devDependencies or exists(".eslintrc*") or exists("eslint.config.*"):
    lint_commands.push({ cmd: "npx eslint . --max-warnings=0", name: "ESLint" })

if exists("pyproject.toml") or exists("ruff.toml"):
  lint_commands.push({ cmd: "ruff check .", name: "Ruff" })
elif exists(".flake8") or exists("setup.cfg"):
  lint_commands.push({ cmd: "flake8 .", name: "Flake8" })

if exists("biome.json"):
  lint_commands.push({ cmd: "npx biome check .", name: "Biome" })

// Execute lint commands
lint_failures = []
for each { cmd, name } in lint_commands:
  result = Bash(cmd, timeout=60000)
  if result.exit_code != 0:
    announce: "[MPL] Gate 0.5 FAIL: {name} lint failed"
    announce: "{first 20 lines of result.stderr}"
    lint_failures.append({ tool: name, errors: result.stderr })
  else:
    announce: "[MPL] Gate 0.5: {name} lint passed ✓"

if lint_failures.length > 0:
  announce: "[MPL] Gate 0.5: {lint_failures.length} lint tool(s) failed. Entering fix loop."
  → Enter fix loop targeting lint errors first
```

**Step 2: Project-Wide Type Check**

```
diagnostics = lsp_diagnostics_directory(path=".", strategy="auto")
// strategy="auto": uses tsc when tsconfig.json exists, falls back to LSP iteration
// Standalone fallback (F-04): Bash("npx tsc --noEmit") or Bash("python -m py_compile *.py")

if diagnostics.errors > 0:
  Report: "[MPL] Type check: {errors} errors found. Entering fix loop."
  -> Enter fix loop targeting type errors before Gate 1

if diagnostics.warnings > 5:
  Report: "[MPL] Type check: {warnings} warnings. Proceeding with caution."

Report: "[MPL] Gate 0.5: Lint + Type check clean. Proceeding to Gate 1."
```

This catches lint and type errors before test execution, reducing fix loop iterations.

**Step 3: Multi-Stack Build Verification (B-02, v0.6.3)**

Gate 0.5 must verify ALL build tools in the project, not just TypeScript:

```
build_commands = []

// Auto-detect build tools
if exists("package.json"):
  scripts = parse("package.json").scripts
  if scripts.build:     build_commands.push({ cmd: "npm run build", name: "Frontend build" })
  if scripts.typecheck:  build_commands.push({ cmd: "npm run typecheck", name: "TypeScript check" })

if exists("Cargo.toml") or exists("src-tauri/Cargo.toml"):
  cargo_dir = exists("src-tauri") ? "src-tauri" : "."
  build_commands.push({ cmd: "cd {cargo_dir} && cargo check", name: "Rust check" })

if exists("pyproject.toml") or exists("setup.py"):
  build_commands.push({ cmd: "python -m py_compile $(find . -name '*.py' -not -path './node_modules/*')", name: "Python check" })

if exists("go.mod"):
  build_commands.push({ cmd: "go build ./...", name: "Go build" })

if exists("build.gradle") or exists("build.gradle.kts"):
  build_commands.push({ cmd: "./gradlew compileJava", name: "Gradle compile" })

if exists("pom.xml"):
  build_commands.push({ cmd: "mvn compile -q", name: "Maven compile" })

// Run all detected build commands
for each { cmd, name } in build_commands:
  result = Bash(cmd, timeout=120000)
  if result.exit_code != 0:
    announce: "[MPL] Gate 0.5 FAIL: {name} failed (exit {result.exit_code})"
    announce: "{first 20 lines of result.stderr}"
    → enter fix loop (target the specific build tool failure)
  else:
    announce: "[MPL] Gate 0.5: {name} passed ✓"
```

#### Gate 1: Automated Tests + Regression Suite (TS-03, v0.8.1)

Run the full test suite **including accumulated regression tests**:
- Execute all test commands (pytest, npm test, etc.)
- **Additionally run regression suite** if `.mpl/regression-suite.json` exists:
  ```
  regression_suite = Read(".mpl/regression-suite.json") or null
  if regression_suite AND regression_suite.regression_command:
    regression_result = Bash(regression_suite.regression_command, timeout=120000)
    if regression_result.exit_code != 0:
      announce: "[MPL] Gate 1: Regression suite FAILED ({regression_suite.total_assertions} assertions)"
      → include regression failures in fix loop context
    else:
      announce: "[MPL] Gate 1: Regression suite PASSED ✓ ({regression_suite.total_assertions} assertions)"
  ```
- Combined pass_rate (current + regression) must be >= 95% to proceed to Gate 2
- If pass_rate < 95%: enter fix loop (see 4.6)

**Zero-Test Block (B-01, v0.6.2):**
```
test_count = count total tests from test runner output
mandatory_domains = phases.filter(p => p.phase_domain in ["ui", "api", "algorithm", "db", "ai"])

if test_count == 0 AND mandatory_domains.length > 0:
  Gate 1 = FAIL
  announce: "[MPL] Gate 1 FAIL: 0 tests found but {mandatory_domains.length} mandatory-domain phases exist."
  announce: "[MPL] Forcing Test Agent dispatch for mandatory phases."

  // Force Test Agent for each mandatory-domain phase that has no tests
  for each phase in mandatory_domains:
    test_files = Glob("{phase.impact_dir}/**/*.{test,spec}.*")
    if test_files.length == 0:
      Task(subagent_type="mpl-test-agent", model="sonnet",
        prompt="Write tests for phase {phase.id} ({phase.phase_domain}).
        Implemented files: {phase.created + phase.modified files}
        Interface contracts: {phase.interface_contract}
        Write and run tests. Return test results.")

  // Re-run Gate 1 after Test Agent
  re-execute test suite → check pass_rate again
```

#### Gate 1.5: Coverage + Duplication + Bundle Metrics (F-50)

After Gate 1 passes (tests must pass before measuring coverage):

```
// 1. Coverage Check
coverage_result = Bash("npx vitest run --coverage --reporter=json" or "pytest --cov --cov-report=json")
// Parse: line_coverage, branch_coverage

// 2. Duplication Check (if jscpd or similar available)
duplication_result = Bash("npx jscpd src/ --reporters json") // optional, soft gate

// 3. Bundle Size Check (if UI project with build)
bundle_result = Bash("npm run build 2>&1") // parse output size

// Thresholds (MVP mode)
coverage_thresholds = { lines: 60, branches: 50 }
// Thresholds (Production mode — when maturity_mode == "strict")
// coverage_thresholds = { lines: 80, branches: 70 }
duplication_threshold = 5  // percent

if line_coverage < coverage_thresholds.lines:
  Report: "[MPL] Gate 1.5: Line coverage {line_coverage}% < {threshold}%. Dispatching Test Agent for gap coverage."
  // Auto-fix: dispatch mpl-test-agent with coverage gaps
  // Max 2 retry attempts
  coverage_fix = Task(subagent_type="mpl-test-agent", model="sonnet",
       prompt="Coverage gaps found. Write tests to improve coverage for: {uncovered_files}")
  // Re-run coverage check after fix

if duplication > duplication_threshold:
  Report: "[MPL] Gate 1.5: Code duplication {duplication}% > {threshold}%. (Warning only)"
  // Soft gate: warning only, does not block

if bundle_size > pp_budget:
  Report: "[MPL] Gate 1.5: Bundle {bundle_size}KB > budget {pp_budget}KB. (H-item for review)"
  // Soft gate: architectural decision, flagged as H-item
```

Gate 1.5 pass criteria: coverage thresholds met (or 2 fix attempts exhausted → soft pass with warning).
Token impact: Happy path ~1,900 tokens. Worst case (2 coverage fix retries) ~22,000 tokens.

Report: `[MPL] Gate 1.5: Coverage {line}%/{branch}%, Duplication {dup}%, Bundle {size}KB.`

#### Gate 1.7: Browser QA (T-03, v4.0)

**Precondition**: UI-domain phases exist AND Chrome MCP server is available.
Skip if: no UI phases, or MCP unavailable, or Frugal/Standard tier (non-blocking skip).

```
if phases.any(p => p.phase_domain == "ui"):
  qa_result = Task(subagent_type="mpl-qa-agent", model="sonnet",
    prompt="Run browser QA on {dev_server_url}.
    Phase 0 UI spec: {phase0_artifacts}
    Expected elements: {from verification plan}
    Check: console errors, accessibility, core element presence.")

  if qa_result.status == "SKIPPED":
    announce: "[MPL] Gate 1.7: Skipped ({qa_result.reason})"
  elif qa_result.status == "PASSED":
    announce: "[MPL] Gate 1.7: Browser QA passed. {qa_result.checks_passed}/{qa_result.checks_total}"
  else:
    announce: "[MPL] Gate 1.7: Browser QA issues found: {qa_result.summary}"
    // Issues are WARNING level — defer to Step 5.5 Post-Execution Review
    // Browser QA does NOT block the pipeline (T-10 pattern)
    append qa_result.issues to .mpl/mpl/deferred-review.md
else:
  announce: "[MPL] Gate 1.7: Skipped (no UI-domain phases)"
```

**dev_server_url detection**:
1. `.mpl/config.json` → `dev_server_url` (explicit)
2. Parse `package.json` scripts → "dev", "start", "serve" → extract port
3. Defaults: `:5173` (Vite), `:3000` (React/Next), `:8080` (Vue)
4. Not detected → Gate 1.7 SKIP

Gate 1.7 is **non-blocking**. Issues are deferred to Step 5.5 review.
Report: `[MPL] Gate 1.7: Browser QA {status}.`

#### Gate 2: Code Review

```
Task(subagent_type="mpl-code-reviewer", model="sonnet",
     prompt="""
     ## Review Scope
     All files changed during pipeline execution.
     ### Pivot Points
     {pivot_points}
     ### Phase Decisions
     {all PDs from completed phases}
     ### PP/PD Compliance Checklist (BM-05, v0.8.6)
     {auto-generated checklist from PPs and PDs:
       - [ ] PP-N: {description}
       - [ ] PD-N: {description} (Phase {N})
     }
     ### Interface Contracts
     {all phase interface_contracts}
     ### Changed Files
     {list all created/modified files across all phases}

     Review all changes for the Quality Gate.
     Check every PP/PD checklist item against the code.
     """)
```

Verdict handling:
- PASS -> proceed to Gate 3
- NEEDS_FIXES -> enter fix loop with prioritized fix list (see 4.6)
- REJECT -> report to user, enter mpl-failed state

#### Gate 3: PP Compliance + H-item Severity Filter (T-10, v3.9)

Final validation focused on Pivot Point compliance and severity-based H-item handling:
- Verify all CONFIRMED PPs are satisfied (no violations across all phases)
- Check PROVISIONAL PPs for drift (flag any deviations for user review)
- **H-item severity routing** (T-10):
  - **HIGH H-items** → present via AskUserQuestion (blocking — must be resolved)
  - **MED/LOW H-items** → append to `.mpl/mpl/deferred-review.md` (non-blocking — deferred to Step 5.5)
  - Format: `- [{severity}] {item} (Phase {N}) — {reason}`
- S-items are already covered by Gate 1 (automated tests) — no duplication here

Gate 3 pass criteria: no PP violations detected + all **HIGH** H-items resolved.
MED/LOW H-items do NOT block Gate 3 — they are reviewed post-execution in Step 5.5.

If Gate 3 fails (PP violation or unresolved HIGH H-item) -> enter fix loop (see 4.6).

All 3 gates pass -> proceed to Step 5 (E2E & Finalize).
Report: `[MPL] Quality Gates: Gate 0.5 (Types) → Gate 1 (Tests) {pass_rate}% → Gate 1.5 (Metrics) cov:{coverage}% → Gate 2 (Review) {verdict} → Gate 3 (PP) {pass/fail}.`

**RUNBOOK Update (F-10)**: Append to `.mpl/mpl/RUNBOOK.md`:
```markdown
## 5-Gate Quality Results
- **Gate 0.5 (Type Check)**: {errors} errors, {warnings} warnings
- **Gate 1 (Tests)**: {pass_rate}%
- **Gate 1.5 (Metrics)**: Coverage {line}%/{branch}%, Duplication {dup}%, Bundle {size}KB
- **Gate 2 (Code Review)**: {verdict} (10-category)
- **Gate 3 (PP Compliance)**: {pass/fail}
- **Overall**: {all_pass ? "PASSED" : "FAILED — entering fix loop"}
- **Timestamp**: {ISO timestamp}
```

### 4.6: Fix Loop (with Convergence Detection)

When any gate fails, enter the fix loop:

1. Analyze failure: which gate failed, what specifically failed
2. (F-16) Optionally dispatch mpl-scout for root cause exploration:
   ```
   Task(subagent_type="mpl-scout", model="haiku",
        prompt="Trace failure: {failure_description}. Find root cause in: {affected_files}")
   ```
   Use scout findings to inform fix strategy before dispatching worker.
   **(P-03, v0.8.7)**: Save scout's `search_trajectory` to `.mpl/mpl/phases/{current_phase}/search-trajectory.json` for observability.
   If scout search failed (0 useful findings), analyze trajectory to determine cause:
   - Wrong pattern → retry with different query
   - QMD stale → fallback to Grep-Only
   - File not in scope → expand search scope
3. Dispatch targeted fixes via mpl-worker
3. Re-run the failed gate + all subsequent gates
4. Track pass_rate in convergence history

Convergence detection after each fix attempt:

```
push pass_rate to convergence.pass_rate_history
convergence_result = checkConvergence(state)

if convergence_result.status == "stagnating":
  -> Change strategy: provide different fix approach hints to worker
  -> If still stagnating after strategy change: circuit break

if convergence_result.status == "regressing":
  -> Immediate circuit break
  -> Report: "[MPL] Fix loop regression detected. Reverting to last good state."

Record convergence_status in state: "progressing" | "stagnating" | "regressing"
```

Max fix loop iterations: controlled by max_fix_loops from config (default 10).
Exceeding max -> mpl-failed state.

### 4.6.1: Reflexion-Based Self-Reflection (F-27)

When entering the Fix Loop, perform **structured self-reflection (Self-Reflection)** rather than immediate fixes.
Applies NeurIPS 2023 Reflexion + Multi-Agent Reflexion (MAR) patterns.

#### Reflection Template

Instruct the Phase Runner to execute the template below before each Fix Loop attempt:

```
## Reflection — Fix Attempt {N}

### 1. Symptom
Accurately describe the failed test/Gate result.
- Which tests failed?
- Error messages?
- Expected vs actual behavior?

### 2. Root Cause
Trace the cause of the symptom.
- Which part of the code has the problem? (file:line)
- Why is this code wrong?
- Why was this cause missed in previous attempts?

### 3. Divergence Point
Where did we deviate from the original plan (mini-plan/Phase 0)?
- Difference between Phase 0 spec and actual implementation?
- PP violation?
- Assumption mismatch?

### 4. Fix Strategy
- What approach differs from before?
- Which Phase 0 artifacts should be re-referenced?
- Predicted side effects of the fix?

### 5. Learning Extraction
- What pattern can be extracted from this failure?
- Pattern classification tag: {tag}
- How to prevent this failure in future runs?
```

#### Reflection Execution Protocol

```pseudocode
function fix_loop_with_reflection(phase, failures, attempt):
  # 1. Generate Reflection
  reflection = phase_runner.generate_reflection(
    template = REFLECTION_TEMPLATE,
    failures = failures,
    phase0_artifacts = load_phase0(),
    previous_reflections = load_previous_reflections(phase),
    attempt_number = attempt
  )

  # 2. Gate 2 failure — MAR pattern: integrate code reviewer feedback
  if failure_source == "gate2":
    reviewer_feedback = gate2_result.feedback
    reflection.root_cause += "\nCode review feedback: " + reviewer_feedback

  # 3. Save reflection results
  save_reflection(phase, attempt, reflection)
  # Path: .mpl/mpl/phases/{phase_id}/reflections/attempt-{N}.md

  # 4. Pattern classification + save to procedural.jsonl (F-25 integration)
  appendProcedural(cwd, {
    timestamp: now(),
    phase: phase.id,
    tool: "reflection",
    action: reflection.fix_strategy,
    result: "pending",  # updated to success/failure after fix
    tags: reflection.learning.tags,  # [type_mismatch, dependency_conflict, etc.]
    context: reflection.root_cause
  })

  # 5. Execute reflection-based fix
  fix_result = phase_runner.execute_fix(
    strategy = reflection.fix_strategy,
    phase0_refs = reflection.phase0_refs
  )

  # 6. Record result
  update_procedural_result(fix_result.success ? "success" : "failure")

  return fix_result
```

#### Pattern Classification Tags (Taxonomy)

| Tag | Description | Example |
|-----|-------------|---------|
| `type_mismatch` | Type mismatch | dict vs TypedDict, string vs number |
| `dependency_conflict` | Dependency conflict | version compatibility, import order |
| `test_flake` | Unstable tests | timing, environment dependencies |
| `api_contract_violation` | API contract violation | parameter order, return type |
| `build_failure` | Build failure | compile error, lint error |
| `logic_error` | Logic error | inverted condition, boundary value |
| `missing_edge_case` | Missing edge case | null, empty array, concurrency |
| `scope_violation` | Scope violation | PP/Must NOT Do violation |

#### Integration with Convergence Detection

Add Reflection information to existing Convergence Detection (improving/stagnating/regressing):
- **stagnating + same tag repeating**: Force strategy switch (prevent repeating the same approach)
- **regressing**: Back-reference previous Reflection's fix_strategy to revert
- **improving**: Maintain current strategy, Reflection can be omitted

#### Previous Reflection Reference (Cumulative Learning)

From Fix attempt 2 onward, reference previous Reflections to prevent repeating the same approach:
```
load_previous_reflections(phase):
  - Load all .mpl/mpl/phases/{phase_id}/reflections/attempt-*.md
  - Max 3 (token budget ~1500)
  - Pass previous failed approaches as "things not to do" list to Phase Runner
```

**RUNBOOK Update (F-10)**: After each fix attempt, append to `.mpl/mpl/RUNBOOK.md`:
```markdown
## Fix Loop Iteration {N}
- **Target Gate**: {failed_gate}
- **Fix Strategy**: {strategy_description}
- **Pass Rate**: {new_pass_rate}% (delta: {delta})
- **Convergence**: {convergence_status}
- **Timestamp**: {ISO timestamp}
```

#### Reflexion Effect Measurement (Observability Metrics)

Reflexion's effect is recorded in token profiling (phases.jsonl) for post-hoc analysis:

```jsonl
{"phase":"phase-3","fix_loop":true,"reflexion_applied":true,"attempts":2,"result":"success","tags":["type_mismatch"],"tokens_used":4500}
```

Measurement items:
- `reflexion_applied`: true/false — whether Reflexion was applied
- `attempts`: Fix Loop attempt count
- `result`: final success/failure
- `tags`: pattern classification

**A/B comparison is performed as post-hoc analysis after sufficient run data is accumulated.**
Compare Fix Loop success rate, average attempt count, and token cost between runs with and without Reflexion applied on the same project.
This is an **observability metric**, not a runtime feature.

### 4.7: Partial Rollback on Circuit Break

When a phase ends in `circuit_break`, preserve completed work and isolate the failure:

```
on circuit_break(phase_id, failure_info):
  1. Identify safe boundary:
     - Find the last TODO with PASS status in this phase
     - All files changed by PASS TODOs are "safe"
     - All files changed by FAIL/PARTIAL TODOs are "contaminated"

  2. Rollback contaminated files:
     - For each contaminated file:
       git checkout HEAD -- {file}  (revert to pre-phase state)
     - Record rollback in state: rolled_back_files[]

  3. Preserve safe work:
     - Keep changes from PASS TODOs (they verified successfully)
     - Update state_summary to reflect partial completion
     - Mark preserved TODOs in phase state

  4. Generate recovery context for redecomposition:
     - What was completed (preserved TODO list with outputs)
     - What failed (failure_info with retry history)
     - Contaminated files that were rolled back
     - Recommendations for redecomposition strategy

  5. Report:
     "[MPL] Circuit break on phase-{N}. {safe_count}/{total_count} TODOs preserved.
      Rolled back: {rolled_back_files}. Recovery context saved."
```

The recovery context is saved to `.mpl/mpl/phases/phase-N/recovery.md` and used by the decomposer if redecomposition is triggered.

### Step 4.8: Graceful Pause Protocol (F-33)

Protocol executed when budget prediction recommends pausing.

**Trigger conditions**:
- `predictBudget(cwd).recommendation` == `"pause_now"` (context < 10%)
- `predictBudget(cwd).recommendation` == `"pause_after_current"` (insufficient budget for remaining Phases)

**Protocol**:

```python
def execute_graceful_pause(budget, next_phase_id, completed_phases, remaining_phases):
    # 1. Create handoff signal file
    mkdir -p ".mpl/signals/"
    handoff = {
        "version": 1,
        "pipeline_id": state.pipeline_id,
        "paused_at": now_iso(),
        "resume_from_phase": next_phase_id,
        "completed_phases": completed_phases,
        "remaining_phases": remaining_phases,
        "budget_snapshot": {
            "context_pct_used": 100 - budget.remaining_pct,
            "remaining_pct": budget.remaining_pct,
            "estimated_needed_pct": budget.estimated_needed_pct,
            "avg_tokens_per_phase": budget.avg_tokens_per_phase
        },
        "state_file": ".mpl/state.json",
        "runbook_file": ".mpl/mpl/RUNBOOK.md"
    }
    Write(".mpl/signals/session-handoff.json", JSON.stringify(handoff))

    # 2. Update State
    writeState(cwd, {
        "session_status": "paused_budget",
        "pause_reason": f"Context budget insufficient: {budget.remaining_pct}% remaining, {budget.estimated_needed_pct}% needed for {len(remaining_phases)} phases",
        "resume_from_phase": next_phase_id,
        "pause_timestamp": now_iso(),
        "budget_at_pause": {
            "context_pct": budget.remaining_pct,
            "estimated_needed_pct": budget.estimated_needed_pct
        }
    })

    # 3. RUNBOOK entry
    Append to RUNBOOK.md:
    """
    ## Session Paused — Budget Prediction (F-33)
    - **Timestamp**: {ISO}
    - **Context Used**: {100 - budget.remaining_pct}%
    - **Estimated Needed**: {budget.estimated_needed_pct}% for {len(remaining_phases)} phases
    - **Resume From**: {next_phase_id}
    - **Action**: `/mpl:mpl-resume` in new session or auto-watcher
    """

    # 4. <remember priority> tag
    <remember priority>
    [MPL Session Paused — Budget F-33]
    Pipeline: {pipeline_id}
    Paused at: {next_phase_id}
    Completed: {len(completed_phases)}/{total} phases
    Resume: /mpl:mpl-resume
    </remember>

    # 5. User message
    Print:
    "[MPL] Session pausing — context {100-budget.remaining_pct}% used, estimated {budget.estimated_needed_pct}% needed for {len(remaining_phases)} remaining phases."
    "[MPL] Resume: run `/mpl:mpl-resume` in a new session, or auto-watcher will continue."
```

**Budget Prediction Data Sources**:

| Data | File | Update Frequency |
|------|------|-----------------|
| Context usage rate | `.mpl/context-usage.json` | HUD ~500ms |
| Average tokens per Phase | `.mpl/mpl/profile/phases.jsonl` | On Phase complete |
| Total Phase count | `.mpl/mpl/decomposition.yaml` | On Step 3 complete |
| Completed Phase count | `.mpl/state.json` | On Phase complete |

**Prediction Algorithm**:
```
remaining_pct = 100 - context_usage.pct
estimated_needed = remaining_phases × avg_tokens_per_phase × 1.15 (safety margin)
estimated_needed_pct = estimated_needed / total_context_tokens × 100

IF remaining_pct < 10%: → pause_now
IF estimated_needed_pct > remaining_pct: → pause_after_current
ELSE: → continue
```

**Safety measures**:
- `context-usage.json` absent or stale (>30s) → fail-open (continue)
- 0 Phases remaining → continue (nothing to do)
- No history data → conservative default 15K tokens/phase
- Manual `/mpl:mpl-resume` resume is possible even without a watcher

---
