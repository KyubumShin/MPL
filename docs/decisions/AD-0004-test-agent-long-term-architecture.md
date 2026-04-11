---
id: AD-0004
title: Test Agent long-term architecture — Option A baseline with conditional Option B experiment
status: accepted
date: 2026-04-12
related: ["#19", "AD-0001", "AD-0002", "AD-0003"]
---

## Context

AD-0003 executed a partial revert of `4903a8d` to restore `agents/mpl-test-agent.md` and explicitly deferred the long-term architectural decision — *where should adversarial verification be hosted in MPL?* — to the 2026-04-12 reconciliation audit. The audit (`~/project/wiki/scratch/2026-04-12/mpl-reconciliation-audit.md` §5) completed D1 (agent registry), D2 (feature matrix), D3 (experimental evidence integration), and D4 (architecture synthesis), and produced a concrete recommendation. This ADR ratifies that recommendation.

Four options were evaluated against the current Phase internal structure, the original 3-role adversarial triangulation design intent, and the cb-phase-a1 experimental data:

- **Option A — Keep `mpl-test-agent.md` as a separate agent** (status quo post-AD-0003). Two observers (Phase Runner + F-40 Test Agent). Agent count = 8. HA-02 fires only in F-40 dispatch.
- **Option B — Inline HA-02 into `mpl-phase-runner` with explicit role-switching**. Delete test-agent again. Agent count = 7. Same session, prompt-level role-switching between runner and adversarial-tester mental contexts.
- **Option C — Full 3-role redesign**: Runner → Adversarial Tester → Reviewer, each a separate agent + separate session. Agent count = 9 or 10.
- **Option D — Flat structure + mechanical Hard 3 only**: delete test-agent, rely entirely on AD-01 (#14) mandatory contracts + AD-05 (#19) Hard 3 parameter value-path verification. Agent count = 7.

### Decision inputs

- **Architectural ground truth** (audit §5.2): Phase Runner self-tests in the same session as implementation, while F-40 Test Agent runs in a separate session. No role-switching in phase-runner's prompt. HA-02 content lives only inside `agents/mpl-test-agent.md:118-143`. The "Reviewer" role from the original 3-role intent is not implemented anywhere — Hard Gates cover some "mechanical observer" duties but none of the "adversarial cross-check against Pivot Points" duty.

- **Triangulation collapse** (audit §5.3): 3 intended observers → 2 current observers. Runner's in-session self-test shares the implementer's bias. Independence is preserved *only* at the F-40 boundary, not inside phase-runner's verify step.

- **Experimental data** (audit §4 + cb-phase-a1 report):
  - M2 contract presence is dominant (Δ = -2.17). CB-06 Contract Snippet Injection is MPL's strongest deployed L2 defense.
  - C2 = 0 and C3 = 0 across all runs — tests are *structurally* blind to L2 parameter and L3 schema defects. Not a cultural problem; mathematical.
  - 37% D2 residual leak at M1=1 M2=ON cells — single-worker writing both sides of a boundary drops L2 parameters ~37% of the time even with a contract. The 6→3 reduction doc's pre-registered Phase B trigger was FALSE (best cell = 0 defects).
  - **Load-bearing caveat**: F-40's *runtime effectiveness* is empirically unmeasured. The Phase A1 M3 branch did not actually run some cells (macOS `timeout` bug). Any claim about "F-40 catches L2/L3 defects" is structurally reasonable but empirically unfounded until a re-measurement.

- **cb-phase-a1 did not test prompt-level role-switching.** The M1 dimension measured *session-level* independence (single-worker vs two-worker), not within-session role-switching. Option B is therefore not flatly invalidated by the experiment — it is simply *unmeasured*.

## Decision

MPL will **keep Option A (status quo post-AD-0003) as the operational baseline**, with the long-term architectural path resolved through **one decision gate**:

1. **Gate 1 — Option B empirical test**. A targeted experiment will measure whether inline HA-02 + prompt-level role-switching inside `mpl-phase-runner` recovers L2/L3 detection at rates comparable to (or better than) the separate-session Option A baseline.
2. **Gate 2 — contingent on Gate 1 result**:
   - If Option B shows *substantial* L2/L3 detection improvement over the M1=1 M2=ON baseline → **promote B over A**. Delete `mpl-test-agent.md`, inline HA-02 into phase-runner, deprecate F-40 dispatch.
   - If Option B shows *no improvement* (detection still blocked at C2/C3 = 0) → **A remains the decision**. Escalate only if A's residual L2/L3 defects surface in production runs, at which point the debate reopens for C vs D.
   - If Option B shows *mixed or inconclusive* results → **stay on A**, re-run with a refined experiment design before making a permanent decision.

Options **C** (full 3-role redesign) and **D** (flat + Hard 3 only) are **explicitly deferred** as premature. C requires solving the Reviewer agent design problem (not well-defined: what does the Reviewer see, what does it output, how is it orchestrated with runner and tester?). D requires retrospective evidence that Hard 3 mechanical verification + AD-05 + AD-01 would have caught Phase A1's L2/L3 defects — current evidence shows mechanical and adversarial defenses are complementary, not substitutable. Neither option is rejected permanently; both are gated on new evidence that does not yet exist.

This ADR is accepted independently of when Gate 1 runs. The Option B experiment is scheduled work; Option A remains the operational default until that experiment has results to evaluate. If the experiment never runs, A is the long-term answer by default.

## Alternatives Considered

### Option B — Inline HA-02 into `mpl-phase-runner` with explicit role-switching

**Proposal**: Delete `mpl-test-agent.md`. Add an explicit "Switch to Adversarial Tester role" section to `agents/mpl-phase-runner.md` Step 4. Same session, prompt-level context shift. Agent count returns to 7. F-40 dispatch is removed from `commands/mpl-run-execute.md:470-546`.

**Rejected at this time because**: empirically untested. cb-phase-a1 varied M1 at session level, not at prompt level within a session. The pro-argument is cost — zero dispatch overhead, no sentinel validation, no Task lifecycle. The con-argument is that C2/C3 = 0 may be caused specifically by *session-level* shared context, in which case prompt-level role-switching does not recover detection. Both arguments are plausible and neither has supporting data.

**Not rejected permanently**. Option B is the *first* escalation path from A. The decision framework above explicitly schedules a Gate 1 experiment to collect the missing data. If that experiment shows B works, B replaces A. The cost of the experiment (≤1 day of experimenter time with ~3–5 cb-testbed-style phases) is much lower than the cost of committing to C or D without evidence.

### Option C — Full 3-role redesign (Runner + Adversarial Tester + Reviewer)

**Proposal**: Restore the original design intent fully. Runner produces implementation. Adversarial Tester (separate agent, spec-only inputs) writes tests. Reviewer (new agent, opus, observes both outputs) cross-checks against Pivot Points. Agent count = 9 or 10. Three sequential Task dispatches per mandatory phase.

**Rejected at this time because**:
- **Design incompleteness**: the Reviewer role has no existing specification. What context does it see? What does it output (pass/fail, findings, recommendations)? How are conflicts between runner and tester resolved? These questions are not answered anywhere in MPL's current documentation or prompts.
- **Runtime cost**: ~20–28K tokens per F-40 dispatch (2.5–3× Option A), ~300–350K per 9-phase pipeline. Material at scale.
- **No empirical evidence that 3-role beats 2-role**. cb-phase-a1 did not test 3-role. The original intent was intuition-based (pre-experimental). Committing to C's engineering overhead without evidence is not justified.

**Not rejected permanently**. If Gate 1 (Option B) fails *and* Option A's residual L2/L3 defects prove unacceptable in production runs, C reopens — but only after (a) Reviewer design clarity and (b) positive evidence that 3-role catches what 2-role misses.

### Option D — Flat structure + mechanical Hard 3 only

**Proposal**: Delete `mpl-test-agent.md` (undo AD-0003). Phase Runner does not dispatch F-40. Rely entirely on Hard 1 (build/lint/type), Hard 2 (tests + regression), Hard 3 + AD-05 (#19, parameter value-path verification), and AD-01 (#14, mandatory contracts). Adversarial prompts eliminated from the MPL defense stack.

**Rejected at this time because**:
- **Irreversible operationally**. Re-introducing adversarial verification after deleting test-agent a second time requires re-landing the agent file + dispatch orchestration. The cost of being wrong is high.
- **No retrospective evidence**. Hard 3 has not been tested against Phase A1's L2/L3 defects. The hypothesis "AD-05 closes the 37% leak" is reasonable but unverified.
- **Mechanical and adversarial are complementary, not substitutable**. AD-05 catches key-set and value-path mismatches at call sites. HA-02 catches semantic anti-rationalization and edge-case blind spots. D3 §4.4 notes these are different blind spots. Eliminating adversarial verification leaves MPL with only one defense layer against L2/L3, not two.

**Not rejected permanently**. If a Hard 3 retrospective experiment (audit §8.C #4) shows AD-05 would have caught all of Phase A1's L2/L3 defects, and Option B experiment shows inline role-switching does not add detection, D reopens. The conditions are strict and the data does not yet exist.

## Consequences

### Immediate (Option A as baseline)

- `agents/mpl-test-agent.md` remains in the tree (status: 8 agents per D1).
- F-40 Mandatory Independent Verification continues to dispatch `mpl-test-agent` for mandatory-domain phases per `commands/mpl-run-execute.md:470-546`.
- HA-02 adversarial verification content at `agents/mpl-test-agent.md:118-143` remains the canonical source.
- HA-03 Probing Hints producer (commit `74d20ac`) lives in `agents/mpl-decomposer.md` Step 9.5. Consumer at `agents/mpl-test-agent.md:140-142` now reads a field that the producer writes. HA-03 is FULLY ACTIVE.
- Agent registry stays at 8. `docs/design.md §4 Agent Catalog` footnote added in commit `c17b322` remains; it can be upgraded to list `mpl-test-agent` as a 8th catalog row once Gate 1 returns a decision.

### Pending — Gate 1 Option B experiment

- **Scope**: run 3–5 cb-testbed-equivalent phases with an inline role-switching HA-02 prompt in `agents/mpl-phase-runner.md` Step 4. Measure whether C2 (parameter-level detection) and C3 (schema-level detection) improve over the Phase A1 baseline at M1=1 M2=ON cells. Use the same defect classes (D2 api_key omission, D3 order field omission).
- **Input preparation**: the HA-02 snippet extraction tracked in audit §8.A #4 (next action) will produce a canonical, reusable prompt module that can be inlined into phase-runner without copy-paste drift from the test-agent source.
- **Success criterion**: C2 > 0 or C3 > 0 with statistical clarity (not noise). If detection rates match or exceed Option A's measured performance (which is itself pending F-40 re-measurement — see audit §8.C #2), B is a candidate for promotion.
- **Failure criterion**: C2 = 0 and C3 = 0 in all runs. Option A stands.
- **Inconclusive criterion**: mixed results or methodological issues. Re-run with refined design before deciding.

### Pending — F-40 runtime re-verification

- A fresh-session `Task(subagent_type="mpl-test-agent", ...)` probe must be run to confirm AD-0003's partial revert is effective in a real MPL session. The current session could not verify this because agent registry is loaded at session-start and does not auto-reload on file changes.
- F-40's *effectiveness* at catching L2/L3 defects also remains empirically unmeasured until the cb-testbed macOS `timeout` bug is fixed and a re-run under M3=1 actually executes.

### Do NOW regardless of gate outcome

These actions are valuable under A, and under B if it wins the gate:

1. **Extract HA-02 into a reusable snippet** (audit §8.A #4). Refactor `agents/mpl-test-agent.md:118-143` into a canonical prompt module with clear begin/end markers. This makes the Gate 1 inlining into phase-runner mechanical instead of a copy-paste operation vulnerable to drift.
2. **Measure Hard 3 mechanical effectiveness retrospectively** (audit §8.C #4). Run AD-05's parameter value-path verification logic on the Phase A1 test set and measure whether it would have caught the 37% D2 leak. This informs Option D's viability as a future fallback without requiring a full commit to D.
3. **Fresh-session F-40 probe** (audit §8.A #3). Verify the AD-0003 partial revert actually works end-to-end in a new session.

### Do NOT do yet

1. **Do not delete `mpl-test-agent.md` again** under any premise other than a positive Gate 1 result. The file restoration cost via `git checkout` is zero if we change our minds, but re-creating HA-02 from memory after deletion is drift-prone.
2. **Do not commit to Option C's Reviewer design** without (a) design clarity and (b) evidence that 3-role beats 2-role. Starting Reviewer work before Gate 1 runs is premature.
3. **Do not rely on Hard 3 alone** (Option D dependency) without the retrospective measurement showing it would have caught Phase A1 defects. The hypothesis is plausible; acting on it before testing is not.
4. **Do not extend F-40 to the `test` domain** phases. The current skip rule (`commands/mpl-run-execute.md:499-500`) is correct — test phases don't need adversarial testing of tests.

### Explicitly not decided by this ADR

- The long-term agent count (7, 8, 9, or 10). This depends entirely on the Gate 1 outcome and any subsequent Option C reopening.
- Whether HA-02's content should be updated to reflect the cb-phase-a1 empirical motivation (the restored file is the exact pre-`4903a8d` content). Any content update is a separate commit with a separate justification, tracked independently of this ADR.
- The fate of the original Reviewer role. If B wins, Reviewer stays unimplemented (flat 2-observer structure is the final answer). If B fails and production signal motivates C, Reviewer design becomes a separate ADR with its own trade-off analysis.

## References

- **Prior ADRs**: `AD-0003` (partial revert that enabled this decision), `AD-0002` (experimental grounding rule that applies to this decision), `AD-0001` (Advisor Tool rejection — the "structural failure, not advisory failure" framing informs Option D's rejection)
- **Audit**: `~/project/wiki/scratch/2026-04-12/mpl-reconciliation-audit.md` §5 (full 4-option evaluation), §8.A–D (decision matrix), §10 (next session opening prompt)
- **Experimental ground**: `~/project/harness_lab/analysis/cb-phase-a1-n3-report.md` §5.3 C2/C3 = 0 structural blindness, §7.2 37% residual leak, §4 M3 macOS timeout caveat
- **Consumer**: `agents/mpl-test-agent.md:118-143` (HA-02 content), `agents/mpl-test-agent.md:140-142` (HA-03 consumer)
- **Producer (post commit `74d20ac`)**: `agents/mpl-decomposer.md` Step 9.5 (HA-03 probing hints producer)
- **F-40 protocol**: `commands/mpl-run-execute.md:470-546` (mandatory-domain dispatch rules)
- **Related issues**: #19 AD-05 Hard 3 parameter-level verification (Option D dependency), #14 AD-01 Contract Coverage Mandatory (prerequisite for #19), #15 AD-02 Hard 3 Auto-Pass Removal (prerequisite for #19 execution)
- **Planned follow-ups**: Gate 1 experiment design (separate issue, not yet filed), HA-02 snippet extraction (audit §8.A #4, separate commit), Hard 3 retrospective measurement (audit §8.C #4)
