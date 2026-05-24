import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReleaseManifest,
  buildEvidenceSummary,
  buildGateResultsSnapshot,
  resolveCutDescriptor,
  RELEASE_DIR_REL_PATH,
} from '../lib/mpl-release-manifest.mjs';

const NOW = '2026-05-24T12:00:00.000Z';

function mvpContract({ ac = ['AC-1', 'AC-2'], ax = ['AX-1'], artifact = 'draft_pr' } = {}) {
  return {
    mvp_scope: {
      acceptance_criteria: ac,
      variation_axes: ax,
      artifact,
    },
  };
}

function mvpGraph({ phases = ['phase-1', 'phase-2'], artifact = 'draft_pr' } = {}) {
  return { mvp: { phases, artifact }, release_cuts: [] };
}

describe('RELEASE_DIR_REL_PATH constant', () => {
  it('points at the canonical .mpl/mpl/releases location (matches RFC §5.4)', () => {
    assert.equal(RELEASE_DIR_REL_PATH, '.mpl/mpl/releases');
  });
});

describe('resolveCutDescriptor', () => {
  it('returns mvp descriptor from graph.mvp + contract.mvp_scope when cutId="mvp"', () => {
    const d = resolveCutDescriptor('mvp', mvpContract(), mvpGraph());
    assert.deepEqual(d.phases, ['phase-1', 'phase-2']);
    assert.deepEqual(d.acceptance_criteria, ['AC-1', 'AC-2']);
    assert.deepEqual(d.variation_axes, ['AX-1']);
    assert.equal(d.artifact, 'draft_pr');
  });

  it('prefers graph.mvp.artifact over contract.mvp_scope.artifact (graph is canonical)', () => {
    const contract = mvpContract({ artifact: 'tag' });
    const graph = mvpGraph({ artifact: 'draft_pr' });
    const d = resolveCutDescriptor('mvp', contract, graph);
    assert.equal(d.artifact, 'draft_pr');
  });

  it('falls back to contract.mvp_scope.artifact when graph.mvp.artifact is missing', () => {
    const contract = mvpContract({ artifact: 'tag' });
    const graph = { mvp: { phases: ['phase-1'], artifact: null }, release_cuts: [] };
    const d = resolveCutDescriptor('mvp', contract, graph);
    assert.equal(d.artifact, 'tag');
  });

  it('returns null when neither contract.mvp_scope nor graph.mvp exists', () => {
    assert.equal(resolveCutDescriptor('mvp', {}, { release_cuts: [] }), null);
  });

  // PR #187 codex review High: strict-both-required regression suite.
  it('returns null when ONLY contract.mvp_scope is present (no graph.mvp) — strict', () => {
    // Pre-fix: would have returned a descriptor with phases:[] and shipped
    // a degraded manifest. Now rejects so release-finalize bails.
    const d = resolveCutDescriptor('mvp', mvpContract(), { mvp: null, release_cuts: [] });
    assert.equal(d, null);
  });

  it('returns null when ONLY graph.mvp is present (no contract.mvp_scope) — strict', () => {
    // Same regression — goal_trace would have been empty without contract,
    // so the manifest could not satisfy RFC §5.4 goal-trace requirement.
    const d = resolveCutDescriptor('mvp', { mvp_scope: null }, mvpGraph());
    assert.equal(d, null);
  });

  it('returns null when graph.mvp.phases is empty array — empty-membership guard', () => {
    // Decomposer never derived an mvp membership; shipping an empty-phases
    // manifest would assert "released" with no work — refuse.
    const graph = { mvp: { phases: [], artifact: 'draft_pr' }, release_cuts: [] };
    const d = resolveCutDescriptor('mvp', mvpContract(), graph);
    assert.equal(d, null);
  });

  it('returns null when extension cut phases array is empty (same empty-membership guard)', () => {
    const graph = {
      mvp: null,
      release_cuts: [{ id: 'cut-1', phases: [], artifact: 'tag' }],
    };
    assert.equal(resolveCutDescriptor('cut-1', {}, graph), null);
  });

  // PR #187 claude review #4: extension-cut AC/AX auto-pickup (Stage B forward-compat).
  it('auto-picks extension cut acceptance_criteria/variation_axes when release_cuts[] entry carries them', () => {
    const graph = {
      mvp: null,
      release_cuts: [{
        id: 'cut-extended',
        phases: ['phase-7'],
        artifact: 'tag',
        acceptance_criteria: ['AC-7', 'AC-8'],  // Stage B forward-compat field
        variation_axes: ['AX-3'],
      }],
    };
    const d = resolveCutDescriptor('cut-extended', {}, graph);
    assert.deepEqual(d.acceptance_criteria, ['AC-7', 'AC-8']);
    assert.deepEqual(d.variation_axes, ['AX-3']);
  });

  it('resolves an extension cut by id from release_cuts[]', () => {
    const graph = {
      mvp: null,
      release_cuts: [
        { id: 'cut-1', phases: ['phase-3', 'phase-4'], artifact: 'tag', user_approved: true },
        { id: 'cut-2', phases: ['phase-5'], artifact: 'branch', user_approved: true },
      ],
    };
    const d = resolveCutDescriptor('cut-2', {}, graph);
    assert.deepEqual(d.phases, ['phase-5']);
    assert.equal(d.artifact, 'branch');
    // Extension cuts don't carry AC/AX in Stage A.
    assert.deepEqual(d.acceptance_criteria, []);
    assert.deepEqual(d.variation_axes, []);
  });

  it('returns null on empty / non-string cutId', () => {
    assert.equal(resolveCutDescriptor('', mvpContract(), mvpGraph()), null);
    assert.equal(resolveCutDescriptor(null, mvpContract(), mvpGraph()), null);
    assert.equal(resolveCutDescriptor(undefined, mvpContract(), mvpGraph()), null);
  });

  it('returns null when extension cut id is not in release_cuts[]', () => {
    const graph = { mvp: null, release_cuts: [{ id: 'cut-1', phases: [], artifact: null }] };
    assert.equal(resolveCutDescriptor('cut-missing', {}, graph), null);
  });
});

describe('buildReleaseManifest', () => {
  it('builds a full manifest for an mvp cohort with all fields populated', () => {
    const state = {
      pipeline_id: 'mpl-20260524-mvp-test',
      release: {
        current_cut_id: 'mvp',
        gate_results: {
          hard1_baseline: { exit_code: 0, command: 'npm run build' },
          hard2_coverage: { exit_code: 0, command: 'npm test' },
          hard3_resilience: { exit_code: 0, command: 'contract' },
        },
      },
    };
    const m = buildReleaseManifest({
      cutId: 'mvp',
      state,
      contract: mvpContract(),
      graph: mvpGraph(),
      now: NOW,
    });
    assert.equal(m.cut_id, 'mvp');
    assert.deepEqual(m.phases, ['phase-1', 'phase-2']);
    assert.deepEqual(m.goal_trace.acceptance_criteria, ['AC-1', 'AC-2']);
    assert.deepEqual(m.goal_trace.variation_axes, ['AX-1']);
    // 1.6c-ii placeholders for 1.6c-iii.
    assert.equal(m.commit_sha, null);
    assert.equal(m.tree_sha, null);
    assert.equal(m.snapshot_ref, null);
    assert.equal(m.artifact_creation_failed, null);
    assert.deepEqual(m.gate_results_summary, { hard1: true, hard2: true, hard3: true });
    assert.equal(m.artifact, 'draft_pr');
    assert.equal(m.created_at, NOW);
    assert.equal(m.pipeline_id, 'mpl-20260524-mvp-test');
  });

  it('returns null when no descriptor can be resolved', () => {
    const m = buildReleaseManifest({
      cutId: 'mvp',
      state: { release: {} },
      contract: null,
      graph: null,
      now: NOW,
    });
    assert.equal(m, null);
  });

  it('summarizes gate FAIL as boolean false', () => {
    const state = {
      release: {
        gate_results: {
          hard1_baseline: { exit_code: 0 },
          hard2_coverage: { exit_code: 1 },
          hard3_resilience: { exit_code: 0 },
        },
      },
    };
    const m = buildReleaseManifest({
      cutId: 'mvp', state,
      contract: mvpContract(), graph: mvpGraph(), now: NOW,
    });
    assert.deepEqual(m.gate_results_summary, { hard1: true, hard2: false, hard3: true });
  });

  it('summarizes absent gates as null', () => {
    const state = { release: { gate_results: {} } };
    const m = buildReleaseManifest({
      cutId: 'mvp', state,
      contract: mvpContract(), graph: mvpGraph(), now: NOW,
    });
    assert.deepEqual(m.gate_results_summary, { hard1: null, hard2: null, hard3: null });
  });

  it('defaults created_at to a fresh ISO timestamp when `now` is omitted', () => {
    const m = buildReleaseManifest({
      cutId: 'mvp',
      state: { release: {} },
      contract: mvpContract(), graph: mvpGraph(),
    });
    assert.match(m.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('buildGateResultsSnapshot', () => {
  it('returns a full snapshot with archived_at + clone of release.gate_results', () => {
    const state = {
      release: {
        gate_results: {
          hard1_passed: true,
          hard2_passed: false,
          hard3_passed: null,
          hard1_baseline: { exit_code: 0, command: 'build' },
          hard2_coverage: { exit_code: 2, stdout_tail: 'fail' },
          hard3_resilience: null,
        },
      },
    };
    const snap = buildGateResultsSnapshot(state, NOW);
    assert.equal(snap.archived_at, NOW);
    assert.equal(snap.gate_results.hard1_passed, true);
    assert.equal(snap.gate_results.hard2_passed, false);
    assert.deepEqual(snap.gate_results.hard1_baseline, { exit_code: 0, command: 'build' });
    assert.deepEqual(snap.gate_results.hard2_coverage, { exit_code: 2, stdout_tail: 'fail' });
    assert.equal(snap.gate_results.hard3_resilience, null);
  });

  it('does not share object identity with state.release.gate_results entries (defensive clone)', () => {
    const entry = { exit_code: 0 };
    const state = { release: { gate_results: { hard1_baseline: entry } } };
    const snap = buildGateResultsSnapshot(state);
    assert.notEqual(snap.gate_results.hard1_baseline, entry);
    // Mutating the source should not bleed into the snapshot.
    entry.exit_code = 99;
    assert.equal(snap.gate_results.hard1_baseline.exit_code, 0);
  });

  it('isolates NESTED mutations via structuredClone (claude #3 forward-compat)', () => {
    // If a gate entry ever grows a nested object (e.g., diagnostics block),
    // shallow spread would leak the source mutation through the nested
    // reference. structuredClone deep-copies so the snapshot is fully
    // independent. This test future-proofs against shape additions.
    const breakdown = { warnings: 1, errors: 0 };
    const entry = { exit_code: 0, diagnostics: { breakdown } };
    const state = { release: { gate_results: { hard2_coverage: entry } } };
    const snap = buildGateResultsSnapshot(state);
    // Mutate the deeply-nested source object after the snapshot is taken.
    breakdown.warnings = 99;
    breakdown.errors = 99;
    assert.equal(snap.gate_results.hard2_coverage.diagnostics.breakdown.warnings, 1);
    assert.equal(snap.gate_results.hard2_coverage.diagnostics.breakdown.errors, 0);
  });

  it('handles missing state.release gracefully', () => {
    const snap = buildGateResultsSnapshot({}, NOW);
    assert.equal(snap.gate_results.hard1_passed, null);
    assert.equal(snap.gate_results.hard1_baseline, null);
  });
});

describe('buildEvidenceSummary', () => {
  it('renders cohort header + phase status + goal_trace + gate results + dispatches', () => {
    const state = {
      pipeline_id: 'mpl-20260524-mvp-test',
      release: {
        gate_results: {
          hard1_baseline: { exit_code: 0 },
          hard2_coverage: { exit_code: 1 },
          hard3_resilience: { exit_code: 0 },
        },
      },
      execution: {
        phase_details: [
          { id: 'phase-1', status: 'completed' },
          { id: 'phase-2', status: 'completed' },
        ],
      },
      test_agent_dispatched: {
        'phase-1': { verdict: 'PASS', tests_total: 5, tests_failed: 0 },
        'phase-2': { verdict: 'PASS', tests_total: 3, tests_failed: 0 },
      },
    };
    const md = buildEvidenceSummary({
      cutId: 'mvp', state,
      contract: mvpContract(), graph: mvpGraph(), now: NOW,
    });
    assert.match(md, /^# Release evidence — `mvp`/);
    assert.match(md, /Pipeline:\*\* mpl-20260524-mvp-test/);
    assert.match(md, /Artifact:\*\* draft_pr/);
    assert.match(md, /## Phases/);
    assert.match(md, /`phase-1` — completed/);
    assert.match(md, /`phase-2` — completed/);
    assert.match(md, /## Goal trace/);
    assert.match(md, /`AC-1`, `AC-2`/);
    assert.match(md, /`AX-1`/);
    assert.match(md, /## Gate results/);
    assert.match(md, /Hard 1.*✅ PASS/);
    assert.match(md, /Hard 2.*❌ FAIL.*exit 1/);
    assert.match(md, /Hard 3.*✅ PASS/);
    assert.match(md, /## Test-agent dispatches/);
    assert.match(md, /`phase-1` — verdict=PASS, tests=5/);
  });

  it('shows "(no execution record)" when phase_details is missing for a cut phase', () => {
    const state = {
      release: { gate_results: {} },
      execution: { phase_details: [] },
      test_agent_dispatched: {},
    };
    const md = buildEvidenceSummary({
      cutId: 'mvp', state,
      contract: mvpContract(), graph: mvpGraph(), now: NOW,
    });
    assert.match(md, /`phase-1` — \(no execution record\)/);
  });

  it('shows "_(none recorded)_" when AC/AX lists are empty (extension cut)', () => {
    const graph = {
      mvp: null,
      release_cuts: [{ id: 'cut-1', phases: ['phase-3'], artifact: 'branch' }],
    };
    const md = buildEvidenceSummary({
      cutId: 'cut-1',
      state: { release: { gate_results: {} } },
      contract: {},
      graph,
      now: NOW,
    });
    assert.match(md, /Acceptance criteria: _\(none recorded\)_/);
    assert.match(md, /Variation axes: _\(none recorded\)_/);
  });

  it('reports missing test-agent evidence when no cohort phase has a dispatch', () => {
    const state = {
      release: { gate_results: {} },
      test_agent_dispatched: { 'phase-other': { verdict: 'PASS' } },
    };
    const md = buildEvidenceSummary({
      cutId: 'mvp', state,
      contract: mvpContract(), graph: mvpGraph(), now: NOW,
    });
    assert.match(md, /_No test-agent evidence recorded for this cohort\._/);
  });

  it('uses fallback descriptor when cut cannot be resolved (degraded but does not throw)', () => {
    // E.g., the contract/graph went missing mid-pipeline — the summary still
    // renders so the user has a reference point in the failure message.
    const md = buildEvidenceSummary({
      cutId: 'mvp',
      state: { release: { gate_results: {} } },
      contract: null, graph: null, now: NOW,
    });
    assert.match(md, /^# Release evidence — `mvp`/);
    assert.match(md, /Artifact:\*\* \(none requested\)/);
  });
});
