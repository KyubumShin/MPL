/**
 * P2b — hooks/lib/state/wave-reducer-cli.mjs.
 *
 * Black-box `spawnSync` round trip over the `merge` subcommand.
 *  - empty wave → ok:true, applied_shards:[]
 *  - happy path → ok:true with applied_shards
 *  - stale base → ok:false with failure_code:stale_shard_base
 *  - malformed stdin → exit 64
 *
 * No actual subagents — every fs touch lives under a tmpdir.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeShard, sha256OfState } from '../lib/state/shard-writer.mjs';

const CLI_PATH = fileURLToPath(new URL('../lib/state/wave-reducer-cli.mjs', import.meta.url));

function runCli(input) {
  return spawnSync('node', [CLI_PATH, 'merge'], {
    input: JSON.stringify(input || {}),
    encoding: 'utf-8',
  });
}

function seedState(cwd) {
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
  };
  writeFileSync(join(cwd, '.mpl', 'state.json'), JSON.stringify(state, null, 2));
  return state;
}

describe('wave-reducer-cli — merge', () => {
  let cwd;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'mpl-reducer-cli-'));
    mkdirSync(join(cwd, '.mpl'), { recursive: true });
    delete process.env.MPL_PHASE_ID;
  });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('returns ok:true with empty applied_shards on a wave with no shards', () => {
    seedState(cwd);
    const r = runCli({ cwd, wave_id: '1:0' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.deepEqual(out.applied_shards, []);
    assert.equal(out.downgrade_to_sequential, false);
    assert.ok(out.merged_summary);
  });

  it('applies a well-formed shard', async () => {
    const seeded = seedState(cwd);
    const base = await sha256OfState(seeded);
    writeShard(
      cwd, '1:0', 'phase-3',
      [{ op: 'add', path: '/test_agent_dispatched/phase-3', value: { verdict: 'PASS', valid_json: true, tests_added: 4 } }],
      { I5: 'ok' },
      base,
    );
    const r = runCli({ cwd, wave_id: '1:0' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.deepEqual(out.applied_shards, ['phase-3']);
  });

  it('classifies stale base → failure_code:stale_shard_base with exit 1', () => {
    seedState(cwd);
    writeShard(
      cwd, '1:0', 'phase-3',
      [{ op: 'add', path: '/test_agent_dispatched/phase-3', value: { verdict: 'PASS' } }],
      { I5: 'ok' },
      'b'.repeat(64), // wrong base
    );
    const r = runCli({ cwd, wave_id: '1:0' });
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.failure_code, 'stale_shard_base');
    assert.equal(out.error_name, 'StaleShardBaseError');
    assert.ok(out.error_payload.drift_shards.includes('phase-3'));
  });

  it('malformed stdin → exit 64', () => {
    const r = spawnSync('node', [CLI_PATH, 'merge'], { input: 'not-json', encoding: 'utf-8' });
    assert.equal(r.status, 64);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.error_name, 'MalformedStdin');
  });

  it('missing wave_id → exit 64', () => {
    const r = runCli({ cwd: '/tmp/anything' });
    assert.equal(r.status, 64);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.match(out.error_message, /wave_id/);
  });

  it('unknown subcommand → exit 64', () => {
    const r = spawnSync('node', [CLI_PATH, 'not-a-subcommand'], { input: '{}', encoding: 'utf-8' });
    assert.equal(r.status, 64);
    const out = JSON.parse(r.stdout);
    assert.equal(out.error_name, 'UnknownSubcommand');
  });
});
