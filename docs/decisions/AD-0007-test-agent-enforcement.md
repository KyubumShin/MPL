---
id: AD-0007
title: F-40 Test-Agent Enforcement — Structural Block on Missing Dispatch
status: accepted
date: 2026-04-19
related: ["AD-0003", "AD-0004", "AD-0006", "#44"]
---

## Context

ygg-exp11 (Opus 4.7, v0.14.1, 2026-04-17) produced 83 `mpl-phase-runner` dispatches across 7 segments but only **1** `mpl-test-agent` dispatch across 63 code-bearing phases (1.6% coverage). The single dispatch (Segment 2 phase-01) found **5 independent gaps** immediately — AD-0004's design rationale ("the test writer must not share assumptions with the implementer") is empirically valid when the dispatch actually happens.

The F-40 policy documented in `phase-decisions.md` triggered test-agent on:

- (a) `pass_rate < 100%`
- (b) algorithm/high-risk domain
- (c) DB schema change with invariant-probing value

All three conditions are structurally self-disabling:

- **(a)** `pass_rate` is the phase-runner's **self-test result**. Code author + self-test + self-report → always 100% → dispatch never fires.
- **(b)** phase-runner classifies its own domain — "this isn't high-risk" is an easy opt-out.
- **(c)** DB-schema-only trigger misses the vast majority of boundary-change phases.

Downstream consequences observed in exp11:

- E2E 42/80 committed as `TODO(segment-7-integration-ci)` skip stubs
- `D-15-1 last_backup_at refresh` reported "consumed" while actually unresolved
- Lint baseline 52 items reframed as "no-hardcoded-korean-strings" — actual cause was TS quality regressions the phase-runner didn't flag
- Common root: **code author was asked to verify and report on their own work**

AD-0006 (v0.15.0) introduced `state.test_agent_dispatched` as machine evidence but stopped at observation. v0.15.1 must add enforcement.

## Decision

### 1. Per-phase required field in decomposition

`agents/mpl-decomposer.md` output schema gains two REQUIRED fields on every phase:

```yaml
test_agent_required: boolean
test_agent_rationale: string
```

**Default policy (Decomposer prompt guidance)**:
- `true` for any phase that creates, modifies, or deletes code paths
- `false` only for: pure documentation edits; migration-script-only phases without new API; infra/config without runnable behaviour
- When `false`, rationale is REQUIRED and must explain why independent test authorship is unnecessary

### 2. Hook-enforced block (`hooks/mpl-require-test-agent.mjs`)

PostToolUse on `Task|Agent` with subagent_type `mpl-phase-runner`:

1. Extract phase id from the runner's prompt (regex `phase[-\s]?(\d+)`)
2. Read `.mpl/mpl/decomposition.yaml` for that phase's `test_agent_required`
3. Read `state.test_agent_dispatched[phase_id]` for dispatch evidence (populated by `mpl-gate-recorder.mjs` from AD-0006)
4. Read `.mpl/config/test-agent-override.json` for user-explicit bypasses
5. If `required (default true) AND not dispatched AND not overridden` → emit `{decision: "block", reason: ...}` with instruction to dispatch test-agent

**Default behaviour on missing field**: treat as **required**. The Decomposer must actively write `false` with a rationale to opt out; absence is not permission.

**Error safety**: any hook exception returns `{continue: true}` to prevent wedging the pipeline on hook bugs.

### 3. F-40 Zero-Test Block replacement

`commands/mpl-run-execute-gates.md` Hard 2 Zero-Test Block becomes field-driven:

```
required = decomposition.phases.filter(p => p.test_agent_required != false)
missing = required.filter(p => not dispatched[p.id] and not overridden[p.id])
if missing.length > 0:
  Hard 2 = FAIL
  force dispatch test-agent for each missing phase
  re-run Hard 2
```

Legacy `phase_domain ∈ {ui, api, algorithm, db, ai}` trigger remains as a fallback for pre-v0.15.1 decompositions without the new field.

### 4. Override config

`.mpl/config/test-agent-override.json` (separate file — deliberately visible):

```json
{
  "phase-3": "trivial doc edit — no runtime surface",
  "phase-5": "manual QA completed 2026-04-20 by kbshin"
}
```

- Each override requires a non-empty user-supplied reason string
- Blanket key `"*"` allowed but flagged by `mpl-doctor audit [g]` as anti-pattern
- Override path deliberately inside `.mpl/config/` subdirectory (not `.mpl/config.json`) so it shows up in git status as a distinct file

## Alternatives Considered

### A: Prompt-only enforcement (Anti-rationalization in F-40 block)
v0.15.0 added this already. exp11 demonstrates prompt guardrails alone are insufficient — 4.7 still skipped 62/63 code phases. Hook enforcement required. **Kept as complementary layer, not standalone.**

### B: Phase-runner loses Write access to test files
`mpl-phase-runner.md` `disallowedTools` additions or prompt change. **Rejected for this release**: Opus 4.7 rationalizes around restrictions ("I'll write the test inline in the implementation file"). Needs schema-level enforcement in a later release; AD-0007 hook is stronger because it cannot be rationalized away.

### C: Sentinel-only (warning, not block)
Post-run advisory. **Rejected**: exp11 shows warnings are ignored at 63/63 rate. Structural block is the minimum sufficient intervention.

### D: Cost-gated dispatch (skip test-agent when budget low)
Token budget trigger. **Rejected as default**: quality > efficiency (MPL invariant, `feedback_quality-over-speed.md`). Budget pressure should cause `paused_budget` session handoff (F-33), not test-agent skip. Override config serves as per-phase escape hatch for genuine low-risk cases.

## Cost Impact (exp11-measured)

- 1 test-agent dispatch ≈ 70K tokens (Segment 2 phase-01 measured)
- If exp11 had enforced AD-0007 on 63 code phases: ≈ 4.4M additional tokens
- exp11 total orchestrator tokens ≈ 3.6M → +122% with full enforcement

Mitigations:
- Decomposer marks trivial/migration phases `false` with rationale (reduces count)
- `.mpl/config/test-agent-override.json` for user-verified bypasses
- Test-agent uses sonnet (`agents/mpl-test-agent.md:4` — `model: sonnet`), so per-phase cost is proportionally lower than opus phase-runner dispatches

Cost-quality trade-off accepted. MPL's invariant prioritises quality; exp11's 42/80 E2E skip and `D-15-1` false-resolved incidents show the cost of skipping is higher than the cost of dispatching.

## Success Criteria (exp12 baseline)

When the next experiment runs with v0.15.1 against the exp10/exp11 spec:

| Check | Target | Doctor category |
|---|---|---|
| Code-bearing phases with `test_agent_required: true` | ≥80% (rest must have explicit false + rationale) | audit `[g]` |
| Required phases with matching `test_agent_dispatched` entry | 100% unless override present | audit `[g]` |
| `"*"` blanket override usage | 0 | audit `[g]` warning |
| Zero-Test Block re-dispatches during Hard 2 | 0 (hook should prevent prior to reaching Hard 2) | logs |
| Bypass reasons averaging `< 20 chars` (e.g., "trivial") | 0 | audit warning |

## Rollback

If exp12 shows:
- Token cost >150% of exp11 AND test-agent findings <5% of dispatches (poor ROI)
  → revert to AD-0006 observability-only; keep field in schema for future re-enable
- Hook false-positive rate >10% (blocking legitimate phase-runner completions)
  → widen override semantics or introduce auto-override for phases with zero impact files

## Evidence Sources

- ygg-exp11 profile: `~/playground/ygg-exp11/.mpl/mpl/profile/phases.jsonl` (83 phase-runner, 1 test-agent)
- exp11 evaluation: `~/project/harness_lab/analysis/mpl-exp11-opus47-evaluation.md`
- exp11 code issues addendum: `~/project/harness_lab/analysis/mpl-exp11-code-issues-addendum.md`
- Design discussion: `~/project/wiki/scratch/2026-04-19/mpl-test-agent-enforcement.md`
