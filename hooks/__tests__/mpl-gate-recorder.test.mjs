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
        block_reason: 'missing test-agent',
        resume_instruction: 'Dispatch mpl-test-agent for phase-1',
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
        block_reason: 'missing test-agent',
        resume_instruction: 'Dispatch mpl-test-agent for phase-1',
        blocked_at: '2026-05-18T00:00:00Z',
      });
      runHook(tmp, responseJson());
      const state = readState(tmp);
      assert.equal(state.session_status, null);
      assert.equal(state.blocked_by_hook, null);
      assert.equal(state.blocked_phase, null);
      assert.equal(state.block_reason, null);
      assert.equal(state.resume_instruction, null);
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
