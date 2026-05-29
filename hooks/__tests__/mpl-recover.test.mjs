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
    // #234: phase_contract_graph_invalid is now routed; use a fabricated
    // unknown code to verify the unsupported fall-through path.
    writeState(blocked({
      block_code: 'fabricated_unknown_code',
      retry_context: { issue_count: 1 },
    }));

    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'unsupported');

    const state = readState();
    assert.equal(state.session_status, 'blocked_hook');
    assert.equal(state.block_code, 'fabricated_unknown_code');
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

  /* ──────────────────── #234: new routing ──────────────────── */

  function writeMinimalDecompositionForDerive() {
    mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
    writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), `
goal_contract_hash: "abc"
phases:
  - id: phase-1
    phase_lang: typescript
    phase_domain: api
    impact:
      modify:
        - path: src/api.ts
    interface_contract:
      produces:
        - type: function
          name: createWidget
          spec: "(body: dict) -> Widget"
    verification_plan:
      a_items:
        - criterion: "valid"
          type: command
          command: "pytest"
      s_items:
        - criterion: "invalid"
          test_file: tests/x.py
          test_command: "pytest"
    goal_trace:
      acceptance_criteria: [AC-1]
      variation_axes: []
      ontology_entities: [api]
`);
  }

  it('#234: auto-regenerate handler reruns writeDerivedDecompositionFields on decomposition_derived_stale', () => {
    writeMinimalDecompositionForDerive();
    writeState(blocked({
      blocked_by_hook: 'mpl-decomposition-postprocess',
      block_code: 'decomposition_derived_stale',
      retry_context: { target: '.mpl/mpl/decomposition.yaml' },
    }));

    const plan = inspectRecovery(tmp);
    assert.equal(plan.status, 'recoverable');
    assert.equal(plan.handler, 'auto_regenerate');

    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'recovered');
    assert.equal(existsSync(join(tmp, '.mpl', 'mpl', 'decomposition-derived.json')), true);
    assert.equal(readState().session_status, null);
  });

  it('#234: auto-regenerate handler reruns writeTestAgentBriefs on test_agent_briefs_write_failed', () => {
    writeMinimalDecompositionForDerive();
    writeState(blocked({
      blocked_by_hook: 'mpl-decomposition-postprocess',
      block_code: 'test_agent_briefs_write_failed',
      retry_context: { target: '.mpl/mpl/decomposition.yaml' },
    }));

    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'recovered');
    assert.equal(existsSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1', 'test-agent-brief.yaml')), true);
    assert.equal(Array.isArray(result.produced) && result.produced.includes('phase-1'), true);
    assert.equal(readState().session_status, null);
  });

  it('#234 [data-integrity] codex r1: test_agent_briefs_write_failed does NOT clear block when decomposition.yaml is missing', () => {
    // codex r1 on PR #242: writeTestAgentBriefs returns an empty list
    // when decomposition.yaml is absent (no throw). The handler must
    // verify the post-condition and keep the block instead of
    // marking it recovered with no briefs produced.
    writeState(blocked({
      blocked_by_hook: 'mpl-decomposition-postprocess',
      block_code: 'test_agent_briefs_write_failed',
      retry_context: { target: '.mpl/mpl/decomposition.yaml' },
    }));

    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'failed');
    assert.equal(result.decomposition_present, false);
    assert.equal(result.produced_count, 0);
    assert.match(result.message, /decomposition\.yaml is missing/);
    assert.equal(readState().session_status, 'blocked_hook');
  });

  it('#234 [data-integrity] codex r1: test_agent_briefs_write_failed keeps block when decomposition has zero required phases', () => {
    // Decomposition exists but no phase has test_agent_required:true —
    // writeTestAgentBriefs returns [] → handler must keep the block.
    mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
    writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), `
phases:
  - id: phase-x
    test_agent_required: false
`);
    writeState(blocked({
      block_code: 'test_agent_briefs_write_failed',
      retry_context: {},
    }));

    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'failed');
    assert.equal(result.decomposition_present, true);
    assert.equal(result.produced_count, 0);
    assert.match(result.message, /zero briefs/);
    assert.equal(readState().session_status, 'blocked_hook');
  });

  it('#234 [data-integrity] codex r2: stale retry_context.recovery from a prior block does NOT poison a fresh auto-regenerate envelope', () => {
    // Codex r2 on PR #242: writeState uses deepMerge, so a prior
    // unresolved block's retry_context.recovery.attempts can survive
    // into a new block's envelope. Without scope-tagging, the budget
    // check would falsely refuse a fresh recoverable block.
    writeMinimalDecompositionForDerive();
    writeState(blocked({
      blocked_by_hook: 'mpl-decomposition-postprocess',
      block_code: 'decomposition_derived_stale',
      // Fresh envelope blocked_at:
      blocked_at: '2026-06-01T12:00:00Z',
      retry_context: {
        // Stale recovery survived from a different prior block. Note
        // its block_code / blocked_at do NOT match the current envelope.
        recovery: {
          block_code: 'goal_contract_baseline_corrupt',
          blocked_at: '2026-05-01T00:00:00Z',
          attempts: 3,
          last_status: 'failed',
        },
      },
    }));

    // Should NOT report budget exhausted — the stored attempts belong
    // to a different block. The fresh block must run the auto-fix.
    const plan = inspectRecovery(tmp);
    assert.equal(plan.status, 'recoverable');
    assert.equal(plan.handler, 'auto_regenerate');
    assert.equal(plan.attempts, 0);

    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'recovered');
    assert.equal(existsSync(join(tmp, '.mpl', 'mpl', 'decomposition-derived.json')), true);
  });

  it('#234 [data-integrity] codex r2: scope-matched retry_context.recovery is honored', () => {
    // Sanity check: when the stored recovery DOES match the current
    // block (same code + blocked_at), the budget enforcement still
    // works.
    writeMinimalDecompositionForDerive();
    writeState(blocked({
      blocked_by_hook: 'mpl-decomposition-postprocess',
      block_code: 'decomposition_derived_stale',
      blocked_at: '2026-06-01T12:00:00Z',
      retry_context: {
        recovery: {
          block_code: 'decomposition_derived_stale',
          blocked_at: '2026-06-01T12:00:00Z',
          attempts: 3,
          last_status: 'failed',
        },
      },
    }));

    const plan = inspectRecovery(tmp);
    assert.equal(plan.status, 'unsupported');
    assert.equal(plan.attempts, 3);

    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'failed');
    assert.match(result.message, /budget exhausted/);
  });

  it('#234: auto-regenerate handler exhausts retry budget on persistent failures', () => {
    // No decomposition.yaml on disk → writeDerivedDecompositionFields throws.
    // After AUTO_FIX_RETRY_BUDGET (3) attempts the handler should return failed.
    // Recovery state is scope-tagged to the active block (codex r2 fix).
    writeState(blocked({
      blocked_by_hook: 'mpl-decomposition-postprocess',
      block_code: 'decomposition_derived_stale',
      blocked_at: '2026-06-01T12:00:00Z',
      retry_context: {
        recovery: {
          block_code: 'decomposition_derived_stale',
          blocked_at: '2026-06-01T12:00:00Z',
          attempts: 3,
        },
      },
    }));

    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'failed');
    assert.match(result.message, /budget exhausted/);
    assert.equal(readState().session_status, 'blocked_hook');
  });

  it('#234: redispatch_decomposer handler reads diagnostics from retry_context.issues (real envelope shape) — codex r1', () => {
    // codex r1 on PR #242: covers_schema_violation hook records
    // validator findings under `retry_context.issues`, NOT `failures`.
    // The handler must normalize so the dispatch instruction echoes
    // the real diagnostics.
    writeState(blocked({
      blocked_by_hook: 'mpl-require-covers',
      block_code: 'covers_schema_violation',
      retry_context: {
        target: '.mpl/mpl/decomposition.yaml',
        issue_count: 1,
        issues: ['phase-1.covers[0]:UC-99 not in goal_contract'],
      },
    }));

    const plan = inspectRecovery(tmp);
    assert.equal(plan.status, 'requires_approval');
    assert.equal(plan.handler, 'redispatch_decomposer');

    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'awaiting_decomposer');
    assert.match(result.dispatch_instruction, /mpl-decomposer/);
    assert.match(result.dispatch_instruction, /UC-99/);
    assert.deepEqual(result.findings, ['phase-1.covers[0]:UC-99 not in goal_contract']);

    const state = readState();
    assert.equal(state.session_status, 'blocked_hook');
    assert.equal(state.retry_context.recovery.last_status, 'awaiting_decomposer');
  });

  it(`#234: redispatch_decomposer routes phase_contract_graph_invalid with retry_context.issues`, () => {
    writeState(blocked({
      block_code: 'phase_contract_graph_invalid',
      retry_context: {
        issue_count: 2,
        issues: ['phase-2.depends_on:cycle', 'tier-1.execution_mode:missing'],
      },
    }));
    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'awaiting_decomposer');
    assert.match(result.dispatch_instruction, /mpl-decomposer/);
    assert.match(result.dispatch_instruction, /depends_on:cycle/);
    assert.deepEqual(result.findings, ['phase-2.depends_on:cycle', 'tier-1.execution_mode:missing']);
  });

  it('#234: legacy retry_context.failures shape still works (back-compat)', () => {
    writeState(blocked({
      block_code: 'covers_schema_violation',
      retry_context: { failures: ['legacy-style finding'] },
    }));
    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'awaiting_decomposer');
    assert.match(result.dispatch_instruction, /legacy-style finding/);
  });

  it('#234: goal_contract_invalid is routed to user_action (NOT decomposer) — codex r1 [logic]', () => {
    // codex r1 on PR #242: goal_contract_invalid is emitted with
    // resumeInstruction "Restore a valid .mpl/goal-contract.yaml" —
    // a decomposer re-dispatch cannot repair a missing source file.
    // Recovery must echo the user instruction, NOT generate a Task call.
    writeState(blocked({
      blocked_by_hook: 'mpl-require-goal-trace',
      block_code: 'goal_contract_invalid',
      resume_instruction: 'Restore a valid .mpl/goal-contract.yaml, then retry the decomposition write.',
      retry_context: { missing: ['mission.goal', 'acceptance_criteria'] },
    }));

    const plan = inspectRecovery(tmp);
    assert.equal(plan.status, 'requires_user_action');
    assert.equal(plan.handler, 'goal_contract_invalid');

    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'requires_user_action');
    assert.match(result.user_instruction, /Restore a valid \.mpl\/goal-contract\.yaml/);
    assert.match(result.user_instruction, /mission\.goal/);
    assert.deepEqual(result.findings, ['mission.goal', 'acceptance_criteria']);
    // No dispatch_instruction — this is user action, not agent re-dispatch.
    assert.equal(result.dispatch_instruction, undefined);
    assert.equal(readState().session_status, 'blocked_hook');
  });

  it('#234: phase_runner_anomaly handler returns anomaly-specific dispatch instruction', () => {
    writeState(blocked({
      blocked_by_hook: 'mpl-gate-recorder',
      blocked_phase: 'phase-1',
      block_code: 'phase_runner_empty_response',
      retry_context: { phase_id: 'phase-1' },
    }));

    const plan = inspectRecovery(tmp);
    assert.equal(plan.status, 'requires_approval');
    assert.equal(plan.handler, 'phase_runner_anomaly');
    assert.equal(plan.anomaly, 'empty_response');

    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'awaiting_phase_runner');
    assert.match(result.dispatch_instruction, /mpl-phase-runner/);
    assert.match(result.dispatch_instruction, /stronger framing/);
    assert.equal(result.anomaly, 'empty_response');
  });

  it('#234: phase_runner_anomaly handler falls back gracefully on unknown anomaly type', () => {
    writeState(blocked({
      block_code: 'phase_runner_some_new_anomaly',
      // Empty resume_instruction forces the generic re-dispatch template path.
      resume_instruction: '',
      retry_context: {},
    }));

    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'awaiting_phase_runner');
    assert.equal(result.anomaly, 'some_new_anomaly');
    assert.match(result.dispatch_instruction, /mpl-phase-runner/);
  });

  it('#234: baseline_immutable handler returns user_instruction without agent dispatch', () => {
    writeState(blocked({
      blocked_by_hook: 'mpl-baseline-guard',
      block_code: 'baseline_immutable',
      resume_instruction: 'Touch .mpl/mpl/.baseline-renewal to authorize a new baseline write, then retry.',
    }));

    const plan = inspectRecovery(tmp);
    assert.equal(plan.status, 'requires_user_action');
    assert.equal(plan.handler, 'baseline_immutable');

    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'requires_user_action');
    assert.match(result.user_instruction, /baseline-renewal/);
    assert.equal(readState().session_status, 'blocked_hook');
  });

  it('#234: phantom alias goal_contract_hash_corrupt is NOT routed (drop confirmed)', () => {
    // The pre-#234 alias was unreachable (no hook ever emitted it) but
    // routed defensively. Now it must fall through to unsupported.
    writeState(blocked({
      block_code: 'goal_contract_hash_corrupt',
      retry_context: {},
    }));
    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'unsupported');
  });

  it('#234: phantom alias goal_contract_hash_mismatch is NOT routed (drop confirmed)', () => {
    writeState(blocked({
      block_code: 'goal_contract_hash_mismatch',
      retry_context: {},
    }));
    const result = recoverBlockedHook(tmp);
    assert.equal(result.status, 'unsupported');
  });
});
