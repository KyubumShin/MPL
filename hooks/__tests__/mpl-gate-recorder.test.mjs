import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';
import {
  isPassingTestAgentEvidence,
  parseTestAgentEvidence,
  TEST_AGENT_EVIDENCE_PREVIEW_LIMIT,
  TEST_AGENT_RESPONSE_PREVIEW_LIMIT,
} from '../lib/mpl-test-agent-evidence.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-gate-recorder.mjs');

function seedState(dir, extra = {}) {
  mkdirSync(join(dir, '.mpl'), { recursive: true });
  writeFileSync(join(dir, '.mpl', 'state.json'), JSON.stringify({
    schema_version: CURRENT_SCHEMA_VERSION,
    current_phase: 'phase2-sprint',
    test_agent_dispatched: {},
    ...extra,
  }, null, 2));
}

function readState(dir) {
  return JSON.parse(readFileSync(join(dir, '.mpl', 'state.json'), 'utf-8'));
}

function runHook(dir, toolResponse, prompt = 'Verify phase-1 from the contract.') {
  const input = {
    cwd: dir,
    tool_name: 'Task',
    tool_input: {
      subagent_type: 'mpl-test-agent',
      prompt,
    },
    tool_response: toolResponse,
  };
  return JSON.parse(execFileSync('node', [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
  }));
}

function responsePayload(overrides = {}) {
  const payload = {
    phase_id: 'phase-1',
    test_files_created: overrides.test_files_created || ['tests/phase-1.test.ts'],
    test_results: {
      total: 2,
      passed: 2,
      failed: overrides.failed ?? 0,
      skipped: overrides.skipped ?? 0,
      pass_rate: 100,
    },
    commands_run: overrides.commands_run || [{
      command: 'npm test -- tests/phase-1.test.ts',
      exit_code: overrides.exit_code ?? 0,
    }],
    a_item_coverage: [{ id: 'A-1', test: 'contract', status: 'PASS', evidence: 'ok' }],
    s_item_coverage: [{ id: 'S-1', test: 'scenario', status: 'PASS', evidence: 'ok' }],
    bugs_found: overrides.bugs_found || [],
    coverage_info: {},
  };
  if (!overrides.omitVerdict) payload.verdict = overrides.verdict || 'PASS';
  return payload;
}

function responseJson(overrides = {}) {
  return `\`\`\`json
${JSON.stringify(responsePayload(overrides), null, 2)}
\`\`\``;
}

describe('mpl-gate-recorder test-agent evidence', () => {
  it('records structured PASS evidence from mpl-test-agent JSON output', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gate-recorder-'));
    try {
      seedState(tmp);
      const r = runHook(tmp, responseJson());
      assert.equal(r.continue, true);
      const state = readState(tmp);
      const ev = state.test_agent_dispatched['phase-1'];
      assert.equal(ev.valid_json, true);
      assert.equal(ev.verdict, 'PASS');
      assert.deepEqual(ev.command_exit_codes, [0]);
      assert.equal(ev.tests_total, 2);
      assert.equal(ev.bugs_found_count, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('bounds oversized test-agent arrays while preserving PASS semantics', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gate-recorder-bounded-'));
    try {
      seedState(tmp);
      const testFiles = Array.from(
        { length: TEST_AGENT_EVIDENCE_PREVIEW_LIMIT + 5 },
        (_, i) => `tests/generated-${i}.test.ts`
      );
      const commandsRun = Array.from(
        { length: TEST_AGENT_EVIDENCE_PREVIEW_LIMIT + 7 },
        (_, i) => ({ command: `npm test -- shard=${i}`, exit_code: 0 })
      );

      runHook(tmp, responseJson({ test_files_created: testFiles, commands_run: commandsRun }));
      const ev = readState(tmp).test_agent_dispatched['phase-1'];

      assert.equal(ev.test_files_created.length, TEST_AGENT_EVIDENCE_PREVIEW_LIMIT);
      assert.equal(ev.test_files_created_count, testFiles.length);
      assert.equal(ev.test_files_created_truncated, true);
      assert.equal(ev.command_exit_codes.length, TEST_AGENT_EVIDENCE_PREVIEW_LIMIT);
      assert.equal(ev.command_exit_codes_count, commandsRun.length);
      assert.equal(ev.command_exit_codes_nonzero_count, 0);
      assert.equal(ev.command_exit_codes_truncated, true);
      assert.equal(isPassingTestAgentEvidence(ev), true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not hide nonzero command exits outside the stored preview', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gate-recorder-bounded-fail-'));
    try {
      seedState(tmp);
      const commandsRun = Array.from(
        { length: TEST_AGENT_EVIDENCE_PREVIEW_LIMIT + 1 },
        (_, i) => ({ command: `npm test -- shard=${i}`, exit_code: i < TEST_AGENT_EVIDENCE_PREVIEW_LIMIT ? 0 : 1 })
      );

      runHook(tmp, responseJson({ commands_run: commandsRun }));
      const ev = readState(tmp).test_agent_dispatched['phase-1'];

      assert.deepEqual(ev.command_exit_codes, Array(TEST_AGENT_EVIDENCE_PREVIEW_LIMIT).fill(0));
      assert.equal(ev.command_exit_codes_count, commandsRun.length);
      assert.equal(ev.command_exit_codes_nonzero_count, 1);
      assert.equal(ev.verdict, 'FAIL');
      assert.match(ev.invalid_reason, /nonzero_command_exit_code/);
      assert.equal(isPassingTestAgentEvidence(ev), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('keeps blocked_hook when test-agent evidence is not PASS', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gate-recorder-fail-'));
    try {
      seedState(tmp, {
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-require-test-agent',
        blocked_phase: 'phase-1',
        blocked_artifact: 'state.test_agent_dispatched.phase-1',
        block_code: 'missing_or_invalid_test_agent_evidence',
        block_reason: 'missing test-agent',
        resume_instruction: 'Dispatch mpl-test-agent for phase-1',
        retry_context: { phase_id: 'phase-1' },
        blocked_at: '2026-05-18T00:00:00Z',
      });
      runHook(tmp, responseJson({ failed: 1, verdict: 'FAIL' }));
      const state = readState(tmp);
      assert.equal(state.session_status, 'blocked_hook');
      assert.equal(state.test_agent_dispatched['phase-1'].verdict, 'FAIL');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('clears matching blocked_hook once PASS evidence is recorded', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gate-recorder-clear-'));
    try {
      seedState(tmp, {
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-require-test-agent',
        blocked_phase: 'phase-1',
        blocked_artifact: 'state.test_agent_dispatched.phase-1',
        block_code: 'missing_or_invalid_test_agent_evidence',
        block_reason: 'missing test-agent',
        resume_instruction: 'Dispatch mpl-test-agent for phase-1',
        retry_context: { phase_id: 'phase-1' },
        blocked_at: '2026-05-18T00:00:00Z',
      });
      runHook(tmp, responseJson());
      const state = readState(tmp);
      assert.equal(state.session_status, null);
      assert.equal(state.blocked_by_hook, null);
      assert.equal(state.blocked_phase, null);
      assert.equal(state.blocked_artifact, null);
      assert.equal(state.block_code, null);
      assert.equal(state.block_reason, null);
      assert.equal(state.resume_instruction, null);
      assert.equal(state.retry_context, null);
      assert.equal(state.blocked_at, null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('records missing verdict as INVALID and does not accept it as PASS evidence', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gate-recorder-no-verdict-'));
    try {
      seedState(tmp);
      runHook(tmp, responseJson({ omitVerdict: true }));
      const state = readState(tmp);
      const ev = state.test_agent_dispatched['phase-1'];
      assert.equal(ev.valid_json, true);
      assert.equal(ev.verdict, 'INVALID');
      assert.match(ev.invalid_reason, /missing_verdict/);
      assert.equal(isPassingTestAgentEvidence(ev), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips test-agent records when the prompt has no phase id', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gate-recorder-no-phase-'));
    try {
      seedState(tmp);
      runHook(tmp, responseJson(), 'Verify the current contract.');
      const state = readState(tmp);
      assert.deepEqual(state.test_agent_dispatched, {});
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects response objects without test-agent fields as invalid JSON payloads', () => {
    const ev = parseTestAgentEvidence({
      phaseId: 'phase-1',
      response: { message: 'completed without structured payload' },
    });
    assert.equal(ev.valid_json, false);
    assert.equal(ev.verdict, 'INVALID');
    assert.equal(ev.invalid_reason, 'missing_test_agent_fields');
    assert.match(ev.response_preview, /completed without structured payload/);
  });

  it('records prose-only test-agent diagnostics without accepting PASS', () => {
    const prose = `Tests passed.\n${'x'.repeat(TEST_AGENT_RESPONSE_PREVIEW_LIMIT + 30)}`;
    const ev = parseTestAgentEvidence({
      phaseId: 'phase-1',
      response: prose,
    });
    assert.equal(ev.valid_json, false);
    assert.equal(ev.verdict, 'INVALID');
    assert.equal(ev.invalid_reason, 'missing_json_block');
    assert.ok(ev.response_preview.length <= TEST_AGENT_RESPONSE_PREVIEW_LIMIT);
    assert.match(ev.response_preview, /\[truncated\]/);
    assert.equal(isPassingTestAgentEvidence(ev), false);
  });

  it('marks empty test-agent returns with an explicit anomaly reason', () => {
    const ev = parseTestAgentEvidence({
      phaseId: 'phase-1',
      response: '',
      anomaly: { type: 'zero_token_after_tools' },
    });
    assert.equal(ev.valid_json, false);
    assert.equal(ev.verdict, 'INVALID');
    assert.equal(ev.invalid_reason, 'empty_response_anomaly');
    assert.equal(ev.subagent_anomaly_type, 'zero_token_after_tools');
  });

  it('records empty test-agent Task returns as anomalies without rewriting response_len', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gate-recorder-anomaly-'));
    try {
      seedState(tmp);
      const input = {
        cwd: tmp,
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'mpl-test-agent',
          prompt: 'Verify phase-1 from the contract.',
        },
        tool_response: '',
        usage: { output_tokens: 0 },
        metrics: { tools_used: 32, duration_ms: 34 * 60 * 1000 },
      };
      const r = JSON.parse(execFileSync('node', [HOOK_PATH], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
      }));
      assert.equal(r.continue, true);
      assert.match(r.systemMessage, /SUBAGENT RETURN ANOMALY/);
      const state = readState(tmp);
      assert.equal(state.subagent_return_anomalies.length, 1);
      assert.equal(state.subagent_return_anomalies[0].type, 'zero_token_after_tools');
      const ev = state.test_agent_dispatched['phase-1'];
      assert.equal(ev.response_len, 0);
      assert.equal(ev.invalid_reason, 'empty_response_anomaly');
      assert.equal(ev.subagent_anomaly_type, 'zero_token_after_tools');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('requires the full evidence contract, not verdict alone, for PASS consumption', () => {
    assert.equal(isPassingTestAgentEvidence({
      valid_json: true,
      verdict: 'PASS',
      command_exit_codes: [0],
    }), false);
  });

  it('rejects legacy array-only PASS evidence without scalar counts', () => {
    assert.equal(isPassingTestAgentEvidence({
      valid_json: true,
      verdict: 'PASS',
      invalid_reason: null,
      tests_total: 1,
      tests_failed: 0,
      tests_skipped: 0,
      test_files_created: ['tests/phase-1.test.ts'],
      command_exit_codes: [0],
      bugs_found_count: 0,
    }), false);
  });

  it('accepts content-array Task responses by extracting the text payload (codex r1)', () => {
    // Real Task tool responses arrive shaped as
    // { content: [{ type: 'text', text: '<assistant message>' }, ...] }
    // The parser must extract that text and parse the fenced JSON inside.
    const fenced = '```json\n' + JSON.stringify({
      phase_id: 'phase-1',
      verdict: 'PASS',
      test_results: { total: 3, passed: 3, failed: 0, skipped: 0, pass_rate: 100 },
      test_files_created: ['tests/phase-1.test.ts'],
      commands_run: [{ command: 'npm test', exit_code: 0 }],
      bugs_found: [],
      a_item_coverage: [{ id: 'A-1', status: 'PASS' }],
      s_item_coverage: [{ id: 'S-1', status: 'PASS' }],
    }) + '\n```';
    const ev = parseTestAgentEvidence({
      phaseId: 'phase-1',
      response: { content: [{ type: 'text', text: fenced }] },
    });
    assert.equal(ev.valid_json, true);
    assert.equal(ev.verdict, 'PASS');
    assert.equal(ev.invalid_reason, null);
  });

  it('rejects prose-before-fence outputs with prose_outside_json_fence (codex r1)', () => {
    // The test-agent prompt requires the final message to start with the
    // fence and have no prose outside. A response with leading prose must
    // not slip through to PASS even when the fenced JSON itself is valid.
    const promiseProse = 'Tests passed. Summary follows.\n\n```json\n' + JSON.stringify({
      phase_id: 'phase-1', verdict: 'PASS',
      test_results: { total: 1, passed: 1, failed: 0, skipped: 0 },
    }) + '\n```';
    const ev = parseTestAgentEvidence({
      phaseId: 'phase-1',
      response: promiseProse,
    });
    assert.equal(ev.valid_json, false);
    assert.equal(ev.verdict, 'INVALID');
    assert.equal(ev.invalid_reason, 'prose_outside_json_fence');
  });

  it('rejects bare objects bypassing strict-fence even with test-agent fields (codex r2)', () => {
    // Codex r2 on PR #218: a bare object with test_results/phase_id used
    // to short-circuit and become valid PASS evidence, defeating the new
    // strict-fence rule. All payloads must pass through text extraction
    // and the fenced-JSON gate.
    const bareObject = {
      phase_id: 'phase-1',
      verdict: 'PASS',
      test_results: { total: 1, passed: 1, failed: 0, skipped: 0, pass_rate: 100 },
      test_files_created: ['tests/phase-1.test.ts'],
      commands_run: [{ command: 'npm test', exit_code: 0 }],
      bugs_found: [],
    };
    const ev = parseTestAgentEvidence({
      phaseId: 'phase-1',
      response: bareObject,
    });
    assert.equal(ev.valid_json, false);
    assert.equal(ev.verdict, 'INVALID');
    assert.equal(ev.invalid_reason, 'missing_test_agent_fields');
    assert.equal(isPassingTestAgentEvidence(ev), false);
  });

  it('rejects bare JSON (no fence) with missing_json_block (codex r1)', () => {
    const bare = JSON.stringify({ phase_id: 'phase-1', verdict: 'PASS' });
    const ev = parseTestAgentEvidence({
      phaseId: 'phase-1',
      response: bare,
    });
    assert.equal(ev.valid_json, false);
    assert.equal(ev.invalid_reason, 'missing_json_block');
  });

  it('test-agent valid PASS JSON with anomaly is INVALID, not PASS (codex r4)', () => {
    // Codex r4 on PR #218: a syntactically valid PASS JSON paired with a
    // recorded subagent anomaly must NOT clear the verifier trust
    // boundary. The anomaly is added to the issues list so invalid_reason
    // stays non-null and isPassingTestAgentEvidence returns false.
    const fenced = '```json\n' + JSON.stringify({
      phase_id: 'phase-1',
      verdict: 'PASS',
      test_results: { total: 3, passed: 3, failed: 0, skipped: 0, pass_rate: 100 },
      test_files_created: ['tests/phase-1.test.ts'],
      commands_run: [{ command: 'npm test', exit_code: 0 }],
      bugs_found: [],
      a_item_coverage: [{ id: 'A-1', status: 'PASS' }],
      s_item_coverage: [{ id: 'S-1', status: 'PASS' }],
    }) + '\n```';
    const ev = parseTestAgentEvidence({
      phaseId: 'phase-1',
      response: fenced,
      anomaly: { type: 'zero_token_after_tools' },
    });
    assert.equal(ev.valid_json, true);
    assert.equal(ev.verdict, 'INVALID');
    assert.match(ev.invalid_reason, /subagent_anomaly:zero_token_after_tools/);
    assert.equal(ev.subagent_anomaly_type, 'zero_token_after_tools');
    assert.equal(isPassingTestAgentEvidence(ev), false);
  });

  it('phase-runner anomaly installs blocked_hook envelope (codex r4)', () => {
    // Codex r4 on PR #218: phase-runner anomaly must structurally block
    // progression — the orchestrator advances from PLAN.md state, not
    // sprint_status, so a non-blocking systemMessage is insufficient.
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gate-recorder-phase-runner-block-'));
    try {
      seedState(tmp);
      const input = {
        cwd: tmp,
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'mpl-phase-runner',
          prompt: 'Execute phase-3.',
        },
        tool_response: '',
        usage: { output_tokens: 0 },
        metrics: { tools_used: 40, duration_ms: 28 * 60 * 1000 },
      };
      const r = JSON.parse(execFileSync('node', [HOOK_PATH], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
      }));
      assert.equal(r.continue, true);
      const state = readState(tmp);
      assert.equal(state.session_status, 'blocked_hook',
        'phase-runner anomaly must install a blocked_hook envelope');
      assert.equal(state.blocked_by_hook, 'mpl-gate-recorder');
      assert.match(state.block_code, /^phase_runner_/);
      assert.equal(typeof state.retry_context, 'object');
      assert.equal(state.retry_context.agent_type, 'mpl-phase-runner');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('test-agent PASS does not clear a phase_runner_* block (codex r5 hook-order regression)', () => {
    // Codex r5 on PR #218: when mpl-gate-recorder installs a
    // phase_runner_<anomaly> block, a later test-agent PASS in the same
    // gate-recorder pass must NOT clear the structural anomaly block.
    // The clear-on-PASS branch only nulls session_status when
    // blocked_by_hook === 'mpl-require-test-agent'.
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gate-recorder-block-survive-'));
    try {
      seedState(tmp, {
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-gate-recorder',
        blocked_phase: 'phase-1',
        blocked_artifact: 'state.subagent_return_anomalies[empty_response]',
        block_code: 'phase_runner_empty_response',
        block_reason: 'phase-runner returned empty after substantial tool work',
        resume_instruction: 'Verify phase artifacts; re-dispatch the runner.',
        blocked_at: '2026-05-27T00:00:00.000Z',
        retry_context: { agent_type: 'mpl-phase-runner', anomaly_type: 'empty_response' },
      });
      // Now a test-agent PASS arrives.
      const fenced = '```json\n' + JSON.stringify({
        phase_id: 'phase-1',
        verdict: 'PASS',
        test_results: { total: 3, passed: 3, failed: 0, skipped: 0, pass_rate: 100 },
        test_files_created: ['tests/phase-1.test.ts'],
        commands_run: [{ command: 'npm test', exit_code: 0 }],
        bugs_found: [],
        a_item_coverage: [{ id: 'A-1', status: 'PASS' }],
        s_item_coverage: [{ id: 'S-1', status: 'PASS' }],
      }) + '\n```';
      runHook(tmp, fenced);
      const state = readState(tmp);
      // Phase-runner anomaly block survives.
      assert.equal(state.session_status, 'blocked_hook');
      assert.equal(state.blocked_by_hook, 'mpl-gate-recorder');
      assert.equal(state.block_code, 'phase_runner_empty_response');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('phase-runner clean re-dispatch self-clears a prior phase_runner_* block (codex r6)', () => {
    // Codex r6 on PR #218: after a phase-runner anomaly installs a
    // phase_runner_* block, a subsequent non-anomalous phase-runner
    // completion must clear that block; otherwise transient anomalies
    // permanently pause the pipeline with no recovery path.
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gate-recorder-phase-runner-self-clear-'));
    try {
      seedState(tmp, {
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-gate-recorder',
        blocked_phase: 'phase-1',
        blocked_artifact: 'state.subagent_return_anomalies[empty_response]',
        block_code: 'phase_runner_empty_response',
        block_reason: 'prior anomaly',
        resume_instruction: 'rerun',
        blocked_at: '2026-05-27T00:00:00.000Z',
        retry_context: { agent_type: 'mpl-phase-runner' },
      });
      const input = {
        cwd: tmp,
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'mpl-phase-runner',
          prompt: 'Re-execute phase-1.',
        },
        tool_response: 'Phase 1 completed successfully.',
        usage: { output_tokens: 1500 },
        metrics: { tools_used: 12, duration_ms: 5 * 60 * 1000 },
      };
      execFileSync('node', [HOOK_PATH], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
      });
      const state = readState(tmp);
      assert.equal(state.session_status, null,
        'clean phase-runner re-dispatch must clear its own phase_runner_* block');
      assert.equal(state.blocked_by_hook, null);
      assert.equal(state.block_code, null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('background phase-runner Task dispatch does NOT record anomaly or install block (codex r8)', () => {
    // Codex r8 on PR #218: a background Task dispatch returns a handle
    // stub, not the final assistant text. Recording it as empty_response
    // would freeze the pipeline before the real completion is joined.
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gate-recorder-bg-phase-runner-'));
    try {
      seedState(tmp);
      const input = {
        cwd: tmp,
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'mpl-phase-runner',
          prompt: 'Execute phase-1.',
          run_in_background: true,
        },
        tool_response: { handle: 'task-bg-abc123' },
        usage: { output_tokens: 0 },
        metrics: { tools_used: 0, duration_ms: 100 },
      };
      execFileSync('node', [HOOK_PATH], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
      });
      const state = readState(tmp);
      assert.equal(Array.isArray(state.subagent_return_anomalies) ? state.subagent_return_anomalies.length : 0, 0,
        'background dispatch must NOT create anomaly entries');
      assert.notEqual(state.session_status, 'blocked_hook',
        'background dispatch must NOT install a block');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('background test-agent Task dispatch does NOT record dispatched evidence (codex r8)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gate-recorder-bg-test-agent-'));
    try {
      seedState(tmp);
      const input = {
        cwd: tmp,
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'mpl-test-agent',
          prompt: 'Verify phase-1 from the contract.',
          run_in_background: true,
        },
        tool_response: { handle: 'task-bg-xyz' },
      };
      execFileSync('node', [HOOK_PATH], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
      });
      const state = readState(tmp);
      assert.deepEqual(state.test_agent_dispatched, {},
        'background dispatch must NOT write evidence');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('phase-runner clean completion for a DIFFERENT phase does NOT clear an anomaly block (codex r7)', () => {
    // Codex r7 on PR #218: self-clear must match the blocked phase id.
    // A clean phase-runner completion for phase-2 must not clear a
    // phase-1 anomaly block.
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gate-recorder-phase-runner-cross-phase-'));
    try {
      seedState(tmp, {
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-gate-recorder',
        blocked_phase: 'phase-1',
        blocked_artifact: 'state.subagent_return_anomalies[empty_response]',
        block_code: 'phase_runner_empty_response',
        block_reason: 'phase-1 anomaly',
        resume_instruction: 'rerun phase-1',
        blocked_at: '2026-05-27T00:00:00.000Z',
        retry_context: { agent_type: 'mpl-phase-runner', phase_id: 'phase-1' },
      });
      const input = {
        cwd: tmp,
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'mpl-phase-runner',
          prompt: 'Re-execute phase-2.',
        },
        tool_response: 'Phase 2 completed successfully.',
        usage: { output_tokens: 1500 },
        metrics: { tools_used: 12, duration_ms: 5 * 60 * 1000 },
      };
      execFileSync('node', [HOOK_PATH], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
      });
      const state = readState(tmp);
      // Phase-1 anomaly block must STILL be active.
      assert.equal(state.session_status, 'blocked_hook');
      assert.equal(state.blocked_phase, 'phase-1');
      assert.equal(state.block_code, 'phase_runner_empty_response');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('phase-runner anomaly does NOT overwrite paused_budget / verification_hang / cancelled session states (codex r10)', () => {
    // Codex r10 bounded review [logic]: !== 'blocked_hook' would overwrite
    // any non-blocked-hook status, including the global pause/hang/cancel
    // states. Anomaly block must only install when session is null/active.
    for (const status of ['paused_budget', 'paused_checkpoint', 'verification_hang', 'cancelled']) {
      const tmp = mkdtempSync(join(tmpdir(), `mpl-gate-recorder-status-${status}-`));
      try {
        seedState(tmp, { session_status: status });
        const input = {
          cwd: tmp,
          tool_name: 'Task',
          tool_input: {
            subagent_type: 'mpl-phase-runner',
            prompt: 'Execute phase-3.',
          },
          tool_response: '',
          usage: { output_tokens: 0 },
          metrics: { tools_used: 40, duration_ms: 28 * 60 * 1000 },
        };
        execFileSync('node', [HOOK_PATH], {
          input: JSON.stringify(input),
          encoding: 'utf-8',
        });
        const state = readState(tmp);
        assert.equal(state.session_status, status,
          `session_status=${status} must NOT be overwritten by anomaly block`);
        // The anomaly is still recorded for visibility.
        assert.equal(state.subagent_return_anomalies.length, 1,
          `anomaly should still be recorded even when block install is skipped (status=${status})`);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  });

  it('phase-runner anomaly does NOT clobber a pre-existing blocked_hook (codex r4)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gate-recorder-phase-runner-noclobber-'));
    try {
      seedState(tmp, {
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-require-test-agent',
        blocked_phase: 'phase-1',
        blocked_artifact: 'state.test_agent_dispatched.phase-1',
        block_code: 'missing_or_invalid_test_agent_evidence',
        block_reason: 'pre-existing more specific block',
        resume_instruction: 'follow existing recovery',
        blocked_at: '2026-05-27T00:00:00.000Z',
        retry_context: { from: 'earlier' },
      });
      const input = {
        cwd: tmp,
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'mpl-phase-runner',
          prompt: 'Execute phase-3.',
        },
        tool_response: '',
        usage: { output_tokens: 0 },
        metrics: { tools_used: 40, duration_ms: 28 * 60 * 1000 },
      };
      execFileSync('node', [HOOK_PATH], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
      });
      const state = readState(tmp);
      // The pre-existing more-specific block must survive.
      assert.equal(state.blocked_by_hook, 'mpl-require-test-agent');
      assert.equal(state.block_code, 'missing_or_invalid_test_agent_evidence');
      // Anomaly is still recorded for visibility.
      assert.equal(state.subagent_return_anomalies.length, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('phase-runner anomaly does not advance sprint_status.completed_todos (codex r3)', () => {
    // Codex r3 on PR #218: when the phase-runner returns anomalous output
    // (empty / zero tokens after substantial tool work), the hook must not
    // count a possibly-stale state-summary.md as a completed phase.
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gate-recorder-phase-runner-anomaly-'));
    try {
      seedState(tmp, { sprint_status: { completed_todos: 0, in_progress_todos: 0, failed_todos: 0, total_todos: 1 } });
      // Plant a stale on-disk state-summary.md so countCompletedPhases would
      // otherwise increment to 1.
      mkdirSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1'), { recursive: true });
      writeFileSync(
        join(tmp, '.mpl', 'mpl', 'phases', 'phase-1', 'state-summary.md'),
        '# phase-1 state summary\nstatus: COMPLETED\n'
      );
      const input = {
        cwd: tmp,
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'mpl-phase-runner',
          prompt: 'Execute phase-1.',
        },
        tool_response: '',  // empty final response after tool work
        usage: { output_tokens: 0 },
        metrics: { tools_used: 40, duration_ms: 28 * 60 * 1000 },
      };
      const r = JSON.parse(execFileSync('node', [HOOK_PATH], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
      }));
      assert.equal(r.continue, true);
      assert.match(r.systemMessage, /SUBAGENT RETURN ANOMALY/);
      const state = readState(tmp);
      // The anomaly is recorded …
      assert.equal(state.subagent_return_anomalies.length, 1);
      assert.equal(state.subagent_return_anomalies[0].agent_type, 'mpl-phase-runner');
      // … but completed_todos must STAY at 0 — not auto-advance from the
      // stale state-summary.md.
      assert.equal(state.sprint_status.completed_todos, 0,
        'phase-runner anomaly must NOT advance completed_todos');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/* ─── Stage A Phase 1.6c-i (PR #186 review fix): Bash gate routing ─── */

describe('mpl-gate-recorder Bash gate routing — release-gate vs whole-pipeline', () => {
  function runBashHook(dir, { command, exit_code, stdout = '' }) {
    const input = {
      cwd: dir,
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: { stdout, exit_code },
    };
    return JSON.parse(execFileSync('node', [HOOK_PATH], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
    }));
  }

  it('current_phase=release-gate routes hard2_coverage into state.release.gate_results (NOT top-level)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gr-release-'));
    try {
      // Seed both subtrees so the assertion has a real before/after for
      // top-level isolation (RFC §5.5).
      const topLevelBefore = {
        hard1_passed: null, hard2_passed: null, hard3_passed: null,
        hard1_baseline: null, hard2_coverage: null, hard3_resilience: null,
      };
      seedState(tmp, {
        current_phase: 'release-gate',
        gate_results: { ...topLevelBefore },
        release: {
          current_cut_id: 'mvp',
          completed_cut_ids: [],
          fix_loop_count: 0,
          pending_artifact: null,
          gate_results: {
            hard1_passed: null, hard2_passed: null, hard3_passed: null,
            hard1_baseline: null, hard2_coverage: null, hard3_resilience: null,
          },
          max_fix_loops: 3,
        },
      });
      runBashHook(tmp, { command: 'npm test', exit_code: 0 });
      const state = readState(tmp);
      // Scoped subtree got the entry.
      assert.equal(state.release.gate_results.hard2_coverage.exit_code, 0);
      assert.equal(state.release.gate_results.hard2_coverage.command, 'npm test');
      // Top-level untouched (RFC §5.5 isolation).
      assert.equal(state.gate_results.hard2_coverage, null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('current_phase=phase3-gate routes hard2_coverage into top-level state.gate_results (unchanged behavior)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gr-phase3-'));
    try {
      seedState(tmp, {
        current_phase: 'phase3-gate',
        release: {
          current_cut_id: null, completed_cut_ids: [], fix_loop_count: 0,
          pending_artifact: null, max_fix_loops: 3,
          gate_results: {
            hard1_passed: null, hard2_passed: null, hard3_passed: null,
            hard1_baseline: null, hard2_coverage: null, hard3_resilience: null,
          },
        },
      });
      runBashHook(tmp, { command: 'npm test', exit_code: 0 });
      const state = readState(tmp);
      assert.equal(state.gate_results.hard2_coverage.exit_code, 0);
      // Scoped subtree NOT polluted by whole-pipeline evidence.
      assert.equal(state.release.gate_results.hard2_coverage, null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('current_phase=phase2-sprint routes to top-level (pre-Stage-A default)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gr-sprint-'));
    try {
      seedState(tmp, {
        current_phase: 'phase2-sprint',
        release: {
          current_cut_id: null, completed_cut_ids: [], fix_loop_count: 0,
          pending_artifact: null, max_fix_loops: 3,
          gate_results: {
            hard1_passed: null, hard2_passed: null, hard3_passed: null,
            hard1_baseline: null, hard2_coverage: null, hard3_resilience: null,
          },
        },
      });
      runBashHook(tmp, { command: 'npm test', exit_code: 0 });
      const state = readState(tmp);
      assert.equal(state.gate_results.hard2_coverage.exit_code, 0);
      assert.equal(state.release.gate_results.hard2_coverage, null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('release-gate FAIL exit_code is recorded into release subtree with first-failure-wins semantics', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-gr-rel-fail-'));
    try {
      seedState(tmp, {
        current_phase: 'release-gate',
        release: {
          current_cut_id: 'mvp',
          completed_cut_ids: [],
          fix_loop_count: 0,
          pending_artifact: null,
          gate_results: {
            hard1_passed: null, hard2_passed: null, hard3_passed: null,
            hard1_baseline: null,
            hard2_coverage: { exit_code: 1, command: 'npm test', timestamp: '2026-05-24T00:00:00Z' },
            hard3_resilience: null,
          },
          max_fix_loops: 3,
        },
      });
      // Second run with PASS — first-failure-wins means the new PASS
      // overrides the prior failure (fix-loop succeeded). Same semantics
      // as the top-level branch (lines 303-305 in mpl-gate-recorder.mjs).
      runBashHook(tmp, { command: 'npm test', exit_code: 0 });
      const state = readState(tmp);
      assert.equal(state.release.gate_results.hard2_coverage.exit_code, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
