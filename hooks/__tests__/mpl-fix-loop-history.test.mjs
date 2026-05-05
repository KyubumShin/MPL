import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  readState,
  writeState,
  CURRENT_SCHEMA_VERSION,
} from '../lib/mpl-state.mjs';
import { checkInvariants, VIOLATION_IDS } from '../lib/mpl-state-invariant.mjs';

let tmpDir;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'mpl-fix-loop-')); });
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

function seed(state) {
  mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
  writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify({
    schema_version: CURRENT_SCHEMA_VERSION,
    current_phase: 'phase4-fix',
    fix_loop_count: 0,
    fix_loop_history: [],
    user_intervention_count: 0,
    ...state,
  }));
}

/* ──────────────────────── G5: fix_loop_history ───────────────────────── */

describe('G5 (#114) fix_loop_history mirror', () => {
  it('preserve write (same fix_loop_count) does NOT append', () => {
    seed({ fix_loop_count: 2, fix_loop_history: [{ phase: 'phase4-fix', count: 2, started_at: 't0' }] });
    const merged = writeState(tmpDir, { fix_loop_count: 2 });
    assert.equal(merged.fix_loop_history.length, 1);
    assert.equal(merged.fix_loop_history[0].count, 2);
  });

  it('first increment under a new phase appends a fresh entry', () => {
    seed({});
    const merged = writeState(tmpDir, { fix_loop_count: 1 });
    assert.equal(merged.fix_loop_history.length, 1);
    assert.equal(merged.fix_loop_history[0].phase, 'phase4-fix');
    assert.equal(merged.fix_loop_history[0].count, 1);
    assert.ok(typeof merged.fix_loop_history[0].started_at === 'string');
  });

  it('subsequent increment under the same phase bumps the existing entry by the delta', () => {
    seed({});
    writeState(tmpDir, { fix_loop_count: 1 });
    writeState(tmpDir, { fix_loop_count: 3 });
    const state = readState(tmpDir);
    assert.equal(state.fix_loop_history.length, 1, 'still one open entry');
    assert.equal(state.fix_loop_history[0].count, 3, 'cumulative count');
  });

  it('phase change opens a new history entry', () => {
    seed({});
    writeState(tmpDir, { fix_loop_count: 2 });
    const after = writeState(tmpDir, {
      current_phase: 'small-sprint',
      fix_loop_count: 5,
    });
    assert.equal(after.fix_loop_history.length, 2);
    assert.equal(after.fix_loop_history[0].phase, 'phase4-fix');
    assert.equal(after.fix_loop_history[0].count, 2);
    assert.equal(after.fix_loop_history[1].phase, 'small-sprint');
    assert.equal(after.fix_loop_history[1].count, 3, 'delta only, not cumulative');
  });

  it('execution.phases.current (concrete phase id) wins over current_phase lifecycle marker', () => {
    seed({});
    writeState(tmpDir, {
      current_phase: 'phase4-fix',
      execution: { phases: { current: 'phase-3', total: 0, completed: 0, failed: 0, circuit_breaks: 0 } },
      fix_loop_count: 1,
    });
    const state = readState(tmpDir);
    assert.equal(state.fix_loop_history[0].phase, 'phase-3', 'concrete id beats lifecycle marker');
  });

  it('PR #133 review #3: reset to 0 clears history (I5 atomic)', () => {
    // The old "history retained for forensic value" framing left I5 in
    // a violated state (count=0, sum>0). Forensic value lives in
    // .mpl/archive/ snapshots taken by archivePreviousRun, not in the
    // live state file.
    seed({});
    writeState(tmpDir, { fix_loop_count: 3 });
    const after = writeState(tmpDir, { fix_loop_count: 0 });
    assert.equal(after.fix_loop_count, 0);
    assert.deepEqual(after.fix_loop_history, [], 'reset clears history');
    // I5 holds: 0 == 0
    const sum = after.fix_loop_history.reduce((acc, e) => acc + (e.count || 0), 0);
    assert.equal(sum, after.fix_loop_count);
  });

  it('PR #133 review #3: partial decrement (not reset) refuses both fields', () => {
    seed({});
    writeState(tmpDir, { fix_loop_count: 5 });
    const after = writeState(tmpDir, { fix_loop_count: 3 });
    // Partial wind-back has no legitimate orchestrator caller → reverted.
    assert.equal(after.fix_loop_count, 5, 'count reverted');
    assert.equal(after.fix_loop_history.reduce((acc, e) => acc + e.count, 0), 5,
      'history reverted to match');
  });

  it('non-numeric or absent fix_loop_count → no history change', () => {
    seed({ fix_loop_count: 2, fix_loop_history: [{ phase: 'phase4-fix', count: 2, started_at: 't' }] });
    const merged = writeState(tmpDir, { current_phase: 'phase5-finalize' });
    assert.equal(merged.fix_loop_history.length, 1);
    assert.equal(merged.fix_loop_history[0].count, 2);
  });

  it('PR #133 review nit: increment with no determinable phase → revert to keep I5 clean', () => {
    // Both current_phase and execution.phases.current absent → helper
    // refuses the bump. fix_loop_count stays at the prior value, history
    // is untouched, I5 invariant holds (count == sum == prior).
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify({
      schema_version: CURRENT_SCHEMA_VERSION,
      current_phase: 'phase2-sprint',
      fix_loop_count: 0,
      fix_loop_history: [],
      user_intervention_count: 0,
    }));
    // Patch sets fix_loop_count but explicitly clears current_phase to
    // null and provides no execution.phases.current.
    const merged = writeState(tmpDir, {
      current_phase: null,
      fix_loop_count: 5,
    });
    assert.equal(merged.fix_loop_count, 0, 'count reverted to prior value');
    assert.deepEqual(merged.fix_loop_history, [], 'history untouched');
    // I5 holds: count(0) == sum(0).
    const sum = merged.fix_loop_history.reduce((acc, e) => acc + (e.count || 0), 0);
    assert.equal(sum, merged.fix_loop_count);
  });

  it('PR #133 review #3: phase-null + patch-supplied history reverts BOTH fields', () => {
    // Reviewer's repro 1 — caller supplies a parallel history array but
    // also clears the phase. Old code reverted only the count, leaving
    // patch's history merged in (I5 desync). New code reverts both.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify({
      schema_version: CURRENT_SCHEMA_VERSION,
      current_phase: 'phase4-fix',
      fix_loop_count: 0,
      fix_loop_history: [],
      user_intervention_count: 0,
    }));
    const after = writeState(tmpDir, {
      current_phase: null,
      fix_loop_count: 5,
      fix_loop_history: [{ phase: 'manual', count: 5, started_at: 't' }],
    });
    assert.equal(after.fix_loop_count, 0, 'count reverted');
    assert.deepEqual(after.fix_loop_history, [], 'history reverted to pre-merge');
    // I5: 0 == 0.
    const sum = after.fix_loop_history.reduce((acc, e) => acc + (e.count || 0), 0);
    assert.equal(sum, after.fix_loop_count);
  });

  it('PR #133 review #4: increment ON TOP OF legacy numeric-entry history works', () => {
    // G3 sumFixLoopHistory accepts bare numbers as legacy/compat entries.
    // Reviewer's reproducer: history=[1,2] (sum=3), count=3, then
    // increment to count=4 should add a new entry of count=1, leaving
    // total sum=4 == count. Pre-fix the writer's final check summed
    // only {count} objects (ignoring numbers), saw sum=1, mismatched
    // count=4, and silently reverted.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify({
      schema_version: CURRENT_SCHEMA_VERSION,
      current_phase: 'phase4-fix',
      fix_loop_count: 3,
      fix_loop_history: [1, 2],
      user_intervention_count: 0,
    }));
    const after = writeState(tmpDir, { fix_loop_count: 4 });
    assert.equal(after.fix_loop_count, 4, 'increment landed (not silently reverted)');
    // Last entry appended (we can't merge into a bare number — no phase)
    assert.equal(after.fix_loop_history.length, 3);
    assert.equal(after.fix_loop_history[2].phase, 'phase4-fix');
    assert.equal(after.fix_loop_history[2].count, 1);
    // I5 invariant equivalence: sum the same way G3 does.
    const sum = after.fix_loop_history.reduce(
      (acc, e) => acc + (typeof e === 'number' ? e : (e?.count ?? 0)),
      0
    );
    assert.equal(sum, after.fix_loop_count);
  });

  it('PR #133 review #4: unparseable entry → revert (matches invariant "not measurable")', () => {
    // Defensive: if any entry is neither a number nor a {count} object,
    // sumFixLoopHistoryForCheck returns null and the writer reverts both
    // fields. Mirrors sumFixLoopHistory's "return null" disposition.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify({
      schema_version: CURRENT_SCHEMA_VERSION,
      current_phase: 'phase4-fix',
      fix_loop_count: 0,
      fix_loop_history: [],
      user_intervention_count: 0,
    }));
    const after = writeState(tmpDir, {
      fix_loop_count: 5,
      fix_loop_history: ['garbage', { phase: 'p', count: 5 }],
    });
    assert.equal(after.fix_loop_count, 0, 'unparseable entry → revert');
    assert.deepEqual(after.fix_loop_history, []);
  });

  it('PR #133 review #3: patch with self-inconsistent history triggers final I5 revert', () => {
    // Caller provides a history whose sum disagrees with the count delta
    // → final I5 check catches it and reverts both atomically.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify({
      schema_version: CURRENT_SCHEMA_VERSION,
      current_phase: 'phase4-fix',
      fix_loop_count: 2,
      fix_loop_history: [{ phase: 'phase4-fix', count: 2, started_at: 't0' }],
      user_intervention_count: 0,
    }));
    // Caller bumps count to 3 but supplies a history that sums to 99.
    const after = writeState(tmpDir, {
      fix_loop_count: 3,
      fix_loop_history: [{ phase: 'phase4-fix', count: 99, started_at: 't1' }],
    });
    // Both reverted to prev so the live state stays consistent.
    assert.equal(after.fix_loop_count, 2);
    assert.equal(after.fix_loop_history[0].count, 2);
    assert.equal(after.fix_loop_history.length, 1);
  });

  it('G3 invariant I5 equality holds across a sequence of writes', () => {
    seed({});
    writeState(tmpDir, { fix_loop_count: 1 });
    writeState(tmpDir, { fix_loop_count: 2 });
    writeState(tmpDir, { current_phase: 'small-sprint', fix_loop_count: 3 });
    const state = readState(tmpDir);
    const sum = state.fix_loop_history.reduce((acc, e) => acc + (e.count || 0), 0);
    assert.equal(sum, state.fix_loop_count,
      'fix_loop_count must equal sum(fix_loop_history[].count) — G3 I5');
  });
});

/* ──────────────────────── v2 → v3 migration ──────────────────────────── */

describe('v2 → v3 migration (#114): additive backfill', () => {
  it('adds fix_loop_history: [] and user_intervention_count: 0 on first read', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify({
      schema_version: 2,
      current_phase: 'phase2-sprint',
      fix_loop_count: 0,
    }));
    const state = readState(tmpDir);
    assert.equal(state.schema_version, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(state.fix_loop_history, []);
    assert.equal(state.user_intervention_count, 0);
  });

  it('preserves an existing fix_loop_history that the v2 state already carried', () => {
    // Forward-compat case: a v2 writer already populated the array (the
    // schema doc allowed it as optional in v0.18.0). Migration must not
    // reset to [].
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify({
      schema_version: 2,
      current_phase: 'phase2-sprint',
      fix_loop_count: 4,
      fix_loop_history: [{ phase: 'phase-1', count: 4 }],
    }));
    const state = readState(tmpDir);
    assert.equal(state.schema_version, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(state.fix_loop_history, [{ phase: 'phase-1', count: 4 }]);
  });

  it('persists v3 fields to disk so subsequent reads short-circuit', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify({
      schema_version: 2,
      current_phase: 'phase2-sprint',
    }));
    readState(tmpDir);
    const raw = JSON.parse(readFileSync(join(tmpDir, '.mpl', 'state.json'), 'utf-8'));
    assert.equal(raw.schema_version, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(raw.fix_loop_history, []);
    assert.equal(raw.user_intervention_count, 0);
  });

  it('PR #133 review #1: v2 mid-run with fix_loop_count > 0 → conservative aggregate entry, I5 holds', () => {
    // Pre-fix bug: backfilling [] when fix_loop_count > 0 would instantly
    // trip G3 I5 (count=N, sum=0) on the first read after upgrade. Migration
    // must synthesize an aggregate entry so the invariant survives.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify({
      schema_version: 2,
      current_phase: 'phase4-fix',
      fix_loop_count: 4,
    }));
    const state = readState(tmpDir);

    assert.equal(state.fix_loop_history.length, 1, 'one aggregate entry created');
    const entry = state.fix_loop_history[0];
    assert.equal(entry.count, 4, 'entry count matches fix_loop_count');
    assert.equal(entry.phase, 'phase4-fix', 'phase attribution from current_phase');
    assert.equal(entry.migrated_from_v2, true, 'forensic flag set');
    assert.ok(typeof entry.started_at === 'string', 'started_at populated');

    // The actual reviewer assertion: G3 I5 must NOT fire post-migration.
    const r = checkInvariants(state, { cwd: tmpDir });
    assert.ok(
      !r.violations.some((v) => v.id === VIOLATION_IDS.FIX_LOOP_HISTORY_DESYNC),
      `expected no I5 violation, got: ${JSON.stringify(r.violations, null, 2)}`,
    );
  });

  it('PR #133 review #1: v2 with fix_loop_count = 0 still backfills to []', () => {
    // Carry-forward only triggers when count > 0 — a fresh / untouched
    // pipeline keeps the empty array.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify({
      schema_version: 2,
      current_phase: 'phase2-sprint',
      fix_loop_count: 0,
    }));
    const state = readState(tmpDir);
    assert.deepEqual(state.fix_loop_history, []);
  });

  it('PR #133 review #1: phase attribution prefers execution.phases.current', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify({
      schema_version: 2,
      current_phase: 'phase4-fix',
      fix_loop_count: 2,
      execution: {
        phases: { current: 'phase-7', total: 0, completed: 0, failed: 0, circuit_breaks: 0 },
      },
    }));
    const state = readState(tmpDir);
    assert.equal(state.fix_loop_history[0].phase, 'phase-7');
  });
});
