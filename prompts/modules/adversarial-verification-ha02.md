# HA-02 Adversarial Verification — Canonical Prompt Module

**Version**: v0.12.0 (antipattern wording refactored v0.16)
**Status**: canonical source
**Canonical consumer**: `agents/mpl-test-agent.md` — the block bounded by
`<!-- HA-02 BEGIN v0.12.0 -->` / `<!-- HA-02 END v0.12.0 -->`.
**Gate 1 candidate consumer**: `agents/mpl-phase-runner.md` Step 4 (AD-0004 Option B experiment — not yet inlined).

**Sync rule**: this file is the **canonical source**. The block between the
BEGIN/END markers in `agents/mpl-test-agent.md` is a synchronized copy. If
either copy is changed, update both in the same commit. Any new consumer
(e.g. inlining into `mpl-phase-runner` for the AD-0004 Gate 1 experiment) must
copy from this file, not from the test-agent inline copy, to prevent drift.

**Empirical motivation**: `cb-phase-a1-n3-report.md` §5.3 — C2 = 0 and C3 = 0
across 29 runs. Tests written by the implementer structurally cannot detect L2
parameter or L3 schema defects. This module is MPL's anti-rationalization
defense at the verification layer.

---

## Content — paste into target prompt verbatim

<!-- HA-02 BEGIN v0.12.0 -->

### AP-VERIFY-01 · Verifier self-rationalization (HA-02)

When your reasoning produces phrasing like "the code looks correct", "this is
good enough", "minor issue — let it pass", "overall well-implemented", or —
most dangerously — discovers a problem and then argues it away, you are no
longer verifying. You are rationalizing a positive conclusion you already
formed. 29-run empirical data (cb-phase-a1-n3-report.md §5.3) shows these are
the dominant failure shapes for LLM verifiers: C2 (parameter) and C3 (schema)
defect recall was structurally zero when verifiers drifted into these phrasings.

Root cause: verifiers share the implementer's context framing and inherit its
confirmation bias unless explicitly structured to produce independent evidence.
This is the AD-0003/AD-0004 rationale for keeping the test-agent as a
separate, adversarial role — your independence is the value you add.

If you catch any of these shapes in your own draft output, stop and replace
the judgment with an evidence record: run the actual command or test, record
its exit code and the specific input/output, and let the `Expected vs Actual`
block below decide the verdict. Every discovered problem must be reported —
filtering them is the antipattern, not reporting too many.

### Structured Verification Output (v0.12.0, HA-02)

For each test case in your report, use this format in the `evidence` field:

```
Test: [test description]
Expected: [Seed-based expected result]
Actual: [actual execution result]
Verdict: PASS | FAIL | WARN
```

### Probing Hints (v0.12.0, HA-03)

If the Phase Seed contains a `probing_hints` field, include at least one
adversarial test based on those hints. These hints represent risk areas
identified by the decomposer (e.g., concurrency conflicts, boundary values,
platform constraints). Treat them as mandatory test targets, not suggestions.

<!-- HA-02 END v0.12.0 -->

---

## Usage notes

- **Language**: the antipattern wording was translated from Korean to English
  in v0.16 as part of the prompt unification pass. Because this file is the
  canonical source and every copy syncs from here, translation drift is
  structurally prevented — the earlier "do not translate on copy" rule was
  about ad-hoc localization by individual consumers, which is still prohibited.
- **Ordering**: the failure shapes listed in AP-VERIFY-01 are ordered by
  frequency observed in past reviews. Preserve ordering when editing.
- **Scope**: this module defines *how* to verify adversarially. It does not
  replace the verifier's Role / Why_This_Matters / Success_Criteria preamble
  — those remain in the consuming agent's own frontmatter. This module is a
  plug-in sub-section, not a standalone prompt.
- **Extraction history**: extracted to this canonical location from
  `agents/mpl-test-agent.md` on 2026-04-12 per AD-0004 §Consequences "Do NOW
  regardless of gate outcome" item 1, to make the Option B experiment
  inlining into `agents/mpl-phase-runner.md` mechanical instead of
  copy-paste-drift-prone. Antipattern wording refactored in v0.16 alongside
  the broader Option D antipattern pass.

## References

- `agents/mpl-test-agent.md` (HA-02 BEGIN/END markers) — synchronized copy (current canonical consumer)
- `agents/mpl-decomposer.md` Step 9.5 — HA-03 producer (writes `probing_hints` that this module's Probing Hints section consumes)
- `docs/decisions/AD-0004-test-agent-long-term-architecture.md` — why this module exists; Gate 1 + Gate 2 decision framework
- `docs/decisions/AD-0003-v012.2-accidental-agent-deletion.md` — why the content was almost lost; why extraction to a canonical source prevents recurrence
- Empirical ground: `~/project/harness_lab/analysis/cb-phase-a1-n3-report.md` §5.3
