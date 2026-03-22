---
description: MPL Execution Protocol - Phase Execution Loop, Context Assembly, 5-Gate Quality, Fix Loop
---

# MPL Execution: Step 4 (Phase Execution Loop)

This file contains Step 4 of the MPL orchestration protocol — the core execution engine.
Load this when `current_phase` is `mpl-phase-running`.

---

## Step 4: Phase Execution Loop (CORE)

### 4.0: Execution Tier Dispatch (D-01, v0.6.0)

If `execution_tiers` exists in decomposition.yaml AND pipeline_tier == "frontier":

```
for each tier in execution_tiers:
  if tier.parallel AND tier.phases.length > 1:
    // Phase-level parallel execution (EXTENSION/SUPPORT only, never CORE)
    announce: "[MPL] Tier {tier.tier}: executing {tier.phases.length} phases in parallel"

    results = parallel_map(tier.phases, fn(phase_id):
      // 4.0.5: Generate Seed (JIT)
      seed = generate_phase_seed(phase_id, all_prior_summaries)
      // 4.1: Context Assembly (with seed)
      context = assemble_context(phase_id, seed)
      // 4.2: Phase Runner (worktree isolated for parallel phases)
      return execute_phase(context, isolation: "worktree")
    , max_concurrent: 3)

    // Merge worktree results sequentially
    for each result in results:
      merge_worktree(result)
      save_state_summary(result)

    // Cumulative test run for entire tier
    run_cumulative_tests(tier.phases)
  else:
    // Sequential execution (CORE phases or single-phase tier)
    for each phase_id in tier.phases:
      // Normal flow: 4.0.5 → 4.1 → 4.2 → 4.3 → 4.8
```

If `execution_tiers` NOT in decomposition.yaml (legacy 0.5.x):
  Fall back to sequential "For each phase in order:" loop below.

---

For each phase in order:

### 4.0.5: Phase Seed Generation (D-01, v0.6.0)

Generate Phase Seed just-in-time, immediately before context assembly:

```
if config.phase_seed?.enabled != false AND pipeline_tier == "frontier":
  prior_summaries = all completed phase state-summary.md files
  phase0_relevant = extract_relevant_phase0(phase_definition, phase0_artifacts)

  seed_result = Task(subagent_type="mpl-phase-seed-generator", model="sonnet",
    prompt="Generate Phase Seed for {phase.id}.
    Phase definition: {phase_definition}
    Pivot Points: {pivot_points}
    Phase 0 context (relevant sections): {phase0_relevant}
    Prior State Summaries: {prior_summaries}
    Verification Plan: {verification_plan}
    Codebase hints: {impact_file_paths}
    Generate phase-seed.yaml output.")

  save seed_result to .mpl/mpl/phases/{phase.id}/phase-seed.yaml
  context.phase_seed = seed_result
  announce: "[MPL] Phase Seed generated for {phase.id}: {seed.mini_plan_seed.todo_structure.length} TODOs"
else:
  context.phase_seed = null  // Legacy mode — Phase Runner generates mini-plan
```

### 4.1: Context Assembly

```
context = {
  phase0_artifacts: load_phase0_artifacts(),        // Phase 0 Enhanced outputs
  pivot_points:     Read(".mpl/pivot-points.md"),
  phase_decisions:  build_tiered_pd(current_phase), // 3-Tier PD
  phase_definition: phases[current_index],
  phase_seed:       load_phase_seed(current_phase),   // D-01: JIT seed (null if not generated)
  impact_files:     load_impact_files(phase.impact),
  maturity_mode:    config.maturity_mode,
  prev_summary:     Read previous phase's state-summary.md (if available),
  dep_summaries:    load_dependency_summaries(current_phase),  // All phases referenced in interface_contract.requires
  verification_plan:  load_phase_verification_plan(current_phase),  // A/S/H items for this phase
  learnings:        load_learnings(),               // F-11: Past run learnings (optional)
  error_files:      load_error_files(current_phase) // F-30: Error files from previous attempts (optional)
}
```

#### Run-to-Run Learnings Loading (F-11) — Legacy

> **Note**: F-25 4-Tier Adaptive Memory replaces this single learnings load.
> Use 4-Tier loading if semantic.md exists; use the legacy logic below if only learnings.md exists and semantic.md does not.

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

#### Layer 8: 4-Tier Adaptive Memory (F-25)

Extends the existing single learnings.md load to 4-Tier selective loading.

```
load_adaptive_memory(task_description):
  1. **semantic.md** (always load): project knowledge — generalized rules, conventions
     - Full load, max 500 tokens
     - Skip on first run (file absent)

  2. **procedural.jsonl** (relevant entries only): tool usage patterns
     - Extract keywords from task_description → match tags
     - Load matching entries only, max 500 tokens (most recent 10)
     - Tags: type_mismatch, dependency_conflict, test_flake, api_contract_violation

  3. **episodic.md** (recent only): previous Phase execution summaries
     - Recent 2 Phases detailed + previous ones compressed to 1 line each
     - Max 800 tokens
     - First Phase run: empty (episodic is empty)

  4. **working.md** (current Phase only): current Phase TODO state
     - Phase Runner updates autonomously
     - Context assembly initializes at Phase start

  Total memory budget: max 2000 tokens (semantic 500 + procedural 500 + episodic 800 + working 200)

  Existing learnings.md is replaced by semantic.md + procedural.jsonl,
  but for backward compatibility, if learnings.md exists and semantic.md does not, learnings.md is loaded.
```

Memory file paths:
```
.mpl/memory/
├── semantic.md         # project knowledge (generalized rules)
├── procedural.jsonl    # tool usage patterns (tag-based search)
├── episodic.md         # Phase execution history (chronological)
├── working.md          # current Phase work state (volatile)
└── learnings.md        # legacy compatibility (F-11)
```

The `learnings` field in context assembly is determined by the following logic:
```
if exists(".mpl/memory/semantic.md"):
  // F-25 active: 4-Tier loading
  context.adaptive_memory = load_adaptive_memory(phase.description)
  context.learnings = null  // legacy disabled
else if exists(".mpl/memory/learnings.md"):
  // legacy fallback
  context.adaptive_memory = null
  context.learnings = load_learnings()
else:
  // first run
  context.adaptive_memory = null
  context.learnings = null
```

#### Error File Loading (F-30)

```
load_error_files(current_phase):
  errors_dir = ".mpl/mpl/phases/{current_phase.id}/errors/"
  if exists(errors_dir):
    files = list(errors_dir)  // todo-{n}-error.md, gate-{n}-error.md
    if files is not empty:
      return { path: errors_dir, files: files, contents: Read each file }
  return null  // No prior errors — first attempt or clean run
```

If error files exist for the current phase, include them in the Phase Runner context so the runner has full error history without relying on compacted conversation memory.

> **QMD Integration**: When entering the fix loop, if error files exist, pass their path to QMD for precise diagnosis. Example: `Task(subagent_type="mpl-scout", prompt="Diagnose error at {errors_dir}...")`.

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

#### Context Assembly Branching (F-32: Adaptive Loading)

Adjust context load amount depending on situation before calling Phase Runner:

**Case 1: Same session, no compaction** (compaction_count == last_phase_compaction_count)
- Load only prev_summary (previous analysis remains in context)
- Skip dependency_summaries, phase0_artifacts
- Skip memory reload (already in context)
- Minimum token usage

**Case 2: After compaction** (compaction_count > last_phase_compaction_count)
- Load prev_summary + dependency_summaries
- **Load compaction checkpoint (F-31, v3.8)**:
  ```
  checkpoint_dir = ".mpl/mpl/checkpoints/"
  checkpoints = Glob("compaction-*.md", checkpoint_dir)
  if checkpoints not empty:
    latest = max(checkpoints by compaction number N)
    context.checkpoint_recovery = Read(latest)
    announce: "[MPL] Recovered from compaction checkpoint: {latest}"
  else:
    context.checkpoint_recovery = null
  ```
- Load error files if they exist (F-30)
- Load phase0_artifacts only when Complex grade
- **F-25 memory reload**: semantic.md + recent procedural (tag matching) + episodic summary (recent 2 Phases)

**Post-Compaction Budget Check (F-33)**:
Re-read context-usage.json after compaction to check budget:
```python
if compaction_since_last_phase:
    budget = predictBudget(cwd)
    if budget.recommendation == "pause_now":
        execute_graceful_pause(budget, current_phase_id, completed, remaining)
        return
    # "pause_after_current" — since a Phase is in progress, judge after current Phase completes
```

**Case 3: Resume in new session** (session_id changed)
- Perform full context assembly
- prev_summary + dependency_summaries + phase0_artifacts + learnings
- RUNBOOK.md tail + error files + checkpoint
- **F-25 full memory load**: full semantic.md + full procedural (most recent 10) + full episodic + working.md

After context assembly completes, update state:
```
state.last_phase_compaction_count = state.compaction_count
```

### 4.1.5: Worktree Isolation Determination (F-15)

Phases determined as risk=HIGH in Pre-Execution Analysis (Step 1-B) are executed in isolation within a worktree.

> **Applies when**: Worktree isolation is **activated only in Frontier tier**. Frugal/Standard tier skips this step because the single Phase overhead exceeds the benefit.

#### Determination Criteria

Reference risk_level from the current Phase info in state.json:
- `risk_level == "HIGH"` → worktree isolated execution
- `risk_level != "HIGH"` → normal execution (existing behavior, proceed to Step 4.2)

#### Isolated Execution Protocol

1. **Create Worktree**:
   ```
   branch_name = "mpl-isolated-{phase_id}-{timestamp}"
   git worktree add /tmp/mpl-worktree-{phase_id} -b {branch_name}
   ```

2. **Dispatch Phase Runner**:
   - Add `isolation: "worktree"` parameter to Task tool
   - Phase Runner executes from worktree path
   - Read `.mpl/` state files from original; code changes are in worktree

3. **Result Judgment**:

   | Result | Response |
   |--------|----------|
   | Phase success (all criteria pass) | Merge worktree → main branch (`git merge --no-ff`) |
   | Phase failure (circuit_break) | Delete worktree, original code unchanged |
   | Partial success (some TODOs complete) | Ask user via AskUserQuestion: merge/discard/manual review |

4. **Cleanup**:
   ```
   git worktree remove /tmp/mpl-worktree-{phase_id}
   git branch -d {branch_name}  # on successful merge
   git branch -D {branch_name}  # on discard
   ```

5. **State Tracking**:
   Record in state.json:
   ```json
   {
     "worktree_history": [{
       "phase_id": "phase-3",
       "branch": "mpl-isolated-phase-3-20260313",
       "path": "/tmp/mpl-worktree-phase-3",
       "risk_level": "HIGH",
       "result": "merged",
       "timestamp": "2026-03-13T14:00:00Z"
     }]
   }
   ```
   `result` values: `"merged"` | `"discarded"` | `"manual_review"`

#### Limitations

- Worktree isolation is active only in Frontier tier (Frugal/Standard: single Phase, worktree overhead > benefit)
- Maintain only 1 worktree at a time (no parallel worktrees)
- Do not copy `.mpl/` directory to worktree (reference original)
- Phase Runner's Read/Grep scope inside worktree is remapped to the worktree path

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
     3. Direct implementation: Implement code changes DIRECTLY using Edit/Write/Bash. Do NOT attempt to spawn mpl-worker subagents — nested agent dispatch is not supported. You are the implementer.
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
     ### Archived (IDs only)
     {tier3_list}

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
{"ts":"...","desc":"...","tier":"frontier","domain_distribution":{"db":2,"api":3,"test":1},"result":"success","tokens":85000}
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

### 4.2.2: Test Agent — Mandatory Independent Verification (F-40)

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

### 4.2.3: Task-based TODO Protocol (F-23)

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

### 4.2.4: Background Execution for Independent TODOs (F-13)

When Phase Runner identifies independent TODOs (no file overlap), dispatch workers in parallel:

```
// File conflict detection (v3.1):
for each pair of pending TODOs:
  files_a = todo_a.impact_files
  files_b = todo_b.impact_files
  if intersection(files_a, files_b) is EMPTY:
    -> mark as independent, eligible for parallel dispatch

// Parallel dispatch with HARD LIMIT (F-36):
MAX_CONCURRENT_WORKERS = 3  // Hard limit for UI stability

independent_todos = todos.filter(independent)
batches = chunk(independent_todos, MAX_CONCURRENT_WORKERS)  // batches of 3

for each batch in batches:
  // Parallel dispatch workers within the batch
  for each todo in batch:
    worker_model = (todo.retry_count >= 3 || todo.tags.includes("architecture")) ? "opus" : "sonnet"
    Task(subagent_type="mpl-worker", model=worker_model,
         prompt="...", run_in_background=true)

  // Wait for all workers in current batch to complete
  // Next batch only starts after current batch completes
  for each background task in batch:
    result = await task completion
    TaskUpdate(id=task_id, status=result.status)

// Sequential fallback (TODOs with file conflicts):
for each TODO with file conflicts:
  worker_model = (todo.retry_count >= 3 || todo.tags.includes("architecture")) ? "opus" : "sonnet"
  Task(subagent_type="mpl-worker", model=worker_model,
       prompt="...", run_in_background=false)
```

Constraints:
- **HARD LIMIT: max 3 concurrent background workers** — excess queued for later
  (Claude Code UI stability restriction. Not adjustable via config)
- Batch execution: 3 complete → next 3 start (concurrent count never exceeds 3)
- File conflict detection uses v3.1's existing overlap logic
- If any parallel worker fails, remaining workers continue
- Failed worker results feed into fix cycle (existing behavior)
- Phase Runner must wait for ALL workers in current batch before starting next batch

### 4.3: Result Processing

**On `"complete"`**:

```
1. Validate state_summary required sections: ["What was implemented", "Phase Decisions", "Verification results"]
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
11. More phases -> current_phase = "mpl-phase-running", continue 4.1
    → **Budget Check (F-33)**: See Step 4.3 extension — check session budget before starting next Phase.
12. All done -> proceed to Step 4.5 (5-Gate Quality)

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

### 4.5: 5-Gate Quality

After all phases complete, apply the 5-Gate Quality system before finalization.

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
