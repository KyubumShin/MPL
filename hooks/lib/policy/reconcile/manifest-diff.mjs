/**
 * MPL v2 L2 — wave reconciliation 4-bucket classifier (Move #17).
 *
 * Deterministic, no-LLM classifier that takes two phase-manifest objects
 * (produced by phase-runner; .mpl/mpl/phases/<phase_id>/phase-manifest.json)
 * plus the frozen decomposition.interface_contract and returns a bucket
 * verdict for every conflict found.
 *
 * 4 buckets (priority on multi-classification: T > C > S > X):
 *
 *  T  Textual conflict     same .produces[].path with different hash AND
 *                          decomposition does NOT permit cross-phase co-edit.
 *                          ACTION: ABORT_WAVE, failure_code='merge_error:textual_conflict'.
 *                          (no LLM reconcile — planning produced an impossible
 *                          decomposition.)
 *  S  Symbol conflict      same export symbol; if signature_hash equal →
 *                          IDEMPOTENT MERGE (decomposition_rank-lowest wins).
 *                          If signature_hash differs → escalate to C.
 *  C  Contract conflict    same route OR same error_code OR same
 *                          schema_fingerprint diverges AND both phases share
 *                          a contract_ref.
 *                          ACTION: SPAWN reconciler (--mode=reconcile).
 *  X  Semantic divergence  same contract_ref but symbols/paths diverge.
 *                          ACTION: bounded re-entry (cap=1) via
 *                          reentry-policy.mjs; second X on same
 *                          (wave_id, contract_ref) → ABORT with
 *                          failure_code='semantic_reentry_exhausted'.
 *
 * Manifest shape (per phase):
 *   {
 *     phase_id, decomposition_rank,
 *     produces: [{path, hash, exports: [{name, signature_hash}],
 *                 routes: [string], error_codes: [string],
 *                 schema_fingerprint: string}],
 *     requires: [...mirror shape...],
 *     contract_refs: [{contract_id, clause}]
 *   }
 */

export const BUCKETS = Object.freeze({
  T: 'T',
  S: 'S',
  C: 'C',
  X: 'X',
});

export const RECONCILE_FAILURE_CODES = Object.freeze({
  TEXTUAL_CONFLICT: 'merge_error:textual_conflict',
  SEMANTIC_REENTRY_EXHAUSTED: 'semantic_reentry_exhausted',
  CONTRACT_RECONCILE_REQUIRED: 'reconcile_required',
});

function safeArr(v) { return Array.isArray(v) ? v : []; }

/**
 * Detect textual conflicts (T) between two phase manifests.
 * Returns array of {bucket:'T', path, phase_a, phase_b, hash_a, hash_b}.
 */
export function findTextualConflicts(a, b, { coEditPermitted = () => false } = {}) {
  const conflicts = [];
  const aMap = new Map();
  for (const p of safeArr(a.produces)) {
    if (p && typeof p.path === 'string') aMap.set(p.path, p);
  }
  for (const p of safeArr(b.produces)) {
    if (!p || typeof p.path !== 'string') continue;
    const peer = aMap.get(p.path);
    if (!peer) continue;
    if (peer.hash === p.hash) continue;
    if (coEditPermitted(p.path, a.phase_id, b.phase_id)) continue;
    conflicts.push({
      bucket: BUCKETS.T,
      path: p.path,
      phase_a: a.phase_id,
      phase_b: b.phase_id,
      hash_a: peer.hash,
      hash_b: p.hash,
    });
  }
  return conflicts;
}

/**
 * Detect symbol conflicts (S). Idempotent when signature_hash matches —
 * caller picks the decomposition_rank-lowest winner. Otherwise escalates
 * to bucket C (returned with `escalate_to: 'C'`).
 */
export function findSymbolConflicts(a, b) {
  const conflicts = [];
  const aSyms = new Map();
  for (const prod of safeArr(a.produces)) {
    for (const sym of safeArr(prod.exports)) {
      if (sym && typeof sym.name === 'string') aSyms.set(sym.name, sym);
    }
  }
  for (const prod of safeArr(b.produces)) {
    for (const sym of safeArr(prod.exports)) {
      if (!sym || typeof sym.name !== 'string') continue;
      const peer = aSyms.get(sym.name);
      if (!peer) continue;
      if (peer.signature_hash === sym.signature_hash) {
        conflicts.push({
          bucket: BUCKETS.S,
          symbol: sym.name,
          phase_a: a.phase_id,
          phase_b: b.phase_id,
          signature_hash: sym.signature_hash,
          resolution: 'idempotent',
        });
      } else {
        conflicts.push({
          bucket: BUCKETS.S,
          symbol: sym.name,
          phase_a: a.phase_id,
          phase_b: b.phase_id,
          signature_a: peer.signature_hash,
          signature_b: sym.signature_hash,
          escalate_to: BUCKETS.C,
        });
      }
    }
  }
  return conflicts;
}

/**
 * Detect contract conflicts (C). Triggered when same route OR same
 * error_code OR same schema_fingerprint diverges AND contract_ref appears
 * in BOTH manifests.
 */
export function findContractConflicts(a, b) {
  const conflicts = [];
  const aRoutes = new Set();
  const aErrors = new Set();
  const aSchemas = new Set();
  for (const prod of safeArr(a.produces)) {
    for (const r of safeArr(prod.routes)) aRoutes.add(r);
    for (const e of safeArr(prod.error_codes)) aErrors.add(e);
    if (prod.schema_fingerprint) aSchemas.add(prod.schema_fingerprint);
  }
  const aContracts = new Set(safeArr(a.contract_refs).map((c) => `${c.contract_id}:${c.clause ?? ''}`));
  const bContracts = new Set(safeArr(b.contract_refs).map((c) => `${c.contract_id}:${c.clause ?? ''}`));
  const sharedContract = [...aContracts].some((k) => bContracts.has(k));

  for (const prod of safeArr(b.produces)) {
    for (const r of safeArr(prod.routes)) {
      if (aRoutes.has(r) && sharedContract) {
        conflicts.push({
          bucket: BUCKETS.C,
          kind: 'route',
          route: r,
          phase_a: a.phase_id,
          phase_b: b.phase_id,
        });
      }
    }
    for (const e of safeArr(prod.error_codes)) {
      if (aErrors.has(e) && sharedContract) {
        conflicts.push({
          bucket: BUCKETS.C,
          kind: 'error_code',
          error_code: e,
          phase_a: a.phase_id,
          phase_b: b.phase_id,
        });
      }
    }
    if (prod.schema_fingerprint && sharedContract) {
      // schema_fingerprint divergence (different prints, same contract_ref)
      for (const peerFp of aSchemas) {
        if (peerFp !== prod.schema_fingerprint) {
          conflicts.push({
            bucket: BUCKETS.C,
            kind: 'schema_fingerprint',
            fp_a: peerFp,
            fp_b: prod.schema_fingerprint,
            phase_a: a.phase_id,
            phase_b: b.phase_id,
          });
          break;
        }
      }
    }
  }
  return conflicts;
}

/**
 * Detect semantic divergence (X) — same contract_ref but disjoint symbols/paths.
 */
export function findSemanticDivergence(a, b) {
  const aContracts = new Set(safeArr(a.contract_refs).map((c) => `${c.contract_id}:${c.clause ?? ''}`));
  const bContracts = new Set(safeArr(b.contract_refs).map((c) => `${c.contract_id}:${c.clause ?? ''}`));
  const shared = [...aContracts].filter((k) => bContracts.has(k));
  if (shared.length === 0) return [];

  const aPaths = new Set();
  const bPaths = new Set();
  const aSyms = new Set();
  const bSyms = new Set();
  for (const prod of safeArr(a.produces)) {
    if (prod.path) aPaths.add(prod.path);
    for (const s of safeArr(prod.exports)) if (s?.name) aSyms.add(s.name);
  }
  for (const prod of safeArr(b.produces)) {
    if (prod.path) bPaths.add(prod.path);
    for (const s of safeArr(prod.exports)) if (s?.name) bSyms.add(s.name);
  }
  const pathOverlap = [...aPaths].some((p) => bPaths.has(p));
  const symOverlap = [...aSyms].some((s) => bSyms.has(s));
  if (pathOverlap || symOverlap) return []; // not divergent — caught by T/S
  return shared.map((contract_ref) => ({
    bucket: BUCKETS.X,
    contract_ref,
    phase_a: a.phase_id,
    phase_b: b.phase_id,
  }));
}

/**
 * Run all four detectors and return a structured verdict for a single
 * phase pair. Priority: T > C > S > X.
 *
 * `topBucket` is the resolved single bucket; `findings` keeps every
 * raw detection for downstream reconciler / log.
 */
export function classifyPair(a, b, opts = {}) {
  const findings = {
    T: findTextualConflicts(a, b, opts),
    S: findSymbolConflicts(a, b),
    C: findContractConflicts(a, b),
    X: findSemanticDivergence(a, b),
  };
  // Promote S(escalate_to=C) into the C bucket.
  for (const s of findings.S) {
    if (s.escalate_to === BUCKETS.C) {
      findings.C.push({ ...s, bucket: BUCKETS.C, kind: 'symbol_signature_divergence' });
    }
  }
  let topBucket = null;
  if (findings.T.length > 0) topBucket = BUCKETS.T;
  else if (findings.C.length > 0) topBucket = BUCKETS.C;
  else if (findings.S.length > 0) topBucket = BUCKETS.S;
  else if (findings.X.length > 0) topBucket = BUCKETS.X;
  return { phase_pair: [a.phase_id, b.phase_id], topBucket, findings };
}

/**
 * Run classifyPair across every distinct unordered pair in the wave.
 * Returns a buckets map { T:[], S:[], C:[], X:[] } where each entry is a
 * flattened finding object enriched with phase_pair.
 */
export function classifyWave(manifests, opts = {}) {
  const out = { T: [], S: [], C: [], X: [] };
  for (let i = 0; i < manifests.length; i++) {
    for (let j = i + 1; j < manifests.length; j++) {
      const r = classifyPair(manifests[i], manifests[j], opts);
      for (const bk of Object.keys(out)) {
        for (const f of r.findings[bk]) out[bk].push(f);
      }
    }
  }
  return out;
}
