import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import {
  parseDecompositionDeltaText,
  validateDecompositionDelta,
} from '../lib/mpl-decomposition-delta.mjs';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-require-decomposition-delta.mjs');

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-decomposition-delta-'));
  mkdirSync(join(tmp, '.mpl', 'mpl', 'decomposition-deltas'), { recursive: true });
  writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
    schema_version: CURRENT_SCHEMA_VERSION,
    current_phase: 'mpl-decompose',
  }));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function graph(count = 0, phaseName = 'Bootstrap', extraPhase = '') {
  return `
graph_version: 1
generated_by: mpl-decomposer
recompose_count: ${count}
completed_phase_policy: immutable_by_default
goal_contract_hash: abc
phases:
  - id: phase-1
    name: ${phaseName}
    evidence_required: [command, goal_trace]
    change_policy: append_delta_only
    interface_contract:
      requires: []
      produces:
        - type: artifact
          name: bootstrap
${extraPhase}`;
}

function appendedPhase() {
  return `  - id: phase-2
    name: Followup
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

function delta(base = 0, target = 1, op = 'append_phase') {
  return `
delta_version: 1
generated_by: mpl-decomposer
base_recompose_count: ${base}
target_recompose_count: ${target}
reason: "Append missing coverage phase"
change_policy: decomposition_delta_then_recompose
operations:
  - op: ${op}
    target_phase: phase-2
    rationale: "cover recovered requirement"
`;
}

function writeCurrentGraph(count = 0) {
  writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), graph(count));
}

function writeDeltaFile(base = 0, target = 1) {
  writeFileSync(
    join(tmp, '.mpl', 'mpl', 'decomposition-deltas', `recompose-${target}.yaml`),
    delta(base, target),
  );
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

describe('decomposition delta parser', () => {
  it('validates a recomposition delta', () => {
    const parsed = parseDecompositionDeltaText(delta());
    assert.equal(parsed.generated_by, 'mpl-decomposer');
    assert.equal(parsed.base_recompose_count, 0);
    assert.equal(parsed.target_recompose_count, 1);
    assert.deepEqual(parsed.operations, ['append_phase']);
    const verdict = validateDecompositionDelta(parsed, { expectedBase: 0, expectedTarget: 1 });
    assert.equal(verdict.valid, true, verdict.issues.join(', '));
  });

  it('rejects non-incremental or unknown delta operations', () => {
    const verdict = validateDecompositionDelta(parseDecompositionDeltaText(delta(0, 2, 'invent_phase')));
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.includes('target_recompose_count:not_next:0->2'));
    assert.ok(verdict.issues.includes('operations:unknown:invent_phase'));
  });
});

describe('mpl-require-decomposition-delta hook integration', () => {
  it('allows initial decomposition write when no graph exists yet', () => {
    const r = runHook({
      file_path: '.mpl/mpl/decomposition.yaml',
      content: graph(0),
    });
    assert.equal(r.continue, true);
  });

  it('blocks rewriting an existing graph without incrementing recompose_count', () => {
    writeCurrentGraph(0);
    const r = runHook({
      file_path: '.mpl/mpl/decomposition.yaml',
      content: graph(0, 'Changed'),
    });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /recompose_count:expected:1:actual:0/);
  });

  it('blocks recompose_count increment when matching delta is missing', () => {
    writeCurrentGraph(0);
    const r = runHook({
      file_path: '.mpl/mpl/decomposition.yaml',
      content: graph(1, 'Bootstrap', appendedPhase()),
    });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /decomposition_delta:missing:recompose-1\.yaml/);
  });

  it('allows full graph recomposition with a matching delta file', () => {
    writeCurrentGraph(0);
    writeDeltaFile(0, 1);
    const r = runHook({
      file_path: '.mpl/mpl/decomposition.yaml',
      content: graph(1, 'Bootstrap', appendedPhase()),
    });
    assert.equal(r.continue, true);
  });

  it('blocks partial Edit or MultiEdit changes to an existing graph', () => {
    writeCurrentGraph(0);
    const r = runHook({
      file_path: '.mpl/mpl/decomposition.yaml',
      edits: [{ old_string: 'Bootstrap', new_string: 'Changed' }],
    }, { toolName: 'MultiEdit' });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /decomposition:partial_edit_not_allowed/);
  });

  it('validates delta writes against the current graph count', () => {
    writeCurrentGraph(0);
    const r = runHook({
      file_path: '.mpl/mpl/decomposition-deltas/recompose-1.yaml',
      content: delta(0, 1),
    });
    assert.equal(r.continue, true);

    const bad = runHook({
      file_path: '.mpl/mpl/decomposition-deltas/recompose-2.yaml',
      content: delta(0, 1),
    });
    assert.equal(bad.decision, 'block');
    assert.match(bad.reason, /target_recompose_count:expected:1:actual:1|path_target:expected:2:actual:1/);
  });

  it('allows migration opt-out', () => {
    writeCurrentGraph(0);
    const r = runHook({
      file_path: '.mpl/mpl/decomposition.yaml',
      content: graph(0, 'Changed'),
    }, {
      config: { decomposition_delta_required: false },
    });
    assert.equal(r.continue, true);
  });
});
