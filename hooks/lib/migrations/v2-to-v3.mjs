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
 *
 * **PR #133 review #1 fix** — `fix_loop_count > 0` carry-forward:
 * a v2 pipeline mid-run can already have `fix_loop_count > 0`. Backfilling
 * an empty `fix_loop_history` would land an instant I5 violation
 * (`count != sum(history) = 0`) on the very first read post-upgrade. We
 * synthesize a conservative aggregate entry so the invariant holds:
 *
 *   { phase: <best guess>, count: fix_loop_count,
 *     started_at: <migration time>, migrated_from_v2: true }
 *
 * The `migrated_from_v2` flag tells operators (and any future analysis
 * tooling) that this entry is aggregated, not per-iteration — phase
 * attribution is best-effort because v2 didn't track it. From the next
 * `writeState` onward, `recordFixLoopHistory` adds proper per-phase
 * entries.
 */

const MIGRATION_PHASE_FALLBACK = 'pre-migration';

export default {
  from: 2,
  to: 3,
  description: 'Additive backfill — fix_loop_history + user_intervention_count (G5+G6 / #114)',
  migrate(state, _cwd) {
    const merged = { ...state };

    if (!Array.isArray(merged.fix_loop_history)) {
      const carryForward = typeof merged.fix_loop_count === 'number'
        && Number.isFinite(merged.fix_loop_count)
        && merged.fix_loop_count > 0;
      if (carryForward) {
        const phase = merged.execution?.phases?.current
          ?? merged.current_phase
          ?? MIGRATION_PHASE_FALLBACK;
        merged.fix_loop_history = [{
          phase,
          count: merged.fix_loop_count,
          started_at: new Date().toISOString(),
          migrated_from_v2: true,
        }];
      } else {
        merged.fix_loop_history = [];
      }
    }
    if (typeof merged.user_intervention_count !== 'number') {
      merged.user_intervention_count = 0;
    }

    merged.schema_version = 3;
    return merged;
  },
};
