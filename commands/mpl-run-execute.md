---
description: MPL Execution Protocol - Phase Execution Loop, Context Assembly, 3-Gate Quality, Fix Loop
---

# MPL Execution: Step 4 (Phase Execution Loop)

This file contains Step 4 of the MPL orchestration protocol — the core execution engine.
Load this when `current_phase` is `mpl-phase-running`.

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
  verification_plan:  load_phase_verification_plan(current_phase)  // A/S/H items for this phase
}
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
1. `modify` files: `location_hint` +/- 50 lines only
2. `affected_tests`: test file names + describe/it block names only
3. `affected_config`: relevant sections only

### 4.2: Phase Runner Execution (Fresh Session)

Each Phase Runner is a Task agent = fresh session. This naturally prevents context accumulation.

```
result = Task(subagent_type="mpl-phase-runner", model="sonnet",
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

     ## Expected Output
     Return structured JSON:
     {
       "status": "complete" | "circuit_break",
       "state_summary": "markdown (required sections: 구현된 것, Phase Decisions, 검증 결과)",
       "new_decisions": [{ "id": "PD-N", "title": "...", "reason": "...", "affected_files": [...], "type": "..." }],
       "discoveries": [{ "id": "D-N", "description": "...", "pp_conflict": null | "PP-N", "recommendation": "..." }],
       "verification": {
         "criteria_results": [{ "criterion": "...", "pass": true|false, "evidence": "..." }],
         "regression_results": [{ "from_phase": "...", "test": "...", "pass": true|false }]
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
10. More phases -> current_phase = "mpl-phase-running", continue 4.1
11. All done -> proceed to Step 4.5 (3-Gate Quality)
```

**On `"circuit_break"`**:

```
1. Record: phase_details[N].status = "circuit_break", phases.circuit_breaks++
2. Update pipeline state: current_phase = "mpl-circuit-break"
3. Proceed to Redecomposition (4.4)
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

### 4.3.6: Orchestrator Context Cleanup

After each phase completes, manage orchestrator context to prevent accumulation:

1. Ensure state_summary is saved to `.mpl/mpl/phases/phase-N/state-summary.md` (already done in 4.3)
2. Release detailed phase data from orchestrator working memory
3. For next phase, load only:
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

### 4.6: Fix Loop (with Convergence Detection)

When any gate fails, enter the fix loop:

1. Analyze failure: which gate failed, what specifically failed
2. Dispatch targeted fixes via mpl-worker
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
