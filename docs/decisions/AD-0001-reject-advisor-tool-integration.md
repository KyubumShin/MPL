---
id: AD-0001
title: Reject Anthropic Advisor Tool integration in MPL
status: accepted
date: 2026-04-11
related: ["#14", "#15"]
---

## Context

Anthropic released the Advisor Tool beta (`advisor-tool-2026-03-01`), which lets a running agent delegate a sub-question to a fresh Claude session and receive a bounded opinion back. The MPL team evaluated whether to integrate it at one of several plausible injection points (Phase Runner, Decomposer, Fix Loop, Advisory Gate, as a consultable Team orchestrator) as a way to improve MPL's self-evaluation weakness — specifically the pattern surfaced in CB ablation experiments where the runner fails to detect its own incomplete implementations (exp5 B-1~B-3; CB Phase A1 D2 = 0/15, D3 = 0/13 missed detections).

The review ran six structured Pro/Con/Mutant debates (three agents arguing via SendMessage, orchestrator mediating) over 2026-04-10 ~ 2026-04-11 and combined them with re-analysis of the CB experiment data. The debates treated each plausible injection point as a separate question with its own pro and con arguments.

**Inputs to this decision**:
- Advisor Tool beta spec (Anthropic, 2026-03-01)
- CB Phase A1 ablation data (n = 3 + 5)
- Six debate transcripts in `wiki/scratch/2026-04-10/advisor-tool-mpl-integration-review.md`
- Per-debate decision notes in `decision/2026-04-10-advisor-tool-*.md` and `decision/2026-04-11-cb-data-advisor-revisit.md`

## Decision

**MPL will not integrate the Anthropic Advisor Tool at any injection point.** Instead, the underlying weakness that motivated the review — missed self-detection of incomplete implementations — will be addressed by strengthening existing MPL mechanisms: contract coverage enforcement, reflection-tag harvesting into the learning loop, L1 sentinel extensions for PP-file detection, and Hard 3 parameter-level verification.

This decision is accepted regardless of how individual follow-up issues (AD-01 through AD-08, SP-0, SP-01) progress — even if none of them land, the Advisor Tool is still rejected. The follow-ups are the *positive* answer to "what should MPL do instead," but the *negative* answer ("don't add an advisor") stands on its own.

## Alternatives Considered

Six concrete integration proposals were debated. Each is listed with its proposer framing, the core objection that rejected it, and the debate ID for cross-reference.

### S1 — Phase Runner with internal Advisor calls

**Proposal**: During phase execution, the Runner consults Advisor on every non-trivial decision (strategy, risk, next step).

**Rejected because**: Fresh Advisor sessions see none of the Runner's transcript, can't call project tools, and can't read state.json. The advisor becomes a blind consultant handing back generic advice. The CB failure mode is *structural* (contract missing → hard gate silent), not *advisory* (runner making a bad call with good information). An advisor won't see a contract that isn't generated.

**Counter-path**: Keep Opus at the Orchestrator layer, where it already has the full session transcript. Invest in Decomposer quality (contract generation, boundary enumeration) rather than mid-flight consultations. This is tracked as issues #14 (AD-01), #15 (AD-02), and the eventual AD-05 Hard 3 parameter-level expansion.

### S2 — Advisory Gate as in-flight consultation

**Proposal**: Convert the currently post-hoc Advisory Gate (Step 4.8) into an in-flight consultation that runs during phase execution, not after.

**Rejected because**: The Advisory Gate's value is *observational*, not *directive*. Its job is to record what happened and feed the pattern back into next-run memory, not to block or redirect mid-execution. In-flight redirection conflicts with the functional isolation that gives micro-phases their value (a phase is supposed to be small enough to run to completion or fail cleanly).

**Counter-path**: Redefine Advisory Gate as "Observation Gate". Keep it post-hoc. Build a feedback loop that routes its output through Adaptive Memory → next run's Phase 0 → Seed generation. This is tracked as AD-06 in the follow-up queue.

### S3 — Decomposer lightweight Sonnet + Advisor

**Proposal**: Drop Decomposer to Sonnet to save cost; compensate for reduced planning quality by calling Advisor on each phase boundary decision.

**Rejected because**: Plans are investment, not overhead. A bad plan's blast radius covers every phase that follows; a good plan's cost amortizes across the whole run. Decomposer runs **once per pipeline**, so the cost difference between Sonnet+advisor and Opus-direct is dominated by the advisor calls themselves. The trade is "pay less now, pay much more on fix-loops from under-planned phases."

**Counter-path**: Keep Decomposer on Opus. If cost matters, find savings in high-frequency paths (Phase Runner, inline tool calls) — not in the single planning step.

### S4 — Fix Loop internal Advisor

**Proposal**: On each fix-loop attempt, before the Runner retries, query Advisor for "what's a different approach to try here."

**Rejected because**: Advisor sessions cannot read the project, can't see the prior attempt's diff, and can't run the failing test. They would be diagnosing blindly from whatever the Runner chose to include in the prompt — which is exactly the information the Runner already has. This is a $0 plumbing job masquerading as a feature: the fix-loop does not *lack* information, it lacks a **strategy generator** that connects prior reflections to next attempts.

**Counter-path**: The Orchestrator already has prior reflections + phase0 artifacts. Wire them into the Runner's retry prompt with an explicit "must-not-do list" and alternative-approach suggestion derived from the reflection pattern tags. This is tracked as AD-07 in the follow-up queue.

### S5 — Team-based Consultable Orchestrator

**Proposal**: Spawn an advisor as a long-lived teammate (via Claude Code's Team feature) that the Orchestrator can consult via SendMessage at any decision point.

**Rejected because**: Each consultation adds a round-trip latency cost, a context-management cost (both sides have to stay synchronized), and a mental-model cost (contributors now have to reason about multi-agent failure modes). The real pain point — "a phase that was decomposed wrong stays wrong" — is addressed *before* the Orchestrator runs, in Decomposer. A consultant bolted onto a bad plan doesn't fix the plan.

**Counter-path**: Use a lightweight L1 hook (PostToolUse on Edit|Write) that mechanically flags PP-file modifications without adding a consultation pattern. This is tracked as AD-04 in the follow-up queue.

### S6 — Advisor for L2/L3 defense layers

**Proposal**: Use Advisor as the L2/L3 defense in depth, catching what L1 hooks and Hard 3 miss.

**Rejected because**: Re-analysis of the CB data showed the failures were *not* cases where Hard 3 ran and missed the defect. They were cases where Hard 3 **auto-passed** because the phase's `contracts/` directory was absent, so there was nothing to verify. Adding a defense layer above Hard 3 doesn't help if Hard 3 itself never gets invoked. The fix is to make contracts mandatory (so Hard 3 always runs with something to check), not to add a new layer that runs after it.

**Counter-path**: Contract coverage mandatory (AD-01 → issue #14), Hard 3 auto-pass removal (AD-02 → issue #15), Hard 3 parameter-level expansion (AD-05, future issue).

## Consequences

**What changes because of this decision**:

- MPL will not add a dependency on the `advisor-tool-2026-03-01` beta API. The plugin manifest, hook tree, and agent list remain unchanged on this front.
- The Advisor Tool is removed from consideration as a response to future "self-detection failure" reports. If such a report arrives, the default response is "is this a contract coverage / Hard 3 scope problem?" before considering any external consultation pattern.
- The six rejected injection points are **documented failures** — future contributors proposing any of them should be pointed at this ADR and the corresponding debate section. Re-opening requires new evidence that invalidates the specific objection cited above, not just a new framing.

**What this decision does not solve**:

- The underlying "runner cannot detect its own incomplete implementations" weakness. This ADR only rules out *one* class of solution (external advisor consultation). The positive response is a basket of MPL-internal strengthenings tracked as issues #14, #15, and the remaining AD-03 through AD-08 + SP-0 + SP-01 items still in `pending-features.md`.
- Observer infrastructure for the Advisory Gate. The gate is currently half-wired (see issue #13) — this ADR notes that S2 concluded "observation gate, post-hoc feedback loop via memory" but #13 is the actual decision point on whether to complete or remove it.

**Operational implications**:

- No new runtime dependency, no new MCP server config, no Advisor API key management burden.
- No additional token cost for advisor consultations (which would have compounded across every fix-loop attempt at the worst-case injection point in S4).
- Commit this ADR before landing any of the follow-up issues so the "why not advisor" context is a grep away when implementation questions come up.

## References

- Debate transcripts: `wiki/scratch/2026-04-10/advisor-tool-mpl-integration-review.md`
- Per-debate notes: `decision/2026-04-10-advisor-tool-*.md`
- CB revisit: `decision/2026-04-11-cb-data-advisor-revisit.md`
- Follow-up implementation issues: #14 (AD-01 Contract Coverage Mandatory), #15 (AD-02 Hard 3 Auto-Pass Removal)
- Remaining follow-ups still in `pending-features.md`: AD-03 Reflection Tag Harvest, AD-04 L1 Hook PP detection, AD-05 Hard 3 Parameter Verification, AD-06 Advisory → Memory → Seed, AD-07 Fix Loop Strategy Gap, AD-08 Phase Runner Sonnet Unification, SP-0 specpill Stage 2 Integration, SP-01 Spec → Contract Auto Derivation
- Related policy issue: #13 (Advisory Gate completion or removal)
- CB experiment source data: exp5 B-1~B-3, CB Phase A1 D2/D3 detection rates
