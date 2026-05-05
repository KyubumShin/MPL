import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  appendRunbookRow,
  parseRunbookRows,
  summarizeGates,
  wallMinutes,
  RUNBOOK_REL_PATH,
} from '../lib/mpl-runbook.mjs';
import { writeState, readState, CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

let tmpDir;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'mpl-runbook-')); });
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

/* ─────────────────────── lib unit ────────────────────────── */

describe('appendRunbookRow', () => {
  it('bootstraps the file with header + table when absent', () => {
    const r = appendRunbookRow(tmpDir, {
      phase: 'phase1a-research',
      started_at: '2026-05-05T01:00:00Z',
      ended_at: '2026-05-05T01:05:00Z',
      gates: '',
      wall_min: '5.0',
      fix_loops: 0,
    });
    assert.equal(r.appended, true);
    const text = readFileSync(join(tmpDir, RUNBOOK_REL_PATH), 'utf-8');
    assert.match(text, /# MPL Pipeline RUNBOOK/);
    assert.match(text, /\| phase \| started_at \| ended_at \| gates \| wall_min \| fix_loops \|/);
    assert.match(text, /phase1a-research/);
  });

  it('inserts new rows immediately after the separator (newest-first)', () => {
    appendRunbookRow(tmpDir, { phase: 'phase1', ended_at: '2026-05-05T01:00:00Z' });
    appendRunbookRow(tmpDir, { phase: 'phase2', ended_at: '2026-05-05T01:05:00Z' });
    appendRunbookRow(tmpDir, { phase: 'phase3', ended_at: '2026-05-05T01:10:00Z' });
    const rows = parseRunbookRows(tmpDir);
    assert.deepEqual(rows.map((r) => r.phase), ['phase3', 'phase2', 'phase1']);
  });

  it('is idempotent over (phase, ended_at) — duplicate is no-op', () => {
    const row = { phase: 'phase1', ended_at: '2026-05-05T01:00:00Z' };
    const first = appendRunbookRow(tmpDir, row);
    const second = appendRunbookRow(tmpDir, row);
    assert.equal(first.appended, true);
    assert.equal(second.appended, false);
    assert.equal(second.reason, 'duplicate');
    assert.equal(parseRunbookRows(tmpDir).length, 1);
  });

  it('does NOT dedupe rows with empty ended_at (in-flight markers)', () => {
    appendRunbookRow(tmpDir, { phase: 'phase1', ended_at: '' });
    appendRunbookRow(tmpDir, { phase: 'phase1', ended_at: '' });
    assert.equal(parseRunbookRows(tmpDir).length, 2);
  });

  it('strips pipe + newline characters from cells (table integrity)', () => {
    appendRunbookRow(tmpDir, {
      phase: 'phase1|injected',
      ended_at: '2026\n05\n05',
      gates: 'H1✓ |bad',
    });
    const rows = parseRunbookRows(tmpDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phase, 'phase1 injected');
    assert.match(rows[0].ended_at, /^2026 05 05$/);
    assert.equal(rows[0].gates, 'H1✓  bad');
  });

  it('refuses rows with no phase', () => {
    const r = appendRunbookRow(tmpDir, { phase: '', ended_at: 'x' });
    assert.equal(r.appended, false);
    assert.equal(r.reason, 'missing-phase');
    assert.equal(existsSync(join(tmpDir, RUNBOOK_REL_PATH)), false);
  });
});

describe('parseRunbookRows', () => {
  it('returns [] when file is absent', () => {
    assert.deepEqual(parseRunbookRows(tmpDir), []);
  });

  it('skips header / separator / non-table lines', () => {
    mkdirSync(join(tmpDir, '.mpl', 'mpl'), { recursive: true });
    writeFileSync(join(tmpDir, RUNBOOK_REL_PATH),
      '# Heading\n\n' +
      '| phase | started_at | ended_at | gates | wall_min | fix_loops |\n' +
      '|---|---|---|---|---|---|\n' +
      '| phase-1 | t0 | t1 | H1✓ | 5 | 0 |\n' +
      '\n' +
      'free-form prose mid-file\n' +
      '| phase-2 | t1 | t2 | H1✗ | 3 | 1 |\n'
    );
    const rows = parseRunbookRows(tmpDir);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].phase, 'phase-1');
    assert.equal(rows[1].phase, 'phase-2');
  });
});

describe('summarizeGates', () => {
  it('renders structured exit_codes (P0-1 / #102 shape)', () => {
    const ent = (e) => ({ command: 'x', exit_code: e, stdout_tail: '', timestamp: 'now' });
    const s = summarizeGates({
      gate_results: { hard1_baseline: ent(0), hard2_coverage: ent(1), hard3_resilience: ent(0) },
    });
    assert.equal(s, 'H1✓ H2✗ H3✓');
  });

  it('falls back to legacy booleans when no structured entries', () => {
    const s = summarizeGates({
      gate_results: { hard1_passed: true, hard2_passed: false, hard3_passed: null },
    });
    assert.equal(s, 'H1✓ H2✗ H3?');
  });

  it('handles missing gate_results', () => {
    assert.equal(summarizeGates({}), '');
    assert.equal(summarizeGates(null), '');
  });
});

describe('wallMinutes', () => {
  it('rounds to 1 decimal', () => {
    assert.equal(wallMinutes('2026-05-05T01:00:00Z', '2026-05-05T01:05:30Z'), '5.5');
  });
  it('returns empty when inputs missing or invalid', () => {
    assert.equal(wallMinutes('', 't'), '');
    assert.equal(wallMinutes('t', 't'), '');
    assert.equal(wallMinutes('2026-05-05T01:05:00Z', '2026-05-05T01:00:00Z'), '');
  });
});

/* ─────────────────────── writeState integration ────────────────────────── */

describe('writeState appends RUNBOOK row on phase transition (G2)', () => {
  function seed(state) {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify({
      schema_version: CURRENT_SCHEMA_VERSION,
      current_phase: 'phase1a-research',
      started_at: '2026-05-05T01:00:00Z',
      fix_loop_count: 0,
      fix_loop_history: [],
      user_intervention_count: 0,
      ...state,
    }));
  }

  it('appends a row when current_phase actually changes', () => {
    seed({});
    writeState(tmpDir, { current_phase: 'phase1b-plan' });
    const rows = parseRunbookRows(tmpDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phase, 'phase1a-research');
    // started_at falls back to state.started_at when no prior row.
    assert.equal(rows[0].started_at, '2026-05-05T01:00:00Z');
    assert.ok(rows[0].ended_at, 'ended_at must be populated');
  });

  it('does NOT append when current_phase is unchanged', () => {
    seed({});
    writeState(tmpDir, { fix_loop_count: 1 });
    assert.equal(parseRunbookRows(tmpDir).length, 0);
  });

  it('chains started_at off the previous row\'s ended_at', () => {
    seed({});
    writeState(tmpDir, { current_phase: 'phase1b-plan' });
    writeState(tmpDir, { current_phase: 'phase2-sprint' });
    const rows = parseRunbookRows(tmpDir);
    assert.equal(rows.length, 2);
    // Newest first: rows[0] = phase1b-plan, rows[1] = phase1a-research.
    // The newer row's started_at should equal the older row's ended_at.
    assert.equal(rows[0].started_at, rows[1].ended_at);
  });

  it('captures gate summary + fix_loops on transition', () => {
    const ent = (e) => ({ command: 'x', exit_code: e, stdout_tail: '', timestamp: 'now' });
    seed({
      current_phase: 'phase3-gate',
      gate_results: { hard1_baseline: ent(0), hard2_coverage: ent(0), hard3_resilience: ent(1) },
      fix_loop_count: 2,
      fix_loop_history: [{ phase: 'phase3-gate', count: 2, started_at: 't0' }],
    });
    writeState(tmpDir, { current_phase: 'phase4-fix' });
    const rows = parseRunbookRows(tmpDir);
    assert.equal(rows[0].phase, 'phase3-gate');
    assert.equal(rows[0].gates, 'H1✓ H2✓ H3✗');
    assert.equal(rows[0].fix_loops, '2');
  });

  it('does not block the state write on RUNBOOK I/O failure', () => {
    seed({});
    // Force the RUNBOOK directory to be a file so mkdir/write fails. The
    // state write must still succeed and persist current_phase change.
    mkdirSync(join(tmpDir, '.mpl', 'mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'mpl', 'RUNBOOK.md'), '\0\0not writable\0\0', { mode: 0o400 });
    // Best-effort: even if we can't truly make it unwritable, the
    // try/catch in recordRunbookTransition must keep writeState from
    // throwing.
    assert.doesNotThrow(() => writeState(tmpDir, { current_phase: 'phase2-sprint' }));
    const state = readState(tmpDir);
    assert.equal(state.current_phase, 'phase2-sprint');
  });
});
