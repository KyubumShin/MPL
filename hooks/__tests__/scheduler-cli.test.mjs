/**
 * P2b — hooks/lib/policy/scheduler-cli.mjs.
 *
 * Both surfaces exercised:
 *   - In-process subcommand handlers (subPlanWave / subClaim / ...) so the
 *     unit suite stays fast.
 *   - Black-box `spawnSync` round trip on a representative subcommand
 *     (`plan-wave`) so we know the binary is invokable end-to-end via Bash.
 *
 * No actual git worktrees, no actual subagents — every fs touch lives in
 * a tmpdir.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  subPlanWave,
  subPlanTier,
  subValidateWave,
  subBuildWaveState,
  subClaim,
  subRelease,
  subDispatchTick,
  subProjectStateRows,
  subDetectImpactDrift,
  subRecordEvent,
  subClassifyWaveFailure,
} from '../lib/policy/scheduler-cli.mjs';
import { FAILURE_CODE_ALLOWLIST } from '../lib/mpl-scheduler-failure-codes.mjs';

const CLI_PATH = fileURLToPath(new URL('../lib/policy/scheduler-cli.mjs', import.meta.url));

function runCli(subcommand, input) {
  return spawnSync('node', [CLI_PATH, subcommand], {
    input: JSON.stringify(input || {}),
    encoding: 'utf-8',
  });
}

// ---------------------------------------------------------------------------
// pure subcommands (in-process)
// ---------------------------------------------------------------------------

describe('scheduler-cli — plan-wave', () => {
  it('plans a 3-phase wave with one file overlap', () => {
    const r = subPlanWave({
      cwd: '/repo',
      run_id: '2026-06-01T00:00:00Z',
      tier: 2,
      wave_index: 0,
      phase_ids: ['p1', 'p2', 'p3'],
      phases: [
        { id: 'p1', risk_level: 'LOW', dependencies: ['p0'], impact: { create: ['src/a.ts'] } },
        { id: 'p2', risk_level: 'LOW', dependencies: ['p0'], impact: { create: ['src/b.ts'] } },
        { id: 'p3', risk_level: 'LOW', dependencies: ['p0'], impact: { create: ['src/a.ts'] } },
      ],
      completed_phase_ids: ['p0'],
      config: { parallelism: { max_phase_workers: 2 } },
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.wave_state.queue, ['p1', 'p2']);
    assert.equal(r.wave_state.max_phase_workers, 2);
    assert.equal(r.wave_state.wave_id, '2:0');
    assert.ok(r.ready_but_blocked.some((x) => x.phase_id === 'p3' && x.code === 'file_overlap'));
  });

  it('rejects HIGH-risk phases at compose time', () => {
    const r = subPlanWave({
      run_id: 'r1', tier: 1, wave_index: 0,
      phase_ids: ['p1'],
      phases: [{ id: 'p1', risk_level: 'HIGH', dependencies: [], impact: {} }],
      completed_phase_ids: [],
      config: {},
    });
    assert.equal(r.ok, true);
    assert.equal(r.wave_state.queue.length, 0);
    assert.ok(r.ready_but_blocked.some((x) => x.code === 'high_risk_phase_rejected'));
  });
});

describe('scheduler-cli — plan-tier', () => {
  it('plans multiple waves as dependencies close within the same tier', () => {
    const r = subPlanTier({
      cwd: '/repo',
      run_id: '2026-06-01T00:00:00Z',
      tier: 2,
      phase_ids: ['p1', 'p2', 'p3'],
      phases: [
        { id: 'p1', risk_level: 'LOW', dependencies: [], impact: { create: ['src/a.ts'] } },
        { id: 'p2', risk_level: 'LOW', dependencies: ['p1'], impact: { create: ['src/b.ts'] } },
        { id: 'p3', risk_level: 'LOW', dependencies: ['p2'], impact: { create: ['src/c.ts'] } },
      ],
      completed_phase_ids: [],
      config: { parallelism: { max_phase_workers: 2 } },
    });
    assert.equal(r.ok, true);
    assert.equal(r.waves.length, 3);
    assert.deepEqual(r.waves.map((w) => w.wave_state.queue), [['p1'], ['p2'], ['p3']]);
    assert.deepEqual(r.unplanned_phase_ids, []);
  });

  it('replans file-overlap losers into a later wave', () => {
    const r = subPlanTier({
      cwd: '/repo',
      run_id: '2026-06-01T00:00:00Z',
      tier: 1,
      phase_ids: ['p1', 'p2', 'p3'],
      phases: [
        { id: 'p1', risk_level: 'LOW', dependencies: [], impact: { create: ['src/a.ts'] } },
        { id: 'p2', risk_level: 'LOW', dependencies: [], impact: { create: ['src/a.ts'] } },
        { id: 'p3', risk_level: 'LOW', dependencies: [], impact: { create: ['src/b.ts'] } },
      ],
      completed_phase_ids: [],
      config: { parallelism: { max_phase_workers: 2 } },
    });
    assert.equal(r.ok, true);
    assert.equal(r.waves.length, 2);
    assert.deepEqual(r.waves[0].wave_state.queue, ['p1', 'p3']);
    assert.deepEqual(r.waves[1].wave_state.queue, ['p2']);
    assert.ok(r.ready_but_blocked.some((x) => x.phase_id === 'p2' && x.code === 'file_overlap'));
  });
});

describe('scheduler-cli — validate-wave', () => {
  it('passes a clean wave', () => {
    const r = subValidateWave({
      wave: { phases: [{ id: 'p1', risk_level: 'LOW', dependencies: [], impact: { create: ['a'] } }] },
      completed_phase_ids: [],
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.reasons, []);
  });
});

describe('scheduler-cli — build-wave-state', () => {
  it('mints slots = max_phase_workers', () => {
    const r = subBuildWaveState({
      run_id: 'r1', tier: 1, wave_index: 0,
      phase_ids: ['p1', 'p2'],
      config: { parallelism: { max_phase_workers: 3 } },
    });
    assert.equal(r.ok, true);
    assert.equal(r.wave_state.slots.length, 3);
  });
});

describe('scheduler-cli — claim + release round trip', () => {
  it('claims and releases on a fresh wave_state', () => {
    const built = subBuildWaveState({
      run_id: 'r1', tier: 1, wave_index: 0, phase_ids: ['p1'],
      config: { parallelism: { max_phase_workers: 1 } },
    });
    const c = subClaim({ wave_state: built.wave_state, phase_id: 'p1' });
    assert.equal(c.ok, true);
    assert.equal(c.execution_context.phase_id, 'p1');
    assert.equal(c.wave_state.running.length, 1);

    const rel = subRelease({ wave_state: c.wave_state, phase_id: 'p1', outcome: 'COMPLETED' });
    assert.equal(rel.ok, true);
    assert.equal(rel.wave_state.running.length, 0);
    assert.deepEqual(rel.wave_state.completed, ['p1']);
  });
});

describe('scheduler-cli — dispatch-tick', () => {
  it('drains the queue up to max_phase_workers', () => {
    const built = subBuildWaveState({
      run_id: 'r1', tier: 1, wave_index: 0,
      phase_ids: ['p1', 'p2', 'p3'],
      config: { parallelism: { max_phase_workers: 2 } },
    });
    const t = subDispatchTick({ wave_state: built.wave_state });
    assert.equal(t.ok, true);
    assert.equal(t.dispatched.length, 2);
    assert.equal(t.wave_state.queue.length, 1);
  });
});

describe('scheduler-cli — project-state-rows', () => {
  it('projects running phases into RUNNING lifecycle entries', () => {
    const built = subBuildWaveState({
      run_id: 'r1', tier: 1, wave_index: 0,
      phase_ids: ['p1'],
      config: { parallelism: { max_phase_workers: 1 } },
    });
    subDispatchTick({ wave_state: built.wave_state });
    const r = subProjectStateRows({ wave_state: built.wave_state });
    assert.equal(r.ok, true);
    assert.equal(r.running.length, 1);
    assert.equal(r.phase_lifecycle['p1'].status, 'RUNNING');
    assert.equal(r.waves_in_flight.length, 1);
  });
});

describe('scheduler-cli — detect-impact-drift', () => {
  it('marks undeclared paths', () => {
    const r = subDetectImpactDrift({
      declared: { create: ['a.ts'] },
      observed: ['a.ts', 'b.ts'],
    });
    assert.equal(r.ok, true);
    assert.equal(r.drift, true);
    assert.deepEqual(r.undeclared, ['b.ts']);
  });
});

describe('scheduler-cli — classify-wave-failure', () => {
  it('maps git worktree errors to worktree_setup_error', () => {
    const r = subClassifyWaveFailure({ error_message: 'git worktree add failed: exit 128' });
    assert.equal(r.ok, true);
    assert.equal(r.failure_code, 'worktree_setup_error');
  });
  it('maps merge errors to merge_error', () => {
    const r = subClassifyWaveFailure({ error_message: 'merge_worktree failed for phase-3' });
    assert.equal(r.failure_code, 'merge_error');
  });
  it('maps unknown to unknown_runtime_error', () => {
    const r = subClassifyWaveFailure({ error_message: 'something completely unexpected happened' });
    assert.equal(r.failure_code, 'unknown_runtime_error');
  });
  it('respects an explicit hint when it is in the allowlist', () => {
    const r = subClassifyWaveFailure({ error_message: 'irrelevant', hint: 'stale_shard_base' });
    assert.equal(r.failure_code, 'stale_shard_base');
  });
  it('never returns a code outside the allowlist', () => {
    const r = subClassifyWaveFailure({ error_message: 'random text', hint: 'not_a_real_code' });
    assert.ok(FAILURE_CODE_ALLOWLIST.has(r.failure_code));
  });
});

// ---------------------------------------------------------------------------
// record-event — writes JSONL + state mirror
// ---------------------------------------------------------------------------

describe('scheduler-cli — record-event', () => {
  let cwd;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'mpl-sched-cli-'));
    mkdirSync(join(cwd, '.mpl'), { recursive: true });
    // Seed minimal state so writeState has something to merge over.
    writeFileSync(join(cwd, '.mpl', 'state.json'), JSON.stringify({
      schema_version: 7,
      pipeline_id: 'mpl-test',
      current_phase: 'phase2-sprint',
      started_at: '2026-06-01T00:00:00Z',
      phase_scheduler_history: [],
    }, null, 2));
  });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('appends one JSONL row and mirrors into state.phase_scheduler_history', () => {
    const r = subRecordEvent({
      event: {
        pipeline_id: 'mpl-test',
        run_started_at: '2026-06-01T00:00:00Z',
        recompose_count: 0,
        tier: 1, wave_index: 0,
        phases: ['p1', 'p2'],
        selected_mode: 'parallel',
        parallel_requested: true,
        worker_cap: 2,
        worktree_slots: [0, 1],
      },
    }, cwd);
    assert.equal(r.ok, true);
    assert.match(r.jsonl_path, /\.mpl\/mpl\/profile\/phase-scheduler\.jsonl$/);
    assert.ok(existsSync(r.jsonl_path));
    const lines = readFileSync(r.jsonl_path, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.selected_mode, 'parallel');
    assert.ok(row.timestamp, 'auto-fills timestamp');
    assert.equal(r.history_length, 1);
  });
});

// ---------------------------------------------------------------------------
// black-box CLI: stdin → stdout round trip
// ---------------------------------------------------------------------------

describe('scheduler-cli — black-box stdin/stdout', () => {
  it('plan-wave invokable via Bash', () => {
    const r = runCli('plan-wave', {
      run_id: 'r1', tier: 1, wave_index: 0,
      phase_ids: ['p1'],
      phases: [{ id: 'p1', risk_level: 'LOW', dependencies: [], impact: { create: ['a.ts'] } }],
      completed_phase_ids: [],
      config: {},
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.deepEqual(out.wave_state.queue, ['p1']);
  });

  it('plan-tier invokable via Bash', () => {
    const r = runCli('plan-tier', {
      run_id: 'r1', tier: 1,
      phase_ids: ['p1', 'p2'],
      phases: [
        { id: 'p1', risk_level: 'LOW', dependencies: [], impact: { create: ['a.ts'] } },
        { id: 'p2', risk_level: 'LOW', dependencies: ['p1'], impact: { create: ['b.ts'] } },
      ],
      completed_phase_ids: [],
      config: {},
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.deepEqual(out.waves.map((w) => w.wave_state.queue), [['p1'], ['p2']]);
  });

  it('malformed stdin → exit 64 with structured envelope', () => {
    const r = spawnSync('node', [CLI_PATH, 'plan-wave'], { input: 'not-json', encoding: 'utf-8' });
    assert.equal(r.status, 64);
    const env = JSON.parse(r.stdout);
    assert.equal(env.ok, false);
    assert.equal(env.error_name, 'MalformedStdin');
  });

  it('unknown subcommand → exit 64', () => {
    const r = runCli('not-a-subcommand', {});
    assert.equal(r.status, 64);
    const env = JSON.parse(r.stdout);
    assert.equal(env.error_name, 'UnknownSubcommand');
  });
});
