---
name: Cleanup / Dead Code Removal
about: Remove config, state fields, or features that are declared but never enforced
title: "[cleanup] Remove <target>"
labels: ["type:cleanup", "status:proposed", "version:vBacklog"]
---

## Target

<!-- The config field, state field, function, file, or feature to remove. -->

## Evidence of Deadness

- **Declared at**: `path/to/file:line`
- **Grep for consumers**: <result — list every caller or "none">
- **Effect of removal**: <no observable change / removes dead display / removes unused field>

## Files to Touch

-
-

## Risk

<!--
Backward-compat concerns:
- Does any existing state.json reference this field? (usually OK to leave for reads via optional chain)
- Is any downstream code assuming its presence?
- Is any test asserting on it?
-->

## References

- Audit source: <conversation / commit / PR>
- Related: #

<!--
Label checklist:
  - type:cleanup
  - area:{...}
  - version:{v0.12.3|vBacklog}
-->
