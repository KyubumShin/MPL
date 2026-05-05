/**
 * v2 → v3 (G5 + G6 / #114): additive telemetry hygiene fields.
 *
 * Adds two new fields to the unified state shape:
 *
 *   - `fix_loop_history: []` — G5 per-phase fix-loop entries.
 *     Each entry: `{ phase, count, started_at, ended_at?, root_cause_summary? }`.
 *     `mpl-phase-controller` appends/updates entries when `fix_loop_count`
 *     changes. G3 invariant I5 enforces
 *     `fix_loop_count == sum(fix_loop_history[].count)`.
 *
 *   - `user_intervention_count: 0` — G6 honest auto-mode telemetry.
 *     `mpl-keyword-detector` (UserPromptSubmit) increments this when the
 *     pipeline is active AND `state.run_mode === 'auto'`. Surfaces in
 *     `/mpl-status` once G2 (#113) lands.
 *
 * Both fields are pure backfills — no breaking semantic change. Per the
 * H8 migration policy this is an additive bump (patch-level on the
 * plugin). v2 state objects gain the defaults; v3 writers populate them
 * incrementally.
 */

export default {
  from: 2,
  to: 3,
  description: 'Additive backfill — fix_loop_history + user_intervention_count (G5+G6 / #114)',
  migrate(state, _cwd) {
    const merged = { ...state };

    if (!Array.isArray(merged.fix_loop_history)) {
      merged.fix_loop_history = [];
    }
    if (typeof merged.user_intervention_count !== 'number') {
      merged.user_intervention_count = 0;
    }

    merged.schema_version = 3;
    return merged;
  },
};
