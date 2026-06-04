/**
 * exp25 — single-session auto-continue (Phase-2+ clean-stop → Stop-block resume).
 *
 * Without this, MPL's Stop hook idles the agent at every Phase-2+ boundary, so an
 * unattended run needs a second CLI nudging the first (the cmux harness). The
 * pure maybeAutoContinue() converts a Phase-2+ idle Stop into {decision:'block'}
 * so the SAME session resumes. Scope = execute phases only; interview/decompose,
 * pause states, terminal states, opt-out, and already-blocking envelopes are
 * left untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maybeAutoContinue, AUTO_CONTINUE_PHASES } from '../lib/auto-continue.mjs';

const IDLE = { continue: true, suppressOutput: true };
const isResume = (r) => r && r.decision === 'block' && /auto-continue/.test(r.reason || '');

test('Phase-2+ execute clean-stop (default ON) → resume (decision:block)', () => {
  for (const phase of ['phase2-sprint', 'phase3-gate', 'phase4-fix', 'phase5-finalize']) {
    const r = maybeAutoContinue('Stop', { ...IDLE }, { current_phase: phase }, true);
    assert.ok(isResume(r), `${phase} should resume, got ${JSON.stringify(r)}`);
  }
});

test('SubagentStop is also auto-continued', () => {
  const r = maybeAutoContinue('SubagentStop', { ...IDLE }, { current_phase: 'phase2-sprint' }, true);
  assert.ok(isResume(r));
});

test('explicit opt-out (enabled=false) → idle untouched', () => {
  const r = maybeAutoContinue('Stop', { ...IDLE }, { current_phase: 'phase2-sprint' }, false);
  assert.deepEqual(r, IDLE);
});

test('out-of-scope phases (interview/decompose/plan) → idle untouched', () => {
  for (const phase of ['mpl-init', 'mpl-decompose', 'mpl-ambiguity-resolve', 'phase1-plan', 'phase1a-research', 'phase1b-plan']) {
    const r = maybeAutoContinue('Stop', { ...IDLE }, { current_phase: phase }, true);
    assert.deepEqual(r, IDLE, `${phase} must stay manual`);
  }
});

test('terminal phases (completed/cancelled) → idle untouched', () => {
  for (const phase of ['completed', 'cancelled']) {
    const r = maybeAutoContinue('Stop', { ...IDLE }, { current_phase: phase }, true);
    assert.deepEqual(r, IDLE, `${phase} must not resume`);
  }
});

test('pause states (verification_hang / blocked_hook) → idle untouched even in execute phase', () => {
  for (const ss of ['verification_hang', 'blocked_hook']) {
    const r = maybeAutoContinue('Stop', { ...IDLE }, { current_phase: 'phase2-sprint', session_status: ss }, true);
    assert.deepEqual(r, IDLE, `session_status=${ss} needs human triage, must not auto-continue`);
  }
});

test('a real block the aggregate already decided is never overridden', () => {
  const block = { continue: false, decision: 'block', reason: 'I14: completion without gate evidence' };
  const r = maybeAutoContinue('Stop', block, { current_phase: 'phase5-finalize' }, true);
  assert.deepEqual(r, block, 'must not clobber a genuine block');
});

test('non-Stop events are untouched', () => {
  const r = maybeAutoContinue('PreToolUse', { ...IDLE }, { current_phase: 'phase2-sprint' }, true);
  assert.deepEqual(r, IDLE);
});

test('missing/invalid state → idle untouched (fail-safe)', () => {
  assert.deepEqual(maybeAutoContinue('Stop', { ...IDLE }, null, true), IDLE);
  assert.deepEqual(maybeAutoContinue('Stop', { ...IDLE }, undefined, true), IDLE);
});

test('small-* and release-* execute phases also resume', () => {
  for (const phase of ['small-sprint', 'small-verify', 'release-gate', 'release-finalize']) {
    assert.ok(AUTO_CONTINUE_PHASES.has(phase));
    const r = maybeAutoContinue('Stop', { ...IDLE }, { current_phase: phase }, true);
    assert.ok(isResume(r), `${phase} should resume`);
  }
});
