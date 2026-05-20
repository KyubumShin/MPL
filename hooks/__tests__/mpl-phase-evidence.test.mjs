import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import {
  newlyCompletedPhaseIds,
  parsePhaseEvidenceText,
  validatePhaseEvidenceLatch,
} from '../lib/mpl-phase-evidence.mjs';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-require-phase-evidence.mjs');

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-phase-evidence-'));
  mkdirSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1'), { recursive: true });
  writeState(baseState());
  writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), decomposition());
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function baseState(extra = {}) {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    current_phase: 'phase2-sprint',
    test_agent_dispatched: {
      'phase-1': passingEvidence(),
    },
    execution: {
      phases: { total: 1, completed: 0, current: 'phase-1', failed: 0, circuit_breaks: 0 },
      phase_details: [{ id: 'phase-1', name: 'One', status: 'in_progress' }],
    },
    ...extra,
  };
}

function passingEvidence() {
  return {
    timestamp: '2026-05-17T00:00:00Z',
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

function completedState() {
  return baseState({
    execution: {
      phases: { total: 1, completed: 1, current: null, failed: 0, circuit_breaks: 0 },
      phase_details: [{ id: 'phase-1', name: 'One', status: 'completed' }],
    },
  });
}

function writeState(state) {
  writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify(state, null, 2));
}

function decomposition() {
  return `
phases:
  - id: phase-1
    evidence_required:
      - command
      - test_agent
      - goal_trace
      - security
    goal_trace:
      acceptance_criteria: [AC-1]
      variation_axes: [AX-1]
`;
}

function validVerification() {
  return `
## Criterion
phase complete

## Evidence Type
command, test_agent, goal_trace, security

## Evidence Latch
- command: PASS command="npm test" exit_code=0
- test_agent: PASS state.test_agent_dispatched.phase-1.verdict=PASS command_exit_codes=[0]
- goal_trace: PASS AC-1 AX-1
- security: PASS dependency audit completed
`;
}

function summary() {
  return `
## Status
completed

## Files Changed
- Modified: src/app.ts

## Verification
See verification.md

## Decisions
None

## Next Phase Context
Ready
`;
}

function runHook(toolInput, opts = {}) {
  if (opts.config) {
    writeFileSync(join(tmp, '.mpl', 'config.json'), JSON.stringify(opts.config));
  }
  const input = {
    cwd: tmp,
    tool_name: opts.toolName || 'Write',
    tool_input: toolInput,
  };
  return JSON.parse(execFileSync('node', [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
  }));
}

describe('phase evidence parser', () => {
  it('extracts evidence_required and newly completed phase ids', () => {
    const parsed = parsePhaseEvidenceText(decomposition());
    assert.deepEqual(parsed.phases[0].evidence_required, ['command', 'test_agent', 'goal_trace', 'security']);

    assert.deepEqual(
      newlyCompletedPhaseIds(baseState(), completedState()),
      ['phase-1'],
    );
  });

  it('validates all required evidence tokens', () => {
    const phase = parsePhaseEvidenceText(decomposition()).phases[0];
    const verdict = validatePhaseEvidenceLatch({
      phase,
      phaseId: 'phase-1',
      verificationText: validVerification(),
      state: baseState(),
    });
    assert.equal(verdict.valid, true, verdict.issues.join(', '));
  });
});

describe('mpl-require-phase-evidence hook integration', () => {
  it('allows verification.md with a complete Evidence Latch', () => {
    const r = runHook({
      file_path: '.mpl/mpl/phases/phase-1/verification.md',
      content: validVerification(),
    });
    assert.equal(r.continue, true);
  });

  it('blocks verification.md missing command exit_code evidence', () => {
    const r = runHook({
      file_path: '.mpl/mpl/phases/phase-1/verification.md',
      content: validVerification().replace('exit_code=0', 'exit_code=1'),
    });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /phase-1:command:missing_exit_code_0/);
  });

  it('blocks test_agent evidence when dispatch state is missing', () => {
    writeState(baseState({ test_agent_dispatched: {} }));
    const r = runHook({
      file_path: '.mpl/mpl/phases/phase-1/verification.md',
      content: validVerification(),
    });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /phase-1:test_agent:missing_pass_evidence/);
  });

  it('blocks test_agent evidence when dispatch record is timestamp-only', () => {
    writeState(baseState({ test_agent_dispatched: { 'phase-1': { timestamp: '2026-05-17T00:00:00Z' } } }));
    const r = runHook({
      file_path: '.mpl/mpl/phases/phase-1/verification.md',
      content: validVerification(),
    });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /phase-1:test_agent:missing_pass_evidence/);
  });

  it('blocks test_agent evidence when dispatch record is only verdict-shaped', () => {
    writeState(baseState({
      test_agent_dispatched: {
        'phase-1': {
          valid_json: true,
          verdict: 'PASS',
          command_exit_codes: [0],
        },
      },
    }));
    const r = runHook({
      file_path: '.mpl/mpl/phases/phase-1/verification.md',
      content: validVerification(),
    });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /phase-1:test_agent:missing_pass_evidence/);
  });

  it('blocks test_agent evidence when tests were skipped', () => {
    writeState(baseState({
      test_agent_dispatched: {
        'phase-1': {
          ...passingEvidence(),
          tests_skipped: 1,
        },
      },
    }));
    const r = runHook({
      file_path: '.mpl/mpl/phases/phase-1/verification.md',
      content: validVerification(),
    });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /phase-1:test_agent:missing_pass_evidence/);
  });

  it('blocks state-summary completion artifact until verification latch exists', () => {
    const r = runHook({
      file_path: '.mpl/mpl/phases/phase-1/state-summary.md',
      content: summary(),
    });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /phase-1:verification:missing/);
  });

  it('allows state-summary after verification latch exists', () => {
    writeFileSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1', 'verification.md'), validVerification());
    const r = runHook({
      file_path: '.mpl/mpl/phases/phase-1/state-summary.md',
      content: summary(),
    });
    assert.equal(r.continue, true);
  });

  it('blocks state completion when verification latch is missing', () => {
    const r = runHook({
      file_path: '.mpl/state.json',
      content: JSON.stringify(completedState(), null, 2),
    });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /phase-1:verification:missing/);
  });

  it('allows state completion when verification latch exists', () => {
    writeFileSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1', 'verification.md'), validVerification());
    const r = runHook({
      file_path: '.mpl/state.json',
      content: JSON.stringify(completedState(), null, 2),
    });
    assert.equal(r.continue, true);
  });

  it('blocks completed count increments that omit phase detail evidence', () => {
    writeFileSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1', 'verification.md'), validVerification());
    const proposed = baseState({
      execution: {
        phases: { total: 1, completed: 1, current: null, failed: 0, circuit_breaks: 0 },
        phase_details: [{ id: 'phase-1', name: 'One', status: 'in_progress' }],
      },
    });
    const r = runHook({
      file_path: '.mpl/state.json',
      content: JSON.stringify(proposed, null, 2),
    });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /state:phase_completion:missing_phase_detail/);
  });

  it('allows migration opt-out', () => {
    const r = runHook({
      file_path: '.mpl/mpl/phases/phase-1/verification.md',
      content: '## Criterion\nnone\n',
    }, {
      config: { phase_evidence_latch_required: false },
    });
    assert.equal(r.continue, true);
  });
});
