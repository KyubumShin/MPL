---
description: "[DEPRECATED] Learning extraction now runs inline during finalize (Step 5.2). This skill is kept for standalone use only. Triggers on: 'compound', '배운 점 정리', '회고해줘'."
---

# MPL Compound (Deprecated)

> **Deprecation Notice (v2):** In v2, learning extraction runs inline during the finalize step (Step 5.2) — the separate mpl-compound agent was removed. This skill is retained only for standalone use outside the pipeline.

Extract learnings, decisions, issues, and metrics from a completed pipeline run or coding session.

## When to Use

- After a completed MPL pipeline run
- After pipeline cancellation (preserve partial learnings)
- Standalone: extract knowledge from any significant code changes
- Periodic knowledge capture for long-running projects

## Protocol

### Step 1: Gather Context

Read available sources:
- `.mpl/mpl/phases/*/state-summary.md` (phase results)
- `.mpl/mpl/metrics.json` (pipeline metrics)
- `.mpl/mpl/phase-decisions.md` (accumulated decisions)
- `.mpl/pivot-points.md` (constraints applied)
- `git log --oneline -20` (recent commits)
- `git diff HEAD~N` (recent changes if no pipeline state)

### Step 2: Extract Learnings (Inline)

The orchestrator performs learning extraction directly (no agent delegation).

Analyze the gathered context and generate 4 learning files under `docs/learnings/{feature}/`:

1. **learnings.md** — Patterns, conventions, effective approaches, anti-patterns discovered
2. **decisions.md** — Design choices with rationale and alternatives considered
3. **issues.md** — Unresolved problems, workarounds, known limitations
4. **metrics.md** — Completion stats, quality gates, fix loop data, agent usage

For each file, structure content with clear headings and bullet points. Extract concrete, reusable knowledge — not just a summary of what happened.

### Step 3: Report

Output summary:
```
[MPL Compound] Learning extraction complete.
  Learnings:  {N} patterns, {N} conventions
  Decisions:  {N} recorded
  Issues:     {N} open
  Output:     docs/learnings/{feature}/
```

## Standalone Mode

When no `.mpl/` state exists, analyze `git diff` and changed files directly to extract knowledge.

## Related

- `/mpl:mpl` runs compound automatically at Step 5.2
- `/mpl:mpl-status` to check pipeline state before extraction
