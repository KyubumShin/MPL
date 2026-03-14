---
description: Resume cancelled or interrupted MPL pipeline from last checkpoint
---

# MPL Resume

Resume a previously cancelled or interrupted MPL pipeline from the last checkpoint.

## Protocol

### Step 1: Validate State

Read `.mpl/state.json`:
- If no state file → "No MPL pipeline to resume. Start with 'mpl' keyword."
- If current_phase = "completed" → "Pipeline already completed. Start new with 'mpl'."
- If current_phase is active (phase1-5) → "Pipeline is already active. Use /mpl:mpl-status to check progress."

Expected states for resume:
- `current_phase = "cancelled"` with `resume_point` field (manual cancel)
- `session_status = "paused_budget"` (automatic context rotation via F-38)

For `paused_budget` state:
- The pipeline was NOT cancelled — it was paused due to context window limits
- `current_phase` still reflects the active phase at pause time
- Resume from `current_phase` directly (no need for `resume_point` field)
- Clear `session_status` and `pause_reason` on resume

### Step 2: Restore Context

Read these files to rebuild context:

```
1. .mpl/state.json              → pipeline state, progress snapshot
2. .mpl/PLAN.md                 → TODO list and acceptance criteria
3. .mpl/research/report.md      → research report (if exists)
4. .mpl/research/stage*-cache.md → intermediate research stage caches (if exists)
5. docs/learnings/{feat}/       → any learnings from previous run
```

### Step 3: Display Resume Summary

```
MPL Pipeline Resume
━━━━━━━━━━━━━━━━━━
Pipeline:     {pipeline_id}
Cancelled at: {cancelled_at} ({cancelled_phase})
Resuming:     {resume_point}

Previous Progress:
  TODOs: {completed}/{total}
  Gates: G1={result} G2={result} G3={result}
  Fix loops used: {count}/{max}

Resuming from {resume_point}...
```

### Step 4: Phase-Specific Resume Logic

#### Resume Phase 1-A (Deep Research)

Research resume is stage-aware — completed stages are not re-run:

| Cancel Point | Resume Action |
|-------------|---------------|
| Stage 1 in progress (no cache) | Stage 1 full re-run |
| Stage 1 completed (`stage1-cache.md` exists) | Load Stage 1 cache → resume from Stage 2 |
| Stage 2 completed (`stage2-cache.md` exists) | Load Stage 1+2 caches → resume from Stage 3 (Synthesis only) |
| Stage 3 completed (`report.md` exists) | Research done → resume from Phase 1-B |

```
Check .mpl/research/ for:
- stage1-cache.md → stages_completed includes 'stage1'
- stage2-cache.md → stages_completed includes 'stage1', 'stage2'
- report.md → research complete, skip to phase1b-plan

Resume state update:
writeState(cwd, { research: { status: '{next incomplete stage}' } })
```

#### Resume Phase 1-B (Plan Generation)

- If `report.md` exists → use as research input for planning agents
- If PLAN.md exists → Skip agent exploration, go directly to HITL
- If no PLAN.md → Full Phase 1-B restart with research context

#### Resume Phase 1 (Quick Plan — legacy)

- If PLAN.md exists → Skip agent exploration, go directly to HITL
- If no PLAN.md → Full Phase 1 restart (explore + analyze + plan)

#### Resume Phase 2 (MVP Sprint)

- Re-parse PLAN.md for incomplete TODOs (`### [ ]`)
- Skip completed TODOs (`### [x]`)
- Dispatch workers only for remaining TODOs
- Continue dependency-aware parallel execution

#### Resume Phase 3 (Quality Gate)

- Check which gates were already evaluated
- Re-run only failed or unevaluated gates
- If gate1_passed=true, skip to Gate 2
- If gate1 & gate2 passed, skip to Gate 3

#### Resume Phase 4 (Fix Loop)

- Resume from Phase 3 (re-evaluate gates after previous fixes)
- Carry forward fix_loop_count and pass_rate_history
- ConvergenceDetector uses existing history for trend analysis

#### Resume Phase 5 (Finalize)

- Check which finalization steps were completed
- Continue from where it stopped (learnings → memory → commits → report)

### Step 5: Activate Pipeline

Update state:
```json
{
  "current_phase": "{resume_point}",
  "resumed_at": "{ISO timestamp}",
  "resumed_from": "cancelled"
}
```

Then execute the phase protocol from `/mpl:mpl-run` or the embedded protocol in `/mpl:mpl`.

## Edge Cases

| Scenario | Action |
|----------|--------|
| PLAN.md was manually edited | Accept edits, use current PLAN.md as is |
| Source files changed since cancel | Workers will work with current codebase state |
| State file corrupted | Report error, suggest /mpl:mpl-cancel --force |
| Multiple cancellations | Use most recent cancellation snapshot |
| Fix loop count near limit | Warn user, offer to reset fix_loop_count |

## Safety Rules

- NEVER skip the resume summary (user must see what's being resumed)
- NEVER reset progress (completed TODOs stay completed)
- Carry forward ALL convergence data (pass_rate_history is critical)
- Re-read PLAN.md fresh (may have been manually updated)
