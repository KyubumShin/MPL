/**
 * Exp22 R6 / #205 — scheduler telemetry aggregator.
 *
 * Reads phase-scheduler events from `.mpl/mpl/profile/phase-scheduler.jsonl`
 * (persistent across pipelines) AND `state.phase_scheduler_history`
 * (ring-buffered last-50 mirror), unions+deduplicates them, filters to the
 * current run scope (pipeline_id + run_started_at + recompose_count), then
 * computes the same fields documented in `commands/mpl-run-finalize.md`
 * Step 5.4. The finalize-artifacts hook calls this to recompute the gates
 * itself rather than trusting `run-summary.json`'s self-reported counts.
 *
 * Returns null when the raw decomposition cannot be read or the
 * state/decomposition is empty (caller decides whether that's fail-open).
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Minimal YAML peek over `execution_tiers:` and top-level
 * `recompose_count:` in decomposition.yaml. We only need the parallel
 * boolean per tier and recompose_count — no need to pull in a full YAML
 * parser for this hook. Supports:
 *  - Block form with arbitrary key order:
 *      - tier: 4
 *        parallel: true
 *        phases: [...]
 *  - Inline-map form:
 *      - { tier: 4, parallel: true, phases: [...] }
 * Returns null when the file is missing. Returns
 * `{ tiers: [], recompose_count, parse_error }` when execution_tiers is
 * present but cannot be parsed; the caller treats parse_error as fail-
 * closed because a present-but-unparseable execution_tiers block must not
 * vacuously skip the scheduler MUST.
 */
export function readDecompositionScope(cwd) {
  const path = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
  if (!existsSync(path)) return null;
  let text;
  try { text = readFileSync(path, 'utf-8'); } catch { return null; }

  const recomposeMatch = text.match(/(^|\n)recompose_count:\s*(\d+)/);
  const recompose_count = recomposeMatch ? Number(recomposeMatch[2]) : 0;

  const blockMatch = text.match(/(^|\n)execution_tiers:\s*\n([\s\S]*?)(?=\n[a-zA-Z_][a-zA-Z0-9_]*:|\n*$)/);
  if (!blockMatch) return { tiers: [], recompose_count };

  const items = splitYamlListItems(blockMatch[2]);
  const tiers = [];
  let parseError = false;
  for (const item of items) {
    const tier = extractField(item, 'tier');
    const parallel = extractField(item, 'parallel');
    if (tier === null) {
      // List item present but no tier field recognized — fail closed.
      parseError = true;
      continue;
    }
    const tierNum = Number(tier);
    if (!Number.isInteger(tierNum)) {
      parseError = true;
      continue;
    }
    const parallelBool = parallel !== null && /^true$/i.test(String(parallel).trim());
    tiers.push({ tier: tierNum, parallel: parallelBool });
  }
  return { tiers, recompose_count, parse_error: parseError };
}

/**
 * Split an indented YAML list block into raw item strings. Each item
 * starts at a line beginning with the list-item marker `- ` at the same
 * indentation, and ends at the next item marker (or end of block).
 * Inline-map items (`- { ... }`) come back as a single line; block-form
 * items come back as multiple lines.
 */
function splitYamlListItems(text) {
  const lines = text.split('\n');
  let markerIndent = null;
  const items = [];
  let current = null;
  for (const line of lines) {
    const itemMatch = line.match(/^(\s*)-\s+(.*)$/);
    if (itemMatch) {
      if (markerIndent === null) markerIndent = itemMatch[1].length;
      if (itemMatch[1].length === markerIndent) {
        if (current !== null) items.push(current);
        current = itemMatch[2];
        continue;
      }
    }
    if (current !== null) current += '\n' + line;
  }
  if (current !== null) items.push(current);
  return items;
}

/**
 * Extract a scalar field from a YAML list item that may be block-form
 * (newline-separated key: value) or inline-map form (`{ k: v, k2: v2 }`).
 * Returns the raw string value or null if not found.
 */
function extractField(item, key) {
  // Block form first: key on its own line (or the start of the item),
  // possibly indented. Works for both reordered-key block items and
  // straight block items.
  const blockMatch = item.match(new RegExp(`(^|\\n)\\s*${key}\\s*:\\s*([^\\n,}]+)`, 'i'));
  if (blockMatch) return blockMatch[2].trim();
  // Inline map form fallback: `{ k: v, k2: v2 }` on one line. Strip
  // surrounding braces. The character class excludes newlines and the
  // map terminators so the lazy quantifier stops at the next field.
  const inlineCandidate = item.trim().replace(/^\{\s*/, '').replace(/\s*\}$/, '');
  const inlineMatch = inlineCandidate.match(
    new RegExp(`(^|,)\\s*${key}\\s*:\\s*([^,\\n}]+?)(?=\\s*[,\\n}]|$)`, 'i')
  );
  if (inlineMatch) return inlineMatch[2].trim();
  return null;
}

function readJsonl(cwd) {
  const path = join(cwd, '.mpl', 'mpl', 'profile', 'phase-scheduler.jsonl');
  if (!existsSync(path)) return [];
  let text;
  try { text = readFileSync(path, 'utf-8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* skip malformed line */ }
  }
  return out;
}

function eventKey(e) {
  return `${e?.pipeline_id ?? ''}|${e?.run_started_at ?? ''}|${e?.recompose_count ?? ''}|${e?.tier ?? ''}|${e?.timestamp ?? ''}|${e?.selected_mode ?? ''}`;
}

/**
 * Compute the scheduler block as documented in `commands/mpl-run-finalize.md`
 * Step 5.4. The returned shape mirrors the schema in
 * `commands/schemas/run-summary.json`.
 *
 * @param {string} cwd
 * @param {object} state - parsed .mpl/state.json
 * @returns {object|null} {
 *   tiers_total, tiers_parallel_requested, tiers_parallel_executed,
 *   tiers_parallel_rejected, tiers_with_missing_telemetry,
 *   waves_parallel_rejected, waves_parallel_failed,
 *   tiers_with_partial_rejection,
 * } — or null when decomposition is missing.
 */
export function aggregateScheduler(cwd, state) {
  const decomp = readDecompositionScope(cwd);
  if (!decomp) return null;

  // If execution_tiers exists but items could not be parsed, fail closed:
  // the caller treats this as a guard violation rather than vacuously
  // skipping the MUST.
  if (decomp.parse_error) {
    return { __decomposition_unparseable__: true };
  }

  const expectedParallel = new Set(
    decomp.tiers.filter((t) => t.parallel).map((t) => t.tier)
  );

  const jsonlEvents = readJsonl(cwd);
  const stateEvents = Array.isArray(state?.phase_scheduler_history)
    ? state.phase_scheduler_history : [];
  const merged = jsonlEvents.concat(stateEvents);

  const seen = new Set();
  const raw = [];
  for (const e of merged) {
    const k = eventKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    raw.push(e);
  }

  const events = raw.filter((e) =>
    e &&
    e.pipeline_id === state?.pipeline_id &&
    e.run_started_at === state?.started_at &&
    Number(e.recompose_count) === Number(decomp.recompose_count)
  );

  const tiersWithParallelEvent = new Set();
  const tiersWithRejectedEvent = new Set();
  const tiersSeen = new Set();
  let wavesParallelRejected = 0;
  let wavesParallelFailed = 0;

  for (const e of events) {
    tiersSeen.add(Number(e.tier));
    if (e.selected_mode === 'parallel') tiersWithParallelEvent.add(Number(e.tier));
    if (e.selected_mode === 'parallel_rejected') {
      tiersWithRejectedEvent.add(Number(e.tier));
      wavesParallelRejected += 1;
    }
    if (e.selected_mode === 'parallel_failed') wavesParallelFailed += 1;
  }

  const tiersParallelExecuted = [...expectedParallel].filter((t) =>
    tiersWithParallelEvent.has(t)
  ).length;
  const tiersWithMissingTelemetry = [...expectedParallel].filter((t) =>
    !tiersSeen.has(t)
  );
  const tiersWithPartialRejection = [...expectedParallel].filter((t) =>
    tiersWithParallelEvent.has(t) && tiersWithRejectedEvent.has(t)
  );

  return {
    tiers_total: decomp.tiers.length,
    tiers_parallel_requested: expectedParallel.size,
    tiers_parallel_executed: tiersParallelExecuted,
    tiers_parallel_rejected: expectedParallel.size - tiersParallelExecuted,
    tiers_with_missing_telemetry: tiersWithMissingTelemetry,
    waves_parallel_rejected: wavesParallelRejected,
    waves_parallel_failed: wavesParallelFailed,
    tiers_with_partial_rejection: tiersWithPartialRejection,
  };
}

/**
 * Whether the computed scheduler aggregate requires a
 * `no_parallel_explanation`.
 */
export function explanationRequiredFromAggregate(agg) {
  if (!agg) return false;
  if (agg.tiers_parallel_requested === 0) return false;
  return (
    agg.tiers_parallel_executed < agg.tiers_parallel_requested ||
    agg.tiers_with_missing_telemetry.length > 0 ||
    agg.tiers_with_partial_rejection.length > 0 ||
    agg.waves_parallel_failed > 0
  );
}
