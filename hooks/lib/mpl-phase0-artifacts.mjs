/**
 * Phase 0 boundary/runtime artifact requirements (Exp22 R11 / #210).
 *
 * The orchestrator must not transition into phase1b-plan or later
 * lifecycle phases until Phase 0 has produced the artifacts that make
 * cross-boundary integration testable. Fast-track (`run_mode=auto`)
 * makes this especially important because user oversight is reduced.
 *
 * Two enforcement points use this helper:
 *   1. `hooks/lib/mpl-state-invariant.mjs` I13 — fires on STATE_WRITE
 *      so a manual `.mpl/state.json` edit cannot land a protected
 *      phase without these artifacts.
 *   2. `hooks/mpl-phase-controller.mjs` (Stop hook) — calls
 *      `missingPhase0Artifacts(cwd)` before each `writeState({
 *      current_phase: <protected> })` transition. Phase-controller's
 *      writeState path does NOT go through PreToolUse, so I13 alone
 *      misses it. Codex r1 on PR #222 flagged this gap.
 *
 * Required artifacts (any missing → transition blocked):
 *   - `.mpl/mpl/phase0/raw-scan.md`
 *   - `.mpl/mpl/phase0/design-intent.yaml`
 *   - at least one `.mpl/contracts/*.json`, including the explicit
 *     `_no-boundaries.json` opt-out the decomposer writes for simple
 *     tasks that have no cross-layer boundary.
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

export const REQUIRES_PHASE0_ARTIFACTS = Object.freeze(new Set([
  'phase1b-plan',
  'phase2-sprint',
  'phase3-gate',
  'phase4-fix',
  'phase5-finalize',
  'release-gate',
  'release-finalize',
  'completed',
]));

function listDirSafe(dir) {
  try { return existsSync(dir) ? readdirSync(dir) : []; } catch { return []; }
}

/**
 * Returns the list of required Phase 0 artifacts that are NOT present.
 * Empty array means the Phase 0 boundary/runtime evidence is complete
 * enough to proceed.
 *
 * Caller is responsible for deciding what to do with a non-empty list —
 * I13 surfaces a violation, phase-controller emits a stopReason and
 * skips the transition.
 */
export function missingPhase0Artifacts(cwd) {
  const missing = [];
  if (!existsSync(join(cwd, '.mpl', 'mpl', 'phase0', 'raw-scan.md'))) {
    missing.push('.mpl/mpl/phase0/raw-scan.md');
  }
  if (!existsSync(join(cwd, '.mpl', 'mpl', 'phase0', 'design-intent.yaml'))) {
    missing.push('.mpl/mpl/phase0/design-intent.yaml');
  }
  const contractFiles = listDirSafe(join(cwd, '.mpl', 'contracts'))
    .filter((n) => n.endsWith('.json'));
  if (contractFiles.length === 0) {
    missing.push('.mpl/contracts/*.json (or _no-boundaries.json)');
  }
  return missing;
}

/**
 * Returns a stopReason string when transitioning to `nextPhase` would
 * land in a protected phase without the required artifacts. Returns
 * null when the transition is allowed (either the phase is exempt or
 * the artifacts are present).
 *
 * Phase-controller uses this to short-circuit a transition write.
 */
export function blockedPhaseTransitionReason(cwd, nextPhase) {
  if (!REQUIRES_PHASE0_ARTIFACTS.has(nextPhase)) return null;
  const missing = missingPhase0Artifacts(cwd);
  if (missing.length === 0) return null;
  return (
    `[MPL I13] Cannot transition to ${nextPhase} — Phase 0 boundary/runtime ` +
    `artifacts missing: ${missing.join(', ')}. Fast-track (run_mode=auto) ` +
    `may shorten user interviews but MUST NOT skip these artifacts. Re-run ` +
    `Phase 0 to produce them, or write .mpl/contracts/_no-boundaries.json ` +
    `as the explicit opt-out for non-boundary tasks.`
  );
}
