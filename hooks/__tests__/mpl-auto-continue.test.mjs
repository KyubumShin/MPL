/**
 * exp25 — cause-aware single-session auto-continue (Phase-2+ clean-stop driver).
 *
 * Without this, MPL's Stop hook idles the agent at every Phase-2+ boundary, so an
 * unattended run needs a second CLI nudging the first (the cmux harness). The pure
 * decideAutoContinue() converts a Phase-2+ idle Stop into {decision:'block'} so the
 * SAME session resumes — but routed by CAUSE (roadmap 02): normal progress resumes,
 * a blocked_hook routes to recover with a bounded per-block_code attempt streak then
 * escalates, a verification_hang surfaces + idles, and genuine blocks / out-of-scope
 * phases / opt-out are left untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAutoContinue, AUTO_CONTINUE_PHASES, RECOVER_CAP } from '../lib/auto-continue.mjs';

const IDLE = { continue: true, suppressOutput: true };
const isResume = (e) => e && e.decision === 'block' && /auto-continue/.test(e.reason || '') && !/recover/.test(e.reason || '');
const isRecover = (e) => e && e.decision === 'block' && /recover/.test(e.reason || '');

/* ───────────────────────── normal progress ───────────────────────── */

test('Phase-2+ execute clean-stop (default ON) → resume, no mutation', () => {
  for (const phase of ['phase2-sprint', 'phase3-gate', 'phase4-fix', 'phase5-finalize']) {
    const r = decideAutoContinue('Stop', { ...IDLE }, { current_phase: phase }, true);
    assert.ok(isResume(r.envelope), `${phase} should resume, got ${JSON.stringify(r.envelope)}`);
    assert.equal(r.mutation, null);
  }
});

test('SubagentStop is also auto-continued', () => {
  const r = decideAutoContinue('SubagentStop', { ...IDLE }, { current_phase: 'phase2-sprint' }, true);
  assert.ok(isResume(r.envelope));
});

test('normal progress clears a lingering recover streak', () => {
  const r = decideAutoContinue('Stop', { ...IDLE },
    { current_phase: 'phase2-sprint', auto_continue_recover: { code: 'x', attempts: 2 } }, true);
  assert.ok(isResume(r.envelope));
  assert.deepEqual(r.mutation, { auto_continue_recover: null }, 'should clear stale streak on progress');
});

/* ───────────────────────── scope / opt-out / terminal ───────────────────────── */

test('explicit opt-out (enabled=false) → idle untouched', () => {
  const r = decideAutoContinue('Stop', { ...IDLE }, { current_phase: 'phase2-sprint' }, false);
  assert.deepEqual(r.envelope, IDLE);
  assert.equal(r.mutation, null);
});

test('out-of-scope phases (interview/decompose/plan) → idle untouched', () => {
  for (const phase of ['mpl-init', 'mpl-decompose', 'mpl-ambiguity-resolve', 'phase1-plan', 'phase1a-research', 'phase1b-plan']) {
    const r = decideAutoContinue('Stop', { ...IDLE }, { current_phase: phase }, true);
    assert.deepEqual(r.envelope, IDLE, `${phase} must stay manual`);
  }
});

test('terminal phases (completed/cancelled) → idle untouched', () => {
  for (const phase of ['completed', 'cancelled']) {
    const r = decideAutoContinue('Stop', { ...IDLE }, { current_phase: phase }, true);
    assert.deepEqual(r.envelope, IDLE, `${phase} must not resume`);
  }
});

test('non-Stop events and missing state → idle untouched', () => {
  assert.deepEqual(decideAutoContinue('PreToolUse', { ...IDLE }, { current_phase: 'phase2-sprint' }, true).envelope, IDLE);
  assert.deepEqual(decideAutoContinue('Stop', { ...IDLE }, null, true).envelope, IDLE);
});

test('a real block the aggregate already decided is never overridden', () => {
  const block = { continue: false, decision: 'block', reason: 'I14: completion without gate evidence' };
  const r = decideAutoContinue('Stop', block, { current_phase: 'phase5-finalize' }, true);
  assert.deepEqual(r.envelope, block);
});

/* ───────────────────────── cause-aware: blocked_hook ───────────────────────── */

const blockedState = (attempts, code = 'decomposition_writer_violation') => ({
  current_phase: 'phase2-sprint',
  session_status: 'blocked_hook',
  blocked_by_hook: 'mpl-write-guard',
  blocked_phase: 'phase2-sprint',
  block_code: code,
  block_reason: 'Refused write to protected path.',
  resume_instruction: 'Dispatch via mpl-phase-runner; do not edit directly.',
  ...(attempts != null ? { auto_continue_recover: { code, attempts } } : {}),
});

test('blocked_hook (first time) → ROUTE TO RECOVER (not blind resume), streak=1', () => {
  const r = decideAutoContinue('Stop', { ...IDLE }, blockedState(null), true);
  assert.ok(isRecover(r.envelope), `expected recover routing, got ${JSON.stringify(r.envelope)}`);
  assert.match(r.envelope.reason, /RESOLVE THE BLOCK/);
  assert.match(r.envelope.reason, /decomposition_writer_violation/);
  assert.deepEqual(r.mutation, { auto_continue_recover: { code: 'decomposition_writer_violation', attempts: 1 } });
});

test('blocked_hook (same code, under cap) → recover again, streak increments', () => {
  const r = decideAutoContinue('Stop', { ...IDLE }, blockedState(1), true);
  assert.ok(isRecover(r.envelope));
  assert.equal(r.mutation.auto_continue_recover.attempts, 2);
});

test('blocked_hook (same code, AT cap) → ESCALATE: idle + systemMessage, no blind retry', () => {
  const r = decideAutoContinue('Stop', { ...IDLE }, blockedState(RECOVER_CAP), true);
  assert.equal(r.envelope.decision, undefined, 'must NOT keep auto-recovering at cap');
  assert.match(r.envelope.systemMessage, /HALTED/);
  assert.match(r.envelope.systemMessage, /mpl-resume/);
});

test('blocked_hook with a DIFFERENT code resets the streak (fresh recover budget)', () => {
  const st = blockedState(RECOVER_CAP, 'old_code');
  st.block_code = 'new_code'; // new block, stale streak is for old_code
  const r = decideAutoContinue('Stop', { ...IDLE }, st, true);
  assert.ok(isRecover(r.envelope), 'a new block_code must get a fresh recover attempt, not escalate');
  assert.deepEqual(r.mutation, { auto_continue_recover: { code: 'new_code', attempts: 1 } });
});

/* ───────────────────────── cause-aware: verification_hang ───────────────────────── */

test('verification_hang → surface + idle (does NOT power through a hang)', () => {
  const r = decideAutoContinue('Stop', { ...IDLE },
    { current_phase: 'phase2-sprint', session_status: 'verification_hang' }, true);
  assert.equal(r.envelope.decision, undefined, 'must not auto-continue past a hang');
  assert.match(r.envelope.systemMessage, /verification_hang/);
  assert.match(r.envelope.systemMessage, /mpl-resume/);
});

/* ───────────────────────── coverage ───────────────────────── */

test('small-* and release-* execute phases also resume', () => {
  for (const phase of ['small-sprint', 'small-verify', 'release-gate', 'release-finalize']) {
    assert.ok(AUTO_CONTINUE_PHASES.has(phase));
    assert.ok(isResume(decideAutoContinue('Stop', { ...IDLE }, { current_phase: phase }, true).envelope));
  }
});
