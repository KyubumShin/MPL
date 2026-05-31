/**
 * Tests — hooks/lib/policy/reconcile/* (Move #17).
 *
 * Validates the 4-bucket classifier, bounded re-entry policy, reconciler
 * verdict validator, and the top-level reconcileWave entrypoint.
 *
 * Bucket priority on multi-classification: T > C > S > X.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  BUCKETS,
  RECONCILE_FAILURE_CODES,
  classifyPair,
  classifyWave,
  decideReentry,
  reentryStatePatch,
  contractRefHash,
  REENTRY_CAP,
  validateReconcilerVerdict,
  verdictPathForWave,
  reconcileWave,
  RECONCILE_OUTCOMES,
} from '../lib/policy/reconcile/index.mjs';

function manifest({ phase_id, rank = 0, produces = [], requires = [], contract_refs = [] }) {
  return { phase_id, decomposition_rank: rank, produces, requires, contract_refs };
}

describe('manifest-diff — T (textual conflict)', () => {
  it('flags same path with different hashes when no co-edit permit', () => {
    const a = manifest({ phase_id: 'p1', rank: 1, produces: [{ path: 'src/a.ts', hash: 'h1' }] });
    const b = manifest({ phase_id: 'p2', rank: 2, produces: [{ path: 'src/a.ts', hash: 'h2' }] });
    const r = classifyPair(a, b);
    assert.equal(r.topBucket, BUCKETS.T);
    assert.equal(r.findings.T[0].path, 'src/a.ts');
  });

  it('clears T when decomposition.coEditPermitted returns true', () => {
    const a = manifest({ phase_id: 'p1', produces: [{ path: 'src/a.ts', hash: 'h1' }] });
    const b = manifest({ phase_id: 'p2', produces: [{ path: 'src/a.ts', hash: 'h2' }] });
    const r = classifyPair(a, b, { coEditPermitted: () => true });
    assert.equal(r.topBucket, null);
  });
});

describe('manifest-diff — S (symbol conflict)', () => {
  it('idempotent when signature_hash matches', () => {
    const a = manifest({ phase_id: 'p1', rank: 1, produces: [{ path: 'a.ts', hash: 'ha', exports: [{ name: 'foo', signature_hash: 'sig1' }] }] });
    const b = manifest({ phase_id: 'p2', rank: 2, produces: [{ path: 'b.ts', hash: 'hb', exports: [{ name: 'foo', signature_hash: 'sig1' }] }] });
    const r = classifyPair(a, b);
    assert.equal(r.topBucket, BUCKETS.S);
    assert.equal(r.findings.S[0].resolution, 'idempotent');
  });

  it('escalates to C when signature_hash differs', () => {
    const a = manifest({ phase_id: 'p1', rank: 1, produces: [{ path: 'a.ts', hash: 'ha', exports: [{ name: 'foo', signature_hash: 'sig1' }] }] });
    const b = manifest({ phase_id: 'p2', rank: 2, produces: [{ path: 'b.ts', hash: 'hb', exports: [{ name: 'foo', signature_hash: 'sig2' }] }] });
    const r = classifyPair(a, b);
    // C wins over S in priority.
    assert.equal(r.topBucket, BUCKETS.C);
    assert.ok(r.findings.C.some((c) => c.kind === 'symbol_signature_divergence'));
  });
});

describe('manifest-diff — C (contract conflict via shared contract_ref)', () => {
  it('flags same route divergence when contract_ref is shared', () => {
    const a = manifest({
      phase_id: 'p1', rank: 1,
      produces: [{ path: 'a.ts', hash: 'ha', routes: ['POST /users'] }],
      contract_refs: [{ contract_id: 'auth', clause: 'create-user' }],
    });
    const b = manifest({
      phase_id: 'p2', rank: 2,
      produces: [{ path: 'b.ts', hash: 'hb', routes: ['POST /users'] }],
      contract_refs: [{ contract_id: 'auth', clause: 'create-user' }],
    });
    const r = classifyPair(a, b);
    assert.equal(r.topBucket, BUCKETS.C);
    assert.ok(r.findings.C.some((c) => c.kind === 'route'));
  });
});

describe('manifest-diff — X (semantic divergence)', () => {
  it('fires only on shared contract_ref with disjoint paths/symbols', () => {
    const a = manifest({
      phase_id: 'p1', rank: 1,
      produces: [{ path: 'a.ts', hash: 'ha', exports: [{ name: 'foo', signature_hash: 's1' }] }],
      contract_refs: [{ contract_id: 'C1', clause: 'cl1' }],
    });
    const b = manifest({
      phase_id: 'p2', rank: 2,
      produces: [{ path: 'b.ts', hash: 'hb', exports: [{ name: 'bar', signature_hash: 's2' }] }],
      contract_refs: [{ contract_id: 'C1', clause: 'cl1' }],
    });
    const r = classifyPair(a, b);
    assert.equal(r.topBucket, BUCKETS.X);
    assert.equal(r.findings.X[0].contract_ref, 'C1:cl1');
  });
});

describe('reentry-policy — bounded cap=1', () => {
  it('allows first re-entry, denies second on same (wave, contract_ref)', () => {
    const finding = { phase_a: 'p1', phase_b: 'p2', contract_ref: 'C1:cl1' };
    const manifests = [
      { phase_id: 'p1', decomposition_rank: 1 },
      { phase_id: 'p2', decomposition_rank: 2 },
    ];
    const first = decideReentry({ state: { reconciler_reentries: {} }, waveId: '1:0', finding, manifests });
    assert.equal(first.allowed, true);
    assert.equal(first.winner_phase_id, 'p1');
    assert.equal(first.loser_phase_id, 'p2');

    const stateAfter = { reconciler_reentries: { '1:0': { [first.contract_ref_hash]: { count: 1 } } } };
    const second = decideReentry({ state: stateAfter, waveId: '1:0', finding, manifests });
    assert.equal(second.allowed, false);
    assert.equal(second.failure_code, 'semantic_reentry_exhausted');
  });

  it('contractRefHash is deterministic and short', () => {
    const h = contractRefHash({ contract_id: 'C1', clause: 'cl1' });
    assert.match(h, /^[0-9a-f]{16}$/);
  });

  it('reentryStatePatch shapes the writeState delta correctly', () => {
    const decision = { allowed: true, wave_id: '2:0', contract_ref_hash: 'abc', count: 1, winner_phase_id: 'p1', loser_phase_id: 'p2' };
    const patch = reentryStatePatch(decision);
    assert.deepEqual(patch, {
      reconciler_reentries: {
        '2:0': { 'abc': { count: 1, winner_phase_id: 'p1', loser_phase_id: 'p2' } },
      },
    });
  });
});

describe('reconciler-verdict-validator', () => {
  const validVerdict = {
    wave_id: '1:0',
    phase_pair: ['p1', 'p2'],
    decision: 'accept_producer',
    rationale: 'producer owns POST /users in contract auth.create-user',
    evidence_refs: [
      { kind: 'file', path: 'src/p1.ts', line: 42, hash: 'h1' },
      { kind: 'contract', contract_id: 'auth', clause: 'create-user' },
    ],
    produced_at: '2026-06-01T00:00:00Z',
  };

  it('accepts a well-formed verdict', () => {
    const v = validateReconcilerVerdict(validVerdict);
    assert.equal(v.valid, true);
    assert.deepEqual(v.errors, []);
  });

  it('rejects empty evidence_refs when decision != reject_both', () => {
    const v = validateReconcilerVerdict({ ...validVerdict, evidence_refs: [] });
    assert.equal(v.valid, false);
    assert.ok(v.errors.some((e) => /evidence_refs/.test(e)));
  });

  it('allows empty evidence_refs when decision == reject_both', () => {
    const v = validateReconcilerVerdict({ ...validVerdict, decision: 'reject_both', evidence_refs: [] });
    assert.equal(v.valid, true);
  });

  it('rejects unknown decision values', () => {
    const v = validateReconcilerVerdict({ ...validVerdict, decision: 'just_pick_one' });
    assert.equal(v.valid, false);
  });

  it('rejects file evidence_refs missing line', () => {
    const v = validateReconcilerVerdict({
      ...validVerdict,
      evidence_refs: [{ kind: 'file', path: 'p.ts' }],
    });
    assert.equal(v.valid, false);
  });
});

describe('reconcileWave — orchestrator', () => {
  let cwd;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'mpl-reconcile-test-')); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('outcome=clean when manifests have no conflicts', () => {
    const m = [
      manifest({ phase_id: 'p1', rank: 1, produces: [{ path: 'a.ts', hash: 'h1' }] }),
      manifest({ phase_id: 'p2', rank: 2, produces: [{ path: 'b.ts', hash: 'h2' }] }),
    ];
    const r = reconcileWave('1:0', cwd, { manifests: m, state: {} });
    assert.equal(r.outcome, RECONCILE_OUTCOMES.CLEAN);
    assert.equal(existsSync(join(cwd, '.mpl', 'signals', 'reconcile', 'wave-reconciliation.json')), true);
  });

  it('outcome=aborted with merge_error:textual_conflict on T finding', () => {
    const m = [
      manifest({ phase_id: 'p1', rank: 1, produces: [{ path: 'a.ts', hash: 'h1' }] }),
      manifest({ phase_id: 'p2', rank: 2, produces: [{ path: 'a.ts', hash: 'h2' }] }),
    ];
    const r = reconcileWave('1:0', cwd, { manifests: m, state: {} });
    assert.equal(r.outcome, RECONCILE_OUTCOMES.ABORTED);
    assert.equal(r.failure_code, RECONCILE_FAILURE_CODES.TEXTUAL_CONFLICT);
  });

  it('outcome=pending_verifier on C finding without verdict file', () => {
    const m = [
      manifest({
        phase_id: 'p1', rank: 1,
        produces: [{ path: 'a.ts', hash: 'ha', routes: ['POST /users'] }],
        contract_refs: [{ contract_id: 'auth', clause: 'create-user' }],
      }),
      manifest({
        phase_id: 'p2', rank: 2,
        produces: [{ path: 'b.ts', hash: 'hb', routes: ['POST /users'] }],
        contract_refs: [{ contract_id: 'auth', clause: 'create-user' }],
      }),
    ];
    const r = reconcileWave('1:0', cwd, { manifests: m, state: {} });
    assert.equal(r.outcome, RECONCILE_OUTCOMES.PENDING_VERIFIER);
  });

  it('outcome=reconciled on C finding with valid verdict file', () => {
    const m = [
      manifest({
        phase_id: 'p1', rank: 1,
        produces: [{ path: 'a.ts', hash: 'ha', routes: ['POST /users'] }],
        contract_refs: [{ contract_id: 'auth', clause: 'create-user' }],
      }),
      manifest({
        phase_id: 'p2', rank: 2,
        produces: [{ path: 'b.ts', hash: 'hb', routes: ['POST /users'] }],
        contract_refs: [{ contract_id: 'auth', clause: 'create-user' }],
      }),
    ];
    const verdict = {
      wave_id: '1:0',
      phase_pair: ['p1', 'p2'],
      decision: 'accept_producer',
      rationale: 'producer owns POST /users in auth.create-user',
      evidence_refs: [{ kind: 'contract', contract_id: 'auth', clause: 'create-user' }],
      produced_at: '2026-06-01T00:00:00Z',
    };
    mkdirSync(join(cwd, '.mpl', 'signals', 'reconcile'), { recursive: true });
    writeFileSync(verdictPathForWave(cwd, '1:0'), JSON.stringify(verdict));
    const r = reconcileWave('1:0', cwd, { manifests: m, state: {} });
    assert.equal(r.outcome, RECONCILE_OUTCOMES.RECONCILED);
  });

  it('outcome=reconciled on X via bounded re-entry; subsequent same finding aborts', () => {
    const m = [
      manifest({
        phase_id: 'p1', rank: 1,
        produces: [{ path: 'a.ts', hash: 'h1', exports: [{ name: 'foo', signature_hash: 's1' }] }],
        contract_refs: [{ contract_id: 'C1', clause: 'cl1' }],
      }),
      manifest({
        phase_id: 'p2', rank: 2,
        produces: [{ path: 'b.ts', hash: 'h2', exports: [{ name: 'bar', signature_hash: 's2' }] }],
        contract_refs: [{ contract_id: 'C1', clause: 'cl1' }],
      }),
    ];
    const r1 = reconcileWave('1:0', cwd, { manifests: m, state: {} });
    assert.equal(r1.outcome, RECONCILE_OUTCOMES.RECONCILED);
    assert.ok(r1.state_patches.length >= 1);

    // Persist the reentry, then re-classify — second X must abort.
    const hash = r1.state_patches[0].reconciler_reentries['1:0'];
    const stateAfter = { reconciler_reentries: { '1:0': hash } };
    const r2 = reconcileWave('1:0', cwd, { manifests: m, state: stateAfter });
    assert.equal(r2.outcome, RECONCILE_OUTCOMES.ABORTED);
    assert.equal(r2.failure_code, 'semantic_reentry_exhausted');
  });
});
