# Prompt → Gate → Restore 3-Layer Pattern Divergence Audit

**Date**: 2026-05-28
**Scope**: post-Exp22 follow-up cycle (PRs #226 / #227 / #228 / #229 / #231 merged)
**Trigger**: user audit request — "현재 구현체에서 내가 생각한 flow → 프롬프트 권고 / gate를 통한 체크 / 자동 restore와 어긋나는 부분"

## Intended 3-Layer Pattern

1. **Layer 1 — Prompt 권고**: `agents/*.md`, `commands/*.md`, `skills/*/SKILL.md` give agents instructions and MUST/SHOULD rules.
2. **Layer 2 — Gate 체크**: `hooks/*.mjs` mechanically enforce as PreToolUse / PostToolUse hooks; on violation emit `{ continue: false, decision: "block", reason }`.
3. **Layer 3 — 자동 Restore**: on a Layer-2 block, the hook records a `blocked_hook` envelope (`hooks/lib/mpl-blocked-hook.mjs::recordBlockedHook`) into `.mpl/state.json` with `block_code` / `blocked_artifact` / `resume_instruction` / `retry_context`. `skills/mpl-recover/SKILL.md` reads that envelope and dispatches the corrective agent.

A hook that emits a block without an envelope leaves the user staring at a wall with no recovery path. A `block_code` not in `mpl-recover`'s routing table falls through to `unsupported` — same outcome.

## Findings

### A. Layer-1-only rules (no Layer-2 gate)

Prompts assert MUSTs that no hook enforces. A drifted agent can violate them undetected.

| # | Rule | Where prompted | Why gate is missing | Sev |
|---|---|---|---|---|
| A1 | Orchestrator must NOT directly `Write/Edit .mpl/mpl/decomposition.yaml` | `commands/mpl-run-decompose.md:16, 24, 188` | `hooks/mpl-write-guard.mjs:54-62` explicitly *allows* `.mpl/` paths. Content gates only check `generated_by: mpl-decomposer` string presence — they don't verify the actual writer. | HIGH |
| A2 | HA-01: vague delegation prompts ("이전 결과 참고해서 구현해", "알아서 판단해") PROHIBITED | `commands/mpl-run.md:15-19` | No PreToolUse hook inspects Task tool prompts for these patterns. `grep "HA-01\|synthesis" hooks/` returns nothing outside hook-trace. | HIGH |
| A3 | `mpl-cancel` must NEVER `rm` under `.mpl/mpl/**`, `.mpl/contracts/*.json`, `docs/learnings/`, `.mpl/memory/` | `skills/mpl-cancel/SKILL.md:104, 108, 110, 113` | `hooks/mpl-write-guard.mjs:111` actively *allowlists* `rm -rf .mpl` as a "safe cleanup" pattern — the dangerous-bash check permits the exact destructive operation the skill forbids. | HIGH |
| A4 | `mpl-validate-output` is registered but advisory-only | `hooks/mpl-validate-output.mjs:95-110` | Hook emits `[VALIDATION FAILED]` as a `systemMessage` and never sets `decision: "block"`. Required-section checks are case-insensitive substring matches — a JSON-fence rule like "Final output MUST be valid JSON in ```json fences" (`agents/mpl-phase-runner.md:140`) is not enforced. | HIGH |
| A5 | e2e `test_command` must not be a placeholder like `TODO(integration-ci)` | `agents/mpl-decomposer.md:180-181` | `mpl-require-e2e.mjs` only checks non-null / non-empty; `mpl-require-e2e-authenticity.mjs` filters `MOCK_PATTERN` tokens but not `TODO(...)`. | MED |
| A6 | Probing hints MUST produce ≥1 adversarial test | `agents/mpl-test-agent.md:175-180` | `mpl-require-test-agent.mjs` passes hints into the dispatch brief but `lib/mpl-test-agent-evidence.mjs` does not check the resulting `test_files_created` references any hint. | MED |
| A7 | Seed Generator "No invention" — unknowns recorded as `ambiguity_notes`, not guessed | `agents/mpl-seed-generator.md:49` | `mpl-validate-seed.mjs` validates `todo_structure` fields but never checks `ambiguity_notes` presence/usage. Hallucinated `files_to_modify` paths are undetectable until phase execution fails. | MED |
| A8 | `mpl-test-agent.md` HA-02 BEGIN/END region must mirror to `prompts/modules/adversarial-verification-ha02.md` in the same commit | `agents/mpl-test-agent.md:181-183` | No pre-commit / hook compares the two regions. Pure social contract. | LOW |
| A9 | `mpl-phase-runner` Retry 2 must reflect prior failure into a "must not do" list | `agents/mpl-phase-runner.md:105` | `fix_loop_count` is tracked but retry prompt content not inspected. | LOW |
| A10 | Interviewer Hypothesis-as-Options + Contrast-Based comparison table | `agents/mpl-interviewer.md:57-58, 73-74, 171` | `mpl-validate-output.mjs:57-61` only checks for the literal strings `PP-`, `Priority Order`, `Interview Metadata` (substring, non-blocking). | LOW |

### B. Layer-2 blocks WITHOUT a Layer-3 envelope

Hooks call a hand-rolled `function block(reason) { console.log(JSON.stringify({continue:false, decision:"block", reason})); }` helper, bypassing `recordBlockedHook`. State.json's `blocked_by_hook` / `block_code` / `retry_context` are never populated, so `mpl-recover` has nothing to dispatch.

| Hook | Block path | Severity |
|---|---|---|
| `hooks/mpl-state-invariant.mjs:174-179` | I13 fast-track Phase 0 invariant — the only stopgap against direct state.json tampering and it leaves no recovery trail | CRITICAL |
| `hooks/mpl-write-guard.mjs:220-225, 259-265` | `direct_source_edit`, `phase_scope_violation` — the most-likely-tripped PreToolUse gates during normal work | HIGH |
| `hooks/mpl-require-test-agent-brief.mjs:51` | new in #226 — brief missing/invalid | HIGH |
| `hooks/mpl-require-phase-evidence.mjs:44` | phase evidence missing | HIGH |
| `hooks/mpl-require-finalize-artifacts.mjs:41` | finalize artifacts missing | HIGH |
| `hooks/mpl-require-completed-phase-immutability.mjs:41` | completed phase mutation | HIGH |
| `hooks/mpl-require-decomposition-delta.mjs:48` | decomposition delta missing | HIGH |
| `hooks/mpl-require-chain-assignment.mjs:44` | chain assignment missing | HIGH |
| `hooks/mpl-require-e2e.mjs:54` | e2e fields missing | HIGH |
| `hooks/mpl-require-e2e-authenticity.mjs:49` | e2e authenticity violation | HIGH |
| `hooks/mpl-require-whole-goal-closure.mjs:40` | whole-goal closure missing | HIGH |
| `hooks/mpl-validate-pp-schema.mjs:83` | pp schema violation | HIGH |
| `hooks/mpl-phase-controller.mjs:1130-1138` | small-plan / mvp_scope conflict | MED |
| `hooks/mpl-bash-timeout.mjs:74-79`, `hooks/mpl-fallback-grep.mjs:139-143` | bash timeout, Tier-1 anti-pattern | MED |

**Failure mode**: when one of these fires, `state.json` may even fail the `BLOCKED_HOOK_STALE` invariant because the envelope shape is partial (or absent). The user is told "blocked" with a reason string and no recovery handle.

### C. Layer-3 routing gap (envelope recorded but `mpl-recover` doesn't handle the code)

`hooks/lib/mpl-recover.mjs:20-28, 537-580` routes 5 code families. Several codes are correctly enveloped at emission but fall through to `unsupported`.

| Code | Emitted at | Routed in `mpl-recover.mjs`? |
|---|---|---|
| `covers_schema_violation` | `hooks/mpl-require-covers.mjs:235` | NO |
| `decomposition_derived_stale` | `hooks/mpl-decomposition-postprocess.mjs:51` | NO |
| `test_agent_briefs_write_failed` | `hooks/mpl-decomposition-postprocess.mjs:68` (new in #226) | NO |
| `goal_contract_invalid` | `hooks/mpl-require-goal-trace.mjs:106` | NO |
| `baseline_immutable` | `hooks/mpl-baseline-guard.mjs:118` | NO |
| `phase_runner_*` (anomaly type) | `hooks/mpl-gate-recorder.mjs:423` (new in #218) | NO |
| `phase_contract_graph_invalid` | `hooks/mpl-require-phase-contract-graph.mjs:199` | NO |

**Phantom codes** routed but never emitted:

- `goal_contract_hash_corrupt`, `goal_contract_hash_mismatch` — `mpl-recover.mjs:20-28` references these aliases; the live hook emits `goal_contract_baseline_corrupt` / `goal_contract_drift` only. Confusing for future hook authors reading recover.mjs as the canonical code list.

### D. Diagnostic gaps (Layer-3 trace coverage)

| Gap | Severity |
|---|---|
| `mpl-require-test-agent-brief` (new in #226) absent from `hooks/lib/mpl-hook-trace.mjs::PURPOSES` map — surfaces as default "registered hook" label, no domain context | MED |
| `hooks/lib/mpl-hook-trace.mjs:172` bidirectional `endsWith` artifact match — no slash-boundary check, `foo.yaml` matches `barfoo.yaml` | LOW |
| `pathCategory === 'state'` is computed but `shouldIncludeHook` doesn't differentiate it from `file` — diagnostic noise, not silent failure | LOW |

## Pattern Summary

- **A** (Layer 1 only): rules live in prompts; drifted agents can violate silently. ~10 rules.
- **B** (Layer 2, no Layer 3 envelope): 10+ hooks block without recording, leaving the user at a dead end.
- **C** (Layer 3 routing incomplete): 7+ block codes exist with proper envelopes but `mpl-recover` returns `unsupported`.
- **D** (Layer 3 diagnostic surface): trace tool's coverage drifted away from the new #226-era hooks.

The dominant divergence pattern is **layer-skip without notification**: a hook either bypasses Layer 3 (B), or Layer 3 doesn't know how to handle what Layer 2 emits (C). Both produce the same user-visible failure mode (wall with no recovery path), so they're effectively the same defect class.

## Audit method

Three parallel `general-purpose` agent reads on 2026-05-28 with grep + `Read` only (no edits), each scoped to one category. Findings cross-checked against `hooks/lib/mpl-recover.mjs:20-28, 537-580` (routing table), `hooks/lib/mpl-blocked-hook.mjs` (envelope shape), `hooks/lib/mpl-hook-trace.mjs::PURPOSES` (trace coverage), and `recordBlockedHook` call sites.

## Non-goals (deferred)

- Issue #232 (recorder semantic gaps: exit code vs leading command, strict/recorder allowlist divergence) is intentional design per PR #231 r5/r6 rebuttals — not in this audit.
- Issue #230 (canonical `failure_code` field) is a producer-side schema change — not in this audit.
- `mpl-validate-output` advisory→blocking conversion needs a separate design pass (false positives risk).
