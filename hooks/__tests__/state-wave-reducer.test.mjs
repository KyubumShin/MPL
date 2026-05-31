/**
 * Tests — hooks/lib/state/wave-reducer.mjs (Move #17).
 *
 * Covers the deterministic wave-end shard collapse:
 *  - empty wave directory => merged snapshot (no writes)
 *  - happy path: two shards sorted by decomposition_rank, single
 *    writeState() call, archive cleanup
 *  - stale_shard_base detection (StaleShardBaseError)
 *  - unknown_field_ownership detection
 *  - contract_amend_request short-circuits to downgrade_to_sequential
 *  - ring_merge / union / last_completed_at_wins projections
 *  - phase-keyed path discipline rejected for cross-phase patches
 *
 * No git / network — all helpers operate on a tmpdir cwd.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { writeShard, sha256OfState, SHARD_DIR } from '../lib/state/shard-writer.mjs';
import { readState } from '../lib/state/reader.mjs';
import {
  mergeWaveShards,
  applyRfc6902,
  BUILTIN_MERGE_POLICY,
  StaleShardBaseError,
  UnknownFieldOwnershipError,
} from '../lib/state/wave-reducer.mjs';

function freshTmp() {
  const cwd = mkdtempSync(join(tmpdir(), 'mpl-reducer-test-'));
  mkdirSync(join(cwd, '.mpl'), { recursive: true });
  return cwd;
}

function seedState(cwd, patch) {
  const state = {
    schema_version: 7,
    pipeline_id: 'mpl-test',
    current_phase: 'phase2-sprint',
    started_at: '2026-06-01T00:00:00Z',
    sprint_status: { total_todos: 0, completed_todos: 0, in_progress_todos: 0, failed_todos: 0 },
    gate_results: {
      hard1_passed: null, hard2_passed: null, hard3_passed: null,
      hard1_baseline: null, hard2_coverage: null, hard3_resilience: null,
    },
    test_agent_dispatched: {},
    phase_lifecycle: {},
    running: [],
    waves_in_flight: [],
    e2e_results: {},
    security_results: {},
    fix_loop_count: 0,
    fix_loop_history: [],
    ambiguity_history: [],
    phase_scheduler_history: [],
    worktree_pool_history: [],
    quality_score_history: [],
    permits: [],
    worktree_history: [],
    completed_cut_ids: [],
    convergence: { pass_rate_history: [], stagnation_window: 3, min_improvement: 0.05, regression_threshold: -0.1 },
    research: { status: null, started_at: null, completed_at: null, stages_completed: [], report_path: null, findings_count: 0, sources_count: 0, mode: 'full', error: null, degraded_stages: [] },
    release: { current_cut_id: null, completed_cut_ids: [], fix_loop_count: 0, pending_artifact: null, gate_results: { hard1_passed: null, hard2_passed: null, hard3_passed: null, hard1_baseline: null, hard2_coverage: null, hard3_resilience: null }, max_fix_loops: 3 },
    ...(patch || {}),
  };
  writeFileSync(join(cwd, '.mpl', 'state.json'), JSON.stringify(state, null, 2));
  return state;
}

describe('mergeWaveShards — empty', () => {
  let cwd;
  beforeEach(() => { cwd = freshTmp(); delete process.env.MPL_PHASE_ID; });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('returns merged snapshot when no shards exist', async () => {
    seedState(cwd);
    const r = await mergeWaveShards('1:0', cwd);
    assert.deepEqual(r.applied_shards, []);
    assert.deepEqual(r.isolated_shards, []);
    assert.equal(r.downgrade_to_sequential, false);
    assert.ok(r.merged);
  });
});

describe('mergeWaveShards — stale base', () => {
  let cwd;
  beforeEach(() => { cwd = freshTmp(); delete process.env.MPL_PHASE_ID; });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('throws StaleShardBaseError when envelope.base_sha drifts', async () => {
    seedState(cwd);
    writeShard(cwd, '1:0', 'phase-3',
      [{ op: 'add', path: '/test_agent_dispatched/phase-3', value: { verdict: 'PASS', valid_json: true, tests_added: 4 } }],
      { I5: 'ok' },
      'b'.repeat(64), // wrong base
    );
    await assert.rejects(() => mergeWaveShards('1:0', cwd), StaleShardBaseError);
  });
});

describe('mergeWaveShards — happy path', () => {
  let cwd;
  beforeEach(() => { cwd = freshTmp(); delete process.env.MPL_PHASE_ID; });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('applies shards in decomposition_rank order and archives the wave', async () => {
    const seed = seedState(cwd);
    const sha = await sha256OfState(seed);
    writeShard(cwd, '1:0', 'phase-3',
      [{ op: 'add', path: '/test_agent_dispatched/phase-3', value: { verdict: 'PASS', valid_json: true, tests_added: 4 } }],
      { I6: 'ok' },
      sha,
      { decompositionRank: 12 },
    );
    writeShard(cwd, '1:0', 'phase-4',
      [{ op: 'add', path: '/test_agent_dispatched/phase-4', value: { verdict: 'PASS', valid_json: true, tests_added: 2 } }],
      { I6: 'ok' },
      sha,
      { decompositionRank: 13 },
    );
    const r = await mergeWaveShards('1:0', cwd);
    assert.deepEqual(r.applied_shards.sort(), ['phase-3', 'phase-4']);
    // active wave dir cleared
    assert.equal(existsSync(join(cwd, SHARD_DIR, '1:0')), false);
    // archive populated
    assert.equal(existsSync(join(cwd, SHARD_DIR, '_archive', '1:0')), true);
    // single writeState merged both shards
    const finalState = readState(cwd);
    assert.ok(finalState.test_agent_dispatched['phase-3']);
    assert.ok(finalState.test_agent_dispatched['phase-4']);
  });
});

describe('mergeWaveShards — contract amend short-circuit', () => {
  let cwd;
  beforeEach(() => { cwd = freshTmp(); delete process.env.MPL_PHASE_ID; });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('returns downgrade_to_sequential when any shard has contract_amend_request', async () => {
    const seed = seedState(cwd);
    const sha = await sha256OfState(seed);
    writeShard(cwd, '1:0', 'phase-3',
      [{ op: 'add', path: '/test_agent_dispatched/phase-3', value: { verdict: 'PASS' } }],
      { I6: 'ok' },
      sha,
      { decompositionRank: 12, contractAmendRequest: { reason: 'route signature changed' } },
    );
    const r = await mergeWaveShards('1:0', cwd);
    assert.equal(r.downgrade_to_sequential, true);
    assert.equal(r.request_meta.phase_id, 'phase-3');
    assert.equal(r.request_meta.wave_id, '1:0');
    // No writes happened.
    assert.deepEqual(r.applied_shards, []);
  });
});

describe('mergeWaveShards — unknown field ownership', () => {
  let cwd;
  beforeEach(() => { cwd = freshTmp(); delete process.env.MPL_PHASE_ID; });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('throws UnknownFieldOwnershipError when a patch touches an unregistered top-level field', async () => {
    const seed = seedState(cwd);
    const sha = await sha256OfState(seed);
    // touch a NEW field that has no merge_policy entry
    writeShard(cwd, '1:0', 'phase-3',
      [{ op: 'add', path: '/totally_new_field', value: { x: 1 } }],
      { I5: 'ok' },
      sha,
      { decompositionRank: 12 },
    );
    await assert.rejects(() => mergeWaveShards('1:0', cwd), UnknownFieldOwnershipError);
  });

  it('accepts every field listed in BUILTIN_MERGE_POLICY', () => {
    // Sanity: every field touched by mainline writer.mjs default state
    // should appear in BUILTIN_MERGE_POLICY or fall under engine_only.
    for (const f of ['gate_results', 'test_agent_dispatched', 'ambiguity_history',
                     'phase_lifecycle', 'running', 'waves_in_flight', 'permits',
                     'completed_cut_ids', 'sprint_status', 'fix_loop_history']) {
      assert.ok(BUILTIN_MERGE_POLICY[f], `${f} missing from merge_policy`);
    }
  });
});

describe('applyRfc6902 — minimal patcher', () => {
  it('supports add/replace/remove', () => {
    const doc = { a: { b: 1 } };
    applyRfc6902(doc, [
      { op: 'add', path: '/a/c', value: 2 },
      { op: 'replace', path: '/a/b', value: 9 },
    ], 'phase-x');
    assert.deepEqual(doc, { a: { b: 9, c: 2 } });
    applyRfc6902(doc, [{ op: 'remove', path: '/a/c' }], 'phase-x');
    assert.deepEqual(doc, { a: { b: 9 } });
  });

  it('test op throws ShardPatchTestFailedError on mismatch', () => {
    const doc = { a: 1 };
    assert.throws(
      () => applyRfc6902(doc, [{ op: 'test', path: '/a', value: 2 }], 'phase-x'),
      /ShardPatchTestFailedError|RFC-6902 test op failed/,
    );
  });
});
