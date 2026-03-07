---
description: Learning extraction and knowledge distillation - standalone or post-pipeline
---

# MPL Compound

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

### Step 2: Delegate to mpl-compound

```
Task(subagent_type="mpl-compound", prompt="""
Extract learnings from the following context:

{gathered context from Step 1}

Feature/task name: {feature name from user or inferred}

Generate the 4 learning files:
- learnings.md (patterns, conventions, effective approaches, anti-patterns)
- decisions.md (design choices with rationale and alternatives considered)
- issues.md (unresolved problems, workarounds, known limitations)
- metrics.md (completion stats, quality gates, fix loop data, agent usage)
""")
```

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

When no `.mpl/` state exists, the agent analyzes `git diff` and changed files directly to extract knowledge.

## Related

- `/mpl:mpl` runs compound automatically at Step 5.2
- `/mpl:mpl-status` to check pipeline state before extraction
