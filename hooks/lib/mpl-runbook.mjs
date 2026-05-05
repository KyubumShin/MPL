/**
 * RUNBOOK row appender + parser (G2 / #113).
 *
 * `.mpl/mpl/RUNBOOK.md` is the human-readable timeline source. Pre-G2 it
 * was written by the orchestrator only on success paths, so phase
 * transitions that crashed or got context-compacted left no trail —
 * R-OBSERVABILITY-GAP (Evidence A) showed half a sprint with rows
 * missing because the orchestrator never resumed long enough to write
 * them. G2 moves the append into hooks (Stop + PreCompact) so the row
 * lands as soon as the phase actually transitions, regardless of what
 * the orchestrator does next.
 *
 * Format (markdown table):
 *
 *   | phase | started_at | ended_at | gates | wall_min | fix_loops |
 *
 * Pure functions where possible. The append is idempotent over (phase,
 * ended_at) so re-running a hook (e.g. Stop fired twice) doesn't
 * duplicate rows.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';

export const RUNBOOK_REL_PATH = '.mpl/mpl/RUNBOOK.md';

const RUNBOOK_HEADER = [
  '# MPL Pipeline RUNBOOK',
  '',
  '> Auto-maintained by `mpl-phase-controller` (Stop) and `mpl-compaction-tracker`',
  '> (PreCompact). Each row records a phase transition observed by hooks.',
  '> Manual edits below the table will be preserved; the appender only',
  '> touches the table block.',
  '',
  '| phase | started_at | ended_at | gates | wall_min | fix_loops |',
  '|---|---|---|---|---|---|',
  '',
].join('\n');

const TABLE_HEADER_RE = /^\|\s*phase\s*\|\s*started_at\s*\|\s*ended_at\s*\|\s*gates\s*\|\s*wall_min\s*\|\s*fix_loops\s*\|\s*$/m;

/**
 * Format a row object into the markdown table line.
 * Strips pipes/newlines from each cell so a stray field can't break the
 * table layout.
 */
function formatRow(row) {
  const cells = [
    row?.phase ?? '',
    row?.started_at ?? '',
    row?.ended_at ?? '',
    row?.gates ?? '',
    (row?.wall_min ?? '').toString(),
    (row?.fix_loops ?? '').toString(),
  ].map((c) => String(c).replace(/[|\n\r]/g, ' ').trim());
  return `| ${cells.join(' | ')} |`;
}

function parseRow(line) {
  if (!line.startsWith('|')) return null;
  const cells = line.split('|').map((c) => c.trim());
  // First and last entries are empty (split artifact of leading/trailing pipe).
  if (cells.length !== 8) return null;
  // Skip header / separator rows.
  if (cells[1] === 'phase' || /^-+$/.test(cells[1])) return null;
  return {
    phase: cells[1],
    started_at: cells[2],
    ended_at: cells[3],
    gates: cells[4],
    wall_min: cells[5],
    fix_loops: cells[6],
  };
}

/**
 * Read all parseable rows from RUNBOOK.md. Returns `[]` when the file
 * is absent or unparseable; never throws.
 */
export function parseRunbookRows(cwd) {
  const path = join(cwd, RUNBOOK_REL_PATH);
  if (!existsSync(path)) return [];
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    const row = parseRow(line);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Append a row to the RUNBOOK table atomically. Idempotent over
 * `(phase, ended_at)`.
 *
 * Note (PR #134 nit #3): in production the dedup is rarely the actual
 * defense — `recordRunbookTransition`'s `prevPhase === newPhase`
 * early-return catches retry-style double-fires before this function
 * sees them, and `ended_at` uses millisecond precision so two real
 * appends almost always differ. The dedup is kept as defense-in-depth
 * for synthetic / programmatic callers that pass the same row twice
 * with a frozen timestamp (notably tests).
 *
 * Empty-`ended_at` rows are NEVER deduped — they're reserved for an
 * "open entry" pattern (PR #134 nit #2): a future caller may want to
 * append an open marker, do work, and close it later with the same
 * phase but a populated `ended_at`. Today no production caller uses
 * this shape (compaction snapshots populate `ended_at` because they
 * ARE the compaction event); the branch is documented as reserved
 * rather than removed so the close-emit can land without changing
 * this function.
 *
 * Returns `{ appended: boolean, reason?: string }` for caller logging.
 */
export function appendRunbookRow(cwd, row) {
  if (!row || typeof row.phase !== 'string' || row.phase.length === 0) {
    return { appended: false, reason: 'missing-phase' };
  }
  const path = join(cwd, RUNBOOK_REL_PATH);
  const dir = dirname(path);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    return { appended: false, reason: 'mkdir-failed' };
  }

  let text = '';
  if (existsSync(path)) {
    try { text = readFileSync(path, 'utf-8'); }
    catch { return { appended: false, reason: 'read-failed' }; }
  }

  // Bootstrap header if missing or table not detected.
  if (!TABLE_HEADER_RE.test(text)) {
    text = RUNBOOK_HEADER + (text ? `\n${text}` : '');
  }

  // Idempotency: skip if a row with the same (phase, ended_at) already
  // exists. A row whose `ended_at` is empty represents an open entry —
  // those are never deduped because the appender expects to close them.
  if (row.ended_at) {
    for (const existing of parseRunbookRows(cwd)) {
      if (existing.phase === row.phase && existing.ended_at === row.ended_at) {
        return { appended: false, reason: 'duplicate' };
      }
    }
  }

  // Insert the new row immediately after the separator row. We find the
  // separator (`|---|---|...`) and splice the new line right after it,
  // which keeps newest-first ordering predictable for readers.
  const lines = text.split('\n');
  let separatorIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|\s*$/.test(lines[i])) {
      separatorIdx = i;
      break;
    }
  }
  if (separatorIdx === -1) {
    // Header was just bootstrapped; locate again.
    return { appended: false, reason: 'no-separator' };
  }
  lines.splice(separatorIdx + 1, 0, formatRow(row));
  const next = lines.join('\n');

  // Atomic write (temp + rename) so a partial write can't corrupt the
  // file mid-rotation.
  try {
    const tmp = join(dir, `.runbook-${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(tmp, next, { mode: 0o600 });
    renameSync(tmp, path);
    return { appended: true };
  } catch {
    return { appended: false, reason: 'write-failed' };
  }
}

/**
 * Compact gate summary string for a row, derived from `state.gate_results`.
 * Returns "H1✓ H2✓ H3✓" / "H1✗ H2? H3✓" / "" when no evidence.
 *
 * Mirrors the precedence used by mpl-phase-controller#checkGateResults:
 * structured `exit_code` first, legacy boolean fallback when no
 * structured entries exist (transitional).
 */
export function summarizeGates(state) {
  const gr = state?.gate_results;
  if (!gr || typeof gr !== 'object') return '';
  const cells = [];
  for (const [k, label] of [['hard1_baseline', 'H1'], ['hard2_coverage', 'H2'], ['hard3_resilience', 'H3']]) {
    const ent = gr[k];
    if (ent && typeof ent === 'object' && typeof ent.exit_code === 'number') {
      cells.push(`${label}${ent.exit_code === 0 ? '✓' : '✗'}`);
    } else {
      const legacy = gr[`${label.toLowerCase().replace('h', 'hard')}_passed`];
      if (legacy === true) cells.push(`${label}✓`);
      else if (legacy === false) cells.push(`${label}✗`);
      else cells.push(`${label}?`);
    }
  }
  return cells.join(' ');
}

/**
 * Compute wall time in minutes between two ISO-8601 timestamps. Returns
 * empty string when either is missing/invalid; rounds to 1 decimal.
 */
export function wallMinutes(startedAt, endedAt) {
  if (!startedAt || !endedAt) return '';
  const s = Date.parse(startedAt);
  const e = Date.parse(endedAt);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return '';
  return ((e - s) / 60000).toFixed(1);
}
