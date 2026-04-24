import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ORIGINAL_HOME = process.env.HOME;
let TEST_HOME;

beforeEach(() => {
  TEST_HOME = mkdtempSync(join(tmpdir(), 'mpl-llm-scorer-test-'));
  process.env.HOME = TEST_HOME;
});

afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  if (TEST_HOME && existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

async function loadModule() {
  const url = new URL(`../dist/lib/llm-scorer.js?t=${Date.now()}-${Math.random()}`, import.meta.url);
  return import(url.href);
}

async function loadCacheModule() {
  const url = new URL(`../dist/lib/session-cache.js?t=${Date.now()}-${Math.random()}`, import.meta.url);
  return import(url.href);
}

describe('isSessionExpiredError (P1-3c)', () => {
  it('detects a 404 status on a thrown error', async () => {
    const mod = await loadModule();
    const err = Object.assign(new Error('Resource missing'), { status: 404 });
    assert.strictEqual(mod.isSessionExpiredError(err), true);
  });

  it('does not flag other HTTP statuses', async () => {
    const mod = await loadModule();
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    assert.strictEqual(mod.isSessionExpiredError(err), false);
    const err5xx = Object.assign(new Error('backend'), { status: 502 });
    assert.strictEqual(mod.isSessionExpiredError(err5xx), false);
  });

  it('matches "session not found" substring (case-insensitive)', async () => {
    const mod = await loadModule();
    assert.strictEqual(mod.isSessionExpiredError(new Error('Session not found')), true);
    assert.strictEqual(mod.isSessionExpiredError('session_not_found: session expired'), true);
    assert.strictEqual(mod.isSessionExpiredError(new Error('not_found_error: no such resource')), true);
  });

  it('handles plain string errors', async () => {
    const mod = await loadModule();
    assert.strictEqual(mod.isSessionExpiredError('No such session: sess_abc'), true);
  });

  it('handles structured error objects with embedded 404', async () => {
    const mod = await loadModule();
    const err = { error: { type: 'not_found_error', message: 'Session sess_x expired' } };
    assert.strictEqual(mod.isSessionExpiredError(err), true);
  });

  it('returns false on null, undefined, and unrelated errors', async () => {
    const mod = await loadModule();
    assert.strictEqual(mod.isSessionExpiredError(null), false);
    assert.strictEqual(mod.isSessionExpiredError(undefined), false);
    assert.strictEqual(mod.isSessionExpiredError(new Error('unrelated timeout')), false);
    assert.strictEqual(mod.isSessionExpiredError({ foo: 'bar' }), false);
  });
});

describe('scoreDimensions recovery flow (P1-3c)', () => {
  let PROJECT_DIR;

  beforeEach(() => {
    PROJECT_DIR = mkdtempSync(join(tmpdir(), 'mpl-proj-recovery-'));
    mkdirSync(join(PROJECT_DIR, '.mpl'), { recursive: true });
    writeFileSync(
      join(PROJECT_DIR, '.mpl', 'state.json'),
      JSON.stringify({ current_phase: 'mpl-ambiguity-resolve', pipeline_id: 'pipe-xyz' }),
    );
  });

  afterEach(() => {
    if (PROJECT_DIR && existsSync(PROJECT_DIR)) {
      rmSync(PROJECT_DIR, { recursive: true, force: true });
    }
  });

  function successEvent(sessionId = 'sess_fresh') {
    return {
      type: 'result',
      subtype: 'success',
      result: JSON.stringify({
        spec_completeness: { score: 0.9, justification: 'ok' },
        edge_case_coverage: { score: 0.9, justification: 'ok' },
        technical_decision: { score: 0.9, justification: 'ok' },
        acceptance_testability: { score: 0.9, justification: 'ok' },
        pp_conformance: { score: 0.9, justification: 'ok', conflicts: [], infeasible: [] },
      }),
      sessionId,
    };
  }

  function sessionExpiredErrorEvent() {
    return {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Session sess_stale not found (status: 404)'],
    };
  }

  function makeQueryFn(scripts, calls) {
    return function queryFn({ options }) {
      calls.push({ sessionId: options?.sessionId ?? null });
      const events = scripts[calls.length - 1] ?? [];
      return (async function* () {
        for (const ev of events) {
          if (ev.__throw) throw Object.assign(new Error(ev.message), ev.props ?? {});
          yield ev;
        }
      })();
    };
  }

  it('invalidates stale session + retries fresh when result event signals 404', async () => {
    const scorer = await loadModule();
    const cache = await loadCacheModule();

    // Seed cache with a stale session id. Use the real scorer prompt constants
    // by hitting persistSession directly — the scorer recomputes content_hash
    // internally so we must supply the same inputs both here and in the
    // scoreDimensions call.
    const pivot_points = 'PP-1: the thing';
    const user_responses = 'R1';
    // Pre-populate the cache with a stub entry keyed by whatever hash scorer
    // will compute. We cannot recompute without access to SCORING_PROMPT, so
    // we instead seed by running a first successful scoreDimensions call with
    // the real SDK stub, letting the scorer persist the session id itself.
    const calls = [];
    scorer.__testing.setQueryFn(makeQueryFn([[successEvent('sess_stale')]], calls));
    const first = await scorer.scoreDimensions({
      cwd: PROJECT_DIR, pivot_points, user_responses,
    });
    assert.strictEqual(first.spec_completeness.score, 0.9);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].sessionId, null, 'first call has no cached session id');

    // Second round: cache has sess_stale. SDK returns 404-error event on the
    // resumed call, then success on the retry (no sessionId).
    const calls2 = [];
    scorer.__testing.setQueryFn(makeQueryFn(
      [[sessionExpiredErrorEvent()], [successEvent('sess_new')]],
      calls2,
    ));
    const second = await scorer.scoreDimensions({
      cwd: PROJECT_DIR, pivot_points, user_responses,
    });
    assert.strictEqual(second.spec_completeness.score, 0.9);
    assert.strictEqual(calls2.length, 2, 'expected one failed resume + one fresh retry');
    assert.strictEqual(calls2[0].sessionId, 'sess_stale');
    assert.strictEqual(calls2[1].sessionId, null, 'retry must drop the stale sessionId');

    scorer.__testing.setQueryFn(null);
  });

  it('invalidates + retries on thrown 404 error', async () => {
    const scorer = await loadModule();

    // Seed cache via a first successful call.
    const pivot_points = 'PP-A';
    const user_responses = 'U';
    const seedCalls = [];
    scorer.__testing.setQueryFn(makeQueryFn([[successEvent('sess_will_die')]], seedCalls));
    await scorer.scoreDimensions({ cwd: PROJECT_DIR, pivot_points, user_responses });

    // Second run: resume throws 404, then fresh session succeeds.
    const recoveryCalls = [];
    scorer.__testing.setQueryFn(makeQueryFn(
      [
        [{ __throw: true, message: 'Session sess_will_die not found', props: { status: 404 } }],
        [successEvent('sess_recovered')],
      ],
      recoveryCalls,
    ));
    const result = await scorer.scoreDimensions({ cwd: PROJECT_DIR, pivot_points, user_responses });
    assert.strictEqual(result.edge_case_coverage.score, 0.9);
    assert.strictEqual(recoveryCalls.length, 2);
    assert.strictEqual(recoveryCalls[0].sessionId, 'sess_will_die');
    assert.strictEqual(recoveryCalls[1].sessionId, null);

    scorer.__testing.setQueryFn(null);
  });

  it('sets degraded=true when SDK is unavailable (fallback)', async () => {
    const scorer = await loadModule();
    scorer.__testing.setQueryFn(null);  // no query fn → real import attempt
    // Patch globalThis so the dynamic import fails predictably — easiest
    // approach: inject a query fn that throws synchronously to force the
    // catch-all fallback in the retry loop. Any non-session error that
    // exhausts retries ends in neutralResult('retry_exhausted').
    scorer.__testing.setQueryFn(() => {
      throw new Error('unrelated backend failure');
    });
    const result = await scorer.scoreDimensions({
      cwd: PROJECT_DIR,
      pivot_points: 'PP-degraded',
      user_responses: 'R',
    });
    assert.strictEqual(result.degraded, true);
    assert.strictEqual(result.degraded_reason, 'retry_exhausted');
    assert.strictEqual(result.spec_completeness.score, 0.5);
    scorer.__testing.setQueryFn(null);
  });

  it('omits degraded flag on successful scoring', async () => {
    const scorer = await loadModule();
    const calls = [];
    scorer.__testing.setQueryFn(makeQueryFn([[successEvent('sess_ok')]], calls));
    const result = await scorer.scoreDimensions({
      cwd: PROJECT_DIR,
      pivot_points: 'PP-healthy',
      user_responses: 'R',
    });
    assert.notStrictEqual(result.degraded, true);
    scorer.__testing.setQueryFn(null);
  });

  it('does not invalidate on non-session thrown errors (retries same session)', async () => {
    const scorer = await loadModule();

    const pivot_points = 'PP-B';
    const user_responses = 'U';
    const seedCalls = [];
    scorer.__testing.setQueryFn(makeQueryFn([[successEvent('sess_keep')]], seedCalls));
    await scorer.scoreDimensions({ cwd: PROJECT_DIR, pivot_points, user_responses });

    const calls = [];
    scorer.__testing.setQueryFn(makeQueryFn(
      [
        [{ __throw: true, message: 'rate limited', props: { status: 429 } }],
        [successEvent('sess_keep')],
      ],
      calls,
    ));
    const result = await scorer.scoreDimensions({ cwd: PROJECT_DIR, pivot_points, user_responses });
    assert.strictEqual(result.technical_decision.score, 0.9);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].sessionId, 'sess_keep');
    assert.strictEqual(calls[1].sessionId, 'sess_keep', 'non-404 must not drop the cached session');

    scorer.__testing.setQueryFn(null);
  });
});
