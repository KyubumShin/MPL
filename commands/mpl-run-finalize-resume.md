---
description: MPL Finalize Protocol - Resume, Budget Pause, Discovery Processing, Related Skills
---

# MPL Finalize: Resume Protocol, Discovery Processing, Related Skills (Step 6+)

This file contains Step 6 (Resume Protocol), F-33 Budget Pause Resume,
Watcher-based Auto-Resume, Discovery Processing, and Related Skills.
Load this when resuming a session or processing discoveries.

See also: `mpl-run-finalize.md` (main finalization steps).

---

## Step 6: Resume Protocol

MPL naturally supports resume via per-phase state persistence.

```
On session start:
  if .mpl/state.json has run_mode == "mpl":
    mplState = Read .mpl/mpl/state.json
    nextPhase = first phase with status != "completed"

    # F-10: Load RUNBOOK for session continuity
    if exists(".mpl/mpl/RUNBOOK.md"):
      runbook = Read(".mpl/mpl/RUNBOOK.md")
      // RUNBOOK provides: current status, milestones, decisions, issues
      // Use as primary context for understanding pipeline state

    # F-31 (v3.8): Checkpoint-aware resume
    if exists(".mpl/mpl/checkpoints/"):
      checkpoints = list(".mpl/mpl/checkpoints/compaction-*.md")
      if checkpoints not empty:
        latest = max(checkpoints by N)
        announce: "[MPL] Found compaction checkpoint: {latest}. Using for enhanced recovery."
        # Checkpoint supplements standard resume data (RUNBOOK + state-summary)
        # Loaded into context.checkpoint_recovery during Step 4.1 Context Assembly

    if all completed -> Step 5 (Finalize) if not done
    else:
      Report: "[MPL] Resuming: {completed}/{total} done. Next: {nextPhase.name}"
      Load: RUNBOOK.md + phase-decisions.md + last state-summary.md + checkpoint (if exists)
      Continue from Step 4.1 for nextPhase
```

#### F-33: Budget Pause Resume

```python
if state.session_status in ("paused_budget", "paused_checkpoint"):
    pause_kind = "budget" if state.session_status == "paused_budget" else "checkpoint (orchestrator self-pause)"
    print(f"[MPL] Resuming from {pause_kind} pause (paused at {state.pause_timestamp})")
    if state.session_status == "paused_budget":
        print(f"[MPL] Previous session: context {state.budget_at_pause.context_pct}% remaining")

    # Clear pause state
    writeState(cwd, {
        "session_status": "active",
        "pause_reason": None,
        "pause_timestamp": None,
        "budget_at_pause": None
        # resume_from_phase is preserved — used by Step 6's existing logic
    })

    # Clear handoff signal (paused_budget only; paused_checkpoint doesn't write one)
    rm -f ".mpl/signals/session-handoff.json"

    # Proceed to existing Resume logic (based on resume_from_phase)
```

This processing runs **before** the existing Resume logic, cleans up `session_status`, then the existing Phase restoration logic uses `resume_from_phase` to perform normal continuation.

v0.14.1 (#35) added `paused_checkpoint` handling: orchestrator verbal pauses (checkpoint report + carryover) write the same pause fields as F-33, so the same resume path clears them.

#### Watcher-Based Auto-Resume (F-33, v3.9)

For hands-free operation, run the session watcher in a separate terminal:

```bash
# Watch for pause signals and auto-resume
./MPL/tools/mpl-session-watcher.sh /path/to/project

# Notify-only mode (no auto-start)
./MPL/tools/mpl-session-watcher.sh /path/to/project --notify-only

# Custom check interval (default: 5s)
./MPL/tools/mpl-session-watcher.sh /path/to/project --interval 10
```

The watcher monitors `.mpl/signals/session-handoff.json`. When detected:
1. Reads signal data (resume_from_phase, budget info)
2. Removes signal file (prevents duplicate resume)
3. Starts a new Claude session with `/mpl:mpl-resume`

Signal freshness: mpl-session-init.mjs validates the signal is <120s old (HANDOFF_MAX_AGE_MS).

| Data | Source |
|------|--------|
| Completed results | `.mpl/mpl/phases/phase-N/state-summary.md` |
| Accumulated PDs | `.mpl/mpl/phase-decisions.md` |
| Phase definitions | `.mpl/mpl/decomposition.yaml` |
| Progress | `.mpl/mpl/state.json` |
| Pivot Points | `.mpl/pivot-points.md` |

---

## Discovery Processing

When Phase Runner reports discoveries, Orchestrator processes them:

```
for each discovery in result.discoveries:

  # 1. PP Conflict Check
  if discovery.pp_conflict:
    pp = find_pp(discovery.pp_conflict)

    if pp.status == "CONFIRMED":
      -> Automatic rejection (hard constraint)
      -> Record in .mpl/discoveries.md with reason

    elif pp.status == "PROVISIONAL":
      -> HITL:
         AskUserQuestion: "Discovery D-{N} conflicts with PP-{M}."
         Options: "Reject" | "Accept" | "Defer"
         Timeout: 30s -> Auto-select "Defer"

  # 2. PD Override Check
  elif discovery.pd_override:
    -> HITL judgment

  # 3. General Discovery (no conflict)
  else:
    -> Review at phase transition

  # 4. Record
  Append to .mpl/discoveries.md:
    "D-{N} (Phase {current}): {description} [status: approved/rejected/pending]"
```

---

## Related Skills

| Skill | Purpose |
|-------|---------|
| `/mpl:mpl` | Micro-Phase Loop pipeline — single entry point with auto tier routing (F-20) |
| `/mpl:mpl-small` | **Deprecated** — use `/mpl:mpl` (auto-routes to standard tier) |
| `/mpl:mpl-pivot` | Pivot Points interview |
| `/mpl:mpl-status` | Pipeline status dashboard |
| `/mpl:mpl-cancel` | Clean cancellation |
| `/mpl:mpl-resume` | Resume from last phase |
| `/mpl:mpl-bugfix` | **Deprecated** — use `/mpl:mpl` (auto-routes to near proximity) |
| `/mpl:mpl-doctor` | Installation diagnostics |
| `/mpl:mpl-setup` | Setup wizard |
| `/mpl:mpl-gap-analysis` | Gap analysis for missing requirements |

> **Note (F-20)**: `mpl-small` and `mpl-bugfix` are deprecated. The `/mpl:mpl` skill now auto-detects
> pp_proximity (near/mid/far) via Quick Scope Scan. Use keyword hints for manual override:
> `"mpl bugfix"` → near, `"mpl small"` → mid.
