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
    test_files_created_count: 1,
    bugs_found_count: 0,
    command_exit_codes_count: 1,
    command_exit_codes_nonzero_count: 0,
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
    phase_domain: api
    impact:
      modify:
        - src/api/widgets.ts
    interface_contract:
      requires: []
      produces:
        - symbol: createWidget
          path: src/api/widgets.ts
    probing_hints:
      - retry path returns structured error
    verification_plan:
      s_items:
        - id: S-1
          statement: rejected payload returns 422
    test_agent_required: true
    test_agent_rationale: "touches a boundary" # inline comment stripped
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
      assert.match(r.reason, /rationale: touches a boundary\)/);
      assert.doesNotMatch(r.reason, /inline comment stripped/);
      const state = JSON.parse(readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8'));
      assert.equal(state.session_status, 'blocked_hook');
      assert.equal(state.blocked_by_hook, 'mpl-require-test-agent');
      assert.equal(state.blocked_phase, 'phase-1');
      assert.match(state.resume_instruction, /Dispatch mpl-test-agent for phase-1/);
      assert.match(state.resume_instruction, /Task\(subagent_type="mpl-test-agent"/);
      assert.match(state.resume_instruction, /Interface Contract:/);
      assert.match(state.resume_instruction, /createWidget/);
      assert.match(state.resume_instruction, /Impact Files \/ Phase Impact:/);
      assert.match(state.resume_instruction, /src\/api\/widgets\.ts/);
      assert.match(state.resume_instruction, /Probing Hints:/);
      assert.match(state.resume_instruction, /retry path returns structured error/);
      assert.match(state.resume_instruction, /Verification Plan:/);
      assert.match(state.resume_instruction, /S-1/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('blocks even when phase-runner self-tests have gate evidence but no independent test-agent PASS', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-test-agent-self-test-'));
    try {
      mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase2-sprint',
        gate_results: {
          hard2_coverage: {
            command: 'npm test',
            exit_code: 0,
            stdout_tail: 'all phase-runner tests passed',
          },
        },
        test_agent_dispatched: {},
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
      assert.match(r.reason, /code_author == test_author is a tautology/);
      const state = JSON.parse(readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8'));
      assert.equal(state.session_status, 'blocked_hook');
      assert.equal(state.blocked_phase, 'phase-1');
      assert.equal(state.gate_results.hard2_coverage.exit_code, 0);
      assert.deepEqual(state.test_agent_dispatched, {});
      // The hook output stays concise; the executable recovery prompt lives in state.
      assert.match(state.resume_instruction, /independent test author/);
      assert.match(state.resume_instruction, /Task\(subagent_type="mpl-test-agent"/);
      assert.match(state.resume_instruction, /N\/A - not declared in decomposition\.yaml/);
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

  it('clears its visible blocked state when a user-approved override exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-test-agent-override-'));
    try {
      mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
      mkdirSync(join(tmp, '.mpl', 'config'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase2-sprint',
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-require-test-agent',
        blocked_phase: 'phase-1',
        block_reason: 'old block',
        resume_instruction: 'old instruction',
        blocked_at: '2026-05-18T00:00:00Z',
        test_agent_dispatched: {},
      }));
      writeFileSync(join(tmp, '.mpl', 'config', 'test-agent-override.json'), JSON.stringify({
        'phase-1': 'user approved manual verification',
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
      const state = JSON.parse(readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8'));
      assert.equal(state.session_status, 'blocked_hook');
      assert.equal(state.blocked_by_hook, 'mpl-require-test-agent');
      assert.equal(state.blocked_phase, 'phase-1');
      assert.match(state.block_reason, /recorded mpl-test-agent evidence is verdict=PASS/);
      assert.match(state.resume_instruction, /Prior evidence status:/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('blocks legacy array-only PASS evidence without scalar counts', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-test-agent-array-only-'));
    try {
      mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase2-sprint',
        test_agent_dispatched: {
          'phase-1': {
            valid_json: true,
            verdict: 'PASS',
            invalid_reason: null,
            tests_total: 1,
            tests_failed: 0,
            tests_skipped: 0,
            test_files_created: ['tests/phase-1.test.ts'],
            command_exit_codes: [0],
            bugs_found_count: 0,
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
      assert.match(r.reason, /missing scalar count fields/);
      assert.match(r.reason, /pre-v0\.18\.7 legacy record/);
      assert.match(r.reason, /Re-run mpl-test-agent for phase-1/);
      const state = JSON.parse(readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8'));
      assert.match(state.block_reason, /missing scalar count fields/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
