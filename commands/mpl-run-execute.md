---
description: MPL Execution Protocol - Phase Execution Loop, Context Assembly, 3-Gate Quality, Fix Loop
---

# MPL Execution: Step 4 (Phase Execution Loop)

This file contains Step 4 of the MPL orchestration protocol — the core execution engine.
Load this when `current_phase` is `mpl-phase-running`.

---

## Debug Logging (Protocol Level)

All decision points in Phase Execution MUST emit debug logs when `.mpl/config.json` has `"debug": { "enabled": true }`.
Use the `debugLog`, `debugDecision`, and `debugTransition` functions from `hooks/lib/mpl-debug.mjs`.

| Decision Point | Category | What to Log |
|----------------|----------|-------------|
| Context assembly | `context-assembly` | Loaded artifacts, PD tier counts, impact file count, token budget |
| Phase model routing | `model-selection` | phase_model (sonnet/opus), reason (complexity/architecture) |
| Worker model routing | `model-selection` | worker_model (sonnet/opus), retry_count, architecture tag |
| Phase Runner dispatch | `agent-dispatch` | phase_id, phase_name, model, context size estimate |
| Phase Runner result | `phase-transition` | status (complete/circuit_break), pass_rate, micro_fixes |
| Gate 0.5 result | `gate` | errors, warnings, action (fix loop/proceed) |
| Gate 1 result | `gate` | pass_rate, threshold, action (proceed/fix loop) |
| Gate 2 result | `gate` | verdict (PASS/NEEDS_FIXES/REJECT) |
| Gate 3 result | `gate` | pp_violations, h_items_resolved |
| Fix loop iteration | `convergence` | iteration, pass_rate, delta, convergence_status |
| Convergence detection | `convergence` | status (improving/stagnating/regressing), suggestion |
| Circuit break | `escalation` | phase_id, failure_summary, escalation target |
| Redecomposition | `escalation` | redecompose_count, remaining_phases |
| Parallel TODO dispatch | `routing` | independent_count, sequential_count, concurrent_workers |

Example usage in orchestrator:
```
// Phase model routing
debugDecision(cwd, 'model-selection', `Phase Runner model: ${phase_model}`, {
  phase_id, complexity: phase.complexity, tags: phase.tags,
}, phase.complexity === 'L' ? 'L complexity → opus' : 'Default → sonnet')

// Gate result
debugLog(cwd, 'gate', `Gate 1: pass_rate=${pass_rate}%`, {
  pass_rate, threshold: 95, action: pass_rate >= 95 ? 'proceed' : 'fix_loop'
})

// Convergence
debugDecision(cwd, 'convergence', `Fix loop: ${convergence_result.status}`, {
  iteration: fix_loop_count, pass_rate, delta: convergence_result.delta,
}, convergence_result.suggestion || 'Improving — continue')
```

---

## Step 4: Phase Execution Loop (CORE)

For each phase in order:

### 4.1: Context Assembly

```
context = {
  phase0_artifacts: load_phase0_artifacts(),        // Phase 0 Enhanced outputs
  pivot_points:     Read(".mpl/pivot-points.md"),
  phase_decisions:  build_tiered_pd(current_phase), // 3-Tier PD
  phase_definition: phases[current_index],
  impact_files:     load_impact_files(phase.impact),
  maturity_mode:    config.maturity_mode,
  prev_summary:     Read previous phase's state-summary.md (if available),
  dep_summaries:    load_dependency_summaries(current_phase),  // All phases referenced in interface_contract.requires
  verification_plan:  load_phase_verification_plan(current_phase),  // A/S/H items for this phase
  learnings:        load_learnings()                // F-11: Past run learnings (optional)
}
```

#### Run-to-Run Learnings Loading (F-11)

```
load_learnings():
  path = ".mpl/memory/learnings.md"
  if exists(path):
    content = Read(path)
    // Cap at 2000 tokens (~100 lines) to bound context
    // Prioritize Failure Patterns section (most actionable)
    return truncate(content, max_lines=100)
  return null  // No learnings yet — first run
```

#### Phase 0 Artifacts Loading

```
load_phase0_artifacts():
  summary = Read(".mpl/mpl/phase0/summary.md")
  grade = Read(".mpl/mpl/phase0/complexity-report.json").grade

  artifacts = { summary }

  // Load only generated artifacts (check existence)
  if exists(".mpl/mpl/phase0/api-contracts.md"):
    artifacts.api_contracts = Read(".mpl/mpl/phase0/api-contracts.md")
  if exists(".mpl/mpl/phase0/examples.md"):
    artifacts.examples = Read(".mpl/mpl/phase0/examples.md")
  if exists(".mpl/mpl/phase0/type-policy.md"):
    artifacts.type_policy = Read(".mpl/mpl/phase0/type-policy.md")
  if exists(".mpl/mpl/phase0/error-spec.md"):
    artifacts.error_spec = Read(".mpl/mpl/phase0/error-spec.md")

  // Token budget: ~2000 tokens for summary + key sections
  // Full artifacts only for Phase 1-2 (foundation phases)
  // Later phases: summary only (unless phase impacts Phase 0 artifact areas)
  return artifacts
```

#### Dependency-Based Summary Loading

```
load_dependency_summaries(current_phase):
  deps = current_phase.interface_contract.requires || []
  summaries = {}
  for each dep in deps:
    from_phase = dep.from_phase
    if from_phase != previous_phase:  // previous phase already loaded via prev_summary
      summary_path = ".mpl/mpl/phases/{from_phase}/state-summary.md"
      if exists(summary_path):
        summaries[from_phase] = Read(summary_path)

  // Token budget: max 30% of model context for all injected summaries
  // If over budget: trim summaries to first 100 lines each
  return summaries
```

#### PD 3-Tier Classification

Orchestrator classifies all PDs before each phase:

```
build_tiered_pd(current_phase):
  all_pd = read(".mpl/mpl/phase-decisions.md")

  for each pd in all_pd:
    if pd.affected_files INTERSECT current_phase.impact.{create,modify} != EMPTY:
      -> Tier 1 (Active): full detail included
    elif pd.from_phase in current_phase.interface_contract.requires[].from_phase:
      -> Tier 1 (Active): full detail included
    elif pd.type in ['DB Schema', 'API Contract', 'Architecture']:
      -> Tier 2 (Summary): 1-line summary
    else:
      -> Tier 3 (Archived): IDs only, not sent in context

  Token budget: Tier 1 ~400-800, Tier 2 ~90-240 tokens. Total ~500-1000 (stable regardless of phase count).
```

#### Impact Files Loading

For each file in `phase.impact.{create, modify, affected_tests, affected_config}`:
- If exists -> `Read(file)`, cap at 500 lines per file
- If not exists -> note as "new file to create"
- Total budget: ~5000 tokens

Over budget strategies:
1. `modify` files: send file paths + `location_hint` only — Phase Runner reads as needed (F-24)
2. `affected_tests`: test file names + describe/it block names only
3. `affected_config`: relevant sections only

#### Self-Directed Context Note (F-24)

Phase Runner is authorized to Read/Grep within the impact scope directly.
Therefore, the orchestrator MAY provide file paths only (without full content)
for large files, letting the Phase Runner load relevant sections on demand.
This reduces context assembly cost while maintaining Phase Runner accuracy.

### 4.2: Phase Runner Execution (Fresh Session)

Each Phase Runner is a Task agent = fresh session. This naturally prevents context accumulation.

```
// Model routing: sonnet by default, opus for L complexity or architecture changes
phase_model = (phase.complexity == "L" || phase.tags.includes("architecture")) ? "opus" : "sonnet"

result = Task(subagent_type="mpl-phase-runner", model=phase_model,
     prompt="""
     You are a Phase Runner for MPL.
     Execute this single phase: plan TODOs, delegate to Workers, verify, summarize.

     ## Rules
     1. Scope discipline: Only work within this phase's scope.
     2. Impact awareness: Impact section lists files to touch. Out-of-scope -> create Discovery.
     3. Worker delegation: Delegate code changes to mpl-worker via Task tool.
     4. Incremental testing: After each TODO (or parallel group), immediately test the affected module. Fix failures before moving to the next TODO. Do NOT batch all implementation before testing.
     5. Cumulative verification: Run ALL tests (current + prior phases) at phase end. Record pass_rate.
     6. Discovery reporting: Unexpected findings -> Discovery with PP conflict assessment.
     7. PD Override: Changing past decisions -> explicit PD Override request.
     8. State Summary: Write thorough summary including pass_rate. This is the ONLY thing the next phase sees.
     9. Retry on failure: Same session retry (max 3). Change approach each time. After 3 -> circuit_break.
     10. Phase 0 reference on failure: When tests fail, consult Phase 0 artifacts (error-spec, type-policy, api-contracts) before fixing. Most failures stem from Phase 0 spec misalignment.
     11. Self-directed context (F-24): You may use Read/Grep within scope-bounded files (impact files listed below) to gather additional context. Do NOT search outside the phase's impact scope. This replaces passive "given context" with active exploration.
     12. Task-based TODO (F-23): Use TaskCreate to register TODOs instead of writing mini-plan.md checkboxes. Track TODO status via TaskUpdate (in_progress -> completed/failed). This enables worker dependency tracking and parallel dispatch readiness.

     ---
     ## Pivot Points
     {pp_content}

     ## Phase Decisions
     ### Active (full detail)
     {tier1_pd}
     ### Summary (1-line each)
     {tier2_pd}
     ### Archived (IDs only)
     {tier3_list}

     ## Phase Definition
     {phase_definition as YAML}

     ## Impact Files
     {impact_files content}

     ## Maturity Mode
     {maturity_mode}

     ## Previous Phase State Summary
     {previous phase's state-summary.md if available, or "N/A (first phase)"}

     ## Dependency Phase Summaries
     {dep_summaries — summaries from non-adjacent dependency phases, or "N/A"}

     ## Phase 0 Enhanced Artifacts
     ### Complexity: {grade} (score: {score})
     ### Summary
     {phase0_summary}
     ### API Contracts (if available)
     {api_contracts or "N/A — below complexity threshold"}
     ### Examples (if available)
     {examples or "N/A — below complexity threshold"}
     ### Type Policy (if available)
     {type_policy or "N/A — below complexity threshold"}
     ### Error Specification
     {error_spec}

     ## Verification Plan (A/S/H items for this phase)
     {phase_verification_plan}

     ## Past Run Learnings (F-11)
     {learnings or "N/A — first run, no accumulated learnings"}

     ## Scope-Bounded Search (F-24)
     You are authorized to Read/Grep the following files directly for additional context.
     Stay within this scope — do NOT explore files outside the impact boundary.
     Allowed files: {phase.impact.create + phase.impact.modify + phase.impact.affected_tests}
     Use this when:
     - The provided context is insufficient to implement a TODO
     - You need to understand how a function is called elsewhere within scope
     - Test files need inspection for assertion patterns

     ## Expected Output
     Return structured JSON:
     {
       "status": "complete" | "circuit_break",
       "task_ids": ["task-1", "task-2"],  // F-23: IDs from TaskCreate
       "state_summary": "markdown (required sections: 구현된 것, Phase Decisions, 검증 결과)",
       "new_decisions": [{ "id": "PD-N", "title": "...", "reason": "...", "affected_files": [...], "type": "..." }],
       "discoveries": [{ "id": "D-N", "description": "...", "pp_conflict": null | "PP-N", "recommendation": "..." }],
       "verification": {
         "criteria_results": [{ "criterion": "...", "pass": true|false, "evidence": "..." }],
         "regression_results": [{ "from_phase": "...", "test": "...", "pass": true|false }],
         "micro_cycle_fixes": 0,
         "pass_rate": 100
       },
       "failure_summary": "... (only if circuit_break)",
       "attempted_fixes": ["... (only if circuit_break)"]
     }

     State Summary recommended additional sections: "수정된 것", "Discovery 처리 결과", "다음 phase를 위한 참고"
     """)
```

### 4.2.1: Test Agent (Independent Verification)

After Phase Runner completes with status `"complete"`, dispatch the Test Agent for independent verification:

```
test_result = Task(subagent_type="mpl-test-agent", model="sonnet",
     prompt="""
     ## Phase: {phase_id} - {phase_name}
     ### Verification Plan (A/S-items for this phase)
     {phase_verification_plan}
     ### Interface Contract
     {phase_definition.interface_contract}
     ### Implemented Code
     {list of files created/modified by the Phase Runner}

     Write and run tests for this phase's implementation.
     """)
```

Merge test_result into Phase Runner's verification data:
- Update pass_rate with Test Agent's independent results
- Record any bugs_found for potential fix cycle
- If Test Agent pass_rate < Phase Runner's pass_rate: flag discrepancy

### 4.2.2: Task-based TODO Protocol (F-23)

Phase Runner uses Task tool instead of mini-plan.md for TODO management:

```
// Instead of writing mini-plan.md:
// - [ ] TODO 1: implement X
// - [ ] TODO 2: add tests for X

// Use Task tool:
TaskCreate(description="TODO 1: implement X", priority="high")
TaskCreate(description="TODO 2: add tests for X", priority="medium")

// Before delegating to worker:
TaskUpdate(id=task_id, status="in_progress")

// After worker completes:
TaskUpdate(id=task_id, status="completed")  // or "failed"
```

Benefits over mini-plan.md:
- Worker dependency tracking via Task metadata
- Parallel dispatch: independent Tasks can run simultaneously (F-13)
- Status synchronization: orchestrator can poll Task status
- No model-generated checkbox parsing errors

Backward compatibility: mini-plan.md is still written as a human-readable artifact,
but Task tool is the SSOT for TODO state during execution.

### 4.2.3: Background Execution for Independent TODOs (F-13)

When Phase Runner identifies independent TODOs (no file overlap), dispatch workers in parallel:

```
// File conflict detection (v3.1):
for each pair of pending TODOs:
  files_a = todo_a.impact_files
  files_b = todo_b.impact_files
  if intersection(files_a, files_b) is EMPTY:
    -> mark as independent, eligible for parallel dispatch

// Parallel dispatch:
for each independent TODO group:
  // Model routing: opus for architecture changes or 3+ retry failures
  worker_model = (todo.retry_count >= 3 || todo.tags.includes("architecture")) ? "opus" : "sonnet"
  Task(subagent_type="mpl-worker", model=worker_model,
       prompt="...", run_in_background=true)

// Sequential fallback:
for each TODO with file conflicts:
  worker_model = (todo.retry_count >= 3 || todo.tags.includes("architecture")) ? "opus" : "sonnet"
  Task(subagent_type="mpl-worker", model=worker_model,
       prompt="...", run_in_background=false)

// Wait and collect:
for each background task:
  result = await task completion
  TaskUpdate(id=task_id, status=result.status)
```

Constraints:
- Maximum 3 concurrent background workers per phase
- File conflict detection uses v3.1's existing overlap logic
- If any parallel worker fails, remaining workers continue
- Failed worker results feed into fix cycle (existing behavior)
- Phase Runner must wait for ALL workers before proceeding to verification

### 4.3: Result Processing

**On `"complete"`**:

```
1. Validate state_summary required sections: ["구현된 것", "Phase Decisions", "검증 결과"]
   - Missing -> request supplement (1 attempt). Still missing -> warn, proceed (non-blocking)
2. Save state_summary to .mpl/mpl/phases/phase-N/state-summary.md
3. Save verification to .mpl/mpl/phases/phase-N/verification.md
4. Update phase-decisions.md with result.new_decisions
5. Process discoveries (see Discovery Processing section)
6. Update MPL state:
   phases.completed++, phase_details[N].status = "completed"
   phase_details[N].criteria_passed, pass_rate, micro_fixes, pd_count, discoveries
   totals.total_micro_fixes += result.verification.micro_cycle_fixes
   cumulative_pass_rate = result.verification.pass_rate
   // M-5: Populate pass_rate_history for convergence detection
   convergence.pass_rate_history.push(result.verification.pass_rate)
7. Update pipeline state: current_phase = "mpl-phase-complete"
8. Profile: Record phase execution profile to .mpl/mpl/profile/phases.jsonl:
   {
     "step": "phase-{N}",
     "name": phase_name,
     "pass_rate": pass_rate,
     "micro_fixes": micro_fixes,
     "criteria_passed": "X/Y",
     "estimated_tokens": { "context": ~ctx_size, "output": ~out_size, "total": ~total },
     "retries": retry_count,
     "duration_ms": elapsed
   }
9. Report: "[MPL] Phase N/total 완료: {name}. Pass rate: {pass_rate}%. Micro-fixes: {micro_fixes}. PD {count}건."
10. **RUNBOOK Update (F-10)**: Append to `.mpl/mpl/RUNBOOK.md`:
    ```markdown
    ## Phase {N} Complete: {name}
    - **Pass Rate**: {pass_rate}%
    - **Criteria**: {criteria_passed}
    - **Micro-fixes**: {micro_fixes}
    - **PDs Created**: {pd_count}
    - **Discoveries**: {discovery_count}
    - **Timestamp**: {ISO timestamp}
    ```
11. More phases -> current_phase = "mpl-phase-running", continue 4.1
12. All done -> proceed to Step 4.5 (3-Gate Quality)
```

**On `"circuit_break"`**:

```
1. Record: phase_details[N].status = "circuit_break", phases.circuit_breaks++
2. Update pipeline state: current_phase = "mpl-circuit-break"
3. **RUNBOOK Update (F-10)**: Append to `.mpl/mpl/RUNBOOK.md`:
   ## Circuit Break: Phase {N} - {name}
   - **Failure**: {failure_summary}
   - **Attempted Fixes**: {attempted_fixes list}
   - **Retries Exhausted**: 3/3
   - **Timestamp**: {ISO timestamp}
4. **Dynamic Escalation (F-21)**: Check pipeline_tier before redecomposition:
   - If pipeline_tier < "frontier":
     escalation = escalateTier(cwd, "circuit_break", { completed_phases, failed_phase })
     If escalation succeeded:
       Report: "[MPL] Escalating: {from} → {to}. Preserving completed work."
       RUNBOOK: Append "## Tier Escalation: {from} → {to}"
       Re-run Triage with new tier (reload skipped steps)
       Continue from failed phase with expanded pipeline
   - If pipeline_tier == "frontier" or escalation returns null:
     Proceed to Redecomposition (4.4)
5. Proceed to Redecomposition (4.4) if no escalation
```

### 4.3.5: Side Interview (Conditional)

After processing phase results, check if a Side Interview is needed before the next phase.

Trigger conditions (ANY triggers the interview):
1. Phase reported a CRITICAL discovery
2. Phase has 1+ H-items in verification_plan (human confirmation required)
3. AD (After Decision) marker was created in this phase

If NO triggers -> skip Side Interview, proceed to next phase.

If triggered:

```
interview_role = determine_role(triggers):
  - CRITICAL discovery -> "Issue Resolution": present discovery and ask for resolution
  - H-items present -> "H-items Verification": present H-items for human judgment
  - AD marker -> "AD Sufficiency Check": confirm AD interface definition is adequate

AskUserQuestion based on interview_role:
  - Issue Resolution: "Phase {N}에서 CRITICAL discovery가 발생했습니다: {description}. 어떻게 처리할까요?"
    Options: "수용" | "반려" | "수정 후 계속"
  - H-items: "Phase {N}의 H-items를 확인해주세요: {h_items_list}"
    Options: "모두 확인됨" | "문제 있음 (수정 필요)"
  - AD Sufficiency: "AD-{N}의 인터페이스 정의가 충분한가요? {ad_details}"
    Options: "충분함" | "보완 필요"

Record Side Interview results in `.mpl/mpl/phases/phase-N/side-interview.md`
Report: "[MPL] Side Interview (Phase {N}): {role}. Result: {outcome}."
```

### 4.3.6: Session Context Persistence (F-12)

After each phase completes, persist critical state to survive context compression:

```
<remember priority>
[MPL Session State]
- Pipeline: {pipeline_id}
- Phase: {completed_phase}/{total_phases} complete
- Tier: {pipeline_tier}
- PP Summary: {top 3 PP names and status}
- Last Phase: {phase_name} — {pass/fail}, pass_rate={pass_rate}%
- Last Failure: {failure_reason or "none"}
- Next: {next_phase_name or "finalize"}
- RUNBOOK: .mpl/mpl/RUNBOOK.md
</remember>
```

This tag is emitted by the orchestrator after Step 4.3 result processing. Combined with RUNBOOK.md (file-based), this creates a dual safety net:
- `<remember priority>` — survives context compression within the session
- `RUNBOOK.md` — survives session boundaries (readable by next session)

### 4.3.7: Orchestrator Context Cleanup

After each phase completes, manage orchestrator context to prevent accumulation:

1. Ensure state_summary is saved to `.mpl/mpl/phases/phase-N/state-summary.md` (already done in 4.3)
2. Emit `<remember priority>` tag with critical state (4.3.6 above)
3. Release detailed phase data from orchestrator working memory
4. For next phase, load only:
   - Previous phase summary (from file)
   - Dependency summaries (from files, per interface_contract.requires)
   - Updated phase-decisions.md
   - Current phase definition

This ensures each phase starts with a bounded context regardless of total phase count.

### 4.4: Redecomposition (on circuit break)

```
redecompose_count = mpl_state.redecompose_count + 1

if redecompose_count > 2 (max_redecompose):
  -> pipeline: "mpl-failed", MPL: status = "failed"
  -> Report failure (preserve completed results), EXIT

else:
  mpl_state.redecompose_count = redecompose_count

  Task(subagent_type="mpl-decomposer", model="opus",
       prompt="""
       ## Redecomposition Request
       A phase failed after exhausting retries. Redecompose REMAINING work only.

       ### Completed Phases (preserve, do NOT regenerate)
       {for each completed phase: id, name, state-summary snippet}

       ### Failed Phase
       ID: {id}, Name: {name}
       Failure: {result.failure_summary}
       Attempts: {result.attempted_fixes}

       ### Original Remaining Phases (unconsumed)
       {phases not yet started}

       ### Existing Phase Decisions
       {all PDs from .mpl/mpl/phase-decisions.md}

       ### Codebase Analysis
       {codebase-analysis.json}

       Break failed phase differently or use new strategy. Output YAML only.
       """)

  After receiving new phases:
  1. Replace remaining phases (keep completed intact)
  2. Create new .mpl/mpl/phases/phase-N/ directories
  3. Update MPL state with new phase_details
  4. pipeline: current_phase = "mpl-phase-running"
  5. Resume from first new phase (back to 4.1)
```

### 4.5: 3-Gate Quality

After all phases complete, apply the 3-Gate Quality system before finalization.

#### Gate 0.5: Project-Wide Type Check (F-17)

Before running tests, perform project-level type checking:

```
diagnostics = lsp_diagnostics_directory(path=".", strategy="auto")
// strategy="auto": uses tsc when tsconfig.json exists, falls back to LSP iteration
// Standalone fallback (F-04): Bash("npx tsc --noEmit") or Bash("python -m py_compile *.py")

if diagnostics.errors > 0:
  Report: "[MPL] Type check: {errors} errors found. Entering fix loop."
  -> Enter fix loop targeting type errors before Gate 1

if diagnostics.warnings > 5:
  Report: "[MPL] Type check: {warnings} warnings. Proceeding with caution."

Report: "[MPL] Type check: clean. Proceeding to Gate 1."
```

This catches type errors before test execution, reducing fix loop iterations.

#### Gate 1: Automated Tests

Run the full test suite:
- Execute all test commands (pytest, npm test, etc.)
- pass_rate must be >= 95% to proceed to Gate 2
- If pass_rate < 95%: enter fix loop (see 4.6)

#### Gate 2: Code Review

```
Task(subagent_type="mpl-code-reviewer", model="sonnet",
     prompt="""
     ## Review Scope
     All files changed during pipeline execution.
     ### Pivot Points
     {pivot_points}
     ### Interface Contracts
     {all phase interface_contracts}
     ### Changed Files
     {list all created/modified files across all phases}

     Review all changes for the Quality Gate.
     """)
```

Verdict handling:
- PASS -> proceed to Gate 3
- NEEDS_FIXES -> enter fix loop with prioritized fix list (see 4.6)
- REJECT -> report to user, enter mpl-failed state

#### Gate 3: PP Compliance

Final validation focused on Pivot Point compliance and H-item resolution:
- Verify all CONFIRMED PPs are satisfied (no violations across all phases)
- Check PROVISIONAL PPs for drift (flag any deviations for user review)
- Present H-items requiring human judgment via AskUserQuestion
- S-items are already covered by Gate 1 (automated tests) — no duplication here

Gate 3 pass criteria: no PP violations detected + all H-items resolved.

If Gate 3 fails -> enter fix loop (see 4.6).

All 3 gates pass -> proceed to Step 5 (E2E & Finalize).
Report: `[MPL] 3-Gate Quality: Gate 1 {pass_rate}%, Gate 2 {verdict}, Gate 3 {pass/fail}.`

**RUNBOOK Update (F-10)**: Append to `.mpl/mpl/RUNBOOK.md`:
```markdown
## 3-Gate Quality Results
- **Gate 0.5 (Type Check)**: {errors} errors, {warnings} warnings
- **Gate 1 (Tests)**: {pass_rate}%
- **Gate 2 (Code Review)**: {verdict}
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

**RUNBOOK Update (F-10)**: After each fix attempt, append to `.mpl/mpl/RUNBOOK.md`:
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

---
