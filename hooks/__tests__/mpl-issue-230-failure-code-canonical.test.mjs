/**
 * #230 — Canonical `failure_code` separation + per-event runtime cause.
 *
 * Before this issue, `parallel_failed` events carried only a free-form
 * `failure_reason: err.message` and the scheduler aggregator unioned
 * that string into `rejection_reasons`. Two attack shapes survived
 * #214's vocabulary gate:
 *
 *  (1) Paraphrase bypass — an explanation could repeat the free-form
 *      `failure_reason` verbatim and pass the canonical-vocabulary
 *      check, even though `"worker dispatch failed"` is exactly the
 *      kind of paraphrase #214 was meant to block.
 *
 *  (2) Masked runtime cause — a `parallel_failed` event with both
 *      pre-attempt `rejection_reasons_by_phase` AND a runtime
 *      `failure_reason` could be explained by the planning token
 *      alone, hiding the runtime failure.
 *
 * The fix introduces a canonical `failure_code` enum on
 * parallel_failed events; the aggregator surfaces it under
 * `failure_codes` SEPARATELY from `rejection_reasons`; the finalize
 * gate requires EVERY computed code to appear verbatim in
 * `no_parallel_explanation` independently of the rejection-reason
 * axis.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

import {
  FAILURE_CODE_ALLOWLIST,
  isCanonicalFailureCode,
} from '../lib/mpl-scheduler-failure-codes.mjs';
import {
  aggregateScheduler,
  explanationRequiredFromAggregate,
} from '../lib/mpl-scheduler-aggregate.mjs';

const PIPELINE_ID = 'mpl-230-test';
const STARTED_AT = '2026-05-30T00:00:00.000Z';

function decompositionYaml() {
  return `
recompose_count: 0
execution_tiers:
  - tier: 1
    parallel: true
    phases: [phase-1, phase-2]
phases:
  - id: phase-1
  - id: phase-2
`;
}

function writeWorkspace(tmp, events) {
  mkdirSync(join(tmp, '.mpl', 'mpl', 'profile'), { recursive: true });
  writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), decompositionYaml());
  writeFileSync(
    join(tmp, '.mpl', 'mpl', 'profile', 'phase-scheduler.jsonl'),
    events.map((e) => JSON.stringify({
      pipeline_id: PIPELINE_ID,
      run_started_at: STARTED_AT,
      recompose_count: 0,
      ...e,
    })).join('\n') + '\n',
  );
}

function fakeState() {
  return {
    pipeline_id: PIPELINE_ID,
    started_at: STARTED_AT,
    phase_scheduler_history: [],
  };
}

// ---------------------------------------------------------------------------
// Allowlist surface
// ---------------------------------------------------------------------------

describe('#230 allowlist', () => {
  it('exposes the five canonical failure codes (extended in Move #17; v1 codes still preserved)', () => {
    // Move #17 extended the Set to 11 (5 legacy v1 + 6 wave-reducer/reconcile).
    // The #230 contract is: every v1 code MUST still be canonical.
    const codes = [...FAILURE_CODE_ALLOWLIST];
    for (const code of [
      'merge_error',
      'unknown_runtime_error',
      'wave_execution_error',
      'worker_dispatch_error',
      'worktree_setup_error',
    ]) {
      assert.ok(codes.includes(code), `#230 legacy code missing: ${code}`);
    }
  });
  it('isCanonicalFailureCode accepts allowlisted codes only', () => {
    assert.equal(isCanonicalFailureCode('worker_dispatch_error'), true);
    assert.equal(isCanonicalFailureCode('worktree_setup_error'), true);
    assert.equal(isCanonicalFailureCode('worker dispatch failed'), false);
    assert.equal(isCanonicalFailureCode(''), false);
    assert.equal(isCanonicalFailureCode(null), false);
    assert.equal(isCanonicalFailureCode(undefined), false);
    assert.equal(isCanonicalFailureCode(42), false);
  });
});

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

describe('#230 aggregator', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mpl-230-agg-')); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('surfaces canonical failure_code in failure_codes[] (not in rejection_reasons)', () => {
    writeWorkspace(tmp, [
      {
        tier: 1, wave_index: 0,
        timestamp: '2026-05-30T00:01:00.000Z',
        phases: ['phase-1', 'phase-2'],
        selected_mode: 'parallel_failed',
        parallel_requested: true,
        worker_cap: 2,
        worktree_slots: [],
        failure_code: 'worker_dispatch_error',
        failure_reason: 'worker dispatch failed: ENOENT spawning node',
      },
    ]);
    const agg = aggregateScheduler(tmp, fakeState());
    assert.deepEqual(agg.failure_codes, ['worker_dispatch_error']);
    // The free-form failure_reason must NOT enter rejection_reasons —
    // that's the paraphrase-bypass surface #230 closes.
    assert.equal(agg.rejection_reasons.includes('worker dispatch failed: ENOENT spawning node'), false);
  });

  it('drops non-canonical failure_code values silently', () => {
    writeWorkspace(tmp, [
      {
        tier: 1, wave_index: 0,
        timestamp: '2026-05-30T00:01:00.000Z',
        phases: ['phase-1', 'phase-2'],
        selected_mode: 'parallel_failed',
        parallel_requested: true,
        worker_cap: 2,
        worktree_slots: [],
        failure_code: 'this_is_not_allowlisted',
        failure_reason: 'arbitrary prose',
      },
    ]);
    const agg = aggregateScheduler(tmp, fakeState());
    assert.deepEqual(agg.failure_codes, []);
    // The non-canonical code must not leak into rejection_reasons either.
    assert.equal(agg.rejection_reasons.includes('this_is_not_allowlisted'), false);
  });

  it('collects failure_code only from parallel_failed events', () => {
    writeWorkspace(tmp, [
      {
        tier: 1, wave_index: 0,
        timestamp: '2026-05-30T00:01:00.000Z',
        phases: ['phase-1', 'phase-2'],
        selected_mode: 'parallel',
        parallel_requested: true,
        worker_cap: 2,
        worktree_slots: [1, 2],
        // Even if a non-failed event has a failure_code, ignore it.
        failure_code: 'worker_dispatch_error',
      },
    ]);
    const agg = aggregateScheduler(tmp, fakeState());
    assert.deepEqual(agg.failure_codes, []);
  });

  it('preserves rejection_reasons / rejection_reasons_by_phase semantics (regression on PR #229)', () => {
    writeWorkspace(tmp, [
      {
        tier: 1, wave_index: 0,
        timestamp: '2026-05-30T00:01:00.000Z',
        phases: ['phase-1', 'phase-2'],
        selected_mode: 'parallel_failed',
        parallel_requested: true,
        worker_cap: 2,
        worktree_slots: [],
        rejection_reasons_by_phase: { 'phase-1': 'file_overlap' },
        failure_code: 'worker_dispatch_error',
        failure_reason: 'spawn EAGAIN',
      },
    ]);
    const agg = aggregateScheduler(tmp, fakeState());
    // The pre-attempt planning rejection still feeds rejection_reasons —
    // the change is that failure_reason no longer does.
    assert.ok(agg.rejection_reasons.includes('file_overlap'));
    assert.deepEqual(agg.failure_codes, ['worker_dispatch_error']);
    // explanation_required stays true (waves_parallel_failed > 0).
    assert.equal(explanationRequiredFromAggregate(agg), true);
  });

  it('dedupes failure_codes across multiple parallel_failed waves', () => {
    writeWorkspace(tmp, [
      {
        tier: 1, wave_index: 0,
        timestamp: '2026-05-30T00:01:00.000Z',
        phases: ['phase-1', 'phase-2'],
        selected_mode: 'parallel_failed',
        parallel_requested: true,
        worker_cap: 2,
        worktree_slots: [],
        failure_code: 'worker_dispatch_error',
      },
      {
        tier: 1, wave_index: 1,
        timestamp: '2026-05-30T00:02:00.000Z',
        phases: ['phase-1', 'phase-2'],
        selected_mode: 'parallel_failed',
        parallel_requested: true,
        worker_cap: 2,
        worktree_slots: [],
        failure_code: 'worker_dispatch_error',
      },
    ]);
    const agg = aggregateScheduler(tmp, fakeState());
    assert.deepEqual(agg.failure_codes, ['worker_dispatch_error']);
  });

  it('surfaces multiple distinct failure_codes sorted', () => {
    writeWorkspace(tmp, [
      {
        tier: 1, wave_index: 0,
        timestamp: '2026-05-30T00:01:00.000Z',
        phases: ['phase-1', 'phase-2'],
        selected_mode: 'parallel_failed',
        parallel_requested: true,
        worker_cap: 2,
        worktree_slots: [],
        failure_code: 'worker_dispatch_error',
      },
      {
        tier: 1, wave_index: 1,
        timestamp: '2026-05-30T00:02:00.000Z',
        phases: ['phase-1', 'phase-2'],
        selected_mode: 'parallel_failed',
        parallel_requested: true,
        worker_cap: 2,
        worktree_slots: [],
        failure_code: 'merge_error',
      },
    ]);
    const agg = aggregateScheduler(tmp, fakeState());
    assert.deepEqual(agg.failure_codes, ['merge_error', 'worker_dispatch_error']);
  });
});

// ---------------------------------------------------------------------------
// Finalize-gate dispatch — exercise the explanation requirement directly
// against the validateNoParallelExplanationPresence helper by going
// through the gate's public path: the gate's failure-code check uses
// the same containsToken helper as the rejection-reasons check, so the
// dispatch logic is exercised when we drive the gate file end-to-end.
//
// We do that via the existing finalize-artifacts test harness, but to
// keep this test file focused we exercise the aggregator output in
// combination with a hand-built explanation string and assert against
// the contains-token semantics indirectly via the public
// explanationRequiredFromAggregate signal.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Finalize gate — end-to-end integration through mpl-require-finalize-artifacts
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const FINALIZE_HOOK_PATH = join(dirname(__filename), '..', 'mpl-require-finalize-artifacts.mjs');

function fullDecompositionYaml() {
  return `
recompose_count: 0
execution_tiers:
  - tier: 1
    parallel: true
    phases: [phase-1, phase-2]
phases:
  - id: phase-1
  - id: phase-2
`;
}

function fullGoalContract() {
  return `
source:
  user_request: "Build app"
  user_request_hash: "req"
mission:
  goal: "Test failure_code canonical vocabulary"
  project_pivot: "no paraphrase bypass"
  must_ship_outcomes:
    - "x"
ontology:
  entities:
    - app
variation_axes:
  - id: AX-1
acceptance_criteria:
  - id: AC-1
e2e_policy:
  real_runtime_required: false
  mock_allowed: false
  placeholder_assertions_allowed: false
security_policy:
  required: false
completion_evidence:
  required_artifacts:
    - .mpl/mpl/audit-report.json
    - .mpl/mpl/profile/run-summary.json
    - .mpl/mpl/RUNBOOK.md
  require_commit: false
  require_finalize_timestamps: true
`;
}

function setupFullWorkspace(tmp, { events, summary }) {
  mkdirSync(join(tmp, '.mpl', 'mpl', 'profile'), { recursive: true });
  writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
    schema_version: CURRENT_SCHEMA_VERSION,
    current_phase: 'phase5-finalize',
    pipeline_id: PIPELINE_ID,
    started_at: STARTED_AT,
    phase_scheduler_history: events.map((e, i) => ({
      pipeline_id: PIPELINE_ID,
      run_started_at: STARTED_AT,
      recompose_count: 0,
      wave_index: i,
      timestamp: `2026-05-30T00:00:${String(10 + i).padStart(2, '0')}.000Z`,
      ...e,
    })),
  }));
  writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'), fullGoalContract());
  writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), fullDecompositionYaml());
  writeFileSync(join(tmp, '.mpl', 'mpl', 'audit-report.json'), JSON.stringify({ verdict: 'pass' }));
  writeFileSync(join(tmp, '.mpl', 'mpl', 'profile', 'run-summary.json'),
    JSON.stringify({ run_id: 'r1', scheduler: summary }));
  writeFileSync(join(tmp, '.mpl', 'mpl', 'RUNBOOK.md'),
    '# MPL Pipeline RUNBOOK\n\n## Pipeline Complete\n');
  // Also persist the events to the JSONL profile so the aggregator picks them up.
  writeFileSync(
    join(tmp, '.mpl', 'mpl', 'profile', 'phase-scheduler.jsonl'),
    events.map((e, i) => JSON.stringify({
      pipeline_id: PIPELINE_ID,
      run_started_at: STARTED_AT,
      recompose_count: 0,
      wave_index: i,
      timestamp: `2026-05-30T00:00:${String(10 + i).padStart(2, '0')}.000Z`,
      ...e,
    })).join('\n') + '\n',
  );
}

function runFinalizeHook(tmp) {
  const stateContent = JSON.stringify({
    current_phase: 'phase5-finalize',
    finalize_done: true,
    completed_at: '2026-05-30T00:01:00.000Z',
    finalized_at: '2026-05-30T00:01:01.000Z',
  });
  return JSON.parse(execFileSync('node', [FINALIZE_HOOK_PATH], {
    input: JSON.stringify({
      cwd: tmp,
      tool_name: 'Write',
      tool_input: {
        file_path: '.mpl/state.json',
        content: stateContent,
      },
    }),
    encoding: 'utf-8',
  }));
}

describe('#230 finalize gate — failure_code requirement', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mpl-230-gate-')); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('blocks when explanation paraphrases the failure_reason but omits the canonical failure_code', () => {
    // The exact paraphrase-bypass shape from the #230 issue body.
    setupFullWorkspace(tmp, {
      events: [{
        tier: 1,
        phases: ['phase-1', 'phase-2'],
        selected_mode: 'parallel_failed',
        parallel_requested: true,
        worker_cap: 2,
        worktree_slots: [],
        failure_code: 'worker_dispatch_error',
        failure_reason: 'worker dispatch failed',
      }],
      summary: {
        tiers_total: 1,
        tiers_parallel_requested: 1,
        tiers_parallel_executed: 0,
        tiers_parallel_rejected: 1,
        tiers_with_missing_telemetry: [],
        waves_parallel_rejected: 0,
        waves_parallel_failed: 1,
        tiers_with_partial_rejection: [],
        rejection_reasons: [],
        failure_codes: ['worker_dispatch_error'],
        no_parallel_explanation: 'tier 1: worker dispatch failed (parallel_failed_without_reason: false)',
      },
    });
    const r = runFinalizeHook(tmp);
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /no_parallel_explanation_missing_failure_code:expected=worker_dispatch_error/);
  });

  it('passes when explanation names the canonical failure_code verbatim', () => {
    setupFullWorkspace(tmp, {
      events: [{
        tier: 1,
        phases: ['phase-1', 'phase-2'],
        selected_mode: 'parallel_failed',
        parallel_requested: true,
        worker_cap: 2,
        worktree_slots: [],
        failure_code: 'worker_dispatch_error',
        failure_reason: 'spawn EAGAIN under pool pressure',
      }],
      summary: {
        tiers_total: 1,
        tiers_parallel_requested: 1,
        tiers_parallel_executed: 0,
        tiers_parallel_rejected: 1,
        tiers_with_missing_telemetry: [],
        waves_parallel_rejected: 0,
        waves_parallel_failed: 1,
        tiers_with_partial_rejection: [],
        rejection_reasons: [],
        failure_codes: ['worker_dispatch_error'],
        no_parallel_explanation:
          'tier 1 hit worker_dispatch_error during the wave; ' +
          'parallel_failed_without_reason did not apply (failure_reason captured).',
      },
    });
    const r = runFinalizeHook(tmp);
    assert.equal(r.continue, true,
      `expected continue:true with full vocabulary, got ${JSON.stringify(r)}`);
  });

  it('blocks when masked runtime cause: pre-attempt token present but failure_code omitted', () => {
    // The second issue-body repro: a wave with both file_overlap
    // (pre-attempt deferred) AND worker_dispatch_error (runtime) — an
    // explanation that names ONLY file_overlap was the masked-cause
    // bypass.
    setupFullWorkspace(tmp, {
      events: [{
        tier: 1,
        phases: ['phase-1', 'phase-2'],
        selected_mode: 'parallel_failed',
        parallel_requested: true,
        worker_cap: 2,
        worktree_slots: [],
        rejection_reasons_by_phase: { 'phase-1': 'file_overlap' },
        failure_code: 'worker_dispatch_error',
        failure_reason: 'pool exhaustion',
      }],
      summary: {
        tiers_total: 1,
        tiers_parallel_requested: 1,
        tiers_parallel_executed: 0,
        tiers_parallel_rejected: 1,
        tiers_with_missing_telemetry: [],
        waves_parallel_rejected: 0,
        waves_parallel_failed: 1,
        tiers_with_partial_rejection: [],
        rejection_reasons: ['file_overlap'],
        failure_codes: ['worker_dispatch_error'],
        no_parallel_explanation:
          'tier 1 lost parallelism: file_overlap deferred phase-1',
      },
    });
    const r = runFinalizeHook(tmp);
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /no_parallel_explanation_missing_failure_code:expected=worker_dispatch_error/);
  });

  it('passes when masked runtime cause is resolved by naming BOTH tokens', () => {
    setupFullWorkspace(tmp, {
      events: [{
        tier: 1,
        phases: ['phase-1', 'phase-2'],
        selected_mode: 'parallel_failed',
        parallel_requested: true,
        worker_cap: 2,
        worktree_slots: [],
        rejection_reasons_by_phase: { 'phase-1': 'file_overlap' },
        failure_code: 'worker_dispatch_error',
        failure_reason: 'pool exhaustion',
      }],
      summary: {
        tiers_total: 1,
        tiers_parallel_requested: 1,
        tiers_parallel_executed: 0,
        tiers_parallel_rejected: 1,
        tiers_with_missing_telemetry: [],
        waves_parallel_rejected: 0,
        waves_parallel_failed: 1,
        tiers_with_partial_rejection: [],
        rejection_reasons: ['file_overlap'],
        failure_codes: ['worker_dispatch_error'],
        no_parallel_explanation:
          'tier 1: file_overlap deferred phase-1, then the wave hit ' +
          'worker_dispatch_error during dispatch.',
      },
    });
    const r = runFinalizeHook(tmp);
    assert.equal(r.continue, true,
      `expected continue:true with both tokens, got ${JSON.stringify(r)}`);
  });

  it('hyphen / space variants of the failure_code satisfy the gate', () => {
    setupFullWorkspace(tmp, {
      events: [{
        tier: 1,
        phases: ['phase-1', 'phase-2'],
        selected_mode: 'parallel_failed',
        parallel_requested: true,
        worker_cap: 2,
        worktree_slots: [],
        failure_code: 'worktree_setup_error',
      }],
      summary: {
        tiers_total: 1,
        tiers_parallel_requested: 1,
        tiers_parallel_executed: 0,
        tiers_parallel_rejected: 1,
        tiers_with_missing_telemetry: [],
        waves_parallel_rejected: 0,
        waves_parallel_failed: 1,
        tiers_with_partial_rejection: [],
        rejection_reasons: [],
        failure_codes: ['worktree_setup_error'],
        // Hyphenated variant — same canonical token, different separator.
        no_parallel_explanation:
          'tier 1 lost parallelism: worktree-setup-error before any worker dispatched.',
      },
    });
    const r = runFinalizeHook(tmp);
    assert.equal(r.continue, true,
      `expected continue:true for hyphen variant, got ${JSON.stringify(r)}`);
  });
});

describe('#230 explanationRequired', () => {
  it('stays true when a parallel_failed event is present (failure_code feeds the gate)', () => {
    const agg = {
      tiers_total: 1,
      tiers_parallel_requested: 1,
      tiers_parallel_executed: 0,
      tiers_parallel_rejected: 1,
      tiers_with_missing_telemetry: [],
      waves_parallel_rejected: 0,
      waves_parallel_failed: 1,
      waves_parallel_rejected_without_reason: 0,
      waves_parallel_failed_without_reason: 0,
      tiers_with_partial_rejection: [],
      rejection_reasons: [],
      failure_codes: ['worker_dispatch_error'],
      affected_tier_ids: [1],
    };
    assert.equal(explanationRequiredFromAggregate(agg), true);
  });
});
