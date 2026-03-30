---
description: "Gap analysis for missing requirements — standalone pre-implementation review. Usually called internally during Phase 0. May also trigger when the user explicitly asks for requirement review: 'gap analysis', '빠진 거 없는지 검토', '요구사항 점검해줘'."
---

# MPL Gap Analysis

Run gap analysis independently to identify missing requirements, AI pitfalls, and "Must NOT Do" constraints before implementation.

## When to Use

- Before starting any implementation (preventive review)
- When requirements feel incomplete or ambiguous
- To validate a plan before committing to execution
- As a second opinion on an existing decomposition

## Protocol

### Step 1: Gather Context

1. Read user's task description / requirements
2. Analyze relevant codebase areas:
   - `Glob` for affected file patterns
   - `Grep` for existing implementations and patterns
   - `lsp_document_symbols` for public API signatures
3. Read existing Pivot Points if available (`.mpl/pivot-points.md`)

### Step 2: Delegate to mpl-pre-execution-analyzer

```
Task(subagent_type="mpl-pre-execution-analyzer", model="sonnet", prompt="""
Analyze the following for gaps and risks:

User Request: {task description}
Pivot Points: {PPs if available, else "none"}
Codebase Context:
{relevant file structure, APIs, patterns}

Part 1 - Gap Analysis:
1. Missing Requirements - what the user didn't specify but is needed
2. AI Pitfalls - common mistakes an AI agent would make on this task
3. Must NOT Do - explicit constraints to prevent breaking changes
4. Recommended Questions - what to ask the user before proceeding

Part 2 - Tradeoff Analysis:
5. Overall Risk Assessment
6. Change-Level Analysis (risk/reversibility per change)
7. Recommended Execution Order
""")
```

### Step 3: Report

Present the analysis to the user with actionable items:
- CRITICAL gaps that block implementation
- Questions that need user input
- Constraints to carry forward as Pivot Points
- Risk summary and recommended execution order

If used within the full MPL pipeline, results feed into Step 1-B automatically.

## Constraints

- Read-only analysis: no code changes
- Orchestrator delegates analysis entirely to mpl-pre-execution-analyzer
- Results are advisory; user decides which gaps to address

## Related

- `/mpl:mpl` runs pre-execution analysis automatically at Step 1-B
