import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  GOAL_CONTRACT_REL_PATH,
  MVP_SCOPE_ARTIFACTS,
  hashNormalizedGoalContractText,
  parseGoalContractText,
  readBaselineGoalContractHash,
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
  runtime: "codex"
  runtime_goal: "Ship goal-first MPL"
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
    assert.equal(c.source.runtime, 'codex');
    assert.equal(c.source.runtime_goal, 'Ship goal-first MPL');
    assert.equal(c.source.codex_goal, 'Ship goal-first MPL');
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

  it('extracts list ids even when id is not the first key in the list item', () => {
    const text = validGoalContract()
      .replace('- id: AX-1\n    name: runtime_mode', '- name: runtime_mode\n    id: AX-1')
      .replace('- id: AC-1\n    statement: "finalize is blocked without evidence"', '- statement: "finalize is blocked without evidence"\n    id: AC-1');
    const c = parseGoalContractText(text);
    assert.deepEqual(c.variation_axes, ['AX-1']);
    assert.deepEqual(c.acceptance_criteria, ['AC-1']);
  });

  it('validates a complete contract', () => {
    const verdict = validateGoalContractText(validGoalContract());
    assert.equal(verdict.valid, true);
    assert.deepEqual(verdict.missing, []);
  });

  it('accepts a Claude-specific goal as a runtime goal source', () => {
    const text = validGoalContract()
      .replace('  runtime: "codex"', '  runtime: "claude"')
      .replace('  runtime_goal: "Ship goal-first MPL"', '  runtime_goal: "Ship goal-first MPL from Claude"')
      .replace('  codex_goal: "Ship goal-first MPL"\n', '  claude_goal: "Ship goal-first MPL from Claude"\n');

    const verdict = validateGoalContractText(text);
    assert.equal(verdict.valid, true);
    assert.equal(verdict.contract.source.runtime, 'claude');
    assert.equal(verdict.contract.source.runtime_goal, 'Ship goal-first MPL from Claude');
    assert.equal(verdict.contract.source.claude_goal, 'Ship goal-first MPL from Claude');
  });

  it('keeps legacy codex_goal contracts valid for compatibility', () => {
    const text = validGoalContract()
      .replace('  runtime: "codex"\n', '')
      .replace('  runtime_goal: "Ship goal-first MPL"\n', '');

    const verdict = validateGoalContractText(text);
    assert.equal(verdict.valid, true);
    assert.equal(verdict.contract.source.codex_goal, 'Ship goal-first MPL');
  });

  it('reports missing goal-readiness fields', () => {
    const verdict = validateGoalContractText('mission:\n  goal: "x"\n');
    assert.equal(verdict.valid, false);
    assert.ok(verdict.missing.includes('source.runtime_goal_or_user_request'));
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

  it('uses the shared normalized hash helper for content_sha256', () => {
    const text = `${validGoalContract()}\n`;
    const c = parseGoalContractText(text);
    assert.equal(c.content_sha256, hashNormalizedGoalContractText(text));
  });

  it('validates baseline goal contract hashes as lowercase 64-char hex', () => {
    mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
    writeFileSync(join(tmp, '.mpl', 'mpl', 'baseline.yaml'), `
artifacts:
  goal_contract:
    path: ".mpl/goal-contract.yaml"
    sha256: "43aaf36b9bf7"
`);
    const baseline = readBaselineGoalContractHash(tmp);
    assert.equal(baseline.exists, true);
    assert.equal(baseline.hash, null);
    assert.match(baseline.error, /expected 64 lowercase hex/);
    assert.equal(baseline.rawHash, '43aaf36b9bf7');
  });
});

describe('goal contract mvp_scope (Stage A)', () => {
  function mvpScopeBlock(body) {
    return validGoalContract() + `mvp_scope:\n${body}\n`;
  }

  it('parses mvp_scope as null when the top-level key is absent', () => {
    const c = parseGoalContractText(validGoalContract());
    assert.equal(c.mvp_scope, null);
  });

  it('keeps the contract valid when mvp_scope is absent (backward compatibility)', () => {
    const verdict = validateGoalContractText(validGoalContract());
    assert.equal(verdict.valid, true);
    assert.equal(verdict.contract.mvp_scope, null);
  });

  it('parses mvp_scope with inline-list acceptance_criteria, variation_axes, and a supported artifact', () => {
    const text = mvpScopeBlock('  acceptance_criteria: [AC-1]\n  variation_axes: [AX-1]\n  artifact: draft_pr');
    const verdict = validateGoalContractText(text);
    assert.equal(verdict.valid, true, `missing: ${verdict.missing.join(',')}`);
    assert.deepEqual(verdict.contract.mvp_scope.acceptance_criteria, ['AC-1']);
    assert.deepEqual(verdict.contract.mvp_scope.variation_axes, ['AX-1']);
    assert.equal(verdict.contract.mvp_scope.artifact, 'draft_pr');
  });

  it('parses mvp_scope with block-list acceptance_criteria', () => {
    const text = mvpScopeBlock('  acceptance_criteria:\n    - AC-1\n  artifact: release_manifest');
    const c = parseGoalContractText(text);
    assert.deepEqual(c.mvp_scope.acceptance_criteria, ['AC-1']);
    assert.deepEqual(c.mvp_scope.variation_axes, []);
    assert.equal(c.mvp_scope.artifact, 'release_manifest');
  });

  it('rejects mvp_scope when the block is declared but completely empty', () => {
    const text = validGoalContract() + 'mvp_scope:\n';
    const verdict = validateGoalContractText(text);
    assert.equal(verdict.valid, false);
    assert.ok(
      verdict.missing.includes('mvp_scope.acceptance_criteria_or_variation_axes'),
      `expected empty-block to surface AC/AX-or check; got: ${verdict.missing.join(',')}`,
    );
    assert.ok(
      verdict.missing.includes('mvp_scope.artifact'),
      `expected empty-block to surface missing artifact; got: ${verdict.missing.join(',')}`,
    );
    // The contract.mvp_scope object MUST be non-null so downstream consumers
    // can distinguish "declared-but-malformed" from "absent".
    assert.notEqual(verdict.contract.mvp_scope, null);
  });

  it('rejects mvp_scope when only artifact is declared (no AC/AX keys)', () => {
    const text = mvpScopeBlock('  artifact: branch');
    const verdict = validateGoalContractText(text);
    assert.equal(verdict.valid, false);
    assert.ok(verdict.missing.includes('mvp_scope.acceptance_criteria_or_variation_axes'));
    assert.equal(verdict.contract.mvp_scope.artifact, 'branch');
  });

  it('rejects mvp_scope acceptance_criteria ids that do not exist in the contract', () => {
    const text = mvpScopeBlock('  acceptance_criteria: [AC-1, AC-999]\n  artifact: draft_pr');
    const verdict = validateGoalContractText(text);
    assert.equal(verdict.valid, false);
    assert.ok(
      verdict.missing.some((m) => m === 'mvp_scope.acceptance_criteria.unknown_id:AC-999'),
      `expected unknown AC id in missing; got: ${verdict.missing.join(',')}`,
    );
  });

  it('rejects mvp_scope variation_axes ids that do not exist in the contract', () => {
    const text = mvpScopeBlock('  acceptance_criteria: [AC-1]\n  variation_axes: [AX-99]\n  artifact: tag');
    const verdict = validateGoalContractText(text);
    assert.equal(verdict.valid, false);
    assert.ok(
      verdict.missing.some((m) => m === 'mvp_scope.variation_axes.unknown_id:AX-99'),
      `expected unknown AX id in missing; got: ${verdict.missing.join(',')}`,
    );
  });

  it('rejects mvp_scope with an unsupported artifact value', () => {
    const text = mvpScopeBlock('  acceptance_criteria: [AC-1]\n  artifact: gist');
    const verdict = validateGoalContractText(text);
    assert.equal(verdict.valid, false);
    assert.ok(
      verdict.missing.some((m) => m === 'mvp_scope.artifact.unsupported:gist'),
      `expected unsupported artifact in missing; got: ${verdict.missing.join(',')}`,
    );
  });

  it('rejects mvp_scope when artifact is missing entirely', () => {
    const text = mvpScopeBlock('  acceptance_criteria: [AC-1]');
    const verdict = validateGoalContractText(text);
    assert.equal(verdict.valid, false);
    assert.ok(verdict.missing.includes('mvp_scope.artifact'));
  });

  it('rejects mvp_scope when both acceptance_criteria and variation_axes are empty', () => {
    const text = mvpScopeBlock('  acceptance_criteria: []\n  variation_axes: []\n  artifact: branch');
    const verdict = validateGoalContractText(text);
    assert.equal(verdict.valid, false);
    assert.ok(verdict.missing.includes('mvp_scope.acceptance_criteria_or_variation_axes'));
  });

  it('exposes the allowed artifact set as MVP_SCOPE_ARTIFACTS', () => {
    assert.deepEqual([...MVP_SCOPE_ARTIFACTS].sort(), ['branch', 'draft_pr', 'release_manifest', 'tag']);
  });
});
