import { afterEach, before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// session-cache.ts captures `homedir()` at import time into a module-scoped
// CACHE_DIR constant, so we cannot swap HOME per test once the module has
// loaded. Set TEST_HOME ONCE before any imports, then rely on unique cwd
// paths per test + explicit cache resets in beforeEach to avoid cross-test
// pollution.
const ORIGINAL_HOME = process.env.HOME;
const TEST_HOME = mkdtempSync(join(tmpdir(), 'mpl-agent-sdk-query-test-'));
process.env.HOME = TEST_HOME;

before(() => {
  process.env.HOME = TEST_HOME;
});

after(() => {
  process.env.HOME = ORIGINAL_HOME;
  if (TEST_HOME && existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

/** Wipe the shared sessions.json between tests to prevent cross-test bleed. */
function resetSessionCache() {
  const cacheFile = join(TEST_HOME, '.mpl', 'cache', 'sessions.json');
  if (existsSync(cacheFile)) rmSync(cacheFile);
}

beforeEach(() => {
  resetSessionCache();
});

// Import modules canonically (no ?t= query suffix) so all callers share the
// same agent-sdk-query module instance. Otherwise `setQueryFn` on a `?t=`
// instance would not affect the canonical module that classifier/diagnoser
// actually import. Tests reset global state in afterEach via setQueryFn(null)
// and fresh HOME dirs — so sharing a single module instance is safe.
async function loadModule() {
  return import('../dist/lib/agent-sdk-query.js');
}

async function loadCacheModule() {
  return import('../dist/lib/session-cache.js');
}

async function loadClassifierModule() {
  return import('../dist/lib/feature-classifier.js');
}

async function loadDiagnoserModule() {
  return import('../dist/lib/e2e-diagnoser.js');
}

async function loadScorerModule() {
  return import('../dist/lib/llm-scorer.js');
}

function successEvent(sessionId = 'sess_ok', payload = { ok: true }) {
  return {
    type: 'result',
    subtype: 'success',
    result: JSON.stringify(payload),
    sessionId,
  };
}

function sessionExpiredEvent() {
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

describe('isSessionExpiredError (P2-7 moved from llm-scorer)', () => {
  it('exported from agent-sdk-query', async () => {
    const mod = await loadModule();
    assert.strictEqual(mod.isSessionExpiredError(Object.assign(new Error('x'), { status: 404 })), true);
    assert.strictEqual(mod.isSessionExpiredError('session_not_found: expired'), true);
    assert.strictEqual(mod.isSessionExpiredError(new Error('unrelated')), false);
  });

  it('re-exported for backward compatibility from llm-scorer', async () => {
    const scorer = await loadScorerModule();
    assert.strictEqual(typeof scorer.isSessionExpiredError, 'function');
    assert.strictEqual(scorer.isSessionExpiredError(Object.assign(new Error('x'), { status: 404 })), true);
  });
});

describe('runCachedQuery', () => {
  it('returns sdk_unavailable when no SDK injected and no module available', async () => {
    // No setQueryFn call → real import will be attempted. Since the real
    // SDK is installed in node_modules, this test validates the degraded
    // path by injecting a thrower instead.
    const mod = await loadModule();
    mod.__testing.setQueryFn(() => {
      throw new Error('induced failure for retry_exhausted');
    });
    const r = await mod.runCachedQuery(
      {
        cwd: '/tmp/doesnotmatter',
        kind: 'test',
        pipeline_id: 'p',
        cache_input: 'x',
        system_prompt: 'sys',
        full_prompt: 'prompt',
      },
      () => null,
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.degraded, true);
    assert.strictEqual(r.reason, 'retry_exhausted');
    mod.__testing.setQueryFn(null);
  });

  it('persists session id on success; resumes on next call', async () => {
    const mod = await loadModule();
    const calls1 = [];
    mod.__testing.setQueryFn(makeQueryFn([[successEvent('sess_1', { value: 42 })]], calls1));
    const r1 = await mod.runCachedQuery(
      {
        cwd: '/tmp/proj-persist',
        kind: 'test_kind',
        pipeline_id: 'p-1',
        cache_input: 'stable-prefix',
        system_prompt: 'sys',
        full_prompt: 'one',
      },
      (text) => JSON.parse(text),
    );
    assert.strictEqual(r1.ok, true);
    assert.deepStrictEqual(r1.value, { value: 42 });
    assert.strictEqual(calls1[0].sessionId, null);

    // Second call uses the persisted session id.
    const calls2 = [];
    mod.__testing.setQueryFn(makeQueryFn([[successEvent('sess_1', { value: 99 })]], calls2));
    const r2 = await mod.runCachedQuery(
      {
        cwd: '/tmp/proj-persist',
        kind: 'test_kind',
        pipeline_id: 'p-1',
        cache_input: 'stable-prefix',
        system_prompt: 'sys',
        full_prompt: 'two',
      },
      (text) => JSON.parse(text),
    );
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(calls2[0].sessionId, 'sess_1');
    mod.__testing.setQueryFn(null);
  });

  it('invalidates + retries on result-level 404 signature', async () => {
    const mod = await loadModule();
    const seed = [];
    mod.__testing.setQueryFn(makeQueryFn([[successEvent('sess_stale')]], seed));
    await mod.runCachedQuery(
      {
        cwd: '/tmp/proj-recover',
        kind: 'test_kind',
        pipeline_id: 'p-1',
        cache_input: 'stable-prefix',
        system_prompt: 'sys',
        full_prompt: 'one',
      },
      (text) => JSON.parse(text),
    );

    const recovery = [];
    mod.__testing.setQueryFn(makeQueryFn(
      [[sessionExpiredEvent()], [successEvent('sess_fresh', { recovered: true })]],
      recovery,
    ));
    const r = await mod.runCachedQuery(
      {
        cwd: '/tmp/proj-recover',
        kind: 'test_kind',
        pipeline_id: 'p-1',
        cache_input: 'stable-prefix',
        system_prompt: 'sys',
        full_prompt: 'two',
      },
      (text) => JSON.parse(text),
    );
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.value, { recovered: true });
    assert.strictEqual(recovery.length, 2);
    assert.strictEqual(recovery[0].sessionId, 'sess_stale');
    assert.strictEqual(recovery[1].sessionId, null);
    mod.__testing.setQueryFn(null);
  });

  it('invalidates + retries on thrown 404', async () => {
    const mod = await loadModule();
    const seed = [];
    mod.__testing.setQueryFn(makeQueryFn([[successEvent('sess_will_die')]], seed));
    await mod.runCachedQuery(
      {
        cwd: '/tmp/proj-thrown',
        kind: 'test_kind',
        pipeline_id: 'p-1',
        cache_input: 'stable-prefix',
        system_prompt: 'sys',
        full_prompt: 'one',
      },
      (text) => JSON.parse(text),
    );

    const recovery = [];
    mod.__testing.setQueryFn(makeQueryFn(
      [
        [{ __throw: true, message: 'Session sess_will_die not found', props: { status: 404 } }],
        [successEvent('sess_recovered')],
      ],
      recovery,
    ));
    const r = await mod.runCachedQuery(
      {
        cwd: '/tmp/proj-thrown',
        kind: 'test_kind',
        pipeline_id: 'p-1',
        cache_input: 'stable-prefix',
        system_prompt: 'sys',
        full_prompt: 'two',
      },
      (text) => JSON.parse(text),
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(recovery.length, 2);
    assert.strictEqual(recovery[0].sessionId, 'sess_will_die');
    assert.strictEqual(recovery[1].sessionId, null);
    mod.__testing.setQueryFn(null);
  });

  it('does not invalidate on non-session thrown errors (keeps resuming)', async () => {
    const mod = await loadModule();
    const seed = [];
    mod.__testing.setQueryFn(makeQueryFn([[successEvent('sess_keep')]], seed));
    await mod.runCachedQuery(
      {
        cwd: '/tmp/proj-rate',
        kind: 'test_kind',
        pipeline_id: 'p-1',
        cache_input: 'stable-prefix',
        system_prompt: 'sys',
        full_prompt: 'one',
      },
      (text) => JSON.parse(text),
    );

    const calls = [];
    mod.__testing.setQueryFn(makeQueryFn(
      [
        [{ __throw: true, message: 'rate limited', props: { status: 429 } }],
        [successEvent('sess_keep')],
      ],
      calls,
    ));
    const r = await mod.runCachedQuery(
      {
        cwd: '/tmp/proj-rate',
        kind: 'test_kind',
        pipeline_id: 'p-1',
        cache_input: 'stable-prefix',
        system_prompt: 'sys',
        full_prompt: 'two',
      },
      (text) => JSON.parse(text),
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].sessionId, 'sess_keep');
    assert.strictEqual(calls[1].sessionId, 'sess_keep');
    mod.__testing.setQueryFn(null);
  });

  it('segregates cache entries by kind — classifier and scorer coexist', async () => {
    const mod = await loadModule();
    const cache = await loadCacheModule();

    // Persist a scoring session
    const seedA = [];
    mod.__testing.setQueryFn(makeQueryFn([[successEvent('sess_score')]], seedA));
    await mod.runCachedQuery(
      {
        cwd: '/tmp/proj-kinds',
        kind: 'ambiguity',
        pipeline_id: 'p-1',
        cache_input: 'scoring-prefix',
        system_prompt: 'sys',
        full_prompt: 'x',
      },
      (text) => JSON.parse(text),
    );

    // Persist a classifier session in the same project
    const seedB = [];
    mod.__testing.setQueryFn(makeQueryFn([[successEvent('sess_classify')]], seedB));
    await mod.runCachedQuery(
      {
        cwd: '/tmp/proj-kinds',
        kind: 'classify_scope',
        pipeline_id: 'p-1',
        cache_input: 'classifier-prefix',
        system_prompt: 'sys',
        full_prompt: 'x',
      },
      (text) => JSON.parse(text),
    );

    // Each kind resolves independently
    const scoringHash = cache.computeContentHash('scoring-prefix');
    const classifierHash = cache.computeContentHash('classifier-prefix');
    assert.strictEqual(
      cache.lookupSession({ cwd: '/tmp/proj-kinds', kind: 'ambiguity', pipeline_id: 'p-1', content_hash: scoringHash }),
      'sess_score',
    );
    assert.strictEqual(
      cache.lookupSession({ cwd: '/tmp/proj-kinds', kind: 'classify_scope', pipeline_id: 'p-1', content_hash: classifierHash }),
      'sess_classify',
    );
    mod.__testing.setQueryFn(null);
  });
});

describe('P2-7 integration: classifier + diagnoser reuse sessions', () => {
  let PROJECT_DIR;

  beforeEach(() => {
    PROJECT_DIR = mkdtempSync(join(tmpdir(), 'mpl-p2-7-int-'));
    mkdirSync(join(PROJECT_DIR, '.mpl'), { recursive: true });
    writeFileSync(
      join(PROJECT_DIR, '.mpl', 'state.json'),
      JSON.stringify({ current_phase: 'phase5-finalize', pipeline_id: 'p2-7-test' }),
    );
  });

  afterEach(() => {
    if (PROJECT_DIR && existsSync(PROJECT_DIR)) {
      rmSync(PROJECT_DIR, { recursive: true, force: true });
    }
  });

  it('classifyFeatureScope persists + resumes session across calls', async () => {
    const sdk = await loadModule();
    const classifier = await loadClassifierModule();

    const successPayload = {
      user_cases: [{ id: 'UC-01', title: 't', user_delta: '', priority: 'P0', status: 'included', covers_pp: ['PP-1'] }],
      deferred: [],
      cut: [],
      scenarios: [],
      pp_conflict: [],
      ambiguity_hints: [],
      next_question: null,
      convergence: true,
    };

    // First call — no cached session
    const calls1 = [];
    sdk.__testing.setQueryFn(makeQueryFn([[successEvent('sess_classify_A', successPayload)]], calls1));
    const r1 = await classifier.classifyFeatureScope(
      { spec_text: 'spec', pivot_points: 'PP-1: foo', user_responses: 'round 1', round: 1 },
      { cwd: PROJECT_DIR },
    );
    assert.strictEqual(r1.convergence, true);
    assert.strictEqual(calls1[0].sessionId, null);

    // Second call with same pivot_points + spec_text → cache hits
    const calls2 = [];
    sdk.__testing.setQueryFn(makeQueryFn([[successEvent('sess_classify_A', successPayload)]], calls2));
    const r2 = await classifier.classifyFeatureScope(
      { spec_text: 'spec', pivot_points: 'PP-1: foo', user_responses: 'round 2', round: 2 },
      { cwd: PROJECT_DIR },
    );
    assert.strictEqual(r2.convergence, true);
    assert.strictEqual(calls2[0].sessionId, 'sess_classify_A', 'round 2 must resume session A');
    sdk.__testing.setQueryFn(null);
  });

  it('diagnoseE2EFailure persists + resumes session across calls', async () => {
    const sdk = await loadModule();
    const diagnoser = await loadDiagnoserModule();

    const diagPayload = {
      classification: 'B',
      root_cause: 'assertion mismatch',
      fix_strategy: 'update test',
      iter_hint: 1,
      trace_excerpt: '...',
      append_phases: [],
      confidence: 0.8,
    };

    const scenariosYaml = 'scenarios:\n  - id: E2E-01\n    test_command: pytest';
    const userContractMd = 'user_cases:\n  - id: UC-01';
    const decompYaml = 'phases:\n  - id: phase-1';

    const calls1 = [];
    sdk.__testing.setQueryFn(makeQueryFn([[successEvent('sess_diag_A', diagPayload)]], calls1));
    const r1 = await diagnoser.diagnoseE2EFailure(
      {
        scenarios: scenariosYaml,
        e2e_results: '{"E2E-01": {"exit_code": 1}}',
        trace_excerpt: 'FAIL',
        user_contract: userContractMd,
        decomposition: decompYaml,
        prev_iter: 0,
      },
      { cwd: PROJECT_DIR },
    );
    assert.strictEqual(r1.classification, 'B');
    assert.strictEqual(calls1[0].sessionId, null);

    // Second call with same stable prefix (scenarios + user_contract + decomposition)
    // but different trace_excerpt + e2e_results → cache must hit.
    const calls2 = [];
    sdk.__testing.setQueryFn(makeQueryFn([[successEvent('sess_diag_A', diagPayload)]], calls2));
    const r2 = await diagnoser.diagnoseE2EFailure(
      {
        scenarios: scenariosYaml,
        e2e_results: '{"E2E-01": {"exit_code": 2}}',
        trace_excerpt: 'DIFFERENT TRACE',
        user_contract: userContractMd,
        decomposition: decompYaml,
        prev_iter: 1,
      },
      { cwd: PROJECT_DIR },
    );
    assert.strictEqual(r2.classification, 'B');
    assert.strictEqual(calls2[0].sessionId, 'sess_diag_A', 'iter 2 must resume session A (per-call inputs excluded from hash)');
    sdk.__testing.setQueryFn(null);
  });

  it('classifier and diagnoser sessions do not collide in the cache', async () => {
    const sdk = await loadModule();
    const classifier = await loadClassifierModule();
    const diagnoser = await loadDiagnoserModule();
    const cache = await loadCacheModule();

    const classifyPayload = {
      user_cases: [], deferred: [], cut: [], scenarios: [], pp_conflict: [], ambiguity_hints: [],
      next_question: null, convergence: true,
    };
    const diagPayload = {
      classification: 'D', root_cause: 'x', fix_strategy: 'y',
      iter_hint: 0, trace_excerpt: '', append_phases: [], confidence: 0.3,
    };

    const cCalls = [];
    sdk.__testing.setQueryFn(makeQueryFn([[successEvent('sess_c', classifyPayload)]], cCalls));
    await classifier.classifyFeatureScope(
      { spec_text: 's', pivot_points: 'PP-1', user_responses: 'r', round: 1 },
      { cwd: PROJECT_DIR },
    );

    const dCalls = [];
    sdk.__testing.setQueryFn(makeQueryFn([[successEvent('sess_d', diagPayload)]], dCalls));
    await diagnoser.diagnoseE2EFailure(
      { scenarios: 'sc', e2e_results: 'er', trace_excerpt: '', user_contract: 'uc', decomposition: 'dc', prev_iter: 0 },
      { cwd: PROJECT_DIR },
    );

    // Both entries coexist in the cache under different kind buckets.
    const cachePath = join(TEST_HOME, '.mpl', 'cache', 'sessions.json');
    const raw = JSON.parse(readFileSync(cachePath, 'utf-8'));
    assert.ok(raw.sessions[PROJECT_DIR].classify_scope, 'classifier entry');
    assert.ok(raw.sessions[PROJECT_DIR].e2e_diagnose, 'diagnoser entry');
    assert.strictEqual(raw.sessions[PROJECT_DIR].classify_scope.session_id, 'sess_c');
    assert.strictEqual(raw.sessions[PROJECT_DIR].e2e_diagnose.session_id, 'sess_d');
    sdk.__testing.setQueryFn(null);
  });
});
