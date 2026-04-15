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
session_status: "cancelled"
+ cancellation snapshot fields above
```

**Do not touch any other file** (see Safety Rules below). If a later session re-inits
the pipeline via the `mpl` keyword, `cleanPipelineScope` archives the entire
`.mpl/mpl/` subtree to `.mpl/archive/{pipeline_id}/mpl/` before cleanup (v0.14.1 #37),
so artifacts remain recoverable even if the user loses track.

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

1. Archive `.mpl/state.json` to `.mpl/archive/{pipeline_id}/` (do not delete outright)
2. Reset `.mpl/state.json` to empty / removed state so the next `mpl` keyword starts fresh
3. Keep every `.mpl/mpl/**` artifact in place (decomposition.yaml, RUNBOOK.md, phase-decisions.md, phase0/, phases/, chains/, profile/, etc.)
4. Keep `docs/learnings/`, `.mpl/memory/`, `.mpl/cache/` (knowledge preservation)
5. Report: "MPL state cleared. All sprint artifacts preserved under .mpl/mpl/ and archived state at .mpl/archive/{pipeline_id}/. Start fresh with 'mpl' keyword."

## Safety Rules (v0.14.1 #37)

Cancel is a **preservation** operation, not a destruction. Every failure mode should
leave artifacts recoverable from disk or git.

- **NEVER** delete, move, or overwrite ANY file under `.mpl/mpl/**` in any cancel mode.
  That includes `decomposition.yaml`, `RUNBOOK.md`, `phase-decisions.md`, `phase0/`,
  `phases/`, `checkpoints/`, `chains/`, `profile/`. Normal cancel must only update
  `.mpl/state.json`; `--force` archives state.json but still preserves `.mpl/mpl/`.
- **NEVER** delete `docs/learnings/`, `.mpl/memory/`, `.mpl/cache/`, `.mpl/pivot-points.md`,
  or `.mpl/discoveries.md`. These live beyond pipeline scope.
- **NEVER** touch `.mpl/contracts/*.json` — they are referenced by git-tracked code.
- **ALWAYS** record cancellation reason, `cancelled_at` timestamp, and `resume_point`.
- **ALWAYS** show resume instructions (`/mpl:mpl-resume`) in the confirmation report.
- **Regression guard**: If a future change adds a delete/mv call to this skill, it MUST
  come with an integration test asserting `before_files == after_files` for `.mpl/mpl/**`
  across a simulated cancel (issue #37 recommendation C).
