/**
 * v1 → v2 (P2-6 / #84): unify the split state files.
 *
 * Pre-P2-6 the pipeline-scope fields lived in `.mpl/state.json` and the
 * execution-scope fields (task, phases, phase_details, totals,
 * cumulative_pass_rate, failure_phase) lived in a separate
 * `.mpl/mpl/state.json`. v2 absorbs the latter into `state.execution`.
 *
 * The migration:
 *   1. Reads `.mpl/mpl/state.json` if present (legacy data).
 *   2. Merges the legacy fields into `state.execution`, with already-unified
 *      values winning over legacy values when both exist.
 *   3. Archives the legacy file to
 *      `.mpl/archive/{pipeline_id}-legacy-execution-state.json` (or
 *      `legacy-execution-state.json` when no pipeline_id is known).
 *   4. Removes the legacy file once archived.
 *   5. Bumps schema_version to 2.
 *
 * I/O failure during archive is non-fatal — it's better to leave the
 * legacy file in place than to wedge the pipeline.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { deepMerge } from '../mpl-state-merge.mjs';

export const LEGACY_EXECUTION_STATE_PATH = '.mpl/mpl/state.json';

const BASELINE_EXECUTION = Object.freeze({
  task: null,
  status: null,
  started_at: null,
  phases: { total: 0, completed: 0, current: null, failed: 0, circuit_breaks: 0 },
  phase_details: [],
  totals: { total_retries: 0, total_micro_fixes: 0, total_discoveries: 0, elapsed_ms: 0 },
  cumulative_pass_rate: null,
  failure_phase: null,
});

function readLegacyExecutionFile(legacyPath) {
  if (!existsSync(legacyPath)) return null;
  try {
    return JSON.parse(readFileSync(legacyPath, 'utf-8'));
  } catch {
    // Corrupt legacy file — return null so the migration falls back to
    // baseline defaults; the corrupt file is still archived verbatim
    // below for forensic value.
    return null;
  }
}

function archiveLegacyFile(cwd, currentState, legacyParsed, legacyPath) {
  if (legacyParsed === null && !existsSync(legacyPath)) return;
  const archiveRoot = join(cwd, '.mpl', 'archive');
  try {
    mkdirSync(archiveRoot, { recursive: true });
    const archiveName = currentState?.pipeline_id
      ? `${currentState.pipeline_id}-legacy-execution-state.json`
      : 'legacy-execution-state.json';
    writeFileSync(
      join(archiveRoot, archiveName),
      JSON.stringify({
        migrated_at: new Date().toISOString(),
        pipeline_id: currentState?.pipeline_id ?? null,
        legacy_content: legacyParsed,
      }, null, 2),
      { mode: 0o600 },
    );
    if (existsSync(legacyPath)) rmSync(legacyPath, { force: true });
  } catch {
    // Non-fatal: better to keep the legacy file than wedge the pipeline.
  }
}

export default {
  from: 1,
  to: 2,
  description: 'Unify split state files (P2-6 / #84) — execution subtree absorbs .mpl/mpl/state.json',
  migrate(state, cwd) {
    const legacyPath = join(cwd, LEGACY_EXECUTION_STATE_PATH);
    const legacyParsed = readLegacyExecutionFile(legacyPath);

    const merged = { ...state };
    const existingExecution = (state && typeof state.execution === 'object' && state.execution !== null)
      ? state.execution
      : {};

    merged.execution = deepMerge(
      deepMerge(BASELINE_EXECUTION, legacyParsed && typeof legacyParsed === 'object' ? legacyParsed : {}),
      existingExecution,
    );
    merged.schema_version = 2;

    archiveLegacyFile(cwd, state, legacyParsed, legacyPath);

    return merged;
  },
};
