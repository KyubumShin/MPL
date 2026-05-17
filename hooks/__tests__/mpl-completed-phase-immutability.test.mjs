import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import {
  completedPhaseIds,
  validateCompletedPhaseImmutability,
} from '../lib/mpl-completed-phase-immutability.mjs';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-require-completed-phase-immutability.mjs');

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-completed-phase-immutability-'));
  mkdirSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1'), { recursive: true });
  writeFileSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1', 'state-summary.md'), '# done');
  writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
    schema_version: CURRENT_SCHEMA_VERSION,
    current_phase: 'phase2-sprint',
    execution: {
      phases: { total: 2, completed: 1, current: 'phase-2', failed: 0, circuit_breaks: 0 },
      phase_details: [
        { id: 'phase-1', name: 'One', status: 'completed' },
        { id: 'phase-2', name: 'Two', status: 'in_progress' },
      ],
    },
  }));
  writeFileSync(join(tmp, '.mpl', 'mpl', 'decomposition.yaml'), graph());
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function graph(phase1Name = 'Completed', phase2Name = 'Pending') {
  return `
graph_version: 1
generated_by: mpl-decomposer
recompose_count: 0
completed_phase_policy: immutable_by_default
goal_contract_hash: abc
phases:
  - id: phase-1
    name: ${phase1Name}
    evidence_required: [command, goal_trace]
    change_policy: append_delta_only
    interface_contract:
      requires: []
      produces:
        - type: artifact
          name: completed_output
  - id: phase-2
    name: ${phase2Name}
    evidence_required: [command, goal_trace]
    change_policy: append_delta_only
    interface_contract:
      requires:
        - type: artifact
          name: completed_output
          from_phase: phase-1
      produces: []
`;
}

function graphWithoutPhase1() {
  return `
graph_version: 1
generated_by: mpl-decomposer
recompose_count: 1
completed_phase_policy: immutable_by_default
goal_contract_hash: abc
phases:
  - id: phase-2
    name: Pending
    evidence_required: [command, goal_trace]
    change_policy: append_delta_only
    interface_contract:
      requires: []
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

describe('completed phase immutability helpers', () => {
  it('collects completed phases from disk and state', () => {
    assert.deepEqual(completedPhaseIds(tmp, JSON.parse(readStateText())), ['phase-1']);
  });

  it('allows incomplete phase changes while completed block is unchanged', () => {
    const verdict = validateCompletedPhaseImmutability({
      oldText: graph(),
      newText: graph('Completed', 'Changed Pending'),
      completedIds: ['phase-1'],
    });
    assert.equal(verdict.valid, true, verdict.issues.join(', '));
  });

  it('detects completed phase block mutations', () => {
    const verdict = validateCompletedPhaseImmutability({
      oldText: graph(),
      newText: graph('Changed Completed', 'Pending'),
      completedIds: ['phase-1'],
    });
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.includes('phase-1:contract:modified'));
  });
});

function readStateText() {
  return readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8');
}

describe('mpl-require-completed-phase-immutability hook integration', () => {
  it('allows rewriting incomplete phase blocks when completed blocks are unchanged', () => {
    const r = runHook(graph('Completed', 'Changed Pending'));
    assert.equal(r.continue, true);
  });

  it('blocks changes to completed phase blocks', () => {
    const r = runHook(graph('Changed Completed', 'Pending'));
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /phase-1:contract:modified/);
  });

  it('blocks removing a completed phase from the graph', () => {
    const r = runHook(graphWithoutPhase1());
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /phase-1:new_contract:missing/);
  });

  it('blocks partial Edit/MultiEdit when completed phases exist', () => {
    const r = runHook(null, {
      toolName: 'MultiEdit',
      toolInput: {
        file_path: '.mpl/mpl/decomposition.yaml',
        edits: [{ old_string: 'Completed', new_string: 'Changed Completed' }],
      },
    });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /partial_edit_not_allowed/);
  });

  it('allows migration opt-out', () => {
    const r = runHook(graph('Changed Completed', 'Pending'), {
      config: { completed_phase_immutability_required: false },
    });
    assert.equal(r.continue, true);
  });
});
