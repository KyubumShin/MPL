/**
 * Tests — hooks/lib/state/shard-writer.mjs (Move #17).
 *
 * Atomic envelope writer for per-phase RFC-6902 shards. Validates:
 *   - wave_id / phase_id / base_sha format guards
 *   - env.MPL_PHASE_ID mismatch refusal (engine front-door contract)
 *   - RFC-6902 op vocabulary + path discipline
 *   - engine-only / reducer-only path REJECTION (defense-in-depth before
 *     reducer's field-ownership matrix)
 *   - invariant_claims I1..I13 + 'ok'|'na' shape
 *   - on-disk envelope frozen with schema_version=1, producer info,
 *     contract_amend_request null by default
 *   - atomic mode 0o600 via temp+rename
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  writeShard,
  sha256OfState,
  SHARD_ENVELOPE_SCHEMA_VERSION,
  SHARD_DIR,
  ShardPhaseIdMismatchError,
  ShardEnvelopeInvalidError,
} from '../lib/state/shard-writer.mjs';

const VALID_SHA = 'a'.repeat(64);

function freshTmp() {
  return mkdtempSync(join(tmpdir(), 'mpl-shard-test-'));
}

function basePatch() {
  return [{ op: 'replace', path: '/gate_results/hard1_baseline', value: { command: 'npm test', exit_code: 0 } }];
}
function baseClaims() { return { I5: 'ok', I6: 'ok', I12: 'ok' }; }

describe('writeShard — happy path', () => {
  let cwd;
  beforeEach(() => { cwd = freshTmp(); delete process.env.MPL_PHASE_ID; });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('writes envelope at .mpl/state.shards/<waveId>/<phaseId>.patch.json', () => {
    const out = writeShard(cwd, '1:0', 'phase-3', basePatch(), baseClaims(), VALID_SHA);
    assert.ok(out.endsWith('.mpl/state.shards/1:0/phase-3.patch.json'));
    assert.ok(existsSync(out));
  });

  it('freezes schema_version=1 + wave_id + phase_id + base_sha + patches + invariant_claims', () => {
    const out = writeShard(cwd, '2:1', 'phase-7', basePatch(), baseClaims(), VALID_SHA,
      { decompositionRank: 12, producer: { execution_context_id: 'ctx-1', slot_id: 0, worktree_root: '/wt/slot-0' } });
    const env = JSON.parse(readFileSync(out, 'utf-8'));
    assert.equal(env.schema_version, SHARD_ENVELOPE_SCHEMA_VERSION);
    assert.equal(env.wave_id, '2:1');
    assert.equal(env.phase_id, 'phase-7');
    assert.equal(env.base_sha, VALID_SHA);
    assert.equal(env.decomposition_rank, 12);
    assert.deepEqual(env.producer, { execution_context_id: 'ctx-1', slot_id: 0, worktree_root: '/wt/slot-0' });
    assert.deepEqual(env.invariant_claims, baseClaims());
    assert.equal(env.contract_amend_request, null);
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(env.produced_at));
  });

  it('writes with mode 0o600 (private)', () => {
    const out = writeShard(cwd, '1:0', 'phase-3', basePatch(), baseClaims(), VALID_SHA);
    const mode = statSync(out).mode & 0o777;
    // umask can mask bits; the file MUST NOT be world-readable.
    assert.equal(mode & 0o077, 0, `expected private mode, got ${mode.toString(8)}`);
  });
});

describe('writeShard — guards', () => {
  let cwd;
  beforeEach(() => { cwd = freshTmp(); delete process.env.MPL_PHASE_ID; });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); delete process.env.MPL_PHASE_ID; });

  it('throws ShardPhaseIdMismatchError when env.MPL_PHASE_ID disagrees', () => {
    process.env.MPL_PHASE_ID = 'phase-4';
    assert.throws(
      () => writeShard(cwd, '1:0', 'phase-3', basePatch(), baseClaims(), VALID_SHA),
      ShardPhaseIdMismatchError,
    );
  });

  it('accepts when env.MPL_PHASE_ID matches', () => {
    process.env.MPL_PHASE_ID = 'phase-3';
    const out = writeShard(cwd, '1:0', 'phase-3', basePatch(), baseClaims(), VALID_SHA);
    assert.ok(existsSync(out));
  });

  it('rejects invalid wave_id format', () => {
    assert.throws(
      () => writeShard(cwd, 'tier1-wave0', 'phase-3', basePatch(), baseClaims(), VALID_SHA),
      ShardEnvelopeInvalidError,
    );
  });

  it('rejects non-hex base_sha', () => {
    assert.throws(
      () => writeShard(cwd, '1:0', 'phase-3', basePatch(), baseClaims(), 'not-a-sha'),
      ShardEnvelopeInvalidError,
    );
  });

  it('rejects unknown RFC-6902 op', () => {
    const bad = [{ op: 'patch', path: '/foo', value: 1 }];
    assert.throws(
      () => writeShard(cwd, '1:0', 'phase-3', bad, baseClaims(), VALID_SHA),
      ShardEnvelopeInvalidError,
    );
  });

  it('rejects engine-only path (pipeline_id)', () => {
    const bad = [{ op: 'replace', path: '/pipeline_id', value: 'forged' }];
    assert.throws(
      () => writeShard(cwd, '1:0', 'phase-3', bad, baseClaims(), VALID_SHA),
      ShardEnvelopeInvalidError,
    );
  });

  it('rejects engine-only path (fix_loop_count)', () => {
    const bad = [{ op: 'replace', path: '/fix_loop_count', value: 99 }];
    assert.throws(
      () => writeShard(cwd, '1:0', 'phase-3', bad, baseClaims(), VALID_SHA),
      ShardEnvelopeInvalidError,
    );
  });

  it('rejects reducer-only path (running / waves_in_flight / phase_lifecycle)', () => {
    for (const path of ['/running', '/waves_in_flight', '/phase_lifecycle']) {
      assert.throws(
        () => writeShard(cwd, '1:0', 'phase-3', [{ op: 'add', path, value: [] }], baseClaims(), VALID_SHA),
        ShardEnvelopeInvalidError,
        `expected reject for ${path}`,
      );
    }
  });

  it('rejects invariant claims with non-I1..I13 keys', () => {
    assert.throws(
      () => writeShard(cwd, '1:0', 'phase-3', basePatch(), { Q9: 'ok' }, VALID_SHA),
      ShardEnvelopeInvalidError,
    );
  });

  it('rejects invariant claims with values other than ok|na', () => {
    assert.throws(
      () => writeShard(cwd, '1:0', 'phase-3', basePatch(), { I5: 'maybe' }, VALID_SHA),
      ShardEnvelopeInvalidError,
    );
  });
});

describe('sha256OfState', () => {
  it('produces stable 64-char hex', async () => {
    const a = await sha256OfState({ a: 1 });
    const b = await sha256OfState({ a: 1 });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });
  it('differs for different inputs', async () => {
    const a = await sha256OfState({ a: 1 });
    const b = await sha256OfState({ a: 2 });
    assert.notEqual(a, b);
  });
  it('handles null', async () => {
    const a = await sha256OfState(null);
    assert.match(a, /^[0-9a-f]{64}$/);
  });
});
