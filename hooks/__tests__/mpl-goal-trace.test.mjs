import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import {
  parseDecompositionGoalTraceText,
  validateGoalTraceCoverage,
} from '../lib/mpl-goal-trace.mjs';
import { readGoalContract } from '../lib/mpl-goal-contract.mjs';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-require-goal-trace.mjs');

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-goal-trace-'));
  mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
  writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
    schema_version: CURRENT_SCHEMA_VERSION,
    current_phase: 'mpl-decompose',
  }));
  writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'), goalContract());
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function goalContract() {
  return `
source:
  user_request: "Build app"
  user_request_hash: "req"
mission:
  goal: "Ship goal traced phases"
  project_pivot: "No false completion"
  must_ship_outcomes:
    - "all AC and AX covered"
ontology:
  entities:
    - finalization
    - runtime
variation_axes:
  - id: AX-1
    name: runtime
  - id: AX-2
    name: security
acceptance_criteria:
  - id: AC-1
    statement: "first"
  - id: AC-2
    statement: "second"
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

function goalHash() {
  return readGoalContract(tmp).contract.content_sha256;
}

function decomposition(hash = goalHash()) {
  return `
goal_contract_hash: "${hash}"
architecture_anchor:
  tech_stack: [node]
phases:
  - id: phase-1
    covers: [UC-01]
    goal_trace:
      acceptance_criteria: [AC-1]
      variation_axes:
        - AX-1
      ontology_entities: [finalization]
  - id: phase-2
    covers: [UC-02]
    goal_trace:
      acceptance_criteria:
        - AC-2
      variation_axes: [AX-2]
      ontology_entities:
        - runtime
`;
}

function runHook(decomp, opts = {}) {
  if (opts.config) {
    writeFileSync(join(tmp, '.mpl', 'config.json'), JSON.stringify(opts.config));
  }
  if (opts.baselineHash) {
    writeFileSync(join(tmp, '.mpl', 'mpl', 'baseline.yaml'), `
artifacts:
  goal_contract:
    path: ".mpl/goal-contract.yaml"
    sha256: "${opts.baselineHash}"
`);
  }
  const input = {
    cwd: tmp,
    tool_name: opts.toolName || 'Write',
    tool_input: opts.toolInput || {
      file_path: '.mpl/mpl/decomposition.yaml',
      content: decomp,
    },
  };
  return JSON.parse(execFileSync('node', [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
  }));
}

describe('goal trace parser', () => {
  it('extracts top-level goal hash and per-phase goal_trace arrays', () => {
    const parsed = parseDecompositionGoalTraceText(decomposition('abc'));
    assert.equal(parsed.goal_contract_hash, 'abc');
    assert.equal(parsed.phases.length, 2);
    assert.deepEqual(parsed.phases[0].acceptance_criteria, ['AC-1']);
    assert.deepEqual(parsed.phases[0].variation_axes, ['AX-1']);
    assert.deepEqual(parsed.phases[1].ontology_entities, ['runtime']);
  });

  it('validates complete AC/AX coverage', () => {
    const goal = readGoalContract(tmp);
    const verdict = validateGoalTraceCoverage(
      parseDecompositionGoalTraceText(decomposition()),
      goal.contract,
    );
    assert.equal(verdict.valid, true, verdict.issues.join(', '));
  });

  it('reports missing coverage and unknown ids', () => {
    const goal = readGoalContract(tmp);
    const parsed = parseDecompositionGoalTraceText(`
goal_contract_hash: "${goal.contract.content_sha256}"
phases:
  - id: phase-1
    goal_trace:
      acceptance_criteria: [AC-404]
      variation_axes: [AX-1]
      ontology_entities: [unknown]
`);
    const verdict = validateGoalTraceCoverage(parsed, goal.contract);
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.includes('acceptance_criteria:uncovered:AC-1'));
    assert.ok(verdict.issues.includes('acceptance_criteria:uncovered:AC-2'));
    assert.ok(verdict.issues.includes('variation_axes:uncovered:AX-2'));
    assert.ok(verdict.issues.includes('acceptance_criteria:unknown:AC-404'));
    assert.ok(verdict.issues.includes('ontology_entities:unknown:unknown'));
  });
});

describe('mpl-require-goal-trace hook integration', () => {
  it('allows complete goal trace with matching hash', () => {
    const r = runHook(decomposition());
    assert.equal(r.continue, true);
  });

  it('blocks MultiEdit writes with missing top-level goal_contract_hash', () => {
    const r = runHook(null, {
      toolName: 'MultiEdit',
      toolInput: {
        file_path: '.mpl/mpl/decomposition.yaml',
        edits: [{
          old_string: 'old',
          new_string: decomposition('').replace(/goal_contract_hash: ""\n/, ''),
        }],
      },
    });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /goal_contract_hash:missing/);
  });

  it('blocks when AC or AX coverage is incomplete', () => {
    const r = runHook(`
goal_contract_hash: "${goalHash()}"
phases:
  - id: phase-1
    goal_trace:
      acceptance_criteria: [AC-1]
      variation_axes: [AX-1]
      ontology_entities: [finalization]
`);
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /acceptance_criteria:uncovered:AC-2/);
    assert.match(r.reason, /variation_axes:uncovered:AX-2/);
  });

  it('blocks when baseline goal contract hash differs from current goal contract', () => {
    const r = runHook(decomposition(), { baselineHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /drifted from baseline/);
  });

  it('allows opt-out via goal_trace_required=false', () => {
    const r = runHook('phases:\n  - id: phase-1\n', {
      config: { goal_trace_required: false },
    });
    assert.equal(r.continue, true);
  });
});
