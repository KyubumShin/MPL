import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import {
  ALLOWED_RELEASE_ARTIFACTS,
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
    resource_locks: []
    interface_contract:
      requires: []
      produces:
        - type: artifact
          name: bootstrap
  - id: phase-2
    evidence_required: [command, test_agent]
    change_policy: append_delta_only
    resource_locks: [dev_server]
    interface_contract:
      requires:
        - type: artifact
          name: bootstrap
          from_phase: phase-1
      produces: []
execution_tiers:
  - tier: 1
    phases: [phase-1]
    parallel: false
  - tier: 2
    phases: [phase-2]
    parallel: false
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
    assert.equal(graph.has_execution_tiers, true);
    assert.deepEqual(graph.execution_tier_phase_refs, ['phase-1', 'phase-2']);
    assert.equal(graph.phases.length, 2);
    assert.equal(graph.phases[0].has_resource_locks, true);
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
    assert.ok(verdict.issues.includes('execution_tiers:missing'));
    assert.ok(verdict.issues.includes('phase-1:evidence_required:missing'));
    assert.ok(verdict.issues.includes('phase-1:change_policy:missing'));
    assert.ok(verdict.issues.includes('phase-1:resource_locks:missing'));
    assert.ok(verdict.issues.includes('phase-1:requires:unknown:phase-99'));
  });

  it('reports execution_tiers unknown, duplicate, and missing phase refs', () => {
    const graph = parsePhaseContractGraphText(validGraph().replace(
      `  - tier: 2
    phases: [phase-2]
    parallel: false`,
      `  - tier: 2
    phases: [phase-1, phase-404]
    parallel: true`,
    ));
    const verdict = validatePhaseContractGraph(graph);
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.includes('execution_tiers:duplicate:phase-1'));
    assert.ok(verdict.issues.includes('execution_tiers:unknown:phase-404'));
    assert.ok(verdict.issues.includes('phase-2:execution_tiers:missing'));
  });
});

describe('Stage A mvp + release_cuts schema', () => {
  function graphWithMvp(mvpYaml = '', cutsYaml = '') {
    let base = validGraph();
    // Inject mvp and release_cuts at the top level, before execution_tiers.
    const insertion = (mvpYaml ? `\n${mvpYaml}` : '') + (cutsYaml ? `\n${cutsYaml}` : '');
    return base.replace('execution_tiers:', `${insertion}\nexecution_tiers:`);
  }

  it('exposes the allowed artifact set', () => {
    assert.deepEqual([...ALLOWED_RELEASE_ARTIFACTS].sort(), ['branch', 'draft_pr', 'release_manifest', 'tag']);
  });

  it('parses mvp object with phases, execution_mode, and artifact', () => {
    const text = graphWithMvp(`mvp:
  derived_from: goal_contract.mvp_scope
  phases: [phase-1]
  execution_mode: sequential
  artifact: draft_pr`);
    const graph = parsePhaseContractGraphText(text);
    assert.notEqual(graph.mvp, null);
    assert.deepEqual(graph.mvp.phases, ['phase-1']);
    assert.equal(graph.mvp.execution_mode, 'sequential');
    assert.equal(graph.mvp.artifact, 'draft_pr');
  });

  it('parses release_cuts items with block-list phases without splitting at nested dashes', () => {
    // Regression for codex review on 02beb4d: indent-blind `-` detection
    // misread inner `- phase-2` as a new cut boundary, splitting one valid
    // cut into two malformed items. Cut item boundaries must respect indent.
    const text = graphWithMvp('', `release_cuts:
  - id: cut-a
    phases:
      - phase-2
    user_approved: true
    artifact: release_manifest`);
    const graph = parsePhaseContractGraphText(text);
    assert.equal(graph.release_cuts.length, 1, `cut count: expected 1, got ${graph.release_cuts.length}`);
    assert.equal(graph.release_cuts[0].id, 'cut-a');
    assert.deepEqual(graph.release_cuts[0].phases, ['phase-2']);
    assert.equal(graph.release_cuts[0].user_approved, true);
    assert.equal(graph.release_cuts[0].artifact, 'release_manifest');
    const verdict = validatePhaseContractGraph(graph);
    assert.equal(verdict.valid, true, verdict.issues.join(', '));
  });

  it('parses release_cuts items even when id is not the first key (YAML mapping order is insignificant)', () => {
    // Regression for codex review: previously, parseReleaseCuts only recognized
    // items whose first line was `- id:`, which silently dropped items with
    // any other field order. Validator would then report `valid: true` because
    // there were no items to check.
    const text = graphWithMvp('', `release_cuts:
  - phases: [phase-2]
    id: cut-a
    user_approved: true
    artifact: release_manifest`);
    const graph = parsePhaseContractGraphText(text);
    assert.equal(graph.release_cuts.length, 1);
    assert.equal(graph.release_cuts[0].id, 'cut-a');
    assert.deepEqual(graph.release_cuts[0].phases, ['phase-2']);
    assert.equal(graph.release_cuts[0].user_approved, true);
    assert.equal(graph.release_cuts[0].artifact, 'release_manifest');

    // And the validator MUST still see the same constraints — e.g., overlap
    // detection must trigger even when ids are not first.
    const overlapText = graphWithMvp(
      `mvp:
  derived_from: goal_contract.mvp_scope
  phases: [phase-1]
  execution_mode: sequential
  artifact: draft_pr`,
      `release_cuts:
  - phases: [phase-1]
    id: cut-a
    user_approved: true
    artifact: release_manifest`,
    );
    const verdict = validatePhaseContractGraph(parsePhaseContractGraphText(overlapText));
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.some((i) => i.startsWith('release_cuts:cut-a:phases:overlap:phase-1:already_in:mvp')));
  });

  it('parses release_cuts list with id, phases, user_approved, artifact', () => {
    const text = graphWithMvp('', `release_cuts:
  - id: cut-ext-a
    phases: [phase-2]
    user_approved: true
    artifact: release_manifest`);
    const graph = parsePhaseContractGraphText(text);
    assert.equal(graph.release_cuts.length, 1);
    assert.equal(graph.release_cuts[0].id, 'cut-ext-a');
    assert.deepEqual(graph.release_cuts[0].phases, ['phase-2']);
    assert.equal(graph.release_cuts[0].user_approved, true);
    assert.equal(graph.release_cuts[0].artifact, 'release_manifest');
  });

  it('keeps a graph without mvp valid (backward compatibility)', () => {
    const verdict = validatePhaseContractGraph(parsePhaseContractGraphText(validGraph()));
    assert.equal(verdict.valid, true, verdict.issues.join(', '));
    const g = parsePhaseContractGraphText(validGraph());
    assert.equal(g.mvp, null);
    assert.equal(g.release_cuts, null);
  });

  it('accepts a fully valid mvp + release_cuts graph', () => {
    const text = graphWithMvp(
      `mvp:
  derived_from: goal_contract.mvp_scope
  phases: [phase-1]
  execution_mode: sequential
  artifact: draft_pr`,
      `release_cuts:
  - id: cut-ext-a
    phases: [phase-2]
    user_approved: true
    artifact: release_manifest`,
    );
    const verdict = validatePhaseContractGraph(parsePhaseContractGraphText(text));
    assert.equal(verdict.valid, true, verdict.issues.join(', '));
  });

  it('rejects mvp.phases pointing at unknown phase ids', () => {
    const text = graphWithMvp(`mvp:
  derived_from: goal_contract.mvp_scope
  phases: [phase-1, phase-999]
  execution_mode: sequential
  artifact: draft_pr`);
    const verdict = validatePhaseContractGraph(parsePhaseContractGraphText(text));
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.includes('mvp:phases:unknown:phase-999'));
  });

  it('rejects mvp.phases with duplicate ids', () => {
    const text = graphWithMvp(`mvp:
  derived_from: goal_contract.mvp_scope
  phases: [phase-1, phase-1]
  execution_mode: sequential
  artifact: draft_pr`);
    const verdict = validatePhaseContractGraph(parsePhaseContractGraphText(text));
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.includes('mvp:phases:duplicate:phase-1'));
  });

  it('rejects mvp without execution_mode', () => {
    const text = graphWithMvp(`mvp:
  derived_from: goal_contract.mvp_scope
  phases: [phase-1]
  artifact: draft_pr`);
    const verdict = validatePhaseContractGraph(parsePhaseContractGraphText(text));
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.includes('mvp:execution_mode:missing'));
  });

  it('rejects Stage B contract_skeleton execution_mode in Stage A', () => {
    const text = graphWithMvp(`mvp:
  derived_from: goal_contract.mvp_scope
  phases: [phase-1]
  execution_mode: contract_skeleton
  artifact: draft_pr`);
    const verdict = validatePhaseContractGraph(parsePhaseContractGraphText(text));
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.includes('mvp:execution_mode:unsupported:contract_skeleton'));
  });

  it('rejects mvp.artifact with unsupported value', () => {
    const text = graphWithMvp(`mvp:
  derived_from: goal_contract.mvp_scope
  phases: [phase-1]
  execution_mode: sequential
  artifact: gist`);
    const verdict = validatePhaseContractGraph(parsePhaseContractGraphText(text));
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.includes('mvp:artifact:unsupported:gist'));
  });

  it('rejects release_cuts with the reserved "mvp" id', () => {
    const text = graphWithMvp('', `release_cuts:
  - id: mvp
    phases: [phase-2]
    user_approved: true
    artifact: release_manifest`);
    const verdict = validatePhaseContractGraph(parsePhaseContractGraphText(text));
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.includes('release_cuts:id:reserved:mvp'));
  });

  it('rejects release_cuts with duplicate ids', () => {
    const text = graphWithMvp('', `release_cuts:
  - id: cut-a
    phases: [phase-1]
    user_approved: true
    artifact: release_manifest
  - id: cut-a
    phases: [phase-2]
    user_approved: true
    artifact: release_manifest`);
    const verdict = validatePhaseContractGraph(parsePhaseContractGraphText(text));
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.includes('release_cuts:id:duplicate:cut-a'));
  });

  it('rejects release_cuts.phases pointing at unknown phase ids', () => {
    const text = graphWithMvp('', `release_cuts:
  - id: cut-a
    phases: [phase-2, phase-999]
    user_approved: true
    artifact: release_manifest`);
    const verdict = validatePhaseContractGraph(parsePhaseContractGraphText(text));
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.includes('release_cuts:cut-a:phases:unknown:phase-999'));
  });

  it('rejects phase overlap between mvp and a release_cut', () => {
    const text = graphWithMvp(
      `mvp:
  derived_from: goal_contract.mvp_scope
  phases: [phase-1]
  execution_mode: sequential
  artifact: draft_pr`,
      `release_cuts:
  - id: cut-a
    phases: [phase-1]
    user_approved: true
    artifact: release_manifest`,
    );
    const verdict = validatePhaseContractGraph(parsePhaseContractGraphText(text));
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.some((i) => i.startsWith('release_cuts:cut-a:phases:overlap:phase-1:already_in:mvp')));
  });

  it('rejects phase overlap between two release_cuts', () => {
    const text = graphWithMvp('', `release_cuts:
  - id: cut-a
    phases: [phase-1]
    user_approved: true
    artifact: release_manifest
  - id: cut-b
    phases: [phase-1]
    user_approved: true
    artifact: release_manifest`);
    const verdict = validatePhaseContractGraph(parsePhaseContractGraphText(text));
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.some((i) => i.startsWith('release_cuts:cut-b:phases:overlap:phase-1:already_in:cut-a')));
  });

  it('rejects release_cuts missing user_approved', () => {
    const text = graphWithMvp('', `release_cuts:
  - id: cut-a
    phases: [phase-1]
    artifact: release_manifest`);
    const verdict = validatePhaseContractGraph(parsePhaseContractGraphText(text));
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.includes('release_cuts:cut-a:user_approved:missing'));
  });

  it('rejects mvp with no phases field at all', () => {
    const text = graphWithMvp(`mvp:
  derived_from: goal_contract.mvp_scope
  execution_mode: sequential
  artifact: draft_pr`);
    const verdict = validatePhaseContractGraph(parsePhaseContractGraphText(text));
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.includes('mvp:phases:missing'));
  });

  it('rejects mvp.phases as an explicit empty inline list', () => {
    const text = graphWithMvp(`mvp:
  derived_from: goal_contract.mvp_scope
  phases: []
  execution_mode: sequential
  artifact: draft_pr`);
    const verdict = validatePhaseContractGraph(parsePhaseContractGraphText(text));
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.includes('mvp:phases:missing'));
  });

  it('accepts release_cuts as an explicit empty inline list (backward-compat)', () => {
    const text = graphWithMvp('', 'release_cuts: []');
    const graph = parsePhaseContractGraphText(text);
    // Empty array parses to `[]` and validator runs zero cut-level checks.
    assert.deepEqual(graph.release_cuts, []);
    const verdict = validatePhaseContractGraph(graph);
    assert.equal(verdict.valid, true, verdict.issues.join(', '));
  });

  it('parses mvp.phases in block-list form', () => {
    const text = graphWithMvp(`mvp:
  derived_from: goal_contract.mvp_scope
  phases:
    - phase-1
  execution_mode: sequential
  artifact: draft_pr`);
    const graph = parsePhaseContractGraphText(text);
    assert.deepEqual(graph.mvp.phases, ['phase-1']);
    const verdict = validatePhaseContractGraph(graph);
    assert.equal(verdict.valid, true, verdict.issues.join(', '));
  });

  it('rejects mvp.derived_from with an unsupported value', () => {
    const text = graphWithMvp(`mvp:
  derived_from: some_other_source
  phases: [phase-1]
  execution_mode: sequential
  artifact: draft_pr`);
    const verdict = validatePhaseContractGraph(parsePhaseContractGraphText(text));
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.includes('mvp:derived_from:unsupported:some_other_source'));
  });

  it('accepts mvp without derived_from (treated as informational omission)', () => {
    const text = graphWithMvp(`mvp:
  phases: [phase-1]
  execution_mode: sequential
  artifact: draft_pr`);
    const verdict = validatePhaseContractGraph(parsePhaseContractGraphText(text));
    assert.equal(verdict.valid, true, verdict.issues.join(', '));
  });

  it('rejects release_cuts missing artifact', () => {
    const text = graphWithMvp('', `release_cuts:
  - id: cut-a
    phases: [phase-1]
    user_approved: false`);
    const verdict = validatePhaseContractGraph(parsePhaseContractGraphText(text));
    assert.equal(verdict.valid, false);
    assert.ok(verdict.issues.includes('release_cuts:cut-a:artifact:missing'));
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
