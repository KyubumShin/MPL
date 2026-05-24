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
  validateMvpGoalTraceCoverage,
} from '../lib/mpl-goal-trace.mjs';
import { readGoalContract } from '../lib/mpl-goal-contract.mjs';
import { parsePhaseContractGraphText } from '../lib/mpl-phase-contract-graph.mjs';
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

// Post-Stage-A audit fix #2: RFC §4.2 — MVP cohort goal_trace subset coverage.

function goalContractWithMvp({ mvpAc = ['AC-1'], mvpAx = ['AX-1'] } = {}) {
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
mvp_scope:
  acceptance_criteria: [${mvpAc.join(', ')}]
  variation_axes: [${mvpAx.join(', ')}]
  artifact: draft_pr
`;
}

function decompositionWithMvp({ mvpPhases = ['phase-1'], phaseTraces = {} } = {}) {
  // Default per-phase trace: phase-1 covers AC-1+AX-1 (the MVP subset),
  // phase-2 covers AC-2+AX-2 (non-MVP tail). Overridable via phaseTraces.
  const defaults = {
    'phase-1': { ac: ['AC-1'], ax: ['AX-1'], entities: ['finalization'] },
    'phase-2': { ac: ['AC-2'], ax: ['AX-2'], entities: ['runtime'] },
  };
  const merged = { ...defaults, ...phaseTraces };
  const phasesYaml = Object.entries(merged).map(([id, trace]) => `
  - id: ${id}
    covers: [UC-01]
    goal_trace:
      acceptance_criteria: [${trace.ac.join(', ')}]
      variation_axes: [${trace.ax.join(', ')}]
      ontology_entities: [${trace.entities.join(', ')}]
`).join('');
  // graph_version + generated_by + mvp/release_cuts so the graph parser
  // sees mvp.phases. (parsePhaseContractGraphText reads the same text.)
  return `
graph_version: "1.0"
generated_by: mpl-decomposer
recompose_count: 0
completed_phase_policy: immutable
goal_contract_hash: "${goalHash()}"
execution_tiers:
  - tier: 1
    phases: [${Object.keys(merged).join(', ')}]
phases:${phasesYaml}
mvp:
  phases: [${mvpPhases.join(', ')}]
  execution_mode: sequential
  artifact: draft_pr
  derived_from: mvp_scope
release_cuts: []
`;
}

describe('validateMvpGoalTraceCoverage (RFC §4.2, post-Stage-A audit fix #2)', () => {
  it('returns valid (no-op) when contract has no mvp_scope (whole-pipeline only)', () => {
    // Plain decomposition with no mvp block; whole-pipeline validator
    // already covers this case. MVP validator must skip silently.
    const goal = readGoalContract(tmp);  // beforeEach contract has no mvp_scope
    const decomp = parseDecompositionGoalTraceText(decomposition());
    const graph = parsePhaseContractGraphText(decomposition());
    const verdict = validateMvpGoalTraceCoverage(decomp, goal.contract, graph);
    assert.equal(verdict.valid, true);
    assert.deepEqual(verdict.issues, []);
  });

  it('returns valid when union of MVP phases covers every mvp_scope AC/AX', () => {
    writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'),
      goalContractWithMvp({ mvpAc: ['AC-1'], mvpAx: ['AX-1'] }));
    const goal = readGoalContract(tmp);
    const text = decompositionWithMvp({ mvpPhases: ['phase-1'] });
    const decomp = parseDecompositionGoalTraceText(text);
    const graph = parsePhaseContractGraphText(text);
    const verdict = validateMvpGoalTraceCoverage(decomp, goal.contract, graph);
    assert.equal(verdict.valid, true, verdict.issues.join(', '));
  });

  it('flags mvp_scope.acceptance_criteria uncovered when MVP phase set misses an AC the MVP scope requires', () => {
    // Concrete spec-gap reproducer: AC-2 is in mvp_scope but only covered
    // by phase-2 (a NON-MVP phase). Whole-pipeline coverage passes
    // (phase-2 covers AC-2) but MVP subset coverage fails (the manifest
    // shipped at release-finalize would claim AC-2 coverage based on
    // mvp_scope while no MVP phase actually delivers it).
    writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'),
      goalContractWithMvp({ mvpAc: ['AC-1', 'AC-2'], mvpAx: ['AX-1'] }));
    const goal = readGoalContract(tmp);
    const text = decompositionWithMvp({ mvpPhases: ['phase-1'] });  // phase-2 not in MVP
    const decomp = parseDecompositionGoalTraceText(text);
    const graph = parsePhaseContractGraphText(text);

    // Whole-pipeline coverage passes — AC-2 covered by phase-2 somewhere.
    const wholeVerdict = validateGoalTraceCoverage(decomp, goal.contract);
    assert.equal(wholeVerdict.valid, true, `whole-pipeline should pass: ${wholeVerdict.issues.join(', ')}`);

    // MVP subset coverage fails — phase-1 (only MVP phase) does not cover AC-2.
    const mvpVerdict = validateMvpGoalTraceCoverage(decomp, goal.contract, graph);
    assert.equal(mvpVerdict.valid, false);
    assert.ok(mvpVerdict.issues.includes('mvp_scope.acceptance_criteria:uncovered:AC-2'),
      `expected AC-2 uncovered, got: ${mvpVerdict.issues.join(', ')}`);
  });

  it('flags mvp_scope.variation_axes uncovered when MVP phase set misses an AX', () => {
    writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'),
      goalContractWithMvp({ mvpAc: ['AC-1'], mvpAx: ['AX-1', 'AX-2'] }));
    const goal = readGoalContract(tmp);
    const text = decompositionWithMvp({ mvpPhases: ['phase-1'] });
    const decomp = parseDecompositionGoalTraceText(text);
    const graph = parsePhaseContractGraphText(text);
    const verdict = validateMvpGoalTraceCoverage(decomp, goal.contract, graph);
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.includes('mvp_scope.variation_axes:uncovered:AX-2'));
  });

  it('returns valid (no-op) when graph.mvp.phases is empty (other validators handle that)', () => {
    // Empty mvp.phases is already caught by mpl-require-phase-contract-graph
    // and resolveCutDescriptor. The goal-trace validator should not
    // double-report.
    writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'),
      goalContractWithMvp({ mvpAc: ['AC-1'], mvpAx: ['AX-1'] }));
    const goal = readGoalContract(tmp);
    const text = decompositionWithMvp({ mvpPhases: [] });
    const decomp = parseDecompositionGoalTraceText(text);
    const graph = parsePhaseContractGraphText(text);
    const verdict = validateMvpGoalTraceCoverage(decomp, goal.contract, graph);
    assert.equal(verdict.valid, true);
  });
});

describe('mpl-require-goal-trace hook integration: MVP subset coverage', () => {
  it('blocks decomposition write when MVP scope AC is not covered by any MVP phase (even if whole-pipeline coverage passes)', () => {
    writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'),
      goalContractWithMvp({ mvpAc: ['AC-1', 'AC-2'], mvpAx: ['AX-1'] }));
    const r = runHook(decompositionWithMvp({ mvpPhases: ['phase-1'] }));
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /mvp_scope\.acceptance_criteria:uncovered:AC-2/);
    assert.match(r.reason, /including the MVP subset/);
  });

  it('allows decomposition write when MVP scope AC/AX is fully covered by MVP phases', () => {
    writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'),
      goalContractWithMvp({ mvpAc: ['AC-1'], mvpAx: ['AX-1'] }));
    const r = runHook(decompositionWithMvp({ mvpPhases: ['phase-1'] }));
    assert.equal(r.continue, true);
  });

  it('does NOT enforce MVP subset coverage when goal_contract has no mvp_scope (whole-pipeline behavior unchanged)', () => {
    // beforeEach writes a contract WITHOUT mvp_scope. Default
    // decomposition() covers whole-pipeline correctly. Adding the MVP
    // validator must not regress non-MVP flows.
    const r = runHook(decomposition());
    assert.equal(r.continue, true);
  });
});
