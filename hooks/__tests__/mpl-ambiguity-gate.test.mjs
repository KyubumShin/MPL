import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-ambiguity-gate.mjs');
const SCHEMA_V = CURRENT_SCHEMA_VERSION;

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-amb-goal-'));
  mkdirSync(join(tmp, '.mpl'), { recursive: true });
  writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
    schema_version: SCHEMA_V,
    current_phase: 'mpl-decompose',
    user_contract_set: true,
    ambiguity_score: 0.1,
  }));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function goalContract() {
  return `
source:
  user_request: "Build app"
  user_request_hash: "req"
mission:
  goal: "Build with a frozen goal"
  project_pivot: "Goal consistency"
  must_ship_outcomes:
    - "goal contract is ready"
ontology:
  entities:
    - goal_contract
variation_axes:
  - id: AX-1
acceptance_criteria:
  - id: AC-1
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

function runHook() {
  const input = {
    cwd: tmp,
    tool_name: 'Task',
    tool_input: {
      subagent_type: 'mpl-decomposer',
    },
  };
  return JSON.parse(execFileSync('node', [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
  }));
}

describe('mpl-ambiguity-gate goal contract readiness', () => {
  it('blocks decomposer dispatch when goal contract is missing', () => {
    const r = runHook();
    assert.equal(r.continue, false);
    assert.match(r.reason, /goal contract is missing or incomplete/);
  });

  it('allows decomposer dispatch and syncs goal contract state when valid', () => {
    writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'), goalContract());
    const r = runHook();
    assert.equal(r.continue, true);
    const state = JSON.parse(readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8'));
    assert.equal(state.goal_contract_set, true);
    assert.equal(state.goal_contract_path, '.mpl/goal-contract.yaml');
    assert.equal(state.goal_contract_hash.length, 64);
  });
});
