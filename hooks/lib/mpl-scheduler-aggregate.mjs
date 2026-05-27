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

  // Strip YAML line comments before regex parsing so `key: # comment` and
  // `parallel: true # note` are recognized. Quoted-string-aware: `#`
  // inside double or single quotes does NOT start a comment. Decomposition
  // values are simple scalars; this is sufficient.
  text = stripYamlComments(text);

  const recomposeMatch = text.match(/(^|\n)recompose_count:\s*(\d+)/);
  const recompose_count = recomposeMatch ? Number(recomposeMatch[2]) : 0;

  // Two supported forms for the execution_tiers value:
  //   (a) block list — `execution_tiers:` on its own line, items indented
  //       below as `- ...`
  //   (b) top-level inline list — `execution_tiers: [{...}, {...}]` on the
  //       same line (still valid YAML)
  // The previous parser only recognized (a), so form (b) silently returned
  // zero tiers and bypassed enforcement.
  const headerMatch = text.match(/(^|\n)execution_tiers:[ \t]*(.*)$/m);
  if (!headerMatch) return { tiers: [], recompose_count };
  const sameLineValue = headerMatch[2].trim();

  let items;
  if (sameLineValue.startsWith('[')) {
    // Inline list form. Find the matching closing `]` (nesting-aware) so
    // multi-line inline lists are handled too.
    const headerEnd = headerMatch.index + headerMatch[0].length - headerMatch[2].length + (headerMatch[2].indexOf('[') >= 0 ? headerMatch[2].indexOf('[') : 0);
    const startBracket = text.indexOf('[', headerEnd);
    const endBracket = matchClosingBracket(text, startBracket);
    if (endBracket === -1) {
      return { tiers: [], recompose_count, parse_error: true };
    }
    const inner = text.slice(startBracket + 1, endBracket);
    items = splitTopLevelCommaItems(inner);
  } else if (sameLineValue === '' || sameLineValue.startsWith('#')) {
    // Block list form. Block ends at the next top-level YAML key.
    const blockMatch = text.match(/(^|\n)execution_tiers:[ \t]*(?:#[^\n]*)?\n([\s\S]*?)(?=\n[a-zA-Z_][a-zA-Z0-9_]*:|\n*$)/);
    if (!blockMatch) return { tiers: [], recompose_count };
    items = splitYamlListItems(blockMatch[2]);
  } else {
    // Same-line non-list value (e.g. `execution_tiers: null`). Treat as
    // unparseable — fail closed rather than pretending zero tiers.
    return { tiers: [], recompose_count, parse_error: true };
  }

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
    // Normalize the parallel value. A missing parallel field is an
    // explicit failure rather than an implicit false — `parallel:` is
    // required on every execution_tiers item by the decomposer schema,
    // and silently treating absence as false would let a malformed
    // decomposition vacuously skip the MUST.
    if (parallel === null) {
      parseError = true;
      continue;
    }
    const raw = String(parallel).trim().toLowerCase();
    if (raw !== 'true' && raw !== 'false') {
      parseError = true;
      continue;
    }
    tiers.push({ tier: tierNum, parallel: raw === 'true' });
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
/**
 * Find the closing `]` matching the opening `[` at `start`, ignoring
 * brackets inside single/double quotes. Returns -1 if unmatched.
 */
function matchClosingBracket(text, start) {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let pairs = { '[': ']', '{': '}' };
  let opens = new Set(['[', '{']);
  let closes = new Set([']', '}']);
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (opens.has(c)) depth++;
      else if (closes.has(c)) {
        depth--;
        if (depth === 0 && c === ']') return i;
      }
    }
  }
  return -1;
}

/**
 * Split an inline-list body on top-level commas (not inside nested
 * brackets or quotes). Returns each item as a raw string. For our parse
 * needs, items are either inline maps `{ ... }` or bare YAML values.
 */
function splitTopLevelCommaItems(text) {
  const out = [];
  let buf = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (const c of text) {
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    if (!inSingle && !inDouble) {
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      if (c === ',' && depth === 0) {
        if (buf.trim().length > 0) out.push(buf.trim());
        buf = '';
        continue;
      }
    }
    buf += c;
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
}

/**
 * Strip YAML `# comment` segments from each line, except when the `#` is
 * inside a single- or double-quoted string. Keeps escape behavior simple
 * (no backslash handling) — decomposition.yaml scalars are plain enough
 * that this matches js-yaml's behavior for the cases we parse.
 */
function stripYamlComments(text) {
  const out = [];
  for (const line of text.split('\n')) {
    let inSingle = false;
    let inDouble = false;
    let cut = -1;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "'" && !inDouble) inSingle = !inSingle;
      else if (c === '"' && !inSingle) inDouble = !inDouble;
      else if (c === '#' && !inSingle && !inDouble) {
        const prev = i === 0 ? ' ' : line[i - 1];
        if (/\s/.test(prev)) { cut = i; break; }
      }
    }
    out.push(cut === -1 ? line : line.slice(0, cut).replace(/\s+$/, ''));
  }
  return out.join('\n');
}

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
  // wave_index is the per-tier wave counter and prevents two same-tier
  // rejected/failed waves from collapsing onto the same dedupe key when
  // the timestamps happen to share the same coarse value.
  return [
    e?.pipeline_id ?? '',
    e?.run_started_at ?? '',
    e?.recompose_count ?? '',
    e?.tier ?? '',
    e?.wave_index ?? '',
    e?.timestamp ?? '',
    e?.selected_mode ?? '',
  ].join('|');
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
  const rejectionReasonSet = new Set();
  let wavesParallelRejected = 0;
  let wavesParallelFailed = 0;

  function collectRejectionReasons(e) {
    if (Array.isArray(e?.rejection_reasons)) {
      for (const r of e.rejection_reasons) if (typeof r === 'string' && r) rejectionReasonSet.add(r);
    }
    const byPhase = e?.rejection_reasons_by_phase;
    if (byPhase && typeof byPhase === 'object') {
      for (const v of Object.values(byPhase)) {
        if (typeof v === 'string' && v) rejectionReasonSet.add(v);
        else if (Array.isArray(v)) for (const r of v) if (typeof r === 'string' && r) rejectionReasonSet.add(r);
      }
    }
    if (typeof e?.failure_reason === 'string' && e.failure_reason) {
      rejectionReasonSet.add(e.failure_reason);
    }
  }

  for (const e of events) {
    tiersSeen.add(Number(e.tier));
    if (e.selected_mode === 'parallel') tiersWithParallelEvent.add(Number(e.tier));
    if (e.selected_mode === 'parallel_rejected') {
      tiersWithRejectedEvent.add(Number(e.tier));
      wavesParallelRejected += 1;
    }
    if (e.selected_mode === 'parallel_failed') {
      wavesParallelFailed += 1;
    }
    // Collect rejection reasons from EVERY event — the finalize prompt's
    // rejection_reasons rule is "union across all events", including
    // successful parallel events that record ready_but_blocked_reason on
    // deferred phases. Limiting this to non-parallel events would wedge a
    // correctly generated summary that mentions wave-split block reasons.
    collectRejectionReasons(e);
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

  // Tiers for which the run-summary's no_parallel_explanation MUST name an
  // affected tier id. The union of: missing telemetry, partial rejection,
  // and any expected parallel tier where the only event(s) were rejected or
  // failed (no successful parallel event).
  const affectedTierSet = new Set();
  for (const t of tiersWithMissingTelemetry) affectedTierSet.add(t);
  for (const t of tiersWithPartialRejection) affectedTierSet.add(t);
  for (const t of expectedParallel) {
    if (!tiersWithParallelEvent.has(t) && tiersSeen.has(t)) affectedTierSet.add(t);
  }
  const affected_tier_ids = [...affectedTierSet].sort((a, b) => a - b);

  return {
    tiers_total: decomp.tiers.length,
    tiers_parallel_requested: expectedParallel.size,
    tiers_parallel_executed: tiersParallelExecuted,
    tiers_parallel_rejected: expectedParallel.size - tiersParallelExecuted,
    tiers_with_missing_telemetry: tiersWithMissingTelemetry,
    waves_parallel_rejected: wavesParallelRejected,
    waves_parallel_failed: wavesParallelFailed,
    tiers_with_partial_rejection: tiersWithPartialRejection,
    rejection_reasons: [...rejectionReasonSet].sort(),
    affected_tier_ids,
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
