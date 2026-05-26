import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { inspectRecovery, recoverBlockedHook } from '../lib/mpl-recover.mjs';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';
import { readGoalContract, readBaselineGoalContractHash } from '../lib/mpl-goal-contract.mjs';

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-recover-'));
  mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function goalContract() {
  return `
source:
  user_request: "Build app"
  user_request_hash: "req"
mission:
  goal: "Ship recoverable hook blocks"
  project_pivot: "No false completion"
  must_ship_outcomes:
    - "recover safely"
ontology:
  entities:
    - runtime
variation_axes:
  - id: AX-1
    name: runtime
acceptance_criteria:
  - id: AC-1
    statement: "first"
e2e_policy:
  real_runtime_required: true
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

function writeGoalContract() {
  mkdirSync(join(tmp, '.mpl'), { recursive: true });
  writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'), goalContract());
  return readGoalContract(tmp).contract.content_sha256;
}

function writeBaseline(hash) {
  mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
  writeFileSync(join(tmp, '.mpl', 'mpl', 'baseline.yaml'), `
artifacts:
  goal_contract:
    path: ".mpl/goal-contract.yaml"
    sha256: "${hash}"
`);
}

function writeState(extra = {}) {
  mkdirSync(join(tmp, '.mpl'), { recursive: true });
  writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
    schema_version: CURRENT_SCHEMA_VERSION,
    current_phase: 'mpl-decompose',
    test_agent_dispatched: {},
    ...extra,
  }, null, 2));
}

function readState() {
  return JSON.parse(readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8'));
}

function blocked(extra = {}) {
  return {
    session_status: 'blocked_hook',
    blocked_by_hook: 'mpl-require-goal-trace',
    blocked_phase: 'mpl-decompose',
    blocked_artifact: '.mpl/mpl/decomposition.yaml',
    block_code: 'goal_contract_baseline_corrupt',
    block_reason: 'blocked',
    resume_instruction: 'repair goal hash',
    retry_context: {},
    blocked_at: '2026-05-26T00:00:00Z',
    ...extra,
  };
}

function passEvidence() {
  return {
    valid_json: true,
    verdict: 'PASS',
    invalid_reason: null,
    tests_total: 1,
    tests_failed: 0,
    tests_skipped: 0,
    test_files_created: ['tests/phase-1.test.ts'],
    test_files_created_count: 1,
    command_exit_codes: [0],
    command_exit_codes_count: 1,
    command_exit_codes_nonzero_count: 0,
    bugs_found_count: 0,
  };
}

function decompositionMissingTestAgentRequired() {
  return `
phases:
  - id: phase-1
    scope: "Add editor"
    covers: [UC-01]
    impact: { create: [], modify: [], affected_tests: [] }
    interface_contract: { requires: [], produces: [], contract_files: [] }
    success_criteria: []
`;
}

function decompositionWithGoalTrace(hash) {
  return `
goal_contract_hash: "${hash}"
phases:
  - id: phase-1
    scope: "Add editor"
    covers: [UC-01]
    impact: { create: [], modify: [], affected_tests: [] }
    interface_contract: { requires: [], produces: [], contract_files: [] }
    test_agent_required: true
    success_criteria: []
    goal_trace:
      acceptance_criteria: [AC-1]
      variation_axes: [AX-1]
      ontology_entities: [runtime]
`;
}

describe('mpl recover', () => {
  it('reports no_state and not_blocked without mutating state', () => {
    assert.equal(inspectRecovery(tmp).status, 'no_state');
    writeState({ session_status: null });
    assert.equal(inspectRecovery(tmp).status, 'not_blocked');
    assert.equal(recoverBlockedHook(tmp).status, 'not_blocked');
  });

  it('keeps unsupported block codes intact with recovery context', () => {
    writeState(blocked({
      block_code: 'phase_contract_graph_invalid',
      retry_context: { issue_count: 1 },
    }));

    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'unsupported');

    const state = readState();
    assert.equal(state.session_status, 'blocked_hook');
    assert.equal(state.block_code, 'phase_contract_graph_invalid');
    assert.equal(state.retry_context.recovery.last_status, 'unsupported');
  });

  it('repairs a corrupt baseline goal hash and clears blocked_hook', () => {
    const hash = writeGoalContract();
    writeBaseline('43aaf36b9bf7');
    writeState(blocked({
      block_code: 'goal_contract_baseline_corrupt',
      retry_context: { baseline_error: 'corrupt_goal_contract_sha256', raw_hash: '43aaf36b9bf7' },
    }));

    const plan = inspectRecovery(tmp);
    assert.equal(plan.status, 'recoverable');
    assert.equal(plan.handler, 'goal_baseline_hash');

    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'recovered');
    assert.equal(readBaselineGoalContractHash(tmp).hash, hash);

    const state = readState();
    assert.equal(state.session_status, null);
    assert.equal(state.block_code, null);
    assert.equal(existsSync(join(tmp, '.mpl', 'signals', 'recovery.jsonl')), true);
  });

  it('requires explicit approval before repairing goal hash drift', () => {
    writeGoalContract();
    writeBaseline('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    writeState(blocked({
      block_code: 'goal_contract_drift',
      retry_context: {
        baseline_hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      },
    }));

    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'requires_approval');

    const state = readState();
    assert.equal(state.session_status, 'blocked_hook');
    assert.equal(state.block_code, 'goal_contract_drift');
    assert.equal(state.retry_context.recovery.last_status, 'requires_approval');
    assert.match(state.block_reason, /Explicit approval is required/);
  });

  it('patches goal_trace hash-only mismatch with approval and clears the block', () => {
    const hash = writeGoalContract();
    mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
    writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), decompositionWithGoalTrace('bad-hash'));
    writeState(blocked({
      block_code: 'goal_trace_incomplete',
      retry_context: {
        issue_count: 1,
        issues: [`goal_contract_hash:mismatch:bad-hash->${hash}`],
      },
    }));

    const result = recoverBlockedHook(tmp, { approveUnsafe: true });
    assert.equal(result.status, 'recovered');

    const text = readFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), 'utf-8');
    assert.match(text, new RegExp(`goal_contract_hash: "${hash}"`));
    assert.equal(readState().session_status, null);
  });

  it('does not write a goal_trace hash patch when revalidation would still fail', () => {
    const hash = writeGoalContract();
    mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
    const original = `
goal_contract_hash: "bad-hash"
phases:
  - id: phase-1
    goal_trace:
      acceptance_criteria: []
      variation_axes: []
      ontology_entities: [runtime]
`;
    writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), original);
    writeState(blocked({
      block_code: 'goal_trace_incomplete',
      retry_context: {
        issue_count: 1,
        issues: [`goal_contract_hash:mismatch:bad-hash->${hash}`],
      },
    }));

    const result = recoverBlockedHook(tmp, { approveUnsafe: true });
    assert.equal(result.status, 'failed');

    const text = readFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), 'utf-8');
    assert.equal(text, original);
    const state = readState();
    assert.equal(state.session_status, 'blocked_hook');
    assert.equal(state.retry_context.recovery.last_status, 'failed');
  });

  it('clears missing test-agent block when PASS evidence already exists', () => {
    writeState(blocked({
      blocked_by_hook: 'mpl-require-test-agent',
      blocked_phase: 'phase-1',
      blocked_artifact: 'state.test_agent_dispatched.phase-1',
      block_code: 'missing_or_invalid_test_agent_evidence',
      resume_instruction: 'Task(subagent_type="mpl-test-agent", model="sonnet", prompt="""...""")',
      retry_context: { phase_id: 'phase-1' },
      test_agent_dispatched: { 'phase-1': passEvidence() },
    }));

    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'recovered');
    assert.equal(result.phase_id, 'phase-1');
    assert.equal(readState().session_status, null);
  });

  it('keeps missing test-agent block intact while evidence is absent', () => {
    writeState(blocked({
      blocked_by_hook: 'mpl-require-test-agent',
      blocked_phase: 'phase-1',
      blocked_artifact: 'state.test_agent_dispatched.phase-1',
      block_code: 'missing_or_invalid_test_agent_evidence',
      resume_instruction: 'Task(subagent_type="mpl-test-agent", model="sonnet", prompt="""verify phase-1""")',
      retry_context: { phase_id: 'phase-1' },
    }));

    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'awaiting_test_agent');

    const state = readState();
    assert.equal(state.session_status, 'blocked_hook');
    assert.equal(state.retry_context.recovery.last_status, 'awaiting_test_agent');
    assert.match(state.resume_instruction, /mpl-test-agent/);
  });

  it('requires approval before inserting missing test_agent_required defaults', () => {
    mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
    writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), decompositionMissingTestAgentRequired());
    writeState(blocked({
      blocked_by_hook: 'mpl-artifact-schema',
      block_code: 'missing_artifact_schema',
      retry_context: {
        failures: [{
          artifact: 'decomposition',
          file: '.mpl/mpl/decomposition.yaml',
          missing: ['phase-1.test_agent_required'],
          missing_any_of: [],
        }],
      },
    }));

    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'requires_approval');
    assert.deepEqual(result.phase_ids, ['phase-1']);
    assert.equal(readState().session_status, 'blocked_hook');
  });

  it('patches missing test_agent_required with approval and clears the schema block', () => {
    mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
    writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), decompositionMissingTestAgentRequired());
    writeState(blocked({
      blocked_by_hook: 'mpl-artifact-schema',
      block_code: 'missing_artifact_schema',
      retry_context: {
        failures: [{
          artifact: 'decomposition',
          file: '.mpl/mpl/decomposition.yaml',
          missing: ['phase-1.test_agent_required'],
          missing_any_of: [],
        }],
      },
    }));

    const result = recoverBlockedHook(tmp, { approveUnsafe: true });
    assert.equal(result.status, 'recovered');

    const text = readFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), 'utf-8');
    assert.match(text, /test_agent_required: true/);
    assert.equal(readState().session_status, null);
  });
});
