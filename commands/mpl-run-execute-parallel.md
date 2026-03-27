---
description: MPL Execute Protocol - TODO Parallel Dispatch, Background Execution, Worktree Isolation
---

# MPL Execution: Parallel Dispatch & Context Cleanup (Steps 4.2.3-4.2.4, 4.3.7)

This file contains the Task-based TODO protocol, Background Execution for independent TODOs,
and Orchestrator Context Cleanup.
Load this when parallel TODOs are detected during phase execution.

See also: `mpl-run-execute.md` (core loop), `mpl-run-execute-context.md` (context assembly), `mpl-run-execute-gates.md` (5-Gate system).

---

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

When Phase Runner identifies independent TODOs (no file overlap), implement them in parallel batches:

```
// File conflict detection (v3.1):
for each pair of pending TODOs:
  files_a = todo_a.impact_files
  files_b = todo_b.impact_files
  if intersection(files_a, files_b) is EMPTY:
    -> mark as independent, eligible for parallel dispatch

// Parallel dispatch with HARD LIMIT (F-36):
MAX_CONCURRENT_TODOS = 3  // Hard limit for UI stability

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


### 4.3.7: Orchestrator Context Cleanup (Sliding Window)

After each phase completes, apply sliding window retention (window size N from `config.context_cleanup_window`, default 3):

1. Ensure state_summary is saved to `.mpl/mpl/phases/phase-N/state-summary.md` (already done in 4.3)
2. Emit `<remember priority>` tag with critical state (4.3.6 above)
3. Determine window boundary:
   - `current_phase_index` = completed phase number
   - `window_start` = max(0, current_phase_index - context_cleanup_window + 1)
   - Phases within `[window_start, current_phase_index]`: **retain** detailed data (state-summary + verification results)
   - Phases before `window_start`: **release** to summary only
4. For next phase, load:
   - Windowed phase details (last N phases: state-summary + verification results)
   - Dependency summaries (from files, per interface_contract.requires)
   - Updated phase-decisions.md (2-Tier)
   - Current phase definition

Token impact: ~20-30K per retained phase × 3 = ~60-90K (≈7-10% of 900K budget). This enables cross-phase debugging and consistency checks while maintaining bounded context growth.
