---
name: mpl-recover
description: "Recover an MPL pipeline that is paused by a hook block. Use this skill when session_status is blocked_hook, /mpl:mpl-resume reports blocked_by_hook/block_code, or the user asks to recover from a hook block."
---

# MPL Recover

Resolve a hook-blocked MPL pipeline without restarting the whole run.

`/mpl:mpl-recover` is narrower than `/mpl:mpl-resume`: it reads the active
`blocked_hook` envelope, chooses a block-code handler, applies only safe fixes
automatically, and preserves the block when evidence is still missing.

## Step 1: Inspect Recovery Plan

Run:

```bash
node hooks/lib/mpl-recover.mjs --plan
```

When the blocking hook is unclear, trace the relevant artifact first:

```bash
node hooks/lib/mpl-hook-trace.mjs .mpl/mpl/decomposition.yaml
```

The trace distinguishes registered hooks from the hook currently blocking the
active `blocked_hook` envelope.

If the result is:
- `no_state` or `not_blocked` → report that there is no hook block to recover.
- `recoverable` → continue to the matching handler below.
- `requires_approval` → show the reason and ask the user before any canonical artifact edit.
- `unsupported` → show `blocked_by_hook`, `block_code`, `resume_instruction`, and `retry_context`; do not restart the pipeline.

## Step 2: Safe Recovery

For safe handlers, run:

```bash
node hooks/lib/mpl-recover.mjs --apply-safe
```

Safe handlers:
- `goal_baseline_hash` with `goal_contract_baseline_corrupt`:
  repair `.mpl/mpl/baseline.yaml` from the normalized hash of `.mpl/goal-contract.yaml`, then clear `blocked_hook`.
- `test_agent_evidence`:
  if `state.test_agent_dispatched[phase_id]` already contains valid PASS evidence, clear `blocked_hook`; otherwise keep the block and return the embedded `Task(subagent_type="mpl-test-agent", ...)` instruction.
- `auto_regenerate` with `decomposition_derived_stale` or `test_agent_briefs_write_failed` (#234):
  re-run the deterministic postprocess (`writeDerivedDecompositionFields` / `writeTestAgentBriefs`). Capped at 3 attempts via `retry_context.recovery.attempts`; past the budget the handler returns `failed` with the underlying I/O error so the operator can fix the source. For brief regeneration, the handler verifies post-conditions (codex r1 on #242): if `decomposition.yaml` is missing or zero briefs were produced for the blocked context, the block stays `failed` with a concrete instruction instead of being mistakenly cleared.

When `test_agent_evidence` returns `awaiting_test_agent`, execute the embedded
`mpl-test-agent` Task exactly as shown in `resume_instruction`. The agent must
return valid JSON with `verdict:"PASS"`, at least one executable test,
`commands_run[].exit_code == 0`, no skipped/failed tests, and no bugs. After the
Task completes, run `/mpl:mpl-recover` again. `mpl-gate-recorder` may also clear
the matching block automatically when PASS evidence lands.

## Step 3: Explicit Approval Recovery

Only after the user explicitly approves canonical artifact edits, run:

```bash
node hooks/lib/mpl-recover.mjs --approve-unsafe
```

Approval-required handlers:
- `goal_contract_drift`:
  update `baseline.yaml` to the current normalized goal contract hash. Use only
  when the current `.mpl/goal-contract.yaml` is intentionally the source of truth.
- `goal_trace_incomplete` with only `goal_contract_hash:*` issues:
  patch the top-level `goal_contract_hash` in `.mpl/mpl/decomposition.yaml`, then
  revalidate goal trace coverage before clearing the block.
- `missing_artifact_schema` for missing `phase-N.test_agent_required`:
  insert `test_agent_required: true` for the listed phases. This is conservative
  because missing values are already treated as required by AD-0007.
- `redispatch_decomposer` with `covers_schema_violation` or `phase_contract_graph_invalid` (#234):
  the recover skill returns a `Task(subagent_type="mpl-decomposer", ...)` dispatch instruction with the validator's structured findings echoed back. Diagnostics are normalized across `retry_context.failures` / `retry_context.issues` / `retry_context.missing` (each hook records under a different field). The orchestrator (not the recover skill) executes the Task. **Requires `--approve-unsafe` (codex r7 #242)**: `--apply-safe` keeps the block at `requires_approval` so an automation watching `awaiting_decomposer` cannot side-step the human checkpoint.
- `goal_contract_invalid` (#234 codex r1):
  no agent dispatch. Returns the recorded `resume_instruction` ("Restore a valid .mpl/goal-contract.yaml") with the missing-field list appended. A decomposer re-dispatch cannot repair a missing source file. **Requires `--approve-unsafe` (codex r7 #242)**.
- `phase_runner_anomaly` with `phase_runner_<anomaly_type>` (#234):
  the recover skill returns an anomaly-specific `Task(subagent_type="mpl-phase-runner", ...)` dispatch instruction. Anomaly types include `empty_response`, `truncated_response`, `invalid_json`, `no_evidence`. Each has a tailored framing (stronger prompt / reduced context / explicit schema reminder / evidence emphasis). **Requires `--approve-unsafe` (codex r7 #242)**.
- `baseline_immutable` (#234):
  no agent dispatch. Returns the recorded `resume_instruction` (touch `.mpl/mpl/.baseline-renewal`) as `user_instruction`. **Requires `--approve-unsafe` (codex r7 #242)**.
- `finalize_gate_failures` (#257):
  no agent dispatch. The coalesced finalize gate (`mpl-finalize-gate`) batches every per-validator failure on a single `finalize_done=true` write into one envelope. `retry_context.failures[]` preserves each originating validator's `hookId`, `code`, `reason`, and `resume_instruction`. The orchestrator must resolve every entry — they are independent concerns (E2E execution, E2E authenticity, declared artifacts, AC/AX closure) and there is no shortcut. After resolving all entries, retry the finalize write; the gate re-runs every validator from scratch on the new write. Returns `requires_user_action` (no `--approve-unsafe` path).

If revalidation still fails, recovery must leave `session_status:"blocked_hook"`
intact and update `block_reason`, `resume_instruction`, and
`retry_context.recovery` with the failed attempt.

## Step 4: Resume Flow

After a `recovered` result:
1. Read `.mpl/state.json` and confirm `session_status` is no longer `blocked_hook`.
2. Resume from the existing `current_phase` / `blocked_phase` context, not from Phase 0.
3. For `phase2-sprint`, retry the blocked phase transition.
4. For `mpl-decompose` or `phase3-gate`, retry the same decomposition/gate action that originally hit the hook.

## Safety Rules

- Never fabricate test-agent evidence or write PASS into `state.test_agent_dispatched`.
- Never edit `baseline.yaml` for a mismatch/drift block without explicit user approval.
- Never patch `decomposition.yaml` schema/hash fields without explicit user approval.
- Never clear `blocked_hook` unless the missing evidence has been restored and the relevant validator passes.
- Every recovery attempt writes an audit line to `.mpl/signals/recovery.jsonl`.
