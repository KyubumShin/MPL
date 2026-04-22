---
description: "Resume cancelled or interrupted MPL pipeline from last checkpoint. Use this skill when the user wants to continue a previously stopped or interrupted MPL pipeline. Triggers on: '이어서', '재개', '다시 시작', 'resume', 'continue pipeline', 'mpl 이어서 해줘', '아까 하던 거 계속', or any request to pick up where a cancelled/paused pipeline left off."
---

# MPL Resume

Resume a previously cancelled or interrupted MPL pipeline from the last checkpoint.

> **Per-phase resume rules** live in `commands/mpl-run-finalize-resume.md` (Per-Phase Resume Rules section). Load that file for the phase-specific continuation logic — this skill handles only the activation-time concerns (state validation, drift detection, resume summary).

## Step 1: Validate State

Read `.mpl/state.json`:
- No state file → "No MPL pipeline to resume. Start with 'mpl' keyword."
- `current_phase = "completed"` → "Pipeline already completed. Start new with 'mpl'."
- Active phase AND no drift → "Pipeline is already active. Use /mpl:mpl-status."

Expected resumable states:
- `current_phase = "cancelled"` with `resume_point` (manual cancel)
- `session_status = "paused_budget"` (F-33 context rotation)
- `session_status = "paused_checkpoint"` (orchestrator self-pause, v0.14.1 #35)
- **Drift**: `current_phase` active but disk artifacts show completed phases beyond `sprint_status.completed_todos`

For `paused_budget` / `paused_checkpoint`: the pipeline was paused, not cancelled. Resume from `resume_from_phase` (or `current_phase` if unset) and clear `session_status`, `pause_reason`, `pause_timestamp`, `budget_at_pause`.

## Step 2: Drift Detection (v0.14.1, #35)

```
disk_phases = Glob(".mpl/mpl/phases/phase-*/state-summary.md")
disk_max_n = max(phase_number(p) for p in disk_phases) if disk_phases else 0
state_completed = state.sprint_status.completed_todos or 0

if state.current_phase ∈ ACTIVE_PHASES and state.session_status ∈ (null, "active"):
  if disk_max_n > state_completed:
    # Orchestrator emitted verbal pause without writing state — resync
    announce: "[MPL] Drift detected: disk shows {disk_max_n} phases, state has {state_completed}. Resyncing."
    writeState(cwd, {
      session_status: "paused_checkpoint",
      pause_reason: "drift_recovery",
      resume_from_phase: "phase-{disk_max_n + 1}",
      pause_timestamp: new Date().toISOString(),
      sprint_status: { ...state.sprint_status, completed_todos: disk_max_n }
    })
    # Fall through to paused_checkpoint resume
  else:
    reject: "Pipeline already active. Use /mpl:mpl-status."
```

## Step 3: Restore Context

Read in order:
1. `.mpl/state.json` — pipeline state + progress snapshot
2. `.mpl/mpl/decomposition.yaml` — phase definitions + success criteria (fresh read — user may have edited)
3. `.mpl/mpl/phase0/raw-scan.md` (+ baseline.yaml if exists)
4. `.mpl/mpl/phase-decisions.md` — accumulated PDs
5. `.mpl/research/*` — report.md, stage*-cache.md (if phase1a applies)
6. `docs/learnings/{feat}/` — prior-run learnings

## Step 4: Display Resume Summary

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

## Step 5: Apply Per-Phase Resume

Load `commands/mpl-run-finalize-resume.md` and follow the Per-Phase Resume Rules section for the specific phase:
- `phase1a-research` → stage-aware (check caches before re-running)
- `phase1b-plan` / `mpl-decompose` → skip to HITL if decomposition.yaml exists
- `phase2-sprint` → continue from first incomplete phase
- `phase3-gate` → skip PASS gates, re-run failed/unevaluated
- `phase4-fix` → back to phase3-gate with `pass_rate_history` preserved
- `phase5-finalize` → continue from first incomplete finalize step

Then update state:
```json
{ "current_phase": "{resume_point}", "resumed_at": "{ISO}", "resumed_from": "cancelled" }
```

## Edge Cases

| Scenario | Action |
|---|---|
| decomposition.yaml manually edited | Accept as-is (fresh read) |
| Source files changed since cancel | Workers operate on current codebase |
| State file corrupted | Report + suggest `/mpl:mpl-cancel --force` |
| Multiple cancellations | Use most recent snapshot |
| Fix loop count near limit | Warn user, offer reset |

## Safety Rules

- NEVER skip the resume summary — the user must see what's being resumed.
- NEVER reset progress — completed phases stay completed.
- Carry forward ALL convergence data (`pass_rate_history`, `fix_loop_count`). ConvergenceDetector trend analysis depends on it.
- Re-read `decomposition.yaml` fresh — manual edits between runs must be respected.
