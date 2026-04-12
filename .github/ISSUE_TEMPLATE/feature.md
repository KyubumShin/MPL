---
name: Feature / Change
about: New capability, modification of existing behavior, or refactor
title: "[stage] Short description"
labels: ["type:feature", "status:proposed", "version:vBacklog"]
---

## Summary

<!-- One sentence: what changes and why. -->

## Context

<!--
Where did this come from? (internal audit, PR discussion, user report, downstream need)
Link related ADRs in docs/decisions/ if any.
-->

## Proposal

<!-- Concrete changes as bullets. -->

-
-

## Constraints / Pivot Points

<!-- What must NOT change. Files/interfaces that callers depend on. -->

## Acceptance Criteria

- [ ] <testable outcome>
- [ ] <testable outcome>

## References

- Related issues / PRs: #
- Code paths: `hooks/lib/xxx.mjs`, `commands/xxx.md`
- ADR: `docs/decisions/AD-NNNN-xxx.md` (if applicable)

<!--
Label checklist before submitting:
  - type:{feature|refactor|debt|docs|policy}
  - area:{hooks|agents|skills|commands|mcp-server|plugin|docs|tests}
  - stage:{triage|phase0|decompose|execute|finalize|resume} (if pipeline-specific)
  - gate:{hard1|hard2|hard3|advisory} (if gate-specific)
  - pp:{near|mid|far} (if proximity-specific)
  - version:{v0.13.1|v1.0.0|vBacklog}
  - breaking-change / needs-pp (if applicable)
-->
