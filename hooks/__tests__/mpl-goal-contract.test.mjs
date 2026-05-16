import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  GOAL_CONTRACT_REL_PATH,
  parseGoalContractText,
  readGoalContract,
  validateGoalContractText,
} from '../lib/mpl-goal-contract.mjs';

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-goal-contract-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function validGoalContract() {
  return `
version: 1
source:
  codex_goal: "Ship goal-first MPL"
  user_request: "Improve MPL"
  user_request_hash: "abc123"
mission:
  goal: "MPL completion must be evidence-based"
  project_pivot: "Avoid false completion"
  non_goals:
    - "Rewrite every phase"
  must_ship_outcomes:
    - "Goal contract exists before decomposition"
ontology:
  entities:
    - goal_contract
    - e2e_scenario
  relationships:
    - goal_contract covers acceptance_criteria
variation_axes:
  - id: AX-1
    name: runtime_mode
acceptance_criteria:
  - id: AC-1
    statement: "finalize is blocked without evidence"
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

describe('goal contract parsing', () => {
  it('extracts the readiness fields MPL gates consume', () => {
    const c = parseGoalContractText(validGoalContract());
    assert.equal(c.mission.goal, 'MPL completion must be evidence-based');
    assert.equal(c.mission.project_pivot, 'Avoid false completion');
    assert.deepEqual(c.ontology.entities, ['goal_contract', 'e2e_scenario']);
    assert.deepEqual(c.variation_axes, ['AX-1']);
    assert.deepEqual(c.acceptance_criteria, ['AC-1']);
    assert.equal(c.e2e_policy.real_runtime_required, true);
    assert.equal(c.e2e_policy.mock_allowed, false);
    assert.equal(c.security_policy.required, true);
    assert.deepEqual(c.security_policy.checks, ['dependency_audit']);
    assert.equal(c.completion_evidence.require_finalize_timestamps, true);
    assert.equal(c.content_sha256.length, 64);
  });

  it('validates a complete contract', () => {
    const verdict = validateGoalContractText(validGoalContract());
    assert.equal(verdict.valid, true);
    assert.deepEqual(verdict.missing, []);
  });

  it('reports missing goal-readiness fields', () => {
    const verdict = validateGoalContractText('mission:\n  goal: "x"\n');
    assert.equal(verdict.valid, false);
    assert.ok(verdict.missing.includes('mission.project_pivot'));
    assert.ok(verdict.missing.includes('ontology.entities'));
    assert.ok(verdict.missing.includes('acceptance_criteria[].id'));
    assert.ok(verdict.missing.includes('completion_evidence.required_artifacts'));
  });

  it('reads .mpl/goal-contract.yaml from disk', () => {
    mkdirSync(join(tmp, '.mpl'), { recursive: true });
    writeFileSync(join(tmp, GOAL_CONTRACT_REL_PATH), validGoalContract());
    const verdict = readGoalContract(tmp);
    assert.equal(verdict.exists, true);
    assert.equal(verdict.valid, true);
    assert.equal(verdict.contract.mission.project_pivot, 'Avoid false completion');
  });
});
