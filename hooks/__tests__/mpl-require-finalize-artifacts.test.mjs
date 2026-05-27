import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';
import { readGoalContract } from '../lib/mpl-goal-contract.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-require-finalize-artifacts.mjs');
const SCHEMA_V = CURRENT_SCHEMA_VERSION;

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-finalize-art-'));
  mkdirSync(join(tmp, '.mpl', 'mpl', 'profile'), { recursive: true });
  writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
    schema_version: SCHEMA_V,
    current_phase: 'phase5-finalize',
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

  function writeDecompositionWithParallelTier() {
    writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), `
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
    writeSummaryScheduler({
      tiers_total: 1,
      tiers_parallel_requested: 1,
      tiers_parallel_executed: 0,
      tiers_parallel_rejected: 0,
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
    // Codex round-9 review on PR #213: the original guard used the summary's
    // self-reported tiers_parallel_requested as the denominator. A prompt-
    // drifted or hand-edited summary could set requested=0/executed=0 with
    // explanation=null to vacuously pass. decomposition.yaml is the
    // authority; the summary's count must match it.
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
    assert.match(r.reason, /decomp=1/);
    assert.match(r.reason, /summary=0/);
  });

  it('does not enforce the scheduler MUST when decomposition declares no parallel tier', () => {
    writeArtifacts();
    writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), `
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
