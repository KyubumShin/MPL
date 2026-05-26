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
- `goal_baseline_hash` with `goal_contract_baseline_corrupt` or `goal_contract_hash_corrupt`:
  repair `.mpl/mpl/baseline.yaml` from the normalized hash of `.mpl/goal-contract.yaml`, then clear `blocked_hook`.
- `test_agent_evidence`:
  if `state.test_agent_dispatched[phase_id]` already contains valid PASS evidence, clear `blocked_hook`; otherwise keep the block and return the embedded `Task(subagent_type="mpl-test-agent", ...)` instruction.

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
- `goal_contract_drift` / `goal_contract_hash_mismatch`:
  update `baseline.yaml` to the current normalized goal contract hash. Use only
  when the current `.mpl/goal-contract.yaml` is intentionally the source of truth.
- `goal_trace_incomplete` with only `goal_contract_hash:*` issues:
  patch the top-level `goal_contract_hash` in `.mpl/mpl/decomposition.yaml`, then
  revalidate goal trace coverage before clearing the block.
- `missing_artifact_schema` for missing `phase-N.test_agent_required`:
  insert `test_agent_required: true` for the listed phases. This is conservative
  because missing values are already treated as required by AD-0007.

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
