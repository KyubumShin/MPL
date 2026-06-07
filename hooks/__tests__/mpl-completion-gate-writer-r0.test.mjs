/**
 * exp25 R0 — completion gate on the `mpl_state_write` MCP path (writer-cli.mjs).
 *
 * I14 (hooks/lib/mpl-state-invariant.mjs) only fires on Edit/Write of state.json
 * via the PreToolUse hook. The orchestrator's `mpl_state_write` MCP tool shells
 * out to hooks/lib/state/writer-cli.mjs, which bypasses BOTH the PreToolUse hook
 * (I14) and the Stop hook. exp25b reached current_phase='completed' with
 * gate_results=null AND finalize_done=false through this path. writer-cli now
 * runs the same completion-evidence check (completionGateIssues) that I14 uses,
 * scoped to the TRANSITION into 'completed'.
 *
 * The lightweight small-* flow and full-pipeline partial completion both land
 * via the phase-controller Stop hook (writeState directly), never writer-cli, so
 * they must remain unaffected — exercised by mpl-phase-controller.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { completionGateIssues } from '../lib/mpl-state-invariant.mjs';
import { readState } from '../lib/state/reader.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'state', 'writer-cli.mjs');

function fresh(initialState) {
  const cwd = mkdtempSync(join(tmpdir(), 'mpl-r0-cli-'));
  mkdirSync(join(cwd, '.mpl'), { recursive: true });
  if (initialState) writeFileSync(join(cwd, '.mpl', 'state.json'), JSON.stringify(initialState));
  // opt out of Phase 0 artifact gating (I13) so we isolate the R0 behavior.
  writeFileSync(join(cwd, '.mpl', 'config.json'), JSON.stringify({ phase0_artifacts_required: false }));
  return cwd;
}

// Drive the CLI exactly as the MCP state-manager does: --cwd argv + patch on stdin.
function mcpWrite(cwd, patch) {
  const r = spawnSync('node', [CLI, '--cwd', cwd], { input: JSON.stringify(patch), encoding: 'utf-8' });
  assert.equal(r.status, 0, `writer-cli should exit 0 (got ${r.status}); stderr=${r.stderr}`);
  return JSON.parse(r.stdout);
}

const passingGates = () => ({
  hard1_baseline: { exit_code: 0 },
  hard2_coverage: { exit_code: 0 },
  hard3_resilience: { exit_code: 0 },
});

/* ───────────────────────── completionGateIssues (shared helper) ───────────── */

test('helper: null gates + finalize false → all issues reported', () => {
  const issues = completionGateIssues({ current_phase: 'completed' });
  assert.ok(issues.includes('finalize_done_not_true'));
  assert.ok(issues.includes('gate_results_absent'));
});

test('helper: passing gates + finalize_done → no issues', () => {
  assert.deepEqual(
    completionGateIssues({ finalize_done: true, gate_results: passingGates() }),
    [],
  );
});

test('helper: a failing gate (exit_code 1) is flagged not_passing', () => {
  const gr = passingGates();
  gr.hard2_coverage = { exit_code: 1 };
  const issues = completionGateIssues({ finalize_done: true, gate_results: gr });
  assert.deepEqual(issues, ['hard2_coverage_not_passing']);
});

test('helper: waived gate (carries exit_code, matching I14) passes', () => {
  const gr = passingGates();
  gr.hard3_resilience = { exit_code: 1, waived: true };
  assert.deepEqual(completionGateIssues({ finalize_done: true, gate_results: gr }), []);
});

/* ───────────────────────── writer-cli (mpl_state_write) integration ───────── */

test('exp25b repro: MCP flip to completed (null gates, finalize false) → REFUSED', () => {
  const cwd = fresh({ current_phase: 'phase2-sprint' });
  try {
    const res = mcpWrite(cwd, { current_phase: 'completed' });
    assert.equal(res.success, false, 'mpl_state_write must refuse evidence-less completion');
    assert.match(res.reason, /\[MPL R0\]/);
    assert.match(res.reason, /finalize_done_not_true/);
    // on-disk state must NOT have flipped
    assert.equal(readState(cwd).current_phase, 'phase2-sprint');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('MCP completion WITH passing gates + finalize_done → succeeds', () => {
  const cwd = fresh({ current_phase: 'phase2-sprint' });
  try {
    const res = mcpWrite(cwd, {
      current_phase: 'completed', finalize_done: true, gate_results: passingGates(),
    });
    assert.equal(res.success, true, `expected success; reason=${res.reason}`);
    assert.equal(readState(cwd).current_phase, 'completed');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('MCP completion with a failing gate → REFUSED', () => {
  const cwd = fresh({ current_phase: 'phase3-gate' });
  try {
    const gr = passingGates();
    gr.hard1_baseline = { exit_code: 2 };
    const res = mcpWrite(cwd, { current_phase: 'completed', finalize_done: true, gate_results: gr });
    assert.equal(res.success, false);
    assert.match(res.reason, /hard1_baseline_not_passing/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('MCP non-completion transition is never R0-gated', () => {
  const cwd = fresh({ current_phase: 'mpl-decompose' });
  try {
    const res = mcpWrite(cwd, { current_phase: 'phase2-sprint' });
    assert.equal(res.success, true);
    assert.equal(readState(cwd).current_phase, 'phase2-sprint');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('MCP steady-state rewrite of already-completed state is not re-gated', () => {
  // start already-completed WITH evidence, then a benign follow-up patch.
  const cwd = fresh({
    current_phase: 'completed', finalize_done: true, gate_results: passingGates(),
  });
  try {
    const res = mcpWrite(cwd, { note: 'post-completion annotation' });
    assert.equal(res.success, true, `benign post-completion write must pass; reason=${res.reason}`);
    assert.equal(readState(cwd).current_phase, 'completed');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
