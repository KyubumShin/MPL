/**
 * exp25 R0' — completion-evidence schema unification + finalize-path coverage.
 *
 * Part A (schema): isPassingGateEntry / completionGateIssues recognize BOTH gate
 * schemas MPL produces — the recorder {command, exit_code, source:'recorder'} AND
 * the orchestrator summary {gate, ..., result:'PASS'}. Pre-R0', the exit_code-only
 * check FALSE-POSITIVE flagged the result:'PASS' schema as "unrecorded" — exactly
 * what exp25a's live completion used (real tsc/vitest, summarized as result:'PASS').
 *
 * Part B (finalize-path coverage): handleFinalize() enforces the 3 Hard Gates'
 * PASSING evidence on the finalize_done=true write, because the phase-controller
 * completion transition (_phase5FinalizeDecision) bypasses I14 (STATE_WRITE) and
 * writer-cli (mpl_state_write). ABSENT gate_results are always blocked (the
 * exp24/exp25b gate-theater target); a present-but-failing gate is allowed ONLY
 * for partial completion (fix-loop exhausted).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { completionGateIssues } from '../lib/mpl-state-invariant.mjs';
import { handleFinalize } from '../lib/policy/gates.mjs';

/* ───────────────────────── Part A: schema unification ─────────────────────── */

const recorderGates = () => ({
  hard1_baseline: { command: 'npm run build', exit_code: 0, source: 'recorder' },
  hard2_coverage: { command: 'npm test', exit_code: 0, source: 'recorder' },
  hard3_resilience: { command: 'e2e', exit_code: 0, source: 'recorder' },
});
const summaryGates = () => ({
  hard1_baseline: { gate: 'Build+Lint+Type', tsc_noEmit: 'exit 0', result: 'PASS' },
  hard2_coverage: { gate: 'Tests', tests: '551/551', result: 'PASS' },
  hard3_resilience: { gate: 'Contract Diff', violations: 0, result: 'PASS' },
});

test('A: recorder {exit_code:0} schema → no issues (backward compatible)', () => {
  assert.deepEqual(completionGateIssues({ finalize_done: true, gate_results: recorderGates() }), []);
});

test("A: orchestrator {result:'PASS'} schema → no issues (exp25a live schema)", () => {
  assert.deepEqual(completionGateIssues({ finalize_done: true, gate_results: summaryGates() }), []);
});

test("A: {result:'FAIL'} is flagged not_passing", () => {
  const gr = summaryGates();
  gr.hard2_coverage = { gate: 'Tests', result: 'FAIL' };
  assert.deepEqual(
    completionGateIssues({ finalize_done: true, gate_results: gr }),
    ['hard2_coverage_not_passing'],
  );
});

test('A: null gate_results still blocked (exp24/exp25b target intact)', () => {
  const issues = completionGateIssues({ finalize_done: true, gate_results: null });
  assert.ok(issues.includes('gate_results_absent'));
});

test('A: empty-object slot (no exit_code, no result) → unrecorded', () => {
  const gr = summaryGates();
  gr.hard3_resilience = {};
  assert.deepEqual(
    completionGateIssues({ finalize_done: true, gate_results: gr }),
    ['hard3_resilience_unrecorded'],
  );
});

/* ───────────────────── Part B: finalize-path gate-evidence ────────────────── */

function ws() {
  const cwd = mkdtempSync(join(tmpdir(), 'mpl-r0prime-'));
  mkdirSync(join(cwd, '.mpl', 'mpl'), { recursive: true });
  return cwd;
}
const finalizeWrite = (cwd, state) => ({
  cwd,
  state,
  toolName: 'Write',
  toolInput: { file_path: join(cwd, '.mpl', 'state.json'), content: '{"finalize_done": true}' },
  hookEvent: 'PreToolUse',
});
const hasGateEvidenceFailure = (res) =>
  (res.failures || []).some((f) => f.code === 'completion_without_gate_evidence');

test('B: finalize with null gate_results → gate-evidence failure (blocked)', () => {
  const cwd = ws();
  try {
    const res = handleFinalize(finalizeWrite(cwd, { current_phase: 'phase5-finalize', gate_results: null }));
    assert.ok(hasGateEvidenceFailure(res), 'absent gate_results must raise the gate-evidence failure');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("B: finalize with {result:'PASS'} gates → NO gate-evidence failure (exp25a path now ok)", () => {
  const cwd = ws();
  try {
    const res = handleFinalize(finalizeWrite(cwd, { current_phase: 'phase5-finalize', gate_results: summaryGates() }));
    assert.ok(!hasGateEvidenceFailure(res), `result:'PASS' gates must satisfy the evidence check; failures=${JSON.stringify(res.failures)}`);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('B: finalize with a FAILING gate, NOT partial → gate-evidence failure', () => {
  const cwd = ws();
  try {
    const gr = summaryGates();
    gr.hard2_coverage = { gate: 'Tests', result: 'FAIL' };
    const res = handleFinalize(finalizeWrite(cwd, {
      current_phase: 'phase5-finalize', gate_results: gr, fix_loop_count: 0, max_fix_loops: 10,
    }));
    assert.ok(hasGateEvidenceFailure(res), 'failing gate without partial-completion must block');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('B: finalize with a FAILING gate but PARTIAL (fix-loop exhausted) → exempt (no gate-evidence failure)', () => {
  const cwd = ws();
  try {
    const gr = summaryGates();
    gr.hard2_coverage = { gate: 'Tests', result: 'FAIL' };
    const res = handleFinalize(finalizeWrite(cwd, {
      current_phase: 'phase5-finalize', gate_results: gr, fix_loop_count: 10, max_fix_loops: 10,
    }));
    assert.ok(!hasGateEvidenceFailure(res), 'partial completion (fixCount>=maxFix) must be exempt from gate-evidence');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('B: ABSENT gate_results blocked EVEN IF partial (zero evidence is always theater)', () => {
  const cwd = ws();
  try {
    const res = handleFinalize(finalizeWrite(cwd, {
      current_phase: 'phase5-finalize', gate_results: null, fix_loop_count: 10, max_fix_loops: 10,
    }));
    assert.ok(hasGateEvidenceFailure(res), 'absent gate_results must block regardless of partial status');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('B: non-finalize write is untouched (no gate-evidence failure injected)', () => {
  const cwd = ws();
  try {
    const res = handleFinalize({
      cwd,
      state: { current_phase: 'phase2-sprint', gate_results: null },
      toolName: 'Write',
      toolInput: { file_path: join(cwd, 'src', 'x.ts'), content: 'export const x = 1;' },
      hookEvent: 'PreToolUse',
    });
    assert.ok(!hasGateEvidenceFailure(res), 'a non-finalize write must not trigger the finalize gate-evidence check');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
