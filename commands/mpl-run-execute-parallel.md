---
description: MPL Execute Protocol - TODO Parallel Dispatch, Background Execution, Worktree Isolation
---

# MPL Execution: Parallel Dispatch & Context Cleanup (Steps 4.2.3-4.2.4, 4.3.7)

This file contains the Task-based TODO protocol, Background Execution for independent TODOs,
and Orchestrator Context Cleanup.
Load this when parallel TODOs are detected during phase execution.

Phase-level parallelism is scheduled only by `commands/mpl-run-execute.md`
Step 4.0 from top-level `execution_tiers`. This file does not consume
`execution_tiers` or phase-level `resource_locks`; it is limited to TODO
parallelism inside a single phase.

See also: `mpl-run-execute.md` (core loop), `mpl-run-execute-context.md` (context assembly), `mpl-run-execute-gates.md` (3 Hard Gate system).

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

### 4.2.4: Slot Streaming for Independent TODOs (F-13, v0.18.6)

When Phase Runner identifies independent TODOs, implement them with a streaming
slot scheduler. Do not batch-then-wait. As soon as one active worker completes,
fill the freed slot with the next ready TODO.

```
// Ready queue eligibility (v0.18.6):
for each pending TODO:
  ready = all todo.depends_on ids are completed
  no_file_conflict = todo.files_to_modify does not overlap any active worker
  no_resource_conflict = todo.resource_locks does not overlap any active worker
  if ready && no_file_conflict && no_resource_conflict:
    -> eligible for streaming dispatch

// Streaming dispatch with HARD LIMIT (F-36):
MAX_CONCURRENT_TODOS = 3  // Hard limit for UI stability

active = new Map()
pending = todos in dependency order
completed = new Set()
failed = new Set()

while pending.length > 0 || active.size > 0:
  while active.size < MAX_CONCURRENT_TODOS:
    todo = next_ready_todo(pending, completed, active,
      conflict_keys: ["files_to_modify", "resource_locks"])
    if no todo:
      break
    worker_model = (todo.retry_count >= 3 || todo.tags.includes("architecture")) ? "opus" : "sonnet"
    handle = Task(subagent_type="mpl-phase-runner", model=worker_model,
                  prompt="...", run_in_background=true)
    active.set(handle.id, { todo, handle })
    pending.remove(todo)
    TaskUpdate(id=todo.task_id, status="in_progress")

  if active.size == 0:
    // Deadlock: remaining TODOs depend on failed/missing predecessors.
    fail remaining pending TODOs with ready_blocked reason
    break

  result = wait_any_completion(active)
  active.delete(result.handle_id)
  if result.status == "completed":
    completed.add(result.todo.id)
    TaskUpdate(id=result.todo.task_id, status="completed")
  else:
    failed.add(result.todo.id)
    TaskUpdate(id=result.todo.task_id, status="failed")
    // Dependent TODOs remain pending but not ready; fix cycle consumes failed graph.
```

Constraints:
- **HARD LIMIT: max 3 concurrent background workers** — excess queued for later
  (Claude Code UI stability restriction. Not adjustable via config)
- Slot streaming: one completion immediately opens a slot for the next ready TODO
- File conflict detection uses `files_to_modify`; resource conflict detection uses `resource_locks`
- If any parallel worker fails, remaining workers continue
- Failed worker results feed into fix cycle (existing behavior)
- Phase Runner must join all active TODO workers before phase verification/final summary
- Seed TODOs MUST include `depends_on`, `files_to_modify`, and `resource_locks`.
  Missing fields invalidate the seed via `mpl-validate-seed.mjs`.


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
