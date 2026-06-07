/**
 * Tests — hooks/lib/mpl-scheduler-failure-codes.mjs (Move #17 extension).
 *
 * The frozen Set grew from 5 → 11 to cover wave-reducer +
 * reconciliation error vocabulary. The public API
 * (`FAILURE_CODE_ALLOWLIST`, `isCanonicalFailureCode`) MUST remain
 * compatible — existing callers (#230 aggregator, finalize gate) still
 * iterate the Set and call `isCanonicalFailureCode(code)`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FAILURE_CODE_ALLOWLIST,
  isCanonicalFailureCode,
} from '../lib/mpl-scheduler-failure-codes.mjs';

describe('FAILURE_CODE_ALLOWLIST — v2 (Move #17)', () => {
  it('is a frozen Set', () => {
    assert.ok(FAILURE_CODE_ALLOWLIST instanceof Set);
    assert.ok(Object.isFrozen(FAILURE_CODE_ALLOWLIST));
  });

  it('size === 11 (5 legacy + 6 added)', () => {
    assert.equal(FAILURE_CODE_ALLOWLIST.size, 11);
  });

  it('preserves every #230 legacy code', () => {
    for (const code of [
      'worker_dispatch_error',
      'worktree_setup_error',
      'wave_execution_error',
      'merge_error',
      'unknown_runtime_error',
    ]) {
      assert.ok(FAILURE_CODE_ALLOWLIST.has(code), `legacy code missing: ${code}`);
      assert.equal(isCanonicalFailureCode(code), true);
    }
  });

  it('adds 6 Move #17 codes', () => {
    for (const code of [
      'stale_shard_base',
      'unknown_field_ownership',
      'merge_error:textual_conflict',
      'semantic_reentry_exhausted',
      'reconcile_required',
      'wave_reducer_unresolvable',
    ]) {
      assert.ok(FAILURE_CODE_ALLOWLIST.has(code), `move-17 code missing: ${code}`);
      assert.equal(isCanonicalFailureCode(code), true);
    }
  });

  it('isCanonicalFailureCode rejects unknown / non-string', () => {
    assert.equal(isCanonicalFailureCode(null), false);
    assert.equal(isCanonicalFailureCode(undefined), false);
    assert.equal(isCanonicalFailureCode(''), false);
    assert.equal(isCanonicalFailureCode(42), false);
    assert.equal(isCanonicalFailureCode('foo'), false);
    assert.equal(isCanonicalFailureCode('worker_dispatch_failed'), false); // close paraphrase
  });
});
