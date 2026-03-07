---
description: MPL learning extraction and knowledge distillation - post-pipeline knowledge capture
---

# MPL Compound

Extract learnings, decisions, and patterns from a completed (or cancelled) MPL pipeline run.
Adapted from hoyeon's /compound pattern for knowledge distillation.

## When to Use

- After MPL pipeline completes (Phase 5)
- After pipeline cancellation (to preserve partial learnings)
- Periodically during long-running pipelines (manual knowledge capture)
- As a standalone learning tool after any significant coding session

## Protocol

### Step 1: Gather Evidence

Read all available sources in parallel:

```
# Pipeline artifacts
.mpl/state.json          → pipeline metrics, convergence data
.mpl/PLAN.md              → original plan, TODO completion status

# Git history
git log --oneline -20     → recent commits
git diff --stat HEAD~10   → scope of changes

# Existing learnings
docs/learnings/{feature}/ → any previously extracted learnings
```

### Step 2: Extract Categories

Organize findings into 4 categories:

#### Learnings (patterns and conventions)

- What coding patterns were discovered in the codebase?
- What conventions does the project follow?
- What worked well? What approaches were effective?
- What technical patterns should be reused?

#### Decisions (design choices with rationale)

- What architecture decisions were made and why?
- What alternatives were considered and rejected?
- What tradeoffs were accepted?
- What constraints shaped the decisions?

#### Issues (unresolved problems)

- What known bugs remain?
- What technical debt was introduced?
- What workarounds are in place?
- What needs follow-up?

#### Metrics (quantitative data)

- TODO completion rate (completed/total)
- Gate pass rates (per gate)
- Fix loop iterations used
- Total attempts per TODO
- Convergence trend (improving/stagnating)

### Step 3: Generate Artifacts

Create `docs/learnings/{feature-name}/` with 4 files:

#### `learnings.md`
```markdown
# Learnings: {feature-name}
Date: {date}
Pipeline: {pipeline_id}

## Patterns Discovered
- {pattern}: {description} — Source: {file:line}

## Conventions Confirmed
- {convention}: {description}

## Effective Approaches
- {approach}: {why it worked}

## Anti-Patterns Encountered
- {anti-pattern}: {what went wrong} — Fix: {what worked instead}
```

#### `decisions.md`
```markdown
# Decisions: {feature-name}
Date: {date}

## Decision Log

### D-1: {decision title}
- Context: {why this decision was needed}
- Options considered: {list}
- Chosen: {option} — Rationale: {why}
- Consequences: {tradeoffs accepted}
- Revisit when: {trigger for reconsideration}
```

#### `issues.md`
```markdown
# Known Issues: {feature-name}
Date: {date}

## Open Issues

### I-1: {issue title}
- Severity: {LOW|MED|HIGH}
- Description: {details}
- Workaround: {if any}
- Suggested fix: {approach}
- Blocked by: {dependency if any}
```

#### `metrics.md`
```markdown
# Metrics: {feature-name}
Date: {date}
Pipeline: {pipeline_id}

## Completion
- TODOs: {completed}/{total} ({pct}%)
- Duration: {start → end}

## Quality Gates
- Gate 1 (Tests): {PASS|FAIL} — {details}
- Gate 2 (Review): {PASS|FAIL} — {details}
- Gate 3 (Agent): {PASS|FAIL|N/A} — {details}

## Fix Loop
- Iterations: {count}/{max}
- Convergence: {trend}
- Pass rate history: {rates}

## Agent Usage
- Phase 1 agents: {count} ({list})
- Phase 2 workers: {count}
- Model escalations: {count} ({details})
```

### Step 4: Update Project Memory

If project-memory tools are available, persist durable knowledge:

```
project_memory_add_note(category="architecture",
  content="{key architectural decisions from this pipeline}")

project_memory_add_note(category="patterns",
  content="{reusable patterns discovered}")

project_memory_add_note(category="build",
  content="{build/test infrastructure learnings}")
```

### Step 5: Summary Output

```
MPL Knowledge Extraction Complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Pipeline: {pipeline_id}
Feature:  {feature-name}

Extracted:
  Learnings:  {N} patterns, {N} conventions
  Decisions:  {N} design decisions documented
  Issues:     {N} open issues flagged
  Metrics:    completion {pct}%, {N} fix iterations

Files created:
  docs/learnings/{feature}/learnings.md
  docs/learnings/{feature}/decisions.md
  docs/learnings/{feature}/issues.md
  docs/learnings/{feature}/metrics.md

Project memory updated: {yes|no}
```

## Standalone Mode

When used outside a MPL pipeline (no `.mpl/state.json`):

1. Ask user for context: "어떤 작업의 학습을 추출할까요?"
2. Analyze git history and recent changes
3. Generate the 4 learning files based on code changes alone
4. Skip pipeline-specific metrics (no state data)

## Knowledge Lifecycle

```
Pipeline Run → Compound (extract) → Project Memory (persist) → Future Pipelines (inform)
                                                                        ↓
                                                              Phase 1 agents read
                                                              project memory for
                                                              prior art awareness
```

This creates a virtuous cycle: each pipeline run makes future runs smarter.
