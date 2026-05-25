---
name: mpl-pivot
description: "Thin wrapper for Pivot Point discovery. Delegates interview logic to agents/mpl-interviewer.md; use for /mpl:mpl-pivot or when the user asks to define core constraints, Pivot Points, PP, immutable boundaries, PP 정리, 피벗 포인트, or 제약조건."
---

# MPL Pivot Points

Pivot Points (PPs) are immutable project constraints. They define what must not
change while MPL plans and executes the work.

This skill is an entrypoint wrapper only. It does not own the interview
questions, scoring loop, or downstream Phase 0 artifacts. The canonical PP
interview protocol lives in `agents/mpl-interviewer.md`; the canonical pipeline
placement lives in `commands/mpl-run-phase0.md` Stage 1.

## Responsibility Boundary

| Component | Owns | Must not own |
|---|---|---|
| `/mpl:mpl-pivot` skill | Standalone entrypoint, existing PP check, interviewer dispatch, persistence of `.mpl/pivot-points.md` | Interview question design, ambiguity scoring, user contract, goal contract, planning |
| `agents/mpl-interviewer.md` | Structured PP discovery questions, PP conformance checks, final PP specification, `user_responses_summary` | File writes, codebase analysis, implementation, decomposition |
| `commands/mpl-run-phase0.md` | Full pipeline ordering: Stage 1.1 core scenarios through Stage 1.9 interview snapshot, then Stage 2 ambiguity loop | Duplicating interviewer prompt logic |
| `mpl_score_ambiguity` loop | Stage 2 ambiguity scoring and repair after PPs exist | Initial PP interview |

## When To Use

Use this skill when:

- The user explicitly invokes `/mpl:mpl-pivot`.
- The user asks to define PP, Pivot Points, immutable constraints, or project
  boundaries without running the full MPL pipeline.
- The user asks in Korean for "PP 정리", "피벗 포인트", or "제약조건".
- A full `/mpl:mpl` run needs PP discovery and calls this entrypoint as a
  convenience wrapper.

Do not use this skill to run a second interview after `agents/mpl-interviewer.md`
already produced current PPs. If `.mpl/pivot-points.md` exists, ask whether to
keep, refine, or regenerate it before dispatching the interviewer again.

## Runtime Protocol

1. Check whether `.mpl/pivot-points.md` exists.
2. If it exists, show a short summary and ask the user whether to keep, refine,
   or regenerate it.
3. Dispatch `agents/mpl-interviewer.md` with full-equivalent Stage 1 mode.
4. Save the returned PP specification to `.mpl/pivot-points.md`.
5. Save or pass through `user_responses_summary` for Stage 2 when the full
   pipeline is running.
6. Stop after reporting `.mpl/pivot-points.md` in standalone mode. In full
   pipeline mode, return control to `commands/mpl-run-phase0.md` Stage 1.1.

Dispatch shape:

```text
Task(subagent_type="mpl-interviewer", model="opus", prompt=`
  user_request: ${user_request}
  provided_specs: ${provided_specs}
  existing_pivot_points: ${existing_pivot_points_or_empty}
  invocation: "/mpl:mpl-pivot"
`)
```

## Persistence Contract

The interviewer returns a PP specification. Persist it as:

```markdown
# Pivot Points

### PP-1: {title}
- Principle: {the immutable principle}
- User Value: {what user gains from this principle}
- Judgment Criteria: {concrete violation condition}
- Priority: 1
- Status: CONFIRMED | PROVISIONAL
- Violation Example: {scenario where user would say "this is broken"}
- Compliance Example: {scenario where user would say "this works"}

### Priority Order
PP-1 > PP-2 > PP-3

### Interview Metadata
- Depth: full
- Rounds completed: {1-4}
- Provisional PPs: {count}
```

Do not insert User Contract fields into `.mpl/pivot-points.md`. UC data belongs
in `.mpl/requirements/user-contract.md`; the PP schema guard will block leakage.

## Standalone Output

When invoked outside the full MPL pipeline, report only:

- Path written: `.mpl/pivot-points.md`
- Number of PPs and their status counts
- Any PROVISIONAL PP that needs later confirmation
- That planning has not started yet

## Pipeline Handoff

When invoked inside `/mpl:mpl`, return control to Phase 0 after Stage 1:

- Stage 1.1 derives core scenarios from confirmed PPs.
- Stage 1.2 through Stage 1.8 derive intent, contracts, and goal evidence.
- Stage 1.9 saves the interview snapshot.
- Stage 2 runs the orchestrator-driven ambiguity loop with `mpl_score_ambiguity`.

The skill must not duplicate any of those stages.
