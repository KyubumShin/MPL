/**
 * Tests — hooks/lib/policy/scheduler.mjs (Move #16).
 *
 * Covers the pure surfaces of the wave-scoped continuous-frontier
 * scheduler: validateWaveComposition, buildWaveState, claim/release,
 * dispatch_loop, detectImpactDrift, projectStateRows, route_to_phase.
 *
 * No git / fs interaction — all helpers here are pure or in-memory only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PHASE_LIFECYCLE_STATES,
  WAVE_REJECTION_CODES,
  mintExecutionContextId,
  resolveMaxPhaseWorkers,
  validateWaveComposition,
  buildWaveState,
  claim,
  release,
  dispatch_loop,
  detectImpactDrift,
  projectStateRows,
  route_to_phase,
} from '../lib/policy/scheduler.mjs';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function phase(id, opts = {}) {
  return {
    id,
    risk_level: opts.risk || 'MEDIUM',
    dependencies: opts.deps || [],
    impact: {
      create: opts.create || [],
      modify: opts.modify || [],
      affected_tests: opts.affected_tests || [],
    },
  };
}

// ---------------------------------------------------------------------------
// resolveMaxPhaseWorkers
// ---------------------------------------------------------------------------

describe('resolveMaxPhaseWorkers', () => {
  it('defaults to 2 when config is undefined', () => {
    assert.equal(resolveMaxPhaseWorkers(undefined), 2);
    assert.equal(resolveMaxPhaseWorkers({}), 2);
    assert.equal(resolveMaxPhaseWorkers({ parallelism: {} }), 2);
  });
  it('clamps to 1..3', () => {
    assert.equal(resolveMaxPhaseWorkers({ parallelism: { max_phase_workers: 0 } }), 1);
    assert.equal(resolveMaxPhaseWorkers({ parallelism: { max_phase_workers: -5 } }), 1);
    assert.equal(resolveMaxPhaseWorkers({ parallelism: { max_phase_workers: 999 } }), 3);
    assert.equal(resolveMaxPhaseWorkers({ parallelism: { max_phase_workers: 2 } }), 2);
  });
});

// ---------------------------------------------------------------------------
// validateWaveComposition
// ---------------------------------------------------------------------------

describe('validateWaveComposition', () => {
  it('passes when phases are independent and deps are closed', () => {
    const wave = {
      tier: 2, wave_index: 0,
      phases: [
        phase('p1', { create: ['src/a.ts'] }),
        phase('p2', { modify: ['src/b.ts'] }),
      ],
    };
    const r = validateWaveComposition(wave, { completed_phase_ids: [] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.reasons, []);
  });

  it('rejects HIGH-risk phases by default', () => {
    const wave = { tier: 2, wave_index: 0, phases: [phase('p1', { risk: 'HIGH' })] };
    const r = validateWaveComposition(wave);
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => x.code === WAVE_REJECTION_CODES.HIGH_RISK_PHASE));
  });

  it('allows HIGH-risk phases when reject_high_risk:false', () => {
    const wave = { tier: 2, wave_index: 0, phases: [phase('p1', { risk: 'HIGH' })] };
    const r = validateWaveComposition(wave, { reject_high_risk: false });
    assert.equal(r.ok, true);
  });

  it('detects file overlap on impact.create + impact.modify', () => {
    const wave = {
      tier: 2, wave_index: 0,
      phases: [
        phase('p1', { create: ['src/shared.ts'] }),
        phase('p2', { modify: ['src/shared.ts'] }),
      ],
    };
    const r = validateWaveComposition(wave);
    assert.equal(r.ok, false);
    const overlap = r.reasons.find((x) => x.code === WAVE_REJECTION_CODES.FILE_OVERLAP);
    assert.ok(overlap, 'expected file_overlap reason');
    assert.equal(overlap.phase_id, 'p2');
  });

  it('flags unmet dependencies on the dependency frontier', () => {
    const wave = {
      tier: 2, wave_index: 0,
      phases: [phase('p1', { deps: ['p0'] })],
    };
    const r = validateWaveComposition(wave, { completed_phase_ids: [] });
    assert.equal(r.ok, false);
    const dep = r.reasons.find((x) => x.code === WAVE_REJECTION_CODES.DEPENDENCY_FRONTIER);
    assert.ok(dep);
    assert.match(dep.detail, /p0/);
  });

  it('accepts when dependencies are in completed_phase_ids', () => {
    const wave = {
      tier: 2, wave_index: 0,
      phases: [phase('p1', { deps: ['p0'] })],
    };
    const r = validateWaveComposition(wave, { completed_phase_ids: ['p0'] });
    assert.equal(r.ok, true);
  });

  it('returns structured error for missing wave.phases', () => {
    const r = validateWaveComposition({});
    assert.equal(r.ok, false);
    assert.equal(r.reasons[0].code, WAVE_REJECTION_CODES.WAVE_EXECUTION_ERROR);
  });
});

// ---------------------------------------------------------------------------
// buildWaveState / claim / release
// ---------------------------------------------------------------------------

describe('buildWaveState', () => {
  it('respects max_phase_workers from config', () => {
    const w = buildWaveState({
      run_id: 'r1', tier: 1, wave_index: 0,
      phase_ids: ['a', 'b', 'c'],
      config: { parallelism: { max_phase_workers: 3 } },
    });
    assert.equal(w.slots.length, 3);
    assert.equal(w.wave_id, '1:0');
    assert.deepEqual(w.queue, ['a', 'b', 'c']);
    assert.equal(w.tier_parallel, true);
  });

  it('clamps oversized worker counts', () => {
    const w = buildWaveState({
      run_id: 'r1', tier: 1, wave_index: 0, phase_ids: ['a'],
      config: { parallelism: { max_phase_workers: 999 } },
    });
    assert.equal(w.slots.length, 3);
  });
});

describe('claim/release', () => {
  it('claims a free slot and mints a context', () => {
    const w = buildWaveState({ run_id: 'r1', tier: 1, wave_index: 0, phase_ids: ['a', 'b'], config: { parallelism: { max_phase_workers: 2 } } });
    const c1 = claim(w, 'a');
    assert.ok(c1);
    assert.equal(c1.phase_id, 'a');
    assert.equal(c1.slot_id, 0);
    assert.equal(typeof c1.execution_context_id, 'string');
    assert.equal(c1.execution_context_id.length, 32);
    assert.equal(w.running.length, 1);
    assert.deepEqual(w.queue, ['b']);
  });

  it('returns null when slots are exhausted', () => {
    const w = buildWaveState({ run_id: 'r1', tier: 1, wave_index: 0, phase_ids: ['a', 'b', 'c'], config: { parallelism: { max_phase_workers: 2 } } });
    assert.ok(claim(w, 'a'));
    assert.ok(claim(w, 'b'));
    assert.equal(claim(w, 'c'), null);
  });

  it('tier_mutex serializes parallel:false tiers', () => {
    const w = buildWaveState({
      run_id: 'r1', tier: 1, wave_index: 0, phase_ids: ['a', 'b'],
      config: { parallelism: { max_phase_workers: 3 } },
      tier_parallel: false,
    });
    const c1 = claim(w, 'a');
    assert.ok(c1);
    assert.equal(claim(w, 'b'), null, 'tier_mutex must block second claim');
    release(w, 'a', { outcome: PHASE_LIFECYCLE_STATES.COMPLETED });
    const c2 = claim(w, 'b');
    assert.ok(c2, 'claim must succeed once mutex is released');
  });

  it('release frees the slot and updates lifecycle buckets', () => {
    const w = buildWaveState({ run_id: 'r1', tier: 1, wave_index: 0, phase_ids: ['a'], config: { parallelism: { max_phase_workers: 1 } } });
    claim(w, 'a');
    release(w, 'a', { outcome: PHASE_LIFECYCLE_STATES.COMPLETED });
    assert.deepEqual(w.completed, ['a']);
    assert.deepEqual(w.failed, []);
    assert.equal(w.slots[0].phase_id, null);
    assert.equal(w.running.length, 0);
  });

  it('FAILED outcome populates failed[]', () => {
    const w = buildWaveState({ run_id: 'r1', tier: 1, wave_index: 0, phase_ids: ['a'], config: { parallelism: { max_phase_workers: 1 } } });
    claim(w, 'a');
    release(w, 'a', { outcome: PHASE_LIFECYCLE_STATES.FAILED, reason: 'baseline_red' });
    assert.deepEqual(w.failed, [{ phase_id: 'a', reason: 'baseline_red' }]);
    assert.deepEqual(w.completed, []);
  });
});

// ---------------------------------------------------------------------------
// dispatch_loop
// ---------------------------------------------------------------------------

describe('dispatch_loop', () => {
  it('claims every queued phase up to slot capacity in one tick', () => {
    const w = buildWaveState({ run_id: 'r1', tier: 1, wave_index: 0, phase_ids: ['a', 'b', 'c'], config: { parallelism: { max_phase_workers: 2 } } });
    const seen = [];
    const got = dispatch_loop(w, { route_fn: (ctx) => seen.push(ctx.phase_id) });
    assert.equal(got.length, 2);
    assert.deepEqual(seen, ['a', 'b']);
    assert.deepEqual(w.queue, ['c']);
  });

  it('honors ready_predicate vetoes', () => {
    const w = buildWaveState({ run_id: 'r1', tier: 1, wave_index: 0, phase_ids: ['a', 'b'], config: { parallelism: { max_phase_workers: 2 } } });
    const got = dispatch_loop(w, { ready_predicate: (pid) => pid === 'b' });
    assert.equal(got.length, 1);
    assert.equal(got[0].phase_id, 'b');
  });

  it('integrates with acquire_slot: writes worktree_root onto the ctx', () => {
    const w = buildWaveState({ run_id: 'r1', tier: 1, wave_index: 0, phase_ids: ['a'], config: { parallelism: { max_phase_workers: 1 } } });
    const got = dispatch_loop(w, {
      acquire_slot: (ctx) => ({ worktree_root: `/tmp/slot-${ctx.slot_id}` }),
    });
    assert.equal(got.length, 1);
    assert.equal(got[0].worktree_root, '/tmp/slot-0');
    assert.equal(w.slots[0].worktree_root, '/tmp/slot-0');
  });

  it('ABANDONED when acquire_slot returns null', () => {
    const w = buildWaveState({ run_id: 'r1', tier: 1, wave_index: 0, phase_ids: ['a'], config: { parallelism: { max_phase_workers: 1 } } });
    dispatch_loop(w, { acquire_slot: () => null });
    assert.equal(w.running.length, 0);
    assert.equal(w.failed.length, 1);
    assert.equal(w.failed[0].reason, 'acquire_slot_failed');
  });
});

// ---------------------------------------------------------------------------
// detectImpactDrift
// ---------------------------------------------------------------------------

describe('detectImpactDrift', () => {
  it('reports no drift when observed ⊆ declared', () => {
    const r = detectImpactDrift(
      { create: ['a.ts'], modify: ['b.ts'], affected_tests: ['t.spec.ts'] },
      ['a.ts', 'b.ts'],
    );
    assert.equal(r.drift, false);
    assert.deepEqual(r.undeclared, []);
  });

  it('reports drift when an undeclared path was written', () => {
    const r = detectImpactDrift(
      { create: ['a.ts'], modify: ['b.ts'] },
      ['a.ts', 'c.ts'],
    );
    assert.equal(r.drift, true);
    assert.deepEqual(r.undeclared, ['c.ts']);
  });

  it('lists missing_declared paths the phase claimed but never touched', () => {
    const r = detectImpactDrift(
      { create: ['a.ts', 'b.ts'] },
      ['a.ts'],
    );
    assert.deepEqual(r.missing_declared, ['b.ts']);
    assert.equal(r.drift, false); // missing-declared is not drift
  });
});

// ---------------------------------------------------------------------------
// projectStateRows
// ---------------------------------------------------------------------------

describe('projectStateRows', () => {
  it('mirrors running[] into state.running and phase_lifecycle', () => {
    const w = buildWaveState({ run_id: 'r1', tier: 2, wave_index: 1, phase_ids: ['a'], config: { parallelism: { max_phase_workers: 1 } } });
    claim(w, 'a');
    const rows = projectStateRows(w);
    assert.equal(rows.running.length, 1);
    assert.equal(rows.running[0].phase_id, 'a');
    assert.equal(rows.phase_lifecycle.a.status, PHASE_LIFECYCLE_STATES.RUNNING);
    assert.equal(rows.waves_in_flight[0].wave_id, '2:1');
  });

  it('completed + failed buckets project into phase_lifecycle', () => {
    const w = buildWaveState({ run_id: 'r1', tier: 2, wave_index: 1, phase_ids: ['a', 'b'], config: { parallelism: { max_phase_workers: 2 } } });
    claim(w, 'a'); claim(w, 'b');
    release(w, 'a', { outcome: PHASE_LIFECYCLE_STATES.COMPLETED });
    release(w, 'b', { outcome: PHASE_LIFECYCLE_STATES.FAILED, reason: 'gate2_red' });
    const rows = projectStateRows(w, { terminated_at: '2026-06-01T00:00:00Z' });
    assert.equal(rows.phase_lifecycle.a.status, PHASE_LIFECYCLE_STATES.COMPLETED);
    assert.equal(rows.phase_lifecycle.b.status, PHASE_LIFECYCLE_STATES.FAILED);
    assert.equal(rows.phase_lifecycle.b.reason, 'gate2_red');
  });
});

// ---------------------------------------------------------------------------
// route_to_phase resolver
// ---------------------------------------------------------------------------

describe('route_to_phase resolution chain', () => {
  it('priority (1) — env.MPL_EXEC_CTX wins when JSON-parsable', () => {
    const ctx = route_to_phase({
      event: { cwd: '/anything', toolInput: {} },
      state: { current_phase: 'phase-99' },
      env: { MPL_EXEC_CTX: JSON.stringify({ phase_id: 'phase-7', slot_id: 1 }) },
    });
    assert.equal(ctx.phase_id, 'phase-7');
    assert.equal(ctx.slot_id, 1);
  });

  it('priority (1) — env.MPL_PHASE_ID fallback when MPL_EXEC_CTX missing', () => {
    const ctx = route_to_phase({
      event: { cwd: '/anything', toolInput: {} },
      state: { current_phase: 'phase-99' },
      env: { MPL_PHASE_ID: 'phase-3' },
    });
    assert.equal(ctx.phase_id, 'phase-3');
  });

  it('priority (2) — cwd inside a known worktree_root', () => {
    const ctx = route_to_phase({
      event: { cwd: '/tmp/mpl-wt-r1/slot-0/src', toolInput: {} },
      state: {
        current_phase: 'phase-99',
        running: [
          { phase_id: 'phase-3', worktree_root: '/tmp/mpl-wt-r1/slot-0', slot_id: 0 },
          { phase_id: 'phase-4', worktree_root: '/tmp/mpl-wt-r1/slot-1', slot_id: 1 },
        ],
      },
      env: {},
    });
    assert.equal(ctx.phase_id, 'phase-3');
    assert.equal(ctx.slot_id, 0);
  });

  it('priority (2) — longest-prefix match wins on nested worktrees', () => {
    const ctx = route_to_phase({
      event: { cwd: '/tmp/mpl-wt-r1/slot-0/nested/inner', toolInput: {} },
      state: {
        running: [
          { phase_id: 'parent', worktree_root: '/tmp/mpl-wt-r1' },
          { phase_id: 'child', worktree_root: '/tmp/mpl-wt-r1/slot-0' },
        ],
      },
      env: {},
    });
    assert.equal(ctx.phase_id, 'child');
  });

  it('priority (3) — file_path lookup against impact.create/modify', () => {
    const ctx = route_to_phase({
      event: { cwd: '/elsewhere', toolInput: { file_path: 'src/feature.ts' } },
      state: {
        current_phase: 'phase-99',
        running: [
          { phase_id: 'phase-3', worktree_root: null },
        ],
        execution: {
          phase_details: [
            { id: 'phase-3', impact: { create: ['src/feature.ts'] } },
            { id: 'phase-4', impact: { modify: ['src/other.ts'] } },
          ],
        },
      },
      env: {},
    });
    assert.equal(ctx.phase_id, 'phase-3');
  });

  it('priority (4) — current_phase fallback marked _legacy', () => {
    const ctx = route_to_phase({
      event: { cwd: '/elsewhere', toolInput: {} },
      state: { current_phase: 'phase-99', started_at: '2026-06-01' },
      env: {},
    });
    assert.equal(ctx.phase_id, 'phase-99');
    assert.equal(ctx._legacy, true);
    assert.equal(ctx.run_id, '2026-06-01');
  });

  it('returns null when no resolver matches', () => {
    const ctx = route_to_phase({
      event: { cwd: '/elsewhere', toolInput: {} },
      state: null,
      env: {},
    });
    assert.equal(ctx, null);
  });

  it('malformed env.MPL_EXEC_CTX falls through (not throws)', () => {
    const ctx = route_to_phase({
      event: { cwd: '/x', toolInput: {} },
      state: { current_phase: 'phase-9' },
      env: { MPL_EXEC_CTX: 'not-json' },
    });
    assert.equal(ctx.phase_id, 'phase-9');
  });
});

// ---------------------------------------------------------------------------
// mintExecutionContextId
// ---------------------------------------------------------------------------

describe('mintExecutionContextId', () => {
  it('returns a 32-char hex string', () => {
    const id = mintExecutionContextId();
    assert.equal(typeof id, 'string');
    assert.equal(id.length, 32);
    assert.match(id, /^[0-9a-f]+$/);
  });
  it('returns unique ids on consecutive calls', () => {
    const seen = new Set();
    for (let i = 0; i < 100; i++) seen.add(mintExecutionContextId());
    assert.equal(seen.size, 100);
  });
});
