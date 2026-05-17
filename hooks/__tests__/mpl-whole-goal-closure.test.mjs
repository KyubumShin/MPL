import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { validateWholeGoalClosure } from '../lib/mpl-whole-goal-closure.mjs';
import { readGoalContract } from '../lib/mpl-goal-contract.mjs';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-require-whole-goal-closure.mjs');

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-whole-goal-closure-'));
  mkdirSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1'), { recursive: true });
  mkdirSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-2'), { recursive: true });
  writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'), goalContract());
  writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), decomposition());
  writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify(state(), null, 2));
  writeFileSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1', 'state-summary.md'), '# done');
  writeFileSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-2', 'state-summary.md'), '# done');
  writeFileSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1', 'verification.md'), verification('AC-1', 'AX-1'));
  writeFileSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-2', 'verification.md'), verification('AC-2', 'AX-2'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function goalContract() {
  return `
source:
  user_request: "Build app"
  user_request_hash: "req"
mission:
  goal: "Ship the full app"
  project_pivot: "No false completion"
  must_ship_outcomes:
    - "all phases complete"
ontology:
  entities:
    - runtime
variation_axes:
  - id: AX-1
    name: runtime
  - id: AX-2
    name: security
acceptance_criteria:
  - id: AC-1
    statement: first
  - id: AC-2
    statement: second
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

function decomposition(phase2Trace = 'AC-2', phase2Axis = 'AX-2') {
  return `
goal_contract_hash: abc
phases:
  - id: phase-1
    evidence_required: [command, goal_trace]
    goal_trace:
      acceptance_criteria: [AC-1]
      variation_axes: [AX-1]
  - id: phase-2
    evidence_required: [command, goal_trace]
    goal_trace:
      acceptance_criteria: [${phase2Trace}]
      variation_axes: [${phase2Axis}]
`;
}

function verification(ac, ax) {
  return `
## Criterion
done

## Evidence Type
command, goal_trace

## Evidence Latch
- command: PASS command="npm test" exit_code=0
- goal_trace: PASS ${ac} ${ax}
`;
}

function state(overrides = {}) {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    current_phase: 'phase5-finalize',
    finalize_done: false,
    execution: {
      phases: { total: 2, completed: 2, current: null, failed: 0, circuit_breaks: 0 },
      phase_details: [
        { id: 'phase-1', status: 'completed' },
        { id: 'phase-2', status: 'completed' },
      ],
    },
    ...overrides,
  };
}

function finalizeState() {
  return JSON.stringify({
    ...state(),
    current_phase: 'completed',
    finalize_done: true,
    completed_at: '2026-05-17T00:00:00Z',
    finalized_at: '2026-05-17T00:00:01Z',
  }, null, 2);
}

function runHook(content = finalizeState(), opts = {}) {
  if (opts.config) {
    writeFileSync(join(tmp, '.mpl', 'config.json'), JSON.stringify(opts.config));
  }
  const input = {
    cwd: tmp,
    tool_name: 'Write',
    tool_input: {
      file_path: '.mpl/state.json',
      content,
    },
  };
  return JSON.parse(execFileSync('node', [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
  }));
}

describe('whole goal closure validator', () => {
  it('passes when every phase is complete and AC/AX coverage is closed', () => {
    const goal = readGoalContract(tmp);
    const verdict = validateWholeGoalClosure({ cwd: tmp, state: state(), contract: goal.contract });
    assert.equal(verdict.valid, true, verdict.issues.join(', '));
  });

  it('reports AC/AX coverage missing from completed phases', () => {
    writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), decomposition('AC-1', 'AX-1'));
    const goal = readGoalContract(tmp);
    const verdict = validateWholeGoalClosure({ cwd: tmp, state: state(), contract: goal.contract });
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.includes('acceptance_criteria:not_completed:AC-2'));
    assert.ok(verdict.issues.includes('variation_axes:not_completed:AX-2'));
  });
});

describe('mpl-require-whole-goal-closure hook integration', () => {
  it('allows finalize_done when the whole goal is closed', () => {
    const r = runHook();
    assert.equal(r.continue, true);
  });

  it('blocks finalize_done when a phase is not completed', () => {
    rmSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-2', 'state-summary.md'));
    writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify(state({
      execution: {
        phases: { total: 2, completed: 1, current: 'phase-2', failed: 0, circuit_breaks: 0 },
        phase_details: [
          { id: 'phase-1', status: 'completed' },
          { id: 'phase-2', status: 'in_progress' },
        ],
      },
    }), null, 2));
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /phase-2:not_completed/);
  });

  it('blocks finalize_done when completed phase verification is missing', () => {
    rmSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-2', 'verification.md'));
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /phase-2:verification:missing/);
  });

  it('blocks finalize_done when execution completed count does not match graph', () => {
    writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify(state({
      execution: {
        phases: { total: 2, completed: 1, current: null, failed: 0, circuit_breaks: 0 },
        phase_details: [
          { id: 'phase-1', status: 'completed' },
          { id: 'phase-2', status: 'completed' },
        ],
      },
    }), null, 2));
    const r = runHook();
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /execution\.phases\.completed:expected:2:actual:1/);
  });

  it('allows migration opt-out', () => {
    rmSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-2', 'verification.md'));
    const r = runHook(finalizeState(), {
      config: { whole_goal_closure_required: false },
    });
    assert.equal(r.continue, true);
  });
});
