---
description: MPL Execute Protocol - Context Assembly, Memory Loading, Checkpoint Recovery
---

# MPL Execution: Context Assembly (Step 4.1)

This file contains the detailed Context Assembly protocol for MPL Phase Execution.
Load this when entering Step 4.1 during phase execution.

See also: `mpl-run-execute.md` (core loop), `mpl-run-execute-gates.md` (5-Gate system), `mpl-run-execute-parallel.md` (parallel dispatch).

---

### 4.1: Context Assembly

```
context = {
  phase0_artifacts: load_phase0_artifacts(),        // Phase 0 Enhanced outputs
  pivot_points:     Read(".mpl/pivot-points.md"),
  phase_decisions:  build_tiered_pd(current_phase), // 2-Tier PD
  phase_definition: phases[current_index],
  phase_seed:       load_phase_seed(current_phase),   // D-01: JIT seed (null if not generated)
  impact_files:     load_impact_files(phase.impact),
  maturity_mode:    config.maturity_mode,
  prev_summary:       Read previous phase's state-summary.md (if available),
  prev_verification:  Read previous phase's verification.md (if available),    // v0.7.0: failure context
  prev_changes_diff:  load_prev_phase_diff(prev_phase),                        // v0.7.0: code diff (N-1 only)
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

#### Dependency-Based Summary Loading (P-01 L0/L1/L2 Tiering, v0.8.8)

State summaries are loaded at 3 resolution levels to reduce token consumption (~50-60% savings):

| Tier | Content | ~Tokens | Load condition |
|------|---------|---------|----------------|
| L0 | 1-line: "Phase N: {name} — {what was done and result}" | ~20 | All completed phases not covered by L1/L2 |
| L1 | L0 + created/modified file list + interface changes summary | ~200 | Phases with impact_files intersection with current phase |
| L2 | Full state-summary.md (all sections) | ~800 | Direct dependency phases (interface_contract.requires) |

```
load_dependency_summaries(current_phase):
  all_completed_phases = list all phases with state-summary.md
  direct_deps = Set(current_phase.interface_contract.requires[].from_phase || [])
  current_impact = Set(current_phase.impact.create + current_phase.impact.modify)

  summaries = { L0: [], L1: {}, L2: {} }

  for each phase in all_completed_phases:
    if phase.id == previous_phase:
      continue  // already loaded via prev_summary (L2 equivalent)

    summary_path = ".mpl/mpl/phases/{phase.id}/state-summary.md"
    if not exists(summary_path):
      continue

    if phase.id in direct_deps:
      // L2: full detail for direct dependencies
      summaries.L2[phase.id] = Read(summary_path)

    elif intersection(phase.impact_files, current_impact) is not empty:
      // L1: file list + interface changes for overlapping phases
      full = Read(summary_path)
      summaries.L1[phase.id] = extract_L1(full)
      // extract_L1: keep "## What was implemented" + "## Files Changed" + "## Interface Changes"
      // drop "## Phase Decisions rationale", "## Verification results detail"

    else:
      // L0: 1-line compressed summary
      full = Read(summary_path)
      first_line = full.split("\n").find(l => l.trim() && !l.startsWith("#"))
      summaries.L0.push("- Phase {phase.id}: {phase.name} — {first_line.slice(0, 120)}")

  return summaries
```

**Phase Runner state-summary.md output format** (updated for L0/L1/L2 extraction):

Phase Runner MUST structure state-summary.md with these sections in order:
```markdown
## Summary
{1-line summary: what was done and the result — this line becomes L0}

## Files Changed
- Created: {file1}, {file2}
- Modified: {file3}, {file4}

## Interface Changes
{new exports, changed function signatures, API contract changes — this becomes part of L1}

## Phase Decisions
{PD rationale and context — L2 only}

## Verification Results
{pass/fail details — L2 only}
```

This structure enables mechanical L0/L1 extraction without LLM re-summarization.

#### PD 2-Tier Classification

Orchestrator classifies all PDs before each phase:

```
build_tiered_pd(current_phase):
  all_pd = read(".mpl/mpl/phase-decisions.md")

  for each pd in all_pd:
    if pd.affected_files INTERSECT current_phase.impact.{create,modify} != EMPTY:
      -> Tier 1 (Active): full detail included
    elif pd.from_phase in current_phase.interface_contract.requires[].from_phase:
      -> Tier 1 (Active): full detail included
    else:
      -> Tier 2 (Summary): 1-line summary

  Token budget: Tier 1 ~400-800, Tier 2 ~90-240 tokens. Total ~2K-5K for 10-phase project.
```

#### Previous Phase Supplementary Context (v0.7.0)

Load N-1 phase's verification results and code diff to improve cross-phase consistency:

```
load_prev_phase_diff(prev_phase):
  diff_path = ".mpl/mpl/phases/{prev_phase}/changes.diff"
  if exists(diff_path):
    diff = Read(diff_path)
    if token_count(diff) > 3000:  // cap at 3K tokens
      return truncate_to_tokens(diff, 3000) + "\n... (truncated)"
    return diff
  return null  // first phase or no diff recorded
```

- `prev_verification`: Read `.mpl/mpl/phases/{prev_phase}/verification.md` (pass_rate, failure details)
- `prev_changes_diff`: Generated by `load_prev_phase_diff` above
- Both are null for the first phase
- Only N-1 phase is loaded; N-2 and earlier rely on State Summary only

#### Impact Files Loading

For each file in `phase.impact.{create, modify, affected_tests, affected_config}`:
- If exists -> `Read(file)`, cap at 2000 lines per file
- If not exists -> note as "new file to create"
- Total budget: ~15000 tokens

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

