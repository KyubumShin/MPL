/**
 * v5 → v6: Stage A release-gate scoped evidence subtree.
 *
 * Adds the `release.gate_results` + `release.max_fix_loops` fields consumed
 * by Phase 1.6c-i `release-gate` handler:
 *  - `release.gate_results` — parallel to top-level `state.gate_results`,
 *    written by mpl-gate-recorder when the active phase is `release-gate`
 *    (RFC §5.5: scoped release evidence MUST NOT mix into the whole-pipeline
 *    `state.gate_results.hard{1,2,3}_*` subtree).
 *  - `release.max_fix_loops` — scoped retry budget for the release-gate →
 *    phase2-sprint fix loop (RFC §5.3.1). Separate from top-level
 *    `state.max_fix_loops` (default 10) because release-scope failures are
 *    cohort-local and should circuit-break faster (default 3).
 *
 * Backfill is additive: existing v5 state.json keeps every other field
 * intact and gains the two new release fields with safe defaults so the
 * release-gate handler transitions cleanly from stub to active routing
 * once Phase 1.6c-i lands.
 *
 * Same backfill pattern as v4→v5 (PR #184 codex review): adding fields to
 * DEFAULT_STATE without a migration would let legacy v5 state.json read
 * with `state.release.gate_results === undefined`, then the handler would
 * have to defensively treat undefined as MISSING. The migration removes
 * that ambiguity at read time.
 */

export default {
  from: 5,
  to: 6,
  description:
    'Additive backfill — Stage A release-gate scoped evidence (release.gate_results, release.max_fix_loops)',
  migrate(state, _cwd) {
    const merged = { ...state };

    const existing = merged.release;
    const gateDefaults = {
      hard1_passed: null,
      hard2_passed: null,
      hard3_passed: null,
      hard1_baseline: null,
      hard2_coverage: null,
      hard3_resilience: null,
    };
    const releaseDefaults = {
      current_cut_id: null,
      completed_cut_ids: [],
      fix_loop_count: 0,
      pending_artifact: null,
      gate_results: { ...gateDefaults },
      max_fix_loops: 3,
    };

    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      merged.release = { ...releaseDefaults };
    } else {
      // Preserve any field already set by v4→v5 or a hand-edit; fill in
      // only the two new keys.
      const next = { ...releaseDefaults, ...existing };
      // Defensive: nested gate_results must be a plain object with the
      // hard{1,2,3}_* shape. Any non-object replacement (or array) is
      // reset to defaults; partial objects are merged additively.
      const existingGate = existing.gate_results;
      if (!existingGate || typeof existingGate !== 'object' || Array.isArray(existingGate)) {
        next.gate_results = { ...gateDefaults };
      } else {
        next.gate_results = { ...gateDefaults, ...existingGate };
      }
      if (typeof next.max_fix_loops !== 'number' || !Number.isFinite(next.max_fix_loops)) {
        next.max_fix_loops = 3;
      }
      merged.release = next;
    }

    merged.schema_version = 6;
    return merged;
  },
};
