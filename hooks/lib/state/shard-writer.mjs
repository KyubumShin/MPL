/**
 * MPL v2 L1 — shard writer (Move #17).
 *
 * Per-phase RFC-6902 patch envelope writer that NEVER touches `.mpl/state.json`.
 * Workers write their proposed mutations to a per-wave / per-phase shard file
 * under `.mpl/state.shards/<waveId>/<phaseId>.patch.json`; the (future)
 * `wave-reducer` collapses those shards through `writer.mjs#writeState` —
 * which remains the SOLE owner of `state.json` on disk (H8 fail-closed,
 * atomic temp+rename, RUNBOOK chain, I5 lockstep).
 *
 * Atomic write contract mirrors `writer.mjs` C2: write to
 * `.state-<rand>.tmp` with mode 0o600, then `renameSync` into place.
 *
 * Field-ownership guards (defense-in-depth BEFORE the reducer):
 *   - `engine_only` paths (pipeline_id | session_status | current_phase |
 *     schema_version | started_at | finalize_done | ...) are rejected at
 *     write time — workers cannot mutate them; the engine front-door
 *     route_to_phase contract owns them.
 *   - `/running`, `/waves_in_flight`, `/phase_lifecycle` are wave-level
 *     and owned by the reducer / scheduler — rejected.
 *
 * Phase-id contract (Move #16):
 *   - `phaseId` arg MUST equal `envelope.phase_id` AND MUST equal
 *     `process.env.MPL_PHASE_ID` when set. A mismatch raises
 *     `ShardPhaseIdMismatchError` so a worker running under one
 *     ExecutionContext cannot publish a shard for an unrelated phase.
 */

import { existsSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';

export const SHARD_ENVELOPE_SCHEMA_VERSION = 1;
export const SHARD_DIR = join('.mpl', 'state.shards');

// ---------------------------------------------------------------------------
// Errors (engine recovers — never silently merges or writes a bad shard)
// ---------------------------------------------------------------------------

export class ShardPhaseIdMismatchError extends Error {
  constructor({ expected, envelope, env }) {
    super(
      `shard phase_id mismatch — caller=${expected}, envelope=${envelope}, env.MPL_PHASE_ID=${env ?? '<unset>'}.`
    );
    this.name = 'ShardPhaseIdMismatchError';
    this.expected = expected;
    this.envelope = envelope;
    this.env = env;
  }
}

export class ShardEnvelopeInvalidError extends Error {
  constructor(reason, ctx = {}) {
    super(`shard envelope invalid — ${reason}`);
    this.name = 'ShardEnvelopeInvalidError';
    this.reason = reason;
    Object.assign(this, ctx);
  }
}

export class ShardWriteIOError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ShardWriteIOError';
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Path ownership — defense-in-depth path-segment classifier
// ---------------------------------------------------------------------------

/**
 * Engine-only top-level fields. ANY shard patch whose JSON Pointer path
 * begins at one of these root segments is rejected. These mirror the
 * `state.merge_policy.<field>: engine_only` entries in mpl.config.yaml
 * (kept here as defense-in-depth — never trust config alone).
 */
const ENGINE_ONLY_ROOTS = new Set([
  'pipeline_id',
  'session_status',
  'current_phase',
  'schema_version',
  'started_at',
  'finalize_done',
  'finalized_at',
  'completed_at',
  'blocked_by_hook',
  'blocked_phase',
  'blocked_artifact',
  'block_code',
  'block_reason',
  'resume_instruction',
  'retry_context',
  'blocked_at',
  'current_cut_id',
  'fix_loop_count',
]);

/**
 * Reducer-owned wave-level top-level fields. Shards cannot patch them.
 */
const REDUCER_ONLY_ROOTS = new Set([
  'running',
  'waves_in_flight',
  'phase_lifecycle',
]);

const VALID_RFC6902_OPS = new Set(['add', 'remove', 'replace', 'move', 'copy', 'test']);

function firstSegment(pathStr) {
  if (typeof pathStr !== 'string') return null;
  if (!pathStr.startsWith('/')) return null;
  const rest = pathStr.slice(1);
  const slash = rest.indexOf('/');
  const seg = slash >= 0 ? rest.slice(0, slash) : rest;
  // un-escape JSON Pointer (RFC 6901)
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}

function assertPathOwnership(patches, { phaseId }) {
  if (!Array.isArray(patches)) {
    throw new ShardEnvelopeInvalidError('patches[] must be an array', { phase_id: phaseId });
  }
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i];
    if (!p || typeof p !== 'object') {
      throw new ShardEnvelopeInvalidError(`patches[${i}] must be an object`, { phase_id: phaseId });
    }
    if (!VALID_RFC6902_OPS.has(p.op)) {
      throw new ShardEnvelopeInvalidError(`patches[${i}].op '${p.op}' not in RFC-6902 vocabulary`, { phase_id: phaseId });
    }
    if (typeof p.path !== 'string' || !p.path.startsWith('/')) {
      throw new ShardEnvelopeInvalidError(`patches[${i}].path must be a JSON Pointer rooted at state.json (start with '/')`, { phase_id: phaseId });
    }
    const root = firstSegment(p.path);
    if (root && ENGINE_ONLY_ROOTS.has(root)) {
      throw new ShardEnvelopeInvalidError(
        `patches[${i}].path '${p.path}' targets engine-only field '${root}' — workers cannot mutate it`,
        { phase_id: phaseId, field: root }
      );
    }
    if (root && REDUCER_ONLY_ROOTS.has(root)) {
      throw new ShardEnvelopeInvalidError(
        `patches[${i}].path '${p.path}' targets reducer-owned field '${root}' — owned by wave-reducer / scheduler`,
        { phase_id: phaseId, field: root }
      );
    }
    if (p.op === 'move' || p.op === 'copy') {
      if (typeof p.from !== 'string' || !p.from.startsWith('/')) {
        throw new ShardEnvelopeInvalidError(`patches[${i}].from required for op=${p.op}`, { phase_id: phaseId });
      }
      const fromRoot = firstSegment(p.from);
      if (fromRoot && (ENGINE_ONLY_ROOTS.has(fromRoot) || REDUCER_ONLY_ROOTS.has(fromRoot))) {
        throw new ShardEnvelopeInvalidError(
          `patches[${i}].from '${p.from}' targets engine/reducer-owned field '${fromRoot}'`,
          { phase_id: phaseId, field: fromRoot }
        );
      }
    }
  }
}

function assertInvariantClaims(claims, { phaseId }) {
  if (!claims || typeof claims !== 'object') {
    throw new ShardEnvelopeInvalidError('invariantClaims must be an object', { phase_id: phaseId });
  }
  for (const [k, v] of Object.entries(claims)) {
    if (!/^I([1-9]|1[0-3])$/.test(k)) {
      throw new ShardEnvelopeInvalidError(`invariantClaims key '${k}' must be I1..I13`, { phase_id: phaseId });
    }
    if (v !== 'ok' && v !== 'na') {
      throw new ShardEnvelopeInvalidError(`invariantClaims[${k}] must be 'ok' or 'na' (got ${JSON.stringify(v)})`, { phase_id: phaseId });
    }
  }
}

function validateWaveId(waveId) {
  // `${tier}:${wave_index}` per policy/scheduler.mjs:270
  if (typeof waveId !== 'string' || !/^[0-9]+:[0-9]+$/.test(waveId)) {
    throw new ShardEnvelopeInvalidError(`wave_id '${waveId}' must match '<tier>:<wave_index>'`);
  }
}

function validateBaseSha(baseSha) {
  if (typeof baseSha !== 'string' || !/^[0-9a-f]{64}$/.test(baseSha)) {
    throw new ShardEnvelopeInvalidError(`base_sha must be a 64-char lowercase hex sha256 (got ${typeof baseSha === 'string' ? baseSha.slice(0, 12) + '...' : typeof baseSha})`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a shard envelope to .mpl/state.shards/<waveId>/<phaseId>.patch.json.
 *
 * @param {string} cwd
 * @param {string} waveId  `${tier}:${wave_index}`
 * @param {string} phaseId  must equal env.MPL_PHASE_ID when set
 * @param {Array<{op,path,value?,from?}>} patches  RFC-6902 ops
 * @param {Object<string,'ok'|'na'>} invariantClaims  I1..I13 claims
 * @param {string} baseSha  sha256 hex of state.json snapshot the worker read
 * @param {object} [opts]
 * @param {object} [opts.producer]  { execution_context_id, slot_id, worktree_root }
 * @param {number} [opts.decompositionRank]  phases[].order from decomposition.yaml
 * @param {object|null} [opts.contractAmendRequest]  non-null → reducer downgrades wave to sequential
 * @returns {string} absolute path of written shard file
 */
export function writeShard(cwd, waveId, phaseId, patches, invariantClaims, baseSha, opts = {}) {
  // Engine front-door contract (Move #16): if MPL_PHASE_ID is threaded by
  // the runner, refuse a shard that disagrees with it. Workers running
  // under one ExecutionContext cannot publish a shard for another phase.
  const envPhase = process.env.MPL_PHASE_ID;
  if (typeof phaseId !== 'string' || !phaseId) {
    throw new ShardEnvelopeInvalidError('phase_id required', { phase_id: phaseId });
  }
  if (envPhase && envPhase !== phaseId) {
    throw new ShardPhaseIdMismatchError({ expected: phaseId, envelope: phaseId, env: envPhase });
  }

  validateWaveId(waveId);
  validateBaseSha(baseSha);
  assertPathOwnership(patches, { phaseId });
  assertInvariantClaims(invariantClaims, { phaseId });

  const decompositionRank = Number.isFinite(opts.decompositionRank) ? opts.decompositionRank : 0;
  const producer = (opts.producer && typeof opts.producer === 'object') ? opts.producer : {};
  const contractAmendRequest = opts.contractAmendRequest ?? null;

  const envelope = Object.freeze({
    schema_version: SHARD_ENVELOPE_SCHEMA_VERSION,
    wave_id: waveId,
    phase_id: phaseId,
    base_sha: baseSha,
    decomposition_rank: decompositionRank,
    produced_at: new Date().toISOString(),
    producer: {
      execution_context_id: producer.execution_context_id ?? null,
      slot_id: typeof producer.slot_id === 'number' ? producer.slot_id : null,
      worktree_root: producer.worktree_root ?? null,
    },
    patches: patches.map((p) => ({ ...p })),
    invariant_claims: { ...invariantClaims },
    contract_amend_request: contractAmendRequest,
  });

  const dir = join(cwd, SHARD_DIR, waveId);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new ShardWriteIOError(`failed to mkdir ${dir}: ${e.message}`, e);
  }

  const finalPath = join(dir, `${phaseId}.patch.json`);
  const tmpPath = join(dir, `.${phaseId}.patch-${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), { mode: 0o600 });
    renameSync(tmpPath, finalPath);
  } catch (e) {
    throw new ShardWriteIOError(`atomic shard write failed at ${finalPath}: ${e.message}`, e);
  }
  return finalPath;
}

/**
 * Compute the sha256 base for a state snapshot the worker just read. The
 * reducer compares this to its own re-hash so concurrent waves can't race
 * a phantom-merge. Exposed so worker scripts can produce a consistent
 * base_sha without re-implementing the hash shape.
 */
export async function sha256OfState(stateObject) {
  const { createHash } = await import('crypto');
  const canonical = JSON.stringify(stateObject ?? null);
  return createHash('sha256').update(canonical).digest('hex');
}
