import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';
import { readGoalContract } from '../lib/mpl-goal-contract.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-require-finalize-artifacts.mjs');
const SCHEMA_V = CURRENT_SCHEMA_VERSION;

const TEST_PIPELINE_ID = 'mpl-test-205';
const TEST_STARTED_AT = '2026-05-27T00:00:00.000Z';

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-finalize-art-'));
  mkdirSync(join(tmp, '.mpl', 'mpl', 'profile'), { recursive: true });
  writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
    schema_version: SCHEMA_V,
    current_phase: 'phase5-finalize',
    pipeline_id: TEST_PIPELINE_ID,
    started_at: TEST_STARTED_AT,
    phase_scheduler_history: [],
    security_results: {
      dependency_audit: { command: 'npm audit --omit=dev', exit_code: 0 },
    },
  }));
  writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'), goalContract());
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function goalContract() {
  return `
source:
  user_request: "Build app"
  user_request_hash: "req"
mission:
  goal: "Finalize with machine evidence"
  project_pivot: "No false completion"
  must_ship_outcomes:
    - "final artifacts exist"
ontology:
  entities:
    - finalization
variation_axes:
  - id: AX-1
acceptance_criteria:
  - id: AC-1
e2e_policy:
  real_runtime_required: true
  mock_allowed: false
  placeholder_assertions_allowed: false
security_policy:
  required: true
  checks:
    - dependency_audit
completion_evidence:
  required_artifacts:
    - .mpl/mpl/audit-report.json
    - .mpl/mpl/profile/run-summary.json
    - .mpl/mpl/RUNBOOK.md
  require_commit: false
  require_finalize_timestamps: true
`;
}

function writeArtifacts() {
  writeFileSync(join(tmp, '.mpl', 'mpl', 'audit-report.json'), JSON.stringify({ verdict: 'pass' }));
  writeFileSync(join(tmp, '.mpl', 'mpl', 'profile', 'run-summary.json'), JSON.stringify({ run_id: 'r1' }));
  writeFileSync(join(tmp, '.mpl', 'mpl', 'RUNBOOK.md'), '# MPL Pipeline RUNBOOK\n\n## Pipeline Complete\n');
}

function runHook(content = null, { toolName = 'Write', toolInput = null } = {}) {
  const stateContent = content || JSON.stringify({
    current_phase: 'phase5-finalize',
    finalize_done: true,
    completed_at: '2026-05-17T00:00:00Z',
    finalized_at: '2026-05-17T00:00:01Z',
  });
  const input = {
    cwd: tmp,
    tool_name: toolName,
    tool_input: toolInput || {
      file_path: '.mpl/state.json',
      content: stateContent,
    },
  };
  return JSON.parse(execFileSync('node', [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
  }));
}

describe('mpl-require-finalize-artifacts hook', () => {
  it('allows finalize when declared artifacts, timestamps, and security evidence exist', () => {
    writeArtifacts();
    const r = runHook();
    assert.equal(r.continue, true);
  });

  it('blocks when run-summary is missing', () => {
    writeFileSync(join(tmp, '.mpl', 'mpl', 'audit-report.json'), JSON.stringify({ verdict: 'pass' }));
    writeFileSync(join(tmp, '.mpl', 'mpl', 'RUNBOOK.md'), '# MPL Pipeline RUNBOOK\n\n## Pipeline Complete\n');
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /run-summary\.json/);
  });

  it('blocks MultiEdit finalize writes', () => {
    writeFileSync(join(tmp, '.mpl', 'mpl', 'audit-report.json'), JSON.stringify({ verdict: 'pass' }));
    writeFileSync(join(tmp, '.mpl', 'mpl', 'RUNBOOK.md'), '# MPL Pipeline RUNBOOK\n\n## Pipeline Complete\n');
    const r = runHook(null, {
      toolName: 'MultiEdit',
      toolInput: {
        file_path: '.mpl/state.json',
        edits: [{
          old_string: '"finalize_done": false',
          new_string: '"finalize_done": true',
        }],
      },
    });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /run-summary\.json/);
  });

  it('blocks when RUNBOOK lacks the final section', () => {
    writeFileSync(join(tmp, '.mpl', 'mpl', 'audit-report.json'), JSON.stringify({ verdict: 'pass' }));
    writeFileSync(join(tmp, '.mpl', 'mpl', 'profile', 'run-summary.json'), JSON.stringify({ run_id: 'r1' }));
    writeFileSync(join(tmp, '.mpl', 'mpl', 'RUNBOOK.md'), '# MPL Pipeline RUNBOOK\n');
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /Pipeline Complete/);
  });

  it('blocks when required security evidence is missing', () => {
    writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
      schema_version: SCHEMA_V,
      current_phase: 'phase5-finalize',
      security_results: {},
    }));
    writeArtifacts();
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /security:dependency_audit/);
  });

  it('blocks when finalize timestamps are not in the candidate state', () => {
    writeArtifacts();
    const r = runHook(JSON.stringify({ current_phase: 'phase5-finalize', finalize_done: true }));
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /state\.completed_at/);
    assert.match(r.reason, /state\.finalized_at/);
  });

  it('blocks when current goal contract hash drifted from baseline', () => {
    writeArtifacts();
    const currentHash = readGoalContract(tmp).contract.content_sha256;
    const baselineHash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    assert.equal(currentHash.length, 64);
    writeFileSync(join(tmp, '.mpl', 'mpl', 'baseline.yaml'), `
artifacts:
  goal_contract:
    path: ".mpl/goal-contract.yaml"
    sha256: "${baselineHash}"
`);
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /goal contract drifted from baseline/);
    assert.match(r.reason, new RegExp(baselineHash));
    assert.match(r.reason, new RegExp(currentHash));
    assert.match(r.reason, /raw shasum may differ/);
  });

  it('blocks explicitly when baseline goal contract hash is corrupt', () => {
    writeArtifacts();
    writeFileSync(join(tmp, '.mpl', 'mpl', 'baseline.yaml'), `
artifacts:
  goal_contract:
    path: ".mpl/goal-contract.yaml"
    sha256: "43aaf36b9bf7"
`);
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /corrupt baseline\.yaml goal_contract sha256/);
    assert.match(r.reason, /expected 64 lowercase hex/);
    assert.match(r.reason, /43aaf36b9bf7/);
  });

  it('blocks explicitly when baseline exists without goal_contract sha256', () => {
    writeArtifacts();
    writeFileSync(join(tmp, '.mpl', 'mpl', 'baseline.yaml'), `
artifacts:
  pivot_points:
    path: ".mpl/pivot-points.md"
    sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
`);
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /missing_goal_contract_sha256/);
  });

  /* ───────── Exp22 R6 / #205: scheduler observability guard ───────── */

  function writeDecompositionWithParallelTier({ recompose_count = 0 } = {}) {
    writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), `
recompose_count: ${recompose_count}
phases:
  - id: phase-1
  - id: phase-2
execution_tiers:
  - tier: 1
    phases: [phase-1, phase-2]
    parallel: true
`);
  }

  function writeSummaryScheduler(scheduler) {
    writeFileSync(join(tmp, '.mpl', 'mpl', 'profile', 'run-summary.json'),
      JSON.stringify({ run_id: 'r1', scheduler }));
  }

  // Write phase-scheduler events into BOTH state.phase_scheduler_history
  // (the ring-buffered mirror that hooks/lib/mpl-scheduler-aggregate reads)
  // and the persistent JSONL profile file. Each event carries the
  // current-run scope keys (pipeline_id, run_started_at, recompose_count)
  // so the aggregator includes it.
  function writeSchedulerEvents(events) {
    const stamped = events.map((e, i) => ({
      pipeline_id: TEST_PIPELINE_ID,
      run_started_at: TEST_STARTED_AT,
      recompose_count: 0,
      wave_index: i,
      // Distinct ISO timestamps so the dedupe key cannot collapse
      // multiple events sharing the same coarse time.
      timestamp: `2026-05-27T00:00:${String(10 + i).padStart(2, '0')}.000Z`,
      ...e,
    }));
    // patch state.phase_scheduler_history
    const statePath = join(tmp, '.mpl', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    state.phase_scheduler_history = stamped;
    writeFileSync(statePath, JSON.stringify(state));
    // mirror to persistent JSONL
    const jsonlPath = join(tmp, '.mpl', 'mpl', 'profile', 'phase-scheduler.jsonl');
    writeFileSync(jsonlPath, stamped.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  it('blocks finalize when decomposition declares a parallel tier but run-summary.scheduler is missing', () => {
    writeFileSync(join(tmp, '.mpl', 'mpl', 'audit-report.json'), JSON.stringify({ verdict: 'pass' }));
    writeFileSync(join(tmp, '.mpl', 'mpl', 'profile', 'run-summary.json'), JSON.stringify({ run_id: 'r1' }));
    writeFileSync(join(tmp, '.mpl', 'mpl', 'RUNBOOK.md'), '# MPL Pipeline RUNBOOK\n\n## Pipeline Complete\n');
    writeDecompositionWithParallelTier();
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /scheduler:block_missing/);
  });

  it('blocks finalize when parallel-requested tiers were not executed and no_parallel_explanation is null', () => {
    writeFileSync(join(tmp, '.mpl', 'mpl', 'audit-report.json'), JSON.stringify({ verdict: 'pass' }));
    writeFileSync(join(tmp, '.mpl', 'mpl', 'RUNBOOK.md'), '# MPL Pipeline RUNBOOK\n\n## Pipeline Complete\n');
    writeDecompositionWithParallelTier();
    // Real evidence: a parallel_rejected event for tier 1 (planning could
    // not split into a parallel wave). The hook recomputes from this.
    writeSchedulerEvents([
      { tier: 1, selected_mode: 'parallel_rejected',
        rejection_reasons_by_phase: { 'phase-1': ['file_overlap'] } },
    ]);
    writeSummaryScheduler({
      tiers_total: 1,
      tiers_parallel_requested: 1,
      tiers_parallel_executed: 0,
      tiers_parallel_rejected: 1,
      tiers_with_missing_telemetry: [],
      waves_parallel_rejected: 1,
      waves_parallel_failed: 0,
      tiers_with_partial_rejection: [],
      rejection_reasons: ['file_overlap'],
      no_parallel_explanation: null,
    });
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /scheduler:no_parallel_explanation_required_but_missing/);
  });

  it('allows finalize when parallel-requested tier failed at runtime but no_parallel_explanation is filled', () => {
    writeArtifacts();
    writeDecompositionWithParallelTier();
    writeSchedulerEvents([
      { tier: 1, selected_mode: 'parallel_failed', timestamp: '2026-05-27T00:00:02Z', failure_reason: 'worker_dispatch_error' },
    ]);
    writeSummaryScheduler({
      tiers_total: 1,
      tiers_parallel_requested: 1,
      tiers_parallel_executed: 0,
      tiers_parallel_rejected: 1,
      tiers_with_missing_telemetry: [],
      waves_parallel_rejected: 0,
      waves_parallel_failed: 1,
      tiers_with_partial_rejection: [],
      rejection_reasons: ['worker_dispatch_error'],
      no_parallel_explanation: 'tier 1 attempted parallel execution but worker dispatch failed; fell back to sequential retry',
    });
    const r = runHook();
    assert.equal(r.continue, true);
  });

  it('blocks finalize when summary.scheduler.tiers_parallel_requested is lower than decomposition truth (drift/spoof guard)', () => {
    // Codex round-9 review on PR #213: a prompt-drifted or hand-edited
    // summary that reports requested=0 must be rejected because the
    // hook now computes that count from decomposition.yaml itself.
    writeFileSync(join(tmp, '.mpl', 'mpl', 'audit-report.json'), JSON.stringify({ verdict: 'pass' }));
    writeFileSync(join(tmp, '.mpl', 'mpl', 'RUNBOOK.md'), '# MPL Pipeline RUNBOOK\n\n## Pipeline Complete\n');
    writeDecompositionWithParallelTier();
    writeSummaryScheduler({
      tiers_total: 1,
      tiers_parallel_requested: 0,   // drift — decomposition says 1
      tiers_parallel_executed: 0,
      tiers_parallel_rejected: 0,
      tiers_with_missing_telemetry: [],
      waves_parallel_rejected: 0,
      waves_parallel_failed: 0,
      tiers_with_partial_rejection: [],
      rejection_reasons: [],
      no_parallel_explanation: null,
    });
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /scheduler:tiers_parallel_requested_mismatch/);
    assert.match(r.reason, /computed=1/);
    assert.match(r.reason, /summary=0/);
  });

  it('blocks finalize when run-summary falsely claims executed parallelism but no current-run event exists', () => {
    // Codex round-10 review on PR #213: the hook must not trust
    // summary.scheduler.tiers_parallel_executed. Re-derive it from the
    // event stream. A summary that lies (executed=1) with no actual
    // selected_mode:"parallel" event in JSONL/state must be blocked.
    writeFileSync(join(tmp, '.mpl', 'mpl', 'audit-report.json'), JSON.stringify({ verdict: 'pass' }));
    writeFileSync(join(tmp, '.mpl', 'mpl', 'RUNBOOK.md'), '# MPL Pipeline RUNBOOK\n\n## Pipeline Complete\n');
    writeDecompositionWithParallelTier();
    // Intentionally no scheduler events written — telemetry is missing.
    writeSummaryScheduler({
      tiers_total: 1,
      tiers_parallel_requested: 1,
      tiers_parallel_executed: 1,   // lie — there is no parallel event
      tiers_parallel_rejected: 0,
      tiers_with_missing_telemetry: [],   // lie — tier 1 is missing
      waves_parallel_rejected: 0,
      waves_parallel_failed: 0,
      tiers_with_partial_rejection: [],
      rejection_reasons: [],
      no_parallel_explanation: null,
    });
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /scheduler:tiers_parallel_executed_mismatch:computed=0,summary=1/);
  });

  it('parses inline-map execution_tiers and still enforces the MUST', () => {
    // Codex round-11 review on PR #213: the YAML peek only recognized the
    // block form. Inline-map `- { tier: 4, parallel: true, ... }` (a valid
    // YAML form used elsewhere in the repo) parsed as zero tiers and the
    // guard skipped the scheduler MUST. Pin support for inline form.
    writeFileSync(join(tmp, '.mpl', 'mpl', 'audit-report.json'), JSON.stringify({ verdict: 'pass' }));
    writeFileSync(join(tmp, '.mpl', 'mpl', 'RUNBOOK.md'), '# MPL Pipeline RUNBOOK\n\n## Pipeline Complete\n');
    writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), `
recompose_count: 0
phases:
  - id: phase-1
  - id: phase-2
execution_tiers:
  - { tier: 4, phases: [phase-1, phase-2], parallel: true }
`);
    // No events — telemetry missing — should block.
    writeSummaryScheduler({
      tiers_total: 1,
      tiers_parallel_requested: 1,
      tiers_parallel_executed: 0,
      tiers_parallel_rejected: 1,
      tiers_with_missing_telemetry: [4],
      waves_parallel_rejected: 0,
      waves_parallel_failed: 0,
      tiers_with_partial_rejection: [],
      rejection_reasons: [],
      no_parallel_explanation: null,
    });
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /scheduler:no_parallel_explanation_required_but_missing/);
  });

  it('parses reordered-key execution_tiers (parallel before tier) without skipping the MUST', () => {
    writeFileSync(join(tmp, '.mpl', 'mpl', 'audit-report.json'), JSON.stringify({ verdict: 'pass' }));
    writeFileSync(join(tmp, '.mpl', 'mpl', 'RUNBOOK.md'), '# MPL Pipeline RUNBOOK\n\n## Pipeline Complete\n');
    writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), `
recompose_count: 0
phases:
  - id: phase-1
  - id: phase-2
execution_tiers:
  - parallel: true
    tier: 7
    phases: [phase-1, phase-2]
`);
    writeSummaryScheduler({
      tiers_total: 1,
      tiers_parallel_requested: 1,
      tiers_parallel_executed: 0,
      tiers_parallel_rejected: 1,
      tiers_with_missing_telemetry: [7],
      waves_parallel_rejected: 0,
      waves_parallel_failed: 0,
      tiers_with_partial_rejection: [],
      rejection_reasons: [],
      no_parallel_explanation: null,
    });
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /scheduler:no_parallel_explanation_required_but_missing/);
  });

  it('blocks finalize when summary under-reports a rejected wave or names the wrong missing tier', () => {
    // Codex round-11 review on PR #213: scalar+length checks let a summary
    // pass with the right shape but wrong contents. Compare the full
    // aggregate, including exact tier ids and waves_parallel_rejected.
    writeArtifacts();
    writeDecompositionWithParallelTier();
    // Two parallel_rejected events for tier 1.
    writeSchedulerEvents([
      { tier: 1, selected_mode: 'parallel_rejected', timestamp: '2026-05-27T00:00:03Z' },
      { tier: 1, selected_mode: 'parallel_rejected', timestamp: '2026-05-27T00:00:04Z' },
    ]);
    writeSummaryScheduler({
      tiers_total: 1,
      tiers_parallel_requested: 1,
      tiers_parallel_executed: 0,
      tiers_parallel_rejected: 1,
      tiers_with_missing_telemetry: [],
      waves_parallel_rejected: 1,   // lie — actually 2
      waves_parallel_failed: 0,
      tiers_with_partial_rejection: [],
      rejection_reasons: [],
      no_parallel_explanation: 'parallelism rejected by file overlap',
    });
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /scheduler:waves_parallel_rejected_mismatch:computed=2,summary=1/);
  });

  it('blocks finalize when execution_tiers is present but unparseable (fail-closed)', () => {
    writeFileSync(join(tmp, '.mpl', 'mpl', 'audit-report.json'), JSON.stringify({ verdict: 'pass' }));
    writeFileSync(join(tmp, '.mpl', 'mpl', 'RUNBOOK.md'), '# MPL Pipeline RUNBOOK\n\n## Pipeline Complete\n');
    writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), `
recompose_count: 0
phases:
  - id: phase-1
execution_tiers:
  - this_is_not_a_tier_field: 1
    parallel: true
`);
    writeSummaryScheduler({
      tiers_total: 0,
      tiers_parallel_requested: 0,
      tiers_parallel_executed: 0,
      tiers_parallel_rejected: 0,
      tiers_with_missing_telemetry: [],
      waves_parallel_rejected: 0,
      waves_parallel_failed: 0,
      tiers_with_partial_rejection: [],
      rejection_reasons: [],
      no_parallel_explanation: null,
    });
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /scheduler:decomposition_execution_tiers_unparseable/);
  });

  it('preserves two same-tier rejected waves through dedupe via wave_index', () => {
    // Codex round-12 review on PR #213: dedupe-by-timestamp let same-tier
    // rejected waves collapse onto one event. wave_index is the per-tier
    // counter that guarantees distinct dedupe keys.
    writeArtifacts();
    writeDecompositionWithParallelTier();
    writeSchedulerEvents([
      { tier: 1, selected_mode: 'parallel_rejected',
        rejection_reasons_by_phase: { 'phase-1': ['file_overlap'] } },
      { tier: 1, selected_mode: 'parallel_rejected',
        rejection_reasons_by_phase: { 'phase-2': ['resource_lock'] } },
    ]);
    writeSummaryScheduler({
      tiers_total: 1,
      tiers_parallel_requested: 1,
      tiers_parallel_executed: 0,
      tiers_parallel_rejected: 1,
      tiers_with_missing_telemetry: [],
      waves_parallel_rejected: 2,
      waves_parallel_failed: 0,
      tiers_with_partial_rejection: [],
      rejection_reasons: ['file_overlap', 'resource_lock'],
      no_parallel_explanation: 'tier 1: both waves rejected by file_overlap and resource_lock; fell back to sequential',
    });
    const r = runHook();
    assert.equal(r.continue, true);
  });

  it('blocks finalize when no_parallel_explanation is non-empty but fails to reference the affected tier ids', () => {
    // Codex round-12 review on PR #213: a non-empty string is not enough.
    // The explanation must name each affected tier id by number so an
    // operator can find which tiers lost parallelism.
    writeArtifacts();
    writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), `
recompose_count: 0
phases:
  - id: phase-1
  - id: phase-2
execution_tiers:
  - tier: 5
    phases: [phase-1, phase-2]
    parallel: true
`);
    writeSchedulerEvents([
      { tier: 5, selected_mode: 'parallel_rejected',
        rejection_reasons_by_phase: { 'phase-1': ['file_overlap'] } },
    ]);
    writeSummaryScheduler({
      tiers_total: 1,
      tiers_parallel_requested: 1,
      tiers_parallel_executed: 0,
      tiers_parallel_rejected: 1,
      tiers_with_missing_telemetry: [],
      waves_parallel_rejected: 1,
      waves_parallel_failed: 0,
      tiers_with_partial_rejection: [],
      rejection_reasons: ['file_overlap'],
      no_parallel_explanation: 'n/a',
    });
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /scheduler:no_parallel_explanation_missing_tier_refs:\[5\]/);
  });

  it('blocks finalize when summary.scheduler.rejection_reasons disagrees with the computed set', () => {
    writeArtifacts();
    writeDecompositionWithParallelTier();
    writeSchedulerEvents([
      { tier: 1, selected_mode: 'parallel_rejected',
        rejection_reasons_by_phase: { 'phase-1': ['file_overlap'] } },
    ]);
    writeSummaryScheduler({
      tiers_total: 1,
      tiers_parallel_requested: 1,
      tiers_parallel_executed: 0,
      tiers_parallel_rejected: 1,
      tiers_with_missing_telemetry: [],
      waves_parallel_rejected: 1,
      waves_parallel_failed: 0,
      tiers_with_partial_rejection: [],
      rejection_reasons: ['something_unrelated'],   // drift
      no_parallel_explanation: 'tier 1 rejected',
    });
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /scheduler:rejection_reasons_mismatch/);
    assert.match(r.reason, /file_overlap/);
    assert.match(r.reason, /something_unrelated/);
  });

  it('does not enforce the scheduler MUST when decomposition declares no parallel tier', () => {
    writeArtifacts();
    writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), `
recompose_count: 0
phases:
  - id: phase-1
execution_tiers:
  - tier: 1
    phases: [phase-1]
    parallel: false
`);
    // Even with no scheduler block in run-summary, finalize must pass when
    // nothing requested parallelism.
    const r = runHook();
    assert.equal(r.continue, true);
  });
});
