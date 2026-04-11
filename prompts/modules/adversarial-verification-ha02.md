# HA-02 Adversarial Verification — Canonical Prompt Module

**Version**: v0.12.0
**Status**: canonical source
**Canonical consumer**: `agents/mpl-test-agent.md` lines 118–143 (`<Adversarial_Verification_HA02>` block)
**Gate 1 candidate consumer**: `agents/mpl-phase-runner.md` Step 4 (AD-0004 Option B experiment — not yet inlined)

**Sync rule**: this file is the **canonical source**. The content inside `<Adversarial_Verification_HA02>` in `agents/mpl-test-agent.md` is a synchronized copy. If either copy is changed, update both in the same commit. Any new consumer (e.g. inlining into `mpl-phase-runner` for the AD-0004 Gate 1 experiment) must copy from this file, not from the test-agent inline copy, to prevent drift.

**Empirical motivation**: `cb-phase-a1-n3-report.md` §5.3 — C2 = 0 and C3 = 0 across 29 runs. Tests written by the implementer structurally cannot detect L2 parameter or L3 schema defects. This module is MPL's anti-rationalization defense at the verification layer.

---

## Content — paste into target prompt verbatim

<!-- HA-02 BEGIN v0.12.0 -->

### Self-Rationalization Anti-Patterns (v0.12.0, HA-02)

The following judgment patterns are signals of confirmation bias. If you catch yourself producing any of these, STOP and replace with evidence-based verification:

- "코드가 올바르게 보인다" → Prove it with actual execution results, not reading
- "이 정도면 충분하다" → Define "sufficient" by cross-referencing Seed's example I/O
- "사소한 문제이므로 통과" → State explicit evidence for why it is trivial
- "전체적으로 잘 구현되었다" → List per-item verification results individually
- Discovering a problem then rationalizing it away → Report ALL discovered issues without filtering

### Structured Verification Output (v0.12.0, HA-02)

For each test case in your report, use this format in the `evidence` field:

```
Test: [test description]
Expected: [Seed-based expected result]
Actual: [actual execution result]
Verdict: PASS | FAIL | WARN
```

### Probing Hints (v0.12.0, HA-03)

If the Phase Seed contains a `probing_hints` field, you MUST include at least one adversarial test based on those hints. These hints represent risk areas identified by the decomposer (e.g., concurrency conflicts, boundary values, platform constraints). Treat them as mandatory test targets, not suggestions.

<!-- HA-02 END v0.12.0 -->

---

## Usage notes

- **Language**: the 5 anti-patterns are Korean because that is how they shipped in v0.12.0. Do not translate on copy — localization drift would silently weaken the defense. Consumers that do not read Korean should treat each anti-pattern as a fixed identifier, not as natural-language prose.
- **Ordering**: the anti-patterns are ordered by frequency observed in past reviews. Do not reorder.
- **Scope**: this module defines *how* to verify adversarially. It does not replace the verifier's Role / Why_This_Matters / Success_Criteria preamble — those must remain in the consuming agent's own frontmatter. This module is a plug-in sub-section, not a standalone prompt.
- **Extraction history**: extracted to this canonical location from `agents/mpl-test-agent.md:118-143` on 2026-04-12 per AD-0004 §Consequences "Do NOW regardless of gate outcome" item 1, to make the Option B experiment inlining into `agents/mpl-phase-runner.md` mechanical instead of copy-paste-drift-prone.

## References

- `agents/mpl-test-agent.md:118-143` — synchronized copy (current canonical consumer)
- `agents/mpl-decomposer.md` Step 9.5 — HA-03 producer (writes `probing_hints` that this module's Probing Hints section consumes)
- `docs/decisions/AD-0004-test-agent-long-term-architecture.md` — why this module exists; Gate 1 + Gate 2 decision framework
- `docs/decisions/AD-0003-v012.2-accidental-agent-deletion.md` — why the content was almost lost; why extraction to a canonical source prevents recurrence
- Empirical ground: `~/project/harness_lab/analysis/cb-phase-a1-n3-report.md` §5.3
