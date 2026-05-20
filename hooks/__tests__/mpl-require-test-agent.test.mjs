import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-require-test-agent.mjs');

function passingEvidence() {
  return {
    timestamp: '2026-05-18T00:00:00Z',
    valid_json: true,
    verdict: 'PASS',
    command_exit_codes: [0],
    tests_total: 2,
    tests_passed: 2,
    tests_failed: 0,
    tests_skipped: 0,
    test_files_created: ['tests/phase-1.test.ts'],
    bugs_found_count: 0,
  };
}

describe('mpl-require-test-agent hook integration', () => {
  it('returns a real block decision when required test-agent evidence is missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-test-agent-'));
    try {
      mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase2-sprint',
        test_agent_dispatched: {},
      }));
      writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), `
phases:
  - id: phase-1
    test_agent_required: true
    test_agent_rationale: "touches a boundary"
`);

      const input = {
        cwd: tmp,
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'mpl-phase-runner',
          prompt: 'Run phase-1 and report completion.',
        },
        tool_response: 'phase complete',
      };
      const r = JSON.parse(execFileSync('node', [HOOK_PATH], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
      }));
      assert.equal(r.continue, false);
      assert.equal(r.decision, 'block');
      assert.match(r.reason, /mpl-test-agent was not dispatched/);
      const state = JSON.parse(readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8'));
      assert.equal(state.session_status, 'blocked_hook');
      assert.equal(state.blocked_by_hook, 'mpl-require-test-agent');
      assert.equal(state.blocked_phase, 'phase-1');
      assert.match(state.resume_instruction, /Dispatch mpl-test-agent for phase-1/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('clears its visible blocked state once PASS test-agent evidence exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-test-agent-clear-'));
    try {
      mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase2-sprint',
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-require-test-agent',
        blocked_phase: 'phase-1',
        block_reason: 'old block',
        test_agent_dispatched: { 'phase-1': passingEvidence() },
      }));
      writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), `
phases:
  - id: phase-1
    test_agent_required: true
`);

      const input = {
        cwd: tmp,
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'mpl-phase-runner',
          prompt: 'Run phase-1 and report completion.',
        },
      };
      const r = JSON.parse(execFileSync('node', [HOOK_PATH], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
      }));
      assert.equal(r.continue, true);
      const state = JSON.parse(readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8'));
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

  it('blocks timestamp-only legacy dispatch evidence', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-test-agent-legacy-'));
    try {
      mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase2-sprint',
        test_agent_dispatched: { 'phase-1': { timestamp: '2026-05-18T00:00:00Z' } },
      }));
      writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), `
phases:
  - id: phase-1
    test_agent_required: true
`);

      const input = {
        cwd: tmp,
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'mpl-phase-runner',
          prompt: 'Run phase-1 and report completion.',
        },
      };
      const r = JSON.parse(execFileSync('node', [HOOK_PATH], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
      }));
      assert.equal(r.continue, false);
      assert.equal(r.decision, 'block');
      assert.match(r.reason, /recorded mpl-test-agent evidence is verdict=UNKNOWN/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('blocks partial PASS-shaped state without executable test evidence', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-test-agent-partial-pass-'));
    try {
      mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase2-sprint',
        test_agent_dispatched: {
          'phase-1': {
            valid_json: true,
            verdict: 'PASS',
            command_exit_codes: [0],
          },
        },
      }));
      writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), `
phases:
  - id: phase-1
    test_agent_required: true
`);

      const input = {
        cwd: tmp,
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'mpl-phase-runner',
          prompt: 'Run phase-1 and report completion.',
        },
      };
      const r = JSON.parse(execFileSync('node', [HOOK_PATH], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
      }));
      assert.equal(r.continue, false);
      assert.equal(r.decision, 'block');
      assert.match(r.reason, /recorded mpl-test-agent evidence is verdict=PASS/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
