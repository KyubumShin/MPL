/**
 * MPL v2 L1 state reader — read-only access to `.mpl/state.json`.
 *
 * Stage A first move (v2 commit #1): the read-only state utilities are
 * lifted verbatim from `hooks/lib/mpl-state.mjs` so the new
 * `hooks/lib/state/` layer owns the read side without disturbing any
 * caller. `hooks/lib/mpl-state.mjs` re-exports every public symbol below
 * under the same name, so all existing import sites
 * (`isMplActive` ×40, `readState` ×30, `checkConvergence` ×1,
 * `migrateLegacyExecutionState` ×1, plus the `CURRENT_SCHEMA_VERSION` /
 * `MAX_AMBIGUITY_HISTORY` / `LEGACY_EXECUTION_STATE_PATH` constants)
 * continue to work without edits.
 *
 * Exported symbols:
 *   Functions:
 *     - readState(cwd)                                (public)
 *     - applyMigrationChain(cwd, state)               (internal — re-imported by facade)
 *     - migrateLegacyExecutionState(cwd, currentState) (public)
 *     - detectStateDrift(cwd)                         (public)
 *     - readPersistedSchemaVersion(cwd)               (internal — re-imported by facade for H8 guard)
 *     - isMplActive(cwd)                              (public)
 *     - checkConvergence(state)                       (public, pure in-memory analyzer)
 *
 *   Constants:
 *     - STATE_DIR, STATE_FILE                         (internal — consumed by writer via re-import)
 *     - CURRENT_SCHEMA_VERSION = 7                    (public)
 *     - MAX_AMBIGUITY_HISTORY  = 10                   (public)
 *     - LEGACY_EXECUTION_STATE_PATH                   (public, re-exported from v1-to-v2 migration)
 *
 * Contract:
 *   - Read-only / migration-aware / H8 fail-closed.
 *   - No writer logic (stays in mpl-state.mjs facade).
 *   - No imports from policy/ or observability/.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { runMigrations } from '../migrations/index.mjs';
import { LEGACY_EXECUTION_STATE_PATH as V1_TO_V2_LEGACY_PATH } from '../migrations/v1-to-v2.mjs';

export const STATE_DIR = '.mpl';
export const STATE_FILE = 'state.json';

/**
 * Ring-buffer cap for Stage 2 ambiguity round records. writeState enforces this
 * post-merge so the state file cannot grow unbounded even when the orchestrator
 * forgets to slice before writing. The orchestrator still slices on its side as
 * a courtesy (cheaper stringify); this is the defense-in-depth guarantee.
 */
export const MAX_AMBIGUITY_HISTORY = 10;

/**
 * Schema version for the unified `.mpl/state.json` file.
 *
 * - `undefined` in a read state = legacy v1 (pre-P2-6): the pipeline-scope
 *   fields lived in `.mpl/state.json` and the execution-scope fields
 *   (`task`, `phases`, `phase_details`, `totals`, `cumulative_pass_rate`)
 *   lived in a separate `.mpl/mpl/state.json` maintained by orchestrator
 *   prompts.
 * - `2` = unified shape: everything in `.mpl/state.json`, execution-scope
 *   fields under the top-level `execution` subtree.
 * - `3` = G5 + G6 (#114) telemetry hygiene fields: additive backfill for
 *   `fix_loop_history` (per-phase fix-loop entries) and
 *   `user_intervention_count` (auto-mode honesty counter).
 * - `4` = Goal Contract readiness fields and finalize/security evidence
 *   backfills.
 * - `5` = Stage A release-path lifecycle subtree (`state.release` with
 *   `current_cut_id`, `completed_cut_ids`, `fix_loop_count`,
 *   `pending_artifact`); consumed by D-Q6 immutability hook + Phase 1.6b
 *   release-gate / release-finalize handlers.
 * - `6` = Stage A release-gate scoped evidence subtree
 *   (`state.release.gate_results` parallel to top-level `state.gate_results`,
 *   `state.release.max_fix_loops` default 3); consumed by Phase 1.6c-i
 *   release-gate handler for scoped Hard 1/2/3 routing per RFC §5.5.
 *
 * H8 (#116) routes per-version logic through `hooks/lib/migrations/`. To
 * bump this constant, register a new migration entry; see
 * `docs/schemas/migration-policy.md`.
 */
export const CURRENT_SCHEMA_VERSION = 7;

/**
 * Legacy execution state file. Pre-P2-6 orchestrator prompts wrote to this
 * via Write/Edit; v2 stores the same shape under `state.execution` in
 * `.mpl/state.json`. The constant is re-exported from the v1-to-v2
 * migration so existing consumers (resume skill, archive helpers) keep
 * the import path stable.
 */
export const LEGACY_EXECUTION_STATE_PATH = V1_TO_V2_LEGACY_PATH;

/**
 * Read MPL state from .mpl/state.json.
 *
 * Schema-version handling (H8 / #116):
 *   - `schema_version > CURRENT_SCHEMA_VERSION` → **fail-closed**. The
 *     plugin is older than the writer; we cannot reason about field
 *     shapes that may have been renamed or removed. Returns `null` so
 *     downstream hooks degrade rather than misinterpret. A diagnostic
 *     line is written to stderr; G3 I8 (defense-in-depth) also catches
 *     the same condition when invoked.
 *   - `schema_version < CURRENT_SCHEMA_VERSION` (or absent → treated as
 *     1) → run the migration registry up to current. Migrations persist
 *     atomically inside this function so subsequent reads short-circuit.
 *
 * @param {string} cwd - Working directory
 * @returns {object|null} State object or null if not found/invalid/unsupported
 */
export function readState(cwd) {
  try {
    const statePath = join(cwd, STATE_DIR, STATE_FILE);
    if (!existsSync(statePath)) return null;
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8'));
    // M5: Minimal schema validation
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!parsed.current_phase) return null;

    // H8 fail-closed guard — refuse to act on a state from a newer writer.
    if (typeof parsed.schema_version === 'number' && parsed.schema_version > CURRENT_SCHEMA_VERSION) {
      process.stderr.write(
        `[MPL state] schema_version=${parsed.schema_version} exceeds supported MAX=${CURRENT_SCHEMA_VERSION}. ` +
        `Upgrade the mpl plugin or restore .mpl/state.json from a compatible run. ` +
        `See docs/schemas/migration-policy.md.\n`
      );
      return null;
    }

    if ((parsed.schema_version ?? 1) < CURRENT_SCHEMA_VERSION) {
      const migrated = applyMigrationChain(cwd, parsed);
      if (migrated) return migrated;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Run the migration registry against `state` and persist the result
 * atomically. Returns the migrated state, or `null` on I/O failure
 * (caller falls back to the unmigrated state).
 *
 * Exported so the facade can re-import it for `migrateLegacyExecutionState`
 * delegation; not part of the public surface.
 */
export function applyMigrationChain(cwd, state) {
  try {
    const migrated = runMigrations(state, cwd, CURRENT_SCHEMA_VERSION);
    if (!migrated || migrated === state) return migrated || state;

    const stateDir = join(cwd, STATE_DIR);
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    const stateTmp = join(stateDir, `.state-${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(stateTmp, JSON.stringify(migrated, null, 2), { mode: 0o600 });
    renameSync(stateTmp, join(stateDir, STATE_FILE));
    return migrated;
  } catch {
    return null;
  }
}

/**
 * Public migration entry point. Retained from P2-6 so external consumers
 * (e.g. `skills/mpl-resume/SKILL.md`) keep working — the body now
 * delegates to the H8 migration registry, which handles archive +
 * persistence in `applyMigrationChain`. The returned object is the
 * migrated state, or `null` on I/O failure (caller keeps the unmigrated
 * state so the pipeline doesn't wedge).
 */
export function migrateLegacyExecutionState(cwd, currentState) {
  if (!currentState || typeof currentState !== 'object') return null;
  return applyMigrationChain(cwd, currentState);
}

/**
 * P2-6: detect drift between the unified state.execution subtree and a
 * surviving legacy .mpl/mpl/state.json. Called by resume to surface
 * discrepancies before continuing. Returns { drift: boolean, details: [] };
 * any I/O or parse failure resolves to `{ drift: false, details: [] }` so
 * a corrupt legacy file never blocks resume.
 */
export function detectStateDrift(cwd) {
  try {
    const statePath = join(cwd, STATE_DIR, STATE_FILE);
    const legacyPath = join(cwd, LEGACY_EXECUTION_STATE_PATH);
    if (!existsSync(statePath) || !existsSync(legacyPath)) {
      return { drift: false, details: [] };
    }
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    const legacy = JSON.parse(readFileSync(legacyPath, 'utf-8'));
    const execution = state?.execution ?? {};

    const details = [];
    if ((legacy?.phases?.completed ?? null) !== (execution?.phases?.completed ?? null)) {
      details.push(`phases.completed: legacy=${legacy?.phases?.completed} unified=${execution?.phases?.completed}`);
    }
    if ((legacy?.phases?.total ?? null) !== (execution?.phases?.total ?? null)) {
      details.push(`phases.total: legacy=${legacy?.phases?.total} unified=${execution?.phases?.total}`);
    }
    if ((legacy?.status ?? null) !== (execution?.status ?? null)) {
      details.push(`status: legacy=${legacy?.status} unified=${execution?.status}`);
    }
    if ((legacy?.cumulative_pass_rate ?? null) !== (execution?.cumulative_pass_rate ?? null)) {
      details.push(`cumulative_pass_rate: legacy=${legacy?.cumulative_pass_rate} unified=${execution?.cumulative_pass_rate}`);
    }
    const legacyPhaseIds = (legacy?.phase_details ?? []).map((p) => p?.id).filter(Boolean);
    const unifiedPhaseIds = (execution?.phase_details ?? []).map((p) => p?.id).filter(Boolean);
    if (legacyPhaseIds.join(',') !== unifiedPhaseIds.join(',')) {
      details.push(`phase_details ids differ: legacy=[${legacyPhaseIds.join(',')}] unified=[${unifiedPhaseIds.join(',')}]`);
    }
    return { drift: details.length > 0, details };
  } catch {
    return { drift: false, details: [] };
  }
}

/**
 * Probe the on-disk state.json for a schema_version that this plugin can
 * not safely round-trip. Returns the offending version if the file
 * exists, parses, and exceeds CURRENT_SCHEMA_VERSION; null otherwise
 * (missing, corrupt, parity, or older). Pure read — no mutation.
 *
 * Exported so the facade can re-import it for `writeState`'s H8
 * fail-closed guard; not part of the public surface.
 */
export function readPersistedSchemaVersion(cwd) {
  const statePath = join(cwd, STATE_DIR, STATE_FILE);
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8'));
    if (typeof parsed?.schema_version === 'number' && parsed.schema_version > CURRENT_SCHEMA_VERSION) {
      return parsed.schema_version;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if MPL is currently active
 * @param {string} cwd - Working directory
 * @returns {boolean}
 */
export function isMplActive(cwd) {
  // M6: Check file existence separately from readState
  const statePath = join(cwd, STATE_DIR, STATE_FILE);
  if (!existsSync(statePath)) return false; // No file = truly inactive

  const state = readState(cwd);
  if (!state) return true; // File exists but corrupt/invalid = fail-closed (assume active)
  if (!state.current_phase) return false;
  // Active if phase is not null and not finalized
  return state.current_phase !== 'completed' && state.current_phase !== 'cancelled';
}

/**
 * Check convergence of fix loop pass rates
 * Enhanced in v3: stagnation detection with variance, regression detection, strategy suggestions
 * @param {object} state - Current MPL state
 * @returns {{ status: string, delta?: number, suggestion?: string }}
 */
export function checkConvergence(state) {
  const conv = state?.convergence;
  if (!conv) return { status: 'insufficient_data' };

  const { pass_rate_history, stagnation_window = 3, min_improvement = 0.05, regression_threshold = -0.1 } = conv;
  if (!Array.isArray(pass_rate_history) || pass_rate_history.length < 2) return { status: 'insufficient_data' };

  const windowSize = Math.min(stagnation_window, pass_rate_history.length);
  const recent = pass_rate_history.slice(-windowSize);
  const latest = recent[recent.length - 1];
  const earliest = recent[0];
  const improvement = latest - earliest;

  // v3: Regression detection (delta < -10%)
  if (improvement < regression_threshold) {
    return {
      status: 'regressing',
      delta: improvement,
      suggestion: 'Pass rate is declining. Consider reverting to last known good state or reviewing Phase 0 artifacts.'
    };
  }

  // v3: Stagnation detection with variance check
  if (recent.length >= stagnation_window) {
    // Calculate variance of recent pass rates
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / recent.length;

    if (variance < 0.0025 && improvement < min_improvement) {
      // variance < 5% (0.05^2 = 0.0025) AND no meaningful improvement
      return {
        status: 'stagnating',
        delta: improvement,
        suggestion: 'Fix loop stagnating. AD-07 strategy override will be generated from prior reflections + phase0 artifacts. See .mpl/mpl/phases/{phase}/strategy-override.json after generation.'
      };
    }

    if (improvement < min_improvement) {
      return { status: 'stagnating', delta: improvement, suggestion: 'Below improvement threshold. AD-07 strategy override will synthesize alternative approach from reflection history.' };
    }
  }

  return { status: 'improving', delta: improvement };
}
