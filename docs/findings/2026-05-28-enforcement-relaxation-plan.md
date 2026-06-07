# Enforcement Relaxation Plan

**Date**: 2026-05-28
**Source**: companion to `docs/findings/2026-05-28-prompt-gate-restore-divergence.md`
**Context**: user request — "모든 케이스를 hook으로 차단하면 너무 경직되니, 완화할 수 있는 부분 검토"

## Existing relaxation infrastructure

Already in place (v0.18.0 / issue #110):

- `hooks/lib/mpl-config.mjs::ENFORCEMENT_DEFAULTS` — per-rule policy table with `warn` / `block` / `off`. All 8 currently-defined rules ship at `warn` by default.
- `strict: false` global elevation switch — when `true`, every per-rule `warn` elevates to `block`.
- Per-hook boolean toggles (e.g. `phase_evidence_latch_required: false`) for full opt-out.
- Per-hook dedicated config files (e.g. `.mpl/config/test-agent-brief-enforcement.json` from #225) for hook-specific mode.
- Telemetry-only path: `continue: true, systemMessage: "..."` surfaces a diagnostic without blocking.

**The relaxation lever is not missing — it's just not wired up everywhere.** Most B-category hooks (bare `block(reason)` without envelope, no config consultation) bypass the system entirely.

## Three relaxation tiers

| Tier | When to apply | Mechanism |
|---|---|---|
| **block** | invariant violations that corrupt state or skip evidence — recovery without intervention is impossible | `decision: "block"` + `recordBlockedHook` envelope + `mpl-recover` routing |
| **warn** | rule violation that the user should see but doesn't corrupt state — pipeline can continue, fix is deferred | `continue: true, systemMessage: "..."` + (optional) telemetry record |
| **telemetry** | drift signal worth measuring across runs, no immediate user action — e.g. coordination quality | append to a learning log file, no surface | 

## Relaxation evaluation per finding

Re-evaluating each finding from the divergence audit. **Default: warn.** Block only where state corruption / unrecoverable evidence loss is at stake. Telemetry where the rule is about coordination drift rather than artifact correctness.

### A. Layer-1-only rules

| # | Rule | Recommended tier | Reasoning |
|---|---|---|---|
| A1 | Orchestrator must NOT Write/Edit `decomposition.yaml` | **block** | Direct violation corrupts the only source of phase truth. write-guard should detect Write/Edit on `decomposition.yaml` from any non-`mpl-decomposer` agent. |
| A2 | HA-01 vague delegation prompt | **warn** | Pattern-matching Task prompts ("이전 결과 참고해서", "알아서") is heuristic — false positives possible. Surface as systemMessage with the matched phrase so operator can confirm or override. NOT block; soft signal first. |
| A3 | `mpl-cancel` must not `rm .mpl/mpl/**` etc. | **block** | Destructive operation on protected paths is irreversible. Promote from current allowlist behavior to per-path blocklist with explicit override flag. |
| A4 | `mpl-validate-output` JSON-fence rule | **warn** | Already advisory by design. The risk of breaking legitimate output formats (especially `mpl-interviewer` natural-language responses) is real. Stay at warn; add structured telemetry so violation rate is measurable. |
| A5 | `test_command: "TODO(integration-ci)"` placeholder | **warn** → **block on finalize** | Block only at finalize trigger when other Phase 0 artifacts are present. Early decomposition can ship with placeholders during iteration; finalize must not. |
| A6 | Probing hints → ≥1 adversarial test | **warn** | Mapping hint → test is heuristic; a single high-quality test may cover multiple hints. Warn first; block only if zero tests reference any hint. |
| A7 | Seed Generator "No invention" / `ambiguity_notes` | **warn** | Validation is "did the agent use the escape hatch when uncertain", inherently judgement-based. Warn surfaces; block here would mass-fire on benign cases. |
| A8 | HA-02 BEGIN/END region mirror | **telemetry** | Pure development-time discipline. Could be a pre-commit lint, but a runtime hook adds cost and rarely triggers. Telemetry: log when the two files' regions diverge so reviewers see it. |
| A9 | Retry 2 "must not do" reflection | **telemetry** | Coordination quality, not correctness. Log presence/absence; surface in mpl-doctor summary. |
| A10 | Interviewer comparison table | **warn** | Already substring-checked at advisory level. Quality concern, not state-corruption. Stay warn. |

### B. Layer-2 blocks without Layer-3 envelope

For each, the fix is to call `recordBlockedHook` so `mpl-recover` can dispatch. But the level of THAT block can vary:

| Hook | Recommended tier | Note |
|---|---|---|
| `mpl-state-invariant.mjs:174-179` (I13 fast-track Phase 0) | **block** with envelope | The single stopgap against direct state.json tampering — must stay block, must add envelope. |
| `mpl-write-guard.mjs:220-225, 259-265` (`direct_source_edit`, `phase_scope_violation`) | **honor enforcement config** | These already have `ENFORCEMENT_DEFAULTS` entries at `warn`. The current bare `block` ignores the config and over-enforces. Fix: respect the policy. Default warn, escalate to block via `strict: true` or per-rule override. |
| `mpl-require-test-agent-brief.mjs:51` | **mode already exists** (warn/block/off via own config) — add envelope on block path | The hook resolves enforcement mode but the block path doesn't envelope. Connect to `recordBlockedHook`. |
| `mpl-require-phase-evidence.mjs:44`, `mpl-require-finalize-artifacts.mjs:41`, `mpl-require-completed-phase-immutability.mjs:41`, `mpl-require-whole-goal-closure.mjs:40` | **block** with envelope | These guard finalize-time evidence — state corruption if bypassed. Stay block, add envelope. |
| `mpl-require-decomposition-delta.mjs:48`, `mpl-require-chain-assignment.mjs:44`, `mpl-require-phase-contract-graph.mjs` | **block** with envelope | Decomposition completeness — must block on missing structure. |
| `mpl-require-e2e.mjs:54`, `mpl-require-e2e-authenticity.mjs:49` | **honor enforcement config** | Already opt-out toggles exist (`e2e_authenticity_required: true`). Default block stays appropriate but make it config-driven. |
| `mpl-validate-pp-schema.mjs:83` | **warn → block on finalize** | Schema validation can have transient drift during iteration; block only when persisting. |
| `mpl-phase-controller.mjs:1130-1138` (small-plan / mvp_scope conflict) | **block** | Pipeline-mode conflict — must resolve before continuing. Stay block, add envelope explaining the two paths. |
| `mpl-bash-timeout.mjs:74-79`, `mpl-fallback-grep.mjs:139-143` | **already config-driven** (timeout/anti-pattern in defaults at `warn`) — fix: respect config | Currently bypasses its own config. Wire to ENFORCEMENT_DEFAULTS. |

### C. Layer-3 routing gap

Each unrouted code below should get a `mpl-recover` handler. Severity is the *severity of the dead-end*, not the rule:

| Code | Routing recommendation |
|---|---|
| `decomposition_derived_stale`, `test_agent_briefs_write_failed` | Common handler: re-run the mechanical postprocess (`writeDerivedDecompositionFields` / `writeTestAgentBriefs`) since both are deterministic regenerations. Recover should be auto-fix, not agent-dispatch. |
| `phase_runner_*` (anomaly types) | Per-anomaly type handler. Empty response → re-dispatch with stronger framing. Truncated → re-dispatch with shorter context. Etc. Each anomaly type already has a recovery template in `mpl-gate-recorder.mjs`; lift those to `mpl-recover`. |
| `covers_schema_violation`, `goal_contract_invalid`, `phase_contract_graph_invalid` | Common handler: re-dispatch the corresponding decomposer / interviewer agent with the validator's structured error list. |
| `baseline_immutable` | The hook's `resume_instruction` is already concrete (touch the renewal sentinel) — recover can echo it as a one-shot user task, no agent dispatch needed. |
| Phantom `goal_contract_hash_corrupt` / `goal_contract_hash_mismatch` aliases | Delete (no emission site) OR rename emission to match (lower-risk: keep current emission name, drop aliases). |

### D. Diagnostic gaps

| Gap | Recommended action |
|---|---|
| `mpl-require-test-agent-brief` missing from trace PURPOSES | Add label entry. One-line fix. |
| Trace's bidirectional `endsWith` | Tighten to slash-boundary suffix match. One-line fix. |
| `pathCategory === 'state'` not differentiated | Add a `state` branch to `shouldIncludeHook` that filters to state-touching hooks only. |

## Sequencing recommendation

1. **First**: B-category — wire bare `block(reason)` to `recordBlockedHook` + `mpl-recover` routing. This is mechanical and unlocks recovery for the most-tripped hooks. Most can stay at block tier but use envelope.
2. **Second**: C-category — add the missing `mpl-recover` handlers + drop phantom aliases. Auto-fix paths (mechanical regeneration) ship first since they're cheapest.
3. **Third**: A-category high-severity (A1, A3) — write-guard tightening with explicit blocklist on protected paths.
4. **Fourth**: A-category warn/telemetry items — add structured telemetry surface (mpl-doctor / mpl-trace integration) without changing block behavior.
5. **Deferred**: A2 (HA-01 prompt heuristic) — needs design pass on false-positive tolerance.

## Default policy reaffirmation

v0.18.0 said "default: transitional warn, exp16+에서 strict: true". The current state is that ~half the hooks respect this policy (read enforcement config) and ~half bypass it (hand-rolled `block`). **The relaxation work is NOT loosening rules — it's making the hand-rolled hooks respect the policy that already exists.** A workspace that opts into `strict: true` should see consistent block behavior across all hooks; a default workspace should see consistent warn-mode surfacing.
