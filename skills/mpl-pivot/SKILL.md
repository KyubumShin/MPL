---
description: "Pivot Point discovery through structured interview — define immutable constraints before planning. Usually called internally by /mpl:mpl before Phase 1. May also trigger when the user explicitly asks to define constraints: 'pivot point', 'PP 정리', '제약조건 잡아줘'."
---

# MPL Pivot Points Interview

Pivot Points (PP) are **constraints that never change** throughout the entire project.
This skill discovers and defines PPs through a structured interview.

## When to Use

- Before starting the MPL pipeline (before Phase 1)
- When PPs are not clearly defined
- When starting a new project or making a large directional change
- When running `/mpl:mpl` and no PP exists, this skill runs automatically first

## Triage Integration

When invoked from the MPL pipeline, the Triage step determines interview depth:

| Triage Result | Interview Behavior |
|---------------|-------------------|
| `interview_depth: "full"` | All 4 rounds (default behavior) |
| `interview_depth: "light"` | Round 1 (What) + Round 2 (What NOT) only. Skip Either/Or and How to Judge. This is the minimum depth — `light` cannot be reduced further (F-35). |

When `interview_depth` is provided in the invocation context, respect it:
- `"light"`: After Round 2, generate PP candidates and skip to Output. This is the minimum interview depth; `skip` is not supported.

## Interview Protocol

### Round 1: Core Exploration (What)

Identify the core identity of the project.

```
AskUserQuestion: "What is the core identity of this project?"
Options:
  1. {Identity A inferred from project description}
  2. {Identity B inferred from project description}
  3. (User input)
```

**Inference method**: Pre-identify candidates through codebase exploration (explore agent) + README/CLAUDE.md analysis.

Followed by:
```
AskUserQuestion: "What is the most important value in this project?"
Options:
  1. "User Experience (UX)"
  2. "Performance/Speed"
  3. "Stability/Reliability"
  4. (User input)
```

### Round 2: Boundary Exploration (What NOT)

Find what must not change.

```
AskUserQuestion: "What must absolutely not be lost while adding this feature?"
Options:
  1. {Constraint A inferred from Round 1 answers}
  2. {Constraint B inferred from Round 1 answers}
  3. {Core pattern discovered in codebase}
  4. (User input)
```

```
AskUserQuestion: "What changes could break this project?"
Options:
  1. {Inferred risk scenario A}
  2. {Inferred risk scenario B}
  3. (User input)
```

### Round 3: Tradeoff Exploration (Either/Or)

Confirm priorities between PPs.

```
AskUserQuestion: "If {PP-A} and {PP-B} conflict, which takes priority?"
Options:
  1. "{PP-A} first"
  2. "{PP-B} first"
  3. "Depends on the situation" → follow-up question to define judgment criteria
```

This round only runs when there are 2 or more PPs.
Confirm priority for all PP pairs (N*(N-1)/2 pairs).

### Round 4: Concretization (How to Judge)

Concretize the violation judgment criteria for each PP.

```
AskUserQuestion: "How can we judge '{PP-1 principle}'?"
Options:
  1. {Inferred judgment criterion A} (e.g., "Violation if click count increases")
  2. {Inferred judgment criterion B} (e.g., "Violation if loading time exceeds 2 seconds")
  3. (User input)
```

**When judgment criteria are ambiguous**: Use the following strategy if the user cannot answer clearly.

### Unclear PP Handling Strategy

When a PP is not clear, approach in 3 stages:

#### Strategy 1: Example-Based Concretization
```
AskUserQuestion: "Which of the following violates the {PP principle}?"
Options:
  1. "Splitting the settings menu into 3 levels" → Violation?
  2. "Adding keyboard shortcuts" → Violation?
  3. "Always showing the sidebar" → Violation?
```
Extract the judgment criteria in reverse by analyzing the user's violation/non-violation judgments.

#### Strategy 2: Proceed with Provisional PP
```
PP-2: Preserve Editor Essence (PROVISIONAL)
- Principle: Text editing is the core and must not be overshadowed by supplementary features
- Judgment criteria: [TBD — revisit when Discovery occurs in Phase 2]
- Status: PROVISIONAL (soft constraint until confirmed)
```

PROVISIONAL PPs:
- **Do not auto-reject on Discovery conflict — escalate to HITL**
- When concrete cases emerge during Phase 2 execution, finalize judgment criteria
- Must be converted to CONFIRMED before entering Phase 3

#### Strategy 3: Start Without PP
In early exploration stages where a PP cannot be defined:
```json
{
  "pivot_points": [],
  "pp_status": "deferred"
}
```
Start without PP, and extract PP candidates from patterns discovered during Phase 2.

## Output

After the interview, create `.mpl/pivot-points.md`:

```markdown
# Pivot Points

## PP-1: {title}
- Principle: {what must not change}
- Judgment criteria: {specific violation conditions}
- Priority: 1 (highest)
- Status: CONFIRMED
- Violation example: {example}
- Allowed example: {example}

## PP-2: {title}
- Principle: ...
- Judgment criteria: ...
- Priority: 2
- Status: PROVISIONAL (judgment criteria not finalized)
- Violation example: {example}
- Allowed example: {example}

## Priority Order
PP-1 > PP-2 > PP-3
(Higher PP takes priority on conflict)
```

And insert the same content into the `## Pivot Points` section of PLAN.md.

## Integration with MPL Pipeline

```
/mpl:mpl-pivot (this skill)
     │
     ▼
.mpl/pivot-points.md created
     │
     ▼
/mpl:mpl (Phase 1)
     │
     ├── PM references pivot-points.md to write PLAN.md
     ├── PLAN.md includes ## Pivot Points section
     │
     ▼
Phase 2: Worker discoveries → PP conflict check
     │
     ├── CONFIRMED PP conflict → auto-reject
     ├── PROVISIONAL PP conflict → request HITL judgment
     └── No PP (explore) → all discoveries allowed
```

## Standalone Usage

Can be used without the MPL pipeline:
- Define initial project direction
- Formalize implicit constraints in existing projects
- Generate core principles document for team onboarding
