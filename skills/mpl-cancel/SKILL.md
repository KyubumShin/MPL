---
description: "Cancel active MPL pipeline with clean state preservation for safe resume. Use this skill when the user wants to stop, cancel, or abort a running MPL pipeline. Triggers on: '중단', '멈춰', '취소', '그만', 'cancel', 'stop mpl', 'abort pipeline', or any request to halt the current MPL execution."
---

# MPL Cancel

Safely stop the active MPL pipeline with state preservation.

## Protocol

### Step 1: Check MPL State

Read `.mpl/state.json`:
- If no state file → report "No active MPL pipeline" and stop
- If state.current_phase = "completed" → report "Pipeline already completed" and stop
- If state.current_phase = "cancelled" → report "Pipeline already cancelled" and stop

### Step 2: Record Cancellation

Before modifying state, capture current progress snapshot:

```json
{
  "cancelled_at": "{ISO timestamp}",
  "cancelled_phase": "{current_phase}",
  "cancelled_reason": "{user reason or 'user requested'}",
  "resume_point": "{phase to resume from}",
  "progress_snapshot": {
    "todos_completed": N,
    "todos_total": N,
    "gate_results": { ... },
    "fix_loop_count": N,
    "pass_rate_history": [ ... ]
  }
}
```

### Step 3: Determine Resume Point

| Cancelled During | Resume Point | Rationale |
|-----------------|-------------|-----------|
| phase1a-research (stage1 incomplete) | phase1a-research | Restart Stage 1 (no cache) |
| phase1a-research (stage1 done) | phase1a-research | Resume from Stage 2 (stage1-cache exists) |
| phase1a-research (stage2 done) | phase1a-research | Resume from Stage 3 (stage1+2 cache exists) |
| phase1b-plan (no decomposition.yaml) | phase1b-plan | Restart plan generation with research |
| phase1b-plan (decomposition.yaml exists) | phase1b-plan | Re-run HITL for approval |
| phase1-plan (no decomposition.yaml) | phase1-plan | Restart planning (legacy) |
| phase1-plan (decomposition.yaml exists) | phase1-plan | Re-run HITL for approval |
| phase2-sprint | phase2-sprint | Continue remaining TODOs |
| phase3-gate | phase3-gate | Re-run gates |
| phase4-fix | phase3-gate | Re-evaluate after fixes applied |
| phase5-finalize | phase5-finalize | Finish finalization |

### Step 4: Update State

Write to `.mpl/state.json`:
```
current_phase: "cancelled"
+ cancellation snapshot fields above
```

### Step 5: Confirm to User

Output structured cancellation report:

```
MPL Pipeline Cancelled
━━━━━━━━━━━━━━━━━━━━
Pipeline:    {pipeline_id}
Phase:       {cancelled_phase}
Resume from: {resume_point}

Progress preserved:
  TODOs: {completed}/{total} completed
  Gates: {gate summary}
  Fix loops: {count}/{max}

To resume: /mpl:mpl-resume
To start fresh: /mpl:mpl-cancel --force
```

## Force Mode

When invoked with `--force` argument:

1. Delete `.mpl/state.json`
2. Keep `.mpl/mpl/decomposition.yaml` (useful reference)
3. Keep `docs/learnings/` (knowledge preservation)
4. Report: "MPL state cleared. decomposition.yaml preserved. Start fresh with 'mpl' keyword."

## Safety Rules

- NEVER delete `.mpl/mpl/decomposition.yaml` in normal cancel (only --force deletes state, never plan)
- NEVER delete `docs/learnings/` (knowledge is always preserved)
- ALWAYS record cancellation reason and timestamp
- ALWAYS show resume instructions
