---
description: MPL Execution Protocol - Phase Execution Loop, Context Assembly, Gate System, Fix Loop
---

# MPL Execution: Step 4 (Phase Execution Loop)

This file contains Step 4 of the MPL orchestration protocol — the core execution engine.
Load this when `current_phase` is `mpl-phase-running`.

> **See also:** `mpl-run-execute-context.md` (Context Assembly details), `mpl-run-execute-gates.md` (Gate System), `mpl-run-execute-parallel.md` (TODO parallel dispatch).

---

## Step 4: Phase Execution Loop (CORE)

### 4.0: Phase Execution Dispatch

For each phase in decomposition order:

If phase has `parallel_with` field AND parallel phases have no file overlap:
  ```
  // Parallel execution for independent phases
  announce: "[MPL] Executing {parallel_phases.length} phases in parallel"

  results = parallel_map(parallel_phases, fn(phase_id):
    seed = generate_phase_seed(phase_id, all_prior_summaries)
    context = assemble_context(phase_id, seed)
    return execute_phase(context, isolation: "worktree")
  , max_concurrent: 3)

  // Merge worktree results sequentially
  for each result in results:
    merge_worktree(result)
    save_state_summary(result)

  // Post-Join Semantic Boundary Verification — L2 (CB-08)
  // Mechanical key extraction for boundary conflicts
  if parallel_phases.length > 1:
    all_contracts = collect_contract_files(parallel_phases)
    if all_contracts.length > 0:
      reconciliation_issues = verify_boundary_keys(all_contracts)
      if reconciliation_issues.length > 0:
        announce: "[MPL] CB-08 L2: {reconciliation_issues.length} boundary conflicts after parallel join"
        → Dispatch targeted boundary fix
      else:
        announce: "[MPL] CB-08 L2: Post-join verification clean."

  // Cumulative test run
  run_cumulative_tests(parallel_phases)

else:
  // Sequential execution (default)
  // Normal flow: 4.0.5 → 4.1 → 4.2 → 4.3 → 4.8
  ```

For each phase in order:

### 4.0.5: Phase Seed Generation

Generate Phase Seed just-in-time, immediately before context assembly:

```
if config.phase_seed?.enabled != false:
  prior_summaries = all completed phase state-summary.md files
  phase0_relevant = extract_relevant_phase0(phase_definition, phase0_artifacts)

  // Load boundary contracts (SEED-01)
  contract_files = null
  if phase_definition.interface_contract?.contract_files:
    contract_files = {}
    for each cf in phase_definition.interface_contract.contract_files:
      contract_files[cf] = Read(cf)
    if phase_definition.interface_contract.adjacent_contracts?.inbound:
      contract_files["inbound"] = Read(phase_definition.interface_contract.adjacent_contracts.inbound)
    if phase_definition.interface_contract.adjacent_contracts?.outbound:
      contract_files["outbound"] = Read(phase_definition.interface_contract.adjacent_contracts.outbound)

  // Inline seed generation (orchestrator generates directly)
  seed = {
    goal: phase_definition.goal,
    acceptance_criteria: phase_definition.acceptance_criteria,
    todo_structure: derive_todos_from_phase_definition(phase_definition),
    exit_conditions: phase_definition.success_criteria,
    contract_snippet: extract_contract_keys(contract_files),
    phase0_context: phase0_relevant
  }

  save seed to .mpl/mpl/phases/{phase.id}/phase-seed.yaml
  context.phase_seed = seed
  announce: "[MPL] Phase Seed generated for {phase.id}: {seed.todo_structure.length} TODOs"
else:
  context.phase_seed = null  // Legacy mode
```

### 4.0.5.1: Seed Validation (SEED-03 + SNT-S0, v0.10.0)

If Phase Seed was generated:
1. **SEED-03**: `mpl-validate-seed` hook validates required fields (goal, acceptance_criteria, todo_structure, exit_conditions, contract_snippet if boundary)
2. **SNT-S0**: `mpl-sentinel-s0` hook verifies contract_snippet keys ⊆ contracts/*.json keys
3. If either fails: re-generate seed with validation feedback
4. Max 2 Seed regeneration attempts before fallback to Legacy mode

After Phase Runner completes:
5. **SNT-S1**: `mpl-sentinel-s1` hook validates export-manifest.json symbols exist in generated files
6. If S1 fails: re-invoke Phase Runner with feedback ("manifest references non-existent symbol X")

After Test Agent completes:
7. **SNT-S3**: `mpl-sentinel-s3` hook validates test import paths resolve to actual files
8. If S3 fails: re-invoke Test Agent with feedback ("import path X does not exist")


### 4.1: Context Assembly

> **Full context assembly protocol has been moved to `mpl-run-execute-context.md`.**
> This includes: context structure, F-11 learnings loading, F-25 4-Tier memory, F-30 error files, F-31 checkpoint recovery, F-32 adaptive loading, Phase 0 artifacts loading, dependency summaries, PD 2-Tier classification, impact files loading, F-24 self-directed context, and 4.1.5 Worktree Isolation.
>
> Load `mpl-run-execute-context.md` when entering Step 4.1.

Context structure reference:
```
context = {
  phase0_artifacts, pivot_points, phase_decisions, phase_definition,
  phase_seed, impact_files, pp_proximity, prev_summary, dep_summaries,
  verification_plan, learnings, error_files, regression_suite
}
```

#### 4.1.6: Regression Suite Loading (TS-03, v0.8.1)

Load accumulated regression tests for Phase Runner's cumulative verification:

```
regression_suite = Read(".mpl/regression-suite.json") or null

if regression_suite AND regression_suite.accumulated_tests.length > 0:
  context.regression_suite = {
    regression_command: regression_suite.regression_command,
    total_assertions: regression_suite.total_assertions,
    phase_count: regression_suite.accumulated_tests.length
  }
  // Phase Runner uses this command for cumulative verification (Rule 5)
else:
  context.regression_suite = null
```

### 4.2: Phase Runner Execution (Fresh Session)

Each Phase Runner is a Task agent = fresh session. This naturally prevents context accumulation.

```
// Model routing: sonnet by default, opus for L complexity or architecture changes
phase_model = (phase.complexity == "L" || phase.tags.includes("architecture")) ? "opus" : "sonnet"

result = Task(subagent_type="mpl-phase-runner", model=phase_model,
     prompt="""
     You are a Phase Runner for MPL.
     Execute this single phase: plan TODOs, implement code changes directly, verify, summarize.

     ## Rules
     1. Scope discipline: Only work within this phase's scope.
     2. Impact awareness: Impact section lists files to touch. Out-of-scope -> create Discovery.
     3. Direct implementation: Implement code changes DIRECTLY using Edit/Write/Bash. You are the implementer — all code changes happen directly in Phase Runner.
     4. Incremental testing: After each TODO, immediately test the affected module. Fix failures before moving to the next TODO. Do NOT batch all implementation before testing.
     5. Cumulative verification: Run ALL tests (current + prior phases) at phase end. Record pass_rate.
     6. Discovery reporting: Unexpected findings -> Discovery with PP conflict assessment.
     7. PD Override: Changing past decisions -> explicit PD Override request.
     8. State Summary: Write thorough summary including pass_rate. This is the ONLY thing the next phase sees.
     9. Retry on failure: Same session retry (max 3). Change approach each time. After 3 -> circuit_break.
     10. Phase 0 reference on failure: When tests fail, consult Phase 0 artifacts (error-spec, type-policy, api-contracts) before fixing. Most failures stem from Phase 0 spec misalignment.
     11. Self-directed context (F-24): You may use Read/Grep within scope-bounded files (impact files listed below) to gather additional context. Do NOT search outside the phase's impact scope.
     12. Task-based TODO (F-23): Use TaskCreate to register TODOs. Track TODO status via TaskUpdate (in_progress -> completed/failed).

     ---
     ## Pivot Points
     {pp_content}

     ## Phase Decisions
     ### Active (full detail)
     {tier1_pd}
     ### Summary (1-line each)
     {tier2_pd}

     ## Phase Definition
     {phase_definition as YAML}

     ## Phase Seed (D-01, v0.6.0)
     {context.phase_seed as YAML or "N/A — Legacy mode, generate mini-plan from Phase Definition above"}

     If Phase Seed is provided: use mini_plan_seed.todo_structure as your canonical TODO list.
     Do NOT generate your own mini-plan — the Seed is your ground truth.
     Use acceptance_criteria[].touches_todos to know which TODOs satisfy which criteria.
     Use phase0_context embedded in the Seed instead of loading Phase 0 artifacts separately.
     Use exit_conditions to determine when this phase is formally complete.

     ## Impact Files
     {impact_files content}

     ## Previous Phase Context (N-1 only)
     ### State Summary
     {previous phase's state-summary.md if available, or "N/A (first phase)"}
     ### Verification Results
     {previous phase's verification.md if available, or "N/A"}
     ### Code Changes (diff)
     {previous phase's changes.diff if available, or "N/A"}

     ## Dependency Phase Summaries (P-01 L0/L1/L2, v0.8.8)
     ### L2 (Direct Dependencies — full detail)
     {dep_summaries.L2 — full state-summary.md for interface_contract.requires phases, or "N/A"}
     ### L1 (Overlapping Phases — file list + interface changes)
     {dep_summaries.L1 — Summary + Files Changed + Interface Changes sections, or "N/A"}
     ### L0 (All Other Phases — 1-line each)
     {dep_summaries.L0 — bullet list of 1-line summaries, or "N/A"}

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

     ## Adaptive Memory (F-25)
     ### Semantic (project knowledge)
     {adaptive_memory.semantic or "N/A — first run"}
     ### Procedural (relevant tool patterns)
     {adaptive_memory.procedural or "N/A — no matching entries"}
     ### Episodic (previous Phase summaries)
     {adaptive_memory.episodic or "N/A — first Phase"}

     ## Past Run Learnings (F-11) — Legacy
     {learnings or "N/A — refer to Adaptive Memory when F-25 is active"}

     ## Prior Error Files (F-30)
     {error_files contents or "N/A — no prior errors for this phase"}

     ## Compaction Recovery Context (F-31, v3.8)
     {context.checkpoint_recovery or "N/A — no compaction occurred before this phase"}

     If present, this checkpoint captures the pipeline state at the moment of context compression.
     Use it to verify your understanding of completed work and pending tasks before proceeding.

     ## Scope-Bounded Search (F-24)
     You are authorized to Read/Grep the following files directly for additional context.
     Stay within this scope — do NOT explore files outside the impact boundary.
     Allowed files: {phase.impact.create + phase.impact.modify + phase.impact.affected_tests}
     Use this when:
     - The provided context is insufficient to implement a TODO
     - You need to understand how a function is called elsewhere within scope
     - Test files need inspection for assertion patterns

     ## Working Memory (F-25)
     working.md is initialized at Phase start.
     Record TODO state changes and key findings in working.md during execution.
     On Phase completion, convert working.md content to episodic format and return it.
     {working_md_content or "N/A — first Phase, working memory empty"}

     ## Regression Suite (TS-03, v0.8.1)
     {context.regression_suite ? "Run this command at phase end for cumulative verification:\n" + context.regression_suite.regression_command + "\nAccumulated: " + context.regression_suite.total_assertions + " assertions from " + context.regression_suite.phase_count + " prior phases" : "N/A — first phase, no regression suite yet"}

     ## Expected Output
     Return structured JSON:
     {
       "status": "complete" | "circuit_break",
       "task_ids": ["task-1", "task-2"],  // F-23: IDs from TaskCreate
       "state_summary": "markdown (required sections: What was implemented, Phase Decisions, Verification results)",
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

     State Summary recommended additional sections: "What was modified", "Discovery processing results", "Notes for next phase"
     """)
```

#### working.md Lifecycle During Phase Runner Dispatch (F-25)

Manage working.md before and after Phase Runner dispatch:

```
// 1. Phase start: initialize working.md
Write(".mpl/memory/working.md", """
# Working Memory — Phase {N}: {phase_name}
Updated: {timestamp}

## TODOs
(Phase Runner fills after generating Mini-Plan)

## Notes
(Notes discovered by Phase Runner during execution)
""")

// 2. During Phase execution: Phase Runner autonomously updates working.md on TODO complete/fail
//    (handled inside Phase Runner — see mpl-phase-runner.md below)

// 3. Phase complete: transfer working.md contents to episodic.md then clear
if result.status == "complete":
  episodic_entry = format_episodic(result.working_memory_snapshot)
  // "### Phase {N}: {name} ({timestamp})\n{what was implemented}\n{key decisions}\n{verification results}"
  Append(".mpl/memory/episodic.md", episodic_entry)
  Write(".mpl/memory/working.md", "")  // clear
```

### 4.2.1: Phase Domain-Based Dynamic Routing (F-28)

The Decomposer (Step 3) assigns `phase_domain` tags to each Phase.
When dispatching a Phase Runner, the prompt and model are dynamically selected based on the domain.

#### phase_domain Tag List

| Domain | Description | Specialized Prompt | Model |
|--------|-------------|-------------------|-------|
| `db` | DB schema, migration, queries | SQL safety, migration rollback, indexes | sonnet |
| `api` | API endpoints, routing, middleware | RESTful rules, error codes, auth | sonnet |
| `ui` | Frontend, components, styling | Accessibility, responsive, state management | sonnet |
| `algorithm` | Complex logic, optimization, data structures | Time/space complexity, edge cases | **opus** |
| `test` | Writing tests, test infrastructure | Coverage, isolation, mocking strategy | sonnet |
| `infra` | Config, CI/CD, build, deployment | Env vars, Docker, security | sonnet |
| `general` | Unclassifiable or mixed | General (existing behavior) | sonnet |

#### Routing Protocol

```pseudocode
function dispatch_phase_runner(phase):
  domain = phase.phase_domain || "general"
  subdomain = phase.phase_subdomain || null
  task_type = phase.phase_task_type || null
  lang = phase.phase_lang || null

  # 1. Model selection
  if domain == "algorithm" and phase.complexity in ["L", "XL"]:
    model = "opus"
  else:
    model = "sonnet"  # default

  # 2. 4-Layer prompt composition (F-39)
  domain_prompt = load_domain_prompt(domain)
  subdomain_prompt = subdomain ? load_subdomain_prompt(domain, subdomain) : ""
  task_prompt = task_type ? load_task_prompt(task_type) : ""
  lang_prompt = lang ? load_lang_prompt(lang) : ""

  composed_prompt = compose_layers(domain_prompt, subdomain_prompt, task_prompt, lang_prompt)

  # 3. Dispatch Phase Runner
  phase_runner = dispatch(
    agent = "mpl-phase-runner",
    model = model,
    context = assemble_context(phase) + composed_prompt,
    phase_definition = phase
  )

  return phase_runner
```

#### Domain-Specific Prompt Format

`.mpl/prompts/domains/{domain}.md` (orchestrator injects into Phase Runner context):

```markdown
# Domain: {domain}
## Core Principles
- {domain-specific principle 1}
- {domain-specific principle 2}

## Cautions
- {common pitfall 1}
- {common pitfall 2}

## Verification Points
- {what to verify for this domain}
```

Example — `db.md`:
```markdown
# Domain: DB
## Core Principles
- Migrations must always be rollback-able
- Consider data size when adding indexes
- Schema changes must maintain backward compatibility with existing data

## Cautions
- DROP TABLE/COLUMN is irreversible — isolate in a separate Phase
- Do not mix ORM migrations with raw SQL
- Minimize transaction scope

## Verification Points
- Do both migration up and down succeed?
- Is it compatible with existing seed/fixture data?
- Are indexes appropriate for the query patterns?
```

#### 4-Layer Prompt Path Resolution (F-39)

Each layer is searched in two locations (in priority order):

| Layer | Project-specific custom | Plugin default |
|-------|------------------------|---------------|
| Domain | `.mpl/prompts/domains/{domain}.md` | `MPL/prompts/domains/{domain}.md` |
| Subdomain | `.mpl/prompts/subdomains/{domain}/{subdomain}.md` | `MPL/prompts/subdomains/{domain}/{subdomain}.md` |
| Task Type | `.mpl/prompts/tasks/{task_type}.md` | `MPL/prompts/tasks/{task_type}.md` |
| Language | `.mpl/prompts/langs/{lang}.md` | `MPL/prompts/langs/{lang}.md` |

Each layer is **optional** — skip if file doesn't exist.
At minimum, the Domain layer always exists (guarantees existing F-28 behavior).

#### When Domain Prompt Is Absent

If `.mpl/prompts/domains/` directory or the corresponding domain file doesn't exist:
- Use generic prompt (same as existing behavior)
- Domain prompts are **optional extensions** — no impact on pipeline operation if absent

#### Integration with F-22 Routing Patterns

After execution completes, also record domain information in routing-patterns.jsonl:
```jsonl
{"ts":"...","desc":"...","proximity":"non_pp","domain_distribution":{"db":2,"api":3,"test":1},"result":"success","tokens":85000}
```
Next run can reference domain distribution of similar tasks for pre-emptive prompt caching.

#### 4-Layer Context Injection into Phase Runner Prompt (F-39)

Add 4-Layer section to Step 4.2 Phase Runner dispatch prompt:

```
## Domain Context (F-28 + F-39)
Domain: {phase.phase_domain or "general"}
{domain_prompt_content or "General — no domain-specific prompt"}

## Subdomain Context (F-39)
Subdomain: {phase.phase_subdomain or "N/A"}
{subdomain_prompt_content or ""}

## Task Type Context (F-39)
Task Type: {phase.phase_task_type or "N/A"}
{task_prompt_content or ""}

## Language Context (F-39)
Language: {phase.phase_lang or "N/A"}
{lang_prompt_content or ""}
```

Integration with existing `phase_model` logic:
```
// Merge existing complexity-based routing with domain-based routing
phase_model = determine_model(phase):
  // 1. Existing rule: L complexity or architecture tag → opus
  if phase.complexity == "L" || phase.tags.includes("architecture"):
    return "opus"
  // 2. F-28 rule: algorithm domain + L/XL → opus
  if phase.phase_domain == "algorithm" and phase.complexity in ["L", "XL"]:
    return "opus"
  // 3. Default
  return "sonnet"
```

After model selection, record the chosen model in state for profile tracking:
```
writeState(cwd, { last_runner_model: phase_model })
```

### 4.2.2: Test Agent — Mandatory Independent Verification (F-40)

**ENFORCEMENT (B-01, v0.6.2): This step is NOT optional. The orchestrator MUST execute this check
after EVERY Phase Runner completion. Skipping this step is the #1 cause of "0 tests" pipelines.**

After Phase Runner completes with status `"complete"`, the Test Agent is dispatched as a **mandatory gate** based on phase_domain rules.

#### Domain-Based Invocation Rules

| phase_domain | Test Agent | Rationale |
|-------------|-----------|-----------|
| `ui` | **MANDATORY** | Component, hook, store contract tests required |
| `api` | **MANDATORY** | Integration, contract, error response tests required |
| `algorithm` | **MANDATORY** | Edge case, boundary, complexity verification — highest ROI |
| `db` | **MANDATORY** | Migration, CRUD, constraint tests required |
| `ai` | **MANDATORY** | Structured output schema, retry logic, fallback path, API key non-exposure |
| `test` | **SKIP** | Phase itself is test writing — avoid circular invocation |
| `infra` | **CONDITIONAL** | Only if `affected_tests` in phase impact is non-empty |
| `general` | **CONDITIONAL** | Only if source code files (.ts, .py, .rs, etc.) were created/modified |

#### Dispatch Protocol

```
// Determine if Test Agent is required
domain = phase_definition.phase_domain
is_mandatory = domain in ["ui", "api", "algorithm", "db", "ai"]
is_conditional = domain in ["infra", "general"]
is_skip = domain == "test"

if is_skip:
  Report: "[MPL] Phase {phase_id}: test domain — Test Agent skipped (circular)."
  -> proceed to 4.2.3

if is_conditional:
  has_source_changes = any file in changes matches *.ts|*.tsx|*.py|*.rs|*.go|*.java
  has_affected_tests = phase_definition.impact.affected_tests is non-empty
  if not (has_source_changes or has_affected_tests):
    Report: "[MPL] Phase {phase_id}: {domain} domain — no source changes, Test Agent skipped."
    -> proceed to 4.2.3

// Dispatch Test Agent (mandatory or conditional-triggered)
test_result = Task(subagent_type="mpl-test-agent", model="sonnet",
     prompt="""
     ## Phase: {phase_id} - {phase_name}
     ## Phase Domain: {domain}
     ### Verification Plan (A/S-items for this phase)
     {phase_verification_plan}
     ### Interface Contract
     {phase_definition.interface_contract}
     ### Implemented Code
     {list of files created/modified by the Phase Runner}
     ### Domain-Specific Test Requirements
     {domain_test_requirements[domain]}

     Write and run tests for this phase's implementation.
     ALL S-items MUST have corresponding executable tests.
     """)
```

#### Zero-Test Enforcement Gate

```
if is_mandatory AND test_result.test_results.total == 0:
  Report: "[MPL] FAIL: Phase {phase_id} ({domain}) — 0 tests generated for mandatory domain."
  -> Phase status = FAIL
  -> Enter fix loop: re-dispatch Test Agent with explicit failure context
  -> Max 2 re-attempts before circuit_break
```

#### Result Merging

Merge test_result into Phase Runner's verification data:
- Update pass_rate with Test Agent's independent results
- Record any bugs_found for potential fix cycle
- If Test Agent pass_rate < Phase Runner's pass_rate: flag discrepancy
- Record test_files_created for Gate 1 cumulative test suite

#### Token Impact

~13-24K additional per Phase (Test Agent invocation). ~129K for a 9-Phase project (25-30% of total budget).
Skip/conditional rules prevent unnecessary invocations, keeping actual additions at ~80-100K.


> **Steps 4.2.3 (Task-based TODO) and 4.2.4 (Background Execution) and 4.3.7 (Context Cleanup) have been moved to `mpl-run-execute-parallel.md`.**
> Load when parallel TODOs are detected during phase execution.

### 4.3: Result Processing

**On `"complete"`**:

```
1. Validate state_summary required sections: ["What was implemented", "Phase Decisions", "Verification results"]
   - Missing -> request supplement (1 attempt). Still missing -> warn, proceed (non-blocking)
2. Save state_summary to .mpl/mpl/phases/phase-N/state-summary.md
2.5. Generate and save code diff for N-1 context transfer (v0.7.0):
     diff = Bash("git diff HEAD~1 --stat --patch -- {phase_impact_files}", timeout=10000)
     Write(".mpl/mpl/phases/phase-N/changes.diff", diff)
     // If git diff fails (no commits yet, etc.), skip silently — diff is optional context
3. Save verification to .mpl/mpl/phases/phase-N/verification.md
4. Update phase-decisions.md with result.new_decisions
5. Process discoveries (see Discovery Processing section)
5.5. **Process warnings (HA-04, v0.12.0)**: If result.warnings is non-empty, store warnings for next Seed generation:
     - Append to `.mpl/mpl/phases/phase-N/warnings.json` (for traceability)
     - When generating the next Phase Seed, include relevant warnings in the `prior_summaries` context
     - Warnings that affect adjacent phases (dependency substitutions, platform constraints) → inject into next Seed's constraints section
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
9. Report: "[MPL] Phase N/total complete: {name}. Pass rate: {pass_rate}%. Micro-fixes: {micro_fixes}. PD count: {count}."
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
11. **Regression Suite Accumulation (TS-03, v0.8.1)**:
    Append this phase's test files to the regression suite:
    ```
    // Detect test files created/modified by this phase
    phase_test_files = result.test_files_created or
      Glob("{phase.impact_dir}/**/*.{test,spec}.{ts,tsx,js,jsx,py,rs}")

    if phase_test_files.length > 0:
      regression_suite = Read(".mpl/regression-suite.json") or { accumulated_tests: [], total_assertions: 0 }

      regression_suite.accumulated_tests.push({
        phase: phase.id,
        test_files: phase_test_files,
        test_command: detect_test_command(phase_test_files),  // e.g., "npx vitest run {files}"
        added_at: now_iso(),
        assertion_count: result.verification.test_count or 0
      })

      regression_suite.total_assertions += result.verification.test_count or 0
      regression_suite.regression_command = build_regression_command(regression_suite.accumulated_tests)

      Write(".mpl/regression-suite.json", JSON.stringify(regression_suite, null, 2))
      announce: "[MPL] Regression suite: {regression_suite.total_assertions} assertions accumulated across {regression_suite.accumulated_tests.length} phases"
    ```

12. More phases -> current_phase = "mpl-phase-running", continue 4.1
    → **Budget Check (F-33)**: See Step 4.3 extension — check session budget before starting next Phase.
13. All done -> proceed to Step 4.5 (Gate System)

#### Step 4.3 Extension: Budget Check (F-33)

Check session budget after Phase completes, before starting next Phase:

```python
budget = predictBudget(cwd)  # based on .mpl/context-usage.json

if budget.recommendation == "pause_now" or budget.recommendation == "pause_after_current":
    # Current Phase is complete — execute Graceful Pause
    execute_graceful_pause(budget, next_phase_id, completed_phases, remaining_phases)
    return  # exit orchestration loop
else:
    # Budget sufficient — continue to next Phase
    current_phase = "mpl-phase-running"
    continue  # return to Step 4.1
```

**Fail-open**: If `context-usage.json` is absent or stale (>30s), skip budget check and continue.
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
4. Phase retry budget exhausted → circuit break → pipeline failure
   pipeline = "mpl-failed"
   Report: "[MPL] Circuit break on Phase {N}. Pipeline failed. Preserving completed work."
```

### 4.3.5: Side Interview (Conditional — CRITICAL Only)

After processing phase results, check if a Side Interview is needed before the next phase.
Side Interviews **block execution flow**, so they should be minimized by resolving uncertainty sufficiently in the pre-interview (Step 1).

Trigger conditions — **Strengthened CRITICAL criteria**:
1. Phase reported a **CRITICAL** discovery that **directly conflicts with a CONFIRMED PP** or makes further execution impossible
2. ~~Phase has 1+ H-items in verification_plan~~ → H-items attempt best-effort automatic verification; trigger **only when unverifiable + PP violation risk**
3. ~~AD marker was created~~ → AD markers are only logged and proceed **automatically**. Side Interview only when PP conflict exists.

Non-CRITICAL items (H-items without PP conflict, AD markers, MED/LOW discoveries) are:
- Logged to `.mpl/mpl/phases/phase-N/deferred-items.md`
- Included in finalize report for post-hoc review
- **NOT blocking** — execution continues automatically

If NO CRITICAL triggers -> skip Side Interview, proceed to next phase.

If triggered (CRITICAL only):

```
interview_role = determine_role(triggers):
  - CRITICAL discovery + PP conflict -> "Issue Resolution": present discovery and ask for resolution
  - H-item + PP violation risk -> "PP Compliance Check": present conflict for human judgment

AskUserQuestion based on interview_role:
  - Issue Resolution: "A CRITICAL discovery occurred in Phase {N}: {description}. It conflicts with PP-{M}. How should this be handled?"
    Options: "Accept (modify PP)" | "Reject (keep current PP)" | "Modify and continue"
  - PP Compliance: "The result of Phase {N} may violate PP-{M}: {details}"
    Options: "Not a violation (continue)" | "Is a violation (fix needed)"

Record Side Interview results in `.mpl/mpl/phases/phase-N/side-interview.md`
Report: "[MPL] Side Interview (Phase {N}): {role}. Result: {outcome}."
```

### Deferred Items (Non-Blocking)

```
// H-items, AD markers, MED/LOW discoveries → proceed automatically + log
for each non_critical_item in phase_results:
  append to `.mpl/mpl/phases/phase-N/deferred-items.md`:
    - Type: {H-item|AD|Discovery}
    - Summary: {description}
    - PP Impact: {None|PP-N (low risk)}
    - Action: Deferred to finalize review

Report: "[MPL] Phase {N}: {count} items deferred (non-critical). Continuing."
```

### 4.3.6: Session Context Persistence (F-12)

After each phase completes, persist critical state to survive context compression:

```
<remember priority>
[MPL Session State]
- Pipeline: {pipeline_id}
- Phase: {completed_phase}/{total_phases} complete
- PP-proximity: {current_phase.pp_proximity}
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


> **Step 4.3.7 (Orchestrator Context Cleanup) has been moved to `mpl-run-execute-parallel.md`.**

### 4.8: Budget Check & Graceful Pause (F-33, v3.9)

After each phase completes (4.3.7), before proceeding to the next phase, check remaining context budget:

```
budget = predictBudget(cwd)
// predictBudget reads .mpl/context-usage.json (from HUD) + phases.jsonl (historical avg)

if budget.recommendation == "continue":
  // Sufficient budget → proceed to next phase
  continue

if budget.recommendation == "pause_after_current":
  announce: "[MPL] Budget warning: {budget.remaining_pct}% context remaining, est. {budget.estimated_needed_pct}% needed for {budget.remaining_phases} phases."
  announce: "[MPL] Will check again after next phase."
  // Don't pause yet — check again at next phase boundary
  continue

if budget.recommendation == "pause_now":
  announce: "[MPL] Budget critical: {budget.remaining_pct}% remaining. Pausing pipeline."

  // 1. Save pause state
  writeState(cwd, {
    session_status: "paused_budget",
    pause_reason: "context_budget_exhausted",
    resume_from_phase: next_phase_id,
    pause_timestamp: new Date().toISOString(),
    budget_at_pause: {
      context_pct: budget.remaining_pct,
      estimated_needed_pct: budget.estimated_needed_pct,
      remaining_phases: budget.remaining_phases
    }
  })

  // 2. Write handoff signal for external watcher
  writeSessionHandoff(cwd, {
    phaseId: next_phase_id,
    completedPhases: completed_phase_ids,
    remainingPhases: remaining_phase_ids,
    budget: budget
  })

  // 3. Update RUNBOOK
  append to RUNBOOK.md: "## Budget Pause\nPaused at {timestamp}. Resume from {next_phase_id}."

  announce: "[MPL] Session handoff written to .mpl/signals/session-handoff.json"
  announce: "[MPL] Resume options: (1) run mpl-session-watcher.sh (2) /mpl:mpl-resume (3) new session with 'mpl'"
  return  // Stop pipeline execution
```

**Note**: `predictBudget()` requires `.mpl/context-usage.json` to be fresh (<30s). This file is written by the HUD statusline on each render cycle. If HUD is not active, predictBudget returns fail-open (recommendation: "continue").


> **Steps 4.5 (Gate System) through 4.7 (Partial Rollback) and Step 4.8 Graceful Pause Protocol have been moved to `mpl-run-execute-gates.md`.**
> This includes: Hard 1-3 Gates, Advisory Gate, Fix Loop with Convergence Detection, Reflexion, Partial Rollback, and Graceful Pause.
>
> Load `mpl-run-execute-gates.md` when entering Step 4.5 or when any gate fails.

---
