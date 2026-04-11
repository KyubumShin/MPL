---
id: AD-0002
title: CB cross-boundary features are bound to the cb-testbed ablation experiment
status: accepted
date: 2026-04-12
related: ["#13", "#19", "AD-0001", "AD-0003"]
---

## Context

Between 2026-03 and 2026-04, MPL accumulated a Cross-Boundary (CB) feature family targeting the class of defects that show up when two workers build opposite sides of an interface in parallel (method name mismatches, parameter omissions, schema field gaps). The family was planned as CB-01 through CB-08, with CB-02, CB-03, and CB-04 embedded in agent prompt text inside `agents/mpl-verification-planner.md` and pre-v0.11.0 gate protocols.

When the v2 consolidation (v0.11.0, commit `696bb42`, 2026-03-31) cut agent count from 16 → 8, and the v2 completion pass (v0.12.1, commit `a60320e`, 2026-04-05) deleted 7 agent files including `mpl-verification-planner`, CB-02 / CB-03 / CB-04 evaporated along with the host agent files. The consolidation decision doc (`wiki/pages/decisions/agent-consolidation-16-to-8.md`, dated 2026-04-05) was **pre-experimental** — it was grounded in the intuition *"에이전트 수가 많다고 품질이 올라가지 않는다"* (more agents does not imply higher quality) rather than in measured defect data.

Between 2026-04-09 and 2026-04-10 — **after** the consolidation decision, but before this ADR — the `cb-testbed` ablation experiment produced empirical data that changes how CB-02/03/04 restoration should be decided. The 2026-04-11 session audit initially framed CB-02/03/04 as "regret the consolidation, restore them via structured debate." The user corrected:

> cb-testbed 쪽이 오히려 실제 실험을 통하여 직접적으로 증명한 케이스여서 이부분이 훨씬 좋을것 같은데

The experiment gives definitive answers to questions the debate would only produce plausible arguments about. This ADR ratifies the rule *experiment beats debate when both exist*, applies the cb-testbed Phase A1 data to each CB-family restoration candidate, and explicitly names which CB restorations are **not** debatable going forward.

### The cb-testbed Phase A1 experiment

**Design** (source: `~/project/harness_lab/analysis/cb-phase-a1-n3-report.md`, 272 lines; spec: `~/project/harness_lab/analysis/cb-testbed-spec-v1.md`, 270 lines):

A 2³ = 8 cell ablation over three mechanisms, each as an on/off binary:

```
M1  Independent context   (OFF = single worker writes both sides,
                           ON  = two workers, separate sessions)
M2  Contract presence     (OFF = contract.md absent,
                           ON  = contract provided to both sides)
M3  Real IPC test         (OFF = mock-only tests,
                           ON  = real subprocess integration tests)
```

Per-cell `n = 3` baseline run, with `n = 5` top-up runs on leaky cells. Total ~29 runs. Pre-registered Phase B trigger rule: *if the best cell has ≥1 defect after Phase A, trigger a Phase B ablation on candidates 4/5/6 (context isolation strength / contract format / Quality Gate cross-layer verification).*

The three candidates were defined in `~/project/decision/2026-04-08-cb-mechanism-6to3-reduction.md`, which converged 3-to-0 on reducing the candidate set from 6 to 3 with explicit Phase A/B split and a pre-registration rule.

**Main effects** (from the Phase A1 report §4):

```
M2 (contract presence):  Δ = -2.17   ← DOMINANT defense
M1 (independent ctx):    Δ = -0.17   ← narrow, only affects D1 method name
M3 (real IPC test):      Δ = -0.17   ← inconclusive (macOS timeout bug affected some cells)
```

**Per-defect breakdown**:

| Defect | Layer | Behavior | Test detection (C1/C2/C3) |
|--------|-------|----------|---------------------------|
| D1 method name mismatch   | L1 protocol   | 100% occurrence in M1=0 M2=0 cells; 0% in any cell with M1=1 OR M2=1 | **C1 = 6/6** (tests catch all L1) |
| D2 api_key omission       | L2 parameter  | 100% in M2=0; 0/6 in M2=ON M1=0; **3/8 (37.5%)** in M2=ON M1=1 | **C2 = 0/15** (tests never catch L2) |
| D3 order field omission   | L3 schema     | Consistent in M2=0; leaks in M1=1 M2=ON cells | **C3 = 0/13** (tests never catch L3) |

**Structural finding (report §5)**: tests are *mathematically* blind to L2 and L3 defects. A test written to verify L1 protocol correctness does not exercise the parameter space, so it cannot detect L2 omissions. To catch L2/L3 defects without a contract, the tests would have to adversarially target each parameter — which is exactly the role HA-03 Probing Hints was designed for. L2 and L3 cannot be closed by more tests of the same shape; they require either a contract (M2) or structural adversarial probing (HA-02/HA-03).

**The 37% residual leak** (report §5.5): single worker writing both sides of a boundary, even with a contract present, drops L2 parameters ~37% of the time. Hypothesized mechanism: the single worker assumes "the other side already handles it" because context is shared. Contract presence alone has a ceiling.

**Phase B trigger result**: **FALSE**. The best cell (010 or 011) achieved 0 defects across n=3, which does not meet the pre-registered `best cell ≥1 defect` threshold. By the pre-registration rule, Phase B on candidates 4/5/6 does **not** run. This is a load-bearing experimental conclusion — not a soft recommendation.

### What this means for CB-02/03/04 restoration

Each candidate was originally proposed in pre-v0.11.0 design as a specific defense mechanism. The Phase A1 data measures the main effect strength of the underlying mechanism and the defect class it targets. The result: most CB-02/03/04 candidates have **weaker** empirical support than the consolidation decision assumed, not stronger.

## Decision

**Future discussion of CB-family feature restoration is bound to the cb-testbed experimental evidence.** The Phase A1 report's findings are authoritative; debate-based restoration arguments that ignore the data are rejected. Specifically:

1. **CB-02 (Rule 9b boundary-aware grouping, addresses M1)**: **Do not restore.** M1's main effect (Δ = -0.17) is weak, and M1 only narrows D1 method-name mismatches, which tests already catch at C1 = 100%. The complexity cost of reinstating the boundary-aware grouping rule in the Decomposer is not justified by the measured benefit.

2. **CB-03 (Gate 0.7 cross-boundary advisory, addresses candidate 6)**: **Do not restore.** Phase B trigger = FALSE. The 37% residual D2 leak at M1=1 M2=ON is real but is better addressed by **#19 AD-05 Hard 3 parameter-level verification** at the mechanical blocking layer than by an advisory non-blocking PP-gated gate. This is the empirical replacement relationship: AD-05 (mechanical, every-phase, blocking) absorbs the defense goal that CB-03 (advisory, PP-gated, non-blocking) was originally designed for.

3. **CB-04 (Mock Boundary Gap / verification_gaps, addresses M3)**: **Defer restoration pending M3 re-measurement.** The macOS `timeout` command bug affected some cells, leaving the M3 main effect partially unmeasured. A targeted re-run after `gtimeout` installation could change the M3 conclusion meaningfully. Until that data exists, CB-04 restoration has no decisive empirical support or rejection.

4. **#19 AD-05 Hard 3 parameter-level verification (priority ELEVATED)**: the 37% D2 leak residual at M1=1 M2=ON is precisely the failure class AD-05 is designed to close. Per the priority elevation recorded on `#19` (body updated 2026-04-12), AD-05 moves from `v0.13.0 proposed` to **critical v0.13.0 target**, ranked above AD-01 (#14) and AD-02 (#15) in empirical urgency — while AD-01/AD-02 remain strict prerequisites for AD-05 to execute against.

5. **HA-02 / HA-03 restoration is separately empirically motivated.** C2 = 0 and C3 = 0 establish that L2/L3 defects cannot be caught by additional tests written by the implementer alone. Adversarial prompts (HA-02) and probing hints (HA-03) are the only MPL mechanism that structurally targets the L2/L3 blind spot. Their restoration remains valid and empirically grounded — but the *architectural shape* of the restoration (separate agent / inline role / redesign) is a separate decision tracked in AD-0003 and deferred to the reconciliation audit.

6. **The "Advisory Gate as observation layer" direction (#13, #20) is rejected on the same experimental grounds.** The Phase B trigger = FALSE result removes the empirical case for advisory-layer defenses against L2/L3, and the 37% residual is an indication that the *right* layer for the remaining work is Hard 3 (mechanical, blocking), not advisory (non-blocking, PP-gated). #13 resolved to Option B on 2026-04-11, and #20 was closed as `won't-fix` the same day. This ADR ratifies both.

7. **Candidate 5 (contract format rigor) is a separate open question.** The 6→3 reduction doc deferred this to a potential Phase B. Phase B did not trigger, so candidate 5 has no current experimental data. If MPL wants to investigate contract format as a separate defense layer, it must design a new targeted experiment — it does not inherit from Phase A1 automatically.

## Alternatives Considered

### Structured 3-agent debate to decide CB-02/03/04 restoration ("D3 debate")

**Rejected because**: an experiment already answered the questions the debate would argue about. The session's first instinct was to run a Pro/Con/Mutant debate over each CB candidate, following the pattern established for AD-0001 (Advisor Tool rejection). That was sensible when there was no experimental data. It became wrong the moment the Phase A1 report was on disk. Debates produce plausible arguments; experiments produce facts; when both exist, facts win. Re-running the debate now would risk overriding a definitive answer with a well-reasoned conjecture.

This ADR codifies the rule: **for CB-family feature decisions, if `~/project/harness_lab/analysis/cb-phase-a1-n3-report.md` or a successor Phase report speaks, that data is the authority. No CB-family restoration debate is valid without either (a) citing the relevant experimental evidence or (b) designing a new experiment that would generate it.**

### Restore all CB-02/03/04 to pre-consolidation shape

**Rejected because**: the experiment shows that M1 main effect (the mechanism CB-02 targeted) is weak, and the Phase B trigger for candidate 6 (the mechanism CB-03 targeted) was FALSE. Restoring defenses for a defect class the data says is already addressed — or for a candidate the pre-registration rule rejected — adds complexity without empirical benefit. The restoration request implicitly assumes the consolidation was wrong; the experiment only partially supports that view (for HA-02/HA-03, yes; for CB-02/03/04, no).

### Accept the v0.12.1 consolidation as final and never restore any CB features

**Rejected because**: the experiment also shows that the L2/L3 blindness is structural, which the consolidation decision could not have known. Some restoration is empirically warranted — specifically, HA-02 and HA-03 as structural defenses against L2/L3 blindness, and AD-05 as the mechanical Hard 3 complement. Treating the consolidation as untouchable would block empirically-grounded improvements.

### Defer everything until Phase B pilot runs

**Rejected because**: Phase B pre-registration explicitly says Phase B runs **iff** the best cell has ≥1 defect. Best cell had 0 defects. The trigger did not fire. Running Phase B anyway would violate the pre-registration — the entire point of pre-registration is to prevent post-hoc goal-shifting. If MPL wants new data, it must design a new experiment targeting a different question (e.g. candidate 5 contract format), not re-purpose Phase B.

## Consequences

### Bound

- **CB-02, CB-03, CB-04 restoration is closed as a topic** for as long as the Phase A1 report is the authoritative data source. Reopening requires new experimental data.
- **The Advisory Gate feedback-loop direction (AD-06, #20)** is rejected alongside CB-03 on the same empirical grounds.
- **The consolidation decision doc (`wiki/pages/decisions/agent-consolidation-16-to-8.md`) is not retroactively invalidated.** The consolidation was pre-experimental and reasonable at the time. The experiment did not overturn it wholesale — it overturned specific subclaims (specifically the claim that "fewer agents ≈ simpler ≈ sufficient" can close L2/L3 defects).

### Prioritized

- **#19 AD-05 Hard 3 parameter-level verification is the first v0.13.0 target** empirically. AD-01 (#14) and AD-02 (#15) remain strict prerequisites — without mandatory contract files, there is nothing to verify against; without auto-pass removal, new verification logic does not run. But among *new defense work*, AD-05 takes ranking priority.
- **HA-02 / HA-03 restoration is empirically motivated** and should proceed once the architectural path is chosen in the reconciliation audit. The audit decides *how* (separate agent vs inline vs redesign); this ADR + AD-0003 establish *why*.

### Pending new data

- **CB-04 restoration is blocked on M3 re-measurement.** When a re-run after `gtimeout` installation produces a clean M3 effect, this ADR's §Decision item 3 should be revisited as an addendum or superseding ADR. Until then, no restoration action.
- **Candidate 5 (contract format rigor)** has no current experimental basis. If a new targeted experiment is designed, the relevant design doc should reference this ADR as the "why we did not rely on Phase B inheritance" record.

### Not solving

- The long-term architectural shape of MPL's adversarial verification layer. That is tracked in AD-0003 + the reconciliation audit §6.
- The PR-02/03/04 restoration deadlock — those are a different feature family with a different experimental status (no cb-testbed mapping exists for security pattern grep, UI hardcoding, or resource lifecycle pair checks). Tracked as a separate future ADR (AD-0004 reserved).

### Operational notes

- `docs/roadmap/overview.md` entries for CB-02/03/04 should be updated (in a follow-up commit) to point at this ADR instead of claiming "proposed" status.
- `docs/roadmap/pending-features.md` CB-02/03/04 blocks should be marked as `[REJECTED — AD-0002]` rather than deleted, to preserve the historical record.
- New Phase reports added to `~/project/harness_lab/analysis/` that update Phase A1 conclusions should trigger a superseding ADR rather than a silent edit to this one.

## References

- **Phase A1 report**: `~/project/harness_lab/analysis/cb-phase-a1-n3-report.md` (272 lines, 2026-04-10) — M2 dominance, 37% leak, L1/L2/L3 hierarchy, Phase B trigger = FALSE
- **cb-testbed spec**: `~/project/harness_lab/analysis/cb-testbed-spec-v1.md` (270 lines) — M1/M2/M3 definitions, Phase A/A2 separation, pre-registration rule
- **6→3 reduction decision**: `~/project/decision/2026-04-08-cb-mechanism-6to3-reduction.md` — 3-to-0 convergence, candidate definitions, Phase A/B split
- **2026-04-11 CB data advisor revisit**: `~/project/decision/2026-04-11-cb-data-advisor-revisit.md`
- **Consolidation decision (pre-experimental)**: `wiki/pages/decisions/agent-consolidation-16-to-8.md` (2026-04-05) — written 4 days before Phase A1 ran
- **Session resume doc**: `~/project/wiki/scratch/2026-04-11/mpl-session-resume.md` §0 (North Star), §5 (experiment summary), §11 (restore decision matrix)
- **Related ADRs**: `AD-0001` (Advisor Tool rejection — shares the "structural failure, not advisory failure" framing), `AD-0003` (v0.12.2 accidental agent deletion — splits file-level restoration from architectural path decision)
- **Related issues**: #13 (Advisory Gate policy, closed Option B), #19 (AD-05 Hard 3 parameter-level verification, priority elevated), #20 (AD-06 feedback loop, closed won't-fix), #14 (AD-01 Contract Coverage), #15 (AD-02 Hard 3 Auto-Pass Removal), #25 (Advisory Gate vestigial cleanup tracker)
- **Planned experiment**: M3 re-measurement after `gtimeout` fix — will inform CB-04 restoration decision and potentially supersede §Decision item 3 of this ADR
