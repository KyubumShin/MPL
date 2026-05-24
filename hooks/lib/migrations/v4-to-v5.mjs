/**
 * v4 → v5: Stage A release-path state subtree.
 *
 * Adds the `release` subtree consumed by:
 *  - Phase 1.4b D-Q6 immutability hook (PR #183) — reads
 *    `state.release.completed_cut_ids` as SSOT for released cuts.
 *  - Phase 1.6b orchestrator (subsequent PR) — writes
 *    `current_cut_id` / `fix_loop_count` / `pending_artifact` during
 *    release-gate / release-finalize transitions.
 *
 * Backfill is additive: existing v4 state.json keeps every other field
 * intact and gains `release` with safe defaults so the D-Q6 consumer
 * transitions cleanly from no-op to active enforcement once Phase 1.6b
 * starts writing to it.
 *
 * Codex review on PR #184 (1.6a) flagged the original 1.6a commit for
 * adding the subtree to DEFAULT_STATE without bumping the schema version
 * — existing v4 state.json files would silently lack the field, breaking
 * the deep-merge claim in the PR body. This migration is the fix.
 */

export default {
  from: 4,
  to: 5,
  description:
    'Additive backfill — Stage A release-path state subtree (current_cut_id, completed_cut_ids, fix_loop_count, pending_artifact)',
  migrate(state, _cwd) {
    const merged = { ...state };

    const existing = merged.release;
    const releaseDefaults = {
      current_cut_id: null,
      completed_cut_ids: [],
      fix_loop_count: 0,
      pending_artifact: null,
    };

    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      merged.release = { ...releaseDefaults };
    } else {
      // Preserve any field that was already set by a hand-edit / forward-
      // ported state file; fill in only the missing defaults.
      merged.release = { ...releaseDefaults, ...existing };
      // Defensive: completed_cut_ids must be an array of strings.
      if (!Array.isArray(merged.release.completed_cut_ids)) {
        merged.release.completed_cut_ids = [];
      }
      if (typeof merged.release.fix_loop_count !== 'number') {
        merged.release.fix_loop_count = 0;
      }
    }

    merged.schema_version = 5;
    return merged;
  },
};
