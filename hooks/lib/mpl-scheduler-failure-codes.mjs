/**
 * #230 — Canonical `failure_code` allowlist for parallel_failed events.
 *
 * Before this module, `parallel_failed` events carried a free-form
 * `failure_reason: err.message` string and the scheduler aggregator
 * unioned that string into `rejection_reasons`. A free-form prose
 * paraphrase of an error could satisfy the finalize gate's
 * canonical-vocabulary check (#214) just by repeating the same words
 * the executor happened to emit (e.g. `"worker dispatch failed"`),
 * and a wave with both pre-attempt `rejection_reasons_by_phase`
 * (planning) AND runtime `failure_reason` could be explained by the
 * planning token alone, masking the runtime cause.
 *
 * This module enumerates the only `failure_code` values that
 * parallel_failed events may carry. The aggregator collects these
 * SEPARATELY from `rejection_reasons`, and the finalize gate
 * requires each computed code to appear in `no_parallel_explanation`
 * independently of the existing rejection-reason check.
 *
 * Producer contract (commands/mpl-run-execute.md Step 4.0):
 *   - Pool / worktree setup failure  → 'worktree_setup_error'
 *   - Worker dispatch / spawn failure → 'worker_dispatch_error'
 *   - Per-phase execution failure inside the wave → 'wave_execution_error'
 *   - Sequential merge-after-wave failure → 'merge_error'
 *   - Anything not classifiable → 'unknown_runtime_error'
 *
 * Codes outside the allowlist are dropped at the aggregator boundary —
 * they cannot forge their way into the explanation's required-token
 * set. The free-form `failure_reason` message stays alongside the code
 * for operator readability but no longer feeds the gate.
 */

export const FAILURE_CODE_ALLOWLIST = Object.freeze(new Set([
  // ---- legacy v1 (#230) -------------------------------------------------
  'worker_dispatch_error',
  'worktree_setup_error',
  'wave_execution_error',
  'merge_error',
  'unknown_runtime_error',
  // ---- v2 wave-reducer + reconciliation extensions (Move #17) ------------
  // Stale base_sha on a shard envelope vs. the on-disk state.json snapshot.
  // Reducer refuses to merge — caller should re-snapshot and retry.
  'stale_shard_base',
  // Shard patch targets a top-level field with no `state.merge_policy.<field>`
  // entry; adding a new state.json top-level field requires a merge_policy.
  'unknown_field_ownership',
  // The 4-bucket reconciler classifier flagged a Textual (T) conflict —
  // same file path produced by two phases with different hashes. NOT LLM-
  // resolvable; planning produced an impossible decomposition.
  'merge_error:textual_conflict',
  // Bucket X bounded re-entry exhausted on (wave_id, contract_ref). Cap is 1.
  'semantic_reentry_exhausted',
  // Bucket C verifier dispatch produced a `reject_both` or invalid verdict;
  // the orchestrator escalates instead of merging.
  'reconcile_required',
  // Wave-reducer post-invariant replay failed for every isolated shard.
  'wave_reducer_unresolvable',
]));

/**
 * Returns `true` when `code` is a recognized canonical failure code.
 * `false` for null/undefined/non-string/non-allowlisted values.
 */
export function isCanonicalFailureCode(code) {
  return typeof code === 'string' && FAILURE_CODE_ALLOWLIST.has(code);
}
