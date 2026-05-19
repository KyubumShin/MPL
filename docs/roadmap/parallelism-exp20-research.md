# MPL Parallelism Research After exp20

Date: 2026-05-19
Status: research record

## Context

This note records the follow-up research after reviewing MPL's current parallel execution flow and the Yggdrasil exp20 final report.

Inputs:

- MPL flow review: `commands/mpl-run-execute.md`, `commands/mpl-run-execute-parallel.md`, `commands/mpl-run-execute-context.md`, `agents/mpl-decomposer.md`
- exp20 report: `/Users/kbshin/project/harness_lab/yggdrasil/runs/exp20-final-report.md`
- exp20 artifacts: `/Users/kbshin/playground/ygg-exp20/.mpl/**`

## Current Finding

MPL already describes two levels of parallelism, but the active execution path is still mostly sequential.

The main contract mismatch is:

- Decomposer emits `execution_tiers`.
- Executor's phase-parallel branch looks for `parallel_with`.

This means decomposer output already contains useful scheduling intent, but executor does not consume it as the runtime scheduling contract.

Other blockers:

- TODO parallelism is batch-then-wait with max 3 workers, so worker slots can sit idle.
- The executor already has a worktree-isolated branch for parallel phases, but that branch is guarded by `parallel_with`; exp20-style decompositions emit `execution_tiers` instead, so the worktree branch is effectively unreachable.
- `chain_seed.enabled` defaults to false, so chain-scoped seed batching is not active in normal runs.
- Test Agent and reviewer verification are treated mostly as blocking joins instead of pipelinable stages guarded by dependency frontiers.

## exp20 Evidence

exp20 was a quality success and a throughput warning.

Quality recovered:

- 21/21 phases completed.
- Tauri capability setup recovered.
- Fake E2E was replaced by WebdriverIO + tauri-driver scenario tests.
- Measured tests increased from exp19's 27 to exp20's 293.
- `test_agent_required` was emitted for 21/21 phases.

Cost increased:

- Wall time was about 11h 5m.
- The report estimates 1.5M+ tokens, but exact token accounting is unreliable because state/profile writing stalled.
- The non-MPL comparator finished in about 42m, with much shallower backend depth.

The decomposer already identified parallelizable waves in exp20:

```yaml
execution_tiers:
  - { tier: 4, phases: ["phase-04", "phase-05"], parallel: true }
  - { tier: 6, phases: ["phase-07", "phase-08", "phase-09"], parallel: true }
  - { tier: 7, phases: ["phase-10", "phase-11"], parallel: true }
  - { tier: 13, phases: ["phase-18", "phase-19", "phase-20"], parallel: true }
```

The 21-phase run therefore had a 14-wave phase critical path if those tiers were actually consumed by a scheduler. This is a theoretical 33% reduction in phase wave count, not a wall-time estimate. exp20's wall time also includes Test Agent, E2E, gate, research, and retry/network overhead, so this should not be read as "11h becomes 7h" without measurement.

## Measurement Blocker

Parallelism work must start with telemetry recovery. exp20 cannot cleanly prove where time was spent because state/profile integrity regressed:

- `current_phase` reached `completed`, but `execution.phases.total/completed/current` stayed zero/null.
- structured gate evidence existed, but legacy `hardN_passed` booleans remained null, creating public summary drift.
- `session_status` remained `blocked_hook` after `block_reason` and `resume_instruction` were cleared.
- `last_tool_at` stopped far before completion.
- `profile/phases.jsonl` ended early.
- `profile/run-summary.json` was absent.

Without fixing this, exp21 cannot prove whether scheduler changes improve throughput.

## Recommended Priority

### v0.18.4: Restore Measurement Integrity

Do this before aggressive parallelism.

Required changes:

- Add a state freshness invariant at completion.
- Require `profile/run-summary.json` before `finalize_done=true`.
- Add a non-blocking telemetry health channel such as `.mpl/mpl/profile/telemetry-errors.jsonl`.
- Fix blocked hook cleanup so `session_status`, `blocked_by_hook`, `blocked_phase`, `block_reason`, `resume_instruction`, and `blocked_at` clear atomically.
- Resolve structured gate evidence vs legacy boolean drift:
  - either derive compatibility booleans from structured evidence,
  - or remove boolean-based displays and use structured evidence everywhere.
- Record test count manifests with exact feature flags and commands, so feature-gated test deltas are explainable.

Product-quality guardrails observed in exp20 should be tracked separately from measurement integrity:

- Add UI placeholder detection for visible fake counters such as `0 / 0 words`.
- Strengthen production TODO enforcement for user-facing error handling and workflow code.

### v0.18.5: Make Phase Parallelism Real

Required changes:

- Replace `parallel_with` consumption with `execution_tiers` scheduling.
- Treat `execution_tiers` as scheduler input, not a soft hint.
- Once the scheduler actually reaches the parallel branch, add `parallelism.max_phase_workers`, default 2, max 3.
- Add multi-worktree pool support after the scheduler reachability bug is fixed; the primary defect is currently not the worktree mechanism itself, but that the phase-parallel worktree branch is not called for `execution_tiers`.
- Add resource locks such as `package_manager`, `dev_server`, and `db_migration`.
- Require a post-join reconciliation artifact after every parallel tier:
  - changed files
  - contract files
  - exported symbols
  - test-agent findings
  - PASS/FAIL and targeted fix instructions

### v0.18.6: Add Pipeline Pipelining

Required changes:

- Enable Test Agent background pipelining for phases whose consumers do not depend on unverified behavior.
- Join before any dependent phase, gate entry, or finalize.
- Add reviewer pipelining behind the same dependency frontier.
- Replace TODO batch-then-wait with slot streaming:
  - keep max 3 active TODO slots,
  - when one finishes, immediately dispatch the next ready TODO.
- Require Seed TODOs to include `depends_on`, `files_to_modify`, and `resource_locks`.

## exp21 Measurement Design

exp21 should fail if telemetry is not trustworthy.

Measurement recovery gates:

- fail if `execution.phases.completed` is zero at completion,
- fail if `profile/run-summary.json` is absent,
- fail if gate public status and structured evidence disagree,
- fail if `session_status` remains `blocked_hook` with no active `block_reason`.

Parallelism metrics:

- `phase_waves_planned`
- `phase_waves_executed`
- `parallel_slots_available_ms`
- `parallel_slots_used_ms`
- `ready_but_blocked_reason`
- `critical_path_ms`
- `join_reconciliation_ms`

Success criteria:

- State/profile integrity is 100%.
- At least one decomposer parallel tier actually executes with concurrency greater than 1.
- Wall time improves against exp20 or the run explains why quality gates consumed the saved time.
- Quality does not regress: real E2E stays real, Test Agent dispatch coverage stays complete, and exp20's UI placeholder/TODO bugs are caught.

## Relationship To Existing Roadmap

This research updates the priority of the existing parallelism backlog in `docs/roadmap/pending-features.md`.

Prior backlog items still apply:

- PAR-01: intra-phase streaming dispatch
- PAR-02: `execution_tiers` activation
- PAR-03: dependency graph accuracy
- PAR-04: phase execution metrics
- PAR-05: conditional cross-phase pipelining

Change from this research:

- PAR-04 becomes a blocker, not a medium-priority follow-up.
- PAR-02 should become a hard executor contract, not only a soft hint.
- Multi-worktree pool support is required before phase-level parallelism can be real.
- Verification pipelining should be dependency-frontier based, not phase-order based.
