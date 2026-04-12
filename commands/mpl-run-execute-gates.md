---
description: MPL Execute Protocol - 3 Hard Gates, Fix Loop, Convergence Detection
---

# MPL Execution: Gate System (Steps 4.5-4.8)

3 Hard Gates (mechanical, $0, binary pass/fail).
Load this when entering Step 4.5 (after all phases complete) or when a gate fails.

See also: `mpl-run-execute.md` (core loop), `mpl-run-execute-context.md` (context assembly), `mpl-run-execute-parallel.md` (parallel dispatch).

---

## Floor Definition

**ALL phases, regardless of PP-proximity level, must pass Hard 1 + Hard 2 + Hard 3.**
This is the Floor — the minimum quality bar that cannot be lowered.

---

### 4.5: Gate System

After all phases complete, apply the Gate system before finalization.

#### Hard 1: Build + Lint + Type ($0, mechanical, binary)

Binary pass/fail. All build tools, linters, and type checkers must succeed.

**Step 0: Pattern Risk Check (AD-0005, EXPERIMENTAL)**

Independent gate-time cross-check of security patterns against ALL changed files (not just per-phase impact files). Runs the same `default_risk_patterns` from decomposition post-processing, but against `git diff --name-only` to catch files that the decomposer may have missed.

```
// AD-0005 EXPERIMENTAL: non-blocking metric recording only.
// Exit code is IGNORED during EXPERIMENTAL phase.
// When promoted to HARD, non-zero exit → Hard 1 FAIL.

changed_files = Bash("git diff --name-only HEAD~$(state.phases.completed || 1) 2>/dev/null || git diff --name-only --cached").split("\n").filter(f => f.trim())

patterns = [
  { id: "sec-eval",        regex: "\\beval\\(",                                                     langs: [".js",".ts",".py"] },
  { id: "sec-api-key",     regex: "(api_key|apikey|secret)\\s*[:=]\\s*[\"'][^\"']{8,}",             langs: ["*"] },
  { id: "sec-sql-concat",  regex: "[\"']\\s*\\+\\s*\\w+.*(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)",  langs: [".js",".ts",".py",".java"] },
  { id: "sec-innerhtml",   regex: "\\.innerHTML\\s*=",                                              langs: [".js",".ts"] },
  { id: "sec-weak-crypto", regex: "Math\\.random\\(\\)",                                            langs: [".js",".ts"] }
]

matches = []
for each p in patterns:
  target_files = changed_files.filter(f => p.langs.includes("*") or p.langs.some(ext => f.endsWith(ext)))
  if target_files.length > 0:
    result = Bash("grep -rnE '" + p.regex + "' " + target_files.join(" ") + " 2>/dev/null || true")
    if result.stdout.trim():
      matches.push({ pattern_id: p.id, files: target_files, output: result.stdout.trim() })

// Metric recording (EXPERIMENTAL)
if matches.length > 0:
  metric = { timestamp: now_iso(), patterns_matched: matches.length, details: matches }
  Bash("echo '" + JSON.stringify(metric) + "' >> .mpl/mml/pattern-metrics.jsonl")
  announce: "[MPL] Hard 1 Step 0 (EXPERIMENTAL): {matches.length} security pattern matches found. Metrics recorded. (non-blocking)"

// EXPERIMENTAL: do NOT fail Hard 1 on pattern matches.
// When severity promoted to HARD: uncomment the line below.
// if matches.length > 0: → Hard 1 FAIL
```

**Step 1: Lint Auto-Detection and Execution**

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
    announce: "[MPL] Hard 1 FAIL: {name} lint failed"
    announce: "{first 20 lines of result.stderr}"
    lint_failures.append({ tool: name, errors: result.stderr })
  else:
    announce: "[MPL] Hard 1: {name} lint passed"

if lint_failures.length > 0:
  announce: "[MPL] Hard 1: {lint_failures.length} lint tool(s) failed. Entering fix loop."
  → Enter fix loop targeting lint errors first
```

**Step 2: Project-Wide Type Check**

```
diagnostics = lsp_diagnostics_directory(path=".", strategy="auto")
// strategy="auto": uses tsc when tsconfig.json exists, falls back to LSP iteration
// Standalone fallback: Bash("npx tsc --noEmit") or Bash("python -m py_compile *.py")

if diagnostics.errors > 0:
  Report: "[MPL] Hard 1 FAIL: Type check: {errors} errors. Entering fix loop."
  -> Enter fix loop targeting type errors

Report: "[MPL] Hard 1: Type check clean."
```

**Step 3: Multi-Stack Build Verification**

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
    announce: "[MPL] Hard 1 FAIL: {name} failed (exit {result.exit_code})"
    announce: "{first 20 lines of result.stderr}"
    → enter fix loop (target the specific build tool failure)
  else:
    announce: "[MPL] Hard 1: {name} passed"
```

// Defensive check: if NO verification ran at all, fail rather than auto-pass.
// Same principle as AD-02 for Hard 3 — missing precondition ≠ free pass.
total_checks = lint_commands.length + build_commands.length + (diagnostics ? 1 : 0)
if total_checks == 0:
  announce: "[MPL] Hard 1 FAIL: No lint, type check, or build tool detected. At minimum, the project must have one of: package.json with build script, tsconfig.json, Cargo.toml, pyproject.toml, go.mod. Cannot verify code quality with zero tools."
  → enter fix loop (target: add build/lint configuration)

Hard 1 passes when: all lint tools + type check + all build tools succeed AND at least one check ran.
Report: `[MPL] Hard 1: Build + Lint + Type PASSED ({total_checks} checks).`

#### Hard 2: Full Test Suite + Regression ($0, mechanical, binary)

Run the full test suite **including accumulated regression tests**:
- Execute all test commands (pytest, npm test, etc.)
- **Additionally run regression suite** if `.mpl/regression-suite.json` exists:
  ```
  regression_suite = Read(".mpl/regression-suite.json") or null
  if regression_suite AND regression_suite.regression_command:
    regression_result = Bash(regression_suite.regression_command, timeout=120000)
    if regression_result.exit_code != 0:
      announce: "[MPL] Hard 2: Regression suite FAILED ({regression_suite.total_assertions} assertions)"
      → include regression failures in fix loop context
    else:
      announce: "[MPL] Hard 2: Regression suite PASSED ({regression_suite.total_assertions} assertions)"
  ```
- Combined pass_rate (current + regression) must be >= 95% to pass
- If pass_rate < 95%: enter fix loop (see 4.6)

**Zero-Test Block:**
```
test_count = count total tests from test runner output
mandatory_domains = phases.filter(p => p.phase_domain in ["ui", "api", "algorithm", "db", "ai"])

if test_count == 0 AND mandatory_domains.length > 0:
  Hard 2 = FAIL
  announce: "[MPL] Hard 2 FAIL: 0 tests found but {mandatory_domains.length} mandatory-domain phases exist."
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

  // Re-run Hard 2 after Test Agent
  re-execute test suite → check pass_rate again
```

Hard 2 passes when: pass_rate >= 95% (including regression).
Report: `[MPL] Hard 2: Tests {pass_rate}% PASSED.`

#### Hard 3: L1/L2 Contract Diff Guard ($0, mechanical, binary)

Mechanical boundary contract verification. No LLM involved — pure key extraction and diff.

**Precondition**: `.mpl/contracts/*.json` exist. The Decomposer is required to enumerate boundaries and the orchestrator Writes contract files during decomposition post-processing (AD-01, `mpl-run-decompose.md` Step 3 item 2a). Projects with zero cross-layer boundaries get a `_no-boundaries.json` placeholder; a truly missing `.mpl/contracts/` directory signals a decomposer bug or protocol regression.

```
// AD-02 (v0.13.0): no auto-pass. Missing contracts/ means decomposer
// post-processing did not run (bug) or contracts/ was tampered with.
// Fail defensively instead of silently granting a free pass — this was
// the exact chain that let cb-phase-a1 D2 (0/15) and D3 (0/13) shared
// omission defects slip through Hard 3 invisibly.
if not exists(".mpl/contracts/") or Glob(".mpl/contracts/*.json").length == 0:
  Write(".mpl/mpl/hard3-violations.md",
        "Hard 3 FAIL: .mpl/contracts/ directory missing or empty.\n" +
        "Decomposer (mpl-run-decompose.md Step 3 item 2a) must write at least " +
        "one contract file per phase. Projects with no cross-layer boundaries " +
        "should have a `_no-boundaries.json` placeholder. Re-run decomposition " +
        "or fix the decomposer output.")
  announce: "[MPL] Hard 3 FAIL: No contracts found. AD-02 no longer auto-passes. See .mpl/mpl/hard3-violations.md"
  → enter fix loop

contract_files = Glob(".mpl/contracts/*.json")
violations = []

for each contract_file in contract_files:
  contract = JSON.parse(Read(contract_file))

  for each boundary in contract.boundaries:
    // 1. Extract caller-side keys (mechanical grep)
    caller_keys = Grep(boundary.caller.symbol + ".*\\{([^}]+)\\}", boundary.caller.file)

    // 2. Extract callee-side keys (mechanical grep)
    callee_keys = Grep("fn " + boundary.callee.symbol.split("(")[0] + "\\(([^)]+)\\)", boundary.callee.file)

    // 3. Apply naming convention rules (camelCase↔snake_case)
    normalized_caller = apply_naming_rules(caller_keys, boundary.framework_rules)
    normalized_callee = apply_naming_rules(callee_keys, boundary.framework_rules)

    // 4. L1 Compare — any key-set mismatch is a HARD FAIL
    mismatches = diff(normalized_caller, normalized_callee)
    for each mismatch:
      violations.push({
        contract: contract_file,
        boundary_id: boundary.boundary_id,
        type: mismatch.type,  // "missing_param", "name_mismatch", "type_mismatch"
        caller: mismatch.caller_value,
        callee: mismatch.callee_value
      })

    // 5. L2 Parameter Value-Path Check (AD-05, v0.13.0)
    //
    // Closes the 37% D2 leak at M1=1/M2=ON (cb-phase-a1 §5):
    // contract key exists AND callee signature has it, but caller never
    // actually passes it through at the call site. L1 (key-set diff)
    // misses this because both sides "have" the key — the gap is in the
    // call expression, not the declaration.
    //
    // Heuristic: for each contract param, grep the caller file for the
    // callee symbol invocation AND the param name co-occurring. If the
    // param name does not appear near any call to the callee symbol,
    // it is a L2 violation (declared but not threaded through).
    //
    // False-positive tolerance: acceptable at Hard 3 level. Phase Runner
    // can defend with "param passed via alias/destructuring" in the fix
    // loop. False negatives (renamed params) are a known limitation —
    // the naming convention normalization in step 3 partially mitigates.

    if boundary.params:
      callee_fn_name = boundary.callee.symbol.split("(")[0].split(".").pop()
      caller_file_content = Read(boundary.caller.file)

      for each param_name in Object.keys(boundary.params):
        // Search for callee invocation that includes the param name
        // Pattern: callee_fn_name followed by ( ... param_name ... )
        // Uses a loose heuristic: param_name appearing on same line or
        // within 3 lines of a call to callee_fn_name in the caller file.
        call_lines = Grep(callee_fn_name + "\\s*\\(", boundary.caller.file)

        if call_lines.length == 0:
          // No call to callee found in caller file — L1 should have caught
          // this, but flag as L2 for completeness
          violations.push({
            contract: contract_file,
            boundary_id: boundary.boundary_id,
            type: "l2_callee_not_invoked",
            param: param_name,
            detail: callee_fn_name + " not called in " + boundary.caller.file
          })
          break  // no point checking other params if callee isn't called

        // Check if param_name appears within ±3 lines of any call site
        param_found_at_call = false
        for each call_line in call_lines:
          line_num = call_line.line_number
          context = Read(boundary.caller.file, offset=max(1, line_num-3), limit=7)
          if param_name in context or apply_naming_rules(param_name, boundary.framework_rules) in context:
            param_found_at_call = true
            break

        if not param_found_at_call:
          violations.push({
            contract: contract_file,
            boundary_id: boundary.boundary_id,
            type: "l2_param_not_passed",
            param: param_name,
            param_type: boundary.params[param_name],
            detail: param_name + " declared in contract but not found at any " + callee_fn_name + "() call site in " + boundary.caller.file
          })

l1_violations = violations.filter(v => v.type in ["missing_param", "name_mismatch", "type_mismatch"])
l2_violations = violations.filter(v => v.type in ["l2_param_not_passed", "l2_callee_not_invoked"])

if violations.length > 0:
  Write(".mpl/mpl/hard3-violations.md", format_violations(violations, { group_by: "type" }))
  announce: "[MPL] Hard 3 FAIL: {l1_violations.length} L1 key-set + {l2_violations.length} L2 value-path violations. Report: .mpl/mpl/hard3-violations.md"
  → enter fix loop
else:
  announce: "[MPL] Hard 3: All {contract_files.length} contracts verified (L1 key-set + L2 value-path)."
```

Hard 3 passes when: zero L1 key-set violations AND zero L2 value-path violations.
Report: `[MPL] Hard 3: L1 Key-Set + L2 Value-Path PASSED. ({contract_files.length} contracts, {total_params_checked} params verified)`

---

**Gate Summary Report**:

All 3 Hard Gates pass → proceed to Step 5 (E2E & Finalize).
Report: `[MPL] Gates: Hard 1 (Build) PASS → Hard 2 (Tests) {pass_rate}% → Hard 3 (Contracts) PASS.`

**RUNBOOK Update**: Append to `.mpl/mpl/RUNBOOK.md`:
```markdown
## Gate Results
- **Hard 1 (Build+Lint+Type)**: {pass/fail}
- **Hard 2 (Tests+Regression)**: {pass_rate}%
- **Hard 3 (Contract Diff)**: {pass/fail}
- **Overall**: {all_hard_pass ? "PASSED" : "FAILED — entering fix loop"}
- **Timestamp**: {ISO timestamp}
```

### 4.6: Fix Loop (with Convergence Detection)

When any Hard gate fails, enter the fix loop:

1. Analyze failure: which Hard gate failed, what specifically failed
2. Dispatch targeted fixes via Phase Runner
3. Re-run the failed gate + all subsequent Hard gates
4. Track pass_rate in convergence history

**Retry budget by PP-proximity** (Hat model):
- PP-core: max 3 fix loop iterations
- PP-adjacent: max 2 fix loop iterations
- Non-PP: max 1 fix loop iteration

Convergence detection after each fix attempt:

```
push pass_rate to convergence.pass_rate_history
convergence_result = checkConvergence(state)

if convergence_result.status == "stagnating":
  -> Generate context-aware strategy override (AD-07, v0.13.0)
  -> If still stagnating after strategy-informed retry: circuit break

if convergence_result.status == "regressing":
  -> Immediate circuit break
  -> Report: "[MPL] Fix loop regression detected. Reverting to last good state."

Record convergence_status in state: "progressing" | "stagnating" | "regressing"
```

Exceeding max iterations → `phase5-finalize` (partial completion).

### 4.6.1: Reflexion-Based Self-Reflection (F-27)

When entering the Fix Loop, perform **structured self-reflection** before each fix attempt.

**Reflection Template** (instruct Phase Runner):

```
## Reflection — Fix Attempt {N}

### 1. Symptom
What failed? Error messages, expected vs actual.

### 2. Root Cause
Which code is wrong? (file:line) Why was this missed before?

### 3. Fix Strategy
What approach differs from previous attempts?
Which Phase 0 artifacts should be re-referenced?

### 4. Learning
Pattern classification tag: {tag}
```

**Pattern Classification Tags**:

| Tag | Description |
|-----|-------------|
| `type_mismatch` | Type mismatch (dict vs TypedDict, string vs number) |
| `dependency_conflict` | Version compatibility, import order |
| `test_flake` | Timing, environment dependencies |
| `api_contract_violation` | Parameter order, return type |
| `build_failure` | Compile error, lint error |
| `logic_error` | Inverted condition, boundary value |
| `missing_edge_case` | Null, empty array, concurrency |
| `scope_violation` | PP/Must NOT Do violation |

**Integration with Convergence Detection**:
- **stagnating + same tag repeating**: Force strategy switch
- **regressing**: Back-reference previous Reflection to revert
- **improving**: Maintain current strategy

**Previous Reflection Reference** (from attempt 2 onward):
```
load_previous_reflections(phase):
  - Load all .mpl/mpl/phases/{phase_id}/reflections/attempt-*.md
  - Max 3 (token budget ~1500)
  - Pass previous failed approaches as "things not to do" list
```

### 4.6.2: Strategy Generation on Stagnation (AD-07, v0.13.0)

When `checkConvergence` returns `stagnating`, the Orchestrator generates a concrete strategy override from available context before the next retry.

```
if convergence_result.status == "stagnating":

  // 1. Gather context
  reflections = Glob(".mpl/mpl/phases/{current_phase}/reflections/attempt-*.md")
  prior_attempts = reflections.map(f => Read(f))  // max 3, most recent first
  phase0_contracts = Read(".mpl/mpl/phase0/api-contracts.md") or ""
  phase0_errors = Read(".mpl/mpl/phase0/error-spec.md") or ""
  gate_failures = Read(".mpl/mpl/hard3-violations.md") or Read last Hard 1/2 error output

  // 2. Synthesize strategy (Orchestrator inline — NOT a separate agent)
  strategy_override = {
    alternative_approach: string,  // "Use X pattern instead of Y"
    must_not_do: [string],         // "Do NOT retry Z — failed in attempt 2"
    phase0_hint: string,           // relevant constraint from phase0 artifacts
    source_reflections: [attempt_ids]
  }

  // 3. Write for Phase Runner consumption
  Write(".mpl/mpl/phases/{current_phase}/strategy-override.json",
        JSON.stringify(strategy_override, null, 2))

  announce: "[MPL] AD-07: Strategy override generated. Try: {alternative_approach}. Avoid: {must_not_do.length} items."

  // 4. Fallback: no actionable patterns → generic re-approach
  if prior_attempts.length == 0 or no actionable patterns:
    strategy_override = {
      alternative_approach: "Re-read Phase 0 artifacts. Re-approach from first principles.",
      must_not_do: [],
      phase0_hint: "Check api-contracts.md and error-spec.md.",
      source_reflections: []
    }
```

**Phase Seed integration**: `commands/mpl-run-execute.md` Step 4.0.5 loads `strategy-override.json` when regenerating seed for a fix-loop retry:

```
if exists(".mpl/mpl/phases/{phase.id}/strategy-override.json"):
  strategy = JSON.parse(Read(".mpl/mpl/phases/{phase.id}/strategy-override.json"))
  seed.strategy_override = strategy
  // Runner prompt: "MUST NOT DO: {must_not_do}" + "TRY INSTEAD: {alternative_approach}"
```

**RUNBOOK Update**: After each fix attempt, append to `.mpl/mpl/RUNBOOK.md`:
```markdown
## Fix Loop Iteration {N}
- **Target Gate**: {failed_gate}
- **Fix Strategy**: {strategy_description}
- **Pass Rate**: {new_pass_rate}% (delta: {delta})
- **Convergence**: {convergence_status}
- **Timestamp**: {ISO timestamp}
```

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

  4. Generate recovery context:
     - What was completed (preserved TODO list with outputs)
     - What failed (failure_info with retry history)
     - Contaminated files that were rolled back

  5. Report:
     "[MPL] Circuit break on phase-{N}. {safe_count}/{total_count} TODOs preserved.
      Rolled back: {rolled_back_files}. Recovery context saved."
```

Recovery context saved to `.mpl/mpl/phases/phase-N/recovery.md`.

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
