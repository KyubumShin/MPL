import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import {
  parsePhaseContractGraphText,
  validatePhaseContractGraph,
} from '../lib/mpl-phase-contract-graph.mjs';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-require-phase-contract-graph.mjs');

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-contract-graph-'));
  mkdirSync(join(tmp, '.mpl', 'mpl'), { recursive: true });
  writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
    schema_version: CURRENT_SCHEMA_VERSION,
    current_phase: 'mpl-decompose',
  }));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function validGraph() {
  return `
graph_version: 1
generated_by: mpl-decomposer
recompose_count: 0
completed_phase_policy: immutable_by_default
goal_contract_hash: abc
phases:
  - id: phase-1
    evidence_required:
      - command
      - goal_trace
    change_policy: append_delta_only
    interface_contract:
      requires: []
      produces:
        - type: artifact
          name: bootstrap
  - id: phase-2
    evidence_required: [command, test_agent]
    change_policy: append_delta_only
    interface_contract:
      requires:
        - type: artifact
          name: bootstrap
          from_phase: phase-1
      produces: []
`;
}

function runHook(content, opts = {}) {
  if (opts.config) {
    writeFileSync(join(tmp, '.mpl', 'config.json'), JSON.stringify(opts.config));
  }
  const input = {
    cwd: tmp,
    tool_name: opts.toolName || 'Write',
    tool_input: opts.toolInput || {
      file_path: '.mpl/mpl/decomposition.yaml',
      content,
    },
  };
  return JSON.parse(execFileSync('node', [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
  }));
}

describe('phase contract graph parser', () => {
  it('extracts metadata, phase policies, and requires.from_phase refs', () => {
    const graph = parsePhaseContractGraphText(validGraph());
    assert.equal(graph.graph_version, '1');
    assert.equal(graph.generated_by, 'mpl-decomposer');
    assert.equal(graph.recompose_count, '0');
    assert.equal(graph.completed_phase_policy, 'immutable_by_default');
    assert.equal(graph.phases.length, 2);
    assert.deepEqual(graph.phases[1].requires_from_phases, ['phase-1']);
  });

  it('validates a complete graph', () => {
    const verdict = validatePhaseContractGraph(parsePhaseContractGraphText(validGraph()));
    assert.equal(verdict.valid, true, verdict.issues.join(', '));
  });

  it('reports missing metadata and dangling dependencies', () => {
    const graph = parsePhaseContractGraphText(`
generated_by: orchestrator
phases:
  - id: phase-1
    interface_contract:
      requires:
        - from_phase: phase-99
`);
    const verdict = validatePhaseContractGraph(graph);
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.includes('graph_version:missing'));
    assert.ok(verdict.issues.includes('generated_by:orchestrator'));
    assert.ok(verdict.issues.includes('phase-1:evidence_required:missing'));
    assert.ok(verdict.issues.includes('phase-1:change_policy:missing'));
    assert.ok(verdict.issues.includes('phase-1:requires:unknown:phase-99'));
  });
});

describe('mpl-require-phase-contract-graph hook integration', () => {
  it('allows a valid graph', () => {
    const r = runHook(validGraph());
    assert.equal(r.continue, true);
  });

  it('blocks missing graph metadata and missing phase policy', () => {
    const r = runHook('phases:\n  - id: phase-1\n');
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /graph_version:missing/);
    assert.match(r.reason, /phase-1:evidence_required:missing/);
  });

  it('blocks MultiEdit writes with dangling requires.from_phase', () => {
    const r = runHook(null, {
      toolName: 'MultiEdit',
      toolInput: {
        file_path: '.mpl/mpl/decomposition.yaml',
        edits: [{
          old_string: 'old',
          new_string: validGraph().replace('from_phase: phase-1', 'from_phase: phase-404'),
        }],
      },
    });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /phase-2:requires:unknown:phase-404/);
  });

  it('allows migration opt-out', () => {
    const r = runHook('phases:\n  - id: phase-1\n', {
      config: { phase_contract_graph_required: false },
    });
    assert.equal(r.continue, true);
  });
});
