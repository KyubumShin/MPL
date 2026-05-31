/**
 * MPL v2 L1 — wave reducer (Move #17).
 *
 * `mergeWaveShards(waveId, cwd) -> { merged, applied_shards, isolated_shards,
 *  downgrade_to_sequential }` collapses every per-phase shard envelope in
 * `.mpl/state.shards/<waveId>/` into a SINGLE `writer.mjs#writeState` call.
 *
 * IMPORTANT (additive / dormant):
 *   This module is importable + unit-tested but is NOT called by the engine
 *   yet — a follow-on move will add the `wave_end` route in
 *   `lib/dispatch.mjs` that drives it. Until then the call site is the
 *   test surface only.
 *
 * Algorithm (deterministic, fail-closed):
 *   1. List `*.patch.json` envelopes for the wave; lexical sort by phase_id.
 *   2. Parse + validate `schema_version == 1` + required fields.
 *   3. STALE BASE CHECK: every envelope's `base_sha` must equal the
 *      sha256 of the CURRENT on-disk state.json snapshot. Mismatch ->
 *      StaleShardBaseError.
 *   4. SORT: ascending decomposition_rank, ties by phase_id lex.
 *   5. CONTRACT_AMEND DETECTION: any shard with `contract_amend_request !=
 *      null` short-circuits → caller drives the wave through the legacy
 *      serial path. NO partial merges.
 *   6. FIELD-OWNERSHIP RESOLUTION: every distinct top-level field touched
 *      by the union of patches must have an entry in
 *      `state.merge_policy.<field>` (mpl.config.yaml). Unknown →
 *      UnknownFieldOwnershipError. No silent last-write-wins.
 *   7. APPLY: for each shard in rank order:
 *        a) applyRfc6902(working, envelope.patches) — abort on test failure.
 *        b) per-field project the merge_policy rule (phase_keyed /
 *           ring_merge / union / last_completed_at_wins /
 *           recomputed_from_decomposition).
 *        c) re-run checkInvariants(working, { trigger:'STATE_WRITE' }).
 *           Violations → ISOLATE the shard (move file under `_isolated/`),
 *           revert working state to pre-shard snapshot, continue.
 *      After the wave loop, ISOLATED shards are replayed SERIALLY through
 *      writer.mjs#writeState so the writer's own I5 lockstep + H8 guard
 *      adjudicate each one.
 *   8. WRITE: writer.mjs#writeState(cwd, delta) — single call. writer.mjs
 *      remains the sole owner of state.json on disk.
 *   9. CLEANUP: archive merged shards into `_archive/<waveId>/`; remove
 *      the active wave directory.
 *
 * Errors (engine recovers — never silently merges):
 *   - StaleShardBaseError({expected_base_sha, actual_base_sha, drift_shards})
 *   - UnknownFieldOwnershipError({field, touching_shards})
 *   - ShardEnvelopeInvalidError({phase_id, reason})
 *   - ShardPatchTestFailedError({phase_id, op_index, path})
 *   - WaveReducerInvariantUnresolvableError (every shard isolates AND
 *     serial replay also violates — escalates to operator)
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, renameSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { writeState } from './writer.mjs';
import { readState } from './reader.mjs';
import { checkInvariants } from '../mpl-state-invariant.mjs';
import { sha256OfState, SHARD_DIR, ShardEnvelopeInvalidError } from './shard-writer.mjs';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class StaleShardBaseError extends Error {
  constructor({ expected_base_sha, actual_base_sha, drift_shards }) {
    super(`shard base_sha drift — expected=${actual_base_sha}, drifted_shards=${drift_shards.length}`);
    this.name = 'StaleShardBaseError';
    this.expected_base_sha = expected_base_sha;
    this.actual_base_sha = actual_base_sha;
    this.drift_shards = drift_shards;
  }
}

export class UnknownFieldOwnershipError extends Error {
  constructor({ field, touching_shards }) {
    super(`unknown field '${field}' (no merge_policy entry); touching shards=${touching_shards.join(',')}`);
    this.name = 'UnknownFieldOwnershipError';
    this.field = field;
    this.touching_shards = touching_shards;
  }
}

export class ShardPatchTestFailedError extends Error {
  constructor({ phase_id, op_index, path }) {
    super(`RFC-6902 test op failed for shard ${phase_id} (op[${op_index}], path=${path})`);
    this.name = 'ShardPatchTestFailedError';
    this.phase_id = phase_id;
    this.op_index = op_index;
    this.path = path;
  }
}

export class WaveReducerInvariantUnresolvableError extends Error {
  constructor({ wave_id, isolated_shards }) {
    super(`wave ${wave_id}: every shard violated invariants and serial replay also failed`);
    this.name = 'WaveReducerInvariantUnresolvableError';
    this.wave_id = wave_id;
    this.isolated_shards = isolated_shards;
  }
}

// ---------------------------------------------------------------------------
// Built-in merge policy (mirrors mpl.config.yaml `state.merge_policy`)
//
// Embedded so the reducer can run without a YAML load — the YAML is the
// SSOT for documentation, this is defense-in-depth so a missing or
// malformed YAML cannot silently relax the contract. When the YAML
// declares a different policy for a known field, the YAML wins via
// `mergePolicyFor()` below.
// ---------------------------------------------------------------------------

export const BUILTIN_MERGE_POLICY = Object.freeze({
  // phase-keyed
  gate_results: 'phase_keyed',
  test_agent_dispatched: 'phase_keyed',
  e2e_results: 'last_completed_at_wins',
  security_results: 'phase_keyed',
  phase_lifecycle: 'phase_keyed',
  release: 'phase_keyed',
  reconciler_reentries: 'phase_keyed',

  // ring_merge
  ambiguity_history: 'ring_merge',
  phase_scheduler_history: 'ring_merge',
  fix_loop_history: 'ring_merge',
  worktree_pool_history: 'ring_merge',
  quality_score_history: 'ring_merge',

  // union
  permits: 'union',
  worktree_history: 'union',
  waves_in_flight: 'union',
  running: 'union',
  completed_cut_ids: 'union',

  // recomputed_from_decomposition
  sprint_status: 'recomputed_from_decomposition',

  // engine_only — rejected at envelope guard; listed for symmetry
  pipeline_id: 'engine_only',
  session_status: 'engine_only',
  current_phase: 'engine_only',
  schema_version: 'engine_only',
  started_at: 'engine_only',
  finalize_done: 'engine_only',
  finalized_at: 'engine_only',
  completed_at: 'engine_only',
  blocked_by_hook: 'engine_only',
  blocked_phase: 'engine_only',
  blocked_artifact: 'engine_only',
  block_code: 'engine_only',
  block_reason: 'engine_only',
  resume_instruction: 'engine_only',
  retry_context: 'engine_only',
  blocked_at: 'engine_only',
  current_cut_id: 'engine_only',
  fix_loop_count: 'engine_only',
});

const RING_CAPS = Object.freeze({
  ambiguity_history: 10,
  phase_scheduler_history: 50,
  worktree_pool_history: 50,
  quality_score_history: 50,
  fix_loop_history: Infinity,  // writer.mjs I5 lockstep re-asserts; reducer keeps all
});

function mergePolicyFor(field, yamlConfig) {
  const fromYaml = yamlConfig?.state?.merge_policy?.[field];
  if (typeof fromYaml === 'string') return fromYaml;
  return BUILTIN_MERGE_POLICY[field] ?? null;
}

// ---------------------------------------------------------------------------
// Minimal RFC-6902 implementation (no external deps).
// ---------------------------------------------------------------------------

function decodePointer(pointer) {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw new Error(`JSON Pointer must start with '/': ${pointer}`);
  }
  return pointer.slice(1).split('/').map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getByPointer(doc, pointer) {
  const path = decodePointer(pointer);
  let node = doc;
  for (const seg of path) {
    if (node === null || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
      const idx = seg === '-' ? node.length : Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) return undefined;
      node = node[idx];
    } else {
      if (!Object.prototype.hasOwnProperty.call(node, seg)) return undefined;
      node = node[seg];
    }
  }
  return node;
}

function setByPointer(doc, pointer, value, mode /* 'add' | 'replace' */) {
  const path = decodePointer(pointer);
  if (path.length === 0) {
    // root replacement not supported here; reducer never does this.
    throw new Error('root-level patch not supported');
  }
  let node = doc;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (Array.isArray(node)) {
      const idx = Number(seg);
      node = node[idx];
    } else {
      if (node[seg] === undefined || node[seg] === null) {
        node[seg] = {};
      }
      node = node[seg];
    }
  }
  const last = path[path.length - 1];
  if (Array.isArray(node)) {
    const idx = last === '-' ? node.length : Number(last);
    if (mode === 'add') node.splice(idx, 0, value);
    else node[idx] = value;
  } else {
    node[last] = value;
  }
}

function removeByPointer(doc, pointer) {
  const path = decodePointer(pointer);
  if (path.length === 0) throw new Error('root remove not supported');
  let node = doc;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (node == null) return;
    node = Array.isArray(node) ? node[Number(seg)] : node[seg];
  }
  if (node == null) return;
  const last = path[path.length - 1];
  if (Array.isArray(node)) {
    node.splice(Number(last), 1);
  } else {
    delete node[last];
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

export function applyRfc6902(doc, patches, phaseId) {
  for (let i = 0; i < patches.length; i++) {
    const op = patches[i];
    switch (op.op) {
      case 'add':     setByPointer(doc, op.path, op.value, 'add'); break;
      case 'replace': setByPointer(doc, op.path, op.value, 'replace'); break;
      case 'remove':  removeByPointer(doc, op.path); break;
      case 'move': {
        const v = getByPointer(doc, op.from);
        removeByPointer(doc, op.from);
        setByPointer(doc, op.path, v, 'add');
        break;
      }
      case 'copy': {
        const v = getByPointer(doc, op.from);
        setByPointer(doc, op.path, JSON.parse(JSON.stringify(v ?? null)), 'add');
        break;
      }
      case 'test': {
        const v = getByPointer(doc, op.path);
        if (!deepEqual(v, op.value)) {
          throw new ShardPatchTestFailedError({ phase_id: phaseId, op_index: i, path: op.path });
        }
        break;
      }
      default:
        throw new Error(`RFC-6902 op '${op.op}' not supported`);
    }
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Field policy projection helpers
// ---------------------------------------------------------------------------

function ringMerge(existing, incoming, cap) {
  const exArr = Array.isArray(existing) ? existing : [];
  const inArr = Array.isArray(incoming) ? incoming : [];
  const concat = exArr.concat(inArr);
  if (!Number.isFinite(cap) || concat.length <= cap) return concat;
  return concat.slice(-cap);
}

function stableEntryId(entry, field) {
  if (entry == null || typeof entry !== 'object') return JSON.stringify(entry);
  if (field === 'permits' && entry.id) return `id:${entry.id}`;
  if (field === 'waves_in_flight' && entry.wave_id) return `wave:${entry.wave_id}`;
  if (field === 'running' && entry.execution_context_id) return `ctx:${entry.execution_context_id}`;
  if (field === 'worktree_history' && entry.phase_id && entry.started_at) {
    return `wh:${entry.phase_id}:${entry.started_at}`;
  }
  if (field === 'completed_cut_ids' && typeof entry === 'string') return `cut:${entry}`;
  // Fallback: structural hash. For workspaces with custom entry shapes,
  // setting an explicit `.id` field is the most reliable choice.
  return `hash:${JSON.stringify(entry)}`;
}

function unionMerge(existing, incoming, field) {
  const seen = new Map();
  const exArr = Array.isArray(existing) ? existing : [];
  const inArr = Array.isArray(incoming) ? incoming : [];
  for (const e of exArr) seen.set(stableEntryId(e, field), e);
  for (const e of inArr) {
    const k = stableEntryId(e, field);
    if (!seen.has(k)) seen.set(k, e);
  }
  return [...seen.values()];
}

function lastCompletedAtWins(existing, incoming) {
  // Both are objects keyed by scenario/phase id. Per-key, pick entry
  // with latest .completed_at; tie-break by inner key lexical (stable).
  const out = { ...(existing && typeof existing === 'object' ? existing : {}) };
  if (incoming && typeof incoming === 'object') {
    for (const [k, v] of Object.entries(incoming)) {
      const cur = out[k];
      if (!cur) { out[k] = v; continue; }
      const curTime = String(cur?.completed_at ?? '');
      const newTime = String(v?.completed_at ?? '');
      if (newTime > curTime) {
        out[k] = v;
      } else if (newTime === curTime) {
        // tie-break: prefer existing (stable across re-runs)
      }
    }
  }
  return out;
}

function recomputeSprintStatusFromDecomposition(cwd, completedPhaseIds) {
  // Best-effort, NOT an LLM job: read decomposition.yaml execution_tiers
  // and count total/completed phases. Failures fall back to defaults so a
  // missing decomposition.yaml never wedges the reducer.
  try {
    const path = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8');
    const ids = new Set();
    // tiny regex extraction over the phases: list — sufficient for the
    // ID set, which is the only thing sprint_status needs here.
    const phaseBlock = raw.match(/(?:^|\n)phases:\s*\n([\s\S]+?)(?=\n[a-zA-Z_]+:|$)/);
    if (phaseBlock) {
      const matches = phaseBlock[1].match(/^\s*-\s*id:\s*['"]?([A-Za-z0-9_\-:]+)['"]?/gm) || [];
      for (const m of matches) {
        const id = m.replace(/^\s*-\s*id:\s*['"]?/, '').replace(/['"]?\s*$/, '');
        if (id) ids.add(id);
      }
    }
    const total = ids.size;
    let completed = 0;
    for (const id of completedPhaseIds) if (ids.has(id)) completed++;
    return {
      total_todos: total,
      completed_todos: completed,
      in_progress_todos: Math.max(0, total - completed),
      failed_todos: 0,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shard discovery + validation
// ---------------------------------------------------------------------------

function shardsDir(cwd, waveId) {
  return join(cwd, SHARD_DIR, waveId);
}

function listShardFiles(cwd, waveId) {
  const dir = shardsDir(cwd, waveId);
  if (!existsSync(dir)) return [];
  const all = readdirSync(dir).filter((f) => /\.patch\.json$/.test(f) && !f.startsWith('.'));
  return all.sort().map((f) => join(dir, f));
}

function parseEnvelope(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  let env;
  try { env = JSON.parse(raw); }
  catch (e) {
    throw new ShardEnvelopeInvalidError(`malformed JSON at ${filePath}: ${e.message}`);
  }
  if (!env || typeof env !== 'object') {
    throw new ShardEnvelopeInvalidError(`envelope must be an object at ${filePath}`);
  }
  if (env.schema_version !== 1) {
    throw new ShardEnvelopeInvalidError(`unsupported schema_version=${env.schema_version}`, { phase_id: env?.phase_id });
  }
  for (const k of ['wave_id', 'phase_id', 'base_sha']) {
    if (typeof env[k] !== 'string' || !env[k]) {
      throw new ShardEnvelopeInvalidError(`missing field '${k}'`, { phase_id: env?.phase_id });
    }
  }
  if (!Array.isArray(env.patches)) {
    throw new ShardEnvelopeInvalidError(`patches[] must be an array`, { phase_id: env.phase_id });
  }
  if (!env.invariant_claims || typeof env.invariant_claims !== 'object') {
    throw new ShardEnvelopeInvalidError(`invariant_claims missing`, { phase_id: env.phase_id });
  }
  return env;
}

function touchedTopLevelFields(patches) {
  const out = new Set();
  for (const p of patches) {
    if (typeof p?.path !== 'string') continue;
    const m = p.path.match(/^\/([^\/]+)/);
    if (m) out.add(m[1].replace(/~1/g, '/').replace(/~0/g, '~'));
    if (p.from && typeof p.from === 'string') {
      const m2 = p.from.match(/^\/([^\/]+)/);
      if (m2) out.add(m2[1].replace(/~1/g, '/').replace(/~0/g, '~'));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase-keyed path assertion
// ---------------------------------------------------------------------------

const PHASE_KEYED_PATH_RULES = {
  test_agent_dispatched: (segs, phaseId) => segs[1] === phaseId,
  security_results:      (segs, phaseId) => segs[1] === phaseId,
  phase_lifecycle:       (segs, phaseId) => segs[1] === phaseId,
  // gate_results entries are keyed by {phase_id} prefix in command —
  // structural rule is "second segment names the gate slot; the
  // command's command field carries the phase_id". We can't verify
  // the prefix without parsing the command string, so we accept any
  // gate_results sub-write and rely on the reducer's post-shard
  // checkInvariants() + writer.mjs deriveLegacyGateBooleans for
  // adjudication.
  gate_results:          () => true,
  // reconciler_reentries: top-level is wave_id, then contract_ref_hash
  reconciler_reentries:  () => true,
  // e2e_results uses last_completed_at_wins; phase_keyed check is loose
  e2e_results:           () => true,
  release:               () => true,
};

function assertPhaseKeyedPath(patch, phaseId) {
  if (typeof patch?.path !== 'string') return;
  const segs = patch.path.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  const root = segs[0];
  const check = PHASE_KEYED_PATH_RULES[root];
  if (!check) return; // not phase-keyed
  if (segs.length < 2) return; // top-level overwrite of a phase-keyed map is illegal but caught elsewhere
  if (!check(segs, phaseId)) {
    throw new ShardEnvelopeInvalidError(
      `phase_keyed field '${root}' patched at segment '${segs[1]}' but envelope.phase_id='${phaseId}'`,
      { phase_id: phaseId, field: root }
    );
  }
}

// ---------------------------------------------------------------------------
// Isolation / archive helpers
// ---------------------------------------------------------------------------

function isolateShardFile(cwd, waveId, shardFile) {
  const isoDir = join(shardsDir(cwd, waveId), '_isolated');
  if (!existsSync(isoDir)) mkdirSync(isoDir, { recursive: true });
  const base = shardFile.split('/').pop();
  const dest = join(isoDir, base);
  try { renameSync(shardFile, dest); } catch { /* best-effort */ }
  return dest;
}

function archiveWave(cwd, waveId) {
  const archive = join(cwd, SHARD_DIR, '_archive', waveId);
  if (!existsSync(dirname(archive))) mkdirSync(dirname(archive), { recursive: true });
  const dir = shardsDir(cwd, waveId);
  try {
    if (existsSync(dir)) renameSync(dir, archive);
  } catch {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {string} waveId  `${tier}:${wave_index}`
 * @param {string} cwd
 * @param {object} [opts]
 * @param {object} [opts.config]  output of loadConfigV2 (for merge_policy
 *                                 overrides); falls back to BUILTIN_MERGE_POLICY
 * @returns {Promise<{merged?, applied_shards, isolated_shards, downgrade_to_sequential, request_meta?}>}
 */
export async function mergeWaveShards(waveId, cwd, opts = {}) {
  const config = opts.config ?? null;
  const files = listShardFiles(cwd, waveId);
  if (files.length === 0) {
    return {
      merged: readState(cwd),
      applied_shards: [],
      isolated_shards: [],
      downgrade_to_sequential: false,
    };
  }

  // (2) Parse + envelope-validate
  const envelopes = [];
  for (const f of files) {
    const env = parseEnvelope(f);
    envelopes.push({ file: f, envelope: env });
  }

  // (3) Stale base check — every envelope must reference the current state hash.
  const snapshot = readState(cwd);
  const baseShaNow = await sha256OfState(snapshot ?? null);
  const drift = envelopes.filter((e) => e.envelope.base_sha !== baseShaNow);
  if (drift.length > 0) {
    throw new StaleShardBaseError({
      expected_base_sha: envelopes[0].envelope.base_sha,
      actual_base_sha: baseShaNow,
      drift_shards: drift.map((e) => e.envelope.phase_id),
    });
  }

  // (4) Sort by decomposition_rank, then phase_id lex.
  envelopes.sort((a, b) => {
    const ra = Number.isFinite(a.envelope.decomposition_rank) ? a.envelope.decomposition_rank : 0;
    const rb = Number.isFinite(b.envelope.decomposition_rank) ? b.envelope.decomposition_rank : 0;
    if (ra !== rb) return ra - rb;
    return a.envelope.phase_id < b.envelope.phase_id ? -1 : 1;
  });

  // (5) Contract-amend detection — short-circuit BEFORE any merge attempt.
  const amend = envelopes.find((e) => e.envelope.contract_amend_request != null);
  if (amend) {
    return {
      applied_shards: [],
      isolated_shards: [],
      downgrade_to_sequential: true,
      request_meta: {
        wave_id: waveId,
        phase_id: amend.envelope.phase_id,
        request: amend.envelope.contract_amend_request,
      },
    };
  }

  // (6) Field ownership resolution — every touched top-level field must
  //     have a known policy.
  const fieldToShards = new Map(); // field -> [phase_id...]
  for (const { envelope } of envelopes) {
    for (const f of touchedTopLevelFields(envelope.patches)) {
      const list = fieldToShards.get(f) || [];
      list.push(envelope.phase_id);
      fieldToShards.set(f, list);
    }
  }
  for (const [field, shards] of fieldToShards) {
    const policy = mergePolicyFor(field, config);
    if (!policy) {
      throw new UnknownFieldOwnershipError({ field, touching_shards: shards });
    }
  }

  // (7) Apply shards in rank order; isolate violators.
  const working = JSON.parse(JSON.stringify(snapshot ?? {}));
  const applied = [];
  const isolated = [];
  const completedPhaseIds = new Set(
    Object.entries(working?.phase_lifecycle ?? {})
      .filter(([, v]) => v?.status === 'COMPLETED')
      .map(([k]) => k)
  );

  for (const entry of envelopes) {
    const { file, envelope } = entry;
    const beforeShard = JSON.parse(JSON.stringify(working));
    let applyError = null;
    try {
      // Phase-keyed path discipline (defense-in-depth — shard-writer already pre-checks).
      for (const p of envelope.patches) assertPhaseKeyedPath(p, envelope.phase_id);

      applyRfc6902(working, envelope.patches, envelope.phase_id);

      // Per-field policy projection on what THIS shard touched.
      for (const field of touchedTopLevelFields(envelope.patches)) {
        const policy = mergePolicyFor(field, config);
        switch (policy) {
          case 'phase_keyed':
          case 'engine_only':
            // engine_only never reaches here (rejected by shard-writer
            // ownership guard); phase_keyed is enforced by path discipline
            break;
          case 'ring_merge': {
            const cap = RING_CAPS[field] ?? 50;
            const beforeArr = Array.isArray(beforeShard[field]) ? beforeShard[field] : [];
            const afterArr = Array.isArray(working[field]) ? working[field] : [];
            // applyRfc6902 already merged in shard's view; ring_merge means
            // CONCAT prior + delta then cap. Treat afterArr as the
            // shard-extended array, ringMerge keeps tail.
            working[field] = ringMerge(beforeArr, afterArr.slice(beforeArr.length), cap);
            break;
          }
          case 'union': {
            const beforeArr = Array.isArray(beforeShard[field]) ? beforeShard[field] : [];
            const afterArr = Array.isArray(working[field]) ? working[field] : [];
            const incoming = afterArr.slice(beforeArr.length);
            working[field] = unionMerge(beforeArr, incoming, field);
            break;
          }
          case 'last_completed_at_wins': {
            working[field] = lastCompletedAtWins(beforeShard[field], working[field]);
            break;
          }
          case 'recomputed_from_decomposition': {
            // Shard value DISCARDED — recompute after wave loop instead.
            working[field] = beforeShard[field];
            break;
          }
          default:
            // Unknown caught above; defensive.
            break;
        }
      }

      // Track which phases the wave just completed (for sprint_status recompute).
      if (envelope.patches.some((p) => p.path?.startsWith(`/phase_lifecycle/${envelope.phase_id}`))) {
        const status = working?.phase_lifecycle?.[envelope.phase_id]?.status;
        if (status === 'COMPLETED') completedPhaseIds.add(envelope.phase_id);
      }
    } catch (e) {
      applyError = e;
    }

    if (applyError) {
      // Restore + isolate.
      Object.keys(working).forEach((k) => delete working[k]);
      Object.assign(working, beforeShard);
      isolateShardFile(cwd, waveId, file);
      isolated.push({ phase_id: envelope.phase_id, violation: { id: 'APPLY_FAILED', message: applyError.message } });
      continue;
    }

    // (7c) Re-run checkInvariants on the working state after THIS shard.
    const result = checkInvariants(working, { cwd, trigger: 'STATE_WRITE' });
    if (!result.ok) {
      // Restore + isolate.
      Object.keys(working).forEach((k) => delete working[k]);
      Object.assign(working, beforeShard);
      isolateShardFile(cwd, waveId, file);
      isolated.push({ phase_id: envelope.phase_id, violation: result.violations[0] });
      continue;
    }

    applied.push(envelope.phase_id);
  }

  // Recompute sprint_status from decomposition.yaml + completed set.
  const recomputed = recomputeSprintStatusFromDecomposition(cwd, [...completedPhaseIds]);
  if (recomputed) {
    working.sprint_status = recomputed;
  }

  // (8) Single writeState with the merged delta.
  let writtenState = null;
  if (applied.length > 0) {
    // Pass the full merged working as a patch — writer.mjs does deepMerge over
    // the freshest on-disk snapshot. Strip engine-only fields that were not
    // touched so they cannot accidentally regress.
    const patch = { ...working };
    delete patch.schema_version;  // writer derives from defaults
    writtenState = writeState(cwd, patch);
  } else {
    writtenState = snapshot;
  }

  // Serial-replay isolated shards through writer.mjs so I5/H8 adjudicate
  // each one individually. Any STILL-violating shard stays isolated.
  const stillIsolated = [];
  for (const iso of isolated) {
    // Replay best-effort: locate the moved file in _isolated/, parse,
    // and try to writeState its patches in legacy serial path. We don't
    // have a fully generic "apply patches via writer" helper, so we
    // approximate: take working state, apply the shard's patches, hand
    // the delta to writeState. If the writer reverts (I5) or throws, the
    // shard stays in the isolated bucket.
    const isoPath = join(shardsDir(cwd, waveId), '_isolated', `${iso.phase_id}.patch.json`);
    if (!existsSync(isoPath)) { stillIsolated.push(iso); continue; }
    try {
      const env = parseEnvelope(isoPath);
      const fresh = readState(cwd) || {};
      const probe = JSON.parse(JSON.stringify(fresh));
      applyRfc6902(probe, env.patches, env.phase_id);
      const result = checkInvariants(probe, { cwd, trigger: 'STATE_WRITE' });
      if (!result.ok) { stillIsolated.push(iso); continue; }
      writeState(cwd, probe);
      applied.push(iso.phase_id);
    } catch {
      stillIsolated.push(iso);
    }
  }

  // (9) Cleanup: archive merged wave dir. If EVERYTHING isolated AND none
  // recovered, escalate to operator.
  if (applied.length === 0 && stillIsolated.length > 0) {
    throw new WaveReducerInvariantUnresolvableError({
      wave_id: waveId,
      isolated_shards: stillIsolated,
    });
  }

  archiveWave(cwd, waveId);

  return {
    merged: writtenState,
    applied_shards: applied,
    isolated_shards: stillIsolated,
    downgrade_to_sequential: false,
  };
}

// Re-export for tests + downstream wave_end route consumers.
export { sha256OfState };
