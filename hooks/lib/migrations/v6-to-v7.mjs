/**
 * v6 → v7: Exp22 R6 scheduler observability state.
 *
 * Adds two ring-buffered arrays consumed by the parallel scheduler in
 * `commands/mpl-run-execute.md`:
 *  - `phase_scheduler_history` — mirrors the latest 50
 *    `record_scheduler_event` rows that also append to
 *    `.mpl/mpl/profile/phase-scheduler.jsonl`. Lets runs prove whether each
 *    `execution_tiers[]` decision was parallelized or why it was rejected.
 *  - `worktree_pool_history` — slot lifecycle for the parallel-tier worktree
 *    pool. Distinct from `worktree_history` (HIGH-risk isolation lifecycle in
 *    `commands/mpl-run-execute-context.md` §5). Two writers with
 *    non-overlapping shapes; keeping them on separate fields stops any reader
 *    from having to discriminate by schema-shape inspection.
 *
 * Same backfill pattern as v5→v6 (PR #213 codex/claude review): adding fields
 * to DEFAULT_STATE without a migration would let legacy v6 state.json read
 * with `state.phase_scheduler_history === undefined`, then any reader doing
 * `state.phase_scheduler_history.length` would throw. The migration removes
 * that ambiguity at read time.
 */

export default {
  from: 6,
  to: 7,
  description:
    'Additive backfill — Exp22 R6 scheduler observability (phase_scheduler_history, worktree_pool_history)',
  migrate(state, _cwd) {
    const merged = { ...state };

    if (!Array.isArray(merged.phase_scheduler_history)) {
      merged.phase_scheduler_history = [];
    }
    if (!Array.isArray(merged.worktree_pool_history)) {
      merged.worktree_pool_history = [];
    }

    merged.schema_version = 7;
    return merged;
  },
};
