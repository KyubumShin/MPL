---
description: "Resume cancelled or interrupted MPL pipeline from last checkpoint. Use this skill when the user wants to continue a previously stopped or interrupted MPL pipeline. Triggers on: '이어서', '재개', '다시 시작', 'resume', 'continue pipeline', 'mpl 이어서 해줘', '아까 하던 거 계속', or any request to pick up where a cancelled/paused pipeline left off."
---

# MPL Resume

Resume a previously cancelled or interrupted MPL pipeline from the last checkpoint.

## Protocol

### Step 1: Validate State

Read `.mpl/state.json`:
- If no state file → "No MPL pipeline to resume. Start with 'mpl' keyword."
- If current_phase = "completed" → "Pipeline already completed. Start new with 'mpl'."
- If current_phase is active (phase1-5) AND no drift detected → "Pipeline is already active. Use /mpl:mpl-status to check progress."

Expected states for resume:
- `current_phase = "cancelled"` with `resume_point` field (manual cancel)
- `session_status = "paused_budget"` (automatic context rotation via F-33)
- `session_status = "paused_checkpoint"` (orchestrator verbal self-pause, v0.14.1 #35)
- **Drift recovery** (v0.14.1 #35): `current_phase` still active but disk artifacts show completed phases beyond `sprint_status.completed_todos`

For `paused_budget` or `paused_checkpoint` state:
- The pipeline was NOT cancelled — it was paused (budget limit OR orchestrator self-pause)
- `current_phase` still reflects the active phase at pause time
- Resume from `resume_from_phase` (set at pause time) or `current_phase` if unset
- Clear `session_status`, `pause_reason`, `pause_timestamp`, `budget_at_pause` on resume

**Drift Detection (v0.14.1, #35)**:

```
disk_phases = Glob(".mpl/mpl/phases/phase-*/state-summary.md")
disk_max_n = max(extract_phase_number(p) for p in disk_phases) if disk_phases else 0
state_completed = state.sprint_status.completed_todos or 0

if state.current_phase in ACTIVE_PHASES and state.session_status in (null, "active"):
  if disk_max_n > state_completed:
    # Drift detected: orchestrator emitted a verbal pause without writing state
    announce: "[MPL] Drift detected: disk shows {disk_max_n} phases, state has {state_completed}."
    announce: "[MPL] Resyncing state before resume (v0.14.1 #35 backwards-compat)."
    writeState(cwd, {
      session_status: "paused_checkpoint",
      pause_reason: "drift_recovery",
      resume_from_phase: "phase-{disk_max_n + 1}",
      pause_timestamp: new Date().toISOString(),
      sprint_status: { ...state.sprint_status, completed_todos: disk_max_n }
    })
    # Fall through to normal paused_checkpoint resume
  else:
    reject: "Pipeline is already active. Use /mpl:mpl-status to check progress."
```

### Step 2: Restore Context

Read these files to rebuild context:

```
1. .mpl/state.json                    → pipeline state, progress snapshot
2. .mpl/mpl/decomposition.yaml       → phase definitions and success criteria
3. .mpl/mpl/phase0/summary.md        → Phase 0 analysis summary (if exists)
4. .mpl/mpl/phase-decisions.md       → accumulated phase decisions
5. .mpl/research/report.md           → research report (if exists)
6. .mpl/research/stage*-cache.md     → intermediate research stage caches (if exists)
7. docs/learnings/{feat}/            → any learnings from previous run
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
- If decomposition.yaml exists → Skip agent exploration, go directly to HITL
- If no decomposition.yaml → Full Phase 1-B restart with research context

#### Resume Phase 1 (Quick Plan — legacy)

- If decomposition.yaml exists → Skip agent exploration, go directly to HITL
- If no decomposition.yaml → Full Phase 1 restart (explore + analyze + plan)

#### Resume Phase 2 (MVP Sprint)

- Re-parse decomposition.yaml for incomplete phases
- Skip completed phases (check state.json phases_completed)
- Dispatch workers only for remaining TODOs
- Continue dependency-aware parallel execution

#### Resume Phase 3 (Quality Gate)

- Check which gates were already evaluated
- Re-run only failed or unevaluated gates
- If hard1_passed=true, skip to Hard 2
- If hard2_passed=true, skip to Hard 3
- If hard3_passed=true, skip to Advisory

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
| decomposition.yaml was manually edited | Accept edits, use current decomposition.yaml as is |
| Source files changed since cancel | Workers will work with current codebase state |
| State file corrupted | Report error, suggest /mpl:mpl-cancel --force |
| Multiple cancellations | Use most recent cancellation snapshot |
| Fix loop count near limit | Warn user, offer to reset fix_loop_count |

## Safety Rules

- NEVER skip the resume summary (user must see what's being resumed)
- NEVER reset progress (completed phases stay completed)
- Carry forward ALL convergence data (pass_rate_history is critical)
- Re-read decomposition.yaml fresh (may have been manually updated)
