# MPL Architecture Decision Records

This directory holds the decision log for MPL — design choices that are **not** self-evident from the code and that future contributors (human or AI) need context to understand.

## When to write an ADR

Write one when:

- A design decision cost a meaningful debate (trade-off between two plausible approaches, cross-cutting impact).
- A proposal was **rejected** and the reasoning should outlive memory (so the same idea doesn't get re-proposed in six months).
- A feature's shape was constrained by something non-obvious (external API, legacy invariant, Claude model quirk).

Do **not** write one for:

- Straightforward implementations (the code and commit are enough).
- Preferences or naming choices without trade-offs.
- Bug fixes (the commit message and issue are the record).

## File naming

```
AD-NNNN-short-slug.md
```

- `NNNN` is a zero-padded monotonically increasing integer. Take the next number by scanning this directory.
- `short-slug` is kebab-case, 3–6 words.
- Example: `AD-0001-reject-advisor-api-integration.md`

## Frontmatter

```yaml
---
id: AD-0001
title: Reject Advisor API integration
status: accepted | superseded-by:AD-NNNN | rejected | deprecated
date: 2026-04-11
related: [#12, #15, AD-0000]
---
```

`status` transitions:

- `proposed` → `accepted` once approved
- `accepted` → `superseded-by:AD-NNNN` if a later ADR replaces it
- `accepted` → `deprecated` if the decision no longer applies but no replacement exists
- `rejected` for decisions that were explicitly decided against (still worth recording the reasoning)

## Body structure

```markdown
## Context

What forced the decision. Include concrete evidence:
pipeline traces, failure modes, benchmark numbers, quotes from discussion.

## Decision

One paragraph stating the chosen path. Be blunt: "We will X" not "We might X".

## Alternatives Considered

For each rejected option: one line + why it lost.
This section exists so the same alternative doesn't get re-proposed later —
be specific about the dealbreaker.

## Consequences

What changes because of this decision. Include:
- Code impact (which files/subsystems)
- Constraint on future work
- Operational implications (runtime, docs, migration steps)
- What we are explicitly *not* solving with this decision

## References

- Issue / PR links
- Related ADRs
- External sources (blog posts, papers, specs)
```

## Index

| ID | Title | Status | Date |
|----|-------|--------|------|
| [AD-0005](AD-0005-pr-pattern-mechanical-placement.md) | PR-02/03/04 mechanical pattern placement — EXPERIMENTAL + DROP + LOST | accepted | 2026-04-12 |
| [AD-0004](AD-0004-test-agent-long-term-architecture.md) | Test Agent long-term architecture — Option A baseline with conditional Option B experiment | accepted | 2026-04-12 |
| [AD-0003](AD-0003-v012.2-accidental-agent-deletion.md) | v0.12.2 accidental agent deletion — partial revert for mpl-test-agent | accepted | 2026-04-12 |
| [AD-0002](AD-0002-cb-features-bound-to-ablation-experiment.md) | CB cross-boundary features are bound to the cb-testbed ablation experiment | accepted | 2026-04-12 |
| [AD-0001](AD-0001-reject-advisor-tool-integration.md) | Reject Anthropic Advisor Tool integration in MPL | accepted | 2026-04-11 |

<!-- Add a row when a new ADR is created. Keep sorted by ID descending (newest first). -->
<!-- AD-0005 accepted 2026-04-12: PR-02/03/04 pattern placement resolved via 3-agent debate (3:0 convergence) -->
